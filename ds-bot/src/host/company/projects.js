// Project commands: a project, its members, and the group chat a project lives in.
//
// A project is a temporary group pulled from departments, and its chat is the project
// group itself (PRD 6.1): a project created with a coordinator makes its group at once,
// while a draft created without one stays `unbound` until its first member arrives or it
// starts (the coordinator is a start-time requirement, spec :35). The group is made
// through the roster once; a group that was bound and then goes missing or drifting is
// never rebuilt silently — the command fails with `project/group-pending` and
// `project.group.reconcile` is the explicit repair.
//
// Conditions that would make a project unstartable are collected and reported together
// (`readiness.blockers`), so the screen can show everything missing in one pass.
import { randomUUID } from 'node:crypto'
import { companyFail } from './store.js'
import { actorKindOf, isOwnerActor } from './access.js'

// Shared with the acceptance objects (acceptances.js): one id shape for the whole company.
export const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`

const text = (value, field, { max = 120, min = 1 } = {}) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length < min) throw companyFail('company/invalid', `${field} is required.`, { field })
  if (trimmed.length > max) throw companyFail('company/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return trimmed
}

const optionalText = (value, field, max = 2000) => (value === undefined || value === null || value === '' ? undefined : text(value, field, { max }))

export const ACCEPTANCE_REQUIREMENTS = ['daily_independent_bot', 'owner_only']
// What `project.update` may change after the draft exists (PRD 7.1: the coordinator,
// acceptance, memory keeper and workspace are configured after creation). Identity,
// source departments and status are fixed here; the coordinator arrives through
// `project.member.add` with role `coordinator`.
export const UPDATABLE_FIELDS = ['name', 'goal', 'deliverable', 'acceptance', 'workspace_ref', 'acceptance_actor', 'acceptance_requirement', 'memory_assignment_id']
const OPEN = ['setup', 'active']
// Every status in which a project still holds people. Archiving one project must not take an
// employee out of another project she still serves, so these are the statuses checked before
// a memory keeper is suspended.
const LIVE = ['setup', 'active', 'paused', 'delivering']
const MEMBER_ROLES = ['executor', 'coordinator', 'acceptor', 'memory_keeper']

const activeMembers = (state, projectId) => Object.values(state.members)
  .filter(member => member.project_id === projectId && member.membership_status === 'active')
  .sort((left, right) => left.joined_at - right.joined_at)

// One Bot may serve several live projects (contract v1.18 replaced PRD D6): its memberships,
// workspace and sessions are kept apart per project, and memory stays shared with each entry
// tagged by its source project. What is left of the old rule is the question archiving asks —
// does this employee still serve another live project? — so the lookup answers "the other
// running membership", not "a reason to refuse".
const RUNNING = ['active', 'paused', 'delivering']
const runningMembership = (state, employeeId, exceptProjectId = null) => Object.values(state.members)
  .find(member => member.employee_id === employeeId
    && member.project_id !== exceptProjectId
    && member.membership_status === 'active'
    && RUNNING.includes(state.projects[member.project_id]?.status))

// PRD 批 1 T5: one Bot serves at most three live projects at once. The cap counts running
// projects only — a draft in setup holds no work yet — and it is enforced at every door that
// adds an employee to a project, not at start, so the refusal names the number up front.
export const PROJECT_MEMBER_LIMIT = 3
// Both kinds of service count: a membership row, and a project that named this employee its
// memory keeper. The keeper is not a member (no group seat), so counting rows alone would
// let one person hold an unbounded number of live projects.
const liveProjectsOf = (state, employeeId) => {
  const ids = new Set()
  for (const member of Object.values(state.members)) {
    if (member.employee_id === employeeId && member.membership_status === 'active' && RUNNING.includes(state.projects[member.project_id]?.status)) ids.add(member.project_id)
  }
  for (const project of Object.values(state.projects)) {
    if (project.memory_assignment_id === employeeId && RUNNING.includes(project.status)) ids.add(project.id)
  }
  return [...ids]
}
const assertMemberRoom = (state, employee) => {
  const live = liveProjectsOf(state, employee.id)
  if (live.length < PROJECT_MEMBER_LIMIT) return
  throw companyFail('project/member-limit', `${employee.name} already serves ${live.length} live projects; the limit is ${PROJECT_MEMBER_LIMIT}. Leave one before adding another.`, { employee_id: employee.id, limit: PROJECT_MEMBER_LIMIT, project_ids: live })
}

// The projects an employee is part of, kept in one place so `project_id` (the first, and the
// one older screens read) cannot drift from the membership rows.
const joinProject = (employee, projectId) => {
  const ids = Array.isArray(employee.project_ids) ? employee.project_ids : []
  if (!ids.includes(projectId)) ids.push(projectId)
  employee.project_ids = ids
  employee.project_id = ids[0] ?? null
}

const leaveProject = (employee, projectId) => {
  const ids = (Array.isArray(employee.project_ids) ? employee.project_ids : []).filter(id => id !== projectId)
  employee.project_ids = ids
  employee.project_id = ids[0] ?? null
}

const companyOf = state => {
  const company = Object.values(state.companies).find(entry => entry.status !== 'archived')
  if (company === undefined) throw companyFail('company/not-found', 'Create the company before its projects.', {})
  return company
}

const projectOf = (state, id) => {
  const project = state.projects[id]
  if (project === undefined) throw companyFail('project/not-found', `No project ${id}.`, { project_id: id })
  return project
}

const departmentOf = (state, id) => {
  const department = state.departments[id]
  if (department === undefined || department.status === 'archived') throw companyFail('department/not-found', `No department ${id}.`, { field: 'department_id', department_id: id })
  return department
}

const employeeOf = (state, id) => {
  const employee = state.employees[id]
  if (employee === undefined) throw companyFail('employee/not-found', `No employee ${id}.`, { employee_id: id })
  return employee
}

const employeeRole = (value) => {
  const role = value ?? 'executor'
  if (!MEMBER_ROLES.includes(role)) throw companyFail('company/invalid', `role is one of ${MEMBER_ROLES.join(', ')}.`, { field: 'role', allowed: MEMBER_ROLES })
  return role
}

// A membership may carry differences that apply only inside this project (contract v1.18):
// another model, another thinking level, or extra instructions. The Bot itself is untouched,
// so the same employee can look different in each project she serves. Every key is optional
// and a null value clears that key; an empty result is stored as null, not as `{}`.
export const LOCAL_DIFF_KEYS = ['model', 'effort', 'instructions']
const localDiffOf = (value) => {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw companyFail('company/invalid', 'local_diff is an object of model, effort and instructions.', { field: 'local_diff', allowed: LOCAL_DIFF_KEYS })
  const unknown = Object.keys(value).filter(key => !LOCAL_DIFF_KEYS.includes(key))
  if (unknown.length > 0) throw companyFail('company/invalid', `local_diff only holds ${LOCAL_DIFF_KEYS.join(', ')}.`, { field: 'local_diff', unknown, allowed: LOCAL_DIFF_KEYS })
  const diff = {}
  for (const key of LOCAL_DIFF_KEYS) {
    if (value[key] === undefined) continue
    if (value[key] === null) continue
    if (typeof value[key] !== 'string') throw companyFail('company/invalid', `local_diff.${key} is a string or null.`, { field: `local_diff.${key}` })
    const trimmed = value[key].trim()
    if (trimmed === '') continue
    if (trimmed.length > 8000) throw companyFail('company/invalid', `local_diff.${key} is longer than 8000 characters.`, { field: `local_diff.${key}` })
    diff[key] = trimmed
  }
  return Object.keys(diff).length === 0 ? null : diff
}

const requirementOf = (value) => {
  const requirement = value ?? 'daily_independent_bot'
  if (!ACCEPTANCE_REQUIREMENTS.includes(requirement)) throw companyFail('company/invalid', `acceptance_requirement is one of ${ACCEPTANCE_REQUIREMENTS.join(', ')}.`, { field: 'acceptance_requirement', allowed: ACCEPTANCE_REQUIREMENTS })
  return requirement
}

// `user` is the owner; anything else names an employee. owner_only work can only be
// accepted by the owner, so naming a Bot there is refused where it is configured, not
// only where acceptance would happen.
const acceptanceActorOf = (state, value, requirement, field = 'acceptance_actor') => {
  if (value === undefined || value === null || value === '') {
    if (requirement === 'owner_only') throw companyFail('project/owner-required', 'owner_only acceptance belongs to the owner; set acceptance_actor to "user".', { field })
    return undefined
  }
  const kind = actorKindOf(state, value)
  if (kind === 'owner') return 'user'
  if (kind === 'human') {
    const human = state.actors[value]
    if (human.status !== 'active') throw companyFail('actor/inactive', `Person ${human.name ?? value} is disabled; restore them before naming them as the acceptor.`, { field, actor_id: value })
    if (requirement === 'owner_only') throw companyFail('project/owner-required', 'owner_only acceptance belongs to the owner, not to a person.', { field, actor_id: value })
    return value
  }
  const employee = employeeOf(state, text(value, field, { max: 120 }))
  if (employee.status !== 'active') throw companyFail('employee/inactive', `Employee ${employee.id} is dismissed; re-activate them before naming them as the acceptor.`, { field, employee_id: employee.id })
  if (requirement === 'owner_only') throw companyFail('project/owner-required', 'owner_only acceptance belongs to the owner, not to a Bot.', { field, employee_id: employee.id })
  return employee.id
}

const expectedBots = (state, projectId) => activeMembers(state, projectId)
  .map(member => state.employees[member.employee_id]?.bot_id)
  .filter(botId => typeof botId === 'string')

const sameMembers = (left, right) => left.length === right.length && [...left].sort().join('\n') === [...right].sort().join('\n')

/**
 * The Bot that should lead the project group (M1b-1 item 4).
 *
 * The roster picks an admin of its own — the first Main Bot in the group — which a project
 * group usually does not hold, so the group ended up without one and every plain message was
 * answered by every member in turn. The coordinator is the member the project is run by, so it
 * leads the group when it is there. A draft with no coordinator keeps the roster's default.
 */
const coordinatorBot = (state, project, members) => {
  const assignment = project?.coordinator_assignment_id == null ? undefined : state?.members?.[project.coordinator_assignment_id]
  const employee = assignment === undefined ? undefined : state?.employees?.[assignment.employee_id]
  const botId = employee?.bot_id
  return typeof botId === 'string' && members.includes(botId) ? botId : undefined
}

// One project as a screen reads it: the record, its active members, and the group chat it
// lives in with the drift already worked out. Shared by `project.get` and the HTTP read
// model, so both answer the same shape.
export const projectDetailOf = (state, project, roomMembers) => {
  const actual = roomMembers(project)
  return {
    project,
    members: activeMembers(state, project.id),
    group: {
      group_chat_ref: project.group_chat_ref,
      group_binding: project.group_binding ?? null,
      members: actual ?? null,
      drifted: actual === undefined ? null : !sameMembers(actual, expectedBots(state, project.id)),
    },
  }
}

export function projectHandlers({ groups = {} } = {}) {
  const rooms = {
    create: undefined,
    members: undefined,
    setMembers: undefined,
    ...groups,
  }

  const groupFailure = (project, action, error) => companyFail('project/group-pending', `The project group ${project.group_chat_ref ?? ''} needs attention (${action}): ${error?.message ?? error}. Run project.group.reconcile.`, { project_id: project.id, room_id: project.group_chat_ref ?? null })

  async function bindGroup(project, name, members, now, state) {
    if (typeof rooms.create !== 'function') throw companyFail('project/group-failed', 'This dsh cannot create a group chat, so the project group was not made.', { project_id: project.id })
    let created
    try {
      created = await rooms.create({ name, members, admin: coordinatorBot(state, project, members) })
    } catch (error) {
      throw companyFail('project/group-failed', `The project group could not be created: ${error?.message ?? error}`, { project_id: project.id })
    }
    const roomId = typeof created === 'string' ? created : created?.id
    if (typeof roomId !== 'string' || roomId === '') throw companyFail('project/group-failed', 'The roster did not return a group id for the project group.', { project_id: project.id })
    project.group_chat_ref = roomId
    project.group_binding = { status: 'bound', room_id: roomId, synced_at: now() }
    return roomId
  }

  async function syncGroup(project, members, now) {
    if (typeof rooms.setMembers !== 'function') throw companyFail('project/group-failed', 'This dsh cannot change group members, so the project group was left alone.', { project_id: project.id })
    await rooms.setMembers(project.group_chat_ref, members)
    project.group_binding = { ...project.group_binding, status: 'bound', room_id: project.group_chat_ref, synced_at: now(), error: null }
  }

  // The coordinator post is also the group admin: promoting or demoting a member moves it
  // in the same breath, so the group never keeps an admin nobody holds. A host that cannot
  // change a group leaves it alone and the caller falls back to a reconcile warning.
  async function syncAdmin(project, state, now) {
    if (typeof rooms.setAdmin !== 'function') return
    const admin = coordinatorBot(state, project, expectedBots(state, project.id)) ?? null
    await rooms.setAdmin(project.group_chat_ref, admin)
    project.group_binding = { ...project.group_binding, status: 'bound', room_id: project.group_chat_ref, synced_at: now(), error: null }
  }

  // The member change is already in the state when the group refuses it; the save is kept
  // and the drift is reported as a warning on the success envelope, so the screen can say
  // "saved, group needs reconciling" instead of losing the edit or failing silently.
  const markPending = (project, action, error, now) => {
    project.group_binding = { ...project.group_binding, status: 'pending', room_id: project.group_chat_ref, error: `${action}: ${error?.message ?? error}`, failed_at: now() }
    return {
      code: 'group_pending',
      message: `The project was saved, but its group chat needs reconciling (${action}): ${error?.message ?? error}. Run project.group.reconcile.`,
      project_id: project.id,
      room_id: project.group_chat_ref,
    }
  }

  const roomMembers = (project) => {
    if (typeof rooms.members !== 'function') return undefined
    if (project.group_chat_ref == null) return undefined
    return rooms.members(project.group_chat_ref)
  }

  return {
    'project.create': async ({ state, payload, now }) => {
      const company = companyOf(state)
      const name = text(payload.name, 'name', { max: 80 })
      const goal = text(payload.goal, 'goal', { max: 2000 })
      const deliverable = text(payload.deliverable ?? payload.delivery, 'deliverable', { max: 2000 })
      const acceptance = text(payload.acceptance, 'acceptance', { max: 2000 })
      const sourceIds = Array.isArray(payload.source_department_ids) ? [...new Set(payload.source_department_ids)] : []
      if (sourceIds.length === 0) throw companyFail('project/invalid', 'source_department_ids needs at least one department.', { field: 'source_department_ids' })
      for (const departmentId of sourceIds) departmentOf(state, text(departmentId, 'source_department_ids', { max: 120 }))

      // The coordinator is required to start, not to create (spec :35). A draft made
      // without one has no group chat yet, because there is nobody to put in it.
      const coordinator = payload.coordinator_employee_id === undefined || payload.coordinator_employee_id === null || payload.coordinator_employee_id === ''
        ? undefined
        : employeeOf(state, text(payload.coordinator_employee_id, 'coordinator_employee_id', { max: 120 }))
      if (coordinator !== undefined) {
        if (coordinator.status !== 'active') throw companyFail('employee/inactive', `Employee ${coordinator.id} is dismissed; re-activate them before making them the coordinator.`, { field: 'coordinator_employee_id', employee_id: coordinator.id })
        if (!sourceIds.includes(coordinator.department_id)) {
          throw companyFail('project/invalid', `The coordinator must come from one of the source departments.`, { field: 'coordinator_employee_id', department_id: coordinator.department_id, source_department_ids: sourceIds })
        }
        if (coordinator.bot_id === null || coordinator.bot_id === undefined || coordinator.bot_id === '') {
          throw companyFail('project/coordinator-without-bot', `${coordinator.name} has no Bot yet, so the project group cannot hold them. Bind a Bot on the employee profile, or pick another coordinator.`, { field: 'coordinator_employee_id', employee_id: coordinator.id })
        }
      }
      if (coordinator !== undefined) assertMemberRoom(state, coordinator)
      const requirement = requirementOf(payload.acceptance_requirement)
      const acceptanceActor = acceptanceActorOf(state, payload.acceptance_actor, requirement)
      const memoryEmployee = payload.memory_employee_id === undefined ? undefined : employeeOf(state, text(payload.memory_employee_id, 'memory_employee_id', { max: 120 }))
      if (memoryEmployee !== undefined && memoryEmployee.status !== 'active') throw companyFail('employee/inactive', `Employee ${memoryEmployee.id} is dismissed; re-activate them before naming them as the memory keeper.`, { field: 'memory_employee_id', employee_id: memoryEmployee.id })
      if (memoryEmployee !== undefined) assertMemberRoom(state, memoryEmployee)

      const projectId = newId('prj')
      const project = {
        id: projectId,
        company_id: company.id,
        name,
        goal,
        deliverable,
        acceptance,
        source_department_ids: sourceIds,
        status: 'setup',
        group_chat_ref: null,
        group_binding: { status: 'unbound', room_id: null, synced_at: null },
        coordinator_assignment_id: null,
        acceptance_actor: acceptanceActor ?? null,
        acceptance_requirement: requirement,
        memory_assignment_id: memoryEmployee?.id ?? null,
        workspace_ref: optionalText(payload.workspace_ref, 'workspace_ref', 500) ?? null,
        scope_policy_version: 'm1a',
        approval_binding: null,
        chat_refs: [],
        active_baseline_revision: 0,
        created_at: now(),
        updated_at: now(),
        revision: 1,
      }
      state.projects[projectId] = project
      // A draft without a coordinator is complete as it is: no membership, no group. It
      // becomes a real project when a member is added (the first member makes the group)
      // or when `project.start` passes its checks and makes the group then.
      if (coordinator === undefined) {
        return {
          aggregate_id: projectId,
          body: { project, member: null, project_member: null, group_chat_ref: null },
          events: [{ type: 'project.created', data: { name, source_department_ids: sourceIds } }],
        }
      }
      const memberId = newId('pmm')
      const member = {
        id: memberId,
        project_id: projectId,
        employee_id: coordinator.id,
        role: 'coordinator',
        role_definition_version: 'm1a.1',
        membership_status: 'active',
        joined_at: now(),
        left_at: null,
        archived_at: null,
        assignment_scope: 'project',
        configuration_version: 1,
        source_template_version: null,
        local_diff: null,
        // Nothing is known to be missing yet: the Bot, its model and its skills are
        // checked by the host when the project starts.
        readiness: ['ready'],
      }
      state.members[memberId] = member
      project.coordinator_assignment_id = memberId
      joinProject(coordinator, projectId)
      const roomId = await bindGroup(project, name, [coordinator.bot_id], now, state)
      return {
        aggregate_id: projectId,
        body: { project, member, project_member: member, group_chat_ref: roomId },
        events: [
          { type: 'project.created', data: { name, source_department_ids: sourceIds } },
          { type: 'project.group.bound', data: { room_id: roomId } },
        ],
      }
    },

    // The draft is editable while it is setup, and also while it is active: the project
    // page fills in what creation left out. Only the fields below are writable; the
    // operation key and expected_revision come from the envelope, so a stale screen or a
    // retried request is caught before anything changes.
    'project.update': async ({ state, payload, now }) => {
      const project = projectOf(state, text(payload.project_id, 'project_id', { max: 120 }))
      const company = companyOf(state)
      // One company per M1: a project outside it is not addressed by this company's
      // screen, and answering as if it were would let a stale id write across companies.
      if (project.company_id !== company.id) {
        throw companyFail('project/not-found', `No project ${project.id} in this company.`, { project_id: project.id })
      }
      if (!OPEN.includes(project.status)) throw companyFail('project/state-conflict', `A project in ${project.status} cannot be changed.`, { project_id: project.id, status: project.status })
      const changes = []
      const setField = (field, max) => {
        if (payload[field] === undefined) return
        project[field] = text(payload[field], field, { max })
        changes.push(field)
      }
      setField('name', 80)
      setField('goal', 2000)
      setField('deliverable', 2000)
      setField('acceptance', 2000)
      if (payload.workspace_ref !== undefined) {
        project.workspace_ref = optionalText(payload.workspace_ref, 'workspace_ref', 500) ?? null
        changes.push('workspace_ref')
      }
      // Both halves of the acceptance pair are read before either is written: one request may
      // raise the requirement to owner_only and name the owner at the same time, and judging
      // the new requirement against the old actor would refuse a change that is in fact whole.
      const nextRequirement = payload.acceptance_requirement === undefined
        ? project.acceptance_requirement
        : requirementOf(payload.acceptance_requirement)
      const actorGiven = payload.acceptance_actor !== undefined
      const nextActor = actorGiven
        ? acceptanceActorOf(state, payload.acceptance_actor, nextRequirement) ?? null
        : project.acceptance_actor
      // owner_only work can only be accepted by the owner, so owner_only can never be left
      // with a Bot or nobody as the actor — it would create a project that can never be
      // accepted.
      if (nextRequirement === 'owner_only' && !isOwnerActor(state, nextActor)) {
        throw companyFail('project/owner-required', 'owner_only acceptance belongs to the owner; set acceptance_actor to "user".', { field: 'acceptance_actor' })
      }
      if (payload.acceptance_requirement !== undefined) {
        project.acceptance_requirement = nextRequirement
        changes.push('acceptance_requirement')
      }
      if (actorGiven) {
        project.acceptance_actor = nextActor
        changes.push('acceptance_actor')
      }
      if (payload.memory_assignment_id !== undefined) {
        const keeper = payload.memory_assignment_id === null || payload.memory_assignment_id === ''
          ? null
          : employeeOf(state, text(payload.memory_assignment_id, 'memory_assignment_id', { max: 120 }))
        if (keeper !== null) {
          if (keeper.status !== 'active') throw companyFail('employee/inactive', `Employee ${keeper.id} is dismissed; re-activate them before naming them as the memory keeper.`, { field: 'memory_assignment_id', employee_id: keeper.id })
          if (keeper.company_id !== project.company_id) throw companyFail('project/invalid', `Employee ${keeper.id} belongs to another company.`, { field: 'memory_assignment_id' })
        }
        project.memory_assignment_id = keeper?.id ?? null
        changes.push('memory_assignment_id')
      }
      if (changes.length === 0) throw companyFail('company/invalid', `project.update changes one of: ${UPDATABLE_FIELDS.join(', ')}.`, { fields: UPDATABLE_FIELDS })
      project.updated_at = now()
      project.revision += 1
      return { aggregate_id: project.id, body: { project }, events: [{ type: 'project.updated', data: { fields: changes } }] }
    },

    'project.get': ({ state, payload }) => {
      const project = projectOf(state, text(payload.project_id, 'project_id', { max: 120 }))
      return { aggregate_id: project.id, mutates: false, body: projectDetailOf(state, project, roomMembers) }
    },

    'project.list': ({ state, payload }) => {
      const company = Object.values(state.companies).find(entry => entry.status !== 'archived')
      const projects = Object.values(state.projects)
        .filter(project => company === undefined || project.company_id === company.id)
        .filter(project => payload.status === undefined || project.status === payload.status)
        .sort((left, right) => left.created_at - right.created_at)
      return { aggregate_id: company?.id ?? null, mutates: false, body: { projects } }
    },

    'project.member.add': async ({ state, payload, now }) => {
      const project = projectOf(state, text(payload.project_id, 'project_id', { max: 120 }))
      if (!OPEN.includes(project.status)) throw companyFail('project/state-conflict', `A project in ${project.status} cannot take members.`, { project_id: project.id, status: project.status })
      const role = employeeRole(payload.role)
      const employee = employeeOf(state, text(payload.employee_id, 'employee_id', { max: 120 }))
      if (employee.status !== 'active') throw companyFail('employee/inactive', `Employee ${employee.id} is dismissed; re-activate them before adding them to a project.`, { field: 'employee_id', employee_id: employee.id })
      const already = Object.values(state.members).find(member => member.project_id === project.id && member.employee_id === employee.id && member.membership_status !== 'left')
      if (already !== undefined) throw companyFail('project/member-exists', `Employee ${employee.id} is already in this project.`, { project_id: project.id, employee_id: employee.id, membership_status: already.membership_status })
      assertMemberRoom(state, employee)
      // The coordinator post is one, and it is filled by the first member given that role
      // (a draft created without a coordinator is completed this way).
      if (role === 'coordinator') {
        const current = project.coordinator_assignment_id == null ? undefined : state.members[project.coordinator_assignment_id]
        if (current !== undefined && current.membership_status === 'active') {
          throw companyFail('project/coordinator-exists', `The project already has a coordinator (${current.employee_id}).`, { project_id: project.id, coordinator_assignment_id: current.id })
        }
        if (!project.source_department_ids.includes(employee.department_id)) {
          throw companyFail('project/invalid', 'The coordinator must come from one of the source departments.', { field: 'employee_id', department_id: employee.department_id, source_department_ids: project.source_department_ids })
        }
      }
      const memberId = newId('pmm')
      const member = {
        id: memberId,
        project_id: project.id,
        employee_id: employee.id,
        role,
        role_definition_version: 'm1a.1',
        membership_status: 'active',
        joined_at: now(),
        left_at: null,
        archived_at: null,
        assignment_scope: 'project',
        configuration_version: 1,
        source_template_version: null,
        local_diff: null,
        readiness: ['ready'],
      }
      state.members[memberId] = member
      joinProject(employee, project.id)
      if (role === 'coordinator') project.coordinator_assignment_id = memberId
      const events = [{ type: 'project.member.added', data: { employee_id: employee.id, role } }]
      let warning
      if (project.group_chat_ref == null) {
        // The first member of a draft that was created without a coordinator makes the
        // group, with everyone the project holds at that point. Refusing here would leave
        // the draft permanently unstartable, since a group can only be made from members.
        const roomId = await bindGroup(project, project.name, expectedBots(state, project.id), now, state)
        events.push({ type: 'project.group.bound', data: { room_id: roomId } })
      } else if (roomMembers(project) === undefined) {
        throw groupFailure(project, 'the project group is missing', 'no group chat')
      } else {
        try {
          await syncGroup(project, expectedBots(state, project.id), now)
        } catch (error) {
          warning = markPending(project, 'the member was saved', error, now)
        }
      }
      project.updated_at = now()
      return { aggregate_id: project.id, body: { project, member }, events, ...(warning === undefined ? {} : { warning }) }
    },

    'project.member.remove': async ({ state, payload, now }) => {
      const project = projectOf(state, text(payload.project_id, 'project_id', { max: 120 }))
      if (!OPEN.includes(project.status)) throw companyFail('project/state-conflict', `A project in ${project.status} cannot change members.`, { project_id: project.id, status: project.status })
      const employee = employeeOf(state, text(payload.employee_id, 'employee_id', { max: 120 }))
      const member = Object.values(state.members).find(entry => entry.project_id === project.id && entry.employee_id === employee.id && ['active', 'invited'].includes(entry.membership_status))
      if (member === undefined) throw companyFail('project/member-not-found', `Employee ${employee.id} is not an active member of this project.`, { project_id: project.id, employee_id: employee.id })
      const membership = payload.membership_status === 'removed' ? 'removed' : 'left'
      member.membership_status = membership
      member.left_at = now()
      member.left_reason = optionalText(payload.reason, 'reason', 500) ?? null
      // The coordinator post belongs to the project, not to the person: a member who
      // leaves frees it, so the next promotion can fill it (the group admin is rebuilt by
      // project.group.reconcile, not here).
      if (project.coordinator_assignment_id === member.id) project.coordinator_assignment_id = null
      // The department does not change: leaving a project ends the membership only, and
      // the employee (and its history) stays where it is (spec member semantics).
      leaveProject(employee, project.id)
      const remaining = expectedBots(state, project.id)
      let warning
      if (roomMembers(project) !== undefined) {
        try {
          await syncGroup(project, remaining, now)
        } catch (error) {
          warning = markPending(project, 'the removal was saved', error, now)
        }
      }
      project.updated_at = now()
      return { aggregate_id: project.id, body: { project, member }, events: [{ type: 'project.member.removed', data: { employee_id: employee.id, membership_status: membership } }], ...(warning === undefined ? {} : { warning }) }
    },

    // The role is what a member does in the project, not who they are: it can change
    // while the project runs, and the Bot stays in the group either way. The coordinator
    // post is still one — promoting a second member is refused, never a silent swap.
    'project.member.update': async ({ state, payload, now }) => {
      const project = projectOf(state, text(payload.project_id, 'project_id', { max: 120 }))
      if (!OPEN.includes(project.status)) throw companyFail('project/state-conflict', `A project in ${project.status} cannot change members.`, { project_id: project.id, status: project.status })
      const employee = employeeOf(state, text(payload.employee_id, 'employee_id', { max: 120 }))
      const member = Object.values(state.members).find(entry => entry.project_id === project.id && entry.employee_id === employee.id && entry.membership_status === 'active')
      if (member === undefined) throw companyFail('project/member-not-found', `Employee ${employee.id} is not an active member of this project.`, { project_id: project.id, employee_id: employee.id })
      // A membership is updated field by field: sending only local_diff must not silently
      // demote the coordinator to the default role.
      const role = payload.role === undefined ? member.role : employeeRole(payload.role)
      const localDiff = payload.local_diff === undefined ? undefined : localDiffOf(payload.local_diff)
      const diffSame = localDiff === undefined || JSON.stringify(localDiff) === JSON.stringify(member.local_diff ?? null)
      if (role === member.role && diffSame) return { aggregate_id: project.id, mutates: false, body: { project, member } }
      if (role === 'coordinator') {
        const current = project.coordinator_assignment_id == null ? undefined : state.members[project.coordinator_assignment_id]
        if (current !== undefined && current.id !== member.id && current.membership_status === 'active') {
          throw companyFail('project/coordinator-exists', `The project already has a coordinator (${current.employee_id}).`, { project_id: project.id, coordinator_assignment_id: current.id })
        }
        if (!project.source_department_ids.includes(employee.department_id)) {
          throw companyFail('project/invalid', 'The coordinator must come from one of the source departments.', { field: 'employee_id', department_id: employee.department_id, source_department_ids: project.source_department_ids })
        }
      }
      const previousRole = member.role
      if (member.role === 'coordinator' && project.coordinator_assignment_id === member.id) project.coordinator_assignment_id = null
      member.role = role
      if (role === 'coordinator') project.coordinator_assignment_id = member.id
      if (localDiff !== undefined) member.local_diff = localDiff
      member.configuration_version = (member.configuration_version ?? 1) + 1
      // A change of role is a change of the group: the member list stays the same, but the
      // admin moves with the coordinator post. Only done when the role really changed.
      let warning
      if (role !== previousRole && roomMembers(project) !== undefined) {
        try {
          await syncGroup(project, expectedBots(state, project.id), now)
          await syncAdmin(project, state, now)
        } catch (error) {
          warning = markPending(project, 'the role was saved', error, now)
        }
      }
      project.updated_at = now()
      return { aggregate_id: project.id, body: { project, member }, events: [{ type: 'project.member.updated', data: { employee_id: employee.id, role, ...(localDiff === undefined ? {} : { local_diff: localDiff }) } }], ...(warning === undefined ? {} : { warning }) }
    },

    'project.start': async ({ state, payload, now }) => {
      const project = projectOf(state, text(payload.project_id, 'project_id', { max: 120 }))
      if (project.status !== 'setup') throw companyFail('project/state-conflict', `Only a project in setup can start; this one is ${project.status}.`, { project_id: project.id, status: project.status })
      const blockers = []
      const members = activeMembers(state, project.id)
      const coordinator = members.find(member => member.id === project.coordinator_assignment_id)
      if (coordinator === undefined) blockers.push({ code: 'missing_input', field: 'coordinator', message: 'Assign a coordinator who is still an active member.' })
      for (const member of members) {
        const employee = state.employees[member.employee_id]
        if (employee === undefined || employee.status !== 'active') {
          blockers.push({ code: 'missing_input', field: 'member', employee_id: member.employee_id, message: `Employee ${member.employee_id} is not active.` })
          continue
        }
        const department = state.departments[employee.department_id]
        if (department === undefined || department.status === 'archived') {
          blockers.push({ code: 'missing_input', field: 'department', employee_id: employee.id, message: `Employee ${employee.id} has no usable department.` })
          continue
        }
        if (department.chat_ref == null || roomMembers({ group_chat_ref: department.chat_ref }) === undefined) {
          blockers.push({ code: 'department_group', department_id: department.id, employee_id: employee.id, message: `Department ${department.name} has no group chat bound.` })
        }
      }
      const requirement = project.acceptance_requirement
      if (requirement === 'owner_only') {
        if (!isOwnerActor(state, project.acceptance_actor)) blockers.push({ code: 'owner_required', field: 'acceptance_actor', message: 'owner_only acceptance belongs to the owner; set acceptance_actor to "user".' })
      } else if (typeof project.acceptance_actor !== 'string' || isOwnerActor(state, project.acceptance_actor)) {
        blockers.push({ code: 'missing_input', field: 'acceptance_actor', message: 'Name the independent acceptance Bot.' })
      } else if (actorKindOf(state, project.acceptance_actor) === 'human') {
        const person = state.actors[project.acceptance_actor]
        if (person?.status !== 'active') blockers.push({ code: 'missing_input', field: 'acceptance_actor', message: 'The acceptance reviewer is not an active person.' })
      } else {
        const acceptor = state.employees[project.acceptance_actor]
        if (acceptor === undefined || acceptor.status !== 'active') blockers.push({ code: 'missing_input', field: 'acceptance_actor', message: 'The acceptance Bot is not an active employee.' })
      }
      if (project.memory_assignment_id == null) blockers.push({ code: 'missing_input', field: 'memory_assignment_id', message: 'Appoint a memory keeper for the project.' })
      else {
        const keeper = state.employees[project.memory_assignment_id]
        if (keeper === undefined || keeper.status !== 'active') blockers.push({ code: 'missing_input', field: 'memory_assignment_id', message: 'The memory keeper is not an active employee.' })
        else if (keeper.acceptance_role !== 'memory_keeper') blockers.push({ code: 'missing_input', field: 'memory_assignment_id', message: 'The employee is not appointed as memory keeper.' })
      }
      if (project.workspace_ref == null) blockers.push({ code: 'missing_input', field: 'workspace_ref', message: 'Give the project a workspace folder.' })
      if (blockers.length > 0) {
        throw companyFail('project/missing-input', `The project cannot start yet: ${blockers.map(blocker => blocker.message).join(' ')}`, { project_id: project.id, blockers })
      }
      const expected = expectedBots(state, project.id)
      const events = []
      // A draft created without a coordinator has no group yet; start makes it now, with the
      // members the project holds. A group that was bound and then vanished is a different
      // case: it still stops the start, and reconcile is the explicit repair.
      if (project.group_chat_ref == null) {
        const roomId = await bindGroup(project, project.name, expected, now, state)
        events.push({ type: 'project.group.bound', data: { room_id: roomId } })
      }
      const actual = roomMembers(project)
      if (actual === undefined) throw companyFail('project/group-pending', 'The project group is missing, so the project cannot start. Run project.group.reconcile.', { project_id: project.id, room_id: project.group_chat_ref })
      if (!sameMembers(actual, expected)) {
        throw companyFail('project/group-pending', `The project group holds ${actual.length} Bot(s), the project has ${expected.length} active member(s). Run project.group.reconcile.`, { project_id: project.id, room_id: project.group_chat_ref, expected, actual })
      }
      project.status = 'active'
      project.started_at = now()
      project.updated_at = now()
      project.revision += 1
      project.group_binding = { ...project.group_binding, status: 'bound', room_id: project.group_chat_ref, synced_at: now() }
      events.push({ type: 'project.started', data: { room_id: project.group_chat_ref } })
      return { aggregate_id: project.id, body: { project, readiness: { status: 'ready', blockers: [] } }, events }
    },

    'project.archive': async ({ state, payload, now }) => {
      const project = projectOf(state, text(payload.project_id, 'project_id', { max: 120 }))
      if (!OPEN.includes(project.status) && project.status !== 'paused') throw companyFail('project/state-conflict', `A project in ${project.status} cannot be archived.`, { project_id: project.id, status: project.status })

      const isRow = value => value !== null && typeof value === 'object' && !Array.isArray(value)
      const tasks = Object.values(state.tasks ?? {})
        .filter(task => isRow(task) && task.project_id === project.id)
        .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0) || left.id.localeCompare(right.id))
      const acceptances = Object.values(state.acceptances ?? {})
        .filter(acceptance => isRow(acceptance) && acceptance.project_id === project.id)
      const TERMINAL = new Set(['done', 'cancelled'])
      const openTasks = tasks.filter(task => !TERMINAL.has(task.stage))
      const pendingAcceptances = acceptances.filter(acceptance => acceptance.state === 'pending')

      // 4.5: the final delivery has to be accepted, judged once for the project rather than
      // card by card. A card only reaches Done through `acceptance.decide`, so Done cards
      // with no accepted record at all mean the project was written before 4.4 or by hand;
      // archiving it would hide work that never passed. Open cards are not a refusal: they
      // are closed below with a reason and listed first.
      if (tasks.some(task => task.stage === 'done') && !acceptances.some(acceptance => acceptance.state === 'accepted')) {
        throw companyFail('project/acceptance-required', 'This project has Done cards but no accepted record, so it cannot be archived yet.', { project_id: project.id, tasks: tasks.length, acceptances: acceptances.length })
      }

      // 4.5: a dispatched Run on a Doing card means a Bot is still working; archiving
      // would close the card under it. The Run table arrives with 4.3, so a host without
      // `state.runs` simply has nothing to stop.
      const activeRuns = Object.values(state.runs ?? {})
        .filter(run => isRow(run) && run.project_id === project.id)
        .filter(run => run.state === 'dispatched' && (run.ended_at ?? null) === null)
        .filter((run) => {
          const task = run.task_id == null ? undefined : state.tasks?.[run.task_id]
          return task === undefined || task.stage === 'doing'
        })
        .map(run => ({ run_id: run.id, task_id: run.task_id ?? null }))
      if (activeRuns.length > 0) throw companyFail('project/runs-active', 'A dispatched Run is still working on this project.', { project_id: project.id, runs: activeRuns })

      // What the archive closes, listed before any write. Cards and acceptance records are
      // different objects, so a card in Review and its pending record are two lines.
      const unresolved = [
        ...openTasks.map(task => ({ kind: 'task', task_id: task.id, title: task.title, stage: task.stage })),
        ...pendingAcceptances.map(acceptance => ({ kind: 'acceptance', acceptance_id: acceptance.id, title: acceptance.title, task_id: acceptance.task_id ?? null })),
      ]

      // One timestamp for the whole closure: a task's `cancelled_at` and `updated_at` must
      // agree, and one `now()` call per row could straddle a millisecond boundary.
      const closedAt = now()
      const closedTasks = []
      for (const task of openTasks) {
        const from = task.stage
        task.stage = 'cancelled'
        task.cancelled_from = from
        task.cancel_reason = 'project_archived'
        task.cancelled_at = closedAt
        task.hold_reason = 'none'
        task.task_revision = (task.task_revision ?? 1) + 1
        task.updated_at = closedAt
        closedTasks.push({ task_id: task.id, title: task.title, stage: from })
      }

      const archived = []
      const left = []
      const suspended = new Set()
      if (project.memory_assignment_id != null) suspended.add(project.memory_assignment_id)
      for (const member of Object.values(state.members).filter(entry => entry.project_id === project.id)) {
        if (member.membership_status === 'active') {
          member.membership_status = 'archived_readonly'
          member.archived_at = closedAt
          member.archived_reason = 'project_archived'
          archived.push(member.employee_id)
        } else if (member.membership_status === 'invited') {
          member.membership_status = 'left'
          member.left_at = closedAt
          member.left_reason = 'project_archived'
          left.push(member.employee_id)
        }
        if (member.role === 'memory_keeper') suspended.add(member.employee_id)
      }
      // A memory keeper is suspended only when this project was her post. Archiving must not
      // take an employee out of another project she still serves: someone who keeps the
      // memory of another live project (setup/active/paused/delivering), or who still holds
      // an active membership in another running one (runningMembership), stays active and is
      // left out of `suspended_employees`. Members of this project were moved to
      // `archived_readonly` above, so they never count as serving elsewhere here.
      const keepsOtherLiveProject = employeeId => Object.values(state.projects ?? {})
        .some(entry => isRow(entry) && entry.id !== project.id && LIVE.includes(entry.status) && entry.memory_assignment_id === employeeId)
      const suspendedEmployees = []
      for (const employeeId of suspended) {
        const employee = state.employees[employeeId]
        if (employee === undefined || employee.status !== 'active') continue
        if (keepsOtherLiveProject(employeeId) || runningMembership(state, employeeId, project.id) !== undefined) continue
        employee.status = 'suspended'
        employee.updated_at = closedAt
        employee.revision = (employee.revision ?? 1) + 1
        suspendedEmployees.push(employeeId)
      }
      for (const employee of Object.values(state.employees)) if (Array.isArray(employee.project_ids) && employee.project_ids.includes(project.id)) leaveProject(employee, project.id)
      // M1c: archiving closes the acceptances the project still owns. Only `pending` ones
      // move — a card already decided keeps its own outcome — and the reason is recorded on
      // the acceptance itself (`close_reason`, contract §2.2 / §3.5 rule 9), because the
      // to-do read side must skip the card without the row shape changing. Archiving is the
      // only entry: `acceptance.submit` and `acceptance.decide` refuse an archived project,
      // so the read-side filter is for history, not for a second closure path.
      const closedAcceptances = []
      for (const acceptance of pendingAcceptances) {
        acceptance.state = 'cancelled'
        acceptance.close_reason = 'project_archived'
        acceptance.decided_at = closedAt
        acceptance.updated_at = closedAt
        acceptance.revision = (acceptance.revision ?? 1) + 1
        closedAcceptances.push(acceptance.id)
      }

      // 4.5: the host has no group-level read-only switch. The binding records the flag and
      // the response says who enforces it: the client locks the composer for an archived
      // project. A group that went missing is not rebuilt during archive (PRD D15); the
      // binding waits for a check.
      let groupStatus = 'unbound'
      let groupNote = 'The project has no group chat.'
      if (project.group_chat_ref != null) {
        const canRead = typeof rooms.members === 'function'
        const actual = canRead ? roomMembers(project) : undefined
        if (!canRead) {
          groupStatus = 'unknown'
          groupNote = 'This host cannot read the group, so its read-only state was not checked.'
        } else if (actual === undefined) {
          groupStatus = 'missing'
          groupNote = 'The project group is gone; the binding waits for a check and is not rebuilt during archive.'
        } else {
          groupStatus = 'readonly_client'
          groupNote = 'This host has no read-only group switch; the client locks the composer while the project is archived.'
        }
        if (groupStatus === 'missing') project.group_binding = { ...project.group_binding, status: 'pending', error: 'group missing at archive' }
      }
      // Marked on every project, including one that never had a group: the binding is what
      // the client reads, and a later writer must not take the project for live.
      project.group_binding = { ...project.group_binding, readonly: true, checked_at: closedAt }

      project.status = 'archived'
      project.archived_at = closedAt
      project.updated_at = closedAt
      project.revision += 1
      const group = { room_id: project.group_chat_ref ?? null, readonly: true, enforced: 'client', status: groupStatus, note: groupNote }
      return {
        aggregate_id: project.id,
        body: { project, archived_members: archived, left_members: left, suspended_employees: suspendedEmployees, closed_tasks: closedTasks, unresolved, group },
        events: [{ type: 'project.archived', data: { archived_members: archived, left_members: left, suspended_employees: suspendedEmployees, closed_tasks: closedTasks.map(task => task.task_id), group: { room_id: group.room_id, readonly: true, enforced: 'client', status: groupStatus } } }],
        // For logs and tests only. The command envelope copies `body`, `warning`, `events`
        // and `mutates`; every other key is dropped, so this closed list never reaches a
        // response or an event.
        closed_acceptances: closedAcceptances,
      }
    },

    'project.group.reconcile': async ({ state, payload, now }) => {
      const project = projectOf(state, text(payload.project_id, 'project_id', { max: 120 }))
      if (!OPEN.includes(project.status)) throw companyFail('project/state-conflict', `A project in ${project.status} keeps its group as it is.`, { project_id: project.id, status: project.status })
      const expected = expectedBots(state, project.id)
      if (expected.length === 0) throw companyFail('project/missing-input', 'The project has no active member, so it has no group to reconcile.', { project_id: project.id })
      const actual = roomMembers(project)
      if (actual !== undefined && sameMembers(actual, expected)) {
        project.group_binding = { ...project.group_binding, status: 'bound', room_id: project.group_chat_ref, synced_at: now() }
        return { aggregate_id: project.id, mutates: false, body: { project, group_binding: project.group_binding, room_id: project.group_chat_ref } }
      }
      if (actual === undefined) {
        const roomId = await bindGroup(project, project.name, expected, now, state)
        project.updated_at = now()
        project.revision += 1
        return { aggregate_id: project.id, body: { project, group_binding: project.group_binding, room_id: roomId }, events: [{ type: 'project.group.bound', data: { room_id: roomId, repaired: true } }] }
      }
      await syncGroup(project, expected, now)
      project.updated_at = now()
      project.revision += 1
      return { aggregate_id: project.id, body: { project, group_binding: project.group_binding, room_id: project.group_chat_ref }, events: [{ type: 'project.group.reconciled', data: { expected } }] }
    },
  }
}
