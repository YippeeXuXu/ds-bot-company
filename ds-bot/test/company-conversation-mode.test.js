import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCommands } from '../src/host/company/commands.js'
import { COMPANY_MODES, EMPLOYEE_MODES, orgHandlers } from '../src/host/company/org.js'
import { createCompanyStore } from '../src/host/company/store.js'

// M1b-2.5: the company's conversation default and each employee's choice of mode. The
// command keeps the vocabulary and the defaults; the Session side reads them at creation
// (agent-preset.test.js), because a started Session cannot change preset.

const bots = { bot_a: { id: 'bot_a', name: 'Alpha' }, bot_b: { id: 'bot_b', name: 'Beta' }, bot_c: { id: 'bot_c', name: 'Gamma' } }
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-company-mode-'))

function open(home) {
  const store = createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} })
  const commands = createCommands({ store, handlers: orgHandlers({ botOf: id => bots[id], isPrivate: () => false }) })
  return { store, commands }
}

const run = (commands, command, payload) => commands.execute(command, payload)

async function company(commands) {
  return (await run(commands, 'company.init', { operation_key: 'k-company', name: 'DS Bot Company' })).body.company
}

async function department(commands) {
  return (await run(commands, 'department.create', { operation_key: 'k-department', name: '产品' })).body.department
}

async function employee(commands, departmentId, botId = 'bot_a', extra = {}) {
  return run(commands, 'employee.create', { operation_key: `k-employee-${botId}`, bot_id: botId, department_id: departmentId, name: 'Alpha', ...extra })
}

test('a company starts on standard and company.update moves it (M1b-2.5)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  const created = await company(commands)
  assert.equal(created.conversation_mode, 'standard')
  assert.deepEqual(COMPANY_MODES, ['standard', 'ptc'])

  const moved = await run(commands, 'company.update', { operation_key: 'k-mode-ptc', conversation_mode: 'ptc' })
  assert.equal(moved.body.company.conversation_mode, 'ptc')
  assert.equal(store.state.companies[created.id].conversation_mode, 'ptc')
  assert.equal(store.state.revision, 2)
  assert.notEqual(moved.revision, 1)

  // Asking for the value the company already holds is not a write.
  const same = await run(commands, 'company.update', { operation_key: 'k-mode-same', conversation_mode: 'ptc' })
  assert.equal(same.body.company.conversation_mode, 'ptc')
  assert.equal(store.state.revision, 2)
  rmSync(home, { recursive: true, force: true })
})

test('company.update refuses a mode outside the vocabulary and an empty call (M1b-2.5)', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  await assert.rejects(
    run(commands, 'company.update', { operation_key: 'k-mode-bad', conversation_mode: 'turbo' }),
    error => error.code === 'company/invalid' && error.details.field === 'conversation_mode',
  )
  await assert.rejects(
    run(commands, 'company.update', { operation_key: 'k-mode-empty' }),
    error => error.code === 'company/invalid' && error.details.field === 'conversation_mode',
  )
  rmSync(home, { recursive: true, force: true })
})

test('an employee starts on follow and may pin a mode (M1b-2.5)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await company(commands)
  const departmentRow = await department(commands)

  const hired = await employee(commands, departmentRow.id)
  assert.equal(hired.body.employee.conversation_mode, 'follow')
  assert.deepEqual(EMPLOYEE_MODES, ['follow', 'standard', 'ptc'])

  const updated = await run(commands, 'employee.update', { operation_key: 'k-employee-mode', employee_id: hired.body.employee.id, conversation_mode: 'ptc' })
  assert.equal(updated.body.employee.conversation_mode, 'ptc')
  assert.equal(store.state.employees[hired.body.employee.id].conversation_mode, 'ptc')

  // A profile may be hired already pinned, so a screen can set both in one call.
  const pinned = await employee(commands, departmentRow.id, 'bot_b', { conversation_mode: 'standard' })
  assert.equal(pinned.body.employee.conversation_mode, 'standard')

  await assert.rejects(
    run(commands, 'employee.update', { operation_key: 'k-employee-mode-bad', employee_id: hired.body.employee.id, conversation_mode: 'turbo' }),
    error => error.code === 'company/invalid' && error.details.field === 'conversation_mode',
  )
  await assert.rejects(
    run(commands, 'employee.create', { operation_key: 'k-employee-bad', bot_id: 'bot_c', department_id: departmentRow.id, name: 'Beta', conversation_mode: 'turbo' }),
    error => error.code === 'company/invalid',
  )
  rmSync(home, { recursive: true, force: true })
})

test('the company mode is stored with the company, not with a Session (M1b-2.5)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await company(commands)
  await run(commands, 'company.update', { operation_key: 'k-mode-ptc', conversation_mode: 'ptc' })
  // Reopening the store reads the same value back: it is a company field, so a restart
  // keeps it, while Sessions already made still hold the preset they were made with.
  const reopened = createCommands({ store: createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} }), handlers: orgHandlers({ botOf: id => bots[id] }) })
  const model = reopened.execute
  const answer = await model('company.get', { operation_key: 'k-get' })
  assert.equal(answer.body.company.conversation_mode, 'ptc')
  assert.equal(store.state.revision, 2)
  rmSync(home, { recursive: true, force: true })
})
