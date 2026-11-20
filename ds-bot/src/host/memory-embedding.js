// Memory embeddings (M2 G4 4.3, the client side of it): a slice gets a vector as soon as a
// local embedding service is configured. Until one is, nothing is called and the two
// embedding fields stay null — the model choice is the user's, not this module's.
//
// Two service shapes are accepted, because the choice is still open:
//   ollama   POST <base>/api/embeddings  {model, prompt}    -> {embedding: [...]}
//   openai   POST <base>/v1/embeddings   {model, input: []} -> {data: [{index, embedding}]}
//
// A conversation never waits for this. A slice is written first, its id is queued, and a
// later round fills the vector in; a round that fails leaves the row as it was, keeps the
// slice queued for one more try, and says why in `state()`. The queue lives in memory: a
// restart loses pending ids, and `scan()` (run at install) picks them up again from the
// file, since a row without a vector is exactly what a pending slice looks like.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const EMBEDDING_ENDPOINTS = ['ollama', 'openai']
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_BATCH = 16
// A failed round waits this long before trying again; the queue is not dropped.
export const RETRY_MS = 60_000

const trimmed = value => (typeof value === 'string' ? value.trim() : '')
const stripSlash = value => String(value).replace(/\/+$/, '')

// What the config asks for, in the form the rest of the module uses. `wanted` is what the
// user asked (the switch is on); `enabled` is whether it can actually run (a switch on
// with no address or no model is still off, and `problem` says which one is missing).
export function resolveEmbeddingConfig(config = {}) {
  const raw = config.memoryEmbedding ?? {}
  const endpoint = EMBEDDING_ENDPOINTS.includes(raw.endpoint) ? raw.endpoint : 'ollama'
  const baseUrl = stripSlash(trimmed(raw.base_url))
  const model = trimmed(raw.model)
  const timeoutMs = Number.isFinite(raw.timeout_ms) && raw.timeout_ms > 0 ? Math.round(raw.timeout_ms) : DEFAULT_TIMEOUT_MS
  const batch = Number.isInteger(raw.batch) && raw.batch > 0 ? raw.batch : DEFAULT_BATCH
  // Off unless asked for: a module that is wired in but never configured must not call out.
  const wanted = raw.enabled === true
  const problem = !wanted ? null : baseUrl === '' ? 'base_url is not set' : model === '' ? 'model is not set' : null
  return { endpoint, baseUrl, model, timeoutMs, batch, wanted, enabled: wanted && problem === null, problem }
}

// Where the call goes, tolerating a base that already ends in the part the service names.
export const embeddingsUrl = settings => {
  if (settings.endpoint === 'openai') {
    return settings.baseUrl.endsWith('/v1') ? `${settings.baseUrl}/embeddings` : `${settings.baseUrl}/v1/embeddings`
  }
  return settings.baseUrl.endsWith('/api') ? `${settings.baseUrl}/embeddings` : `${settings.baseUrl}/api/embeddings`
}

const isVector = value => Array.isArray(value) && value.length > 0 && value.every(number => typeof number === 'number' && Number.isFinite(number))

const postJson = async (url, body, timeoutMs) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${url} answered with something that is not JSON`)
  }
}

// One round of vectors for `texts`, in the service's own shape. The openai shape takes a
// batch; ollama's prompt shape takes one text per call, so a batch is a short loop.
export async function embedTexts(settings, texts) {
  const wanted = texts.length
  if (wanted === 0) return []
  if (settings.endpoint === 'openai') {
    const body = await postJson(embeddingsUrl(settings), { model: settings.model, input: texts }, settings.timeoutMs)
    const data = Array.isArray(body?.data) ? body.data : []
    if (data.length !== wanted) throw new Error(`asked for ${wanted} vectors, got ${data.length}`)
    const ordered = [...data].sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0))
    const vectors = ordered.map(entry => entry?.embedding)
    for (const vector of vectors) if (!isVector(vector)) throw new Error('an embedding came back empty')
    return vectors
  }
  const vectors = []
  for (const text of texts) {
    const body = await postJson(embeddingsUrl(settings), { model: settings.model, prompt: text }, settings.timeoutMs)
    if (!isVector(body?.embedding)) throw new Error('an embedding came back empty')
    vectors.push(body.embedding)
  }
  return vectors
}

const slicesPath = home => join(home, 'memory-slices', 'slices.jsonl')

// Slices in the file that still want a vector. Read straight from the file so a restart
// (or a store that was not installed in this runtime) is no obstacle.
function unembeddedSlices(home) {
  const file = slicesPath(home)
  if (!existsSync(file)) return []
  const rows = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (row === null || typeof row !== 'object') continue
      if (typeof row.id !== 'string' || typeof row.text !== 'string') continue
      const hasVector = Array.isArray(row.embedding) ? row.embedding.length > 0 : row.embedding !== null && row.embedding !== undefined
      if (!hasVector) rows.push({ id: row.id, text: row.text })
    } catch {
      // A broken line is the store's business; skipping it here keeps the queue moving.
    }
  }
  return rows
}

export function install(rt) {
  const settings = resolveEmbeddingConfig(rt.config)
  const pending = new Map()
  const counts = { embedded: 0, failed: 0, rounds: 0 }
  let lastError = null
  let lastOkAt = null
  let retryAt = 0
  let timer = null
  let flushing = null

  const state = () => ({
    enabled: settings.enabled,
    wanted: settings.wanted,
    problem: settings.problem,
    endpoint: settings.endpoint,
    base_url: settings.baseUrl,
    model: settings.model,
    timeout_ms: settings.timeoutMs,
    pending: pending.size,
    embedded: counts.embedded,
    failed: counts.failed,
    rounds: counts.rounds,
    last_error: lastError,
    last_ok_at: lastOkAt,
    retry_at: retryAt,
  })

  const schedule = delay => {
    if (!settings.enabled || timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, delay)
    timer.unref?.()
  }

  // The store hands each written slice here; `flush()` is what actually calls the service.
  const queue = rows => {
    if (!settings.enabled) return 0
    let added = 0
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.id !== 'string' || typeof row.text !== 'string') continue
      if (Array.isArray(row.embedding) ? row.embedding.length > 0 : row.embedding !== null && row.embedding !== undefined) continue
      pending.set(row.id, row.text)
      added += 1
    }
    if (added > 0) schedule(0)
    return added
  }

  const scan = () => {
    if (!settings.enabled) return 0
    return queue(unembeddedSlices(rt.home))
  }

  const take = limit => {
    const out = []
    for (const [id, text] of pending) {
      out.push({ id, text })
      if (out.length >= limit) break
    }
    return out
  }

  const round = async () => {
    const batch = settings.endpoint === 'openai' ? settings.batch : 1
    const wanted = take(batch)
    counts.rounds += 1
    try {
      const vectors = await embedTexts(settings, wanted.map(row => row.text))
      const updates = wanted.map((row, index) => ({ id: row.id, embedding: vectors[index], embedding_model: settings.model }))
      const patched = (await rt.memorySlices?.patch?.(updates)) ?? 0
      for (const row of wanted) pending.delete(row.id)
      counts.embedded += updates.length
      lastOkAt = Date.now()
      lastError = null
      retryAt = 0
      if (pending.size > 0) schedule(0)
      return { embedded: updates.length, failed: 0, patched }
    } catch (error) {
      const message = error?.message ?? String(error)
      lastError = message
      retryAt = Date.now() + RETRY_MS
      counts.failed += 1
      rt.warn?.('ds-bot: memory embedding failed: %s', message)
      schedule(RETRY_MS)
      return { embedded: 0, failed: 1, error: message }
    }
  }

  // One round at a time; a caller that asks again while a round runs gets that round's
  // result instead of a second call to the service.
  const flush = () => {
    if (!settings.enabled) return Promise.resolve({ embedded: 0, failed: 0, skipped: 'disabled' })
    if (flushing !== null) return flushing
    if (pending.size === 0) return Promise.resolve({ embedded: 0, failed: 0 })
    if (Date.now() < retryAt) {
      schedule(retryAt - Date.now())
      return Promise.resolve({ embedded: 0, failed: 0, waiting: true })
    }
    flushing = round().finally(() => {
      flushing = null
    })
    return flushing
  }

  rt.ctx?.effect?.(() => () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }, 'ds-bot: memory embeddings')

  Object.assign(rt, {
    memoryEmbedding: {
      settings,
      state,
      queue,
      scan,
      flush,
      pending: () => pending.size,
    },
  })

  if (settings.enabled) {
    scan()
    schedule(0)
  }
}
