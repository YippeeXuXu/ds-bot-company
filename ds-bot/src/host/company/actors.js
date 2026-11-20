// People and their grants (M2 batch 3 / G3 3.5, contract v1.19).
//
// A person is an actor row of kind `human`: invited by the owner, disabled when she leaves,
// restored when she comes back. What a person may do is not a property of the person: every
// grant names exactly one scope (the whole company or one project) and the permissions it
// carries, so a person who can dispatch in one project is refused in the next one.
//
// The owner row is not managed here: it is the local user, holds every permission, and is
// written once by `ensureOwnerActor` (store.js) so a rename or a dismissal can never lock
// the company out of itself.
//
// Not here: signing in, passwords, invitations that reach somebody outside the machine.
// Those arrive with the guest web page (batch 6); this batch records who the people are and
// what they may do, and `commands.execute` enforces it.
import { PERMISSIONS } from './access.js'
import { newId } from './projects.js'
import { companyFail } from './store.js'
import { projectOf, text } from './tasks.js'

// `actor.update` and `grant.revoke` carry the revision of the row they change, so the
// envelope leaves that comparison to the handler (see ROW_REVISION_COMMANDS in commands.js).
export const ACTOR_ROW_REVISION_COMMANDS = new Set(['actor.update', 'grant.revoke'])

export const ACTOR_STATUSES = ['active', 'disabled']

const nameKey = value => value.trim().toLowerCase()

// Display names are unique across every actor row, the owner's included, and a disabled
// person keeps her name reserved: restoring her must never leave two active people answering
// to one name. Renaming the disabled row first is the way out, which `actor.update` allows.
const nameTaken = (state, name, exceptId) => Object.values(state.actors ?? {}).some(actor => actor.id !== exceptId && nameKey(actor.name) === nameKey(name))

const onlyCompany = state => Object.values(state.companies ?? {}).find(entry => entry.status !== 'archived')

const rowRevision = (payload, row, what) => {
  if (!Number.isInteger(payload.expected_revision)) throw companyFail('company/invalid', 'expected_revision is required; it names the revision of the row you read.', { field: 'expected_revision' })
  if (payload.expected_revision !== row.revision) {
    throw companyFail('company/revision-conflict', `The ${what} is at revision ${row.revision}, not ${payload.expected_revision}.`, { expected_revision: payload.expected_revision, revision: row.revision })
  }
}

const actorOf = (state, value) => {
  const id = text(value, 'actor_id', 120)
  const actor = state.actors?.[id]
  if (actor === undefined) throw companyFail('actor/not-found', `No actor ${id}.`, { actor_id: id })
  return actor
}

const humanOnly = actor => {
  if (actor.kind === 'owner') throw companyFail('actor/immutable-field', 'The owner cannot be renamed, disabled or granted: the owner already holds every permission.', { actor_id: actor.id })
  if (actor.kind !== 'human') throw companyFail('company/invalid', `Actor ${actor.id} is not a person.`, { actor_id: actor.id })
  return actor
}

const permissionsOfPayload = value => {
  if (!Array.isArray(value)) throw companyFail('company/invalid', `permissions is a list of permission names, one of ${PERMISSIONS.join(', ')}.`, { field: 'permissions', allowed: PERMISSIONS })
  const items = value.map((entry, index) => {
    const name = typeof entry === 'string' ? entry.trim() : ''
    if (!PERMISSIONS.includes(name)) throw companyFail('company/invalid', `permissions[${index}] is one of ${PERMISSIONS.join(', ')}.`, { field: `permissions[${index}]`, allowed: PERMISSIONS })
    return name
  })
  if (items.length === 0) throw companyFail('company/invalid', 'permissions needs at least one entry.', { field: 'permissions' })
  if (new Set(items).size !== items.length) throw companyFail('company/invalid', 'permissions lists an entry twice.', { field: 'permissions' })
  return items
}

export const grantView = grant => ({
  id: grant.id,
  actor_id: grant.actor_id,
  scope_type: grant.scope_type,
  scope_id: grant.scope_id ?? null,
  permissions: [...(grant.permissions ?? [])],
  created_at: grant.created_at,
  updated_at: grant.updated_at,
  revision: grant.revision,
})

export const actorView = (state, actor) => ({
  id: actor.id,
  kind: actor.kind,
  name: actor.name,
  status: actor.status,
  created_at: actor.created_at,
  updated_at: actor.updated_at,
  revision: actor.revision ?? null,
  grants: Object.values(state.grants ?? {})
    .filter(grant => grant.actor_id === actor.id)
    .sort((left, right) => (left.scope_type === right.scope_type ? String(left.scope_id ?? '').localeCompare(String(right.scope_id ?? '')) : left.scope_type === 'company' ? -1 : 1))
    .map(grantView),
})

// The owner first, then people by invitation order; a tie on the same millisecond is broken
// by id so two reads of the same file list the same way.
const byKindThenTime = (left, right) => {
  if (left.kind !== right.kind) return left.kind === 'owner' ? -1 : 1
  if (left.created_at !== right.created_at) return left.created_at - right.created_at
  return left.id.localeCompare(right.id)
}

export function actorHandlers() {
  return {
    'actor.list': ({ state, payload }) => {
      const actors = Object.values(state.actors ?? {})
        .filter(actor => payload.status === undefined || actor.status === payload.status)
        .sort(byKindThenTime)
        .map(actor => actorView(state, actor))
      return { aggregate_id: null, mutates: false, body: { actors } }
    },

    'actor.invite': ({ state, payload, now }) => {
      const name = text(payload.name, 'name', 60)
      if (nameTaken(state, name)) throw companyFail('actor/name-taken', `A person named ${name} is already invited.`, { field: 'name' })
      const id = newId('hum')
      state.actors[id] = { id, kind: 'human', name, status: 'active', created_at: now(), updated_at: now(), revision: 1 }
      return {
        aggregate_id: id,
        body: { actor: actorView(state, state.actors[id]) },
        events: [{ type: 'actor.invited', data: { actor_id: id } }],
      }
    },

    'actor.update': ({ state, payload, now }) => {
      const actor = humanOnly(actorOf(state, payload.actor_id))
      rowRevision(payload, actor, 'person')
      if (payload.name === undefined && payload.status === undefined) {
        throw companyFail('company/invalid', 'actor.update changes name or status.', { fields: ['name', 'status'] })
      }
      const changes = []
      if (payload.name !== undefined) {
        const name = text(payload.name, 'name', 60)
        // A save that repeats what the row already says is not a write: it must not bump the
        // revision or append an event, or the screen's next save would race a change nobody
        // made.
        if (name !== actor.name) {
          if (nameTaken(state, name, actor.id)) throw companyFail('actor/name-taken', `A person named ${name} is already invited.`, { field: 'name' })
          actor.name = name
          changes.push('name')
        }
      }
      if (payload.status !== undefined) {
        const status = text(payload.status, 'status', 20)
        if (!ACTOR_STATUSES.includes(status)) throw companyFail('company/invalid', `status is one of ${ACTOR_STATUSES.join(', ')}.`, { field: 'status', allowed: ACTOR_STATUSES })
        if (status !== actor.status) {
          actor.status = status
          changes.push('status')
        }
      }
      if (changes.length === 0) return { aggregate_id: actor.id, mutates: false, body: { actor: actorView(state, actor) } }
      actor.revision += 1
      actor.updated_at = now()
      return {
        aggregate_id: actor.id,
        body: { actor: actorView(state, actor) },
        events: [{ type: 'actor.updated', data: { actor_id: actor.id, fields: changes, status: actor.status } }],
      }
    },

    'grant.create': ({ state, payload, now }) => {
      const actor = humanOnly(actorOf(state, payload.actor_id))
      if (actor.status !== 'active') throw companyFail('actor/inactive', `Person ${actor.name} is disabled; restore them before granting anything.`, { actor_id: actor.id })
      const scopeType = text(payload.scope_type, 'scope_type', 20)
      if (scopeType !== 'company' && scopeType !== 'project') {
        throw companyFail('company/invalid', 'scope_type is company or project.', { field: 'scope_type', allowed: ['company', 'project'] })
      }
      const company = onlyCompany(state)
      let scopeId = null
      if (scopeType === 'company') {
        if (payload.scope_id !== undefined && payload.scope_id !== null && payload.scope_id !== '') {
          throw companyFail('company/invalid', 'A company grant carries no scope_id.', { field: 'scope_id' })
        }
      } else {
        const project = projectOf(state, payload.scope_id)
        if (company !== undefined && project.company_id !== company.id) throw companyFail('project/not-found', `No project ${project.id} in this company.`, { project_id: project.id })
        scopeId = project.id
      }
      const permissions = permissionsOfPayload(payload.permissions)
      const existing = Object.values(state.grants ?? {}).find(grant => grant.actor_id === actor.id && grant.scope_type === scopeType && (grant.scope_id ?? null) === scopeId)
      if (existing !== undefined) {
        throw companyFail('grant/exists', `Person ${actor.name} already holds a grant for that scope; revoke it before granting again.`, { grant_id: existing.id, actor_id: actor.id })
      }
      const id = newId('grt')
      state.grants[id] = { id, actor_id: actor.id, scope_type: scopeType, scope_id: scopeId, permissions, created_at: now(), updated_at: now(), revision: 1 }
      return {
        aggregate_id: id,
        body: { grant: grantView(state.grants[id]) },
        events: [{ type: 'grant.created', data: { grant_id: id, actor_id: actor.id, scope_type: scopeType, scope_id: scopeId } }],
      }
    },

    'grant.revoke': ({ state, payload }) => {
      const id = text(payload.grant_id, 'grant_id', 120)
      const grant = state.grants?.[id]
      if (grant === undefined) throw companyFail('grant/not-found', `No grant ${id}.`, { grant_id: id })
      rowRevision(payload, grant, 'grant')
      delete state.grants[id]
      return {
        aggregate_id: grant.id,
        body: { grant: grantView(grant) },
        events: [{ type: 'grant.revoked', data: { grant_id: grant.id, actor_id: grant.actor_id } }],
      }
    },
  }
}
