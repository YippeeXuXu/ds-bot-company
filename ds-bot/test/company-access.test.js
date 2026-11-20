import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PERMISSIONS, assertAccess, can, permissionsFor, permissionsOf } from '../src/host/company/access.js'
import { acceptanceHandlers } from '../src/host/company/acceptances.js'
import { orgHandlers } from '../src/host/company/org.js'
import { projectHandlers } from '../src/host/company/projects.js'
import { runHandlers } from '../src/host/company/runs.js'
import { spawnHandlers } from '../src/host/company/spawn.js'
import { taskHandlers } from '../src/host/company/tasks.js'
import { templateIoHandlers } from '../src/host/company/template-io.js'
import { templateHandlers } from '../src/host/company/templates.js'

// The registry, built the way `company/index.js` builds it: the same factories, no runtime.
// A command registered by a new module is picked up here the moment the module is added to
// that wiring, so the map test below fails before the command can be used unmapped.
const registered = () => Object.keys({
  ...orgHandlers(),
  ...projectHandlers(),
  ...acceptanceHandlers(),
  ...taskHandlers(),
  ...runHandlers(),
  ...templateHandlers(),
  ...spawnHandlers(),
  ...templateIoHandlers(),
})

const owner = { id: 'user', kind: 'owner', status: 'active' }
const human = extra => ({ id: 'hum_1', kind: 'human', status: 'active', name: '小周', ...extra })
const grant = (id, actor_id, scope_type, scope_id, permissions) => ({ id, actor_id, scope_type, scope_id, permissions })
const grantsOf = (...rows) => Object.fromEntries(rows.map(row => [row.id, row]))

test('every registered company command is mapped, and the map claims nothing else', () => {
  const commands = registered()
  assert.ok(commands.length >= 41, `expected the full registry, got ${commands.length}`)
  for (const command of commands) {
    assert.notEqual(permissionsFor(command), undefined, `${command} is registered but not mapped in access.js`)
  }
  // A stale line would look like a permission nobody enforces; the two sides move together.
  const stale = ['company.init', 'acceptance.list', 'task.dispatch'].filter(command => !commands.includes(command))
  assert.deepEqual(stale, [])
  assert.equal(typeof permissionsFor('task.dispatch'), 'object')
  assert.deepEqual(PERMISSIONS, ['view', 'dispatch', 'accept', 'configure', 'members'])
})

test('the owner runs everything; a human starts with the read surface only', () => {
  assert.equal(can('company.init', { actor: owner }), true)
  assert.equal(can('task.dispatch', { actor: owner }), true)
  // A command with no line in the map is closed to everyone else, owner included in the
  // registry walk above; the owner answer stays open so `company.init` can boot the file.
  assert.equal(can('task.list', { actor: human(), grants: grantsOf() }), true)
  assert.equal(can('acceptance.list', { actor: human(), grants: grantsOf() }), true)
  assert.equal(can('task.dispatch', { actor: human(), grants: grantsOf() }), false)
  assert.equal(can('acceptance.decide', { actor: human(), grants: grantsOf() }), false)
})

test('a project grant is spent inside that project and nowhere else', () => {
  const grants = grantsOf(grant('g1', 'hum_1', 'project', 'prj_1', ['dispatch', 'accept']))
  assert.equal(can('task.dispatch', { actor: human(), grants, projectId: 'prj_1' }), true)
  assert.equal(can('acceptance.decide', { actor: human(), grants, projectId: 'prj_1' }), true)
  // The same person in the other project is back to reading only.
  assert.equal(can('task.dispatch', { actor: human(), grants, projectId: 'prj_2' }), false)
  assert.equal(can('acceptance.decide', { actor: human(), grants, projectId: 'prj_2' }), false)
})

test('a company grant covers every project, and the payload names the project', () => {
  const grants = grantsOf(grant('g1', 'hum_1', 'company', 'user', ['configure']))
  assert.equal(can('project.update', { actor: human(), grants, payload: { project_id: 'prj_9' } }), true)
  assert.deepEqual([...permissionsOf(human(), grants, 'prj_9')].sort(), ['configure', 'view'])
})

test('a command that needs two permissions needs both', () => {
  const onlyConfigure = grantsOf(grant('g1', 'hum_1', 'company', 'user', ['configure']))
  const both = grantsOf(
    grant('g1', 'hum_1', 'company', 'user', ['configure']),
    grant('g2', 'hum_1', 'company', 'user', ['members']),
  )
  assert.equal(permissionsFor('employee.create').length, 2)
  assert.equal(can('employee.create', { actor: human(), grants: onlyConfigure }), false)
  assert.equal(can('employee.create', { actor: human(), grants: both }), true)
})

test('a stopped person loses even the read surface; an empty grant list grants nothing more', () => {
  assert.equal(can('task.list', { actor: human({ status: 'disabled' }) }), false)
  assert.equal(can('task.dispatch', { actor: human({ status: 'disabled' }), grants: grantsOf(grant('g1', 'hum_1', 'company', 'user', ['dispatch'])) }), false)
  // Someone else's grant is not read as this person's.
  const other = grantsOf(grant('g1', 'hum_2', 'company', 'user', ['dispatch']))
  assert.equal(can('task.dispatch', { actor: human(), grants: other }), false)
})

test('the assertion throws the 403 code with the missing permissions, not the payload', () => {
  let error
  try {
    assertAccess('task.dispatch', { actor: human(), grants: grantsOf(), payload: { project_id: 'prj_1', note: 'secret' } })
  } catch (thrown) {
    error = thrown
  }
  assert.equal(error?.code, 'company/forbidden')
  assert.equal(error?.details.command, 'task.dispatch')
  assert.equal(error?.details.actor_id, 'hum_1')
  assert.deepEqual(error?.details.missing, ['dispatch'])
  assert.equal(JSON.stringify(error.details).includes('secret'), false)
  // An allowed call returns without throwing.
  assert.equal(assertAccess('task.list', { actor: human(), grants: grantsOf() }), undefined)
})
