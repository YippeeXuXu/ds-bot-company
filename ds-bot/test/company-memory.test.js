// Memories (M1b-5.1): one table beside the company, written when a Bot finishes a turn in a
// project group or a card reaches Done. The cases follow contract §5.6: a row is written
// once per source event, delete is soft and keeps the record, and the page reads newest
// first without ever touching a deleted entry by accident.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { statusOf } from '../src/host/company/api.js'
import { createCommands } from '../src/host/company/commands.js'
import {
  MEMORY_ROW_REVISION_COMMANDS,
  appendMemory,
  memoryHandlers,
  memoryLimits,
  memoryRow,
  memoryView,
  withDoneMemory,
} from '../src/host/company/memories.js'
import { install } from '../src/host/company/index.js'
import { COMPANY_VERSION, createCompanyStore } from '../src/host/company/store.js'

const AT = 1_700_000_000_000

const openHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-memory-'))
  mkdirSync(join(home, 'company'), { recursive: true })
  return home
}

const employee = (id, name, botId) => ({ id, name, bot_id: botId, status: 'active', role: 'member', company_id: 'cmp_1', created_at: 1 })

const project = (id, extra = {}) => ({
  id,
  name: id === 'prj_1' ? 'Alpha' : 'Beta',
  status: 'active',
  company_id: 'cmp_1',
  group_chat_ref: id === 'prj_1' ? 'room_1' : 'room_2',
  coordinator_assignment_id: null,
  acceptance_actor: 'emp_acceptor',
  acceptance_requirement: 'daily_independent_bot',
  workspace_ref: `scope_${id}`,
  created_at: 1,
  ...extra,
})

const memoryEntry = (id, extra = {}) => ({
  id,
  ownership_level: 'project',
  scope_id: 'prj_1',
  project_id: 'prj_1',
  owner_bot_id: 'bot_keyboard',
  employee_id: 'emp_owner',
  kind: 'fact',
  lifecycle: 'active',
  pinned: false,
  statement: `记录 ${id}`,
  statement_truncated: false,
  tags: [],
  source_refs: [{ type: 'turn', id: 'chat_1:1' }],
  origin: { session_id: 'chat_1', turn: 1 },
  idempotency_key: `turn:chat_1:${id}`,
  usage_refs: [],
  revision: 1,
  created_at: AT,
  updated_at: AT,
  deleted_at: null,
  deleted_by: null,
  delete_reason: null,
  ...extra,
})

const seed = (home, { version = COMPANY_VERSION, memories = {} } = {}) => {
  const state = {
    version,
    revision: 4,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees: {
      emp_owner: employee('emp_owner', '键盘', 'bot_keyboard'),
      emp_acceptor: employee('emp_acceptor', '白菜', 'bot_cabbage'),
    },
    projects: { prj_1: project('prj_1'), prj_2: project('prj_2') },
    members: {},
    operation_log: {},
    acceptances: {},
    todo_log: {},
    templates: {},
    tasks: {},
    runs: {},
    memories,
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(state))
  return state
}

const storeOf = home => createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT })

const commandsFor = home => createCommands({
  store: storeOf(home),
  now: () => AT,
  handlers: { ...memoryHandlers() },
  rowRevisionCommands: new Set(MEMORY_ROW_REVISION_COMMANDS),
}).execute

const stateOf = home => JSON.parse(readFileSync(join(home, 'company', 'state.json'), 'utf8'))
const eventsOf = home => readFileSync(join(home, 'company', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

const failure = async (promise, code) => {
  try {
    await promise
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return error
  }
  assert.fail(`expected ${code}, but the command succeeded`)
}

test('store: a v5 file opens as v6 with an empty memory table and reports the upgrade once', async () => {
  const home = openHome()
  seed(home, { version: 5 })
  const store = storeOf(home)
  assert.equal(store.state.version, COMPANY_VERSION)
  assert.equal(COMPANY_VERSION, 6)
  assert.deepEqual(store.state.memories, {})
  assert.deepEqual(store.migration(), { from: 5, to: 6 })
})

test('memory.list: newest first, filtered by kind and tag, deleted entries hidden', async () => {
  const home = openHome()
  seed(home, {
    memories: {
      mem_a: memoryEntry('mem_a', { created_at: AT, kind: 'fact', tags: ['间距'] }),
      mem_b: memoryEntry('mem_b', { created_at: AT + 10, kind: 'decision' }),
      mem_c: memoryEntry('mem_c', { created_at: AT + 20, deleted_at: AT + 30, deleted_by: 'user', revision: 2 }),
      mem_d: memoryEntry('mem_d', { created_at: AT + 40, project_id: 'prj_2', scope_id: 'prj_2' }),
    },
  })
  const execute = commandsFor(home)

  const all = await execute('memory.list', { operation_key: 'list-1', project_id: 'prj_1' })
  assert.equal(all.status, 'ok')
  assert.deepEqual(all.body.memories.map(row => row.id), ['mem_b', 'mem_a'])
  assert.equal(all.body.next_cursor, null)

  const decisions = await execute('memory.list', { operation_key: 'list-2', project_id: 'prj_1', kind: ['decision'] })
  assert.deepEqual(decisions.body.memories.map(row => row.id), ['mem_b'])

  const tagged = await execute('memory.list', { operation_key: 'list-3', project_id: 'prj_1', tag: '间距' })
  assert.deepEqual(tagged.body.memories.map(row => row.id), ['mem_a'])

  const withDeleted = await execute('memory.list', { operation_key: 'list-4', project_id: 'prj_1', include_deleted: true })
  assert.deepEqual(withDeleted.body.memories.map(row => row.id), ['mem_c', 'mem_b', 'mem_a'])
  assert.equal(withDeleted.body.memories[0].revision, 2)
})

test('memory.list: pages with the last id, and refuses a cursor it did not issue', async () => {
  const home = openHome()
  seed(home, {
    memories: {
      mem_a: memoryEntry('mem_a', { created_at: AT }),
      mem_b: memoryEntry('mem_b', { created_at: AT + 10 }),
      mem_c: memoryEntry('mem_c', { created_at: AT + 20 }),
    },
  })
  const execute = commandsFor(home)

  const first = await execute('memory.list', { operation_key: 'page-1', project_id: 'prj_1', limit: 2 })
  assert.deepEqual(first.body.memories.map(row => row.id), ['mem_c', 'mem_b'])
  assert.equal(first.body.next_cursor, 'mem_b')

  const second = await execute('memory.list', { operation_key: 'page-2', project_id: 'prj_1', limit: 2, cursor: 'mem_b' })
  assert.deepEqual(second.body.memories.map(row => row.id), ['mem_a'])
  assert.equal(second.body.next_cursor, null)

  await failure(execute('memory.list', { operation_key: 'page-3', project_id: 'prj_1', limit: 2, cursor: 'mem_nope' }), 'company/invalid')
  await failure(execute('memory.list', { operation_key: 'page-4', project_id: 'prj_missing' }), 'project/not-found')
  await failure(execute('memory.list', { operation_key: 'page-5', project_id: 'prj_1', kind: ['rumour'] }), 'company/invalid')
  await failure(execute('memory.list', { operation_key: 'page-6', project_id: 'prj_1', limit: 0 }), 'company/invalid')
})

test('memory.get: a deleted entry is still readable, a missing id is 404', async () => {
  const home = openHome()
  seed(home, { memories: { mem_a: memoryEntry('mem_a', { deleted_at: AT, deleted_by: 'user', revision: 2 }) } })
  const execute = commandsFor(home)

  const got = await execute('memory.get', { operation_key: 'get-1', memory_id: 'mem_a' })
  assert.equal(got.body.memory.id, 'mem_a')
  assert.equal(got.body.memory.deleted_at, AT)
  await failure(execute('memory.get', { operation_key: 'get-2', memory_id: 'mem_nope' }), 'memory/not-found')
})

test('memory.delete: soft, one revision up, a second delete changes nothing', async () => {
  const home = openHome()
  seed(home, { memories: { mem_a: memoryEntry('mem_a') } })
  const execute = commandsFor(home)

  await failure(execute('memory.delete', { operation_key: 'del-0', memory_id: 'mem_a' }), 'company/invalid')
  await failure(execute('memory.delete', { operation_key: 'del-1', memory_id: 'mem_a', expected_revision: 9 }), 'memory/revision-conflict')

  const deleted = await execute('memory.delete', { operation_key: 'del-2', memory_id: 'mem_a', expected_revision: 1, reason: '过时了' })
  assert.equal(deleted.status, 'committed')
  assert.equal(deleted.body.memory.revision, 2)
  assert.equal(deleted.body.memory.deleted_at, AT)
  assert.equal(deleted.body.memory.deleted_by, 'user')
  assert.equal(deleted.body.memory.delete_reason, '过时了')
  assert.deepEqual(eventsOf(home).map(event => event.type), ['memory.deleted'])

  const again = await execute('memory.delete', { operation_key: 'del-3', memory_id: 'mem_a', expected_revision: 1 })
  assert.equal(again.status, 'ok')
  assert.equal(again.body.memory.revision, 2)

  assert.equal(stateOf(home).memories.mem_a.deleted_at, AT)
})

test('appendMemory: one row per idempotency key, and the oldest unpinned row leaves at the cap', () => {
  const state = { memories: {} }
  const first = memoryRow({ at: AT, projectId: 'prj_1', kind: 'fact', statement: '第一句', idempotencyKey: 'turn:chat_1:1' })
  assert.equal(appendMemory(state, first).created, true)
  const replay = memoryRow({ at: AT + 1, projectId: 'prj_1', kind: 'fact', statement: '第一句再说一次', idempotencyKey: 'turn:chat_1:1' })
  const outcome = appendMemory(state, replay)
  assert.equal(outcome.created, false)
  assert.equal(outcome.row.id, first.id)
  assert.equal(Object.keys(state.memories).length, 1)

  // One row short of the cap, then a pinned row older than all of them, then the two rows
  // that push the table over. The pinned row counts toward the cap but never ages out.
  for (let index = 0; index < memoryLimits.PER_PROJECT_CAP - 1; index += 1) {
    appendMemory(state, memoryRow({
      id: `mem_${String(index).padStart(4, '0')}`,
      at: AT + 10 + index,
      projectId: 'prj_2',
      kind: 'fact',
      statement: `第 ${index} 条`,
      idempotencyKey: `turn:chat_2:${index}`,
    }))
  }
  const pinned = memoryRow({
    id: 'mem_pinned',
    at: AT - 1,
    projectId: 'prj_2',
    kind: 'constraint',
    statement: '这一条钉住了',
    idempotencyKey: 'turn:chat_2:pinned',
  })
  appendMemory(state, pinned)
  state.memories.mem_pinned.pinned = true
  appendMemory(state, memoryRow({
    id: 'mem_last',
    at: AT + 9999,
    projectId: 'prj_2',
    kind: 'fact',
    statement: '最后一条',
    idempotencyKey: 'turn:chat_2:last',
  }))
  const overflowOne = memoryRow({
    id: 'mem_last2',
    at: AT + 10000,
    projectId: 'prj_2',
    kind: 'fact',
    statement: '再一条',
    idempotencyKey: 'turn:chat_2:last2',
  })
  const pruned = appendMemory(state, overflowOne).pruned
  assert.equal(pruned.length, 1)
  const victim = state.memories[pruned[0]]
  assert.equal(victim.delete_reason, 'pruned')
  assert.equal(victim.deleted_by, 'company')
  // The earlier insert already sent mem_0000 out, so the one that leaves now is the next.
  assert.equal(victim.id, 'mem_0001')
  assert.equal(state.memories.mem_pinned.deleted_at, null)
})

test('memoryRow: text stops at 600 characters, tags stop at 8, neither is silently cut', () => {
  const long = memoryRow({ at: AT, projectId: 'prj_1', kind: 'fact', statement: '长'.repeat(900), idempotencyKey: 'turn:chat_1:9' })
  assert.equal(long.statement.length, memoryLimits.STATEMENT_MAX)
  assert.equal(long.statement.endsWith('…'), true)
  assert.equal(long.statement_truncated, true)
  assert.throws(() => memoryRow({
    at: AT,
    projectId: 'prj_1',
    kind: 'fact',
    statement: '短',
    tags: Array.from({ length: 9 }, (_, index) => `标签${index}`),
    idempotencyKey: 'turn:chat_1:10',
  }), error => error.code === 'company/invalid')
})

test('withDoneMemory: Done leaves one decision row in the same commit, a return leaves none', () => {
  const state = {
    employees: { emp_owner: employee('emp_owner', '键盘', 'bot_keyboard') },
    projects: { prj_1: project('prj_1') },
    tasks: { tsk_a: { id: 'tsk_a', project_id: 'prj_1', title: '写记忆表', task_revision: 3 } },
    memories: {},
  }
  const decide = ({ state: draft, payload }) => {
    if (payload.decision === 'accept') {
      draft.tasks.tsk_a.stage = 'done'
      return { aggregate_id: 'acc_1', body: { task: { ...draft.tasks.tsk_a, stage: 'done' }, acceptance: { id: 'acc_1', opinion: '通过' } }, events: [{ type: 'task.moved', data: { to: 'done' } }] }
    }
    return { aggregate_id: 'acc_1', body: { task: { ...draft.tasks.tsk_a, stage: 'ready' }, acceptance: { id: 'acc_1' } }, events: [{ type: 'task.moved', data: { to: 'ready' } }] }
  }
  const wrapped = withDoneMemory(decide, { redact: text => text })

  const returned = wrapped({ state, payload: { decision: 'return' }, now: () => AT })
  assert.equal(Object.keys(state.memories).length, 0)
  assert.deepEqual(returned.events.map(event => event.type), ['task.moved'])

  const accepted = wrapped({ state, payload: { decision: 'accept' }, now: () => AT })
  const rows = Object.values(state.memories)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'decision')
  assert.equal(rows[0].project_id, 'prj_1')
  assert.equal(rows[0].idempotency_key, 'task:tsk_a:3')
  assert.match(rows[0].statement, /写记忆表/)
  assert.match(rows[0].statement, /通过/)
  assert.deepEqual(accepted.events.map(event => event.type), ['task.moved', 'memory.created'])
  assert.equal(accepted.events[1].data.source_kind, 'task_result')

  const replay = wrapped({ state, payload: { decision: 'accept' }, now: () => AT })
  assert.equal(Object.keys(state.memories).length, 1)
  assert.deepEqual(replay.events.map(event => event.type), ['task.moved'])
})

test('the memory view copies its lists, so a reader cannot edit the stored row', () => {
  const row = memoryEntry('mem_a', { tags: ['间距'] })
  const view = memoryView(row)
  view.tags.push('别的')
  assert.deepEqual(row.tags, ['间距'])
  assert.equal(view.idempotency_key, row.idempotency_key)
})

test('the HTTP layer answers the three memory errors with 404, 409 and 422', () => {
  assert.equal(statusOf('memory/not-found'), 404)
  assert.equal(statusOf('memory/revision-conflict'), 409)
  assert.equal(statusOf('company/invalid'), 422)
})

test('install: a Bot turn in a project group leaves one fact row, and a replay leaves none', async () => {
  const home = openHome()
  seed(home, { memories: {} })
  const listeners = {}
  const rt = {
    home,
    warn: () => {},
    ctx: {
      connection: { fetch: { register: () => () => {} } },
      effect: () => {},
      on: (name, handler) => {
        listeners[name] = handler
        return () => {}
      },
    },
    approvalsView: () => [],
    selfOf: () => undefined,
    roomOf: () => undefined,
    botOf: () => undefined,
    isPrivate: () => false,
    redactSecrets: text => text,
    groupOwners: new Map([['chat_1', { botId: 'bot_keyboard', roomId: 'room_1' }]]),
  }
  install(rt)
  // The upgrade and the builtin seed commit on install; let them land before the turn.
  await new Promise(resolve => setTimeout(resolve, 150))
  const handler = listeners['session/event']
  assert.equal(typeof handler, 'function')
  const session = { id: 'chat_1' }
  handler(session, { type: 'assistant/message', data: { turn: 3, message: { id: 'msg_1', content: [{ type: 'text', text: '第一段' }] } } })
  handler(session, { type: 'assistant/message', data: { turn: 3, message: { id: 'msg_2', content: [{ type: 'text', text: '最后一段' }] } } })
  handler(session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && Object.keys(stateOf(home).memories).length === 0) await new Promise(resolve => setTimeout(resolve, 10))

  const rows = Object.values(stateOf(home).memories)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'fact')
  assert.equal(rows[0].project_id, 'prj_1')
  assert.equal(rows[0].employee_id, 'emp_owner')
  assert.equal(rows[0].owner_bot_id, 'bot_keyboard')
  // The last piece of text stands for the turn, not every piece.
  assert.equal(rows[0].statement, '最后一段')
  assert.equal(rows[0].idempotency_key, 'turn:chat_1:3')
  assert.deepEqual(rows[0].source_refs, [{ type: 'message_anchor', id: 'msg_2', anchor: 'chat_1#3' }])
  assert.match(rows[0].id, /^mem_[0-9a-f]{24}$/)
  assert.equal(readFileSync(join(home, 'company', 'events.jsonl'), 'utf8').includes('memory.created'), true)

  // The same turn arriving again is the same row, not a second one.
  handler(session, { type: 'assistant/message', data: { turn: 3, message: { id: 'msg_2', content: [{ type: 'text', text: '最后一段' }] } } })
  handler(session, { type: 'turn/end', data: { turn: 3 } })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(Object.keys(stateOf(home).memories).length, 1)
})
