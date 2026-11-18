// Runs and dispatch (M1b-4.3): a Ready card goes to the Bot that owns it, the brief lands in
// that Bot's own chat, and the card moves to Doing in one commit. The cases follow the
// contract's §5.4: a dispatch that cannot land writes nothing, a failed dispatch comes back
// to Ready only through `run.fail`, and the board reads history without touching the file.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { statusOf } from '../src/host/company/api.js'
import { createCommands } from '../src/host/company/commands.js'
import { RUN_ROW_REVISION_COMMANDS, runHandlers } from '../src/host/company/runs.js'
import { createCompanyStore } from '../src/host/company/store.js'
import { TASK_ROW_REVISION_COMMANDS, taskHandlers } from '../src/host/company/tasks.js'

const AT = 1_700_000_000_000

const openHome = async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-runs-'))
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
  description: '把任务表与五条命令做出来',
  source_ref: 'room_1#m1',
  parent_id: null,
  owner_assignment_id: 'mem_owner',
  stage: 'ready',
  hold_reason: 'none',
  next_action: null,
  input_refs: ['设计稿 §5.3'],
  acceptance_checks: ['五命令可用', '循环被拒'],
  acceptance_actor: 'emp_acceptor',
  deliverable_class: 'normal',
  deliverable_class_source: 'default',
  acceptance_requirement: 'daily_independent_bot',
  independence_required: true,
  dependencies: [],
  authorization_scope_ref: 'scope_alpha',
  task_revision: 2,
  problem_ids: [],
  artifact_refs: [],
  latest_run_id: null,
  submissions: [],
  ready_at: 5,
  started_at: null,
  submitted_at: null,
  completed_at: null,
  reopened_at: null,
  reopen_reason: null,
  cancelled_at: null,
  cancelled_from: null,
  cancel_reason: null,
  created_at: 10,
  updated_at: 20,
  ...extra,
})

const runRow = (extra = {}) => ({
  id: 'run_0123456789ab',
  project_id: 'prj_1',
  task_id: 'tsk_a',
  task_revision: 2,
  employee_id: 'emp_owner',
  bot_id: 'bot_keyboard',
  session_id: 'chat_bot_keyboard',
  state: 'dispatched',
  instruction: '[任务派单]\n任务：tsk_a / r2',
  dispatched_at: 30,
  ended_at: null,
  failure_reason: null,
  created_at: 30,
  ...extra,
})

const seed = (home, { projects = [project()], employees = [], members = [], tasks = { tsk_a: taskRow() }, runs = {} } = {}) => {
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
    runs,
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(state))
  return state
}

const storeOf = (home) => createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT })

const hostFor = (staff = []) => {
  const sent = []
  return {
    sent,
    botOf: id => staff.find(entry => entry.bot_id === id),
    chatOf: id => `chat_${id}`,
    deliver: async (message) => { sent.push(message) },
  }
}

const staffOf = (home) => Object.values(stateOf(home).employees)

const commandsFor = (home, host = hostFor(staffOf(home))) => createCommands({
  store: storeOf(home),
  now: () => AT,
  handlers: { ...taskHandlers(), ...runHandlers({ rt: host }) },
  rowRevisionCommands: new Set([...TASK_ROW_REVISION_COMMANDS, ...RUN_ROW_REVISION_COMMANDS]),
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

test('dispatch: a ready card goes to the owner Bot and moves to doing in one commit', async () => {
  const home = await openHome()
  seed(home)
  const host = hostFor([employee('emp_owner', '键盘', 'bot_keyboard'), employee('emp_acceptor', '白菜', 'bot_cabbage')])
  const execute = commandsFor(home, host)

  const result = await execute('task.dispatch', { operation_key: 'dispatch-1', task_id: 'tsk_a', expected_revision: 2 })
  assert.equal(result.status, 'committed')
  assert.equal(result.revision, 5)
  const { task, run } = result.body
  assert.equal(task.stage, 'doing')
  assert.equal(task.task_revision, 3)
  assert.equal(task.latest_run_id, run.id)
  assert.equal(task.started_at, AT)
  assert.match(run.id, /^run_[0-9a-f]{12}$/)
  assert.equal(run.state, 'dispatched')
  assert.equal(run.task_revision, 2)
  assert.equal(run.employee_id, 'emp_owner')
  assert.equal(run.bot_id, 'bot_keyboard')
  assert.equal(run.session_id, 'chat_bot_keyboard')
  assert.equal(run.dispatched_at, AT)

  assert.equal(host.sent.length, 1)
  assert.equal(host.sent[0].toId, 'bot_keyboard')
  assert.equal(host.sent[0].role, 'task')
  assert.equal(host.sent[0].text, run.instruction)
  assert.match(run.instruction, /tsk_a \/ r2/)
  assert.match(run.instruction, /写任务表/)
  assert.match(run.instruction, /1\) 五命令可用/)
  assert.match(run.instruction, /验收人：白菜/)
  assert.match(run.instruction, /工作文件夹：scope_alpha/)
  assert.doesNotMatch(run.instruction, /undefined/)

  const saved = stateOf(home)
  assert.equal(saved.tasks.tsk_a.stage, 'doing')
  assert.equal(saved.runs[run.id].state, 'dispatched')
  const events = eventsOf(home)
  assert.deepEqual(events.slice(-2).map(event => event.type), ['run.dispatched', 'task.moved'])
  assert.deepEqual(events.at(-1).data, { task_id: 'tsk_a', project_id: 'prj_1', from: 'ready', to: 'doing', task_revision: 3 })
})

test('dispatch: a draft or a stale read is refused before anything is written', async () => {
  const home = await openHome()
  seed(home, { tasks: { tsk_a: taskRow({ stage: 'draft' }) } })
  const execute = commandsFor(home)

  await failure(execute('task.dispatch', { operation_key: 'd-draft', task_id: 'tsk_a', expected_revision: 2 }), 'task/state-conflict')

  const stale = await failure(execute('task.dispatch', { operation_key: 'd-stale', task_id: 'tsk_a', expected_revision: 1 }), 'task/revision-conflict')
  assert.deepEqual(stale.details, { task_id: 'tsk_a', expected_revision: 1, revision: 2 })
  assert.deepEqual(Object.keys(stateOf(home).runs), [])
  assert.equal(existsSync(join(home, 'company', 'events.jsonl')), false)
})

test('dispatch: dependencies still open block the run, and a dependency that vanished is a 422', async () => {
  const home = await openHome()
  seed(home, {
    tasks: {
      tsk_a: taskRow({ dependencies: ['tsk_dep'] }),
      tsk_dep: taskRow({ id: 'tsk_dep', title: '先做依赖', stage: 'draft' }),
    },
  })
  const execute = commandsFor(home)

  const unmet = await failure(execute('task.dispatch', { operation_key: 'd-unmet', task_id: 'tsk_a', expected_revision: 2 }), 'task/dependency-unmet')
  assert.equal(unmet.details.blocking[0].task_id, 'tsk_dep')
  assert.equal(unmet.details.blocking[0].title, '先做依赖')

  seed(home, { tasks: { tsk_a: taskRow({ dependencies: ['tsk_ghost'] }) } })
  await failure(commandsFor(home)('task.dispatch', { operation_key: 'd-ghost', task_id: 'tsk_a', expected_revision: 2 }), 'task/dependency-missing')
})

test('dispatch: a host that cannot deliver refuses and writes nothing', async () => {
  const home = await openHome()
  seed(home)
  const ownerless = employee('emp_owner', '键盘', null)
  const noBot = hostFor([ownerless, employee('emp_acceptor', '白菜', 'bot_cabbage')])
  await failure(commandsFor(home, noBot)('task.dispatch', { operation_key: 'd-nobot', task_id: 'tsk_a', expected_revision: 2 }), 'company/unsupported')

  const before = readFileSync(join(home, 'company', 'state.json'), 'utf8')
  const broken = { deliver: async () => { throw new Error('chat closed') }, botOf: () => employee('emp_owner', '键盘', 'bot_keyboard'), chatOf: () => 'chat_bot_keyboard' }
  const error = await failure(commandsFor(home, broken)('task.dispatch', { operation_key: 'd-throw', task_id: 'tsk_a', expected_revision: 2 }), 'run/deliver-failed')
  assert.match(error.message, /chat closed/)
  assert.equal(readFileSync(join(home, 'company', 'state.json'), 'utf8'), before)
  assert.equal(existsSync(join(home, 'company', 'events.jsonl')), false)
})

test('list: runs come newest first, filter by task and state, and archive still reads', async () => {
  const home = await openHome()
  seed(home, {
    projects: [project(), project({ id: 'prj_2', name: 'Beta', status: 'archived' })],
    tasks: { tsk_a: taskRow(), tsk_b: taskRow({ id: 'tsk_b', title: '另一张', task_revision: 1 }) },
    runs: {
      run_a1: runRow({ id: 'run_a1', dispatched_at: 10 }),
      run_a2: runRow({ id: 'run_a2', state: 'failed', dispatched_at: 30, failure_reason: '掉线' }),
      run_b1: runRow({ id: 'run_b1', task_id: 'tsk_b', dispatched_at: 20 }),
      run_other: runRow({ id: 'run_other', project_id: 'prj_2', task_id: 'tsk_b', dispatched_at: 40 }),
    },
  })
  const execute = commandsFor(home)

  const all = await execute('run.list', { operation_key: 'l-all', project_id: 'prj_1' })
  assert.equal(all.status, 'ok')
  assert.equal(all.revision, 4)
  assert.deepEqual(all.body.runs.map(run => run.id), ['run_a2', 'run_b1', 'run_a1'])
  assert.equal(all.body.runs[0].failure_reason, '掉线')
  assert.match(all.body.runs[0].instruction, /\[任务派单\]/)

  const oneTask = await execute('run.list', { operation_key: 'l-task', project_id: 'prj_1', task_id: 'tsk_b' })
  assert.deepEqual(oneTask.body.runs.map(run => run.id), ['run_b1'])
  const failed = await execute('run.list', { operation_key: 'l-state', project_id: 'prj_1', state: 'failed' })
  assert.deepEqual(failed.body.runs.map(run => run.id), ['run_a2'])
  const limited = await execute('run.list', { operation_key: 'l-limit', project_id: 'prj_1', limit: 1 })
  assert.equal(limited.body.runs.length, 1)

  const archived = await execute('run.list', { operation_key: 'l-arch', project_id: 'prj_2' })
  assert.deepEqual(archived.body.runs.map(run => run.id), ['run_other'])

  const saved = stateOf(home)
  assert.deepEqual(saved.operation_log, {})
  await failure(execute('run.list', { operation_key: 'l-missing', project_id: 'prj_x' }), 'project/not-found')
  await failure(execute('run.list', { operation_key: 'l-bad-state', project_id: 'prj_1', state: 'done' }), 'company/invalid')
  await failure(execute('run.list', { operation_key: 'l-bad-limit', project_id: 'prj_1', limit: 0 }), 'company/invalid')
})

test('fail: the latest run goes back to ready, then a second dispatch makes a second run', async () => {
  const home = await openHome()
  seed(home)
  const host = hostFor([employee('emp_owner', '键盘', 'bot_keyboard'), employee('emp_acceptor', '白菜', 'bot_cabbage')])
  const execute = commandsFor(home, host)

  const first = await execute('task.dispatch', { operation_key: 'd-1', task_id: 'tsk_a', expected_revision: 2 })
  const failed = await execute('run.fail', { operation_key: 'f-1', run_id: first.body.run.id, expected_revision: 3, reason: 'Bot 没接上' })
  assert.equal(failed.body.task.stage, 'ready')
  assert.equal(failed.body.task.task_revision, 4)
  assert.equal(failed.body.task.hold_reason, 'none')
  assert.equal(failed.body.run.state, 'failed')
  assert.equal(failed.body.run.ended_at, AT)
  assert.equal(failed.body.run.failure_reason, 'Bot 没接上')
  assert.deepEqual(eventsOf(home).slice(-2).map(event => event.type), ['run.failed', 'task.moved'])

  const second = await execute('task.dispatch', { operation_key: 'd-2', task_id: 'tsk_a', expected_revision: 4 })
  assert.notEqual(second.body.run.id, first.body.run.id)
  assert.equal(second.body.task.stage, 'doing')
  assert.equal(second.body.task.task_revision, 5)
  const saved = stateOf(home)
  assert.equal(Object.keys(saved.runs).length, 2)
  assert.equal(saved.runs[first.body.run.id].state, 'failed')
  assert.equal(saved.runs[second.body.run.id].state, 'dispatched')
})

test('fail: an older run, a stale task revision, a non-doing card and a missing reason are refused', async () => {
  const home = await openHome()
  seed(home, {
    tasks: { tsk_a: taskRow({ stage: 'doing', latest_run_id: 'run_new', task_revision: 4 }) },
    runs: {
      run_old: runRow({ id: 'run_old' }),
      run_new: runRow({ id: 'run_new' }),
    },
  })
  const execute = commandsFor(home)

  await failure(execute('run.fail', { operation_key: 'f-old', run_id: 'run_old', expected_revision: 4, reason: '旧单' }), 'run/state-conflict')
  await failure(execute('run.fail', { operation_key: 'f-stale', run_id: 'run_new', expected_revision: 2, reason: '旧读' }), 'task/revision-conflict')
  await failure(execute('run.fail', { operation_key: 'f-noreason', run_id: 'run_new', expected_revision: 4 }), 'company/invalid')

  seed(home, {
    tasks: { tsk_a: taskRow({ stage: 'ready', latest_run_id: 'run_old', task_revision: 4 }) },
    runs: { run_old: runRow({ id: 'run_old' }) },
  })
  await failure(commandsFor(home)('run.fail', { operation_key: 'f-stage', run_id: 'run_old', expected_revision: 4, reason: '未派单' }), 'task/state-conflict')
})

test('api: run refusals carry the HTTP codes the screens switch on', () => {
  assert.equal(statusOf('run/not-found'), 404)
  assert.equal(statusOf('run/state-conflict'), 409)
  assert.equal(statusOf('run/deliver-failed'), 422)
  assert.equal(statusOf('company/unsupported'), 422)
})
