// Usage (M2 batch 3 / G3 3.6): the company counts what its Bots spent out of the host's
// ledger. The ledger knows the Session and the tokens; the company file knows which person
// holds the Bot and which project a Run or a group room belongs to. The tests pin the three
// cuts, the two kinds of unattributed calls, and the rule that a call with no tokens keeps
// its count instead of showing a zero.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCommands } from '../src/host/company/commands.js'
import { createCompanyStore } from '../src/host/company/store.js'
import { usageHandlers } from '../src/host/company/usage.js'

const AT = Date.UTC(2026, 10, 20, 12, 0, 0)
const DAY = 86_400_000
// The host ledger's bucket width (src/host/usage.js). Call rows carry the bucket's start.
const SLOT = 15 * 60_000

const openHome = async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-usage-'))
  mkdirSync(join(home, 'company'), { recursive: true })
  return home
}

const owner = () => ({ id: 'user', kind: 'owner', name: '老板', status: 'active', created_at: 1, updated_at: 1 })

const seed = (home, { employees = {}, projects = {}, runs = {} } = {}) => {
  const state = {
    version: 6,
    revision: 3,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees,
    projects,
    members: {},
    tasks: {},
    runs,
    acceptances: {},
    todo_log: {},
    templates: {},
    operation_log: {},
    actors: { user: owner() },
    grants: {},
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(state))
}

const employee = (id, name, botId) => ({
  id,
  company_id: 'cmp_1',
  bot_id: botId,
  department_id: 'dep_1',
  name,
  role: null,
  acceptance_role: null,
  conversation_mode: 'follow',
  status: 'active',
  project_ids: [],
  project_id: null,
  created_at: 1,
  updated_at: 1,
  revision: 1,
})

const project = (id, name, roomId) => ({ id, name, status: 'active', company_id: 'cmp_1', group_chat_ref: roomId, created_at: 1, revision: 1 })

const slice = (owner, time, { input = 0, cacheRead = 0, cacheWrite = 0, output = 0, calls = 1, session = `session-${owner}` } = {}) => ({ session, owner, time, input, cacheRead, cacheWrite, output, calls })

const executeFor = (home, ledger) => createCommands({
  store: createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT }),
  now: () => AT,
  handlers: usageHandlers({ rt: { usageCalls: async () => ledger } }),
}).execute

const summary = async (home, ledger, payload) => {
  const execute = executeFor(home, ledger)
  const answer = await execute('usage.summary', { operation_key: `k-${Math.random()}`, ...payload })
  return answer.body
}

test('a person row is the Bots Session, and a call with no tokens says so instead of a zero', async () => {
  const home = await openHome()
  seed(home, {
    employees: { emp_1: employee('emp_1', '林小满', 'bot_1'), emp_2: employee('emp_2', '周舟', 'bot_2') },
    projects: { prj_1: project('prj_1', 'Alpha', 'room_1') },
  })
  const ledger = [
    slice('bot_1', AT - 1000, { input: 100, cacheRead: 50, cacheWrite: 10, output: 40, calls: 2 }),
    slice('bot_1', AT - 2000, { input: 10, output: 5 }),
    // No usage chunk came back for these three calls: they happened, and the row says that.
    slice('bot_2', AT - 1000, { calls: 3 }),
    // A project group's calls belong to the project, not to a person.
    slice('room:room_1', AT - 1000, { input: 7 }),
    // Not company work: a Bot outside the roster, and a Session nobody owns.
    slice('bot_9', AT - 1000, { input: 999 }),
    slice('other', AT - 1000, { input: 888 }),
  ]
  const body = await summary(home, ledger, { by: 'person', from: AT - DAY, to: AT, time_zone: 'UTC' })

  assert.equal(body.by, 'person')
  assert.deepEqual(body.rows.map(row => row.name), ['林小满', '周舟'])
  const [first, second] = body.rows
  assert.equal(first.employee_id, 'emp_1')
  assert.equal(first.bot_id, 'bot_1')
  assert.equal(first.calls, 3)
  assert.equal(first.tokens, 215)
  assert.equal(first.counted_only, false)
  assert.equal(second.calls, 3)
  assert.equal(second.tokens, 0)
  assert.equal(second.counted_only, true)
  // The people total is the people, not the company: the group room is named apart.
  assert.equal(body.totals.calls, 6)
  assert.equal(body.totals.tokens, 215)
  assert.equal(body.unattributed.calls, 1)
  assert.equal(body.unattributed.tokens, 7)
  assert.equal(body.unattributed.reason, 'group')
})

test('a project row is the latest Run dispatched to the Bot, and a call before the first Run is not invented into one', async () => {
  const home = await openHome()
  seed(home, {
    employees: { emp_1: employee('emp_1', '林小满', 'bot_1') },
    projects: { prj_1: project('prj_1', 'Alpha', 'room_1'), prj_2: project('prj_2', 'Beta', 'room_2') },
    runs: {
      run_1: { id: 'run_1', project_id: 'prj_1', task_id: 'tsk_1', bot_id: 'bot_1', employee_id: 'emp_1', state: 'dispatched', dispatched_at: AT - 3 * SLOT, session_id: null },
      run_2: { id: 'run_2', project_id: 'prj_2', task_id: 'tsk_2', bot_id: 'bot_1', employee_id: 'emp_1', state: 'dispatched', dispatched_at: AT - SLOT, session_id: null },
    },
  })
  const ledger = [
    // Before the first dispatch: the Bot's own chat, no project to name.
    slice('bot_1', AT - 4 * SLOT, { input: 1 }),
    // The slot a dispatch happens in: the ledger keeps only the slot start, so the dispatch
    // must claim its own slot or a fresh Run would report its work as unattributed.
    slice('bot_1', AT - 3 * SLOT, { input: 2 }),
    // A later slot: still the first Run, since the second has not been dispatched yet.
    slice('bot_1', AT - 2 * SLOT, { input: 3 }),
    // The second dispatch's slot: the second Run, even though the first never ended.
    slice('bot_1', AT - SLOT, { input: 4 }),
    // A group room's calls go to its project with no dispatch involved.
    slice('room:room_2', AT - 2 * SLOT, { input: 8 }),
  ]
  const body = await summary(home, ledger, { by: 'project', from: AT - DAY, to: AT, time_zone: 'UTC' })

  assert.deepEqual(body.rows.map(row => [row.project_id, row.input]), [['prj_2', 12], ['prj_1', 5]])
  assert.equal(body.totals.input, 17)
  assert.equal(body.unattributed.input, 1)
  assert.equal(body.unattributed.reason, 'no-run')
})

test('a time row cuts every company call by day in the caller zone', async () => {
  const home = await openHome()
  seed(home, {
    employees: { emp_1: employee('emp_1', '林小满', 'bot_1') },
    projects: { prj_1: project('prj_1', 'Alpha', 'room_1') },
  })
  const ledger = [
    slice('bot_1', Date.UTC(2026, 10, 19, 10, 0, 0), { input: 3 }),
    slice('bot_1', Date.UTC(2026, 10, 20, 10, 0, 0), { input: 5 }),
    slice('room:room_1', Date.UTC(2026, 10, 20, 11, 0, 0), { input: 7 }),
  ]
  const body = await summary(home, ledger, { by: 'time', from: AT - 7 * DAY, to: AT + DAY, time_zone: 'UTC' })

  assert.deepEqual(body.rows.map(row => [row.day, row.calls, row.tokens]), [
    ['2026-11-19', 1, 3],
    ['2026-11-20', 2, 12],
  ])
  // Time is the one cut that sees every company call, group rooms included.
  assert.equal(body.totals.calls, 3)
  assert.equal(body.totals.tokens, 15)
})

test('the window is the callers to choose, and a bad one is refused', async () => {
  const home = await openHome()
  seed(home, { employees: { emp_1: employee('emp_1', '林小满', 'bot_1') } })
  const ledger = [slice('bot_1', AT - 40 * DAY, { input: 9 }), slice('bot_1', AT - 1000, { input: 1 })]

  const defaults = await summary(home, ledger, { by: 'person' })
  assert.equal(defaults.totals.tokens, 1)
  assert.equal(defaults.to, AT)

  const whole = await summary(home, ledger, { by: 'person', from: AT - 60 * DAY, to: AT })
  assert.equal(whole.totals.tokens, 10)

  const execute = executeFor(home, ledger)
  await assert.rejects(execute('usage.summary', { operation_key: 'k-bad-by', by: 'team' }), error => error.code === 'company/invalid' && error.details.field === 'by')
  await assert.rejects(execute('usage.summary', { operation_key: 'k-bad-tz', time_zone: 'Mars/Olympus' }), error => error.code === 'company/invalid' && error.details.field === 'time_zone')
  await assert.rejects(execute('usage.summary', { operation_key: 'k-bad-window', from: AT, to: AT - 1 }), error => error.code === 'company/invalid' && error.details.field === 'from')
})

test('a host build without the ledger says so instead of reporting zero', async () => {
  const home = await openHome()
  seed(home)
  const execute = createCommands({
    store: createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT }),
    now: () => AT,
    handlers: usageHandlers({ rt: {} }),
  }).execute
  await assert.rejects(execute('usage.summary', { operation_key: 'k-none', by: 'person' }), error => error.code === 'company/unsupported' && error.details.field === 'usage')
})
