// The to-do view's read side (2a): one aggregation over the live cards, the review records,
// the host facts and the acceptance objects. The cases follow the contract's A-list, so a
// failure says which promise broke rather than which function changed.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCompanyApi } from '../src/host/company/api.js'
import { install } from '../src/host/company/index.js'
import { createCompanyStore } from '../src/host/company/store.js'
import { createTodos } from '../src/host/company/todos.js'

const AT = 1_700_000_000_000
const AT_ISO = new Date(AT).toISOString()
const MINUTE = 60_000

const P09_FIELDS = ['id', 'card_kind', 'state', 'title', 'project_name', 'risk_text', 'requester', 'wait_minutes', 'opinion']

const openHome = async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-todos-'))
  mkdirSync(join(home, 'company'), { recursive: true })
  return home
}

const employee = (id, name, botId) => ({ id, name, bot_id: botId, status: 'active', role: 'member', company_id: 'cmp_1', created_at: 1 })

const project = (id, name, roomId, extra = {}) => ({
  id,
  name,
  status: 'active',
  company_id: 'cmp_1',
  group_chat_ref: roomId,
  coordinator_assignment_id: null,
  acceptance_requirement: 'daily_independent_bot',
  created_at: 1,
  ...extra,
})

const member = (id, projectId, employeeId) => ({ id, project_id: projectId, employee_id: employeeId, role: 'coordinator', membership_status: 'active' })

const seed = (home, { projects = [], employees = [], members = [], acceptances = {} }) => {
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
    todo_log: {},
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(state))
  return state
}

const writeJsonl = (home, name, rows) => {
  writeFileSync(join(home, 'company', name), rows.map(row => JSON.stringify(row)).join('\n').concat(rows.length === 0 ? '' : '\n'))
}

const record = (callId, extra = {}) => ({
  id: `rec_${callId}`,
  request_id: `req_${callId}`,
  call_id: callId,
  decision: 'allow',
  status: 'judged',
  tool: 'bash',
  target: 'deploy.sh',
  predicted_risk_tier: 'low',
  host_policy: 'ask',
  host_preset: 'ask',
  created_at: new Date(AT - 10 * MINUTE).toISOString(),
  ...extra,
})

const fact = (extra) => ({ schema: 1, at: AT_ISO, session_id: 'sess_1', ...extra })

const storeOf = (home) => createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT })

const apiOf = (home, { approvals = () => [], sessionBot = () => undefined, now = () => AT, redact } = {}) =>
  createCompanyApi({
    store: storeOf(home),
    execute: async () => ({}),
    groups: {},
    now,
    approvals,
    sessionBot,
    home,
    ...(redact === undefined ? {} : { redact }),
  })

const liveCard = (extra = {}) => ({
  id: 'ap_row_1',
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

test('A1: a read never writes the company, its revision or its journal', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')] })
  const api = apiOf(home, { approvals: () => [liveCard({ roomId: 'room_1' })] })
  const before = statSync(join(home, 'company', 'state.json'))
  const revision = storeOf(home).state.revision

  const result = await api.todos({})

  assert.equal(result.status, 200)
  const after = statSync(join(home, 'company', 'state.json'))
  assert.equal(after.mtimeMs, before.mtimeMs)
  assert.equal(after.size, before.size)
  assert.equal(storeOf(home).state.revision, revision)
  assert.equal(existsSync(join(home, 'company', 'events.jsonl')), false)
  assert.deepEqual(Object.keys(result.body.counts).sort(), [
    'handled_returned',
    'handled_total',
    'handled_total_capped',
    'waiting_acceptances',
    'waiting_approvals',
    'waiting_total',
    'waiting_unassigned',
  ])
  const [row] = result.body.waiting
  assert.deepEqual(Object.keys(row).slice(0, 9), P09_FIELDS)
})

test('A5: two projects, two cards — each row belongs to its own project and requester', async () => {
  const home = await openHome()
  seed(home, {
    projects: [project('prj_1', 'Alpha', 'room_1'), project('prj_2', 'Beta', 'room_2')],
    employees: [employee('emp_1', '小蓝', 'bot_1'), employee('emp_2', '橙子', 'bot_2')],
  })
  const cards = [
    liveCard({ id: 'ap_a', sessionId: 'sess_a', botId: 'bot_1', roomId: 'room_1', callId: 'call_a' }),
    liveCard({ id: 'ap_b', sessionId: 'sess_b', botId: 'bot_2', roomId: 'room_2', callId: 'call_b' }),
  ]
  const api = apiOf(home, { approvals: () => cards, sessionBot: id => (id === 'sess_a' ? 'bot_1' : 'bot_2') })
  const { body } = await api.todos({})

  assert.equal(body.waiting.length, 2)
  const byProject = new Map(body.waiting.map(row => [row.project_id, row]))
  assert.equal(byProject.get('prj_1').project_name, 'Alpha')
  assert.equal(byProject.get('prj_1').requester, '小蓝')
  assert.equal(byProject.get('prj_1').room_id, 'room_1')
  assert.equal(byProject.get('prj_1').answer_ref, 'ap_a')
  assert.equal(byProject.get('prj_2').requester, '橙子')
  assert.equal(byProject.get('prj_2').room_id, 'room_2')
})

test('A6/A11: a private-chat card is listed unassigned, read-only, with its Session', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')] })
  const api = apiOf(home, { approvals: () => [liveCard({ sessionId: 'sess_private', answerable: false })] })
  const { body } = await api.todos({})

  assert.equal(body.waiting.length, 1)
  const [row] = body.waiting
  assert.equal(row.project_id, null)
  assert.equal(row.project_name, '私聊')
  assert.equal(row.ready, false)
  assert.equal(row.suspended, false)
  assert.equal(row.reason_code, 'private-chat')
  assert.equal(row.reason, '请在私聊中处理')
  assert.equal(row.answer_ref, null)
  assert.equal(row.session_id, 'sess_private')
  assert.equal(body.counts.waiting_unassigned, 1)
  assert.equal(body.counts.waiting_approvals, 1)
})

test('A2/A3: suspended, cancelled, error and lost cards land in the groups the contract says', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')] })
  const suspended = liveCard({ id: 'ap_live', sessionId: 'sess_1', roomId: 'room_1', answerable: false, callId: 'call_live' })
  writeRecords(home, [
    record('call_live', { project_id: 'prj_1' }),
    record('call_done', { project_id: 'prj_1' }),
    record('call_error', { project_id: 'prj_1' }),
    record('call_offline', { project_id: 'prj_1' }),
    record('call_unbidden', { project_id: 'prj_1' }),
  ])
  writeFacts(home, [
    // A card answered by a person: cancelled at the end of its turn is handled history.
    fact({ type: 'tool/call', call_id: 'call_done', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'approval/asked', call_id: 'call_done', approval_id: 'appr_done', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'approval/decided', approval_id: 'appr_done', outcome: 'cancelled', session_id: 'sess_1' }),
    // An execution failure: never a rejection.
    fact({ type: 'tool/call', call_id: 'call_error', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'tool/result', call_id: 'call_error', is_error: true, text: 'boom', session_id: 'sess_1' }),
    // The host lost the channel, and the card was asked but never answered.
    fact({ type: 'tool/call', call_id: 'call_offline', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'approval/asked', call_id: 'call_offline', approval_id: 'appr_offline', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'approval/decided', approval_id: 'appr_offline', outcome: 'unavailable', session_id: 'sess_1' }),
    fact({ type: 'tool/call', call_id: 'call_unbidden', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'approval/asked', call_id: 'call_unbidden', approval_id: 'appr_unbidden', tool: 'bash', session_id: 'sess_1' }),
  ])
  const api = apiOf(home, { approvals: () => [suspended], sessionBot: () => 'bot_1' })
  const { body } = await api.todos({})

  const states = body.waiting.map(row => row.state).sort()
  // `error` (failed-execution) only exists for a call the host asked a card for; the host
  // projection never yields it with an approval, so a bare execution failure stays out of
  // the view (contract §3.4 line 188) rather than becoming a to-do row that was never asked.
  assert.deepEqual(states, ['pending', 'unavailable', 'unobservable'])
  const pending = body.waiting.find(row => row.state === 'pending')
  assert.equal(pending.ready, false)
  assert.equal(pending.suspended, true)
  assert.equal(pending.reason_code, 'suspended')
  assert.equal(pending.reason, '已挂起 · 等待中')
  const offline = body.waiting.find(row => row.state === 'unavailable')
  assert.equal(offline.reason_code, 'host-offline')
  const lost = body.waiting.find(row => row.state === 'unobservable')
  assert.equal(lost.reason_code, 'host-pending')
  assert.equal(body.handled.length, 1)
  assert.equal(body.handled[0].state, 'cancelled')
  assert.equal(body.handled[0].handled, true)
  assert.notEqual(body.handled[0].handled_at, null)
  assert.equal(body.waiting.some(row => row.state === 'cancelled'), false)
})

test('A2: a card the host settled by a person keeps the human outcome and the reject reason', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')] })
  writeRecords(home, [record('call_yes', { project_id: 'prj_1' }), record('call_no', { project_id: 'prj_1' })])
  writeFacts(home, [
    fact({ type: 'tool/call', call_id: 'call_yes', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'approval/asked', call_id: 'call_yes', approval_id: 'appr_yes', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'approval/decided', approval_id: 'appr_yes', outcome: 'allowed-once', session_id: 'sess_1' }),
    fact({ type: 'tool/result', call_id: 'call_yes', is_error: false, session_id: 'sess_1' }),
    fact({ type: 'tool/call', call_id: 'call_no', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'approval/asked', call_id: 'call_no', approval_id: 'appr_no', tool: 'bash', session_id: 'sess_1' }),
    fact({ type: 'approval/decided', approval_id: 'appr_no', outcome: 'rejected', session_id: 'sess_1' }),
    fact({ type: 'tool/result', call_id: 'call_no', is_error: true, text: 'The user rejected tool "bash"', session_id: 'sess_1' }),
  ])
  const api = apiOf(home, { sessionBot: () => 'bot_1' })
  const { body } = await api.todos({})
  const byState = new Map(body.handled.map(row => [row.state, row]))
  assert.equal(byState.get('approved-human').ready, false)
  assert.equal(byState.get('approved-human').handled, true)
  assert.equal(byState.get('rejected').host_reject_reason, '已拒绝 · 未执行')
  assert.equal(byState.get('rejected').title.startsWith('运行命令'), true)
})

test('A7: titles carry a verb and a redacted object, never a secret or a home path', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')] })
  writeRecords(home, [record('call_secret', {
    project_id: 'prj_1',
    tool: 'curl',
    target: `${home}/deploy?token=SECRET42`,
    predicted_risk_tier: 'medium',
  })])
  const redact = text => text.replaceAll(home, '[home]').replaceAll('SECRET42', '[secret]')
  const api = apiOf(home, { approvals: () => [liveCard({ roomId: 'room_1', callId: 'call_secret' })], redact, sessionBot: () => 'bot_1' })
  const { body } = await api.todos({})
  const row = body.waiting.find(entry => entry.card_kind === 'approval')
  assert.equal(row.title.startsWith('访问网络'), true)
  assert.equal(row.title.includes(home), false)
  assert.equal(row.title.includes('SECRET42'), false)
  assert.equal(row.target.includes('SECRET42'), false)
  assert.equal(row.risk_text, '需要授权')
  assert.equal(row.risk_source, 'predicted')
  assert.deepEqual(
    [row.risk_text, '低风险', '高风险', '风险待核实'].includes(row.risk_text),
    true,
  )
})

test('A8: counts agree with the lists, and the handled window is a window', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')] })
  const records = []
  const facts = []
  for (const index of [1, 2, 3]) {
    records.push(record(`call_${index}`, { project_id: 'prj_1' }))
    const at = new Date(AT - index * MINUTE).toISOString()
    facts.push(fact({ at, type: 'tool/call', call_id: `call_${index}`, tool: 'bash', session_id: 'sess_1' }))
    facts.push(fact({ at, type: 'approval/asked', call_id: `call_${index}`, approval_id: `appr_${index}`, tool: 'bash', session_id: 'sess_1' }))
    facts.push(fact({ at, type: 'approval/decided', approval_id: `appr_${index}`, outcome: 'allowed-once', session_id: 'sess_1' }))
  }
  // A call nobody ever asked a card for: it is not a to-do row at all.
  records.push(record('call_policy', { project_id: 'prj_1' }))
  facts.push(fact({ type: 'tool/call', call_id: 'call_policy', tool: 'bash', session_id: 'sess_1' }))
  facts.push(fact({ type: 'tool/result', call_id: 'call_policy', is_error: false, session_id: 'sess_1' }))
  writeRecords(home, records)
  writeFacts(home, facts)
  const api = apiOf(home, { sessionBot: () => 'bot_1' })

  const { body } = await api.todos({ handled_limit: 2 })
  assert.equal(body.handled.length, 2)
  assert.equal(body.handled_has_more, true)
  assert.equal(body.counts.handled_total, 3)
  assert.equal(body.counts.handled_total_capped, false)
  assert.equal(body.counts.handled_returned, 0)
  assert.equal(body.counts.waiting_total, body.waiting.length)
  assert.equal(body.waiting.length, 0)
  // Newest handled first.
  assert.equal(body.handled[0].id, 'ap_appr_1')
})

test('A13: an owner-only acceptance is listed even when an employee submitted it', async () => {
  const home = await openHome()
  seed(home, {
    projects: [
      project('prj_1', 'Alpha', 'room_1', { acceptance_requirement: 'owner_only' }),
      project('prj_2', 'Beta', 'room_2'),
    ],
    employees: [employee('emp_1', '小蓝', 'bot_1')],
    members: [member('pmm_1', 'prj_1', 'emp_1')],
    acceptances: {
      acc_user: acceptance({ id: 'acc_user', project_id: 'prj_2', acceptance_actor: 'user', state: 'pending' }),
      acc_owner: acceptance({ id: 'acc_owner', project_id: 'prj_1', acceptance_actor: 'emp_1', owner_only: true, state: 'pending' }),
      acc_plain: acceptance({ id: 'acc_plain', project_id: 'prj_2', acceptance_actor: 'emp_1', state: 'pending' }),
      acc_done: acceptance({ id: 'acc_done', project_id: 'prj_2', acceptance_actor: 'user', state: 'accepted', decided_at: AT_ISO }),
    },
  })
  const api = apiOf(home, {})
  const { body } = await api.todos({})

  const ids = body.waiting.map(row => row.id).sort()
  assert.deepEqual(ids, ['ac_acc_owner', 'ac_acc_user'])
  assert.equal(body.counts.waiting_acceptances, 2)
  assert.equal(body.waiting.every(row => row.ready === true), true)
  assert.equal(body.waiting.find(row => row.id === 'ac_acc_owner').owner_only, true)
  assert.equal(body.waiting.find(row => row.id === 'ac_acc_user').owner_only, false)
  assert.equal(body.waiting.every(row => row.risk_text === '待确认'), true)
  assert.equal(body.waiting.every(row => row.risk_source === 'none'), true)
  assert.equal(body.handled.length, 1)
  assert.equal(body.handled[0].state, 'accepted')
  assert.equal(body.handled[0].handled_at, AT_ISO)
})

test('A10: a v1 company is read as v2, revision untouched, upgrade pending once', async () => {
  const home = await openHome()
  const legacy = {
    version: 1,
    revision: 7,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees: {},
    projects: {},
    members: {},
    operation_log: {},
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(legacy))
  const store = storeOf(home)
  assert.equal(store.state.version, 2)
  assert.deepEqual(store.state.acceptances, {})
  assert.deepEqual(store.state.todo_log, {})
  assert.equal(store.state.revision, 7)
  assert.deepEqual(store.migration(), { from: 1, to: 2 })

  const api = apiOf(home, {})
  const result = await api.todos({})
  assert.equal(result.status, 200)
  assert.equal(result.body.company_id, 'cmp_1')

  await store.commit(store.state)
  store.clearMigration()
  assert.equal(store.migration(), undefined)
  const saved = JSON.parse(readFileSync(join(home, 'company', 'state.json'), 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.revision, 7)
  assert.deepEqual(saved.acceptances, {})
  const reopened = storeOf(home)
  assert.equal(reopened.migration(), undefined)
})

test('A10: a writable install saves a v1 file back once, with one migration event', async () => {
  const home = await openHome()
  const legacy = {
    version: 1,
    revision: 7,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees: {},
    projects: {},
    members: {},
    operation_log: {},
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(legacy))
  const rtOf = () => ({
    home,
    warn: () => {},
    ctx: { connection: { fetch: { register: () => () => {} } }, effect: () => {} },
    approvalsView: () => [],
    selfOf: () => undefined,
    roomOf: () => undefined,
    botOf: () => undefined,
    isPrivate: () => false,
    redactSecrets: text => text,
  })
  const rt = rtOf()
  install(rt)
  const stateFile = join(home, 'company', 'state.json')
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && JSON.parse(readFileSync(stateFile, 'utf8')).version !== 2) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(saved.version, 2)
  assert.equal(saved.revision, 7)
  assert.deepEqual(saved.acceptances, {})
  const eventsFile = join(home, 'company', 'events.jsonl')
  const events = readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.type), ['company/migrated'])
  assert.deepEqual(events[0].data, { from: 1, to: 2 })
  rt.company.close()

  // A second start on the now-v2 file has nothing to write back.
  const again = rtOf()
  install(again)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).length, 1)
  again.company.close()
  rmSync(home, { recursive: true, force: true })
})

test('the read refuses what the contract says it refuses', async () => {
  const home = await openHome()
  seed(home, {})
  const api = apiOf(home, {})
  const badWindow = await api.todos({ handled_limit: 0 })
  assert.equal(badWindow.status, 422)
  assert.equal(badWindow.body.code, 'todo/invalid')
  const tooBig = await api.todos({ handled_limit: 201 })
  assert.equal(tooBig.status, 422)
  const missing = await api.todos({ project_id: 'prj_missing' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'project/not-found')
})

test('the channel and the route share one answer', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_1', 'Alpha', 'room_1')], employees: [employee('emp_1', '小蓝', 'bot_1')] })
  const api = apiOf(home, { approvals: () => [liveCard({ roomId: 'room_1' })] })
  const routed = await api.todos({})
  const direct = createTodos({ store: storeOf(home), approvals: () => [liveCard({ roomId: 'room_1' })], sessionBot: () => 'bot_1', home, now: () => AT })
  assert.deepEqual(Object.keys(direct.read({})).sort(), Object.keys(routed.body).sort())
  assert.equal(direct.read({}).counts.waiting_total, routed.body.counts.waiting_total)
})

function acceptance(extra) {
  return {
    id: 'acc_1',
    project_id: 'prj_1',
    task_id: 'tsk_1',
    title: '交付验收',
    submitted_version: 'v1',
    acceptance_criteria: '全部通过',
    acceptance_actor: 'user',
    state: 'pending',
    owner_only: false,
    revision: 3,
    created_at: new Date(AT - 3 * MINUTE).toISOString(),
    decided_at: null,
    opinion: '',
    ...extra,
  }
}

function writeRecords(home, rows) {
  writeJsonl(home, 'selfreview.jsonl', rows)
}

function writeFacts(home, rows) {
  writeJsonl(home, 'selfreview-host.jsonl', rows)
}
