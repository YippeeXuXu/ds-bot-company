// Memory slices (M2 G4 4.1 + 4.2): what a Bot and the user said, kept in pieces small
// enough to embed and to recall later, apart from the Markdown memory that a Bot writes
// on purpose (src/host/memory.js).
//
//   <home>/memory-slices/slices.jsonl   one JSON object per line, the 12 fields of the
//                                       contract, never inside state.json
//   <home>/memory-slices/cursors.json   how far each conversation has been sliced
//
// A slice is written when a turn ends, not while it runs: the `agent/status` hook turns
// to idle, the new lines of that turn are read from the conversation, every saved secret
// and every key-shaped run is taken out of the text, and the turn is cut into pieces of
// at most 800 characters (600 is the size a piece aims for; a short turn stays one piece,
// so three turns make three slices).
//
// Nothing here calls a model: the embedding fields stay null until the local model is
// configured (4.3), so the store and the deciding of what a slice is can be finished and
// tested while the model is still being chosen. A slice whose Bot is gone stays readable
// (5,000 per Bot is the cap, one row over is refused, nothing is deleted on its own).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { appendFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { looksLikeKey } from './memory.js'

// The fields a line carries, in the order the contract lists them.
export const SLICE_FIELDS = [
  'id', 'bot_id', 'project_id', 'session_id', 'kind', 'text',
  'tokens', 'embedding', 'embedding_model', 'created_at', 'last_used_at', 'uses',
]
export const SLICE_KINDS = ['chat', 'group']
// A piece aims at 600 characters and never goes past 800; the content decides.
export const SLICE_TARGET = 600
export const SLICE_MAX = 800
// Two books, two caps (D2): the Markdown memory keeps its 500 entries, a Bot's slices
// stop at 5,000. Nothing is deleted automatically — the cap refuses the row and says so.
export const SLICES_PER_BOT = 5000
const READ_MS = 5000
const HOOK_DELAY_MS = 1000

const sliceId = () => `sl_${randomBytes(6).toString('hex')}`
const estimateTokens = text => Math.ceil(text.length / 4)

// The store: one JSONL file, appended to under a promise chain so two turns ending at
// once cannot interleave half-lines, and a cursor map that says how far each
// conversation has been sliced. A line that cannot be parsed is skipped with a warning
// rather than repaired or dropped from the file.
export function createSliceStore({ dir, now = () => Date.now(), warn = () => {} }) {
  const file = join(dir, 'slices.jsonl')
  const cursorsPath = join(dir, 'cursors.json')
  let writing = Promise.resolve()

  const read = () => {
    if (!existsSync(file)) return []
    const out = []
    const lines = readFileSync(file, 'utf8').split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.trim() === '') continue
      try {
        const row = JSON.parse(line)
        if (row !== null && typeof row === 'object' && typeof row.id === 'string') out.push(row)
        else warn('ds-bot: memory slice line %d is not a slice', index + 1)
      } catch {
        warn('ds-bot: memory slice line %d cannot be parsed', index + 1)
      }
    }
    return out
  }

  const readCursors = () => {
    if (!existsSync(cursorsPath)) return {}
    try {
      const cursors = JSON.parse(readFileSync(cursorsPath, 'utf8'))
      return cursors !== null && typeof cursors === 'object' && !Array.isArray(cursors) ? cursors : {}
    } catch {
      warn('ds-bot: memory slice cursors cannot be parsed; slicing starts again')
      return {}
    }
  }

  const writeCursors = async (cursors) => {
    mkdirSync(dir, { recursive: true })
    await writeFile(cursorsPath, `${JSON.stringify(cursors, null, 2)}\n`)
  }

  const countOf = botId => read().filter(row => row.bot_id === botId).length

  // Rows keep the contract's field order and nothing more; a row that would be the
  // 5,001st for its Bot is refused by name, so a caller learns rather than loses it.
  const append = (rows) => {
    const kept = []
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      const line = { id: row.id ?? sliceId() }
      for (const field of SLICE_FIELDS) {
        if (field === 'id') continue
        line[field] = row[field] === undefined ? null : row[field]
      }
      line.created_at = line.created_at ?? now()
      line.last_used_at = line.last_used_at ?? line.created_at
      line.uses = line.uses ?? 0
      kept.push(line)
    }
    writing = writing.then(async () => {
      const counts = new Map()
      for (const row of read()) counts.set(row.bot_id, (counts.get(row.bot_id) ?? 0) + 1)
      const accepted = []
      for (const row of kept) {
        const used = counts.get(row.bot_id) ?? 0
        if (used >= SLICES_PER_BOT) {
          warn('ds-bot: memory slices for Bot %s are at the %d-slice cap; %s is not kept', row.bot_id, SLICES_PER_BOT, row.id)
          continue
        }
        counts.set(row.bot_id, used + 1)
        accepted.push(row)
      }
      if (accepted.length === 0) return []
      mkdirSync(dir, { recursive: true })
      await appendFile(file, `${accepted.map(row => JSON.stringify(row)).join('\n')}\n`)
      return accepted
    })
    return writing
  }

  // Fill fields in on rows that are already on disk (4.3 writes a vector this way). The
  // whole file is rewritten, under the same chain the appends use.
  const patch = (updates) => {
    const byId = new Map()
    for (const update of Array.isArray(updates) ? updates : [updates]) {
      if (update === null || typeof update !== 'object' || typeof update.id !== 'string') continue
      byId.set(update.id, update)
    }
    writing = writing.then(async () => {
      if (byId.size === 0) return 0
      const rows = read()
      let changed = 0
      const next = rows.map(row => {
        const update = byId.get(row.id)
        if (update === undefined) return row
        const merged = { ...row }
        for (const [field, value] of Object.entries(update)) {
          if (field === 'id') continue
          merged[field] = value
        }
        changed += 1
        return merged
      })
      if (changed > 0) {
        mkdirSync(dir, { recursive: true })
        const temp = `${file}.tmp`
        await writeFile(temp, `${next.map(row => JSON.stringify(row)).join('\n')}\n`)
        await rename(temp, file)
      }
      return changed
    })
    return writing
  }

  const remove = (ids) => {
    const wanted = new Set(ids)
    writing = writing.then(async () => {
      const kept = read().filter(row => !wanted.has(row.id))
      mkdirSync(dir, { recursive: true })
      const temp = `${file}.tmp`
      await writeFile(temp, kept.length === 0 ? '' : `${kept.map(row => JSON.stringify(row)).join('\n')}\n`)
      await rename(temp, file)
      return kept.length
    })
    return writing
  }

  const clear = (botId) => {
    writing = writing.then(async () => {
      const kept = read().filter(row => row.bot_id !== botId)
      mkdirSync(dir, { recursive: true })
      const temp = `${file}.tmp`
      await writeFile(temp, kept.length === 0 ? '' : `${kept.map(row => JSON.stringify(row)).join('\n')}\n`)
      await rename(temp, file)
      return kept.length
    })
    return writing
  }

  return { dir, file, cursorsPath, read, readCursors, writeCursors, countOf, append, patch, remove, clear, now, warn }
}

// One turn, cut into pieces. Newlines stay (they mark who spoke); a piece never passes
// SLICE_MAX, and one that would end shorter than a third of the target joins the piece
// before it when the two fit. A single line longer than the maximum is cut on its own.
export function chunkTurn(text, { target = SLICE_TARGET, max = SLICE_MAX } = {}) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return []
  if (trimmed.length <= max) return [trimmed]
  const pieces = []
  let current = ''
  const flush = () => {
    const piece = current.trim()
    if (piece !== '') pieces.push(piece)
    current = ''
  }
  for (const line of trimmed.split('\n')) {
    let rest = line
    while (rest.length > max) {
      if (current !== '') flush()
      pieces.push(rest.slice(0, max))
      rest = rest.slice(max)
    }
    if (current === '') current = rest
    else if (current.length + 1 + rest.length <= target) current = `${current}\n${rest}`
    else if (current.length + 1 + rest.length <= max) current = `${current}\n${rest}`
    else {
      flush()
      current = rest
    }
  }
  flush()
  // A tail too small to stand alone joins the piece before it when the two fit.
  if (pieces.length > 1 && pieces.at(-1).length < target / 3) {
    const last = pieces.at(-1)
    const before = pieces.at(-2)
    if (before.length + 1 + last.length <= max) {
      pieces.splice(-2, 2, `${before}\n${last}`)
    }
  }
  return pieces
}

// A key pasted into Chinese prose has no space around it: the whole sentence is one
// word, and replacing the word would take the sentence with it. So inside a word, cut out
// only the runs that read as a key; the rest of the sentence stays.
const KEY_RUN = /[A-Za-z0-9+/=_.-]{12,}/g

function scrubWord(word) {
  if (!looksLikeKey(word)) return word
  const kept = word.replace(KEY_RUN, run => (looksLikeKey(run) ? '[secret]' : run))
  // Something that still reads as a key but is not one run (a header, say) goes whole.
  return looksLikeKey(kept) ? '[secret]' : kept
}

export function cleanTurnText(rt, text) {
  const redacted = typeof rt.redactSecrets === 'function' ? rt.redactSecrets(text) : text
  return redacted
    .split('\n')
    .map(line => (looksLikeKey(line) ? line.replace(/\S+/g, scrubWord) : line))
    .join('\n')
}

export function install(rt) {
  const dir = join(rt.home, 'memory-slices')
  const store = createSliceStore({ dir, now: () => Date.now(), warn: (...args) => rt.warn?.(...args) })
  const cursors = store.readCursors()
  const timers = new Map()
  let chain = Promise.resolve()
  let running = 0

  const saveCursors = () => store.writeCursors(cursors)

  // A turn's lines, newest first, as `partLines` gives them. A first sight of a
  // conversation keeps only its latest turn: a Bot with a long history does not get
  // its whole past sliced the moment this version starts.
  async function readNewLines(sessionId) {
    const since = cursors[sessionId]
    const lines = []
    for await (const line of rt.partLines(sessionId, AbortSignal.timeout(READ_MS), { pages: Infinity })) {
      if (since === undefined) {
        lines.push(line)
        if (line.who === 'user') break
        continue
      }
      if (line.seq <= since) break
      lines.push(line)
    }
    return lines.reverse()
  }

  const turnsOf = (lines) => {
    const turns = []
    let current = null
    for (const line of lines) {
      if (line.who === 'user' || current === null) {
        current = { lines: [line] }
        turns.push(current)
        continue
      }
      current.lines.push(line)
    }
    return turns.filter(turn => turn.lines.some(line => String(line.text ?? '').trim() !== ''))
  }

  // The host hands lines back already prefixed ("User: …", "You: …"). A slice says who
  // spoke in its own two words — `User:` and `Bot:` — so the host's prefix is dropped and
  // the Bot's lines read the same whether the host called them "You" or "bot".
  const HOST_PREFIX = /^(?:User|You|Bot|user|you|bot)\s*[:：]\s*/
  const saidBy = line => {
    const body = String(line.text ?? '').replace(HOST_PREFIX, '')
    return `${line.who === 'user' ? 'User: ' : 'Bot: '}${body}`
  }

  const rowsOf = ({ turns, botId, projectId, sessionId, kind }) => {
    const rows = []
    for (const turn of turns) {
      const text = cleanTurnText(rt, turn.lines.map(saidBy).join('\n'))
      for (const piece of chunkTurn(text)) {
        rows.push({
          bot_id: botId, project_id: projectId, session_id: sessionId, kind,
          text: piece, tokens: estimateTokens(piece), embedding: null, embedding_model: null,
          created_at: Date.now(),
        })
      }
    }
    return rows
  }

  const projectTagOf = (botId, at) => {
    try {
      return typeof rt.memoryProjectOf === 'function' ? rt.memoryProjectOf(botId, at) ?? null : null
    } catch {
      return null
    }
  }

  // The Bot's own chat: one turn per user message, the Bot's answer included.
  async function captureChat(sessionId, botId) {
    const lines = await readNewLines(sessionId)
    if (lines.length > 0) {
      const at = lines.at(-1).time ?? Date.now()
      const rows = rowsOf({ turns: turnsOf(lines), botId, projectId: projectTagOf(botId, at), sessionId, kind: 'chat' })
      if (rows.length > 0) offer(await store.append(rows))
    }
    const newest = Math.max(...lines.map(line => line.seq ?? 0), cursors[sessionId] ?? 0)
    if (newest > 0) cursors[sessionId] = newest
    await saveCursors()
    return lines.length
  }

  // A group round: the group's log between two user messages, all members together.
  async function captureGroup(sessionId, { roomId, botId }) {
    const room = rt.roomOf?.(roomId)
    if (room === undefined) return 0
    const key = `group:${roomId}`
    const since = cursors[key]
    const log = (room.log ?? []).filter(entry => entry.kind === undefined && typeof entry.text === 'string' && entry.text.trim() !== '')
    const fresh = log.filter(entry => since === undefined ? false : entry.seq > since)
    const latestTurn = () => {
      const lastUser = log.findLastIndex(entry => entry.who === 'User' && entry.botId === undefined)
      return log.slice(lastUser === -1 ? Math.max(0, log.length - 1) : lastUser)
    }
    const picked = since === undefined ? latestTurn() : log.length === 0 ? [] : fresh
    if (picked.length > 0) {
      const lines = picked.map(entry => ({
        who: entry.who === 'User' && entry.botId === undefined ? 'user' : 'bot',
        text: `${entry.who === 'User' && entry.botId === undefined ? 'User' : entry.who === 'You' ? 'Bot' : entry.who}: ${String(entry.text).replace(HOST_PREFIX, '')}`,
        seq: entry.seq,
        time: entry.time,
      }))
      const sliceOwner = botId ?? rt.chatOwners?.get(sessionId) ?? null
      const at = lines.at(-1).time ?? Date.now()
      const rows = rowsOf({ turns: turnsOf(lines), botId: sliceOwner, projectId: projectTagOf(sliceOwner, at), sessionId: roomId, kind: 'group' })
      if (rows.length > 0) offer(await store.append(rows))
    }
    const newest = Math.max(...picked.map(entry => entry.seq ?? 0), since ?? 0)
    if (newest > 0) cursors[key] = newest
    await saveCursors()
    return picked.length
  }

  // A fresh slice is offered to the embedding queue (4.3) and then forgotten here: that
  // module has its own retry and never makes this path wait for a model call.
  const offer = rows => {
    if (Array.isArray(rows) && rows.length > 0) rt.memoryEmbedding?.queue?.(rows)
    return rows
  }

  const capture = (sessionId) => {
    chain = chain.then(async () => {
      running += 1
      try {
        const botId = rt.chatOwners?.get(sessionId)
        if (botId !== undefined) return await captureChat(sessionId, botId)
        const group = rt.groupOwners?.get(sessionId) ?? rt.pastOwners?.get(sessionId)
        if (group?.roomId !== undefined) return await captureGroup(sessionId, group)
        return 0
      } catch (error) {
        rt.warn?.('ds-bot: memory slices for %s failed: %s', sessionId, error?.message ?? error)
        return 0
      } finally {
        running -= 1
      }
    })
    return chain
  }

  // The review hook: when a turn ends, slice what it said, once the idle event has let
  // the rest of the host finish. A turn that starts again before the delay cancels it.
  if (typeof rt.ctx?.on === 'function') {
    rt.ctx.on('agent/status', ({ agent, status }) => {
      const id = agent?.id
      if (id === undefined) return
      clearTimeout(timers.get(id))
      timers.delete(id)
      if (status !== 'idle') return
      const timer = setTimeout(() => {
        timers.delete(id)
        void capture(id)
      }, HOOK_DELAY_MS)
      timer.unref?.()
      timers.set(id, timer)
    })
    rt.ctx.effect?.(() => () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }, 'ds-bot: memory slices')
  }

  Object.assign(rt, {
    memorySlices: {
      dir, file: store.file, cursorsPath: store.cursorsPath,
      list: () => store.read(),
      count: botId => store.countOf(botId),
      remove: ids => store.remove(ids),
      patch: updates => store.patch(updates),
      clear: botId => store.clear(botId),
      capture,
      pending: () => timers.size + running,
    },
  })
}
