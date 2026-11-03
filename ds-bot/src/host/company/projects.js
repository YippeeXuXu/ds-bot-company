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

const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`

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
const MEMBER_ROLES = ['executor', 'coordinator', 'acceptor', 'memory_keeper']

const activeMembers = (state, projectId) => Object.values(state.members)
  .filter(member => member.project_id === projectId && member.membership_status === 'active')
  .sort((left, right) => left.joined_at - right.joined_at)

// The active membership an employee already holds in a running project, if any: one
// employee serves one active project at a time (PRD D6). A membership in a project that is
// still in setup does not occupy the employee, so a second draft may still be planned;
// `project.start` checks again before either draft goes live. Archived read-only
// memberships never count.
const RUNNING = ['active', 'paused', 'delivering']
const busyMembership = (state, employeeId) => Object.values(state.members)
  .find(member => member.employee_id === employeeId
    && member.membership_status === 'active'
    && RUNNING.includes(state.projects[member.project_id]?.status))

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
  if (value === 'user') return 'user'
  const employee = employeeOf(state, text(value, field, { max: 120 }))
  if (employee.status !== 'active') throw companyFail('project/invalid', `Employee ${employee.id} is not active.`, { field, employee_id: employee.id })
  if (requirement === 'owner_only') throw companyFail('project/owner-required', 'owner_only acceptance belongs to the owner, not to a Bot.', { field, employee_id: employee.id })
  return employee.id
}

const expectedBots = (state, projectId) => activeMembers(state, projectId)
  .map(member => state.employees[member.employee_id]?.bot_id)
  .filter(botId => typeof botId === 'string')

const sameMembers = (left, right) => left.length === right.length && [...left].sort().join('\n') === [...right].sort().join('\n')

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

  async function bindGroup(project, name, members, now) {
    if (typeof rooms.create !== 'function') throw companyFail('project/group-failed', 'This dsh cannot create a group chat, so the project group was not made.', { project_id: project.id })
    let created
    try {
      created = await rooms.create({ name, members })
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
        if (coordinator.status !== 'active') throw companyFail('project/invalid', `Employee ${coordinator.id} is not active.`, { field: 'coordinator_employee_id' })
        if (!sourceIds.includes(coordinator.department_id)) {
          throw companyFail('project/invalid', `The coordinator must come from one of the source departments.`, { field: 'coordinator_employee_id', department_id: coordinator.department_id, source_department_ids: sourceIds })
        }
        if (busyMembership(state, coordinator.id) !== undefined) {
          throw companyFail('project/member-busy', `Employee ${coordinator.id} is already in an active project.`, { field: 'coordinator_employee_id', employee_id: coordinator.id })
        }
      }
      const requirement = requirementOf(payload.acceptance_requirement)
      const acceptanceActor = acceptanceActorOf(state, payload.acceptance_actor, requirement)
      const memoryEmployee = payload.memory_employee_id === undefined ? undefined : employeeOf(state, text(payload.memory_employee_id, 'memory_employee_id', { max: 120 }))
      if (memoryEmployee !== undefined && memoryEmployee.status !== 'active') throw companyFail('project/invalid', `Employee ${memoryEmployee.id} is not active.`, { field: 'memory_employee_id' })

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
      coordinator.project_id = projectId
      const roomId = await bindGroup(project, name, [coordinator.bot_id], now)
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
      if (nextRequirement === 'owner_only' && nextActor !== 'user') {
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
          if (keeper.status !== 'active') throw companyFail('project/invalid', `Employee ${keeper.id} is not active.`, { field: 'memory_assignment_id' })
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
      if (employee.status !== 'active') throw companyFail('project/invalid', `Employee ${employee.id} is not active.`, { field: 'employee_id' })
      const already = Object.values(state.members).find(member => member.project_id === project.id && member.employee_id === employee.id && member.membership_status !== 'left')
      if (already !== undefined) throw companyFail('project/member-exists', `Employee ${employee.id} is already in this project.`, { project_id: project.id, employee_id: employee.id, membership_status: already.membership_status })
      if (busyMembership(state, employee.id) !== undefined) {
        throw companyFail('project/member-busy', `Employee ${employee.id} is already in an active project.`, { project_id: project.id, employee_id: employee.id })
      }
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
      employee.project_id = project.id
      if (role === 'coordinator') project.coordinator_assignment_id = memberId
      const events = [{ type: 'project.member.added', data: { employee_id: employee.id, role } }]
      let warning
      if (project.group_chat_ref == null) {
        // The first member of a draft that was created without a coordinator makes the
        // group, with everyone the project holds at that point. Refusing here would leave
        // the draft permanently unstartable, since a group can only be made from members.
        const roomId = await bindGroup(project, project.name, expectedBots(state, project.id), now)
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
      // The department does not change: leaving a project ends the membership only, and
      // the employee (and its history) stays where it is (spec member semantics).
      if (employee.project_id === project.id) employee.project_id = null
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
        const busy = busyMembership(state, employee.id)
        if (busy !== undefined) blockers.push({ code: 'member_busy', employee_id: employee.id, project_id: busy.project_id, message: `Employee ${employee.id} is already serving another active project.` })
      }
      const requirement = project.acceptance_requirement
      if (requirement === 'owner_only') {
        if (project.acceptance_actor !== 'user') blockers.push({ code: 'owner_required', field: 'acceptance_actor', message: 'owner_only acceptance belongs to the owner; set acceptance_actor to "user".' })
      } else if (typeof project.acceptance_actor !== 'string' || project.acceptance_actor === 'user') {
        blockers.push({ code: 'missing_input', field: 'acceptance_actor', message: 'Name the independent acceptance Bot.' })
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
        const roomId = await bindGroup(project, project.name, expected, now)
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
      const archived = []
      const left = []
      const suspended = new Set()
      if (project.memory_assignment_id != null) suspended.add(project.memory_assignment_id)
      for (const member of Object.values(state.members).filter(entry => entry.project_id === project.id)) {
        if (member.membership_status === 'active') {
          member.membership_status = 'archived_readonly'
          member.archived_at = now()
          member.archived_reason = 'project_archived'
          archived.push(member.employee_id)
        } else if (member.membership_status === 'invited') {
          member.membership_status = 'left'
          member.left_at = now()
          member.left_reason = 'project_archived'
          left.push(member.employee_id)
        }
        if (member.role === 'memory_keeper') suspended.add(member.employee_id)
      }
      // A memory keeper is a dedicated post: once the project is archived the employee is
      // suspended rather than carried into another project (spec 8 / archive linkage).
      const suspendedEmployees = []
      for (const employeeId of suspended) {
        const employee = state.employees[employeeId]
        if (employee === undefined || employee.status !== 'active') continue
        employee.status = 'suspended'
        employee.updated_at = now()
        employee.revision = (employee.revision ?? 1) + 1
        suspendedEmployees.push(employeeId)
      }
      for (const employee of Object.values(state.employees)) if (employee.project_id === project.id) employee.project_id = null
      project.status = 'archived'
      project.archived_at = now()
      project.updated_at = now()
      project.revision += 1
      // The group stays: archived_readonly members keep read-only access, and the group is
      // where the project's history is read (application layer refuses new turns there).
      return {
        aggregate_id: project.id,
        body: { project, archived_members: archived, left_members: left, suspended_employees: suspendedEmployees },
        events: [{ type: 'project.archived', data: { archived_members: archived, left_members: left, suspended_employees: suspendedEmployees } }],
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
        const roomId = await bindGroup(project, project.name, expected, now)
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
