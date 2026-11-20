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
import { holdFor } from './tasks.js'
import { actorKindOf, isOwnerActor } from './access.js'

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
  if (employee.status !== 'active') throw companyFail('employee/inactive', `Employee ${employeeId} is dismissed; re-activate them before they take part in an acceptance.`, { field, employee_id: employeeId })
  return employee
}

// Who the acceptance is for: the request's value when given, else the project's own setting.
// `user` is the owner; any other value has to be an active member of the project.
const actorOf = (state, project, value) => {
  const actor = value === undefined || value === null || value === '' ? project.acceptance_actor : value
  if (actor === undefined || actor === null || actor === '') return null
  const kind = actorKindOf(state, actor)
  if (kind === 'owner') return 'user'
  if (kind === 'human') {
    const human = state.actors[actor]
    if (human.status !== 'active') throw companyFail('actor/inactive', `Person ${human.name ?? actor} is disabled; restore them before naming them as the acceptor.`, { field: 'acceptance_actor', actor_id: actor })
    return actor
  }
  if (typeof actor !== 'string') throw companyFail('company/invalid', 'acceptance_actor must be the owner, a person id or an employee id.', { field: 'acceptance_actor' })
  const employee = activeEmployeeOf(state, actor, 'acceptance_actor')
  if (!activeMemberOf(state, project.id, employee.id)) {
    throw companyFail('project/member-not-found', `Employee ${employee.id} is not a member of project ${project.id}.`, { project_id: project.id, employee_id: employee.id })
  }
  return employee.id
}

// One task has at most one open review: the pending record it was submitted with. The
// check is shared by `task.submit` (which creates it) and the optional `acceptance.submit`
// link, so a second delivery cannot queue behind the first.
export const pendingAcceptanceOfTask = (state, taskId) =>
  Object.values(state.acceptances ?? {}).find(row => row?.task_id === taskId && row?.state === 'pending') ?? null

// The pending record `task.submit` creates in the same commit (contract §5.3.4). It lives
// here rather than in tasks.js so the row shape, the owner_only rule and the one-pending
// rule stay with acceptance.submit; the task command only moves the card.
export function createPendingForTask(state, task, payload, project, now) {
  const existing = pendingAcceptanceOfTask(state, task.id)
  if (existing !== null) throw companyFail('acceptance/state-conflict', `Task ${task.id} already has a pending acceptance.`, { task_id: task.id, acceptance_id: existing.id })
  const owner = task.owner_assignment_id === null ? undefined : state.members?.[task.owner_assignment_id]
  if (owner === undefined || owner.membership_status !== 'active') throw companyFail('task/missing-input', 'The task has no active owner to submit for.', { task_id: task.id, missing: ['owner_assignment_id'] })
  // The task's acceptor is the default; a caller may name another one, and the same
  // membership and owner_only rules apply as in acceptance.submit.
  const actor = payload.acceptance_actor === undefined || payload.acceptance_actor === null
    ? task.acceptance_actor
    : actorOf(state, project, payload.acceptance_actor)
  const ownerOnly = task.acceptance_requirement === 'owner_only'
  if (ownerOnly && !isOwnerActor(state, actor)) {
    throw companyFail('owner_only_requires_user', 'An owner_only acceptance belongs to the owner; set acceptance_actor to "user".', { project_id: project.id, acceptance_actor: actor })
  }
  const checks = task.acceptance_checks ?? []
  const criteria = optionalText(payload.acceptance_criteria, 'acceptance_criteria', 2000) ?? (checks.join('\n') || null)
  const acceptance = {
    id: newId('acc'),
    project_id: project.id,
    task_id: task.id,
    task_revision: task.task_revision,
    title: text(payload.title === undefined ? task.title : payload.title, 'title', 200),
    submitted_version: optionalText(payload.submitted_version, 'submitted_version', 120),
    acceptance_criteria: criteria,
    requester_employee_id: owner.employee_id,
    acceptance_actor: actor,
    owner_only: ownerOnly,
    state: 'pending',
    opinion: null,
    decided_at: null,
    close_reason: null,
    created_at: now(),
    updated_at: now(),
    revision: 1,
  }
  state.acceptances[acceptance.id] = acceptance
  return acceptance
}

// The same commit moves the card and creates its pending record (contract §5.3.4). Wrapped
// around the task command rather than inside it, so tasks.js keeps its single subject and
// the acceptance row shape still comes from this module.
export const submitWithAcceptance = submit => (args) => {
  const outcome = submit(args)
  const task = args.state.tasks[outcome.aggregate_id]
  const project = args.state.projects[task.project_id]
  const acceptance = createPendingForTask(args.state, task, args.payload, project, args.now)
  return {
    ...outcome,
    body: { ...outcome.body, acceptance },
    events: [...(outcome.events ?? []), { type: 'acceptance.submitted', data: { acceptance_id: acceptance.id, project_id: project.id, employee_id: acceptance.requester_employee_id, task_id: task.id } }],
  }
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
      if (ownerOnly && !isOwnerActor(state, actor)) {
        throw companyFail('owner_only_requires_user', 'An owner_only acceptance belongs to the owner; set acceptance_actor to "user".', { project_id: project.id, acceptance_actor: actor })
      }
      // v1.12 allows a task link on an independently submitted acceptance (§5 row 183).
      // `task.submit` creates its record through createPendingForTask; this path is for a
      // screen that already holds a review and attaches the delivery to it.
      const taskId = payload.task_id === undefined || payload.task_id === null ? null : text(payload.task_id, 'task_id', 120)
      let taskRevision = null
      if (taskId !== null) {
        const task = state.tasks?.[taskId]
        if (task === undefined) throw companyFail('task/not-found', `No task ${taskId}.`, { task_id: taskId })
        if (task.project_id !== project.id) throw companyFail('company/invalid', 'task_id belongs to another project.', { field: 'task_id', task_id: taskId, project_id: project.id })
        if (task.stage !== 'review') throw companyFail('task/state-conflict', `Task ${taskId} is ${task.stage}, not review.`, { task_id: taskId, stage: task.stage, expected: 'review' })
        if (!Number.isInteger(payload.task_revision) || payload.task_revision !== task.task_revision) {
          throw companyFail('task/revision-conflict', `Task ${taskId} is at revision ${task.task_revision}, not ${payload.task_revision ?? null}.`, { task_id: taskId, expected_revision: payload.task_revision ?? null, revision: task.task_revision })
        }
        const pending = pendingAcceptanceOfTask(state, taskId)
        if (pending !== null) throw companyFail('acceptance/state-conflict', `Task ${taskId} already has a pending acceptance.`, { task_id: taskId, acceptance_id: pending.id })
        taskRevision = task.task_revision
      }
      const acceptance = {
        id: newId('acc'),
        project_id: project.id,
        task_id: taskId,
        task_revision: taskRevision,
        title: text(payload.title, 'title', 200),
        submitted_version: optionalText(payload.submitted_version, 'submitted_version', 120),
        acceptance_criteria: optionalText(payload.acceptance_criteria, 'acceptance_criteria', 2000),
        requester_employee_id: requester.id,
        acceptance_actor: actor,
        owner_only: ownerOnly,
        state: 'pending',
        opinion: null,
        decided_at: null,
        // Closure reasons are written by the system only (project archive, M1c); a fresh
        // submission is never closed (contract §2.2 / §5.2).
        close_reason: null,
        created_at: now(),
        updated_at: now(),
        revision: 1,
      }
      state.acceptances[acceptance.id] = acceptance
      return {
        aggregate_id: acceptance.id,
        body: { acceptance },
        // The submitting employee travels with the event so the project page can name the
        // person without a second lookup. Older lines keep their text; readers fall back to
        // the generic member label when the field is absent.
        events: [{ type: 'acceptance.submitted', data: { acceptance_id: acceptance.id, project_id: project.id, employee_id: acceptance.requester_employee_id, task_id: taskId } }],
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
      // A task-linked record decides the card too (contract §5.3.7). The checks run before
      // either object is written: a stale or cancelled card leaves the acceptance pending.
      const linked = acceptance.task_id ?? null
      let task = null
      if (linked !== null) {
        task = state.tasks?.[linked]
        if (task === undefined || task.project_id !== acceptance.project_id) {
          throw companyFail('task/not-found', `No task ${linked} on project ${acceptance.project_id}.`, { task_id: linked, acceptance_id: acceptance.id })
        }
        if (task.stage !== 'review') throw companyFail('task/state-conflict', `Task ${linked} is ${task.stage}, not review.`, { task_id: linked, stage: task.stage, expected: 'review' })
        const expectedTask = acceptance.task_revision
        if (task.task_revision !== expectedTask) {
          throw companyFail('task/revision-conflict', `Task ${linked} is at revision ${task.task_revision}, not ${expectedTask}.`, { task_id: linked, expected_revision: expectedTask, revision: task.task_revision })
        }
      }
      acceptance.state = decision === 'accept' ? 'accepted' : 'returned'
      acceptance.opinion = optionalText(payload.opinion, 'opinion', 500)
      acceptance.decided_at = now()
      acceptance.updated_at = now()
      acceptance.revision += 1
      // The acceptance is the only writer of a reviewed card's exit: accept ends the task,
      // return puts it back to ready with its dependencies recomputed (never `doing`).
      const events = [{ type: 'acceptance.decided', data: { acceptance_id: acceptance.id, project_id: acceptance.project_id, decision, task_id: acceptance.task_id ?? null, task_stage: null } }]
      if (task !== null) {
        if (decision === 'accept') {
          task.stage = 'done'
          task.hold_reason = 'none'
          task.completed_at = now()
        } else {
          task.stage = 'ready'
          task.completed_at = null
          task.hold_reason = holdFor(state, task)
        }
        task.task_revision += 1
        task.updated_at = now()
        events[0].data.task_stage = task.stage
        events.push({ type: 'task.moved', data: { task_id: task.id, project_id: task.project_id, from: 'review', to: task.stage, task_revision: task.task_revision, acceptance_id: acceptance.id } })
      }
      return {
        aggregate_id: acceptance.id,
        body: { acceptance },
        // The journal records the decision and not the owner's words: the opinion is
        // business text and stays in the object (contract §5.2). The project id rides on
        // the event itself, so a project's activity is readable without walking every
        // acceptance; older decisions that lack it are resolved from the acceptance record.
        events,
      }
    },

    // The project page's decisions feed (contract §5.3.7): newest first, archived projects
    // stay readable, and the command is a read so it writes no operation_log row.
    'acceptance.list': ({ state, payload }) => {
      const projectId = text(payload.project_id, 'project_id', 120)
      const project = state.projects?.[projectId]
      if (project === undefined) throw companyFail('project/not-found', `No project ${projectId}.`, { project_id: projectId })
      const taskId = payload.task_id === undefined || payload.task_id === null ? null : text(payload.task_id, 'task_id', 120)
      const wanted = payload.state === undefined ? null : text(payload.state, 'state', 20)
      if (wanted !== null && !['pending', 'accepted', 'returned', 'cancelled', 'expired'].includes(wanted)) {
        throw companyFail('company/invalid', 'state is one of pending, accepted, returned, cancelled, expired.', { field: 'state', allowed: ['pending', 'accepted', 'returned', 'cancelled', 'expired'] })
      }
      const limit = payload.limit === undefined ? 50 : payload.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw companyFail('company/invalid', 'limit is an integer from 1 to 200.', { field: 'limit', min: 1, max: 200 })
      }
      const acceptances = Object.values(state.acceptances ?? {})
        .filter(row => row.project_id === projectId)
        .filter(row => taskId === null || (row.task_id ?? null) === taskId)
        .filter(row => wanted === null || row.state === wanted)
        .sort((left, right) => (right.created_at ?? 0) - (left.created_at ?? 0) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(row => ({ ...row, task_id: row.task_id ?? null, task_revision: row.task_revision ?? null }))
      return { aggregate_id: projectId, body: { acceptances }, mutates: false }
    },
  }
}
