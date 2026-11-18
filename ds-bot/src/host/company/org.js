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
  const missing = profiles.filter(profile => botOf(profile.bot_id) === undefined || botOf(profile.bot_id) === null)
  return { profiles, missing }
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

    // The company's mode is the default for every new Session (M1b-2.5). Sessions already
    // started keep theirs; the host refuses a preset change mid-session.
    'company.update': ({ state, payload, now }) => {
      const company = companyOf(state)
      if (payload.conversation_mode === undefined) {
        throw companyFail('company/invalid', 'Nothing to change: conversation_mode was not given.', { field: 'conversation_mode' })
      }
      const mode = conversationMode(payload.conversation_mode, COMPANY_MODES, 'conversation_mode')
      const changed = company.conversation_mode !== mode
      if (changed) {
        company.conversation_mode = mode
        company.revision += 1
        company.updated_at = now()
      }
      return {
        aggregate_id: company.id,
        ...(changed ? {} : { mutates: false }),
        body: { company },
        ...(changed ? { events: [{ type: 'company.updated', data: { conversation_mode: mode } }] } : {}),
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
      const { profiles, missing } = groupProfilesOf(state, department, botOf)
      if (missing.length > 0) {
        const named = missing.map(profile => `${profile.name} (${profile.bot_id})`).join(', ')
        throw companyFail('department/group-missing-bots', `The group chat of ${department.name} was not created: ${named} ${missing.length === 1 ? 'has' : 'have'} no Bot in this team.`, {
          department_id: department.id,
          missing: missing.map(profile => ({ employee_id: profile.id, name: profile.name, bot_id: profile.bot_id })),
        })
      }
      if (profiles.length < 2) {
        throw companyFail('department/group-too-small', `A group chat needs at least two Bots; ${department.name} has ${profiles.length}. Add an employee before making its group chat.`, { department_id: department.id, count: profiles.length })
      }
      const members = profiles.map(profile => profile.bot_id)
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
      return { aggregate_id: department.id, body: { department: departmentView(department), room }, events: [{ type: 'department.group.created', data: { room_id: roomId, members } }] }
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
      const botId = text(payload.bot_id, 'bot_id', { max: 120 })
      const bot = botOf(botId)
      if (bot === undefined || bot === null) throw companyFail('employee/unknown-bot', `No Bot ${botId} in this team.`, { field: 'bot_id', bot_id: botId })
      if (isPrivate(botId)) throw companyFail('employee/private-bot', `Bot ${botId} is private and cannot hold an employee profile.`, { field: 'bot_id', bot_id: botId })
      const department = departmentOf(state, text(payload.department_id, 'department_id', { max: 120 }))
      if (activeProfileOf(state, botId) !== undefined) {
        throw companyFail('employee.bot_already_employed', `Bot ${botId} already holds an active employee profile.`, { field: 'bot_id', bot_id: botId })
      }
      const id = newId('emp')
      state.employees[id] = {
        id,
        company_id: company.id,
        bot_id: botId,
        department_id: department.id,
        name: text(payload.name ?? bot.name, 'name', { max: 80 }),
        role: optionalText(payload.role, 'role', 80) ?? null,
        acceptance_role: acceptanceRole(payload.acceptance_role),
        // M1b-2.5: `follow` keeps the profile in step with the company default; a pinned
        // value is for the one employee who needs the other mode.
        conversation_mode: payload.conversation_mode === undefined ? 'follow' : conversationMode(payload.conversation_mode, EMPLOYEE_MODES, 'conversation_mode'),
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
        throw companyFail('employee/immutable-field', 'A profile keeps its Bot; dismiss it and hire the other Bot instead.', { field: 'bot_id' })
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
      profile.revision += 1
      profile.updated_at = now()
      return { aggregate_id: profile.id, body: { employee: profile }, events: [{ type: 'employee.updated', data: {} }] }
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
