// The host's side of each call, written while the turn runs — M1b-1 item 2.
//
// M1b-0 could only project the host outcome after the fact, from `session.v4.jsonl.zstd`: a
// 90-frame zstd file Node decodes one frame of, so the projection was a script over a log the
// plugin could not read. A plugin can listen to `session/event` instead, so the facts are
// appended at the moment they happen, one JSON line each, and the seven-value projection is
// rebuilt from that file (§6.2).
//
// The file holds only what the projection needs: which call, which tool, what the approval card
// did, what the result was, and the Session's policy and preset. Arguments, message text and
// the approval's `reason` are never written — a fact log that repeated the conversation would
// be a second transcript, and the projection does not need one. The only free text kept is the
// host's own denial boilerplate, because that is what tells a rejection from a failure; a line
// that does not match one of those words is dropped (`text: ''`).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CANCELLED_TEXT, NO_CHANNEL_TEXT, REJECTION_TEXT, projectHostOutcome } from './host-outcome.js'
import { createRecorder } from './records.js'

/** The file §6.2 says the facts land in, next to the records. */
export const HOST_LOG_FILE = 'selfreview-host.jsonl'

/** Bumped when a line's shape changes, so a reader knows which parser to use. */
export const HOST_LOG_SCHEMA = 1

/** The keys a line may carry. Anything else is a writer bug, caught by the tests. */
export const HOST_LOG_FIELDS = [
  'schema', 'at', 'session_id', 'type', 'call_id', 'tool',
  'approval_id', 'outcome', 'policy', 'preset', 'is_error', 'text',
]

/** Keep the host's denial words, drop everything else a result may carry. */
const denialWords = (text) => {
  const value = String(text ?? '')
  return REJECTION_TEXT.test(value) || CANCELLED_TEXT.test(value) || NO_CHANNEL_TEXT.test(value) ? value : ''
}

/**
 * One session event as a fact line, or `undefined` when the event says nothing about a call.
 *
 * `tool/result` carries the tool's output in `data.message`; only its error flag and the host's
 * denial words are read, never the output.
 */
export function hostFact(sessionId, event, at = new Date().toISOString()) {
  const type = event?.type
  const data = event?.data ?? {}
  const base = { schema: HOST_LOG_SCHEMA, at, session_id: typeof sessionId === 'string' ? sessionId : null, type }
  if (type === 'tool/call') {
    return { ...base, call_id: typeof data.callId === 'string' ? data.callId : null, tool: typeof data.name === 'string' ? data.name : null }
  }
  if (type === 'tool/result') {
    const message = data.message ?? {}
    const text = Array.isArray(message.content)
      ? message.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
      : ''
    return {
      ...base,
      call_id: typeof message.toolCallId === 'string' ? message.toolCallId : (typeof data.callId === 'string' ? data.callId : null),
      is_error: message.isError === true,
      text: denialWords(text),
    }
  }
  if (type === 'approval/asked') {
    return {
      ...base,
      approval_id: typeof data.id === 'string' ? data.id : null,
      call_id: typeof data.callId === 'string' ? data.callId : null,
      tool: typeof data.toolName === 'string' ? data.toolName : null,
    }
  }
  if (type === 'approval/decided') {
    return { ...base, approval_id: typeof data.id === 'string' ? data.id : null, outcome: typeof data.outcome === 'string' ? data.outcome : null }
  }
  if (type === 'approval/policy') {
    return { ...base, policy: typeof data.policy === 'string' ? data.policy : null }
  }
  if (type === 'permission/preset') {
    return { ...base, preset: typeof data.preset === 'string' ? data.preset : null }
  }
  return undefined
}

/**
 * The writer: same rotation as the records (8MB, five deep), same rule that a lost line never
 * changes a decision.
 */
export function createHostLog({ dir, maxBytes, keep, warn, now = Date.now } = {}) {
  const recorder = createRecorder({ dir, file: HOST_LOG_FILE, maxBytes, keep, warn })
  return {
    file: HOST_LOG_FILE,
    path: recorder.path,
    append(session, event) {
      const row = hostFact(session?.id ?? session?.sessionId, event, new Date(now()).toISOString())
      if (row !== undefined) recorder.write(row)
    },
    async flush() {
      await recorder.flush()
    },
    stats: () => recorder.stats(),
  }
}

/** Read the file back, skipping a line that is not a complete JSON object. */
export function readHostLog(path) {
  if (!existsSync(path)) return []
  const rows = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (row !== null && typeof row === 'object') rows.push(row)
    } catch {
      // A half-written last line (the writer is not awaited) is skipped, not fatal.
    }
  }
  return rows
}

/** The last value of one fact type in one Session — the policy and preset are sticky. */
const sticky = (rows, type, key) => rows.filter(row => row.type === type).at(-1)?.[key] ?? 'unknown'

/**
 * Join the flat fact lines to the call they belong to.
 *
 * A `tool/call` line names its own call; the approval lines do not, so a card is bound to a
 * call through the `approval/asked` line that named both. A line with neither is a Session
 * fact (the policy, the preset) and belongs to no call.
 */
const callBinder = (rows) => {
  const askedCall = new Map()
  for (const row of rows) {
    if (row?.type === 'approval/asked' && typeof row.approval_id === 'string' && typeof row.call_id === 'string') {
      askedCall.set(row.approval_id, row.call_id)
    }
  }
  return (row) => {
    if (row === null || typeof row !== 'object') return undefined
    if (typeof row.call_id === 'string' && row.call_id !== '') return row.call_id
    if (typeof row.approval_id === 'string') return askedCall.get(row.approval_id)
    return undefined
  }
}

/** One fact line in the shape `projectHostOutcome` reads: a Session event. */
const eventOf = (row, callId) => {
  const event = { type: row.type, callId }
  if (typeof row.approval_id === 'string') event.approvalId = row.approval_id
  if (typeof row.outcome === 'string') event.outcome = row.outcome
  if (typeof row.tool === 'string') event.toolName = row.tool
  if (typeof row.is_error === 'boolean') event.isError = row.is_error
  if (typeof row.text === 'string') event.text = row.text
  return event
}

/** The lines of one Session — a call without a Session reads the whole file. */
const sessionRowsOf = (rows, sessionId) => sessionId === null || sessionId === undefined
  ? rows
  : rows.filter(row => row?.session_id === sessionId)

/**
 * Rebuild the seven-value projection for every call the fact file knows about.
 *
 * `records` is the product side of the same calls; a call without one is projected anyway and
 * carries `product: null`, which is how the d3 gap becomes visible instead of missing.
 */
export function rebuildHostOutcomes({ rows = [], records = [], isolated = false } = {}) {
  const callOf = callBinder(rows)
  const byCall = new Map()
  for (const row of rows) {
    const callId = callOf(row)
    if (callId === undefined) continue
    if (!byCall.has(callId)) byCall.set(callId, { sessionId: row.session_id, events: [] })
    byCall.get(callId).events.push(eventOf(row, callId))
  }
  const products = new Map()
  for (const record of records) {
    if (typeof record?.call_id === 'string') products.set(record.call_id, record)
  }
  return [...byCall].map(([callId, { sessionId, events }]) => projectHostOutcome({
    callId,
    events,
    product: products.get(callId),
    preset: sticky(sessionRowsOf(rows, sessionId), 'permission/preset', 'preset'),
    policy: sticky(sessionRowsOf(rows, sessionId), 'approval/policy', 'policy'),
    isolated,
  }))
}

/**
 * Answer "why did this call get this answer": the product record, the host's projection, and
 * the facts in the order they happened — the call's own lines plus the Session's policy and
 * preset, which decide what a card could have done.
 */
export function whyOf({ rows = [], records = [], callId, isolated = false } = {}) {
  const callOf = callBinder(rows)
  const owned = rows.filter(row => callOf(row) === callId)
  const sessionRows = sessionRowsOf(rows, owned[0]?.session_id)
  const record = records.find(entry => entry?.call_id === callId) ?? null
  const projection = projectHostOutcome({
    callId,
    events: owned.map(row => eventOf(row, callId)),
    product: record ?? undefined,
    preset: sticky(sessionRows, 'permission/preset', 'preset'),
    policy: sticky(sessionRows, 'approval/policy', 'policy'),
    isolated,
  })
  const timeline = sessionRows.filter(row => callOf(row) === callId || row?.type === 'permission/preset' || row?.type === 'approval/policy')
  return {
    call_id: callId,
    record,
    projection,
    timeline: timeline.map(row => ({
      at: row.at,
      type: row.type,
      ...(row.tool === null || row.tool === undefined ? {} : { tool: row.tool }),
      ...(row.approval_id === null || row.approval_id === undefined ? {} : { approval_id: row.approval_id }),
      ...(row.outcome === null || row.outcome === undefined ? {} : { outcome: row.outcome }),
      ...(row.is_error === undefined ? {} : { is_error: row.is_error }),
      ...(row.text === undefined || row.text === '' ? {} : { text: row.text }),
    })),
  }
}

/** Where the file lives for a given `<home>`. */
export const hostLogPath = home => join(home, 'company', HOST_LOG_FILE)
