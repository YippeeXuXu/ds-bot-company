// The task side of acceptance (4.4, contract §5.3.4/§5.3.7): a submission creates the
// pending record in the same commit, and that record is the only writer of a reviewed
// card's exit. The cases follow the contract's failure order — a stale revision, a card
// that left review, a second pending record — so a refusal names the promise that broke.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ROW_REVISION_COMMANDS, acceptanceHandlers, submitWithAcceptance } from '../src/host/company/acceptances.js'
import { createCommands } from '../src/host/company/commands.js'
import { createCompanyStore } from '../src/host/company/store.js'
import { TASK_ROW_REVISION_COMMANDS, taskHandlers } from '../src/host/company/tasks.js'

const AT = 1_700_000_000_000

const openHome = async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-task-acceptance-'))
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

const acceptance = (extra = {}) => ({
  id: 'acc_1',
  project_id: 'prj_1',
  task_id: null,
  task_revision: null,
  title: '旧交付',
  submitted_version: null,
  acceptance_criteria: null,
  requester_employee_id: 'emp_owner',
  acceptance_actor: 'emp_acceptor',
  owner_only: false,
  state: 'pending',
  opinion: null,
  decided_at: null,
  close_reason: null,
  created_at: 100,
  updated_at: 100,
  revision: 1,
  ...extra,
})

const seed = (home, { projects = [project()], tasks = {}, acceptances = {} } = {}) => {
  const staff = [employee('emp_owner', '键盘', 'bot_keyboard'), employee('emp_acceptor', '白菜', 'bot_cabbage'), employee('emp_other', '橙子', 'bot_orange')]
  const team = [member('mem_owner', 'prj_1', 'emp_owner'), member('mem_acceptor', 'prj_1', 'emp_acceptor'), member('mem_other', 'prj_1', 'emp_other')]
  const state = {
    version: 4,
    revision: 4,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees: Object.fromEntries(staff.map(entry => [entry.id, entry])),
    projects: Object.fromEntries(projects.map(entry => [entry.id, entry])),
    members: Object.fromEntries(team.map(entry => [entry.id, entry])),
    operation_log: {},
    acceptances,
    todo_log: {},
    templates: {},
    tasks,
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(state))
  return state
}

// The same handlers `install()` assembles: the task command wrapped with the acceptance
// creation, and both modules' row-revision commands declared to the envelope.
const handlersOf = () => {
  const tasks = taskHandlers()
  return { ...tasks, 'task.submit': submitWithAcceptance(tasks['task.submit']), ...acceptanceHandlers() }
}

const storeOf = (home) => createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT })
const commandsFor = (home) => createCommands({
  store: storeOf(home),
  now: () => AT,
  handlers: handlersOf(),
  rowRevisionCommands: new Set([...TASK_ROW_REVISION_COMMANDS, ...ROW_REVISION_COMMANDS]),
}).execute
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

const submit = (execute, extra = {}) => execute('task.submit', {
  operation_key: 'sub-1',
  task_id: 'tsk_a',
  expected_revision: 3,
  summary: '五条命令与单测都齐了',
  artifact_refs: ['file:///tmp/tasks.js'],
  check_notes: ['a 通过', 'b 通过'],
  ...extra,
})

test('submit: the card and its pending acceptance are written in one commit', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'doing', task_revision: 3, acceptance_checks: ['a', 'b'] }) } })
  const execute = commandsFor(home)

  const submitted = await submit(execute, { title: '任务表交付', submitted_version: 'v1', acceptance_criteria: '五命令可用，单测全绿' })
  assert.equal(submitted.revision, 5, 'one company revision covers both objects')
  assert.equal(submitted.body.task.stage, 'review')
  assert.equal(submitted.body.task.task_revision, 4)
  const row = submitted.body.acceptance
  assert.equal(row.task_id, 'tsk_a')
  assert.equal(row.task_revision, 4, 'the linked revision is the post-submit one')
  assert.equal(row.state, 'pending')
  assert.equal(row.requester_employee_id, 'emp_owner')
  assert.equal(row.acceptance_actor, 'emp_acceptor')
  assert.equal(row.owner_only, false)
  assert.equal(row.title, '任务表交付')
  assert.equal(row.submitted_version, 'v1')
  assert.equal(row.acceptance_criteria, '五命令可用，单测全绿')

  const state = stateOf(home)
  assert.deepEqual(Object.keys(state.acceptances), [row.id])
  assert.equal(state.acceptances[row.id].task_id, 'tsk_a')
  const events = eventsOf(home)
  assert.deepEqual(events.slice(-2).map(event => event.type), ['task.submitted', 'acceptance.submitted'])
  assert.equal(events.at(-1).data.acceptance_id, row.id)
  assert.equal(events.at(-1).data.task_id, 'tsk_a')
})

test('decide: accept ends the card, return puts it back to ready with the hold recomputed', async () => {
  const home = await openHome()
  seed(home, {
    tasks: {
      tsk_a: taskRow({ stage: 'doing', task_revision: 3, acceptance_checks: ['a', 'b'], dependencies: ['tsk_dep'] }),
      tsk_dep: taskRow({ id: 'tsk_dep', stage: 'review', task_revision: 2 }),
    },
  })
  const execute = commandsFor(home)

  const submitted = await submit(execute)
  const returned = await execute('acceptance.decide', { operation_key: 'dec-1', acceptance_id: submitted.body.acceptance.id, expected_revision: 1, decision: 'return', opinion: '补一条边界用例' })
  assert.equal(returned.body.acceptance.state, 'returned')
  const state = stateOf(home)
  assert.equal(state.tasks.tsk_a.stage, 'ready')
  assert.equal(state.tasks.tsk_a.task_revision, 5)
  assert.equal(state.tasks.tsk_a.hold_reason, 'dependency', 'the dependency is still in review')
  assert.equal(state.tasks.tsk_a.completed_at, null)
  const events = eventsOf(home)
  assert.deepEqual(events.slice(-2).map(event => event.type), ['acceptance.decided', 'task.moved'])
  assert.equal(events.at(-1).data.to, 'ready')
  assert.equal(events.at(-1).data.acceptance_id, submitted.body.acceptance.id)
  const decidedEvent = events.at(-2)
  assert.equal(decidedEvent.data.task_id, 'tsk_a')
  assert.equal(decidedEvent.data.task_stage, 'ready')
})

test('decide: accept writes done and the completion time in the same commit', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'doing', task_revision: 3, acceptance_checks: ['a', 'b'] }) } })
  const execute = commandsFor(home)

  const submitted = await submit(execute)
  const decided = await execute('acceptance.decide', { operation_key: 'dec-1', acceptance_id: submitted.body.acceptance.id, expected_revision: 1, decision: 'accept' })
  assert.equal(decided.body.acceptance.state, 'accepted')
  const state = stateOf(home)
  assert.equal(state.tasks.tsk_a.stage, 'done')
  assert.equal(state.tasks.tsk_a.task_revision, 5)
  assert.equal(state.tasks.tsk_a.completed_at, AT)
  const events = eventsOf(home)
  assert.equal(events.at(-1).data.to, 'done')
  assert.equal(events.at(-2).data.task_stage, 'done')
})

test('decide: a card that left review is refused and the acceptance stays pending', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'doing', task_revision: 3, acceptance_checks: ['a', 'b'] }) } })
  const execute = commandsFor(home)

  const submitted = await submit(execute)
  await execute('task.move', { operation_key: 'cancel-1', task_id: 'tsk_a', expected_revision: 4, to: 'cancelled', reason: '需求撤了' })
  const refused = await failure(execute('acceptance.decide', { operation_key: 'dec-1', acceptance_id: submitted.body.acceptance.id, expected_revision: 1, decision: 'return' }), 'task/state-conflict')
  assert.deepEqual(refused.details, { task_id: 'tsk_a', stage: 'cancelled', expected: 'review' })
  const state = stateOf(home)
  assert.equal(state.acceptances[submitted.body.acceptance.id].state, 'pending')
  assert.equal(state.tasks.tsk_a.stage, 'cancelled')
})

test('decide: a stale task revision is refused before either object is written', async () => {
  const home = await openHome()
  seed(home, {
    tasks: { tsk_a: taskRow({ stage: 'review', task_revision: 4, submitted_at: 3 }) },
    acceptances: { acc_stale: acceptance({ task_id: 'tsk_a', task_revision: 3 }) },
  })
  const execute = commandsFor(home)

  const refused = await failure(execute('acceptance.decide', { operation_key: 'dec-1', acceptance_id: 'acc_stale', expected_revision: 1, decision: 'accept' }), 'task/revision-conflict')
  assert.deepEqual(refused.details, { task_id: 'tsk_a', expected_revision: 3, revision: 4 })
  const state = stateOf(home)
  assert.equal(state.acceptances.acc_stale.state, 'pending')
  assert.equal(state.tasks.tsk_a.stage, 'review')
})

test('submit: a review already holding a pending record refuses a second link', async () => {
  const home = await openHome()
  seed(home, {
    tasks: { tsk_a: taskRow({ stage: 'review', task_revision: 4, submitted_at: 3 }) },
    acceptances: { acc_open: acceptance({ id: 'acc_open', task_id: 'tsk_a', task_revision: 4 }) },
  })
  const execute = commandsFor(home)

  const refused = await failure(execute('acceptance.submit', {
    operation_key: 'acc-1', project_id: 'prj_1', requester_employee_id: 'emp_owner', title: '再交一版', task_id: 'tsk_a', task_revision: 4,
  }), 'acceptance/state-conflict')
  assert.deepEqual(refused.details, { task_id: 'tsk_a', acceptance_id: 'acc_open' })
})

test('submit: an independent acceptance may attach to a review task, and keeps task_id null otherwise', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'review', task_revision: 4, submitted_at: 3 }) } })
  const execute = commandsFor(home)

  const wrong = await failure(execute('acceptance.submit', {
    operation_key: 'acc-1', project_id: 'prj_1', requester_employee_id: 'emp_owner', title: '交付', task_id: 'tsk_a', task_revision: 3,
  }), 'task/revision-conflict')
  assert.equal(wrong.details.revision, 4)

  const linked = await execute('acceptance.submit', { operation_key: 'acc-2', project_id: 'prj_1', requester_employee_id: 'emp_owner', title: '交付', task_id: 'tsk_a', task_revision: 4 })
  assert.equal(linked.body.acceptance.task_id, 'tsk_a')
  assert.equal(linked.body.acceptance.task_revision, 4)

  const standalone = await execute('acceptance.submit', { operation_key: 'acc-3', project_id: 'prj_1', requester_employee_id: 'emp_owner', title: '独立验收' })
  assert.equal(standalone.body.acceptance.task_id, null)
  assert.equal(standalone.body.acceptance.task_revision, null)
  assert.equal(eventsOf(home).at(-1).data.task_id, null)

  const decided = await execute('acceptance.decide', { operation_key: 'dec-1', acceptance_id: standalone.body.acceptance.id, expected_revision: 1, decision: 'accept' })
  assert.equal(decided.body.acceptance.state, 'accepted')
  const decidedEvent = eventsOf(home).at(-1)
  assert.equal(decidedEvent.type, 'acceptance.decided')
  assert.equal(decidedEvent.data.task_id, null)
  assert.equal(decidedEvent.data.task_stage, null)
  assert.equal(stateOf(home).tasks.tsk_a.stage, 'review', 'a standalone acceptance leaves the card alone')
})

test('list: newest first, filter by task and state, archived projects stay readable', async () => {
  const home = await openHome()
  seed(home, {
    projects: [project(), project({ id: 'prj_old', name: '旧项目', status: 'archived' })],
    acceptances: {
      acc_new: acceptance({ id: 'acc_new', task_id: 'tsk_a', task_revision: 4, created_at: 300 }),
      acc_old: acceptance({ id: 'acc_old', state: 'accepted', created_at: 200 }),
      acc_archived: acceptance({ id: 'acc_archived', project_id: 'prj_old', state: 'accepted', created_at: 400 }),
      acc_closed: acceptance({ id: 'acc_closed', state: 'cancelled', close_reason: 'project_archived', created_at: 100 }),
    },
  })
  const execute = commandsFor(home)

  const first = await execute('acceptance.list', { operation_key: 'list-1', project_id: 'prj_1' })
  assert.equal(first.revision, 4, 'a read does not bump the company revision')
  assert.deepEqual(first.body.acceptances.map(row => row.id), ['acc_new', 'acc_old', 'acc_closed'])
  assert.equal(first.body.acceptances[0].task_id, 'tsk_a')
  assert.equal(first.body.acceptances[1].task_id, null, 'older rows read as unlinked')

  const byTask = await execute('acceptance.list', { operation_key: 'list-2', project_id: 'prj_1', task_id: 'tsk_a' })
  assert.deepEqual(byTask.body.acceptances.map(row => row.id), ['acc_new'])
  const byState = await execute('acceptance.list', { operation_key: 'list-3', project_id: 'prj_1', state: 'accepted' })
  assert.deepEqual(byState.body.acceptances.map(row => row.id), ['acc_old'])
  const cancelled = await execute('acceptance.list', { operation_key: 'list-3b', project_id: 'prj_1', state: 'cancelled' })
  assert.deepEqual(cancelled.body.acceptances.map(row => row.id), ['acc_closed'])
  const limited = await execute('acceptance.list', { operation_key: 'list-4', project_id: 'prj_1', limit: 1 })
  assert.deepEqual(limited.body.acceptances.map(row => row.id), ['acc_new'])
  const archived = await execute('acceptance.list', { operation_key: 'list-5', project_id: 'prj_old' })
  assert.deepEqual(archived.body.acceptances.map(row => row.id), ['acc_archived'])
  assert.equal(stateOf(home).operation_log['list-1'], undefined, 'a read writes no replay record')

  const badState = await failure(execute('acceptance.list', { operation_key: 'list-6', project_id: 'prj_1', state: 'closed' }), 'company/invalid')
  assert.equal(badState.details.field, 'state')
  const badLimit = await failure(execute('acceptance.list', { operation_key: 'list-7', project_id: 'prj_1', limit: 0 }), 'company/invalid')
  assert.equal(badLimit.details.field, 'limit')
})
