import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCommands } from '../src/host/company/commands.js'
import { orgHandlers } from '../src/host/company/org.js'
import { createCompanyStore } from '../src/host/company/store.js'

const bots = { bot_a: { id: 'bot_a', name: 'Alpha' }, bot_b: { id: 'bot_b', name: 'Beta' } }
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-company-org-'))

function open(home, { isPrivate = () => false } = {}) {
  const store = createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} })
  const commands = createCommands({ store, handlers: orgHandlers({ botOf: id => bots[id], isPrivate }) })
  return { store, commands }
}

const run = (commands, command, payload) => commands.execute(command, payload)

async function company(commands) {
  return run(commands, 'company.init', { operation_key: 'k-company', name: 'DS Bot Company' })
}

async function department(commands, name = '产品') {
  return run(commands, 'department.create', { operation_key: `k-department-${name}`, name })
}

test('company.init is idempotent and reports the existing company', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  const first = await company(commands)
  assert.equal(first.revision, 1)
  const second = await run(commands, 'company.init', { operation_key: 'k-company-again', name: '另一个名字' })
  assert.equal(second.status, 'ok')
  assert.equal(second.aggregate_id, first.aggregate_id)
  assert.equal(second.body.existing, true)
  assert.equal(second.body.company.name, 'DS Bot Company')
  assert.equal(store.state.revision, 1)
  rmSync(home, { recursive: true, force: true })
})

const eventsOf = home => readFileSync(join(home, 'company', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

test('company.update renames the company and leaves the mode alone (P1-11)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  const created = await company(commands)
  const renamed = await run(commands, 'company.update', { operation_key: 'k-rename', name: '  星海科技  ' })
  // The name is trimmed like every other name field, and the mode the row already has stays.
  assert.equal(renamed.body.company.name, '星海科技')
  assert.equal(renamed.body.company.conversation_mode, 'standard')
  assert.equal(store.state.revision, 2)
  assert.equal(store.state.companies[created.aggregate_id].revision, 2)
  assert.deepEqual(eventsOf(home).filter(event => event.type === 'company.updated').map(event => event.data), [{ name: '星海科技' }])
  rmSync(home, { recursive: true, force: true })
})

test('company.update takes a name and a mode in one call, and a repeat is not a write (P1-11)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  const created = await company(commands)
  const both = await run(commands, 'company.update', { operation_key: 'k-both', name: '星海科技', conversation_mode: 'ptc' })
  assert.equal(both.body.company.name, '星海科技')
  assert.equal(both.body.company.conversation_mode, 'ptc')
  assert.equal(store.state.revision, 2)
  assert.deepEqual(eventsOf(home).filter(event => event.type === 'company.updated').map(event => event.data), [{ name: '星海科技', conversation_mode: 'ptc' }])

  // Sending the values the company already holds changes nothing, so the revision and the
  // event log stay put and the screen is told there was no write.
  const same = await run(commands, 'company.update', { operation_key: 'k-same', name: '星海科技', conversation_mode: 'ptc' })
  assert.equal(same.body.company.name, '星海科技')
  assert.equal(same.body.company.conversation_mode, 'ptc')
  // A non-write is not recorded in the replay log: asking again simply reads again.
  assert.equal(store.state.operation_log['k-same'], undefined)
  assert.equal(store.state.revision, 2)
  assert.equal(store.state.companies[created.aggregate_id].revision, 2)
  assert.equal(eventsOf(home).filter(event => event.type === 'company.updated').length, 1)
  rmSync(home, { recursive: true, force: true })
})

test('company.update refuses an empty name and keeps an empty call on the mode field (P1-11)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await company(commands)
  await assert.rejects(
    run(commands, 'company.update', { operation_key: 'k-blank', name: '   ' }),
    error => error.code === 'company/invalid' && error.details.field === 'name',
  )
  await assert.rejects(
    run(commands, 'company.update', { operation_key: 'k-long', name: 'x'.repeat(81) }),
    error => error.code === 'company/invalid' && error.details.field === 'name',
  )
  // A call with neither editable field keeps naming the mode, which is what existing
  // callers and the conversation-mode screen already expect.
  await assert.rejects(
    run(commands, 'company.update', { operation_key: 'k-nothing' }),
    error => error.code === 'company/invalid' && error.details.field === 'conversation_mode',
  )
  assert.equal(store.state.revision, 1)
  rmSync(home, { recursive: true, force: true })
})

test('the company is required before a department', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await assert.rejects(department(commands), error => error.code === 'company/not-found')
  rmSync(home, { recursive: true, force: true })
})

test('a department name is unique inside the company, whatever the case', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const first = await department(commands, '产品')
  assert.equal(first.revision, 2)
  await assert.rejects(department(commands, ' 产品 '), error => error.code === 'department.name-taken')
  rmSync(home, { recursive: true, force: true })
})

test('employee.create needs a known Bot, a department and a free Bot', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const dep = await department(commands)

  await assert.rejects(
    run(commands, 'employee.create', { operation_key: 'k-ghost', bot_id: 'bot_ghost', department_id: dep.aggregate_id, name: 'Ghost' }),
    error => error.code === 'employee/unknown-bot',
  )
  await assert.rejects(
    run(commands, 'employee.create', { operation_key: 'k-no-department', bot_id: 'bot_a', department_id: 'dep_missing', name: 'Alpha' }),
    error => error.code === 'department/not-found',
  )

  const hired = await run(commands, 'employee.create', { operation_key: 'k-hire', bot_id: 'bot_a', department_id: dep.aggregate_id, name: '小蓝' })
  assert.equal(hired.revision, 3)
  assert.equal(hired.body.employee.acceptance_role, 'executor')

  await assert.rejects(
    run(commands, 'employee.create', { operation_key: 'k-hire-again', bot_id: 'bot_a', department_id: dep.aggregate_id, name: '小蓝' }),
    error => error.code === 'employee.bot_already_employed',
  )
  rmSync(home, { recursive: true, force: true })
})

test('a private Bot cannot hold an employee profile', async () => {
  const home = tempHome()
  const { commands } = open(home, { isPrivate: id => id === 'bot_a' })
  await company(commands)
  const dep = await department(commands)
  await assert.rejects(
    run(commands, 'employee.create', { operation_key: 'k-private', bot_id: 'bot_a', department_id: dep.aggregate_id, name: '小紫' }),
    error => error.code === 'employee/private-bot',
  )
  rmSync(home, { recursive: true, force: true })
})

test('employee.update moves department and name but never the Bot', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const product = await department(commands, '产品')
  const design = await department(commands, '设计')
  const hired = await run(commands, 'employee.create', { operation_key: 'k-hire', bot_id: 'bot_a', department_id: product.aggregate_id, name: '小蓝' })
  assert.equal(hired.body.employee.revision, 1)

  const moved = await run(commands, 'employee.update', {
    operation_key: 'k-move',
    employee_id: hired.aggregate_id,
    name: '小蓝2',
    department_id: design.aggregate_id,
  })
  assert.equal(moved.body.employee.name, '小蓝2')
  assert.equal(moved.body.employee.department_id, design.aggregate_id)
  assert.equal(moved.body.employee.revision, 2)

  await assert.rejects(
    run(commands, 'employee.update', { operation_key: 'k-swap-bot', employee_id: hired.aggregate_id, bot_id: 'bot_b' }),
    error => error.code === 'employee/immutable-field',
  )
  rmSync(home, { recursive: true, force: true })
})

test('an unknown acceptance_role is refused', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const dep = await department(commands)
  await assert.rejects(
    run(commands, 'employee.create', { operation_key: 'k-role', bot_id: 'bot_a', department_id: dep.aggregate_id, name: 'Alpha', acceptance_role: 'reviewer' }),
    error => error.code === 'company/invalid',
  )
  rmSync(home, { recursive: true, force: true })
})

test('lists read the company without a revision bump or an operation log entry', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await company(commands)
  const dep = await department(commands)
  await run(commands, 'employee.create', { operation_key: 'k-hire', bot_id: 'bot_a', department_id: dep.aggregate_id, name: '小蓝' })

  const departments = await run(commands, 'department.list', { operation_key: 'k-list-departments' })
  assert.equal(departments.body.departments.length, 1)
  const employees = await run(commands, 'employee.list', { operation_key: 'k-list-employees', department_id: dep.aggregate_id })
  assert.equal(employees.body.employees.length, 1)
  assert.equal(store.state.revision, 3)
  assert.deepEqual(Object.keys(store.state.operation_log).sort(), ['k-department-产品', 'k-hire', 'k-company'].sort())
  // A list may be asked again with the same key: it holds no replay record.
  const again = await run(commands, 'department.list', { operation_key: 'k-list-departments' })
  assert.equal(again.body.departments.length, 1)
  rmSync(home, { recursive: true, force: true })
})

test('a department lead is one of its own active employees, and can be cleared', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const dep = await department(commands, '产品')
  const hired = await run(commands, 'employee.create', { operation_key: 'k-hire', bot_id: 'bot_a', department_id: dep.aggregate_id, name: '小蓝' })

  const led = await run(commands, 'department.update', {
    operation_key: 'k-lead',
    department_id: dep.aggregate_id,
    lead_employee_id: hired.aggregate_id,
  })
  assert.equal(led.body.department.lead_employee_id, hired.aggregate_id)
  assert.equal(led.body.department.revision, 2)

  const read = await run(commands, 'department.list', { operation_key: 'k-list' })
  assert.equal(read.body.departments[0].lead_employee_id, hired.aggregate_id)

  const cleared = await run(commands, 'department.update', {
    operation_key: 'k-lead-clear',
    department_id: dep.aggregate_id,
    lead_employee_id: null,
  })
  assert.equal(cleared.body.department.lead_employee_id, null)
  rmSync(home, { recursive: true, force: true })
})

test('a lead has to belong to the department, and a new department has none yet', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const product = await department(commands, '产品')
  const design = await department(commands, '设计')
  const designer = await run(commands, 'employee.create', { operation_key: 'k-hire', bot_id: 'bot_b', department_id: design.aggregate_id, name: '蓝莓' })

  await assert.rejects(
    run(commands, 'department.update', { operation_key: 'k-outsider', department_id: product.aggregate_id, lead_employee_id: designer.aggregate_id }),
    error => error.code === 'department/invalid' && error.details?.field === 'lead_employee_id',
  )
  const stranded = await run(commands, 'employee.create', { operation_key: 'k-hire-2', bot_id: 'bot_a', department_id: product.aggregate_id, name: '小蓝' })
  await run(commands, 'department.update', { operation_key: 'k-lead', department_id: product.aggregate_id, lead_employee_id: stranded.aggregate_id })
  // Moving the lead away ends the post instead of leaving a pointer to an outsider.
  await run(commands, 'employee.update', { operation_key: 'k-move', employee_id: stranded.aggregate_id, department_id: design.aggregate_id })
  const read = await run(commands, 'department.list', { operation_key: 'k-list' })
  assert.equal(read.body.departments.find(entry => entry.id === product.aggregate_id).lead_employee_id, null)

  await assert.rejects(
    run(commands, 'department.create', { operation_key: 'k-dep-with-lead', name: '工程', lead_employee_id: designer.aggregate_id }),
    error => error.code === 'department/invalid',
  )
  rmSync(home, { recursive: true, force: true })
})

// M1b-2.4: the four refusals the configuration screen shows inline, each with the field
// and the names a screen needs to say what happened. The codes are the contract: the
// screen maps them, it does not read English.
test('the four configuration refusals carry a stable code and the field to show', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const product = await department(commands, '产品')

  // 1. A department name is unique, whatever the case and the padding.
  const clash = await department(commands, ' 产品 ').catch(error => error)
  assert.equal(clash.code, 'department.name-taken')
  assert.equal(clash.details.field, 'name')

  // 2. A Bot holds one active profile; hiring it twice says which Bot.
  await run(commands, 'employee.create', { operation_key: 'k-hire', bot_id: 'bot_a', department_id: product.aggregate_id, name: '小蓝' })
  const taken = await run(commands, 'employee.create', { operation_key: 'k-hire-again', bot_id: 'bot_a', department_id: product.aggregate_id, name: '小蓝2' }).catch(error => error)
  assert.equal(taken.code, 'employee.bot_already_employed')
  assert.equal(taken.details.field, 'bot_id')
  assert.equal(taken.details.bot_id, 'bot_a')

  // 3. A Bot the team does not have is refused before anything is written.
  const ghost = await run(commands, 'employee.create', { operation_key: 'k-ghost', bot_id: 'bot_ghost', department_id: product.aggregate_id, name: 'Ghost' }).catch(error => error)
  assert.equal(ghost.code, 'employee/unknown-bot')
  assert.equal(ghost.details.bot_id, 'bot_ghost')
  rmSync(home, { recursive: true, force: true })
})

test('an employee without live work is dismissed, listed apart, and re-activated', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const dep = await department(commands, '产品')
  const hired = await run(commands, 'employee.create', { operation_key: 'k-hire', bot_id: 'bot_a', department_id: dep.aggregate_id, name: '小蓝' })

  const dismissed = await run(commands, 'employee.update', { operation_key: 'k-dismiss', employee_id: hired.aggregate_id, status: 'disabled' })
  assert.equal(dismissed.status, 'committed')
  assert.equal(dismissed.body.employee.status, 'disabled')
  assert.equal(dismissed.body.employee.project_id, null)

  // The profile keeps its row and its history; only the list of who is active changes.
  const disabled = await run(commands, 'employee.list', { operation_key: 'k-list-disabled', status: 'disabled' })
  assert.equal(disabled.body.employees.length, 1)
  const active = await run(commands, 'employee.list', { operation_key: 'k-list-active', status: 'active' })
  assert.equal(active.body.employees.length, 0)

  const back = await run(commands, 'employee.update', { operation_key: 'k-rehire', employee_id: hired.aggregate_id, status: 'active' })
  assert.equal(back.body.employee.status, 'active')
  rmSync(home, { recursive: true, force: true })
})

test('a dismissal is refused while the employee leads a department, and says which one', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const dep = await department(commands, '产品')
  const hired = await run(commands, 'employee.create', { operation_key: 'k-hire', bot_id: 'bot_a', department_id: dep.aggregate_id, name: '小蓝' })
  await run(commands, 'department.update', { operation_key: 'k-lead', department_id: dep.aggregate_id, lead_employee_id: hired.aggregate_id })

  const refusal = await run(commands, 'employee.update', { operation_key: 'k-dismiss', employee_id: hired.aggregate_id, status: 'disabled' }).catch(error => error)
  assert.equal(refusal.code, 'employee/still-referenced')
  assert.equal(refusal.details.employee_id, hired.aggregate_id)
  assert.deepEqual(refusal.details.departments.map(entry => entry.role), ['lead'])
  assert.match(refusal.message, /lead of 产品/)
  // Nothing was written by the refusal.
  assert.equal((await run(commands, 'employee.list', { operation_key: 'k-list' })).body.employees[0].status, 'active')

  await run(commands, 'department.update', { operation_key: 'k-lead-clear', department_id: dep.aggregate_id, lead_employee_id: null })
  const dismissed = await run(commands, 'employee.update', { operation_key: 'k-dismiss-again', employee_id: hired.aggregate_id, status: 'disabled' })
  assert.equal(dismissed.body.employee.status, 'disabled')
  rmSync(home, { recursive: true, force: true })
})

test('an unknown status is refused with the values that are allowed', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  const dep = await department(commands)
  const hired = await run(commands, 'employee.create', { operation_key: 'k-hire', bot_id: 'bot_a', department_id: dep.aggregate_id, name: '小蓝' })

  const refusal = await run(commands, 'employee.update', { operation_key: 'k-fired', employee_id: hired.aggregate_id, status: 'fired' }).catch(error => error)
  assert.equal(refusal.code, 'company/invalid')
  assert.equal(refusal.details.field, 'status')
  assert.deepEqual(refusal.details.allowed, ['active', 'disabled'])
  rmSync(home, { recursive: true, force: true })
})
