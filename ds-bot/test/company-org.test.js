import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
