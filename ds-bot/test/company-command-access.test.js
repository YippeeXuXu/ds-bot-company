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
