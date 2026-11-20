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

test('a Bot that already serves a running project can coordinate a second one (v1.18)', async () => {
  // Contract v1.18 replaced PRD D6: one Bot serves several live projects, with its membership
  // kept apart per project. The second project is created and started like the first, and the
  // employee records both projects.
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const first = await run(commands, 'project.create', { operation_key: key('create-1'), ...draft(seed_) })
  await run(commands, 'project.start', { operation_key: key('start-1'), project_id: first.body.project.id })
  const second = await run(commands, 'project.create', { operation_key: key('create-2'), ...draft(seed_, { name: '另一个项目' }) })
  assert.equal(second.status, 'committed')
  const secondStart = await run(commands, 'project.start', { operation_key: key('start-2'), project_id: second.body.project.id })
  assert.equal(secondStart.status, 'committed')

  const coordinator = seed_.alpha
  const ids = store.state.employees[coordinator].project_ids
  assert.deepEqual([...ids].sort(), [first.body.project.id, second.body.project.id].sort())
  assert.equal(store.state.employees[coordinator].project_id, ids[0])
  // Two membership rows, one per project, not one row moved.
  const rows = Object.values(store.state.members).filter(member => member.employee_id === coordinator)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.project_id).sort(), [first.body.project.id, second.body.project.id].sort())
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

test('a role changes while the project runs, and the coordinator post stays single', async () => {
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
  const betaMember = added.body.member.id

  // The post is taken: promoting a second member is refused, not a silent swap.
  await assert.rejects(
    run(commands, 'project.member.update', { operation_key: key('promote-beta'), project_id: projectId, employee_id: seed_.beta, role: 'coordinator' }),
    error => error.code === 'project/coordinator-exists',
  )

  // Stepping down frees it, and the next promotion fills it without touching the group.
  const demoted = await run(commands, 'project.member.update', {
    operation_key: key('demote-alpha'),
    project_id: projectId,
    employee_id: seed_.alpha,
    role: 'acceptor',
  })
  assert.equal(demoted.status, 'committed')
  assert.equal(store.state.projects[projectId].coordinator_assignment_id, null)

  const promoted = await run(commands, 'project.member.update', {
    operation_key: key('promote-beta-again'),
    project_id: projectId,
    employee_id: seed_.beta,
    role: 'coordinator',
  })
  assert.equal(promoted.status, 'committed')
  assert.equal(promoted.body.member.role, 'coordinator')
  assert.equal(store.state.projects[projectId].coordinator_assignment_id, betaMember)
  assert.deepEqual([...rooms.get(created.body.project.group_chat_ref).members].sort(), ['bot_a', 'bot_b'])

  // A member who leaves frees the post too, so the project is never stuck on a ghost.
  await run(commands, 'project.member.remove', { operation_key: key('remove-boss'), project_id: projectId, employee_id: seed_.beta })
  assert.equal(store.state.projects[projectId].coordinator_assignment_id, null)
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

test('archiving keeps a shared memory keeper active while another live project names her', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const first = await run(commands, 'project.create', { operation_key: key('create-shared-a'), ...draft(seed_) })
  const second = await run(commands, 'project.create', { operation_key: key('create-shared-b'), ...draft(seed_, { name: '第二个项目' }) })
  const archived = await run(commands, 'project.archive', { operation_key: key('archive-shared'), project_id: first.body.project.id })

  assert.equal(archived.status, 'committed')
  assert.deepEqual(archived.body.suspended_employees, [])
  assert.equal(store.state.employees[seed_.keeper].status, 'active')
  assert.equal(store.state.projects[second.body.project.id].memory_assignment_id, seed_.keeper)
  rmSync(home, { recursive: true, force: true })
})

test('archiving keeps an employee active when legacy data already bound her to a running project', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const first = await run(commands, 'project.create', { operation_key: key('create-legacy-a'), ...draft(seed_) })
  const second = await run(commands, 'project.create', {
    operation_key: key('create-legacy-b'),
    ...draft(seed_, { name: '第二个项目', memory_employee_id: undefined }),
  })
  // Since v1.18 the API itself writes this state (one Bot in two live projects). Archiving
  // the first project must still not suspend an employee who serves the second one.
  const secondId = second.body.project.id
  store.state.projects[secondId].status = 'active'
  store.state.members.pmm_legacy = {
    id: 'pmm_legacy',
    project_id: secondId,
    employee_id: seed_.keeper,
    role: 'executor',
    membership_status: 'active',
    joined_at: Date.now(),
  }
  const archived = await run(commands, 'project.archive', { operation_key: key('archive-legacy'), project_id: first.body.project.id })
  assert.equal(archived.status, 'committed')
  assert.deepEqual(archived.body.suspended_employees, [])
  assert.equal(store.state.employees[seed_.keeper].status, 'active')
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
  assert.deepEqual(Object.keys(archived.body).sort(), ['archived_members', 'closed_tasks', 'group', 'left_members', 'project', 'suspended_employees', 'unresolved'])
  assert.equal('closed_acceptances' in archived.body, false)
  assert.deepEqual(archived.body.closed_tasks, [])
  assert.deepEqual(archived.body.unresolved, [{ kind: 'acceptance', acceptance_id: pendingId, title: '第一版交付', task_id: null }])

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
  assert.deepEqual(Object.keys(journal.at(-1).data).sort(), ['archived_members', 'closed_tasks', 'group', 'left_members', 'suspended_employees'])
  assert.equal(journal.at(-1).data.group.readonly, true)
  rmSync(home, { recursive: true, force: true })
})

// 4.5: archiving is the one closure that can cancel cards in bulk. It lists what it is
// about to close first, then closes every open card with a reason — a card in Review takes
// its pending record with it — and marks the group read-only for the client.
test('archiving closes open cards with a reason and lists them before closing (4.5)', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  await run(commands, 'project.start', { operation_key: key('start'), project_id: projectId })

  const taskRow = (id, title, stage, createdAt) => ({
    id, project_id: projectId, title, stage, task_revision: 1, created_at: createdAt, updated_at: createdAt,
    acceptance_checks: ['可运行'], hold_reason: 'none', dependencies: [], submissions: [],
  })
  store.state.tasks = {
    tsk_doing: taskRow('tsk_doing', '写服务端', 'doing', 1),
    tsk_review: taskRow('tsk_review', '写界面', 'review', 2),
  }
  store.state.acceptances = {
    acc_done: { id: 'acc_done', project_id: projectId, task_id: null, title: '上一轮交付', state: 'accepted', revision: 2, decided_at: 90, created_at: 90 },
    acc_pending: { id: 'acc_pending', project_id: projectId, task_id: 'tsk_review', task_revision: 2, title: '界面交付', state: 'pending', revision: 1, created_at: 100 },
  }

  const archived = await run(commands, 'project.archive', { operation_key: key('archive'), project_id: projectId })
  assert.equal(archived.status, 'committed')
  assert.deepEqual(archived.body.closed_tasks, [
    { task_id: 'tsk_doing', title: '写服务端', stage: 'doing' },
    { task_id: 'tsk_review', title: '写界面', stage: 'review' },
  ])
  assert.deepEqual(archived.body.unresolved, [
    { kind: 'task', task_id: 'tsk_doing', title: '写服务端', stage: 'doing' },
    { kind: 'task', task_id: 'tsk_review', title: '写界面', stage: 'review' },
    { kind: 'acceptance', acceptance_id: 'acc_pending', title: '界面交付', task_id: 'tsk_review' },
  ])
  for (const id of ['tsk_doing', 'tsk_review']) {
    const row = store.state.tasks[id]
    assert.equal(row.stage, 'cancelled')
    assert.equal(row.cancel_reason, 'project_archived')
    assert.equal(row.task_revision, 2)
    assert.equal(row.cancelled_at, row.updated_at)
  }
  assert.equal(store.state.acceptances.acc_pending.state, 'cancelled')
  assert.equal(store.state.acceptances.acc_pending.close_reason, 'project_archived')
  assert.equal(store.state.projects[projectId].group_binding.readonly, true)
  assert.equal(archived.body.group.status, 'readonly_client')
  assert.equal(archived.body.group.enforced, 'client')
  rmSync(home, { recursive: true, force: true })
})

test('archiving refuses a project whose Done card has no accepted record (4.5)', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  await run(commands, 'project.start', { operation_key: key('start'), project_id: projectId })
  // Legacy or hand-written data: a Done card without the accepted record 4.4 writes.
  store.state.tasks = { tsk_done: { id: 'tsk_done', project_id: projectId, title: '已交付但无记录', stage: 'done', task_revision: 2, created_at: 1 } }

  await assert.rejects(
    run(commands, 'project.archive', { operation_key: key('archive-refused'), project_id: projectId }),
    error => error.code === 'project/acceptance-required' && error.details.tasks === 1,
  )
  assert.equal(store.state.projects[projectId].status, 'active')
  assert.equal(store.state.tasks.tsk_done.stage, 'done')
  rmSync(home, { recursive: true, force: true })
})

test('archiving refuses while a dispatched Run is still working (4.5)', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  await run(commands, 'project.start', { operation_key: key('start'), project_id: projectId })
  store.state.tasks = { tsk_doing: { id: 'tsk_doing', project_id: projectId, title: '还在做', stage: 'doing', task_revision: 1, created_at: 1 } }
  store.state.acceptances = { acc_done: { id: 'acc_done', project_id: projectId, task_id: null, title: '上一轮', state: 'accepted', revision: 2, created_at: 90 } }
  store.state.runs = { run_1: { id: 'run_1', project_id: projectId, task_id: 'tsk_doing', state: 'dispatched', ended_at: null } }

  await assert.rejects(
    run(commands, 'project.archive', { operation_key: key('archive-run'), project_id: projectId }),
    error => error.code === 'project/runs-active' && error.details.runs[0].run_id === 'run_1',
  )
  assert.equal(store.state.projects[projectId].status, 'active')

  // A Run that already failed no longer blocks; the card is closed by the archive.
  store.state.runs.run_1.state = 'failed'
  store.state.runs.run_1.ended_at = 99
  const archived = await run(commands, 'project.archive', { operation_key: key('archive-after-fail'), project_id: projectId })
  assert.equal(archived.status, 'committed')
  assert.equal(store.state.tasks.tsk_doing.stage, 'cancelled')
  rmSync(home, { recursive: true, force: true })
})

test('a missing project group is marked for a check and never rebuilt by the archive (4.5)', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const projectId = created.body.project.id
  const roomId = created.body.project.group_chat_ref
  rooms.delete(roomId)

  const archived = await run(commands, 'project.archive', { operation_key: key('archive-missing'), project_id: projectId })
  assert.equal(archived.status, 'committed')
  assert.equal(archived.body.group.status, 'missing')
  assert.equal(archived.body.group.readonly, true)
  assert.equal(store.state.projects[projectId].group_binding.status, 'pending')
  assert.equal(store.state.projects[projectId].group_binding.readonly, true)
  assert.equal(rooms.size, 1) // only the department room; no new project room
  rmSync(home, { recursive: true, force: true })
})

test('an empty project without a group archives and still carries the read-only mark (4.5)', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_), coordinator_employee_id: undefined })
  const projectId = created.body.project.id
  assert.equal(created.body.project.group_chat_ref, null)
  assert.equal(created.body.project.group_binding.status, 'unbound')

  const archived = await run(commands, 'project.archive', { operation_key: key('archive'), project_id: projectId })
  assert.equal(archived.status, 'committed')
  assert.equal(archived.body.group.status, 'unbound')
  assert.equal(archived.body.group.readonly, true)
  assert.equal(store.state.projects[projectId].group_binding.readonly, true)
  assert.ok(store.state.projects[projectId].group_binding.checked_at > 0)
  rmSync(home, { recursive: true, force: true })
})

// M1b-2.4: a dismissal is about live work, not about the row. A project that still names
// the employee refuses it and says which post; once the work is handed over, the same
// dismissal goes through.
test('a project that still names an employee refuses the dismissal and says which post', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create'), ...draft(seed_) })
  const project = created.body.project

  const coordinator = await run(commands, 'employee.update', { operation_key: key('dismiss-alpha'), employee_id: seed_.alpha, status: 'disabled' }).catch(error => error)
  assert.equal(coordinator.code, 'employee/still-referenced')
  assert.deepEqual(coordinator.details.projects.map(entry => entry.roles), [['coordinator']])
  assert.equal(coordinator.details.projects[0].project_id, project.id)
  assert.match(coordinator.message, /coordinator on DS Bot Company M1/)

  const acceptor = await run(commands, 'employee.update', { operation_key: key('dismiss-beta'), employee_id: seed_.beta, status: 'disabled' }).catch(error => error)
  assert.equal(acceptor.code, 'employee/still-referenced')
  assert.deepEqual(acceptor.details.projects[0].roles, ['acceptor'])

  const keeper = await run(commands, 'employee.update', { operation_key: key('dismiss-keeper'), employee_id: seed_.keeper, status: 'disabled' }).catch(error => error)
  assert.equal(keeper.code, 'employee/still-referenced')
  assert.deepEqual(keeper.details.projects[0].roles, ['memory keeper'])

  // Handing the post over is the way out: removing the coordinator empties the seat.
  await run(commands, 'project.member.remove', { operation_key: key('remove-alpha'), project_id: project.id, employee_id: seed_.alpha })
  const dismissed = await run(commands, 'employee.update', { operation_key: key('dismiss-alpha-again'), employee_id: seed_.alpha, status: 'disabled' })
  assert.equal(dismissed.body.employee.status, 'disabled')

  // A dismissed employee is not a member of anything any more.
  const readded = await run(commands, 'project.member.add', { operation_key: key('add-alpha'), project_id: project.id, employee_id: seed_.alpha, role: 'executor' }).catch(error => error)
  assert.equal(readded.code, 'employee/inactive')
  assert.equal(readded.details.field, 'employee_id')
  rmSync(home, { recursive: true, force: true })
})

test('a dismissed employee cannot be named in a new project', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const extra = await run(commands, 'employee.create', {
    operation_key: key('delta'),
    bot_id: 'bot_d',
    department_id: seed_.department,
    name: '键盘',
  })
  await run(commands, 'employee.update', { operation_key: key('dismiss-delta'), employee_id: extra.aggregate_id, status: 'disabled' })

  const asCoordinator = await run(commands, 'project.create', {
    operation_key: key('create-delta'),
    ...draft(seed_, { coordinator_employee_id: extra.aggregate_id }),
  }).catch(error => error)
  assert.equal(asCoordinator.code, 'employee/inactive')
  assert.equal(asCoordinator.details.field, 'coordinator_employee_id')

  const asAcceptor = await run(commands, 'project.create', {
    operation_key: key('create-delta-acceptor'),
    ...draft(seed_, { acceptance_actor: extra.aggregate_id }),
  }).catch(error => error)
  assert.equal(asAcceptor.code, 'employee/inactive')
  assert.equal(asAcceptor.details.field, 'acceptance_actor')

  const asKeeper = await run(commands, 'project.create', {
    operation_key: key('create-delta-keeper'),
    ...draft(seed_, { memory_employee_id: extra.aggregate_id }),
  }).catch(error => error)
  assert.equal(asKeeper.code, 'employee/inactive')
  assert.equal(asKeeper.details.field, 'memory_employee_id')

  // Nothing was written by any of the three refusals.
  const projects = await run(commands, 'project.list', { operation_key: key('list') })
  assert.equal(projects.body.projects.length, 0)
  rmSync(home, { recursive: true, force: true })
})

test('a membership carries differences that apply only inside one project (v1.18)', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const seed_ = await seed(commands, rooms)
  const created = await run(commands, 'project.create', { operation_key: key('create-diff'), ...draft(seed_) })
  const projectId = created.body.project.id
  const memberId = created.body.member.id
  const before = store.state.members[memberId].configuration_version

  const written = await run(commands, 'project.member.update', {
    operation_key: key('diff-write'),
    project_id: projectId,
    employee_id: seed_.alpha,
    local_diff: { model: 'deepseek/deepseek-reasoner', instructions: '  这个项目里先给结论。  ' },
  })
  assert.equal(written.status, 'committed')
  assert.deepEqual(written.body.member.local_diff, { model: 'deepseek/deepseek-reasoner', instructions: '这个项目里先给结论。' })
  assert.equal(written.body.member.configuration_version, before + 1)
  assert.match(readFileSync(store.eventsPath, 'utf8'), /"type":"project\.member\.updated".*"local_diff"/)

  // The same difference again changes nothing, so no revision is spent on it.
  const revisionBefore = store.state.revision
  const again = await run(commands, 'project.member.update', {
    operation_key: key('diff-again'),
    project_id: projectId,
    employee_id: seed_.alpha,
    local_diff: { model: 'deepseek/deepseek-reasoner', instructions: '这个项目里先给结论。' },
  })
  assert.equal(store.state.revision, revisionBefore)
  assert.equal(again.status, 'ok')

  // Keys the membership does not hold, and shapes that are not an object, are refused.
  await assert.rejects(
    run(commands, 'project.member.update', { operation_key: key('diff-bad-key'), project_id: projectId, employee_id: seed_.alpha, local_diff: { temperature: '1' } }),
    error => error.code === 'company/invalid' && error.details.field === 'local_diff',
  )
  await assert.rejects(
    run(commands, 'project.member.update', { operation_key: key('diff-bad-shape'), project_id: projectId, employee_id: seed_.alpha, local_diff: ['model'] }),
    error => error.code === 'company/invalid' && error.details.field === 'local_diff',
  )

  // Null clears it, and the post she holds is untouched.
  const cleared = await run(commands, 'project.member.update', { operation_key: key('diff-clear'), project_id: projectId, employee_id: seed_.alpha, local_diff: null })
  assert.equal(cleared.body.member.local_diff, null)
  assert.equal(cleared.body.member.role, 'coordinator')
  rmSync(home, { recursive: true, force: true })
})
