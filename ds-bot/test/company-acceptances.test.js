// The answering half of M1b-2b: an approval answer relays to the host and leaves one note,
// and an acceptance is written and decided as a company object. The cases follow the
// contract's A-list (A9, A12, A14) plus the round trip through the read view, so a failure
// names the promise that broke rather than the function that changed.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ROW_REVISION_COMMANDS, acceptanceHandlers } from '../src/host/company/acceptances.js'
import { createCompanyApi } from '../src/host/company/api.js'
import { createCommands } from '../src/host/company/commands.js'
import { createCompanyStore } from '../src/host/company/store.js'
import { TODOS_ANSWER_PATH } from '../src/host/company/todos.js'

const AT = 1_700_000_000_000
const AT_ISO = new Date(AT).toISOString()
const MINUTE = 60_000

const openHome = async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-acceptances-'))
  mkdirSync(join(home, 'company'), { recursive: true })
  return home
}

const employee = (id, name, botId, extra = {}) => ({ id, name, bot_id: botId, status: 'active', role: 'member', company_id: 'cmp_1', created_at: 1, ...extra })

const project = (id, name, roomId, extra = {}) => ({
  id,
  name,
  status: 'active',
  company_id: 'cmp_1',
  group_chat_ref: roomId,
  coordinator_assignment_id: null,
  acceptance_actor: 'user',
  acceptance_requirement: 'daily_independent_bot',
  created_at: 1,
  ...extra,
})

const member = (id, projectId, employeeId, extra = {}) => ({ id, project_id: projectId, employee_id: employeeId, role: 'executor', membership_status: 'active', ...extra })

const acceptance = (extra = {}) => ({
  id: 'acc_1',
  project_id: 'prj_1',
  task_id: null,
  title: 'M1b-2 待办聚合读接口',
  submitted_version: 'v1.0',
  acceptance_criteria: '全部用例通过',
  requester_employee_id: 'emp_1',
  acceptance_actor: 'user',
  owner_only: false,
  state: 'pending',
  opinion: null,
  decided_at: null,
  created_at: AT - 30 * MINUTE,
  updated_at: AT - 30 * MINUTE,
  revision: 3,
  ...extra,
})

const seed = (home, { projects = [], employees = [], members = [], acceptances = {}, todoLog = {} } = {}) => {
  const state = {
    version: 2,
    revision: 4,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees: Object.fromEntries(employees.map(entry => [entry.id, entry])),
    projects: Object.fromEntries(projects.map(entry => [entry.id, entry])),
    members: Object.fromEntries(members.map(entry => [entry.id, entry])),
    operation_log: {},
    acceptances,
    todo_log: todoLog,
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(state))
  return state
}

const writeJsonl = (home, name, rows) => {
  writeFileSync(join(home, 'company', name), rows.map(row => JSON.stringify(row)).join('\n').concat(rows.length === 0 ? '' : '\n'))
}

const liveCard = (extra = {}) => ({
  id: 'row_1',
  sessionId: 'sess_1',
  botId: 'bot_1',
  tool: 'bash',
  callId: 'call_1',
  reason: 'needs approval',
  detail: { code: 'bash deploy.sh' },
  at: AT - 5 * MINUTE,
  answerable: true,
  ...extra,
})

const storeOf = (home) => createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT })

const apiOf = (home, { approvals = () => [], answerApproval, execute = async () => ({}), warn = () => {} } = {}) => createCompanyApi({
  store: storeOf(home),
  execute,
  groups: {},
  now: () => AT,
  approvals,
  sessionBot: () => undefined,
  home,
  answerApproval,
  warn,
})

// The same wiring install() uses: a row decides on its own revision, not the company's.
const commandsFor = (store) => createCommands({ store, now: () => AT, handlers: acceptanceHandlers(), rowRevisionCommands: ROW_REVISION_COMMANDS })

const stateOf = home => JSON.parse(readFileSync(join(home, 'company', 'state.json'), 'utf8'))
const eventsOf = home => readFileSync(join(home, 'company', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

test('A9: an answer reaches the host once, leaves one note, and a second answer finds nothing', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')], members: [member('mem_1', 'prj_1', 'emp_1')] })
  writeJsonl(home, 'selfreview.jsonl', [{
    id: 'rec_1', request_id: 'req_1', call_id: 'call_1', decision: 'allow', status: 'judged', tool: 'bash',
    target: 'deploy.sh', predicted_risk_tier: 'low', host_policy: 'ask', created_at: new Date(AT - 10 * MINUTE).toISOString(),
    project_id: 'prj_1',
  }])
  writeJsonl(home, 'selfreview-host.jsonl', [
    { schema: 1, at: AT_ISO, session_id: 'sess_1', type: 'approval/asked', call_id: 'call_1', approval_id: 'appr_host_1', tool: 'bash' },
  ])
  let cards = [liveCard()]
  const calls = []
  const answerApproval = (id, choice) => {
    calls.push({ id, choice })
    cards = cards.filter(card => card.id !== id)
  }
  const api = apiOf(home, { approvals: () => cards, answerApproval })

  const first = await api.answer({ todo_id: 'ap_row_1', answer_ref: 'row_1', decision: 'allow', opinion: '只允许这一次', operation_key: 'answer-1' })
  assert.equal(first.status, 200)
  assert.deepEqual(first.body, { ok: true, todo_id: 'ap_row_1', host_outcome: 'allowed-once', handled: true })
  assert.deepEqual(calls, [{ id: 'row_1', choice: 'allow' }])

  const saved = stateOf(home)
  const rows = Object.values(saved.todo_log)
  assert.equal(rows.length, 1)
  const note = rows[0]
  assert.match(note.id, /^tdl_[0-9a-f]{12}$/)
  assert.equal(note.card_kind, 'approval')
  assert.equal(note.call_id, 'call_1')
  assert.equal(note.answer_ref, 'row_1')
  assert.equal(note.approval_id, 'appr_host_1')
  assert.equal(note.project_id, 'prj_1')
  assert.equal(note.decision, 'allow')
  assert.equal(note.opinion, '只允许这一次')
  assert.equal(note.at, AT)

  // The card is gone from the host, so answering it again is not a second decision.
  const again = await api.answer({ todo_id: 'ap_row_1', answer_ref: 'row_1', decision: 'allow', operation_key: 'answer-2' })
  assert.equal(again.status, 404)
  assert.equal(again.body.code, 'todo/unknown')
  assert.equal(Object.values(stateOf(home).todo_log).length, 1)

  // A reject says so in the reply and in the note.
  cards = [liveCard({ id: 'row_2', callId: 'call_2', detail: { code: 'bash rm.sh' } })]
  writeJsonl(home, 'selfreview-host.jsonl', [
    { schema: 1, at: AT_ISO, session_id: 'sess_1', type: 'approval/asked', call_id: 'call_2', approval_id: 'appr_host_2', tool: 'bash' },
  ])
  const rejected = await api.answer({ todo_id: 'ap_row_2', answer_ref: 'row_2', decision: 'reject', operation_key: 'answer-3' })
  assert.equal(rejected.status, 200)
  assert.equal(rejected.body.host_outcome, 'rejected')
  const byCall = Object.fromEntries(Object.values(stateOf(home).todo_log).map(row => [row.call_id, row]))
  assert.equal(byCall.call_2.decision, 'reject')
  assert.equal(byCall.call_2.opinion, null)
  assert.equal(byCall.call_2.approval_id, 'appr_host_2')
})

test('A9: a lost note is a warning, never a reason to un-answer the host', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')], members: [member('mem_1', 'prj_1', 'emp_1')] })
  const warnings = []
  const calls = []
  // A store whose save always fails, as a full disk would: the host answer still stands.
  const store = {
    dir: join(home, 'company'),
    state: stateOf(home),
    assertWritable: () => {},
    commit: async () => { throw new Error('no space left') },
  }
  const api = createCompanyApi({
    store,
    execute: async () => ({}),
    groups: {},
    now: () => AT,
    approvals: () => [liveCard()],
    sessionBot: () => undefined,
    home,
    answerApproval: (id, choice) => { calls.push({ id, choice }) },
    warn: (...args) => warnings.push(args),
  })

  const result = await api.answer({ todo_id: 'ap_row_1', answer_ref: 'row_1', decision: 'allow', operation_key: 'answer-4' })

  assert.equal(result.status, 200)
  assert.equal(result.body.handled, true)
  assert.deepEqual(calls, [{ id: 'row_1', choice: 'allow' }])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /could not record the answer/)
})

test('the answer endpoint refuses what the contract says it refuses', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')], members: [member('mem_1', 'prj_1', 'emp_1')] })
  let cards = [liveCard()]
  const api = apiOf(home, { approvals: () => cards, answerApproval: () => { cards = [] } })

  // An acceptance row is decided by `acceptance.decide`, not by allow/reject.
  const acceptanceRow = await api.answer({ todo_id: 'ac_acc_1', answer_ref: 'row_1', decision: 'allow', operation_key: 'k-1' })
  assert.equal(acceptanceRow.status, 422)
  assert.equal(acceptanceRow.body.code, 'todo/unsupported')

  // An unassigned row has no card here; its card lives in the private chat (B-1).
  const unassigned = await api.answer({ todo_id: 'ap_row_1', answer_ref: null, decision: 'allow', operation_key: 'k-2' })
  assert.equal(unassigned.status, 404)
  assert.equal(unassigned.body.code, 'todo/unknown')

  // A row that names another card has changed under the caller.
  const stale = await api.answer({ todo_id: 'ap_row_9', answer_ref: 'row_1', decision: 'allow', operation_key: 'k-3' })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'todo/stale')

  // A decision this build does not know is a bad request, not a guess.
  const bad = await api.answer({ todo_id: 'ap_row_1', answer_ref: 'row_1', decision: 'maybe', operation_key: 'k-4' })
  assert.equal(bad.status, 422)
  assert.equal(bad.body.code, 'todo/invalid')
  const noKey = await api.answer({ todo_id: 'ap_row_1', answer_ref: 'row_1', decision: 'allow' })
  assert.equal(noKey.status, 422)
  assert.equal(noKey.body.code, 'todo/invalid')
})

test('the answer route is registered beside the read route', async () => {
  const home = await openHome()
  seed(home, {})
  const api = apiOf(home, {})
  const registered = []
  const dispose = api.register({ connection: { fetch: { register: (route) => { registered.push(route); return () => {} } } } })
  const answer = registered.find(route => route.path === TODOS_ANSWER_PATH)
  assert.ok(answer, 'the answer route is registered')
  assert.deepEqual(answer.methods, ['POST'])

  // The route itself answers with the same body the method returns.
  const response = await answer.fetch(new Request('http://127.0.0.1/api/company/todos/answer', {
    method: 'POST',
    body: JSON.stringify({ todo_id: 'ap_row_1', answer_ref: 'row_1', decision: 'allow', operation_key: 'k-5' }),
  }))
  assert.equal(response.status, 404)
  assert.equal((await response.json()).code, 'todo/unknown')
  dispose()
})

test('A12: a stale row revision is refused and the acceptance keeps its pending state', async () => {
  const home = await openHome()
  seed(home, {
    projects: [project('prj_1', 'Alpha', 'room_1')],
    employees: [employee('emp_1', '小蓝', 'bot_1')],
    members: [member('mem_1', 'prj_1', 'emp_1')],
    acceptances: { acc_1: acceptance() },
  })
  const store = storeOf(home)
  const api = createCompanyApi({ store, execute: commandsFor(store).execute, groups: {}, now: () => AT, approvals: () => [], home })

  const stale = await api.command({ command: 'acceptance.decide', operation_key: 'decide-1', expected_revision: 2, payload: { acceptance_id: 'acc_1', decision: 'accept' } })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'company/revision-conflict')
  assert.equal(stateOf(home).acceptances.acc_1.state, 'pending')
  assert.equal(stateOf(home).acceptances.acc_1.revision, 3)

  const missing = await api.command({ command: 'acceptance.decide', operation_key: 'decide-2', payload: { acceptance_id: 'acc_1', decision: 'accept' } })
  assert.equal(missing.status, 409)
  assert.equal(missing.body.code, 'company/revision-conflict')

  const decided = await api.command({ command: 'acceptance.decide', operation_key: 'decide-3', expected_revision: 3, payload: { acceptance_id: 'acc_1', decision: 'accept', opinion: '第 3 条不达标' } })
  assert.equal(decided.status, 200)
  const row = decided.body.body.acceptance
  assert.equal(row.state, 'accepted')
  assert.equal(row.revision, 4)
  assert.equal(row.decided_at, AT)
  assert.equal(row.opinion, '第 3 条不达标')
  const saved = stateOf(home).acceptances.acc_1
  assert.equal(saved.state, 'accepted')
  assert.equal(saved.revision, 4)

  const events = eventsOf(home)
  const decidedEvent = events.find(event => event.type === 'acceptance.decided')
  assert.deepEqual(decidedEvent.data, { acceptance_id: 'acc_1', project_id: 'prj_1', decision: 'accept' })

  const twice = await api.command({ command: 'acceptance.decide', operation_key: 'decide-4', expected_revision: 4, payload: { acceptance_id: 'acc_1', decision: 'return' } })
  assert.equal(twice.status, 409)
  assert.equal(twice.body.code, 'acceptance/state-conflict')
  assert.equal(stateOf(home).acceptances.acc_1.state, 'accepted')
})

test('a decision writes the project onto its event, so the project page can find it', async () => {
  const home = await openHome()
  seed(home, {
    projects: [project('prj_1', 'Alpha', 'room_1')],
    employees: [employee('emp_1', '小蓝', 'bot_1')],
    acceptances: { acc_1: acceptance({ revision: 3 }) },
  })
  const store = storeOf(home)
  const api = createCompanyApi({ store, execute: commandsFor(store).execute, groups: {}, now: () => AT, approvals: () => [], home })

  const decided = await api.command({ command: 'acceptance.decide', operation_key: 'decide-project', expected_revision: 3, payload: { acceptance_id: 'acc_1', decision: 'return', opinion: '补测试' } })
  assert.equal(decided.status, 200)
  const event = eventsOf(home).findLast(entry => entry.type === 'acceptance.decided')
  assert.deepEqual(event.data, { acceptance_id: 'acc_1', project_id: 'prj_1', decision: 'return' })

  const page = await api.events({ project_id: 'prj_1' })
  assert.deepEqual(page.body.events.map(entry => entry.type), ['acceptance.decided'])
})

test('A13: an older decision without a project on it still counts as that project activity', async () => {
  const home = await openHome()
  seed(home, {
    projects: [project('prj_1', 'Alpha', 'room_1'), project('prj_2', 'Beta', 'room_2')],
    acceptances: {
      acc_1: acceptance({ id: 'acc_1', project_id: 'prj_1', state: 'accepted', revision: 4 }),
      acc_2: acceptance({ id: 'acc_2', project_id: 'prj_2', state: 'returned', revision: 2 }),
    },
  })
  const store = storeOf(home)
  const api = createCompanyApi({ store, execute: commandsFor(store).execute, groups: {}, now: () => AT, approvals: () => [], home })
  // A journal written before decisions carried a project id: the line names only the
  // acceptance. The read resolves the project from the acceptance record, and the line
  // itself keeps its original text — the attribution is computed, not rewritten.
  const legacy = [
    { id: 'evt_1_0', cursor: 1, at: AT_ISO, operation_key: 'old-1', command: 'acceptance.decide', aggregate_id: 'acc_1', type: 'acceptance.decided', data: { acceptance_id: 'acc_1', decision: 'accept' } },
    { id: 'evt_2_0', cursor: 2, at: AT_ISO, operation_key: 'old-2', command: 'acceptance.decide', aggregate_id: 'acc_2', type: 'acceptance.decided', data: { acceptance_id: 'acc_2', decision: 'return' } },
  ]
  writeFileSync(join(home, 'company', 'events.jsonl'), legacy.map(entry => JSON.stringify(entry)).join('\n') + '\n')

  const first = await api.events({ project_id: 'prj_1' })
  assert.deepEqual(first.body.events.map(entry => entry.cursor), [1])
  assert.deepEqual(first.body.events[0].data, { acceptance_id: 'acc_1', decision: 'accept' })
  const second = await api.events({ project_id: 'prj_2' })
  assert.deepEqual(second.body.events.map(entry => entry.cursor), [2])
  const none = await api.events({ project_id: 'prj_1', order: 'desc', limit: '5' })
  assert.deepEqual(none.body.events.map(entry => entry.cursor), [1])
  assert.equal(none.body.has_more, false)
})

test('A14: an owner_only project refuses an employee actor before anything is written', async () => {
  const home = await openHome()
  seed(home, {
    projects: [
      project('prj_1', 'Owner only', 'room_1', { acceptance_requirement: 'owner_only', acceptance_actor: 'user' }),
      project('prj_2', 'Daily review', 'room_2', { acceptance_requirement: 'daily_independent_bot' }),
    ],
    employees: [employee('emp_1', '小蓝', 'bot_1')],
    members: [member('mem_1', 'prj_1', 'emp_1'), member('mem_2', 'prj_2', 'emp_1')],
  })
  const store = storeOf(home)
  const api = createCompanyApi({ store, execute: commandsFor(store).execute, groups: {}, now: () => AT, approvals: () => [], home })
  const submit = (payload) => api.command({ command: 'acceptance.submit', operation_key: `submit-${Math.random()}`, payload })

  const refused = await submit({ project_id: 'prj_1', title: '敏感交付', requester_employee_id: 'emp_1', acceptance_actor: 'emp_1' })
  assert.equal(refused.status, 422)
  assert.equal(refused.body.code, 'owner_only_requires_user')
  assert.deepEqual(Object.keys(stateOf(home).acceptances), [])

  const owner = await submit({ project_id: 'prj_1', title: '敏感交付', requester_employee_id: 'emp_1', submitted_version: 'v2', acceptance_criteria: '老板亲自验收' })
  assert.equal(owner.status, 200)
  const accepted = owner.body.body.acceptance
  assert.match(accepted.id, /^acc_[0-9a-f]{12}$/)
  assert.equal(accepted.owner_only, true)
  assert.equal(accepted.acceptance_actor, 'user')
  assert.equal(accepted.state, 'pending')
  assert.equal(accepted.revision, 1)
  assert.equal(accepted.task_id, null)
  assert.equal(accepted.created_at, AT)

  const daily = await submit({ project_id: 'prj_2', title: '日常交付', requester_employee_id: 'emp_1', acceptance_actor: 'emp_1' })
  assert.equal(daily.status, 200)
  assert.equal(daily.body.body.acceptance.owner_only, false)
  assert.equal(daily.body.body.acceptance.acceptance_actor, 'emp_1')

  // The requester has to be a live member of the project it accepts for.
  const outsider = await submit({ project_id: 'prj_2', title: '外部提交', requester_employee_id: 'emp_x' })
  assert.equal(outsider.status, 404)
  assert.equal(outsider.body.code, 'employee/not-found')
})

test('a submitted acceptance appears in the to-do view, and leaves it after the decision', async () => {
  const home = await openHome()
  seed(home, {
    projects: [project('prj_1', 'Owner only', 'room_1', { acceptance_requirement: 'owner_only', acceptance_actor: 'user' })],
    employees: [employee('emp_1', '小蓝', 'bot_1')],
    members: [member('mem_1', 'prj_1', 'emp_1')],
  })
  const store = storeOf(home)
  const execute = commandsFor(store).execute
  const api = createCompanyApi({ store, execute, groups: {}, now: () => AT, approvals: () => [], sessionBot: () => 'bot_1', home })

  const submitted = await api.command({ command: 'acceptance.submit', operation_key: 'submit-1', payload: { project_id: 'prj_1', title: 'M1b-2b 答复与验收对象', requester_employee_id: 'emp_1' } })
  assert.equal(submitted.status, 200)
  const acceptanceId = submitted.body.body.acceptance.id

  const before = await api.todos({})
  assert.equal(before.status, 200)
  const waiting = before.body.waiting.find(row => row.id === `ac_${acceptanceId}`)
  assert.ok(waiting, 'the acceptance is waiting')
  assert.equal(waiting.card_kind, 'acceptance')
  assert.equal(waiting.revision, 1)
  assert.equal(waiting.risk_text, '待确认')
  assert.equal(waiting.risk_source, 'none')
  assert.equal(waiting.ready, true)
  assert.equal(waiting.owner_only, true)
  assert.equal(waiting.acceptance_criteria, null)
  assert.equal(before.body.counts.waiting_acceptances, 1)

  const decided = await api.command({ command: 'acceptance.decide', operation_key: 'decide-1', expected_revision: waiting.revision, payload: { acceptance_id: acceptanceId, decision: 'return', opinion: '补测试' } })
  assert.equal(decided.status, 200)

  const after = await api.todos({})
  assert.equal(after.body.counts.waiting_acceptances, 0)
  const handled = after.body.handled.find(row => row.id === `ac_${acceptanceId}`)
  assert.ok(handled, 'the decided acceptance is handled history')
  assert.equal(handled.state, 'returned')
  assert.equal(handled.handled, true)
  assert.equal(handled.opinion, '补测试')
  assert.equal(after.body.counts.handled_returned, 1)
})

test('S-4: a note waits for the command in the queue and neither write is lost', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')], members: [member('mem_1', 'prj_1', 'emp_1')] })
  writeJsonl(home, 'selfreview-host.jsonl', [
    { schema: 1, at: AT_ISO, session_id: 'sess_1', type: 'approval/asked', call_id: 'call_1', approval_id: 'appr_host_1', tool: 'bash' },
  ])
  const store = storeOf(home)
  // A gate instead of a race: the command parks inside the queue, the answer is sent while the
  // queue is occupied, and only then the command is let through. Without the shared queue the
  // note would commit immediately, over the command's unfinished state.
  let openGate
  const gate = new Promise(resolve => { openGate = resolve })
  let parked
  const entered = new Promise(resolve => { parked = resolve })
  const commands = createCommands({
    store,
    now: () => AT,
    handlers: {
      'company/hire': async ({ state, payload }) => {
        parked()
        await gate
        state.employees[payload.id] = employee(payload.id, '新同事', 'bot_9')
        return { events: [] }
      },
    },
  })
  const api = createCompanyApi({
    store,
    execute: (command, payload) => commands.execute(command, payload),
    groups: {},
    now: () => AT,
    approvals: () => [liveCard()],
    sessionBot: () => undefined,
    home,
    answerApproval: () => {},
    runExclusive: commands.runExclusive,
    warn: () => {},
  })

  const hired = commands.execute('company/hire', { operation_key: 'hire-1', id: 'emp_9' })
  await entered
  let answered = false
  const answering = api.answer({ todo_id: 'ap_row_1', answer_ref: 'row_1', decision: 'allow', operation_key: 'answer-1' })
  answering.then(() => { answered = true })

  // The queue is still occupied, so the note has neither saved nor returned.
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(answered, false, 'the note waits for the command in the queue')
  assert.equal(Object.values(stateOf(home).todo_log).length, 0, 'nothing is saved while the command holds the queue')

  openGate()
  const [commandResult, answerResult] = await Promise.all([hired, answering])
  assert.equal(commandResult.status, 'committed')
  assert.equal(answerResult.status, 200)
  assert.equal(answerResult.body.handled, true)

  const saved = stateOf(home)
  assert.ok(saved.employees.emp_9, 'the command write survived the answer note')
  assert.equal(Object.values(saved.todo_log).length, 1, 'the note survived the command write')
  // The note is a note, not a command: it neither takes a revision nor records an operation.
  assert.equal(saved.operation_log['answer-1'], undefined)
})
