// Access: who may run which company command.
//
// The five permissions are the product's own words (PRD §13, 2026-11-20): view, dispatch,
// accept, configure, members. They are granted to a person (an `actors` row) either for the
// whole company or for one project, and a project grant never travels to another project.
//
// The table below names every command the company layer registers, so a command that is not
// in it is denied to everyone but the owner: forgetting to map a new command fails closed
// instead of silently opening it. A test walks the registered handlers and fails when the
// table and the registry drift apart in either direction.
import { companyFail } from './store.js'

// The order is the PRD's ①–⑤; the client shows a permission matrix in this order.
export const PERMISSIONS = ['view', 'dispatch', 'accept', 'configure', 'members']

// Every actor is handed the company's read surface (① 看数据), visitors included. The other
// four permissions arrive as grants: ②③ per project, ④ for the projects one runs, ⑤ only
// from the owner (and, later, an administrator).
export const DEFAULT_PERMISSIONS = ['view']

// Command → the permissions it needs, all of them. `company.init` is the owner's own call:
// it creates the company every other command works inside, so it answers to no grant.
const ACCESS = {
  // Reading is one permission across every object.
  'company.get': ['view'],
  'acceptance.list': ['view'],
  'department.list': ['view'],
  'employee.list': ['view'],
  'employee.preview-from-template': ['view'],
  'project.get': ['view'],
  'project.list': ['view'],
  'run.list': ['view'],
  'task.list': ['view'],
  'template.export': ['view'],
  'template.list': ['view'],
  // People and their grants (3.5): reading who is in the company is part of the read
  // surface; inviting, disabling and granting is the membership permission.
  'actor.list': ['view'],

  // The board: making a card, moving it, handing it over, and the dispatch side of a run.
  'task.create': ['dispatch'],
  'task.update': ['dispatch'],
  'task.move': ['dispatch'],
  'task.submit': ['dispatch'],
  'task.reopen': ['dispatch'],
  'task.dispatch': ['dispatch'],
  'run.fail': ['dispatch'],

  // Deciding somebody else's delivery.
  'acceptance.submit': ['accept'],
  'acceptance.decide': ['accept'],

  // Company and project configuration, templates included.
  'company.update': ['configure'],
  'department.create': ['configure'],
  'department.update': ['configure'],
  'department.group.create': ['configure'],
  'department.group.bind': ['configure'],
  'project.create': ['configure'],
  'project.update': ['configure'],
  'project.archive': ['configure'],
  'project.start': ['configure'],
  'project.group.reconcile': ['configure'],
  'project.member.update': ['configure'],
  'template.create': ['configure'],
  'template.update': ['configure'],
  'template.archive': ['configure'],
  'template.import': ['configure'],

  // Membership: inviting, removing, and creating the Bot that takes the seat. Hiring a
  // person writes the profile in the same breath, so it needs both permissions.
  'project.member.add': ['members'],
  'project.member.remove': ['members'],
  'employee.create': ['configure', 'members'],
  'employee.create-from-template': ['configure', 'members'],
  'employee.update': ['configure'],
  'actor.invite': ['members'],
  'actor.update': ['members'],
  'grant.create': ['members'],
  'grant.revoke': ['members'],

  // The company itself: only the owner, and only when there is no company yet.
  'company.init': [],
}

// The owner is the local user; the grants table never carries a row for them.
const owner = actor => actor?.kind === 'owner'

// The owner row, read from the file rather than compared as a string: `'user'` is the id the
// company has carried since v1 and stays, but a check that reads the row keeps working when
// the row is named differently in a later version.
export const actorKindOf = (state, id) => {
  if (typeof id !== 'string' || id === '') return undefined
  return state?.actors?.[id]?.kind
}
export const isOwnerActor = (state, id) => actorKindOf(state, id) === 'owner'

// The permissions an actor holds for one project: the company-wide read surface, plus every
// grant that either covers the whole company or this exact project. A grant for another
// project stays out, so moving to another project asks again (PRD: ②③ 换项目不继承).
export function permissionsOf(actor, grants = {}, projectId) {
  const held = new Set(DEFAULT_PERMISSIONS)
  for (const grant of Object.values(grants)) {
    if (grant?.actor_id !== actor?.id) continue
    if (grant.scope_type === 'project' && (projectId === undefined || grant.scope_id !== projectId)) continue
    if (grant.scope_type !== 'project' && grant.scope_type !== 'company') continue
    for (const permission of grant.permissions ?? []) if (PERMISSIONS.includes(permission)) held.add(permission)
  }
  return held
}

// The project a command acts on, when the payload names one. `project.get` and the project
// member commands carry `project_id` directly; `task.*` and `run.*` do too.
export const projectOfPayload = payload => (typeof payload?.project_id === 'string' ? payload.project_id : undefined)

// Does this actor hold every permission the command needs? Unknown commands answer false
// for everyone but the owner, so a command added without a line in ACCESS stays closed.
export function can(command, { actor, grants, projectId, payload } = {}) {
  if (actor !== undefined && actor.status !== undefined && actor.status !== 'active') return false
  const needed = ACCESS[command]
  if (needed === undefined) return owner(actor)
  if (owner(actor)) return true
  const held = permissionsOf(actor, grants, projectId ?? projectOfPayload(payload))
  return needed.every(permission => held.has(permission))
}

// The command-side assertion: the same answer as `can`, as the error the HTTP layer maps to
// 403. The details name the command and the missing permissions, never the payload.
export function assertAccess(command, context = {}) {
  if (can(command, context)) return
  const needed = ACCESS[command]
  const held = permissionsOf(context.actor, context.grants, context.projectId ?? projectOfPayload(context.payload))
  const missing = needed === undefined ? [] : needed.filter(permission => !held.has(permission))
  throw companyFail('company/forbidden', `This person may not run ${command}.`, {
    command,
    ...(context.actor?.id !== undefined ? { actor_id: context.actor.id } : {}),
    ...(missing.length > 0 ? { missing } : {}),
  })
}

// What the settings screen shows: the permissions mapped to a command, for the matrix.
export const permissionsFor = command => ACCESS[command]
