import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { format } from 'node:util'
import { test } from 'node:test'
import { createCompanyApi } from '../src/host/company/api.js'
import { createCommands } from '../src/host/company/commands.js'
import { createCompanyStore } from '../src/host/company/store.js'

// Two command names, so this file checks the wiring rather than any handler: the fence is
// decided from the command's name and the actor, never from what the handler would do.
const handlers = {
  'task.list': () => ({ mutates: false, body: { tasks: [] } }),
  'task.dispatch': ({ payload, now }) => ({
    mutates: true,
    body: { dispatched: payload.task_id },
    events: [{ type: 'task.dispatched', data: { task_id: payload.task_id }, at: now() }],
  }),
  'run.fail': ({ payload }) => ({ mutates: true, body: { failed: payload.run_id }, events: [] }),
  'acceptance.decide': ({ payload }) => ({ mutates: true, body: { decided: payload.acceptance_id }, events: [] }),
}

const human = extra => ({ id: 'hum_1', kind: 'human', status: 'active', name: '小周', ...extra })
const room = { id: 'room_1', name: '项目群', members: [] }

async function open({ actorOf } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-company-fence-'))
  const warnings = []
  const store = createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} })
  const commands = createCommands({
    store,
    handlers,
    warn: (...args) => warnings.push(format(...args)),
  })
  const grants = (...rows) => store.commit({ ...store.state, grants: Object.fromEntries(rows.map(row => [row.id, row])) })
  const api = createCompanyApi({
    store,
    execute: commands.execute,
    groups: { roomOf: id => (id === room.id ? room : undefined), members: () => undefined },
    warn: () => {},
    ...(actorOf === undefined ? {} : { actorOf }),
  })
  return {
    home,
    store,
    commands,
    api,
    warnings,
    grants,
    run: (command, payload = {}, context) => commands.execute(command, { operation_key: `k-${command}-${Math.random()}`, ...payload }, context),
    http: (command, payload = {}) => api.command({ command, operation_key: `h-${Math.random()}`, payload }),
    close: () => {
      store.close()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('a call that names no actor is the owner, so every existing caller keeps working', async t => {
  const host = await open()
  t.after(() => host.close())
  assert.deepEqual((await host.run('task.list')).body, { tasks: [] })
  // The owner writes without any grant row.
  const dispatched = await host.run('task.dispatch', { task_id: 'tsk_1' })
  assert.equal(dispatched.status, 'committed')
})

test('a human is stopped at the fence before the queue, with the 403 code and no payload in the log', async t => {
  const host = await open()
  t.after(() => host.close())
  // Reading is the one permission everyone holds.
  assert.deepEqual((await host.run('task.list', {}, { actor: human() })).body, { tasks: [] })
  await assert.rejects(
    () => host.run('task.dispatch', { task_id: 'tsk_1', note: 'do-not-log-me' }, { actor: human() }),
    error => error.code === 'company/forbidden' && error.details.missing.includes('dispatch'),
  )
  assert.equal(host.warnings.length, 1)
  assert.match(host.warnings[0], /task\.dispatch was refused for hum_1/)
  assert.equal(host.warnings[0].includes('do-not-log-me'), false)
})

test('a project grant opens the command inside its project only', async t => {
  const host = await open()
  t.after(() => host.close())
  await host.grants({ id: 'g1', actor_id: 'hum_1', scope_type: 'project', scope_id: 'prj_1', permissions: ['dispatch'] })
  const inside = await host.run('task.dispatch', { task_id: 'tsk_1', project_id: 'prj_1' }, { actor: human() })
  assert.equal(inside.status, 'committed')
  await assert.rejects(
    () => host.run('task.dispatch', { task_id: 'tsk_1', project_id: 'prj_2' }, { actor: human() }),
    error => error.code === 'company/forbidden',
  )
})

test('a stopped person is refused even the read surface', async t => {
  const host = await open()
  t.after(() => host.close())
  await assert.rejects(
    () => host.run('task.list', {}, { actor: human({ status: 'stopped' }) }),
    error => error.code === 'company/forbidden',
  )
})

// 3.5's acceptance asks for "a grant on project A does not open project B", and most task
// commands name only a task. The fence resolves the project from the row it is about, so a
// person does not have to remember to send project_id, and naming a project she may act in
// does not open a task that lives in another one.
test('a task carries its own project into the fence, and a borrowed project_id does not open it', async t => {
  const host = await open()
  t.after(() => host.close())
  host.store.state.tasks = {
    tsk_a: { id: 'tsk_a', project_id: 'prj_a' },
    tsk_b: { id: 'tsk_b', project_id: 'prj_b' },
  }
  await host.grants({ id: 'g1', actor_id: 'hum_1', scope_type: 'project', scope_id: 'prj_a', permissions: ['dispatch'] })

  const inside = await host.run('task.dispatch', { task_id: 'tsk_a' }, { actor: human() })
  assert.equal(inside.status, 'committed')

  await assert.rejects(
    () => host.run('task.dispatch', { task_id: 'tsk_b' }, { actor: human() }),
    error => error.code === 'company/forbidden' && error.details.missing.includes('dispatch'),
  )
  // The payload names the project she may act in, but the task lives elsewhere.
  await assert.rejects(
    () => host.run('task.dispatch', { task_id: 'tsk_b', project_id: 'prj_a' }, { actor: human() }),
    error => error.code === 'company/forbidden',
  )
})

test('runs and acceptances carry their project into the fence too', async t => {
  const host = await open()
  t.after(() => host.close())
  host.store.state.runs = { run_a: { id: 'run_a', project_id: 'prj_a' }, run_b: { id: 'run_b', project_id: 'prj_b' } }
  host.store.state.acceptances = { acc_a: { id: 'acc_a', project_id: 'prj_a', task_id: null }, acc_b: { id: 'acc_b', project_id: 'prj_b', task_id: null } }
  await host.grants({ id: 'g1', actor_id: 'hum_1', scope_type: 'project', scope_id: 'prj_a', permissions: ['dispatch', 'accept'] })

  assert.equal((await host.run('run.fail', { run_id: 'run_a' }, { actor: human() })).status, 'committed')
  assert.equal((await host.run('acceptance.decide', { acceptance_id: 'acc_a' }, { actor: human() })).status, 'committed')
  for (const [command, payload] of [['run.fail', { run_id: 'run_b' }], ['acceptance.decide', { acceptance_id: 'acc_b' }]]) {
    await assert.rejects(() => host.run(command, payload, { actor: human() }), error => error.code === 'company/forbidden')
  }
})

test('the HTTP route answers 403 for a person and 200 for the default owner', async t => {
  const host = await open()
  t.after(() => host.close())
  const refused = await host.http('task.dispatch', { task_id: 'tsk_1' })
  assert.equal(refused.status, 200)

  const other = await open({ actorOf: () => human() })
  t.after(() => other.close())
  const denied = await other.http('task.dispatch', { task_id: 'tsk_1' })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.code, 'company/forbidden')
  assert.equal(denied.body.details.command, 'task.dispatch')
  const allowed = await other.http('task.list', {})
  assert.equal(allowed.status, 200)
})
