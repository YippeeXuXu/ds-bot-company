import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { COMMAND_PATH, EVENTS_PATH, MODEL_PATH, createCompanyApi } from '../src/host/company/api.js'
import { TODOS_ANSWER_PATH, TODOS_PATH } from '../src/host/company/todos.js'
import { ROW_REVISION_COMMANDS, acceptanceHandlers } from '../src/host/company/acceptances.js'
import { createCommands } from '../src/host/company/commands.js'
import { orgHandlers } from '../src/host/company/org.js'
import { projectHandlers } from '../src/host/company/projects.js'
import { createCompanyStore } from '../src/host/company/store.js'

const bots = {
  bot_a: { id: 'bot_a', name: 'Alpha' },
  bot_b: { id: 'bot_b', name: 'Beta' },
  bot_c: { id: 'bot_c', name: 'Gamma' },
}
const botOf = id => bots[id]
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-company-api-'))

// The roster side, as plain maps: a test can make the roster refuse a member change and
// see the warning travel through HTTP, without a Session behind the group.
function fakeGroups({ failSetMembers = false } = {}) {
  const rooms = new Map()
  let seq = 0
  return {
    rooms,
    groups: {
      create: async ({ name, members }) => {
        const id = `room_${++seq}`
        rooms.set(id, { id, name, members: [...members] })
        return { id }
      },
      members: roomId => {
        const room = rooms.get(roomId)
        return room === undefined ? undefined : [...room.members]
      },
      setMembers: async (roomId, members) => {
        if (failSetMembers) throw new Error('the roster is busy')
        const room = rooms.get(roomId)
        if (room === undefined) throw new Error(`No group chat ${roomId}.`)
        room.members = [...members]
      },
    },
  }
}

function open(home, { failSetMembers = false } = {}) {
  const { groups, rooms } = fakeGroups({ failSetMembers })
  const store = createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} })
  const commands = createCommands({
    store,
    // `acceptance.decide` carries the acceptance's own revision, as production wires it
    // (index.js) — without this the envelope would compare it to the company revision.
    rowRevisionCommands: ROW_REVISION_COMMANDS,
    handlers: {
      ...orgHandlers({ botOf, isPrivate: () => false }),
      ...projectHandlers({ groups }),
      ...acceptanceHandlers(),
    },
  })
  const api = createCompanyApi({ store, execute: commands.execute, groups, now: () => 1_700_000_000_000 })
  return { store, commands, api, rooms }
}

let counter = 0
const key = name => `k-${name}-${++counter}`

const command = (api, name, payload) => api.command({ operation_key: key(name), command: name, payload })

// The whole chain over the HTTP entry: company, a department with its group, three
// employees, then a project. Nothing here touches the store directly.
async function seed(api, rooms) {
  rooms.set('room_dep_product', { id: 'room_dep_product', name: '产品', members: ['bot_a', 'bot_b'] })
  const company = await command(api, 'company.init', { name: 'DS Bot Company' })
  assert.equal(company.status, 200)
  const department = await command(api, 'department.create', {
    name: '产品',
    chat_ref: 'room_dep_product',
  })
  assert.equal(department.status, 200)
  const alpha = await command(api, 'employee.create', {
    bot_id: 'bot_a',
    department_id: department.body.aggregate_id,
    name: '小蓝',
  })
  const beta = await command(api, 'employee.create', {
    bot_id: 'bot_b',
    department_id: department.body.aggregate_id,
    name: '橙子',
  })
  const keeper = await command(api, 'employee.create', {
    bot_id: 'bot_c',
    department_id: department.body.aggregate_id,
    name: '记忆岗',
    acceptance_role: 'memory_keeper',
  })
  return {
    company: company.body.aggregate_id,
    department: department.body.aggregate_id,
    alpha: alpha.body.aggregate_id,
    beta: beta.body.aggregate_id,
    keeper: keeper.body.aggregate_id,
  }
}

const draft = (seed_, extra = {}) => ({
  name: 'DS Bot Company M1',
  goal: '把公司化改造跑通',
  deliverable: '可运行的项目页',
  acceptance: '六条验收全绿',
  source_department_ids: [seed_.department],
  coordinator_employee_id: seed_.alpha,
  memory_employee_id: seed_.keeper,
  ...extra,
})

test('the read model answers an empty company without inventing one', async () => {
  const home = tempHome()
  const { api } = open(home)
  const answer = api.model({})
  assert.equal(answer.status, 200)
  assert.equal(answer.body.company, null)
  assert.deepEqual(answer.body.departments, [])
  assert.deepEqual(answer.body.employees, [])
  assert.deepEqual(answer.body.projects, [])
  assert.equal(answer.body.revision, 0)
  assert.equal(answer.body.activity_cursor, '0')
  rmSync(home, { recursive: true, force: true })
})

test('a command over HTTP returns the same envelope the tools get', async () => {
  const home = tempHome()
  const { api, rooms } = open(home)
  const seed_ = await seed(api, rooms)

  const created = await command(api, 'project.create', draft(seed_))
  assert.equal(created.status, 200)
  assert.equal(created.body.status, 'committed')
  assert.equal(created.body.command, 'project.create')
  const project = created.body.body.project
  assert.equal(project.status, 'setup')
  assert.match(project.group_chat_ref, /^room_/)

  const model = api.model({ project_id: project.id })
  assert.equal(model.status, 200)
  assert.equal(model.body.project.id, project.id)
  assert.deepEqual(model.body.project.group.members, ['bot_a'])
  assert.equal(model.body.project.group.drifted, false)
  assert.equal(model.body.projects.length, 1)

  const read = await command(api, 'project.get', { project_id: project.id })
  assert.equal(read.status, 200)
  // The read model lifts members and group next to the project for a screen, and adds the
  // chat page's view fields (waiting decisions, recent activity); project.get keeps the
  // record itself with the two siblings. Same three pieces, one shape each.
  const record = { ...model.body.projects[0] }
  for (const field of ['pending_count', 'pending_decisions', 'pinned_decisions', 'activity']) delete record[field]
  assert.deepEqual(read.body.body, {
    project: record,
    members: model.body.project.members,
    group: model.body.project.group,
  })
  rmSync(home, { recursive: true, force: true })
})

test('a repeated operation_key replays the first answer instead of committing again', async () => {
  const home = tempHome()
  const { api, store } = open(home)
  const payload = { operation_key: key('company'), command: 'company.init', payload: { name: 'DS Bot Company' } }
  const first = await api.command(payload)
  assert.equal(first.status, 200)
  assert.equal(first.body.revision, 1)
  const revision = store.state.revision

  const again = await api.command(payload)
  assert.equal(again.status, 200)
  assert.equal(again.body.replayed, true)
  assert.equal(again.body.revision, 1)
  assert.equal(store.state.revision, revision)

  const different = await api.command({ ...payload, payload: { name: 'Another Company' } })
  assert.equal(different.status, 409)
  assert.equal(different.body.code, 'company/idempotency-conflict')
  rmSync(home, { recursive: true, force: true })
})

test('a stale expected_revision is refused instead of overwriting a newer company', async () => {
  const home = tempHome()
  const { api } = open(home)
  await command(api, 'company.init', { name: 'DS Bot Company' })
  const stale = await api.command({
    operation_key: key('department'),
    expected_revision: 99,
    command: 'department.create',
    payload: { name: '产品', chat_ref: 'room_dep_product' },
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'company/revision-conflict')
  rmSync(home, { recursive: true, force: true })
})

test('the command entry refuses malformed requests without a 200', async () => {
  const home = tempHome()
  const { api } = open(home)
  const notObject = await api.command(null)
  assert.equal(notObject.status, 400)
  assert.equal(notObject.body.code, 'company/invalid')

  const noCommand = await api.command({ operation_key: key('x') })
  assert.equal(noCommand.status, 422)
  assert.equal(noCommand.body.details.field, 'command')

  const noKey = await api.command({ command: 'company.init', payload: { name: 'DS Bot Company' } })
  assert.equal(noKey.status, 422)
  assert.equal(noKey.body.details.field, 'operation_key')

  const unknown = await command(api, 'project.fly', {})
  assert.equal(unknown.status, 422)
  assert.equal(unknown.body.code, 'company/unknown-command')

  const missing = await command(api, 'project.get', { project_id: 'nope' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'project/not-found')
  rmSync(home, { recursive: true, force: true })
})

test('the events page follows its cursor and never repeats an event', async () => {
  const home = tempHome()
  const { api, rooms } = open(home)
  const seed_ = await seed(api, rooms)
  await command(api, 'project.create', draft(seed_))

  const first = await api.events({ limit: '2' })
  assert.equal(first.status, 200)
  assert.equal(first.body.events.length, 2)
  assert.equal(first.body.cursor, '2')
  assert.equal(first.body.has_more, true)
  assert.deepEqual(first.body.events.map(event => event.cursor), [1, 2])

  const next = await api.events({ cursor: first.body.cursor, limit: '2' })
  assert.equal(next.body.events.length, 2)
  assert.deepEqual(next.body.events.map(event => event.cursor), [3, 4])
  assert.equal(next.body.cursor, '4')

  // One revision can carry several events: `project.create` writes the project and the
  // group binding together, so both lines share a cursor and a page keeps both.
  const rest = await api.events({ cursor: '4' })
  assert.deepEqual(rest.body.events.map(event => event.cursor), [5, 6, 6])
  assert.equal(rest.body.has_more, false)

  // The page size is clamped, never trusted: zero becomes one and a huge ask stays bounded.
  const tiny = await api.events({ cursor: '2', limit: '0' })
  assert.deepEqual(tiny.body.events.map(event => event.cursor), [3])
  const wide = await api.events({ cursor: '0', limit: '9999' })
  assert.equal(wide.body.events.length, 7)
  rmSync(home, { recursive: true, force: true })
})

test('a null query is read as an empty one instead of failing the screen', async () => {
  const home = tempHome()
  const { api, rooms } = open(home)
  const seed_ = await seed(api, rooms)
  await command(api, 'project.create', draft(seed_))

  // `/api/bot` hands a client's payload straight through, and a client may send null where
  // it means "no filter"; a default parameter only covers `undefined`, so the entry has to
  // read null as the empty query rather than crash into a 500 on the first screen.
  const model = api.model(null)
  assert.equal(model.status, 200)
  assert.equal('project' in model.body, false)
  assert.equal(model.body.projects.length, 1)
  assert.equal(model.body.company.id, seed_.company)

  const events = await api.events(null)
  assert.equal(events.status, 200)
  assert.equal(events.body.events[0].type, 'company.created')
  assert.deepEqual(events.body.events.map(event => event.cursor), [1, 2, 3, 4, 5, 6, 6])
  assert.equal(events.body.cursor, '6')
  assert.equal(events.body.has_more, false)
  rmSync(home, { recursive: true, force: true })
})

test('a saved member change the group refused comes back as a warning, not a failure', async () => {
  const home = tempHome()
  const { api, rooms } = open(home, { failSetMembers: true })
  const seed_ = await seed(api, rooms)
  const created = await command(api, 'project.create', draft(seed_))
  const project = created.body.body.project

  const added = await command(api, 'project.member.add', { project_id: project.id, employee_id: seed_.beta })
  assert.equal(added.status, 200)
  assert.equal(added.body.warning.code, 'group_pending')
  assert.equal(added.body.warning.project_id, project.id)

  const model = api.model({ project_id: project.id })
  assert.equal(model.body.project.group.group_binding.status, 'pending')
  assert.equal(model.body.project.members.length, 2)
  rmSync(home, { recursive: true, force: true })
})

test('the routes are registered on the host carrier and disposed with the plugin', async () => {
  const home = tempHome()
  const { api } = open(home)
  const routes = []
  const disposed = []
  const ctx = {
    connection: {
      fetch: {
        register: route => {
          routes.push(route)
          return () => disposed.push(route.path)
        },
      },
    },
  }
  const dispose = api.register(ctx)
  assert.deepEqual(routes.map(route => [route.path, route.methods]), [
    [COMMAND_PATH, ['POST']],
    [MODEL_PATH, ['GET']],
    [EVENTS_PATH, ['GET']],
    [TODOS_PATH, ['GET']],
    [TODOS_ANSWER_PATH, ['POST']],
  ])

  const post = await routes[0].fetch(new Request(`http://127.0.0.1${COMMAND_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation_key: key('company'), command: 'company.init', payload: { name: 'DS Bot Company' } }),
  }))
  assert.equal(post.status, 200)
  assert.equal(post.headers.get('content-type'), 'application/json')
  assert.equal((await post.json()).status, 'committed')

  const get = await routes[1].fetch(new Request(`http://127.0.0.1${MODEL_PATH}`))
  assert.equal(get.status, 200)
  assert.equal((await get.json()).company.name, 'DS Bot Company')

  const broken = await routes[0].fetch(new Request(`http://127.0.0.1${COMMAND_PATH}`, { method: 'POST', body: '{' }))
  assert.equal(broken.status, 400)
  assert.equal((await broken.json()).code, 'company/invalid')

  dispose()
  assert.deepEqual(disposed, [COMMAND_PATH, MODEL_PATH, EVENTS_PATH, TODOS_PATH, TODOS_ANSWER_PATH])
  rmSync(home, { recursive: true, force: true })
})

test('the model carries the view fields the project screens read', async () => {
  const home = tempHome()
  const { api, rooms } = open(home)
  const seed_ = await seed(api, rooms)
  const created = await command(api, 'project.create', draft(seed_))
  const project = created.body.body.project

  // Only decisions the owner makes reach the owner's list: a Bot-decided acceptance stays
  // out of the pinned card even while it is pending (todos.js acceptanceRow).
  const submitted = await command(api, 'acceptance.submit', {
    project_id: project.id,
    requester_employee_id: seed_.alpha,
    acceptance_actor: 'user',
    title: '交付项目页',
  })
  assert.equal(submitted.status, 200)

  // The header count, the pinned card and the drawer read these three fields off the
  // project; the waiting row is the to-do read's own row, so the card text is the same
  // one the to-do page shows.
  const model = api.model({})
  const row = model.body.projects[0]
  assert.equal(row.pending_count, 1)
  assert.deepEqual(row.pinned_decisions, [{ id: row.pending_decisions[0].id, title: '交付项目页', who: '小蓝' }])
  assert.deepEqual(row.pending_decisions, row.pinned_decisions)
  assert.deepEqual(row.activity.map(item => item.kind), ['acceptance.submitted', 'member.joined', 'project.created'])

  // Opening one project answers the same fields, so a screen does not join two shapes.
  const detail = api.model({ project_id: project.id })
  assert.equal(detail.body.project.pending_count, 1)
  assert.deepEqual(detail.body.project.pinned_decisions, row.pinned_decisions)

  // Answering the decision empties the card and leaves the answer as the latest activity.
  const answer = await command(api, 'acceptance.decide', {
    acceptance_id: submitted.body.body.acceptance.id,
    decision: 'accept',
    expected_revision: 1,
  })
  assert.equal(answer.status, 200)
  const after = api.model({ project_id: project.id }).body.project
  assert.equal(after.pending_count, 0)
  assert.deepEqual(after.pinned_decisions, [])
  assert.equal(after.activity[0].kind, 'acceptance.accepted')
  rmSync(home, { recursive: true, force: true })
})
