// People (v6) can accept a project's and a card's work (3.4). The owner is read from the
// actor row instead of the literal `'user'`, so a named person is carried by id; owner_only
// stays with the owner, and a disabled person is refused where they are named instead of
// when the delivery arrives.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ROW_REVISION_COMMANDS, acceptanceHandlers } from '../src/host/company/acceptances.js'
import { createCommands } from '../src/host/company/commands.js'
import { projectHandlers } from '../src/host/company/projects.js'
import { createCompanyStore } from '../src/host/company/store.js'
import { TASK_ROW_REVISION_COMMANDS, taskHandlers } from '../src/host/company/tasks.js'

const AT = 1_700_000_000_000

const openHome = async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-people-acceptors-'))
  mkdirSync(join(home, 'company'), { recursive: true })
  return home
}

const owner = () => ({ id: 'user', kind: 'owner', name: '老板', status: 'active', created_at: 1, updated_at: 1 })
const person = (id, name, extra = {}) => ({ id, kind: 'human', name, status: 'active', created_at: 1, updated_at: 1, ...extra })
const employee = (id, name, botId, extra = {}) => ({ id, name, bot_id: botId, status: 'active', role: 'member', company_id: 'cmp_1', created_at: 1, ...extra })

const project = (id, extra = {}) => ({
  id,
  name: `Project ${id}`,
  status: 'active',
  company_id: 'cmp_1',
  group_chat_ref: 'room_1',
  coordinator_assignment_id: null,
  workspace_ref: 'scope_alpha',
  acceptance_actor: 'emp_acceptor',
  acceptance_requirement: 'daily_independent_bot',
  created_at: 1,
  updated_at: 1,
  revision: 1,
  ...extra,
})

const member = (id, projectId, employeeId, extra = {}) => ({ id, project_id: projectId, employee_id: employeeId, role: 'executor', membership_status: 'active', joined_at: 1, ...extra })

const seed = (home, { projects = [project('prj_1')], actors = [] } = {}) => {
  const state = {
    version: 6,
    revision: 4,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees: { emp_acceptor: employee('emp_acceptor', '白菜', 'bot_cabbage') },
    projects: Object.fromEntries(projects.map(entry => [entry.id, entry])),
    members: { mem_acceptor: member('mem_acceptor', 'prj_1', 'emp_acceptor') },
    operation_log: {},
    acceptances: {},
    todo_log: {},
    templates: {},
    tasks: {},
    runs: {},
    actors: Object.fromEntries([owner(), ...actors].map(entry => [entry.id, entry])),
    grants: {},
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(state))
  return state
}

const handlersOf = () => ({ ...projectHandlers({}), ...taskHandlers(), ...acceptanceHandlers() })
const storeOf = (home) => createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT })
const commandsFor = (home) => createCommands({
  store: storeOf(home),
  now: () => AT,
  handlers: handlersOf(),
  rowRevisionCommands: new Set([...TASK_ROW_REVISION_COMMANDS, ...ROW_REVISION_COMMANDS]),
}).execute
const stateOf = (home) => JSON.parse(readFileSync(join(home, 'company', 'state.json'), 'utf8'))
// Every write carries its own operation key; the envelope refuses a write that does not.
const op = (() => { let n = 0; return () => `op_${++n}` })()

const failure = async (promise, code) => {
  try {
    await promise
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return error
  }
  assert.fail(`expected the command to fail with ${code}`)
}

test('a project can name a person to accept its work, and a card inherits that person', async () => {
  const home = await openHome()
  seed(home, { actors: [person('hum_1', '林小满')] })
  const run = commandsFor(home)

  await run('project.update', { project_id: 'prj_1', acceptance_actor: 'hum_1', operation_key: op() })
  assert.equal(stateOf(home).projects.prj_1.acceptance_actor, 'hum_1')

  const created = await run('task.create', { project_id: 'prj_1', title: '写一版首页', source_ref: 'room_1#m1', operation_key: op() })
  const task = created.body.task
  assert.equal(task.acceptance_actor, 'hum_1', 'the card inherits the person, not the employee it replaced')
})

test('owner only work still belongs to the owner, not to a person', async () => {
  const home = await openHome()
  seed(home, { projects: [project('prj_2', { acceptance_actor: 'user', acceptance_requirement: 'owner_only' })], actors: [person('hum_1', '林小满')] })
  const run = commandsFor(home)

  await failure(run('project.update', { project_id: 'prj_2', acceptance_actor: 'hum_1', operation_key: op() }), 'project/owner-required')
  assert.equal(stateOf(home).projects.prj_2.acceptance_actor, 'user', 'a refused request writes nothing')
})

test('a disabled person cannot be named as the acceptor', async () => {
  const home = await openHome()
  seed(home, { actors: [person('hum_off', '停用的人', { status: 'disabled' })] })
  const run = commandsFor(home)

  await failure(run('project.update', { project_id: 'prj_1', acceptance_actor: 'hum_off', operation_key: op() }), 'actor/inactive')
  await failure(run('task.create', { project_id: 'prj_1', title: '写一版首页', source_ref: 'room_1#m1', acceptance_actor: 'hum_off', operation_key: op() }), 'actor/inactive')
  assert.equal(stateOf(home).projects.prj_1.acceptance_actor, 'emp_acceptor')
})
