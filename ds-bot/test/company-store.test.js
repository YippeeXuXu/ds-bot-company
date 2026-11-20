import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCommands } from '../src/host/company/commands.js'
import { orgHandlers } from '../src/host/company/org.js'
import { COMPANY_VERSION, createCompanyStore } from '../src/host/company/store.js'

const bots = { bot_a: { id: 'bot_a', name: 'Alpha' }, bot_b: { id: 'bot_b', name: 'Beta' } }
const botOf = id => bots[id]

const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-company-'))
const companyDir = home => join(home, 'company')
const statePath = home => join(companyDir(home), 'state.json')
const eventsPath = home => join(companyDir(home), 'events.jsonl')

function open(home, { useLock = false, isPrivate = () => false } = {}) {
  const store = createCompanyStore({ dir: companyDir(home), useLock, warn: () => {} })
  const commands = createCommands({ store, handlers: orgHandlers({ botOf, isPrivate }) })
  return { store, commands }
}

const run = (commands, command, payload) => commands.execute(command, payload)

// The M1a chain every later command builds on.
async function seed(commands) {
  const company = await run(commands, 'company.init', { operation_key: 'seed-company', name: 'DS Bot Company' })
  const department = await run(commands, 'department.create', { operation_key: 'seed-department', expected_revision: company.revision, name: '产品' })
  const employee = await run(commands, 'employee.create', {
    operation_key: 'seed-employee',
    expected_revision: department.revision,
    bot_id: 'bot_a',
    department_id: department.aggregate_id,
    name: '小蓝',
  })
  return { company, department, employee }
}

test('the company, a department and an employee commit in one revision line', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  const { company, department, employee } = await seed(commands)
  assert.equal(company.status, 'committed')
  assert.equal(company.revision, 1)
  assert.equal(department.revision, 2)
  assert.equal(employee.revision, 3)
  assert.equal(store.state.revision, 3)
  assert.equal(store.state.companies[company.aggregate_id].name, 'DS Bot Company')
  assert.equal(store.state.employees[employee.aggregate_id].department_id, department.aggregate_id)

  const list = await run(commands, 'employee.list', { operation_key: 'read-employees' })
  assert.equal(list.status, 'ok')
  assert.equal(list.revision, 3)
  assert.equal(list.body.employees.length, 1)
  rmSync(home, { recursive: true, force: true })
})

test('the saved file is written whole and no temp file stays behind', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await seed(commands)
  const saved = JSON.parse(readFileSync(statePath(home), 'utf8'))
  assert.equal(saved.revision, 3)
  assert.equal(Object.keys(saved.employees).length, 1)
  const names = readdirSync(companyDir(home))
  assert.deepEqual(names.filter(name => name.endsWith('.tmp')), [])
  assert.ok(names.includes('state.json'))
  assert.ok(names.includes('events.jsonl'))
  rmSync(home, { recursive: true, force: true })
})

test('a replay of the same operation_key returns the first result', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await seed(commands)
  const first = await run(commands, 'department.create', { operation_key: 'again', name: '设计' })
  const again = await run(commands, 'department.create', { operation_key: 'again', name: '设计' })
  assert.equal(again.replayed, true)
  assert.equal(again.revision, first.revision)
  assert.equal(again.aggregate_id, first.aggregate_id)
  assert.equal(store.state.revision, 4)
  rmSync(home, { recursive: true, force: true })
})

test('a reused operation_key with other content is a conflict', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await seed(commands)
  await run(commands, 'department.create', { operation_key: 'again', name: '设计' })
  await assert.rejects(
    run(commands, 'department.create', { operation_key: 'again', name: '别的' }),
    error => error.code === 'company/idempotency-conflict',
  )
  rmSync(home, { recursive: true, force: true })
})

test('two commands that arrive together with one operation_key commit once', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await seed(commands)
  const results = await Promise.all([
    run(commands, 'department.create', { operation_key: 'parallel', name: '设计' }),
    run(commands, 'department.create', { operation_key: 'parallel', name: '设计' }),
  ])
  assert.equal(store.state.revision, 4)
  assert.equal(Object.keys(store.state.departments).length, 2)
  assert.equal(results.filter(result => result.replayed === true).length, 1)
  assert.equal(results[0].aggregate_id, results[1].aggregate_id)
  // One event line per commit: the loser must not append its own.
  assert.equal(readFileSync(eventsPath(home), 'utf8').trim().split('\n').length, 4)
  rmSync(home, { recursive: true, force: true })
})

test('two commands on the same expected_revision: one commits, one conflicts', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await seed(commands)
  const outcomes = await Promise.allSettled([
    run(commands, 'department.create', { operation_key: 'race-a', expected_revision: 3, name: '设计' }),
    run(commands, 'department.create', { operation_key: 'race-b', expected_revision: 3, name: '运营' }),
  ])
  const committed = outcomes.filter(outcome => outcome.status === 'fulfilled')
  const refused = outcomes.filter(outcome => outcome.status === 'rejected')
  assert.equal(committed.length, 1)
  assert.equal(refused.length, 1)
  assert.equal(refused[0].reason.code, 'company/revision-conflict')
  assert.equal(store.state.revision, 4)
  assert.equal(Object.keys(store.state.departments).length, 2)
  rmSync(home, { recursive: true, force: true })
})

test('a stale expected_revision is refused', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await seed(commands)
  await assert.rejects(
    run(commands, 'department.create', { operation_key: 'stale', expected_revision: 1, name: '设计' }),
    error => error.code === 'company/revision-conflict',
  )
  assert.equal(store.state.revision, 3)
  rmSync(home, { recursive: true, force: true })
})

test('restarting reads the same company and rebuilds the Bot index', async () => {
  const home = tempHome()
  const first = open(home)
  const { employee } = await seed(first.commands)
  first.store.close()

  const second = open(home)
  assert.equal(second.store.state.revision, 3)
  assert.equal(second.store.byBotId().get('bot_a'), employee.aggregate_id)
  const list = await run(second.commands, 'employee.list', { operation_key: 'read-after-restart' })
  assert.equal(list.body.employees.length, 1)
  // The operation log survives too, so a retry after a restart stays a replay.
  const replay = await run(second.commands, 'company.init', { operation_key: 'seed-company', name: 'DS Bot Company' })
  assert.equal(replay.replayed, true)
  second.store.close()
  rmSync(home, { recursive: true, force: true })
})

test('two active employees on one Bot make the file corrupt and the store read-only', async () => {
  const home = tempHome()
  const first = open(home)
  const { employee } = await seed(first.commands)
  first.store.close()
  const saved = JSON.parse(readFileSync(statePath(home), 'utf8'))
  const profile = saved.employees[employee.aggregate_id]
  saved.employees.emp_duplicate = { ...profile, id: 'emp_duplicate' }
  writeFileSync(statePath(home), JSON.stringify(saved))

  const second = open(home)
  assert.match(second.store.readOnly(), /two active employees share Bot bot_a/)
  assert.throws(() => second.store.assertWritable(), error => error.code === 'company.state.corrupt')
  await assert.rejects(
    run(second.commands, 'department.create', { operation_key: 'blocked', name: '设计' }),
    error => error.code === 'company.state.corrupt',
  )
  // The file is left exactly as it was: a read-only store never rewrites it.
  assert.equal(JSON.parse(readFileSync(statePath(home), 'utf8')).employees.emp_duplicate.id, 'emp_duplicate')
  rmSync(home, { recursive: true, force: true })
})

test('an unreadable file puts the store in read-only mode and is left alone', async () => {
  const home = tempHome()
  mkdirSync(companyDir(home), { recursive: true })
  writeFileSync(statePath(home), '{ not json')
  const { store, commands } = open(home)
  assert.match(store.readOnly(), /invalid JSON/)
  await assert.rejects(
    run(commands, 'company.init', { operation_key: 'blocked', name: 'DS Bot Company' }),
    error => error.code === 'company.state.corrupt',
  )
  assert.equal(readFileSync(statePath(home), 'utf8'), '{ not json')
  rmSync(home, { recursive: true, force: true })
})

test('a file from a newer plugin version counts as corrupt', async () => {
  const home = tempHome()
  mkdirSync(companyDir(home), { recursive: true })
  writeFileSync(statePath(home), JSON.stringify({ version: 99, revision: 4 }))
  const { store } = open(home)
  assert.match(store.readOnly(), /version 99 is not 6/)
  rmSync(home, { recursive: true, force: true })
})

test('events.jsonl grows with each commit and the revision only goes up', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await seed(commands)
  await run(commands, 'employee.update', { operation_key: 'rename', employee_id: (await run(commands, 'employee.list', { operation_key: 'find' })).body.employees[0].id, name: '小蓝2' })
  const events = readFileSync(eventsPath(home), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(events.length, 4)
  assert.deepEqual(events.map(event => event.type), ['company.created', 'department.created', 'employee.created', 'employee.updated'])
  const cursors = events.map(event => event.cursor)
  assert.deepEqual(cursors, [...cursors].sort((left, right) => left - right))
  assert.equal(new Set(cursors).size, 4)
  assert.equal(events.at(-1).cursor, 4)
  rmSync(home, { recursive: true, force: true })
})

test('another process holding the lock makes this store read-only', async () => {
  const home = tempHome()
  const { commands, store } = open(home, { useLock: true })
  await seed(commands)
  store.close()
  // A live holder on another host: the host check is skipped, so only the fresh
  // heartbeat keeps it live. Pid liveness differs by platform (pid 1 is alive on Linux,
  // not on Windows), and this claim must read the same on every runner.
  mkdirSync(companyDir(home), { recursive: true })
  writeFileSync(join(companyDir(home), 'state.lock'), JSON.stringify({ pid: 1, host: 'another-host', token: 'other', since: Date.now() }))
  const again = open(home, { useLock: true })
  assert.match(again.store.readOnly(), /open in another dsh/)
  await assert.rejects(
    run(again.commands, 'department.create', { operation_key: 'blocked', name: '设计' }),
    error => error.code === 'company/read-only',
  )
  rmSync(home, { recursive: true, force: true })
})

test('an unknown command and a missing operation_key are refused', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await assert.rejects(run(commands, 'company.explode', { operation_key: 'k' }), error => error.code === 'company/unknown-command')
  await assert.rejects(run(commands, 'company.init', { name: 'No Key' }), error => error.code === 'company/invalid')
  rmSync(home, { recursive: true, force: true })
})

test('a new company carries the owner actor and no grants (v6)', async () => {
  const home = tempHome()
  const { store } = open(home)
  const owner = store.state.actors.user
  assert.equal(owner.id, 'user')
  assert.equal(owner.kind, 'owner')
  assert.equal(owner.name, '老板')
  assert.equal(owner.status, 'active')
  assert.equal(typeof owner.created_at, 'number')
  assert.deepEqual(store.state.grants, {})
  rmSync(home, { recursive: true, force: true })
})

test('a v5 file upgrades to v6 and the owner keeps the id the old fields used (v6)', async () => {
  const home = tempHome()
  const legacy = {
    version: 5,
    revision: 2,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees: {},
    projects: {},
    members: {},
    operation_log: {},
    acceptances: {},
    todo_log: {},
    templates: {},
    tasks: {},
    runs: {},
  }
  mkdirSync(companyDir(home), { recursive: true })
  writeFileSync(statePath(home), JSON.stringify(legacy))
  const first = open(home)
  assert.equal(first.store.state.version, COMPANY_VERSION)
  assert.deepEqual(first.store.migration(), { from: 5, to: COMPANY_VERSION })
  assert.equal(first.store.state.actors.user.kind, 'owner')
  // Reading never rewrites the file; the upgrade lands with the next commit.
  assert.equal(JSON.parse(readFileSync(statePath(home), 'utf8')).version, 5)
  const department = await run(first.commands, 'department.create', { operation_key: 'dep', expected_revision: 2, name: '产品' })
  assert.equal(department.status, 'committed')
  const saved = JSON.parse(readFileSync(statePath(home), 'utf8'))
  assert.equal(saved.version, COMPANY_VERSION)
  assert.equal(saved.actors.user.kind, 'owner')
  assert.deepEqual(saved.grants, {})
  first.store.clearMigration()
  const second = open(home)
  assert.equal(second.store.migration(), undefined)
  assert.equal(second.store.state.actors.user.id, 'user')
  rmSync(home, { recursive: true, force: true })
})

test('a stored owner row is kept as it is, including a changed name or status (v6)', async () => {
  const home = tempHome()
  mkdirSync(companyDir(home), { recursive: true })
  writeFileSync(statePath(home), JSON.stringify({
    version: 6,
    revision: 1,
    companies: {},
    departments: {},
    employees: {},
    projects: {},
    members: {},
    operation_log: {},
    acceptances: {},
    todo_log: {},
    templates: {},
    tasks: {},
    runs: {},
    actors: { user: { id: 'user', kind: 'owner', name: '本人', status: 'disabled', created_at: 3, updated_at: 4 } },
    grants: {},
  }))
  const { store } = open(home)
  assert.equal(store.state.actors.user.name, '本人')
  assert.equal(store.state.actors.user.status, 'disabled')
  assert.equal(store.state.actors.user.created_at, 3)
  rmSync(home, { recursive: true, force: true })
})

test('an actors table of the wrong shape counts as corrupt (v6)', async () => {
  const home = tempHome()
  mkdirSync(companyDir(home), { recursive: true })
  writeFileSync(statePath(home), JSON.stringify({ version: 6, revision: 1, actors: [] }))
  const { store } = open(home)
  assert.match(store.readOnly(), /actors is not a table/)
  rmSync(home, { recursive: true, force: true })
})
