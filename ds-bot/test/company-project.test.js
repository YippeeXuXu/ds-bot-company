import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ROW_REVISION_COMMANDS, acceptanceHandlers } from '../src/host/company/acceptances.js'
import { createCommands } from '../src/host/company/commands.js'
import { orgHandlers } from '../src/host/company/org.js'
import { projectHandlers } from '../src/host/company/projects.js'
import { createCompanyStore } from '../src/host/company/store.js'

const bots = {
  bot_a: { id: 'bot_a', name: 'Alpha' },
  bot_b: { id: 'bot_b', name: 'Beta' },
  bot_c: { id: 'bot_c', name: 'Gamma' },
  bot_d: { id: 'bot_d', name: 'Delta' },
}
const botOf = id => bots[id]
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-company-project-'))

// The roster side of the project tests: groups are plain maps, so a test can make one
// disappear or drift without a Session behind it.
function fakeGroups({ failSetMembers = false } = {}) {
  const rooms = new Map()
  let seq = 0
  const groups = {
    create: async ({ name, members, admin }) => {
      const id = `room_${++seq}`
      // `admin` is kept so a test can see who the group is led by (M1b-1 item 4).
      rooms.set(id, { id, name, members: [...members], admin })
      return { id }
    },
    members: (roomId) => {
      const room = rooms.get(roomId)
      return room === undefined ? undefined : [...room.members]
    },
    setMembers: async (roomId, members) => {
      if (failSetMembers) throw new Error('the roster is busy')
      const room = rooms.get(roomId)
      if (room === undefined) throw new Error(`No group chat ${roomId}.`)
      room.members = [...members]
    },
  }
  return { groups, rooms }
}

function open(home, { failSetMembers = false } = {}) {
  const { groups, rooms } = fakeGroups({ failSetMembers })
  const store = createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} })
  const commands = createCommands({
    store,
    handlers: {
      ...orgHandlers({ botOf, isPrivate: () => false }),
      ...projectHandlers({ groups }),
      ...acceptanceHandlers(),
    },
    // Production wiring (index.js): `acceptance.decide` carries the acceptance's revision.
    rowRevisionCommands: ROW_REVISION_COMMANDS,
  })
  return { store, commands, rooms }
}

const run = (commands, command, payload) => commands.execute(command, payload)

let counter = 0
const key = name => `k-${name}-${++counter}`

// A company with one department (its group chat bound) and three employees, one of them
// the dedicated memory keeper.
async function seed(commands, rooms) {
  rooms.set('room_dep_product', { id: 'room_dep_product', name: '产品', members: ['bot_a', 'bot_b'] })
  const company = await run(commands, 'company.init', { operation_key: key('company'), name: 'DS Bot Company' })
  const department = await run(commands, 'department.create', {
    operation_key: key('department'),
    expected_revision: company.revision,
    name: '产品',
    chat_ref: 'room_dep_product',
  })
  const alpha = await run(commands, 'employee.create', {
    operation_key: key('alpha'),
    expected_revision: department.revision,
    bot_id: 'bot_a',
    department_id: department.aggregate_id,
    name: '小蓝',
  })
  const beta = await run(commands, 'employee.create', {
    operation_key: key('beta'),
    expected_revision: alpha.revision,
    bot_id: 'bot_b',
    department_id: department.aggregate_id,
    name: '橙子',
  })
  const keeper = await run(commands, 'employee.create', {
    operation_key: key('keeper'),
    expected_revision: beta.revision,
    bot_id: 'bot_c',
    department_id: department.aggregate_id,
    name: '记忆岗',
    acceptance_role: 'memory_keeper',
  })
  return {
    company: company.aggregate_id,
    department: department.aggregate_id,
    alpha: alpha.aggregate_id,
    beta: beta.aggregate_id,
    keeper: keeper.aggregate_id,
    revision: keeper.revision,
  }
}

const projectOf = (commands, id) => run(commands, 'project.get', { operation_key: key('read'), project_id: id })

const draft = (seed, extra = {}) => ({
  name: 'DS Bot Company M1',
  goal: '把公司化改造跑通',
  deliverable: '可运行的项目页',
  acceptance: '六条验收全绿',
  source_department_ids: [seed.department],
  coordinator_employee_id: seed.alpha,
  acceptance_actor: seed.beta,
  memory_employee_id: seed.keeper,
  workspace_ref: '/tmp/projects/m1',
  ...extra,
})

test('project.create commits the project, its coordinator and the project group together', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)

  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  assert.equal(created.status, 'committed')
  assert.equal(created.revision, seed_.revision + 1)
  const project = created.body.project
  assert.equal(project.status, 'setup')
  assert.equal(project.company_id, seed_.company)
  assert.equal(project.acceptance_requirement, 'daily_independent_bot')
  assert.match(project.group_chat_ref, /^room_/)
  assert.equal(project.group_binding.status, 'bound')
  assert.equal(project.group_binding.room_id, project.group_chat_ref)

  const member = created.body.member
  assert.equal(member.role, 'coordinator')
  assert.equal(member.membership_status, 'active')
  assert.equal(project.coordinator_assignment_id, member.id)
  assert.deepEqual(rooms.get(project.group_chat_ref).members, ['bot_a'])
  assert.equal(store.state.employees[seed_.alpha].project_id, project.id)

  const read = await projectOf(commands, project.id)
  assert.equal(read.status, 'ok')
  assert.deepEqual(read.body.group.members, ['bot_a'])
  assert.equal(read.body.group.drifted, false)
  rmSync(home, { recursive: true, force: true })
})

test('a Bot that already serves a running project cannot coordinate a second one', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const first = await run(commands, 'project.create', { operation_key: key('create-1'), ...draft(seed_) })
  await run(commands, 'project.start', { operation_key: key('start-1'), project_id: first.body.project.id })
  await assert.rejects(
    run(commands, 'project.create', { operation_key: key('create-2'), ...draft(seed_, { name: '另一个项目' }) }),
    error => error.code === 'project/member-busy',
  )
  rmSync(home, { recursive: true, force: true })
})

test('owner_only acceptance belongs to the owner and cannot name a Bot', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  await assert.rejects(
    run(commands, 'project.create', {
      operation_key: key('create-owner-bot'),
      ...draft(seed_, { acceptance_requirement: 'owner_only' }),
    }),
    error => error.code === 'project/owner-required',
  )
  const created = await run(commands, 'project.create', {
    operation_key: key('create-owner'),
    ...draft(seed_, { acceptance_requirement: 'owner_only', acceptance_actor: 'user', name: '对外发布' }),
  })
  assert.equal(created.body.project.acceptance_actor, 'user')
  rmSync(home, { recursive: true, force: true })
})

test('the coordinator must come from one of the source departments', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const other = await run(commands, 'department.create', { operation_key: key('dept-2'), name: '工程' })
  await assert.rejects(
    run(commands, 'project.create', { operation_key: key('create-foreign'), ...draft(seed_, { source_department_ids: [other.aggregate_id] }) }),
    error => error.code === 'project/invalid',
  )
  rmSync(home, { recursive: true, force: true })
})

test('a member joins the project and the project group, and leaves without leaving the department', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id

  const added = await run(commands, 'project.member.add', {
    operation_key: key('add'),
    project_id: projectId,
    employee_id: seed_.beta,
    role: 'executor',
  })
  assert.equal(added.status, 'committed')
  assert.equal(added.body.member.membership_status, 'active')
  assert.deepEqual([...rooms.get(created.body.project.group_chat_ref).members].sort(), ['bot_a', 'bot_b'])
  assert.equal(store.state.employees[seed_.beta].project_id, projectId)

  await assert.rejects(
    run(commands, 'project.member.add', { operation_key: key('add-dup'), project_id: projectId, employee_id: seed_.beta }),
    error => error.code === 'project/member-exists',
  )

  const removed = await run(commands, 'project.member.remove', {
    operation_key: key('remove'),
    project_id: projectId,
    employee_id: seed_.beta,
  })
  assert.equal(removed.status, 'committed')
  assert.equal(removed.body.member.membership_status, 'left')
  assert.equal(removed.body.member.left_reason, null)
  assert.equal(store.state.employees[seed_.beta].project_id, null)
  assert.equal(store.state.employees[seed_.beta].department_id, seed_.department)
  assert.deepEqual(rooms.get(created.body.project.group_chat_ref).members, ['bot_a'])
  rmSync(home, { recursive: true, force: true })
})

test('project.start reports every missing piece at once, then activates the project', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const bare = await run(commands, 'project.create', {
    operation_key: key('create-bare'),
    ...draft(seed_, { workspace_ref: undefined, memory_employee_id: undefined }),
  })
  await assert.rejects(
    run(commands, 'project.start', { operation_key: key('start-bare'), project_id: bare.body.project.id }),
    error => error.code === 'project/missing-input' && error.details.blockers.some(blocker => blocker.field === 'workspace_ref') && error.details.blockers.some(blocker => blocker.field === 'memory_assignment_id'),
  )
  assert.equal(store.state.projects[bare.body.project.id].status, 'setup')

  const ready = await run(commands, 'project.create', { operation_key: key('create-ready'), ...draft(seed_, { name: '就绪项目' }) })
  const projectId = ready.body.project.id
  const started = await run(commands, 'project.start', { operation_key: key('start'), project_id: projectId })
  assert.equal(started.status, 'committed')
  assert.equal(started.body.project.status, 'active')
  assert.deepEqual(started.body.readiness.blockers, [])
  assert.equal(typeof started.body.project.started_at, 'number')
  assert.equal(store.state.projects[projectId].revision, 2)
  rmSync(home, { recursive: true, force: true })
})

test('a drifting project group blocks the start until it is reconciled', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  const roomId = created.body.project.group_chat_ref
  rooms.set(roomId, { id: roomId, name: 'drifted', members: ['bot_b', 'bot_c'] })

  await assert.rejects(
    run(commands, 'project.start', { operation_key: key('start-drift'), project_id: projectId }),
    error => error.code === 'project/group-pending',
  )
  const reconciled = await run(commands, 'project.group.reconcile', { operation_key: key('reconcile'), project_id: projectId })
  assert.equal(reconciled.status, 'committed')
  assert.deepEqual(rooms.get(roomId).members, ['bot_a'])
  const started = await run(commands, 'project.start', { operation_key: key('start-after'), project_id: projectId })
  assert.equal(started.body.project.status, 'active')
  rmSync(home, { recursive: true, force: true })
})

test('a group that is gone is rebuilt only by the explicit reconcile command', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  const oldRoom = created.body.project.group_chat_ref
  rooms.delete(oldRoom)

  await assert.rejects(
    run(commands, 'project.start', { operation_key: key('start-missing'), project_id: projectId }),
    error => error.code === 'project/group-pending',
  )
  const repaired = await run(commands, 'project.group.reconcile', { operation_key: key('reconcile'), project_id: projectId })
  assert.equal(repaired.status, 'committed')
  const newRoom = repaired.body.project.group_chat_ref
  assert.notEqual(newRoom, oldRoom)
  assert.deepEqual(rooms.get(newRoom).members, ['bot_a'])
  rmSync(home, { recursive: true, force: true })
})

test('archiving keeps the group, turns members read-only and suspends the memory keeper', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  const roomId = created.body.project.group_chat_ref
  await run(commands, 'project.start', { operation_key: key('start'), project_id: projectId })
  const archived = await run(commands, 'project.archive', { operation_key: key('archive'), project_id: projectId })

  assert.equal(archived.status, 'committed')
  assert.equal(store.state.projects[projectId].status, 'archived')
  assert.deepEqual(archived.body.archived_members, [seed_.alpha])
  assert.deepEqual(archived.body.suspended_employees, [seed_.keeper])
  const membership = Object.values(store.state.members).find(member => member.project_id === projectId && member.employee_id === seed_.alpha)
  assert.equal(membership.membership_status, 'archived_readonly')
  assert.equal(membership.archived_reason, 'project_archived')
  assert.equal(store.state.employees[seed_.alpha].project_id, null)
  assert.equal(store.state.employees[seed_.keeper].status, 'suspended')
  assert.ok(rooms.has(roomId))

  // Read-only members do not occupy the one-project rule: the same Bot can join a new one.
  const next = await run(commands, 'project.create', {
    operation_key: key('create-next'),
    ...draft(seed_, { name: '下一个项目', memory_employee_id: undefined }),
  })
  assert.equal(next.status, 'committed')
  rmSync(home, { recursive: true, force: true })
})

test('a group the roster refuses is saved as pending and reported as a warning', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home, { failSetMembers: true })
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  const added = await run(commands, 'project.member.add', {
    operation_key: key('add'),
    project_id: projectId,
    employee_id: seed_.beta,
  })
  assert.equal(added.status, 'committed')
  assert.equal(added.warning.code, 'group_pending')
  assert.equal(store.state.projects[projectId].group_binding.status, 'pending')
  assert.equal(store.state.employees[seed_.beta].project_id, projectId)

  const read = await projectOf(commands, projectId)
  assert.equal(read.body.group.group_binding.status, 'pending')
  assert.equal(read.body.group.drifted, true)
  rmSync(home, { recursive: true, force: true })
})

test('a draft can be created without a coordinator, stays unbound, and starts once one joins', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', {
    operation_key: key('create-draft'),
    ...draft(seed_, { coordinator_employee_id: undefined }),
  })
  assert.equal(created.status, 'committed')
  const project = created.body.project
  assert.equal(project.status, 'setup')
  assert.equal(project.coordinator_assignment_id, null)
  assert.equal(project.group_chat_ref, null)
  assert.equal(project.group_binding.status, 'unbound')
  assert.equal(created.body.member, null)
  assert.equal(created.body.group_chat_ref, null)
  // Only the department group exists: a draft without members makes no group chat.
  assert.equal(rooms.size, 1)

  const read = await projectOf(commands, project.id)
  assert.equal(read.body.group.group_chat_ref, null)
  assert.equal(read.body.group.members, null)
  assert.equal(read.body.group.drifted, null)

  await assert.rejects(
    run(commands, 'project.start', { operation_key: key('start-draft'), project_id: project.id }),
    error => error.code === 'project/missing-input' && error.details.blockers.some(blocker => blocker.field === 'coordinator'),
  )
  assert.equal(store.state.projects[project.id].status, 'setup')

  // The first member of an unbound draft makes the group, and the coordinator post is
  // filled by the member given that role.
  const added = await run(commands, 'project.member.add', {
    operation_key: key('add-coordinator'),
    project_id: project.id,
    employee_id: seed_.alpha,
    role: 'coordinator',
  })
  assert.equal(added.status, 'committed')
  assert.equal(added.body.project.coordinator_assignment_id, added.body.member.id)
  assert.match(added.body.project.group_chat_ref, /^room_/)
  assert.deepEqual(rooms.get(added.body.project.group_chat_ref).members, ['bot_a'])

  const started = await run(commands, 'project.start', { operation_key: key('start-after'), project_id: project.id })
  assert.equal(started.body.project.status, 'active')
  rmSync(home, { recursive: true, force: true })
})

test('the coordinator post is filled once and only from a source department', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', {
    operation_key: key('create-draft'),
    ...draft(seed_, { coordinator_employee_id: undefined }),
  })
  const projectId = created.body.project.id
  await run(commands, 'project.member.add', { operation_key: key('add-alpha'), project_id: projectId, employee_id: seed_.alpha, role: 'coordinator' })
  await assert.rejects(
    run(commands, 'project.member.add', { operation_key: key('add-beta-coordinator'), project_id: projectId, employee_id: seed_.beta, role: 'coordinator' }),
    error => error.code === 'project/coordinator-exists',
  )

  // A Bot from a department outside the project cannot take the post.
  const other = await run(commands, 'department.create', { operation_key: key('dept-2'), name: '工程' })
  const foreign = await run(commands, 'employee.create', {
    operation_key: key('foreign'),
    bot_id: 'bot_d',
    department_id: other.aggregate_id,
    name: '工程 Bot',
  })
  const second = await run(commands, 'project.create', {
    operation_key: key('create-second'),
    ...draft(seed_, { coordinator_employee_id: undefined, name: '第二个项目' }),
  })
  await assert.rejects(
    run(commands, 'project.member.add', { operation_key: key('add-foreign'), project_id: second.body.project.id, employee_id: foreign.aggregate_id, role: 'coordinator' }),
    error => error.code === 'project/invalid' && error.details.field === 'employee_id',
  )
  rmSync(home, { recursive: true, force: true })
})

test('one project.update can raise owner_only and name the owner together', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', {
    operation_key: key('create-draft'),
    ...draft(seed_, { coordinator_employee_id: undefined, acceptance_actor: seed_.beta }),
  })
  const projectId = created.body.project.id
  // Both halves in one command: the new requirement is judged against the new actor, not
  // against the Bot the draft was created with.
  const updated = await run(commands, 'project.update', {
    operation_key: key('update-owner'),
    project_id: projectId,
    acceptance_requirement: 'owner_only',
    acceptance_actor: 'user',
  })
  assert.equal(updated.status, 'committed')
  assert.equal(updated.body.project.acceptance_requirement, 'owner_only')
  assert.equal(updated.body.project.acceptance_actor, 'user')
  assert.equal(store.state.projects[projectId].acceptance_requirement, 'owner_only')

  // owner_only with a Bot in the same command is still refused, and the project is untouched.
  await assert.rejects(
    run(commands, 'project.update', {
      operation_key: key('update-owner-bot'),
      project_id: projectId,
      acceptance_requirement: 'owner_only',
      acceptance_actor: seed_.beta,
    }),
    error => error.code === 'project/owner-required',
  )
  assert.equal(store.state.projects[projectId].acceptance_actor, 'user')
  rmSync(home, { recursive: true, force: true })
})

test('project.update fills in what the draft left out and records the change', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', {
    operation_key: key('create-draft'),
    ...draft(seed_, { coordinator_employee_id: undefined, workspace_ref: undefined, memory_employee_id: undefined }),
  })
  const projectId = created.body.project.id
  const updated = await run(commands, 'project.update', {
    operation_key: key('update'),
    expected_revision: created.revision,
    project_id: projectId,
    name: 'DS Bot Company M1 试点',
    goal: '把公司化改造跑通（试点）',
    deliverable: '可运行的项目页',
    acceptance: '六条验收全绿（试点）',
    workspace_ref: '/tmp/projects/m1-pilot',
    acceptance_actor: seed_.beta,
    acceptance_requirement: 'daily_independent_bot',
    memory_assignment_id: seed_.keeper,
  })
  assert.equal(updated.status, 'committed')
  const project = updated.body.project
  assert.equal(project.name, 'DS Bot Company M1 试点')
  assert.equal(project.goal, '把公司化改造跑通（试点）')
  assert.equal(project.deliverable, '可运行的项目页')
  assert.equal(project.acceptance, '六条验收全绿（试点）')
  assert.equal(project.workspace_ref, '/tmp/projects/m1-pilot')
  assert.equal(project.acceptance_actor, seed_.beta)
  assert.equal(project.memory_assignment_id, seed_.keeper)
  // The edit is a new revision of the project, and it is on disk.
  assert.equal(project.revision, 2)
  assert.equal(store.state.projects[projectId].name, 'DS Bot Company M1 试点')
  assert.equal(store.state.projects[projectId].revision, 2)
  assert.match(readFileSync(store.eventsPath, 'utf8'), /"type":"project\.updated".*"fields":\["name","goal","deliverable","acceptance","workspace_ref","acceptance_requirement","acceptance_actor","memory_assignment_id"\]/)

  // Configured values can be cleared again; the project then blocks its start on them.
  const cleared = await run(commands, 'project.update', {
    operation_key: key('update-clear'),
    project_id: projectId,
    workspace_ref: null,
    memory_assignment_id: null,
  })
  assert.equal(cleared.body.project.workspace_ref, null)
  assert.equal(cleared.body.project.memory_assignment_id, null)
  assert.equal(cleared.body.project.revision, 3)
  await assert.rejects(
    run(commands, 'project.start', { operation_key: key('start-cleared'), project_id: projectId }),
    error => error.code === 'project/missing-input' && error.details.blockers.some(blocker => blocker.field === 'workspace_ref') && error.details.blockers.some(blocker => blocker.field === 'memory_assignment_id'),
  )
  rmSync(home, { recursive: true, force: true })
})

test('project.update replays a retry, refuses a stale revision and a changed retry', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id

  const first = await run(commands, 'project.update', { operation_key: 'dup-update', project_id: projectId, goal: '新目标' })
  const replay = await run(commands, 'project.update', { operation_key: 'dup-update', project_id: projectId, goal: '新目标' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.revision, first.revision)
  assert.equal(store.state.projects[projectId].revision, first.body.project.revision)
  await assert.rejects(
    run(commands, 'project.update', { operation_key: 'dup-update', project_id: projectId, goal: '另一个目标' }),
    error => error.code === 'company/idempotency-conflict',
  )

  await assert.rejects(
    run(commands, 'project.update', { operation_key: key('update-stale'), expected_revision: store.state.revision - 1, project_id: projectId, goal: '过期目标' }),
    error => error.code === 'company/revision-conflict',
  )
  assert.equal(store.state.projects[projectId].goal, '新目标')

  // Only the listed fields are writable, and an update must change something.
  await assert.rejects(
    run(commands, 'project.update', { operation_key: key('update-nothing'), project_id: projectId, status: 'active' }),
    error => error.code === 'company/invalid',
  )
  await assert.rejects(
    run(commands, 'project.update', { operation_key: key('update-empty-name'), project_id: projectId, name: '   ' }),
    error => error.code === 'company/invalid',
  )
  rmSync(home, { recursive: true, force: true })
})

test('project.update refuses an archived project and a project of another company', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  await run(commands, 'project.archive', { operation_key: key('archive'), project_id: projectId })
  await assert.rejects(
    run(commands, 'project.update', { operation_key: key('update-archived'), project_id: projectId, goal: '归档后改' }),
    error => error.code === 'project/state-conflict',
  )

  const second = await run(commands, 'project.create', {
    operation_key: key('create-2'),
    ...draft(seed_, { name: '另一个项目', coordinator_employee_id: undefined, memory_employee_id: undefined }),
  })
  store.state.projects[second.body.project.id].company_id = 'company_elsewhere'
  await assert.rejects(
    run(commands, 'project.update', { operation_key: key('update-elsewhere'), project_id: second.body.project.id, goal: '跨公司改' }),
    error => error.code === 'project/not-found',
  )
  rmSync(home, { recursive: true, force: true })
})


test('the project group is led by the coordinator, not left to the roster default', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('admin'), ...draft(seed_) })
  const room = created.body.project.group_chat_ref
  // The coordinator is 小蓝's Bot; the roster would have picked a Main Bot the group does not hold.
  assert.equal(rooms.get(room).admin, 'bot_a')
  assert.deepEqual(rooms.get(room).members, ['bot_a'])
  rmSync(home, { recursive: true, force: true })
})

// M1c: an acceptance cannot outlive the project it is waiting on. Archiving closes the
// pending ones on the object itself, leaves decided ones alone, and keeps the response, the
// event and the event journal free of any new shape.
test('archiving closes the pending acceptances of the project (M1c)', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  await run(commands, 'project.start', { operation_key: key('start'), project_id: projectId })

  const pending = await run(commands, 'acceptance.submit', {
    operation_key: key('submit-pending'),
    project_id: projectId,
    requester_employee_id: seed_.alpha,
    title: '第一版交付',
    submitted_version: 'v1',
    acceptance_actor: 'user',
  })
  const pendingId = pending.body.acceptance.id
  assert.equal(pending.body.acceptance.close_reason, null)
  const second = await run(commands, 'acceptance.submit', {
    operation_key: key('submit-decided'),
    project_id: projectId,
    requester_employee_id: seed_.alpha,
    title: '第二版交付',
    submitted_version: 'v2',
    acceptance_actor: 'user',
  })
  const decidedId = second.body.acceptance.id
  await run(commands, 'acceptance.decide', { operation_key: key('decide'), acceptance_id: decidedId, decision: 'accept', expected_revision: 1 })
  const decidedBefore = { ...store.state.acceptances[decidedId] }

  const archived = await run(commands, 'project.archive', { operation_key: key('archive'), project_id: projectId })
  assert.equal(archived.status, 'committed')
  // The closed ids travel on the handler's own list, never on the response.
  assert.deepEqual(Object.keys(archived.body).sort(), ['archived_members', 'left_members', 'project', 'suspended_employees'])
  assert.equal('closed_acceptances' in archived.body, false)

  const closed = store.state.acceptances[pendingId]
  assert.equal(closed.state, 'cancelled')
  assert.equal(closed.close_reason, 'project_archived')
  assert.equal(closed.opinion, null)
  assert.equal(typeof closed.decided_at, 'number')
  assert.equal(closed.updated_at, closed.decided_at)
  assert.equal(closed.revision, 2)

  const kept = store.state.acceptances[decidedId]
  assert.equal(kept.state, 'accepted')
  assert.equal(kept.decided_at, decidedBefore.decided_at)
  assert.equal(kept.revision, decidedBefore.revision)
  // A normal decision carries the field as null, never a closure reason (contract §2.2).
  assert.equal(kept.close_reason, null)

  // No closure event: the archive itself is the visible record (contract §3.5 rule 9).
  const journal = readFileSync(join(home, 'company', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(journal.some(event => event.type === 'acceptance.cancelled'), false)
  assert.equal(journal.at(-1).type, 'project.archived')
  assert.deepEqual(Object.keys(journal.at(-1).data).sort(), ['archived_members', 'left_members', 'suspended_employees'])
  rmSync(home, { recursive: true, force: true })
})
