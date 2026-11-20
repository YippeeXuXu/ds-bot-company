// Organisation commands: the company, its departments, and the employee profiles that
// sit on top of the Bot roster. A profile points at a Bot; the Bot's model, skills and
// chats stay in the team file, so this layer never copies permissions. The one rule the
// roster cannot express — a Bot holds one active profile — is enforced here, in the
// store's single writer.
import { randomUUID } from 'node:crypto'
import { companyFail } from './store.js'

export const ACCEPTANCE_ROLES = ['executor', 'coordinator', 'acceptor', 'memory_keeper']

// Conversation modes (M1b-2.5): the company picks the default for every new Session and an
// employee may follow it, pin standard, or pin PTC. Only a new Session can take a preset —
// the host locks it once the first turn starts (`agent-preset/locked`) — so these values
// are read when the Session is made, never to switch a chat that is already open.
export const COMPANY_MODES = ['standard', 'ptc']
export const EMPLOYEE_MODES = ['follow', 'standard', 'ptc']

// The stored value is the public value: `standard` and `ptc` name host presets, and
// `follow` is an employee-only word for "the company's".
const conversationMode = (value, allowed, field) => {
  const mode = text(value, field, { max: 20 })
  if (!allowed.includes(mode)) throw companyFail('company/invalid', `${field} is one of ${allowed.join(', ')}.`, { field, allowed })
  return mode
}

// Planner (batch 2): the stronger model that writes the plan for a turn before the
// employee's own model runs. The pair is stored as given; whether it is served is
// settled when a turn asks for it, so a provider that starts later still fits.
const plannerSetting = (value) => {
  if (value === null || value === '') return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw companyFail('company/invalid', 'planner is an object with provider and model, or null.', { field: 'planner' })
  }
  const provider = text(value.provider, 'planner.provider', { max: 120 })
  const model = text(value.model, 'planner.model', { max: 200 })
  const effort = value.reasoning_effort === undefined || value.reasoning_effort === null || value.reasoning_effort === ''
    ? undefined
    : text(value.reasoning_effort, 'planner.reasoning_effort', { max: 60 })
  return {
    enabled: value.enabled !== false,
    provider,
    model,
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  }
}

const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`

const text = (value, field, { max = 120, min = 1 } = {}) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length < min) throw companyFail('company/invalid', `${field} is required.`, { field })
  if (trimmed.length > max) throw companyFail('company/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return trimmed
}

const optionalText = (value, field, max = 2000) => (value === undefined || value === null || value === '' ? undefined : text(value, field, { max }))

const nameKey = name => name.trim().toLowerCase()

// The company is the parent of everything: one exists in M1 (PRD D1), and every other
// command refuses to create orphans when it does not.
const onlyCompany = state => Object.values(state.companies).find(company => company.status !== 'archived')

const companyOf = state => {
  const company = onlyCompany(state)
  if (company === undefined) throw companyFail('company/not-found', 'Create the company before its departments and employees.', {})
  return company
}

const departmentOf = (state, id, field = 'department_id') => {
  const department = state.departments[id]
  if (department === undefined || department.status === 'archived') throw companyFail('department/not-found', `No department ${id}.`, { field, department_id: id })
  return department
}

const employeeOf = (state, id) => {
  const profile = state.employees[id]
  if (profile === undefined) throw companyFail('employee/not-found', `No employee ${id}.`, { employee_id: id })
  return profile
}

const activeProfileOf = (state, botId) => Object.values(state.employees).find(profile => profile.status === 'active' && profile.bot_id === botId)

// M1b-2.4: an employee may be dismissed, and a dismissal must not leave a project, a
// group or a department pointing at a row nobody serves. Everything that still names the
// profile is collected here, so the refusal can say which places to hand over first.
// 'suspended' is set by project.archive and read back like this; only these two are
// requestable through employee.update.
export const EMPLOYEE_STATUS = ['active', 'disabled']

// A project that is over keeps its history: only a live project is a place to hand over.
const liveProjectOf = project => !['archived', 'closed', 'cancelled', 'done'].includes(project.status)

const dismissalReferencesOf = (state, profile) => {
  const departments = Object.values(state.departments)
    .filter(department => department.status !== 'archived' && department.lead_employee_id === profile.id)
    .map(department => ({ department_id: department.id, name: department.name, role: 'lead' }))
  const projects = []
  for (const project of Object.values(state.projects)) {
    if (!liveProjectOf(project)) continue
    const roles = []
    const assignment = project.coordinator_assignment_id == null ? undefined : state.members[project.coordinator_assignment_id]
    if (assignment !== undefined && assignment.employee_id === profile.id && assignment.membership_status === 'active') roles.push('coordinator')
    if (project.acceptance_actor === profile.id) roles.push('acceptor')
    if (project.memory_assignment_id === profile.id) roles.push('memory keeper')
    const membership = Object.values(state.members).find(member => member.project_id === project.id && member.employee_id === profile.id && ['active', 'invited'].includes(member.membership_status))
    if (membership !== undefined && !roles.includes(membership.role)) roles.push(membership.role)
    if (roles.length > 0) projects.push({ project_id: project.id, name: project.name, status: project.status, roles })
  }
  return { projects, departments }
}

const stillReferenced = (state, profile) => {
  const references = dismissalReferencesOf(state, profile)
  if (references.projects.length === 0 && references.departments.length === 0) return undefined
  const places = [
    ...references.departments.map(department => `lead of ${department.name}`),
    ...references.projects.map(project => `${project.roles.join(' and ')} on ${project.name}`),
  ]
  const named = places.slice(0, 3).join('; ')
  const rest = places.length > 3 ? `; and ${places.length - 3} more` : ''
  return companyFail('employee/still-referenced', `Employee ${profile.name} still holds work: ${named}${rest}. Hand it over before dismissing them.`, { employee_id: profile.id, ...references })
}

// A department lead is one of its own active employees. The field is a pointer, not a
// copy of a name: an employee who leaves the department must not keep the post, and the
// check lives here so every caller of department.update gets it (PRD §13).
const leadOf = (state, department, value) => {
  const profile = employeeOf(state, text(value, 'lead_employee_id', { max: 120 }))
  if (profile.status !== 'active') {
    throw companyFail('department/invalid', `Employee ${profile.id} is not active.`, { field: 'lead_employee_id', employee_id: profile.id, status: profile.status })
  }
  if (profile.department_id !== department.id) {
    throw companyFail('department/invalid', `Employee ${profile.id} belongs to another department.`, { field: 'lead_employee_id', employee_id: profile.id, department_id: profile.department_id })
  }
  return profile.id
}

const acceptanceRole = (value) => {
  const role = value ?? 'executor'
  if (!ACCEPTANCE_ROLES.includes(role)) throw companyFail('company/invalid', `acceptance_role is one of ${ACCEPTANCE_ROLES.join(', ')}.`, { field: 'acceptance_role', allowed: ACCEPTANCE_ROLES })
  return role
}

// A department group is an ordinary group chat, so the roster owns the room and the
// department owns the pointer. The stored name is `chat_ref`; `room_id` is its public
// alias, and `room.department_id` is derived from it at read time (the roster keeps no
// product fields). Both spellings are written through, so a screen can use either.
export const departmentView = (department) => ({ ...department, room_id: department.chat_ref ?? null })

const chatRef = payload => (payload.chat_ref !== undefined ? payload.chat_ref : payload.room_id)

// The Bots a department group would hold: its active employees, in join order. An
// employee whose Bot is gone is named rather than skipped — a group quietly missing
// someone is worse than a refusal that says who is missing.
const groupProfilesOf = (state, department, botOf) => {
  const profiles = Object.values(state.employees)
    .filter(profile => profile.company_id === department.company_id && profile.department_id === department.id && profile.status === 'active')
    .sort((left, right) => left.created_at - right.created_at)
  // An unbound profile (no Bot chosen yet) is skipped, not named: it is a slot waiting for
  // a Bot, and refusing the whole group would strand a department whose roster was filled
  // in before its Bots arrived. A profile whose Bot has gone is still named — a group
  // quietly missing someone is worse than a refusal that says who is missing.
  const unbound = profiles.filter(profile => profile.bot_id === null || profile.bot_id === undefined || profile.bot_id === '')
  const bound = profiles.filter(profile => !unbound.includes(profile))
  const missing = bound.filter(profile => botOf(profile.bot_id) === undefined || botOf(profile.bot_id) === null)
  return { profiles, bound, unbound, missing }
}

export function orgHandlers({ botOf = () => undefined, isPrivate = () => false, groups = {} } = {}) {
  const roomOf = typeof groups.roomOf === 'function' ? groups.roomOf : () => undefined
  const roomView = (roomId, fallback = {}) => {
    const room = roomOf(roomId)
    return {
      id: room?.id ?? roomId,
      name: room?.name ?? fallback.name ?? null,
      members: Array.isArray(room?.members) ? [...room.members] : [...(fallback.members ?? [])],
    }
  }
  return {
    'company.init': ({ state, payload, now }) => {
      const name = text(payload.name, 'name', { max: 80 })
      const existing = onlyCompany(state)
      if (existing !== undefined) return { aggregate_id: existing.id, mutates: false, body: { company: existing, existing: true } }
      const id = newId('cmp')
      state.companies[id] = { id, name, status: 'active', conversation_mode: 'standard', created_at: now(), updated_at: now(), revision: 1 }
      return { aggregate_id: id, body: { company: state.companies[id] }, events: [{ type: 'company.created', data: { name } }] }
    },

    'company.get': ({ state }) => {
      const company = onlyCompany(state) ?? null
      return { aggregate_id: company?.id ?? null, mutates: false, body: { company } }
    },

    // The company's name and its mode are both edited here. The mode is the default for
    // every new Session (M1b-2.5): Sessions already started keep theirs, and the host
    // refuses a preset change mid-session. Either field may be sent alone; a call that
    // changes nothing is not a write, so it leaves the revision and the event log alone.
    'company.update': ({ state, payload, now }) => {
      const company = companyOf(state)
      if (payload.name === undefined && payload.conversation_mode === undefined) {
        throw companyFail('company/invalid', 'Nothing to change: give name or conversation_mode.', { field: 'conversation_mode', fields: ['name', 'conversation_mode'] })
      }
      const changed = {}
      if (payload.name !== undefined) {
        const name = text(payload.name, 'name', { max: 80 })
        if (name !== company.name) changed.name = name
      }
      if (payload.conversation_mode !== undefined) {
        const mode = conversationMode(payload.conversation_mode, COMPANY_MODES, 'conversation_mode')
        if (mode !== company.conversation_mode) changed.conversation_mode = mode
      }
      const fields = Object.keys(changed)
      if (fields.length > 0) {
        Object.assign(company, changed)
        company.revision += 1
        company.updated_at = now()
      }
      return {
        aggregate_id: company.id,
        ...(fields.length > 0 ? {} : { mutates: false }),
        body: { company },
        ...(fields.length > 0 ? { events: [{ type: 'company.updated', data: changed }] } : {}),
      }
    },

    'department.create': ({ state, payload, now }) => {
      const company = companyOf(state)
      const name = text(payload.name, 'name', { max: 80 })
      const clash = Object.values(state.departments).some(department => department.company_id === company.id && department.status !== 'archived' && nameKey(department.name) === nameKey(name))
      if (clash) throw companyFail('department.name-taken', `A department named ${name} already exists.`, { field: 'name' })
      const id = newId('dep')
      // Nobody can lead a department that has no members yet; the lead is set by
      // department.update once an employee has joined. Refusing the value keeps the
      // screen from believing it took effect.
      if (payload.lead_employee_id !== undefined && payload.lead_employee_id !== null && payload.lead_employee_id !== '') {
        throw companyFail('department/invalid', 'A new department has no employees; create it first and set its lead afterwards.', { field: 'lead_employee_id' })
      }
      state.departments[id] = {
        id,
        company_id: company.id,
        name,
        description: optionalText(payload.description, 'description') ?? null,
        // A department chat is an ordinary group chat. It can be bound here, or made by
        // department.group.create once the department has Bots to put in it (M1a-4).
        chat_ref: optionalText(chatRef(payload), 'chat_ref', 120) ?? null,
        // Added by M1b-2.2: the lead is a pointer into this department's employees.
        lead_employee_id: null,
        status: 'active',
        created_at: now(),
        updated_at: now(),
        revision: 1,
      }
      return { aggregate_id: id, body: { department: departmentView(state.departments[id]) }, events: [{ type: 'department.created', data: { name } }] }
    },

    'department.update': ({ state, payload, now }) => {
      const department = departmentOf(state, text(payload.department_id, 'department_id', { max: 120 }))
      if (payload.name !== undefined) {
        const name = text(payload.name, 'name', { max: 80 })
        const clash = Object.values(state.departments).some(other => other.id !== department.id && other.company_id === department.company_id && other.status !== 'archived' && nameKey(other.name) === nameKey(name))
        if (clash) throw companyFail('department.name-taken', `A department named ${name} already exists.`, { field: 'name' })
        department.name = name
      }
      if (payload.description !== undefined) department.description = optionalText(payload.description, 'description') ?? null
      if (payload.chat_ref !== undefined || payload.room_id !== undefined) department.chat_ref = optionalText(chatRef(payload), 'chat_ref', 120) ?? null
      if (payload.lead_employee_id !== undefined) {
        department.lead_employee_id = payload.lead_employee_id === null || payload.lead_employee_id === ''
          ? null
          : leadOf(state, department, payload.lead_employee_id)
      }
      department.revision += 1
      department.updated_at = now()
      return { aggregate_id: department.id, body: { department: departmentView(department) }, events: [{ type: 'department.updated', data: { name: department.name, lead_employee_id: department.lead_employee_id } }] }
    },

    // Make the department's group chat out of its own Bots, then bind it. The command is
    // async because the roster creates a real Session; the department row is written in
    // the same commit, so a group is never left with no owner on disk.
    'department.group.create': async ({ state, payload, now }) => {
      const company = companyOf(state)
      const department = departmentOf(state, text(payload.department_id, 'department_id', { max: 120 }))
      if (department.company_id !== company.id) {
        throw companyFail('department/not-found', `No department ${department.id} in this company.`, { department_id: department.id })
      }
      // A live binding answers as it is: pressing "new group" twice must not make two.
      if (department.chat_ref != null) {
        const current = roomOf(department.chat_ref)
        if (current !== undefined) {
          return { aggregate_id: department.id, mutates: false, body: { department: departmentView(department), room: roomView(department.chat_ref), existing: true } }
        }
      }
      if (typeof groups.create !== 'function') {
        throw companyFail('department/group-failed', 'This dsh cannot create a group chat, so the department group was not made.', { department_id: department.id })
      }
      const { bound, unbound, missing } = groupProfilesOf(state, department, botOf)
      if (missing.length > 0) {
        const named = missing.map(profile => `${profile.name} (${profile.bot_id})`).join(', ')
        throw companyFail('department/group-missing-bots', `The group chat of ${department.name} was not created: ${named} ${missing.length === 1 ? 'has' : 'have'} no Bot in this team.`, {
          department_id: department.id,
          missing: missing.map(profile => ({ employee_id: profile.id, name: profile.name, bot_id: profile.bot_id })),
        })
      }
      if (bound.length < 2) {
        throw companyFail('department/group-too-small', `A group chat needs at least two Bots; ${department.name} has ${bound.length}. Add an employee before making its group chat.`, { department_id: department.id, count: bound.length })
      }
      const members = bound.map(profile => profile.bot_id)
      const lead = department.lead_employee_id == null ? undefined : state.employees[department.lead_employee_id]
      const admin = lead !== undefined && members.includes(lead.bot_id) ? lead.bot_id : undefined
      const name = optionalText(payload.name, 'name', 80) ?? `${department.name}群`
      let created
      try {
        created = await groups.create({ name, members, admin })
      } catch (error) {
        throw companyFail('department/group-failed', `The group chat of ${department.name} could not be created: ${error?.message ?? error}`, { department_id: department.id })
      }
      const roomId = typeof created === 'string' ? created : created?.id
      if (typeof roomId !== 'string' || roomId === '') {
        throw companyFail('department/group-failed', 'The roster did not return a group id for the department group.', { department_id: department.id })
      }
      department.chat_ref = roomId
      department.revision += 1
      department.updated_at = now()
      const room = roomView(roomId, { name, members })
      const skipped = unbound.map(profile => ({ employee_id: profile.id, name: profile.name }))
      return { aggregate_id: department.id, body: { department: departmentView(department), room, skipped }, events: [{ type: 'department.group.created', data: { room_id: roomId, members, skipped } }] }
    },

    // Bind a group that already exists (made in the chat list, or by an earlier install).
    // The members are reported, not changed: an existing group may hold Bots this
    // department has no profile for, and the screen decides what to do about it.
    'department.group.bind': ({ state, payload, now }) => {
      const department = departmentOf(state, text(payload.department_id, 'department_id', { max: 120 }))
      const roomId = text(chatRef(payload), 'room_id', { max: 120 })
      if (typeof groups.roomOf !== 'function') {
        throw companyFail('department/group-failed', 'This dsh cannot read group chats, so the binding was not checked.', { department_id: department.id })
      }
      if (groups.roomOf(roomId) === undefined) throw companyFail('department/group-not-found', `No group chat ${roomId}.`, { room_id: roomId })
      const other = Object.values(state.departments).find(entry => entry.id !== department.id && entry.company_id === department.company_id && entry.chat_ref === roomId)
      if (other !== undefined) {
        throw companyFail('department/group-bound', `Group chat ${roomId} already belongs to ${other.name}.`, { room_id: roomId, department_id: other.id })
      }
      const changed = department.chat_ref !== roomId
      if (changed) {
        department.chat_ref = roomId
        department.revision += 1
        department.updated_at = now()
      }
      const { profiles } = groupProfilesOf(state, department, botOf)
      const expected = profiles.filter(profile => botOf(profile.bot_id) !== undefined && botOf(profile.bot_id) !== null).map(profile => profile.bot_id)
      const room = roomView(roomId)
      const actual = room.members
      const drifted = expected.length !== actual.length || expected.some(botId => !actual.includes(botId))
      return {
        aggregate_id: department.id,
        ...(changed ? {} : { mutates: false }),
        body: { department: departmentView(department), room, expected, actual, drifted },
        ...(changed ? { events: [{ type: 'department.group.bound', data: { room_id: roomId } }] } : {}),
      }
    },

    'department.list': ({ state }) => {
      const company = onlyCompany(state)
      const departments = Object.values(state.departments)
        .filter(department => company === undefined || department.company_id === company.id)
        .sort((left, right) => left.created_at - right.created_at)
        .map(departmentView)
      return { aggregate_id: company?.id ?? null, mutates: false, body: { departments } }
    },

    'employee.create': ({ state, payload, now }) => {
      const company = companyOf(state)
      // A profile may be opened before its Bot is picked: `bot_id: null` is a slot the
      // department can fill in later with employee.update. A Bot that is given must exist.
      const unbound = payload.bot_id === undefined || payload.bot_id === null || payload.bot_id === ''
      const botId = unbound ? null : text(payload.bot_id, 'bot_id', { max: 120 })
      const bot = botId === null ? null : botOf(botId)
      if (botId !== null && (bot === undefined || bot === null)) throw companyFail('employee/unknown-bot', `No Bot ${botId} in this team.`, { field: 'bot_id', bot_id: botId })
      if (botId !== null && isPrivate(botId)) throw companyFail('employee/private-bot', `Bot ${botId} is private and cannot hold an employee profile.`, { field: 'bot_id', bot_id: botId })
      const department = departmentOf(state, text(payload.department_id, 'department_id', { max: 120 }))
      if (botId !== null && activeProfileOf(state, botId) !== undefined) {
        throw companyFail('employee.bot_already_employed', `Bot ${botId} already holds an active employee profile.`, { field: 'bot_id', bot_id: botId })
      }
      const id = newId('emp')
      const planner = payload.planner === undefined ? null : plannerSetting(payload.planner)
      state.employees[id] = {
        id,
        company_id: company.id,
        bot_id: botId,
        department_id: department.id,
        name: text(payload.name ?? bot?.name, 'name', { max: 80 }),
        role: optionalText(payload.role, 'role', 80) ?? null,
        acceptance_role: acceptanceRole(payload.acceptance_role),
        // M1b-2.5: `follow` keeps the profile in step with the company default; a pinned
        // value is for the one employee who needs the other mode.
        conversation_mode: payload.conversation_mode === undefined ? 'follow' : conversationMode(payload.conversation_mode, EMPLOYEE_MODES, 'conversation_mode'),
        ...(planner === null ? {} : { planner }),
        status: 'active',
        // Filled by the project commands (M1a-3): the profile itself has no project.
        project_id: null,
        created_at: now(),
        updated_at: now(),
        revision: 1,
      }
      return { aggregate_id: id, body: { employee: state.employees[id] }, events: [{ type: 'employee.created', data: { bot_id: botId, department_id: department.id } }] }
    },

    'employee.update': ({ state, payload, now }) => {
      const profile = employeeOf(state, text(payload.employee_id, 'employee_id', { max: 120 }))
      if (payload.bot_id !== undefined && payload.bot_id !== profile.bot_id) {
        // An unbound slot takes a Bot once; a bound profile keeps it.
        const next = payload.bot_id === null || payload.bot_id === '' ? null : text(payload.bot_id, 'bot_id', { max: 120 })
        if (next !== null && profile.bot_id !== null && profile.bot_id !== undefined && next !== profile.bot_id) {
          throw companyFail('employee/immutable-field', 'A profile keeps its Bot; dismiss it and hire the other Bot instead.', { field: 'bot_id' })
        }
        if (next !== null) {
          const bot = botOf(next)
          if (bot === undefined || bot === null) throw companyFail('employee/unknown-bot', `No Bot ${next} in this team.`, { field: 'bot_id', bot_id: next })
          if (isPrivate(next)) throw companyFail('employee/private-bot', `Bot ${next} is private and cannot hold an employee profile.`, { field: 'bot_id', bot_id: next })
          if (activeProfileOf(state, next) !== undefined) {
            throw companyFail('employee.bot_already_employed', `Bot ${next} already holds an active employee profile.`, { field: 'bot_id', bot_id: next })
          }
        }
        profile.bot_id = next
      }
      if (payload.name !== undefined) profile.name = text(payload.name, 'name', { max: 80 })
      if (payload.role !== undefined) profile.role = optionalText(payload.role, 'role', 80) ?? null
      if (payload.department_id !== undefined) {
        const next = departmentOf(state, text(payload.department_id, 'department_id', { max: 120 })).id
        if (next !== profile.department_id) {
          // A lead who leaves the department loses the post: the pointer would otherwise
          // keep pointing at an outsider, and the department page would show a name its
          // own member list no longer holds.
          for (const other of Object.values(state.departments)) {
            if (other.lead_employee_id === profile.id) {
              other.lead_employee_id = null
              other.revision += 1
              other.updated_at = now()
            }
          }
        }
        profile.department_id = next
      }
      if (payload.acceptance_role !== undefined) profile.acceptance_role = acceptanceRole(payload.acceptance_role)
      if (payload.conversation_mode !== undefined) profile.conversation_mode = conversationMode(payload.conversation_mode, EMPLOYEE_MODES, 'conversation_mode')
      if (payload.planner !== undefined) {
        const next = plannerSetting(payload.planner)
        if (next === null) delete profile.planner
        else profile.planner = next
      }
      if (payload.status !== undefined) {
        const next = text(payload.status, 'status', { max: 20 })
        if (!EMPLOYEE_STATUS.includes(next)) throw companyFail('company/invalid', `status is one of ${EMPLOYEE_STATUS.join(', ')}.`, { field: 'status', allowed: EMPLOYEE_STATUS })
        if (next !== profile.status) {
          if (next === 'disabled') {
            // A dismissed employee stays on the roster and in history; only live work has
            // to be handed over first, and the refusal names it (M1b-2.4).
            const refusal = stillReferenced(state, profile)
            if (refusal !== undefined) throw refusal
            profile.status = 'disabled'
            profile.project_id = null
          } else {
            // Hiring is refused while a Bot holds an active profile; re-activating an old
            // profile takes the same rule, so the roster never has two active rows per Bot.
            const holder = activeProfileOf(state, profile.bot_id)
            if (holder !== undefined && holder.id !== profile.id) {
              throw companyFail('employee.bot_already_employed', `Bot ${profile.bot_id} already holds an active employee profile.`, { field: 'bot_id', bot_id: profile.bot_id, employee_id: holder.id })
            }
            profile.status = 'active'
          }
        }
      }
      profile.revision += 1
      profile.updated_at = now()
      return {
        aggregate_id: profile.id,
        body: { employee: profile },
        events: [{ type: 'employee.updated', data: payload.status === undefined ? {} : { status: profile.status } }],
      }
    },

    'employee.list': ({ state, payload }) => {
      const company = onlyCompany(state)
      const departmentId = payload.department_id
      const employees = Object.values(state.employees)
        .filter(profile => company === undefined || profile.company_id === company.id)
        .filter(profile => departmentId === undefined || profile.department_id === departmentId)
        .filter(profile => payload.status === undefined || profile.status === payload.status)
        .sort((left, right) => left.created_at - right.created_at)
      return { aggregate_id: company?.id ?? null, mutates: false, body: { employees } }
    },
  }
}
