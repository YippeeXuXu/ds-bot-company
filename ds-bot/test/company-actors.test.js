// People and their grants (M2 batch 3 / G3 3.5): inviting a person writes an actor row of
// kind human, disabling one keeps the row and its grants, and every permission a person
// holds comes from a grant that names one scope. The owner is never managed here — the row
// is written once by the store and cannot be renamed, disabled or granted.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ACTOR_ROW_REVISION_COMMANDS, actorHandlers } from '../src/host/company/actors.js'
import { createCommands } from '../src/host/company/commands.js'
import { createCompanyStore } from '../src/host/company/store.js'

const AT = 1_700_000_000_000

const openHome = async () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-actors-'))
  mkdirSync(join(home, 'company'), { recursive: true })
  return home
}

// The owner row is written once by the store and carries no revision: nothing can edit it.
const owner = () => ({ id: 'user', kind: 'owner', name: '老板', status: 'active', created_at: 1, updated_at: 1 })
const person = (id, name, extra = {}) => ({ id, kind: 'human', name, status: 'active', created_at: 1, updated_at: 1, revision: 1, ...extra })

const seed = (home, { actors = [], grants = {}, projects = {} } = {}) => {
  const state = {
    version: 6,
    revision: 4,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 } },
    departments: {},
    employees: {},
    projects: {
      prj_1: { id: 'prj_1', name: 'Alpha', status: 'active', company_id: 'cmp_1', group_chat_ref: 'room_1', created_at: 1, revision: 1 },
      ...projects,
    },
    members: {},
    tasks: {},
    runs: {},
    acceptances: {},
    todo_log: {},
    templates: {},
    operation_log: {},
    actors: Object.fromEntries([owner(), ...actors].map(entry => [entry.id, entry])),
    grants,
  }
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify(state))
  return state
}

const handlersOf = () => ({ ...actorHandlers() })
const storeOf = (home) => createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {}, now: () => AT })
const commandsFor = (home) => createCommands({
  store: storeOf(home),
  now: () => AT,
  handlers: handlersOf(),
  rowRevisionCommands: new Set(ACTOR_ROW_REVISION_COMMANDS),
}).execute
const stateOf = (home) => JSON.parse(readFileSync(join(home, 'company', 'state.json'), 'utf8'))

let ops = 0
const op = () => `op_${++ops}`

const failure = async (promise, code) => {
  try {
    await promise
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return error
  }
  assert.fail(`expected the command to fail with ${code}`)
}

const OWNER = { id: 'user', kind: 'owner', status: 'active', name: '老板' }
const HUMAN = { id: 'hum_1', kind: 'human', status: 'active', name: '林小满' }

test('inviting a person writes one active actor row and lists it after the owner', async () => {
  const home = await openHome()
  seed(home)
  const run = commandsFor(home)

  const invited = await run('actor.invite', { name: '林小满', operation_key: op() }, { actor: OWNER })
  const actor = invited.body.actor
  assert.equal(actor.kind, 'human')
  assert.equal(actor.status, 'active')
  assert.equal(actor.revision, 1)
  assert.deepEqual(actor.grants, [])
  assert.equal(invited.status, 'committed')

  const listed = await run('actor.list', { operation_key: op() }, { actor: OWNER })
  assert.deepEqual(listed.body.actors.map(entry => [entry.id, entry.kind]), [['user', 'owner'], [actor.id, 'human']])
  assert.equal(stateOf(home).actors[actor.id].name, '林小满')

  // The owner row carries no revision (nobody can edit it) and no grants of its own: it
  // holds every permission implicitly, which is what keeps the company from locking itself
  // out. The event uses the dotted name every other aggregate uses.
  assert.equal(listed.body.actors[0].revision, null)
  assert.deepEqual(listed.body.actors[0].grants, [])
  const event = JSON.parse(readFileSync(join(home, 'company', 'events.jsonl'), 'utf8').trim().split('\n').at(-1))
  assert.equal(event.type, 'actor.invited')
  assert.equal(event.command, 'actor.invite')
})

test('a second person with the same name is refused, in any case', async () => {
  const home = await openHome()
  seed(home, { actors: [person('hum_9', '林小满'), person('hum_off', '停用的人', { status: 'disabled' })] })
  const run = commandsFor(home)

  await failure(run('actor.invite', { name: ' 林小满 ', operation_key: op() }, { actor: OWNER }), 'actor/name-taken')
  // A disabled person keeps her name reserved: restoring her must never leave two active
  // people answering to one name, so the name is refused now rather than after a restore.
  await failure(run('actor.invite', { name: '停用的人', operation_key: op() }, { actor: OWNER }), 'actor/name-taken')
  // The owner's row is a name on the same list, so nobody else may take it.
  await failure(run('actor.invite', { name: '老板', operation_key: op() }, { actor: OWNER }), 'actor/name-taken')
  assert.equal(Object.keys(stateOf(home).actors).length, 3)
})

test('renaming onto a name someone else holds is refused, and a save that changes nothing writes nothing', async () => {
  const home = await openHome()
  seed(home, { actors: [person('hum_1', '林小满'), person('hum_2', '另一个人')] })
  const run = commandsFor(home)

  await failure(run('actor.update', { actor_id: 'hum_1', expected_revision: 1, name: '另一个人', operation_key: op() }, { actor: OWNER }), 'actor/name-taken')

  // The save repeats what the row already says: no revision bump, no event, no write.
  const same = await run('actor.update', { actor_id: 'hum_1', expected_revision: 1, name: '林小满', status: 'active', operation_key: op() }, { actor: OWNER })
  assert.equal(same.status, 'ok')
  assert.equal(same.body.actor.revision, 1)
  assert.equal(stateOf(home).revision, 4)
  assert.equal(stateOf(home).actors.hum_1.revision, 1)

  await failure(run('actor.update', { actor_id: 'hum_1', expected_revision: 1, operation_key: op() }, { actor: OWNER }), 'company/invalid')
})

test('renaming and disabling a person each need the revision that was read, and the owner is untouchable', async () => {
  const home = await openHome()
  seed(home, { actors: [person('hum_1', '林小满')] })
  const run = commandsFor(home)

  const renamed = await run('actor.update', { actor_id: 'hum_1', expected_revision: 1, name: '林小满 A', operation_key: op() }, { actor: OWNER })
  assert.equal(renamed.body.actor.name, '林小满 A')
  assert.equal(renamed.body.actor.revision, 2)

  await failure(run('actor.update', { actor_id: 'hum_1', expected_revision: 1, status: 'disabled', operation_key: op() }, { actor: OWNER }), 'company/revision-conflict')

  const disabled = await run('actor.update', { actor_id: 'hum_1', expected_revision: 2, status: 'disabled', operation_key: op() }, { actor: OWNER })
  assert.equal(disabled.body.actor.status, 'disabled')
  assert.equal(stateOf(home).actors.hum_1.status, 'disabled')

  await failure(run('actor.update', { actor_id: 'user', expected_revision: 1, name: '老板 2', operation_key: op() }, { actor: OWNER }), 'actor/immutable-field')
})

test('a grant names one scope and its permissions, and a second one for the same scope is refused', async () => {
  const home = await openHome()
  seed(home, { actors: [person('hum_1', '林小满')] })
  const run = commandsFor(home)

  const company = await run('grant.create', { actor_id: 'hum_1', scope_type: 'company', permissions: ['view', 'members'], operation_key: op() }, { actor: OWNER })
  assert.equal(company.body.grant.scope_type, 'company')
  assert.equal(company.body.grant.scope_id, null)
  assert.deepEqual(company.body.grant.permissions, ['view', 'members'])

  const project = await run('grant.create', { actor_id: 'hum_1', scope_type: 'project', scope_id: 'prj_1', permissions: ['dispatch'], operation_key: op() }, { actor: OWNER })
  assert.equal(project.body.grant.scope_id, 'prj_1')

  await failure(run('grant.create', { actor_id: 'hum_1', scope_type: 'company', permissions: ['accept'], operation_key: op() }, { actor: OWNER }), 'grant/exists')
  await failure(run('grant.create', { actor_id: 'hum_1', scope_type: 'company', permissions: ['owner'], operation_key: op() }, { actor: OWNER }), 'company/invalid')
  await failure(run('grant.create', { actor_id: 'hum_1', scope_type: 'project', scope_id: 'prj_404', permissions: ['view'], operation_key: op() }, { actor: OWNER }), 'project/not-found')
})

test('a grant is revoked by id and its revision, and a disabled person cannot be granted at all', async () => {
  const home = await openHome()
  seed(home, {
    actors: [person('hum_1', '林小满'), person('hum_off', '停用的人', { status: 'disabled' })],
    grants: { grt_1: { id: 'grt_1', actor_id: 'hum_1', scope_type: 'project', scope_id: 'prj_1', permissions: ['dispatch'], created_at: 1, updated_at: 1, revision: 1 } },
  })
  const run = commandsFor(home)

  await failure(run('grant.revoke', { grant_id: 'grt_1', expected_revision: 2, operation_key: op() }, { actor: OWNER }), 'company/revision-conflict')
  const revoked = await run('grant.revoke', { grant_id: 'grt_1', expected_revision: 1, operation_key: op() }, { actor: OWNER })
  assert.equal(revoked.body.grant.id, 'grt_1')
  assert.deepEqual(stateOf(home).grants, {})

  await failure(run('grant.create', { actor_id: 'hum_off', scope_type: 'company', permissions: ['view'], operation_key: op() }, { actor: OWNER }), 'actor/inactive')
})

test('the fence reads the grants: a person can read, cannot invite until granted it', async () => {
  const home = await openHome()
  seed(home, { actors: [person('hum_1', '林小满')] })
  const run = commandsFor(home)

  const listed = await run('actor.list', { operation_key: op() }, { actor: HUMAN })
  assert.equal(listed.body.actors.length, 2)

  await failure(run('actor.invite', { name: '另一个人', operation_key: op() }, { actor: HUMAN }), 'company/forbidden')

  await run('grant.create', { actor_id: 'hum_1', scope_type: 'company', permissions: ['members'], operation_key: op() }, { actor: OWNER })
  const invited = await run('actor.invite', { name: '另一个人', operation_key: op() }, { actor: HUMAN })
  assert.equal(invited.status, 'committed')
})
