// Acceptance objects (M1b-2b): what a project asks the owner to confirm, and the owner's
// decision. An acceptance is its own object rather than a field of a task — M1b-3 adds the
// task table, and the contract lets an acceptance exist before one (`task_id` stays null
// until then), because the thing being accepted is a delivery with its own title.
//
// Two commands: `acceptance.submit` writes the object in `pending`, `acceptance.decide`
// moves it to `accepted` or `returned` once. Both are ordinary company commands, so they
// share the envelope, the `operation_key` replay record and the journal.
//
// `owner_only` is derived here, never taken from the caller. M1b-2 knows one source (the
// contract allows exactly one for now): the project's `acceptance_requirement`. A project
// configured `owner_only` can only be accepted by the owner, so a submission naming an
// employee actor is refused before anything is written; the reading side's fallback for
// older rows stays a fallback (contract §3.5, §5.2, A14).
import { newId } from './projects.js'
import { companyFail } from './store.js'

// The commands whose `expected_revision` names the object's own revision, not the company's.
// A to-do row carries the acceptance revision (contract A12/B-2) and `acceptance.decide`
// answers with that value, so `commands.js` must leave the check to this handler.
export const ROW_REVISION_COMMANDS = new Set(['acceptance.decide'])

const text = (value, field, max) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '') throw companyFail('company/invalid', `${field} is required.`, { field })
  if (trimmed.length > max) throw companyFail('company/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return trimmed
}

// Absent stays null: the contract's columns are nullable, and a screen can tell "not given"
// from "". A value of the wrong type is refused rather than coerced.
const optionalText = (value, field, max) => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw companyFail('company/invalid', `${field} must be text.`, { field })
  if (value.trim() === '') return null
  if (value.length > max) throw companyFail('company/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return value.trim()
}

const projectOf = (state, id) => {
  const project = state.projects?.[id]
  if (project === undefined) throw companyFail('project/not-found', `No project ${id}.`, { project_id: id })
  if (project.status === 'archived') throw companyFail('project/state-conflict', `Project ${id} is archived.`, { project_id: id, status: project.status })
  return project
}

// An acceptance names the staff member who delivered the work, so that person has to be a
// live member of the project it belongs to — the same rule the project commands use.
const activeMemberOf = (state, projectId, employeeId) => Object.values(state.members ?? {})
  .some(member => member?.project_id === projectId && member?.employee_id === employeeId && member?.membership_status === 'active')

const activeEmployeeOf = (state, employeeId, field = 'requester_employee_id') => {
  const employee = state.employees?.[employeeId]
  if (employee === undefined) throw companyFail('employee/not-found', `No employee ${employeeId}.`, { field, employee_id: employeeId })
  if (employee.status !== 'active') throw companyFail('company/invalid', `Employee ${employeeId} is not active.`, { field, employee_id: employeeId })
  return employee
}

// Who the acceptance is for: the request's value when given, else the project's own setting.
// `user` is the owner; any other value has to be an active member of the project.
const actorOf = (state, project, value) => {
  const actor = value === undefined || value === null || value === '' ? project.acceptance_actor : value
  if (actor === undefined || actor === null || actor === '') return null
  if (actor === 'user') return 'user'
  if (typeof actor !== 'string') throw companyFail('company/invalid', 'acceptance_actor must be "user" or an employee id.', { field: 'acceptance_actor' })
  const employee = activeEmployeeOf(state, actor, 'acceptance_actor')
  if (!activeMemberOf(state, project.id, employee.id)) {
    throw companyFail('project/member-not-found', `Employee ${employee.id} is not a member of project ${project.id}.`, { project_id: project.id, employee_id: employee.id })
  }
  return employee.id
}

export function acceptanceHandlers() {
  return {
    // Submit one acceptance for the owner. Allowed again for the same project, title and
    // version: a new delivery is a new acceptance object, not a reopened one.
    'acceptance.submit': async ({ state, payload, now }) => {
      const project = projectOf(state, text(payload.project_id, 'project_id', 120))
      const requester = activeEmployeeOf(state, text(payload.requester_employee_id, 'requester_employee_id', 120))
      if (!activeMemberOf(state, project.id, requester.id)) {
        throw companyFail('project/member-not-found', `Employee ${requester.id} is not a member of project ${project.id}.`, { project_id: project.id, employee_id: requester.id })
      }
      const actor = actorOf(state, project, payload.acceptance_actor)
      const ownerOnly = project.acceptance_requirement === 'owner_only'
      // Submission-side enforcement (owner decision 10:34): a project that only the owner
      // may accept cannot be submitted for a Bot, even if the caller asks for one. Nothing
      // is written when this fails.
      if (ownerOnly && actor !== 'user') {
        throw companyFail('owner_only_requires_user', 'An owner_only acceptance belongs to the owner; set acceptance_actor to "user".', { project_id: project.id, acceptance_actor: actor })
      }
      const acceptance = {
        id: newId('acc'),
        project_id: project.id,
        task_id: null,
        title: text(payload.title, 'title', 200),
        submitted_version: optionalText(payload.submitted_version, 'submitted_version', 120),
        acceptance_criteria: optionalText(payload.acceptance_criteria, 'acceptance_criteria', 2000),
        requester_employee_id: requester.id,
        acceptance_actor: actor,
        owner_only: ownerOnly,
        state: 'pending',
        opinion: null,
        decided_at: null,
        created_at: now(),
        updated_at: now(),
        revision: 1,
      }
      state.acceptances[acceptance.id] = acceptance
      return {
        aggregate_id: acceptance.id,
        body: { acceptance },
        events: [{ type: 'acceptance.submitted', data: { acceptance_id: acceptance.id, project_id: project.id } }],
      }
    },

    // Answer one acceptance. `expected_revision` comes from the to-do row and names the
    // acceptance, not the company (A12): a stale screen is refused and the object keeps its
    // pending state, so a retry reads the new row rather than landing on the old decision.
    'acceptance.decide': async ({ state, payload, now }) => {
      const acceptanceId = text(payload.acceptance_id, 'acceptance_id', 120)
      const acceptance = state.acceptances?.[acceptanceId]
      if (acceptance === undefined) throw companyFail('acceptance/not-found', `No acceptance ${acceptanceId}.`, { acceptance_id: acceptanceId })
      const decision = payload.decision
      if (decision !== 'accept' && decision !== 'return') {
        throw companyFail('company/invalid', 'decision is accept or return.', { field: 'decision', allowed: ['accept', 'return'] })
      }
      const expected = payload.expected_revision
      if (!Number.isInteger(expected) || expected !== acceptance.revision) {
        throw companyFail('company/revision-conflict', `Acceptance ${acceptanceId} is at revision ${acceptance.revision}, not ${expected}.`, { acceptance_id: acceptanceId, expected_revision: expected ?? null, revision: acceptance.revision })
      }
      // A decision is final: accepting or returning twice would rewrite a recorded answer,
      // and a re-acceptance is a new object (contract §2.2).
      if (acceptance.state !== 'pending') {
        throw companyFail('acceptance/state-conflict', `Acceptance ${acceptanceId} is ${acceptance.state}.`, { acceptance_id: acceptanceId, state: acceptance.state })
      }
      acceptance.state = decision === 'accept' ? 'accepted' : 'returned'
      acceptance.opinion = optionalText(payload.opinion, 'opinion', 500)
      acceptance.decided_at = now()
      acceptance.updated_at = now()
      acceptance.revision += 1
      return {
        aggregate_id: acceptance.id,
        body: { acceptance },
        // The journal records the decision and not the owner's words: the opinion is
        // business text and stays in the object (contract §5.2).
        events: [{ type: 'acceptance.decided', data: { acceptance_id: acceptance.id, decision } }],
      }
    },
  }
}
