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
// similarity of at least 0.86 between their vectors. A summary never becomes a source of
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
// Nothing here writes `state.json`, adds a company command, or calls a paid service.
import { join } from 'node:path'

// Two pieces of one subject usually sit this close; 0.86 keeps different subjects apart
// without splitting one that was said twice in different words.
export const MERGE_THRESHOLD = 0.86
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
  const base = String(settings?.base_url ?? '').trim().replace(/\/+$/, '')
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

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms)
  promise.then(
    value => { clearTimeout(timer); resolve(value) },
    error => { clearTimeout(timer); reject(error) },
  )
})

const nowIso = () => new Date().toISOString()

export function install(rt) {
  const { ctx } = rt
  const rounds = new Map()
  const state = { last_run_at: null, last_result: null, problem: null }

  const settings = () => (rt.config?.memorySummary !== undefined && typeof rt.config.memorySummary === 'object' ? rt.config.memorySummary : {})
  const canAsk = () => {
    const options = settings()
    return typeof options.model === 'string' && options.model !== '' && chatUrl(options) !== ''
  }

  // One group, one row. A model failure or an empty answer skips the group and writes
  // nothing; a merge that lost a source cancels itself inside the store.
  const mergeGroup = async (group) => {
    let text
    if (canAsk()) {
      text = await withTimeout(askModel(settings(), group, { timeoutMs: Number(settings().timeout_ms) || SUMMARY_TIMEOUT_MS }), SUMMARY_TIMEOUT_MS)
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
    const groups = groupSlices(mine)
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
    state.last_result = { bot_id: botId ?? null, groups: groups.length, merged, skipped }
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
      const every = Number(settings().rounds) > 1 ? Number(settings().rounds) : SUMMARY_ROUNDS
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

  Object.assign(rt, {
    memorySummary: {
      run,
      runAll,
      text: summaryText,
      groups: groupSlices,
      threshold: MERGE_THRESHOLD,
      state: () => ({ ...state, rounds: Object.fromEntries(rounds), enabled: canAsk() }),
    },
  })
}

// Where the archive lives, for tests and for the report.
export const archiveOf = home => join(home, 'memory-slices', 'archive.jsonl')
