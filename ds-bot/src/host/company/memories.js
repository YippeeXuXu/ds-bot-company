// Company memories (M1b-5.1): what a project's Bots and cards leave behind, kept in one
// table beside the company rather than in a tree of files.
//
// Two things write a row, neither of them a screen: a Bot's turn ends in a project group,
// and a card reaches Done. Both are idempotent through `idempotency_key`, so a replayed
// turn or a card read twice still leaves one row. A person can only delete: soft, so the
// row leaves recall and stays readable for the audit trail (contract §5.6).
//
// Not here: recalling entries into a prompt (5.2), revisions, journal, candidates, promotion.
import { randomUUID } from 'node:crypto'
import { companyFail } from './store.js'

// `memory.delete` is answered with the entry's own revision: the row is what changed under
// the caller, so the envelope leaves that comparison to the handler.
export const MEMORY_ROW_REVISION_COMMANDS = new Set(['memory.delete'])

const STATEMENT_MAX = 600
const TAGS_MAX = 8
const TAG_MAX = 24
const ROW_MAX_BYTES = 4096
// 500, not more: `state.json` is rewritten whole on every commit, and each entry may hold
// 600 characters of text. 500 keeps a busy project near 300K and still leaves room in a
// file every company command has to carry.
const PER_PROJECT_CAP = 500
const KINDS = ['fact', 'decision', 'constraint', 'hypothesis', 'lesson']
const LIST_DEFAULT = 50
const LIST_MAX = 200

const tagList = (value) => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw companyFail('company/invalid', 'tags must be a list of words.', { field: 'tags' })
  if (value.length > TAGS_MAX) throw companyFail('company/invalid', `tags holds at most ${TAGS_MAX} words.`, { field: 'tags', max: TAGS_MAX })
  return value.map((tag) => {
    const word = typeof tag === 'string' ? tag.trim() : ''
    if (word === '' || word.length > TAG_MAX) throw companyFail('company/invalid', `A tag is 1 to ${TAG_MAX} characters.`, { field: 'tags', max: TAG_MAX })
    return word
  })
}

const memoryId = () => `mem_${randomUUID().replaceAll('-', '').slice(0, 24)}`

const pruneTo = (state, projectId, now) => {
  const rows = Object.values(state.memories ?? {})
    .filter(entry => entry.project_id === projectId && entry.deleted_at === null)
    .sort((left, right) => (left.created_at - right.created_at) || left.id.localeCompare(right.id))
  const excess = rows.length - PER_PROJECT_CAP
  if (excess <= 0) return []
  // Pinned entries do not age out: the point of pinning is that the owner keeps it.
  const victims = rows.filter(entry => entry.pinned !== true).slice(0, excess)
  for (const entry of victims) {
    entry.deleted_at = now()
    entry.updated_at = entry.deleted_at
    entry.delete_reason = 'pruned'
    entry.deleted_by = 'company'
    entry.revision += 1
  }
  return victims
}

// The one place a row's shape is decided, so the two writers and any later command agree.
// `statement` arrives already redacted: the caller owns the home path and the secret
// scrubber, because only it knows the host.
export function memoryRow({
  at,
  projectId,
  kind,
  statement,
  tags = [],
  sourceRefs = [],
  employeeId = null,
  botId = null,
  origin = null,
  idempotencyKey,
  id = memoryId(),
}) {
  const words = tagList(tags)
  const full = typeof statement === 'string' ? statement.trim() : ''
  const kept = full.length > STATEMENT_MAX ? `${full.slice(0, STATEMENT_MAX - 1)}…` : full
  const row = {
    id,
    ownership_level: 'project',
    scope_id: projectId,
    project_id: projectId,
    owner_bot_id: botId,
    employee_id: employeeId,
    kind,
    lifecycle: 'active',
    pinned: false,
    statement: kept,
    statement_truncated: full.length > STATEMENT_MAX,
    tags: words,
    source_refs: sourceRefs,
    origin,
    idempotency_key: idempotencyKey,
    usage_refs: [],
    revision: 1,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    deleted_by: null,
    delete_reason: null,
  }
  // A row that would not fit is not saved at all: a half-statement read later is worse
  // than no entry, and the cap is what keeps the file writable.
  if (Buffer.byteLength(JSON.stringify(row)) > ROW_MAX_BYTES) {
    throw companyFail('company/invalid', 'This memory is too large to store.', { field: 'statement', max: ROW_MAX_BYTES })
  }
  return row
}

// One row, once. The key is the identity: the same turn or the same card revision arriving
// twice returns the first row, and no revision moves.
export function appendMemory(state, row) {
  if (state.memories === undefined || state.memories === null || typeof state.memories !== 'object') state.memories = {}
  const existing = Object.values(state.memories).find(entry => entry.idempotency_key === row.idempotency_key)
  if (existing !== undefined) return { created: false, row: existing, pruned: [], prunedOldest: null }
  state.memories[row.id] = row
  const pruned = pruneTo(state, row.project_id, () => row.updated_at)
  // `oldest_created_at` names the row that left, not the one that arrived: that is what the
  // event's reader needs to know how far back the table reached.
  const prunedOldest = pruned.reduce((oldest, entry) => (oldest === null || entry.created_at < oldest ? entry.created_at : oldest), null)
  return { created: true, row, pruned: pruned.map(entry => entry.id), prunedOldest }
}

export const memoryView = row => ({ ...row, tags: [...(row.tags ?? [])], source_refs: [...(row.source_refs ?? [])] })

// The memory page reads one project at a time. Newest first, because what a Bot said last
// is what a person is looking for; the cursor is the last id of the previous page.
export function memoryHandlers() {
  return {
    'memory.list': ({ state, payload }) => {
      const projectId = typeof payload.project_id === 'string' ? payload.project_id.trim() : ''
      if (projectId === '') throw companyFail('company/invalid', 'project_id is required.', { field: 'project_id' })
      if (state.projects[projectId] === undefined) throw companyFail('project/not-found', `No project ${projectId}.`, { project_id: projectId })
      const ownerBot = typeof payload.owner_bot_id === 'string' && payload.owner_bot_id.trim() !== '' ? payload.owner_bot_id.trim() : null
      const kind = payload.kind === undefined || payload.kind === null
        ? null
        : (Array.isArray(payload.kind) ? payload.kind : [payload.kind])
      if (kind !== null && (kind.length === 0 || kind.some(name => !KINDS.includes(name)))) {
        throw companyFail('company/invalid', `kind is one of ${KINDS.join(', ')}.`, { field: 'kind', allowed: KINDS })
      }
      const tag = typeof payload.tag === 'string' && payload.tag.trim() !== '' ? payload.tag.trim() : null
      const since = payload.since === undefined ? null : payload.since
      if (since !== null && (!Number.isInteger(since) || since < 0)) throw companyFail('company/invalid', 'since is a whole number of milliseconds.', { field: 'since' })
      const limit = payload.limit === undefined ? LIST_DEFAULT : payload.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) throw companyFail('company/invalid', `limit is a whole number from 1 to ${LIST_MAX}.`, { field: 'limit' })
      const includeDeleted = payload.include_deleted === true
      const cursor = typeof payload.cursor === 'string' && payload.cursor.trim() !== '' ? payload.cursor.trim() : null
      const rows = Object.values(state.memories ?? {})
        .filter(entry => entry.project_id === projectId)
        .filter(entry => includeDeleted || entry.deleted_at === null)
        .filter(entry => ownerBot === null || entry.owner_bot_id === ownerBot)
        .filter(entry => kind === null || kind.includes(entry.kind))
        .filter(entry => tag === null || (entry.tags ?? []).includes(tag))
        .filter(entry => since === null || entry.created_at >= since)
        .sort((left, right) => (right.created_at - left.created_at) || left.id.localeCompare(right.id))
      const start = cursor === null ? 0 : rows.findIndex(entry => entry.id === cursor) + 1
      if (cursor !== null && start === 0) throw companyFail('company/invalid', `No memory ${cursor} on this page.`, { field: 'cursor' })
      const page = rows.slice(start, start + limit)
      const next = start + limit < rows.length ? page[page.length - 1]?.id ?? null : null
      return { aggregate_id: null, body: { memories: page.map(memoryView), next_cursor: next }, mutates: false }
    },

    'memory.get': ({ state, payload }) => {
      const row = rowOf(state, payload.memory_id)
      return { aggregate_id: row.id, body: { memory: memoryView(row) }, mutates: false }
    },

    // Soft: the row stops being recalled, and the audit trail keeps what was said. Deleting
    // twice is not an error — a screen retried after a lost answer should land on the same
    // answer, not on a conflict.
    'memory.delete': ({ state, payload, now }) => {
      const row = rowOf(state, payload.memory_id)
      if (row.deleted_at !== null) return { aggregate_id: row.id, body: { memory: memoryView(row) }, mutates: false }
      const expected = payload.expected_revision
      if (!Number.isInteger(expected)) throw companyFail('company/invalid', 'expected_revision is required; it names the memory revision you read.', { field: 'expected_revision' })
      if (expected !== row.revision) {
        throw companyFail('memory/revision-conflict', `Memory ${row.id} is at revision ${row.revision}, not ${expected}.`, { memory_id: row.id, expected_revision: expected, revision: row.revision })
      }
      const at = now()
      row.deleted_at = at
      row.updated_at = at
      row.deleted_by = 'user'
      row.delete_reason = typeof payload.reason === 'string' && payload.reason.trim() !== '' ? payload.reason.trim().slice(0, 200) : null
      row.revision += 1
      return {
        aggregate_id: row.id,
        body: { memory: memoryView(row) },
        events: [{ type: 'memory.deleted', data: { memory_id: row.id, reason: row.delete_reason } }],
      }
    },
  }
}

const rowOf = (state, id) => {
  const key = typeof id === 'string' ? id.trim() : ''
  if (key === '') throw companyFail('company/invalid', 'memory_id is required.', { field: 'memory_id' })
  const row = state.memories?.[key]
  if (row === undefined) throw companyFail('memory/not-found', `No memory ${id}.`, { memory_id: id })
  return row
}

// The card reaching Done is a command already; the row rides in that same commit, so a
// decision cannot be remembered without being made. Wrapped around `acceptance.decide`,
// which is the only command that writes Done.
export const withDoneMemory = (decide, { redact = value => value } = {}) => (args) => {
  const outcome = decide(args)
  const task = outcome?.body?.task
  if (task === undefined || task.stage !== 'done') return outcome
  const project = args.state.projects?.[task.project_id]
  if (project === undefined) return outcome
  const acceptance = outcome.body.acceptance ?? null
  const note = [acceptance?.opinion, task.submissions?.at(-1)?.summary]
    .map(value => (typeof value === 'string' ? value.trim() : ''))
    .find(value => value !== '') ?? ''
  const opinion = note === '' ? '' : `：${note}`
  const row = memoryRow({
    at: args.now(),
    projectId: project.id,
    kind: 'decision',
    statement: redact(`任务「${task.title}」完成${opinion}`),
    sourceRefs: [{ type: 'task_result', id: task.id, anchor: acceptance?.id ?? null }],
    employeeId: acceptance?.requester_employee_id ?? null,
    botId: args.state.employees?.[acceptance?.requester_employee_id ?? '']?.bot_id ?? null,
    origin: { task_id: task.id, task_revision: task.task_revision },
    idempotencyKey: `task:${task.id}:${task.task_revision}`,
  })
  const added = appendMemory(args.state, row)
  if (!added.created) return outcome
  return {
    ...outcome,
    events: [
      ...(outcome.events ?? []),
      { type: 'memory.created', data: { memory_id: row.id, ownership_level: row.ownership_level, scope_id: row.scope_id, kind: row.kind, source_kind: 'task_result' } },
      ...(added.pruned.length === 0 ? [] : [{ type: 'memory.pruned', data: { count: added.pruned.length, oldest_created_at: added.prunedOldest } }]),
    ],
  }
}

export const memoryLimits = { STATEMENT_MAX, TAGS_MAX, TAG_MAX, ROW_MAX_BYTES, PER_PROJECT_CAP, KINDS }
