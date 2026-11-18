// The task row and its five commands (M1b-3.3 / 4.1): a card is created, filled, moved,
// submitted and reopened under its own integer revision. The cases follow the contract's
// §3.2 state machine, so a failure names the promise that broke — an illegal step, a cycle,
// a stale write, evidence that does not answer the checks — rather than a function.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { statusOf } from '../src/host/company/api.js'
import { createCommands } from '../src/host/company/commands.js'
import { createCompanyStore } from '../src/host/company/store.js'
import { TASK_ROW_REVISION_COMMANDS, taskHandlers } from '../src/host/company/tasks.js'

const AT = 1_700_000_000_000

const openHome = async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-tasks-'))
  mkdirSync(join(home, 'company'), { recursive: true })
  return home
}

const employee = (id, name, botId, extra = {}) => ({ id, name, bot_id: botId, status: 'active', role: 'member', company_id: 'cmp_1', created_at: 1, ...extra })

const project = (extra = {}) => ({
  id: 'prj_1',
  name: 'Alpha',
  status: 'active',
  company_id: 'cmp_1',
  group_chat_ref: 'room_1',
  coordinator_assignment_id: null,
  acceptance_actor: 'emp_acceptor',
  acceptance_requirement: 'daily_independent_bot',
  workspace_ref: 'scope_alpha',
  created_at: 1,
  ...extra,
})

const member = (id, projectId, employeeId, extra = {}) => ({ id, project_id: projectId, employee_id: employeeId, role: 'executor', membership_status: 'active', joined_at: 1, ...extra })

const taskRow = (extra = {}) => ({
  id: 'tsk_a',
  project_id: 'prj_1',
  title: '写任务表',
  description: null,
  source_ref: 'room_1#m1',
  parent_id: null,
  owner_assignment_id: 'mem_owner',
  stage: 'draft',
  hold_reason: 'none',
  next_action: null,
  input_refs: [],
  acceptance_checks: ['五命令可用'],
  acceptance_actor: 'emp_acceptor',
  deliverable_class: 'normal',
  deliverable_class_source: 'default',
  acceptance_requirement: 'daily_independent_bot',
  independence_required: true,
  dependencies: [],
  authorization_scope_ref: 'scope_alpha',
  task_revision: 1,
  problem_ids: [],
  artifact_refs: [],
  latest_run_id: null,
  submissions: [],
  ready_at: null,
  started_at: null,
  submitted_at: null,
  completed_at: null,
  reopened_at: null,
  reopen_reason: null,
  cancelled_at: null,
  cancelled_from: null,
  cancel_reason: null,
  created_at: 10,
  updated_at: 10,
  ...extra,
})

const seed = (home, { projects = [project()], employees = [], members = [], tasks = {} } = {}) => {
  const staff = employees.length > 0
    ? employees
    : [employee('emp_owner', '键盘', 'bot_keyboard'), employee('emp_acceptor', '白菜', 'bot_cabbage'), employee('emp_other', '橙子', 'bot_orange')]
  const team = members.length > 0
    ? members
    : [member('mem_owner', 'prj_1', 'emp_owner'), member('mem_acceptor', 'prj_1', 'emp_acceptor'), member('mem_other', 'prj_1', 'emp_other')]
  const state = {
    version: 5,
    revision: 4,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees: Object.fromEntries(staff.map(entry => [entry.id, entry])),
    projects: Object.fromEntries(projects.map(entry => [entry.id, entry])),
    members: Object.fromEntries(team.map(entry => [entry.id, entry])),
    operation_log: {},
    acceptances: {},
    todo_log: {},
    templates: {},
    tasks,
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(state))
  return state
}

const storeOf = (home) => createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT })
const commandsFor = (home) => createCommands({ store: storeOf(home), now: () => AT, handlers: taskHandlers(), rowRevisionCommands: TASK_ROW_REVISION_COMMANDS }).execute
const stateOf = (home) => JSON.parse(readFileSync(join(home, 'company', 'state.json'), 'utf8'))
const eventsOf = (home) => readFileSync(join(home, 'company', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

const failure = async (promise, code) => {
  try {
    await promise
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return error
  }
  assert.fail(`expected ${code}, but the command succeeded`)
}

test('create: a draft keeps the project scope and acceptor, and trims its text', async () => {
  const home = await openHome()
  seed(home)
  const execute = commandsFor(home)

  const result = await execute('task.create', { operation_key: 'create-1', project_id: 'prj_1', title: '  写任务表  ', source_ref: ' room_1#m1 ' })
  assert.equal(result.status, 'committed')
  const task = result.body.task
  assert.match(task.id, /^tsk_[0-9a-f]{12}$/)
  assert.equal(task.title, '写任务表')
  assert.equal(task.source_ref, 'room_1#m1')
  assert.equal(task.stage, 'draft')
  assert.equal(task.hold_reason, 'none')
  assert.equal(task.owner_assignment_id, null)
  assert.deepEqual(task.input_refs, [])
  assert.equal(task.acceptance_actor, 'emp_acceptor')
  assert.equal(task.authorization_scope_ref, 'scope_alpha')
  assert.equal(task.deliverable_class, 'normal')
  assert.equal(task.acceptance_requirement, 'daily_independent_bot')
  assert.equal(task.independence_required, true)
  assert.equal(task.task_revision, 1)
  assert.deepEqual(task.submissions, [])

  const saved = stateOf(home)
  assert.equal(saved.tasks[task.id].stage, 'draft')
  assert.equal(saved.revision, 5)
  const event = eventsOf(home).at(-1)
  assert.equal(event.type, 'task.created')
  assert.deepEqual(event.data, { task_id: task.id, project_id: 'prj_1', stage: 'draft', task_revision: 1 })

  await assert.rejects(execute('task.create', { operation_key: 'create-2', project_id: 'prj_1', title: '   ', source_ref: 'room#2' }), /title is required/)
  await assert.rejects(execute('task.create', { operation_key: 'create-3', project_id: 'prj_1', title: 'x', source_ref: '' }), /source_ref is required/)
})

test('create: a ready card needs an owner, checks and an acceptor that fits the project', async () => {
  const home = await openHome()
  seed(home)
  const execute = commandsFor(home)

  const missing = await failure(execute('task.create', {
    operation_key: 'ready-1', project_id: 'prj_1', title: '发版', source_ref: 'room#2', stage: 'ready', acceptance_checks: ['CI 绿'],
  }), 'task/missing-input')
  assert.deepEqual(missing.details.missing, ['owner_assignment_id'])

  const ok = await execute('task.create', {
    operation_key: 'ready-2', project_id: 'prj_1', title: '发版', source_ref: 'room#2', stage: 'ready', owner_assignment_id: 'mem_owner', acceptance_checks: ['CI 绿'],
  })
  assert.equal(ok.body.task.stage, 'ready')
  assert.equal(ok.body.task.hold_reason, 'none')

  seed(home, { projects: [project({ acceptance_actor: 'user', acceptance_requirement: 'owner_only' })] })
  const ownerOnly = commandsFor(home)
  const refused = await failure(ownerOnly('task.create', {
    operation_key: 'ready-3', project_id: 'prj_1', title: '对外发布', source_ref: 'room#3', stage: 'ready',
    owner_assignment_id: 'mem_owner', acceptance_checks: ['老板点头'], acceptance_actor: 'emp_acceptor',
  }), 'project/owner-required')
  assert.equal(refused.details.field, 'acceptance_actor')
})

test('update: a card saves by its own revision, and a repeated key writes once', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ task_revision: 1 }) } })
  const execute = commandsFor(home)

  const first = await execute('task.update', { operation_key: 'edit-1', task_id: 'tsk_a', expected_revision: 1, title: '写任务表与命令' })
  assert.equal(first.body.task.task_revision, 2)

  const stale = await failure(execute('task.update', { operation_key: 'edit-2', task_id: 'tsk_a', expected_revision: 1, title: '另一版' }), 'task/revision-conflict')
  assert.deepEqual(stale.details, { task_id: 'tsk_a', expected_revision: 1, revision: 2 })

  const replay = await execute('task.update', { operation_key: 'edit-1', task_id: 'tsk_a', expected_revision: 1, title: '写任务表与命令' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.body.task.task_revision, 2)

  const saved = stateOf(home)
  assert.equal(saved.tasks.tsk_a.title, '写任务表与命令')
  assert.equal(saved.revision, 5)
  assert.equal(eventsOf(home).filter(event => event.type === 'task.updated').length, 1)
})

test('update: a card already on the board cannot lose what Ready promised', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'ready', task_revision: 2, ready_at: 2 }) } })
  const execute = commandsFor(home)

  const missing = await failure(execute('task.update', { operation_key: 'edit-1', task_id: 'tsk_a', expected_revision: 2, acceptance_checks: [] }), 'task/missing-input')
  assert.deepEqual(missing.details.missing, ['acceptance_checks'])

  // Review freezes the evidence contract: the checks are exactly the ones submitted against.
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'review', task_revision: 4, acceptance_checks: ['a', 'b'] }) } })
  const review = commandsFor(home)
  await failure(review('task.update', { operation_key: 'edit-2', task_id: 'tsk_a', expected_revision: 4, title: '改标题' }), 'task/state-conflict')
  await failure(review('task.update', { operation_key: 'edit-3', task_id: 'tsk_a', expected_revision: 4, acceptance_checks: ['a'] }), 'task/state-conflict')
})

test('move: a draft cannot jump to doing, and a ready card waits for its dependency', async () => {
  const home = await openHome()
  seed(home, {
    tasks: {
      tsk_a: taskRow({ stage: 'draft', task_revision: 1, dependencies: ['tsk_dep'] }),
      tsk_dep: taskRow({ id: 'tsk_dep', title: '先做依赖', stage: 'doing', task_revision: 3 }),
    },
  })
  const execute = commandsFor(home)

  const jumped = await failure(execute('task.move', { operation_key: 'move-1', task_id: 'tsk_a', expected_revision: 1, to: 'doing' }), 'task/state-conflict')
  assert.deepEqual(jumped.details.allowed, ['ready', 'cancelled'])

  const ready = await execute('task.move', { operation_key: 'move-2', task_id: 'tsk_a', expected_revision: 1, to: 'ready' })
  assert.equal(ready.body.task.stage, 'ready')
  assert.equal(ready.body.task.hold_reason, 'dependency')

  const blocked = await failure(execute('task.move', { operation_key: 'move-3', task_id: 'tsk_a', expected_revision: 2, to: 'doing' }), 'task/dependency-unmet')
  assert.deepEqual(blocked.details.blocking.map(entry => entry.task_id), ['tsk_dep'])
})

test('move: a done dependency releases the card, and a missing one is named', async () => {
  const home = await openHome()
  seed(home, {
    tasks: {
      tsk_a: taskRow({ stage: 'ready', task_revision: 2, dependencies: ['tsk_dep'] }),
      tsk_dep: taskRow({ id: 'tsk_dep', title: '先做依赖', stage: 'done', task_revision: 5, completed_at: 3 }),
    },
  })
  const execute = commandsFor(home)

  const started = await execute('task.move', { operation_key: 'move-1', task_id: 'tsk_a', expected_revision: 2, to: 'doing' })
  assert.equal(started.body.task.stage, 'doing')
  assert.equal(started.body.task.hold_reason, 'none')
  assert.equal(started.body.task.started_at, AT)
  const event = eventsOf(home).at(-1)
  assert.equal(event.type, 'task.moved')
  assert.deepEqual(event.data, { task_id: 'tsk_a', project_id: 'prj_1', from: 'ready', to: 'doing', task_revision: 3 })

  seed(home, { tasks: { tsk_a: taskRow({ stage: 'ready', task_revision: 2, dependencies: ['tsk_ghost'] }) } })
  const ghost = commandsFor(home)
  await failure(ghost('task.move', { operation_key: 'move-2', task_id: 'tsk_a', expected_revision: 2, to: 'doing' }), 'task/dependency-missing')
})

test('update: a dependency cycle is refused with the path it would close', async () => {
  const home = await openHome()
  seed(home, {
    tasks: {
      tsk_a: taskRow({ task_revision: 1 }),
      tsk_b: taskRow({ id: 'tsk_b', title: '后做依赖', task_revision: 1, dependencies: ['tsk_a'] }),
    },
  })
  const execute = commandsFor(home)

  const cycle = await failure(execute('task.update', { operation_key: 'edit-1', task_id: 'tsk_a', expected_revision: 1, dependencies: ['tsk_b'] }), 'task/dependency-cycle')
  assert.deepEqual(cycle.details, { task_id: 'tsk_a', path: ['tsk_a', 'tsk_b', 'tsk_a'], kind: 'dependency' })

  const self = await failure(execute('task.update', { operation_key: 'edit-2', task_id: 'tsk_b', expected_revision: 1, dependencies: ['tsk_b'] }), 'task/dependency-cycle')
  assert.deepEqual(self.details.path, ['tsk_b', 'tsk_b'])
})

test('move: a review is decided by its acceptance, and may only be cancelled by a move', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'review', task_revision: 4, submitted_at: 3 }) } })
  const execute = commandsFor(home)

  for (const to of ['done', 'ready']) {
    const refused = await failure(execute('task.move', { operation_key: `move-${to}`, task_id: 'tsk_a', expected_revision: 4, to }), 'task/acceptance-required')
    assert.deepEqual(refused.details, { task_id: 'tsk_a', stage: 'review', to, expected: 'acceptance.decide' })
  }

  const noReason = await failure(execute('task.move', { operation_key: 'move-cancel-1', task_id: 'tsk_a', expected_revision: 4, to: 'cancelled' }), 'company/invalid')
  assert.equal(noReason.details.field, 'reason')

  const cancelled = await execute('task.move', { operation_key: 'move-cancel-2', task_id: 'tsk_a', expected_revision: 4, to: 'cancelled', reason: '需求撤了' })
  assert.equal(cancelled.body.task.stage, 'cancelled')
  assert.equal(cancelled.body.task.cancelled_from, 'review')
  assert.equal(cancelled.body.task.cancel_reason, '需求撤了')
  assert.equal(eventsOf(home).at(-1).type, 'task.cancelled')
})

test('submit: the evidence is recorded once and moves the card to review', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'doing', task_revision: 3, acceptance_checks: ['a', 'b'], artifact_refs: ['file:///old.md'] }) } })
  const execute = commandsFor(home)

  const submitted = await execute('task.submit', {
    operation_key: 'sub-1',
    task_id: 'tsk_a',
    expected_revision: 3,
    summary: '五条命令与单测都齐了',
    artifact_refs: ['file:///tmp/tasks.js'],
    check_notes: ['a 通过', 'b 通过'],
  })
  const task = submitted.body.task
  assert.equal(task.stage, 'review')
  assert.equal(task.task_revision, 4)
  assert.equal(task.submitted_at, AT)
  assert.deepEqual(task.artifact_refs, ['file:///old.md', 'file:///tmp/tasks.js'])
  assert.equal(task.submissions.length, 1)
  assert.deepEqual(task.submissions[0], {
    task_revision: 3,
    summary: '五条命令与单测都齐了',
    artifact_refs: ['file:///tmp/tasks.js'],
    check_notes: ['a 通过', 'b 通过'],
    submitted_by_employee_id: 'emp_owner',
    submitted_at: AT,
  })
  assert.equal(eventsOf(home).at(-1).type, 'task.submitted')

  await failure(execute('task.submit', {
    operation_key: 'sub-2', task_id: 'tsk_a', expected_revision: 3, summary: '再交一次', artifact_refs: ['file:///x'], check_notes: ['a', 'b'],
  }), 'task/revision-conflict')
})

test('submit: only a task being done, with notes for every check and its own owner, is submitted', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'ready', task_revision: 2, acceptance_checks: ['a', 'b'] }) } })
  const execute = commandsFor(home)

  const notDoing = await failure(execute('task.submit', {
    operation_key: 'sub-1', task_id: 'tsk_a', expected_revision: 2, summary: '交了', artifact_refs: ['file:///x'], check_notes: ['a', 'b'],
  }), 'task/state-conflict')
  assert.deepEqual(notDoing.details, { task_id: 'tsk_a', stage: 'ready', expected: 'doing' })

  seed(home, { tasks: { tsk_a: taskRow({ stage: 'doing', task_revision: 3, acceptance_checks: ['a', 'b'] }) } })
  const doing = commandsFor(home)
  const shortNotes = await failure(doing('task.submit', {
    operation_key: 'sub-2', task_id: 'tsk_a', expected_revision: 3, summary: '交了', artifact_refs: ['file:///x'], check_notes: ['a'],
  }), 'company/invalid')
  assert.equal(shortNotes.details.field, 'check_notes')

  const wrongOwner = await failure(doing('task.submit', {
    operation_key: 'sub-3', task_id: 'tsk_a', expected_revision: 3, summary: '交了', artifact_refs: ['file:///x'], check_notes: ['a', 'b'], submitted_by_employee_id: 'emp_other',
  }), 'company/invalid')
  assert.equal(wrongOwner.details.field, 'submitted_by_employee_id')

  seed(home, { tasks: { tsk_a: taskRow({ stage: 'doing', task_revision: 3, acceptance_checks: ['a'], owner_assignment_id: null }) } })
  const noOwner = commandsFor(home)
  await failure(noOwner('task.submit', {
    operation_key: 'sub-4', task_id: 'tsk_a', expected_revision: 3, summary: '交了', artifact_refs: ['file:///x'], check_notes: ['a'],
  }), 'task/missing-input')
})

test('reopen: a done card returns to ready with its reason and a new revision', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'done', task_revision: 5, completed_at: 9, acceptance_checks: ['旧条件'] }) } })
  const execute = commandsFor(home)

  const reopened = await execute('task.reopen', {
    operation_key: 'reopen-1', task_id: 'tsk_a', expected_revision: 5, reason: '退回路径没覆盖', acceptance_checks: ['新条件'],
  })
  const task = reopened.body.task
  assert.equal(task.stage, 'ready')
  assert.equal(task.task_revision, 6)
  assert.equal(task.completed_at, null)
  assert.equal(task.reopened_at, AT)
  assert.equal(task.reopen_reason, '退回路径没覆盖')
  assert.deepEqual(task.acceptance_checks, ['新条件'])
  assert.equal(eventsOf(home).at(-1).type, 'task.reopened')

  const again = await failure(execute('task.reopen', { operation_key: 'reopen-2', task_id: 'tsk_a', expected_revision: 6, reason: '再来' }), 'task/state-conflict')
  assert.deepEqual(again.details, { task_id: 'tsk_a', stage: 'ready', expected: 'done' })

  seed(home, { tasks: { tsk_a: taskRow({ stage: 'done', task_revision: 5, completed_at: 9 }) } })
  const done = commandsFor(home)
  const noReason = await failure(done('task.reopen', { operation_key: 'reopen-3', task_id: 'tsk_a', expected_revision: 5 }), 'company/invalid')
  assert.equal(noReason.details.field, 'reason')
})

test('update: a sensitive or final delivery cannot be lowered after draft', async () => {
  const home = await openHome()
  seed(home, {
    tasks: {
      tsk_a: taskRow({ stage: 'ready', task_revision: 2, deliverable_class: 'sensitive', acceptance_requirement: 'owner_only', acceptance_actor: 'user' }),
    },
  })
  const execute = commandsFor(home)

  const lowered = await failure(execute('task.update', { operation_key: 'edit-1', task_id: 'tsk_a', expected_revision: 2, deliverable_class: 'normal' }), 'task/downgrade-forbidden')
  assert.deepEqual(lowered.details, { task_id: 'tsk_a', from: 'sensitive', to: 'normal' })

  seed(home, { tasks: { tsk_a: taskRow({ stage: 'draft', task_revision: 1, deliverable_class: 'sensitive' }) } })
  const draft = commandsFor(home)
  const changed = await draft('task.update', { operation_key: 'edit-2', task_id: 'tsk_a', expected_revision: 1, deliverable_class: 'normal' })
  assert.equal(changed.body.task.deliverable_class, 'normal')
  assert.equal(changed.body.task.acceptance_requirement, 'daily_independent_bot')
  assert.equal(changed.body.task.independence_required, true)
})

test('cancel: a move to cancelled needs a reason and records where it came from', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'doing', task_revision: 3, started_at: 2 }) } })
  const execute = commandsFor(home)

  const refused = await failure(execute('task.move', { operation_key: 'cancel-1', task_id: 'tsk_a', expected_revision: 3, to: 'cancelled' }), 'company/invalid')
  assert.equal(refused.details.field, 'reason')

  const cancelled = await execute('task.move', { operation_key: 'cancel-2', task_id: 'tsk_a', expected_revision: 3, to: 'cancelled', reason: '范围撤了' })
  assert.equal(cancelled.body.task.cancelled_from, 'doing')
  assert.equal(cancelled.body.task.cancelled_at, AT)
  assert.deepEqual(eventsOf(home).at(-1).data, { task_id: 'tsk_a', project_id: 'prj_1', from: 'doing', task_revision: 4 })
})

test('list: a board reads one project without writing', async () => {
  const home = await openHome()
  seed(home, {
    projects: [project(), project({ id: 'prj_2', name: 'Beta' }), project({ id: 'prj_3', name: 'Old', status: 'archived' })],
    tasks: {
      tsk_a: taskRow({ id: 'tsk_a', created_at: 10 }),
      tsk_b: taskRow({ id: 'tsk_b', project_id: 'prj_2', title: '别家任务', created_at: 5 }),
      tsk_c: taskRow({ id: 'tsk_c', title: '执行中任务', stage: 'doing', task_revision: 2, created_at: 7 }),
      tsk_d: taskRow({ id: 'tsk_d', project_id: 'prj_3', title: '归档项目任务', created_at: 8 }),
    },
  })
  const execute = commandsFor(home)
  const before = stateOf(home).revision

  const all = await execute('task.list', { operation_key: 'list-1', project_id: 'prj_1' })
  assert.deepEqual(all.body.tasks.map(task => task.id), ['tsk_c', 'tsk_a'])
  assert.equal(all.revision, before)

  const doing = await execute('task.list', { operation_key: 'list-2', project_id: 'prj_1', stage: 'doing' })
  assert.deepEqual(doing.body.tasks.map(task => task.id), ['tsk_c'])

  const archived = await execute('task.list', { operation_key: 'list-3', project_id: 'prj_3' })
  assert.deepEqual(archived.body.tasks.map(task => task.id), ['tsk_d'])

  await failure(execute('task.list', { operation_key: 'list-4', project_id: 'prj_9' }), 'project/not-found')

  const saved = stateOf(home)
  assert.equal(saved.revision, before)
  assert.equal(saved.operation_log['list-1'], undefined)
})

test('api: the task refusals carry the HTTP codes the screens switch on', () => {
  assert.equal(statusOf('task/not-found'), 404)
  assert.equal(statusOf('task/state-conflict'), 409)
  assert.equal(statusOf('task/revision-conflict'), 409)
  assert.equal(statusOf('task/acceptance-required'), 409)
  assert.equal(statusOf('task/dependency-unmet'), 409)
  assert.equal(statusOf('task/missing-input'), 422)
  assert.equal(statusOf('task/dependency-cycle'), 422)
  assert.equal(statusOf('task/dependency-missing'), 422)
  assert.equal(statusOf('task/downgrade-forbidden'), 422)
})
