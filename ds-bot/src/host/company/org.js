// Organisation commands: the company, its departments, and the employee profiles that
// sit on top of the Bot roster. A profile points at a Bot; the Bot's model, skills and
// chats stay in the team file, so this layer never copies permissions. The one rule the
// roster cannot express — a Bot holds one active profile — is enforced here, in the
// store's single writer.
import { randomUUID } from 'node:crypto'
import { companyFail } from './store.js'

export const ACCEPTANCE_ROLES = ['executor', 'coordinator', 'acceptor', 'memory_keeper']

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

const acceptanceRole = (value) => {
  const role = value ?? 'executor'
  if (!ACCEPTANCE_ROLES.includes(role)) throw companyFail('company/invalid', `acceptance_role is one of ${ACCEPTANCE_ROLES.join(', ')}.`, { field: 'acceptance_role', allowed: ACCEPTANCE_ROLES })
  return role
}

export function orgHandlers({ botOf = () => undefined, isPrivate = () => false } = {}) {
  return {
    'company.init': ({ state, payload, now }) => {
      const name = text(payload.name, 'name', { max: 80 })
      const existing = onlyCompany(state)
      if (existing !== undefined) return { aggregate_id: existing.id, mutates: false, body: { company: existing, existing: true } }
      const id = newId('cmp')
      state.companies[id] = { id, name, status: 'active', created_at: now(), updated_at: now(), revision: 1 }
      return { aggregate_id: id, body: { company: state.companies[id] }, events: [{ type: 'company.created', data: { name } }] }
    },

    'company.get': ({ state }) => {
      const company = onlyCompany(state) ?? null
      return { aggregate_id: company?.id ?? null, mutates: false, body: { company } }
    },

    'department.create': ({ state, payload, now }) => {
      const company = companyOf(state)
      const name = text(payload.name, 'name', { max: 80 })
      const clash = Object.values(state.departments).some(department => department.company_id === company.id && department.status !== 'archived' && nameKey(department.name) === nameKey(name))
      if (clash) throw companyFail('department.name-taken', `A department named ${name} already exists.`, { field: 'name' })
      const id = newId('dep')
      state.departments[id] = {
        id,
        company_id: company.id,
        name,
        description: optionalText(payload.description, 'description') ?? null,
        // A department chat is an ordinary group chat, bound later (M1a-4); it is never
        // created here, because a group needs two Bots the department may not have yet.
        chat_ref: optionalText(payload.chat_ref, 'chat_ref', 120) ?? null,
        status: 'active',
        created_at: now(),
        updated_at: now(),
        revision: 1,
      }
      return { aggregate_id: id, body: { department: state.departments[id] }, events: [{ type: 'department.created', data: { name } }] }
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
      if (payload.chat_ref !== undefined) department.chat_ref = optionalText(payload.chat_ref, 'chat_ref', 120) ?? null
      department.revision += 1
      department.updated_at = now()
      return { aggregate_id: department.id, body: { department }, events: [{ type: 'department.updated', data: { name: department.name } }] }
    },

    'department.list': ({ state }) => {
      const company = onlyCompany(state)
      const departments = Object.values(state.departments)
        .filter(department => company === undefined || department.company_id === company.id)
        .sort((left, right) => left.created_at - right.created_at)
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
      if (payload.department_id !== undefined) profile.department_id = departmentOf(state, text(payload.department_id, 'department_id', { max: 120 })).id
      if (payload.acceptance_role !== undefined) profile.acceptance_role = acceptanceRole(payload.acceptance_role)
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
