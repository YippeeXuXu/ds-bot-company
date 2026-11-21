// Memory summaries (M2 G4 4.5): when a Bot has said much about one subject, its slices are
// merged into a single summary, so a long memory does not turn into twenty nearly equal
// pieces that crowd the recall.
//
//   slices (4.1)     <home>/memory-slices/slices.jsonl, 600–800 characters per row
//   archive (4.5)    <home>/memory-slices/archive.jsonl, the originals of every merge
//   summary          a slice row whose `summary_of` names the rows it was made from; the
//                    sources are archived, never lost, and one merge can be undone
//
// What counts as one subject: the same Bot, the same scene (chat or group), and either the
// same words (duplicates are dropped even when neither row has a vector) or a cosine
// similarity of at least `threshold` between their vectors. The threshold is calibrated per
// embedding model rather than assumed: 1024-dimensional bge-m3 and 384-dimensional MiniLM
// put unrelated text at very different distances, so the settings file remembers one value
// per `embedding_model` (see `thresholdFor`). A summary never becomes a source of
// another summary — that would grow without a bound; a Bot's memory is rebuilt from plain
// slices only.
//
// Who writes the text: the local model when a chat model is configured (Ollama
// `/api/chat` or an OpenAI-compatible `/v1/chat/completions`), and a plain, fact-preserving
// join of the distinct lines when it is not. A model that fails, times out, or answers
// nothing skips that group: no row is written, so a failed run leaves the memory exactly
// as it was. The run itself hangs off the same idle event the slicing uses — every
// `rounds` turns of a Bot, or once a day, whichever comes first.
//
// Where the model is configured (4.5.1): <home>/memory-summary.json, the same file the
// settings page writes, holding endpoint, base_url, model and timeout_ms. The file wins
// over the plugin config, so a value saved on the page reaches the next run without a
// restart; the plugin config is the default for a fresh home, not a second source of truth.
//
// Nothing here writes `state.json`, adds a company command, or calls a paid service.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Two pieces of one subject usually sit this close; 0.86 keeps different subjects apart
// without splitting one that was said twice in different words. This is only the fallback:
// a file calibrated on real vectors of a given model overrides it.
export const MERGE_THRESHOLD = 0.86
// Anything outside this range is not a similarity between normalised vectors.
export const THRESHOLD_MIN = 0.5
export const THRESHOLD_MAX = 0.95
// One duplicate is already worth merging; a single row is not a summary.
export const MERGE_MIN = 2
// A summary names at most this many sources, so one long run cannot swallow the memory.
export const MERGE_MAX = 6
// The summary itself never passes the slice maximum: it is a slice with sources.
export const SUMMARY_MAX = 800
// A Bot is looked at after this many of its own turns; a day is the slow backstop.
export const SUMMARY_ROUNDS = 20
export const SUMMARY_INTERVAL_MS = 24 * 60 * 60 * 1000
export const SUMMARY_TIMEOUT_MS = 15000
// The file the settings page writes; the same endpoint shapes the embedding client knows.
export const SETTINGS_FILE = 'memory-summary.json'
export const SUMMARY_ENDPOINTS = ['ollama', 'openai']
const MODEL_MAX = 80

export const settingsPathOf = home => join(home, SETTINGS_FILE)

// Which threshold this memory uses. A model that was measured on real vectors wins over the
// global value, and the global value over the built-in fallback; `model` is the
// `embedding_model` written on the slices, so switching embedding models does not silently
// apply the old model's calibration.
export function thresholdFor(model, saved = {}) {
  const name = typeof model === 'string' ? model.trim() : ''
  const byModel = saved?.merge_thresholds
  if (name !== '' && byModel !== null && typeof byModel === 'object') {
    const value = Number(byModel[name])
    if (Number.isFinite(value) && value >= THRESHOLD_MIN && value <= THRESHOLD_MAX) return value
  }
  const global = Number(saved?.merge_threshold)
  if (Number.isFinite(global) && global >= THRESHOLD_MIN && global <= THRESHOLD_MAX) return global
  return MERGE_THRESHOLD
}

// The model most of a memory's vectors came from: one Bot can hold rows embedded by two
// models after a switch, and the threshold must follow the majority, not the newest row.
export function dominantModel(rows = []) {
  const counts = new Map()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (!Array.isArray(row.embedding) || row.embedding.length === 0) continue
    const name = typeof row.embedding_model === 'string' ? row.embedding_model.trim() : ''
    if (name === '') continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  let best = ''
  let most = 0
  for (const [name, count] of counts) {
    if (count > most) {
      best = name
      most = count
    }
  }
  return best
}

// The saved settings, or nothing when the file is absent or unreadable. A broken file stays
// on disk: the next save replaces it, and the warning says why it was ignored.
export function readSavedSettings(home, warn) {
  const file = settingsPathOf(home)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    warn?.('ds-bot: %s cannot be read, the plugin config is used instead: %s', file, error?.message ?? String(error))
    return {}
  }
}

// Written through a temp file: a half-written JSON would be read as "no settings" on the
// next start, and the model the user configured would look like it was never saved.
export function writeSavedSettings(home, saved) {
  mkdirSync(home, { recursive: true })
  const file = settingsPathOf(home)
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(saved, null, 2)}\n`)
  renameSync(temp, file)
}

// Only the keys the page owns, each checked alone so the page can point at one field.
export function normalizeSettingsPatch(patch = {}) {
  const next = {}
  if ('endpoint' in patch) {
    if (!SUMMARY_ENDPOINTS.includes(patch.endpoint)) return { ok: false, field: 'endpoint', message: `the service must be one of ${SUMMARY_ENDPOINTS.join(', ')}` }
    next.endpoint = patch.endpoint
  }
  if ('base_url' in patch) {
    const url = String(patch.base_url ?? '').trim().replace(/\/+$/, '')
    if (url !== '' && !/^https?:\/\/\S+$/i.test(url)) return { ok: false, field: 'base_url', message: 'the address must start with http:// or https://' }
    next.base_url = url
  }
  if ('merge_threshold' in patch) {
    const value = Number(patch.merge_threshold)
    if (!Number.isFinite(value) || value < THRESHOLD_MIN || value > THRESHOLD_MAX) {
      return { ok: false, field: 'merge_threshold', message: `the merge threshold must be ${THRESHOLD_MIN}–${THRESHOLD_MAX}` }
    }
    next.merge_threshold = Math.round(value * 1000) / 1000
  }
  if ('merge_thresholds' in patch) {
    const map = patch.merge_thresholds
    if (map === null || typeof map !== 'object' || Array.isArray(map)) return { ok: false, field: 'merge_thresholds', message: 'the per-model thresholds must be an object' }
    const cleaned = {}
    for (const [model, raw] of Object.entries(map)) {
      const name = String(model).trim()
      if (name === '' || name.length > MODEL_MAX) return { ok: false, field: 'merge_thresholds', message: `a model name must be 1–${MODEL_MAX} characters` }
      const value = Number(raw)
      if (!Number.isFinite(value) || value < THRESHOLD_MIN || value > THRESHOLD_MAX) {
        return { ok: false, field: 'merge_thresholds', message: `the threshold for ${name} must be ${THRESHOLD_MIN}–${THRESHOLD_MAX}` }
      }
      cleaned[name] = Math.round(value * 1000) / 1000
    }
    next.merge_thresholds = cleaned
  }
  if ('model' in patch) {
    const model = String(patch.model ?? '').trim()
    if (model.length > MODEL_MAX) return { ok: false, field: 'model', message: `the model name is longer than ${MODEL_MAX} characters` }
    next.model = model
  }
  if ('timeout_ms' in patch) {
    if (!Number.isInteger(patch.timeout_ms) || patch.timeout_ms < 1_000 || patch.timeout_ms > 120_000) {
      return { ok: false, field: 'timeout_ms', message: 'the timeout must be 1000–120000 ms' }
    }
    next.timeout_ms = patch.timeout_ms
  }
  return { ok: true, next }
}

// The settings actually in force: the saved file over the plugin config, each value
// checked. `configured` is what the run asks before calling a model; `problem` names the
// missing piece so the page can say it instead of showing an empty field.
export function resolveSummarySettings(config = {}) {
  const endpoint = SUMMARY_ENDPOINTS.includes(config.endpoint) ? config.endpoint : 'ollama'
  const baseUrl = String(config.base_url ?? '').trim().replace(/\/+$/, '')
  const model = String(config.model ?? '').trim()
  const wanted = Number(config.timeout_ms)
  const timeoutMs = Number.isInteger(wanted) && wanted >= 1_000 && wanted <= 120_000 ? wanted : SUMMARY_TIMEOUT_MS
  const problem = baseUrl === '' ? 'base_url is not set' : model === '' ? 'model is not set' : null
  return { endpoint, baseUrl, model, timeoutMs, configured: problem === null, problem }
}

const timeOf = (row) => {
  const parsed = Date.parse(row?.created_at)
  return Number.isNaN(parsed) ? 0 : parsed
}

const isVector = value => Array.isArray(value) && value.length >= 2 && value.every(item => typeof item === 'number' && Number.isFinite(item))

// One number for how alike two slices are; 0 when either has no vector of the same length.
export function cosine(left, right) {
  if (!isVector(left) || !isVector(right) || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

// The words with case, spaces and punctuation flattened away, for "the same line twice".
export function normalizeText(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Plain slices of one Bot and one scene, oldest first; summaries and empty rows stay out.
const candidatesOf = (rows) => (Array.isArray(rows) ? rows : [])
  .filter(row => row !== null && typeof row === 'object')
  .filter(row => typeof row.id === 'string' && typeof row.text === 'string' && row.text.trim() !== '')
  .filter(row => !Array.isArray(row.summary_of) || row.summary_of.length === 0)
  .sort((left, right) => timeOf(left) - timeOf(right) || String(left.id).localeCompare(String(right.id)))

// Groups of rows that are one subject: identical words, or vectors this close. Groups are
// connected pieces — A joins B, B joins C, so one subject said three ways is one group.
export function groupSlices(rows, { threshold = MERGE_THRESHOLD, min = MERGE_MIN, max = MERGE_MAX } = {}) {
  const candidates = candidatesOf(rows)
  const parent = candidates.map((_, index) => index)
  const find = (index) => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    while (parent[index] !== root) {
      const next = parent[index]
      parent[index] = root
      index = next
    }
    return root
  }
  const union = (left, right) => {
    const leftRoot = find(left)
    const rightRoot = find(right)
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot
  }
  const byText = new Map()
  candidates.forEach((row, index) => {
    const key = `${row.bot_id}\u0000${row.kind}\u0000${normalizeText(row.text)}`
    const first = byText.get(key)
    if (first === undefined) byText.set(key, index)
    else union(first, index)
  })
  for (let left = 0; left < candidates.length; left += 1) {
    const leftRow = candidates[left]
    if (!isVector(leftRow.embedding)) continue
    for (let right = left + 1; right < candidates.length; right += 1) {
      const rightRow = candidates[right]
      if (leftRow.bot_id !== rightRow.bot_id || leftRow.kind !== rightRow.kind) continue
      if (!isVector(rightRow.embedding)) continue
      if (cosine(leftRow.embedding, rightRow.embedding) >= threshold) union(left, right)
    }
  }
  const groups = new Map()
  candidates.forEach((row, index) => {
    const root = find(index)
    const group = groups.get(root)
    if (group === undefined) groups.set(root, [row])
    else group.push(row)
  })
  return [...groups.values()]
    .filter(group => group.length >= Math.max(2, min))
    .map(group => group.slice(0, Math.max(2, max)))
}

// The text when no model is configured: every distinct line of the sources, oldest first,
// with one line saying how many turns it came from. Facts are kept, not paraphrased.
export function summaryText(rows, { max = SUMMARY_MAX } = {}) {
  const sources = candidatesOf(rows)
  const lines = []
  const seen = new Set()
  for (const row of sources) {
    for (const piece of String(row.text).split('\n')) {
      const line = piece.replace(/\s+/g, ' ').trim()
      if (line === '') continue
      const key = line.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(line)
    }
  }
  const head = `Merged from ${sources.length} earlier turns on one subject: `
  const text = `${head}${lines.join(' / ')}`
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// Endpoint shapes shared with the embedding client (4.3): Ollama first, OpenAI-compatible
// second. The summary call is a chat call either way.
const chatUrl = (settings) => {
  const base = String(settings?.baseUrl ?? settings?.base_url ?? '').trim().replace(/\/+$/, '')
  if (base === '') return ''
  if (settings?.endpoint === 'openai') return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  return `${base}/api/chat`
}

const summaryPrompt = (rows) => [
  'Summarize these pieces of earlier conversations into one short paragraph.',
  'Keep names, numbers and decisions exactly as they are; do not add anything.',
  'Reply with the summary only.',
  '',
  ...rows.map(row => `- ${String(row.text).replace(/\s+/g, ' ').trim()}`),
].join('\n')

const readAnswer = (data) => {
  const content = data?.message?.content ?? data?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

// Ask the configured chat model. Resolves with the text, rejects when the service cannot be
// reached, answers with a non-2xx status, or answers nothing at all.
export async function askModel(settings, rows, { fetchImpl = fetch, timeoutMs = SUMMARY_TIMEOUT_MS } = {}) {
  const url = chatUrl(settings)
  if (url === '') throw new Error('the summary service address is not set')
  const body = settings?.endpoint === 'openai'
    ? { model: settings?.model, messages: [{ role: 'user', content: summaryPrompt(rows) }], temperature: 0 }
    : { model: settings?.model, messages: [{ role: 'user', content: summaryPrompt(rows) }], stream: false }
  let answer
  try {
    answer = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    // The page and the report show this text, so name the address and the real reason
    // instead of a bare "fetch failed".
    const reason = error?.name === 'TimeoutError'
      ? `no answer within ${Math.round(timeoutMs / 1000)} s`
      : (error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error))
    throw new Error(`${url} could not be reached (${reason})`)
  }
  if (!answer.ok) throw new Error(`${url} answered ${answer.status}`)
  const text = readAnswer(await answer.json())
  if (text === '') throw new Error(`${url} answered nothing`)
  return text
}

const nowIso = () => new Date().toISOString()

export function install(rt) {
  const { ctx } = rt
  const rounds = new Map()
  const state = { last_run_at: null, last_result: null, problem: null }
  // The settings file wins over the plugin config: a value saved on the page is already in
  // force for the next run, without a restart.
  let saved = readSavedSettings(rt.home, rt.warn)

  const raw = () => ({ ...rt.config?.memorySummary, ...saved })
  // Which model's calibration the page should show before the first run: the last run's
  // model when there is one, else the embedding model currently configured.
  // The last model that actually had vectors is what the page should show; a run that
  // merged everything leaves no vectorised rows behind and must not flip the display back
  // to the built-in fallback.
  let lastModel = ''
  const currentModel = () => {
    const fromRun = state.last_result?.model
    if (typeof fromRun === 'string' && fromRun !== '') return fromRun
    if (lastModel !== '') return lastModel
    const configured = rt.memoryEmbedding?.settings?.model
    return typeof configured === 'string' ? configured : ''
  }
  const settings = () => resolveSummarySettings(raw())
  const canAsk = () => settings().configured

  // One group, one row. A model failure or an empty answer skips the group and writes
  // nothing; a merge that lost a source cancels itself inside the store.
  const mergeGroup = async (group) => {
    let text
    if (canAsk()) {
      const options = settings()
      // `askModel` holds its own abort timer set to `timeout_ms`; a second, fixed cap on
      // top of it would cut a slower model short and skip a group the user did configure.
      text = await askModel(options, group, { timeoutMs: options.timeoutMs })
    } else {
      text = summaryText(group)
    }
    const trimmed = String(text ?? '').trim()
    if (trimmed === '') return { merged: 0, skipped: 1 }
    const newest = group[group.length - 1]
    const summary = {
      bot_id: newest.bot_id ?? null,
      project_id: newest.project_id ?? null,
      // A summary spans conversations; it belongs to no single one, and recall excludes a
      // row only when its session is the one being answered.
      session_id: null,
      kind: newest.kind ?? 'chat',
      text: trimmed.length <= SUMMARY_MAX ? trimmed : `${trimmed.slice(0, SUMMARY_MAX - 1)}…`,
      tokens: Math.ceil(trimmed.length / 4),
      embedding: null,
      embedding_model: null,
      created_at: nowIso(),
      last_used_at: nowIso(),
      uses: 0,
      summary_of: group.map(row => row.id),
    }
    const answer = await rt.memorySlices.merge({ summary, sourceIds: summary.summary_of })
    if ((answer?.merged ?? 0) === 0) return { merged: 0, skipped: 1 }
    return { merged: answer.merged, skipped: 0 }
  }

  const run = async (botId) => {
    const rows = await rt.memorySlices?.list?.()
    const mine = (rows ?? []).filter(row => botId === undefined || row.bot_id === botId)
    // Calibration is per embedding model: the same two sentences sit at 0.7 under MiniLM and
    // at 0.9 under bge-m3, so one fixed number cannot serve both.
    const model = dominantModel(mine)
    if (model !== '') lastModel = model
    const threshold = thresholdFor(model === '' ? lastModel : model, saved)
    const groups = groupSlices(mine, { threshold })
    let merged = 0
    let skipped = 0
    for (const group of groups) {
      try {
        const answer = await mergeGroup(group)
        merged += answer.merged
        skipped += answer.skipped
      } catch (error) {
        skipped += 1
        state.problem = error?.message ?? String(error)
        rt.warn?.('ds-bot: memory summary skipped a group: %s', state.problem)
      }
    }
    state.last_run_at = nowIso()
    state.last_result = { bot_id: botId ?? null, groups: groups.length, merged, skipped, threshold, model: model === '' ? null : model }
    return state.last_result
  }

  const runAll = async () => {
    const rows = await rt.memorySlices?.list?.()
    const bots = [...new Set((rows ?? []).map(row => row.bot_id).filter(id => id !== null && id !== undefined))]
    let merged = 0
    let skipped = 0
    for (const botId of bots) {
      try {
        const answer = await run(botId)
        merged += answer.merged
        skipped += answer.skipped
      } catch (error) {
        skipped += 1
        state.problem = error?.message ?? String(error)
        rt.warn?.('ds-bot: memory summary for %s failed: %s', botId, state.problem)
      }
    }
    return { bots: bots.length, merged, skipped }
  }

  // A Bot's own turn ends: count it, and look at the memory every `rounds` turns. A daily
  // timer is the backstop for a Bot that has gone quiet with duplicates still in place.
  if (typeof ctx?.on === 'function') {
    ctx.on('agent/status', ({ agent, status }) => {
      const id = agent?.id
      if (typeof id !== 'string' || status !== 'idle') return
      const botId = rt.selfOf?.(id)
      if (botId === undefined) return
      const counted = (rounds.get(botId) ?? 0) + 1
      rounds.set(botId, counted)
      const every = Number(raw().rounds) > 1 ? Number(raw().rounds) : SUMMARY_ROUNDS
      if (counted < every) return
      rounds.set(botId, 0)
      void run(botId)
    })
    ctx.effect?.(() => {
      const timer = setInterval(() => { void runAll() }, SUMMARY_INTERVAL_MS)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'ds-bot: memory summary timer')
  }

  // The page's save: file first, then the running module, so the next run of this host
  // already asks the model the page shows. A refusal names the field it is about.
  const save = (patch) => {
    const checked = normalizeSettingsPatch(patch)
    if (!checked.ok) return { ok: false, field: checked.field, message: checked.message, state: stateOf() }
    const next = { ...saved, ...checked.next }
    try {
      writeSavedSettings(rt.home, next)
    } catch (error) {
      return { ok: false, field: null, message: `the settings could not be written: ${error?.message ?? String(error)}`, state: stateOf() }
    }
    saved = next
    return { ok: true, state: stateOf() }
  }

  const stateOf = () => {
    const options = settings()
    return {
      ...state,
      configured: options.configured,
      // A missing field is what the page must say, even when an older run failed: the user
      // has to fix the address or the model name before anything else can work.
      problem: options.problem ?? state.problem,
      endpoint: options.endpoint,
      base_url: options.baseUrl,
      model: options.model,
      timeout_ms: options.timeoutMs,
      // What the next run will use, and where that number came from.
      merge_threshold: thresholdFor(currentModel(), saved),
      merge_thresholds: { ...saved.merge_thresholds },
      saved: { ...saved },
      settings_path: settingsPathOf(rt.home),
      rounds: Object.fromEntries(rounds),
      enabled: options.configured,
    }
  }

  Object.assign(rt, {
    memorySummary: {
      run,
      runAll,
      text: summaryText,
      groups: groupSlices,
      threshold: MERGE_THRESHOLD,
      threshold_for: model => thresholdFor(model, saved),
      dominant_model: dominantModel,
      settings,
      save,
      state: stateOf,
    },
  })
}

// Where the archive lives, for tests and for the report.
export const archiveOf = home => join(home, 'memory-slices', 'archive.jsonl')
