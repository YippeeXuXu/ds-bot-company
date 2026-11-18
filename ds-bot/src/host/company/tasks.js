// Task objects (M1b-3.3): the piece of work one project moves through its board. A task is
// its own row rather than a field of a project, because a project holds many at once and a
// card outlives the Run that executed it.
//
// Five commands: `task.create`, `task.update`, `task.move`, `task.submit`, `task.reopen`.
// `task.list` is the one read, so a board asks one command for the project's cards.
//
// The state machine is the one in the contract (§3.2), split by who may write it. This
// module owns the plain moves: draft→ready, ready→doing, and non-terminal→cancelled.
// `doing→review` is `task.submit`, because a review starts only with the evidence a Run
// submits. `review→done` and `review→ready` are not moves at all: an acceptance record
// decides them (M1b-3.3b / 4.4), so a drag or a menu can request `done` and be refused with
// `task/acceptance-required`. `done→ready` is `task.reopen`, with its reason and new
// revision. Every change to a task bumps its integer `task_revision`; the commands that
// name a task take `expected_revision` and are checked against it, so two screens editing
// one card cannot silently overwrite each other.
//
// `task.submit` records the delivery on the task here, and leaves the acceptance record to
// 4.4: the same commit that moves a task to review will create its `pending` acceptance.
// Keeping the seam explicit is why this module never touches `acceptances.js`.
import { newId } from './projects.js'
import { companyFail } from './store.js'

// `task.update`, `task.move`, `task.submit` and `task.reopen` are answered with the
// revision of the task itself, not the company's; commands.js must leave that comparison to
// the handler. A board reads a card's revision and writes it back on the next action.
export const TASK_ROW_REVISION_COMMANDS = new Set(['task.update', 'task.move', 'task.submit', 'task.reopen'])

const STAGES = ['draft', 'ready', 'doing', 'review', 'done', 'cancelled']
const DELIVERABLE_CLASSES = ['normal', 'sensitive', 'final_delivery']
const SENSITIVE_CLASSES = new Set(['sensitive', 'final_delivery'])
const OPEN_PROJECTS = ['setup', 'active']

// A plain status request may only take these steps. `review` is absent on purpose: its
// exit is a decision (acceptance.decide) or a cancellation, never a move.
const MOVES = {
  draft: ['ready', 'cancelled'],
  ready: ['doing', 'cancelled'],
  doing: ['cancelled'],
  review: ['cancelled'],
  done: [],
  cancelled: [],
}

const isTable = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export const text = (value, field, max = 120) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '') throw companyFail('company/invalid', `${field} is required.`, { field })
  if (trimmed.length > max) throw companyFail('company/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return trimmed
}

// Absent stays null: a screen has to tell "not filled in" from "". A wrong type is refused
// rather than coerced, so a number in a text column never quietly becomes "42".
export const optionalText = (value, field, max = 2000) => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw companyFail('company/invalid', `${field} must be text.`, { field })
  if (value.trim() === '') return null
  if (value.length > max) throw companyFail('company/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return value.trim()
}

const textList = (value, field, { maxItems = 50, maxLength = 500, allowEmpty = true, unique = true } = {}) => {
  if (!Array.isArray(value)) throw companyFail('company/invalid', `${field} is a list of text.`, { field })
  if (!allowEmpty && value.length === 0) throw companyFail('company/invalid', `${field} needs at least one entry.`, { field })
  if (value.length > maxItems) throw companyFail('company/invalid', `${field} holds at most ${maxItems} entries.`, { field, max: maxItems })
  const items = value.map((entry, index) => text(entry, `${field}[${index}]`, maxLength))
  if (unique && new Set(items).size !== items.length) throw companyFail('company/invalid', `${field} lists an entry twice.`, { field })
  return items
}

const revisionOf = (payload) => {
  if (!Number.isInteger(payload.expected_revision)) throw companyFail('company/invalid', 'expected_revision is required; it names the task revision you read.', { field: 'expected_revision' })
  return payload.expected_revision
}

export const projectOf = (state, id, { writable = true } = {}) => {
  const key = typeof id === 'string' ? id.trim() : ''
  if (key === '') throw companyFail('company/invalid', 'project_id is required.', { field: 'project_id' })
  const project = state.projects[key]
  if (project === undefined) throw companyFail('project/not-found', `No project ${id}.`, { project_id: id })
  if (writable && !OPEN_PROJECTS.includes(project.status)) {
    throw companyFail('project/state-conflict', `Project ${project.name} is ${project.status}; its tasks cannot change.`, { project_id: project.id, status: project.status })
  }
  return project
}

export const taskOf = (state, id) => {
  const key = typeof id === 'string' ? id.trim() : ''
  if (key === '') throw companyFail('company/invalid', 'task_id is required.', { field: 'task_id' })
  const task = state.tasks?.[key]
  if (task === undefined) throw companyFail('task/not-found', `No task ${id}.`, { task_id: id })
  return task
}

export const memberOf = (state, projectId, assignmentId, field) => {
  const id = text(assignmentId, field, 120)
  const member = state.members[id]
  if (member === undefined || member.project_id !== projectId || member.membership_status !== 'active') {
    throw companyFail('project/member-not-found', `The owner is not an active member of this project.`, { field, assignment_id: id })
  }
  return member
}

export const employeeOf = (state, id, field) => {
  const employee = state.employees[text(id, field, 120)]
  if (employee === undefined) throw companyFail('employee/not-found', `No employee ${id}.`, { field })
  if (employee.status !== 'active') throw companyFail('employee/inactive', `Employee ${employee.name} is not active.`, { field, employee_id: employee.id })
  return employee
}

const requirementOf = (project, deliverableClass) => (
  project.acceptance_requirement === 'owner_only' || SENSITIVE_CLASSES.has(deliverableClass) ? 'owner_only' : 'daily_independent_bot'
)

// The acceptor named on a task, or inherited from the project. A Bot is refused for an
// owner-only requirement exactly as the project layer refuses it; a `user` is refused for a
// daily requirement because D7 wants an independent Bot there.
const actorOf = (state, project, value, requirement, field) => {
  if (value === undefined || value === null || value === '') return null
  if (value === 'user') return 'user'
  const employee = employeeOf(state, value, field)
  if (requirement === 'owner_only') throw companyFail('project/owner-required', 'owner_only acceptance belongs to the owner.', { field })
  return employee.id
}

const classOf = (value, field) => {
  const name = text(value, field, 40)
  if (!DELIVERABLE_CLASSES.includes(name)) throw companyFail('company/invalid', `${field} is one of ${DELIVERABLE_CLASSES.join(', ')}.`, { field, allowed: DELIVERABLE_CLASSES })
  return name
}

const dependenciesOf = (value, field = 'dependencies') => textList(value, field, { maxItems: 50, maxLength: 120, allowEmpty: true })

// Every dependency has to be a task of the same project, and adding it must not close a
// loop. The path is reported with the refusal so a screen can name the tasks, not only say
// that something is circular.
const findPathTo = (state, from, target, seen = new Set()) => {
  if (from === target) return [from]
  if (seen.has(from)) return undefined
  seen.add(from)
  const node = state.tasks?.[from]
  if (node === undefined) return undefined
  for (const next of node.dependencies ?? []) {
    const rest = findPathTo(state, next, target, seen)
    if (rest !== undefined) return [from, ...rest]
  }
  return undefined
}

const assertDependencies = (state, project, taskId, dependencies) => {
  for (const id of dependencies) {
    if (id === taskId) throw companyFail('task/dependency-cycle', 'A task cannot depend on itself.', { task_id: taskId, path: [taskId, taskId], kind: 'dependency' })
    const dependency = state.tasks?.[id]
    if (dependency === undefined || dependency.project_id !== project.id) {
      throw companyFail('task/dependency-missing', `No task ${id} in this project.`, { task_id: taskId, dependency_id: id })
    }
  }
  for (const id of dependencies) {
    const path = findPathTo(state, id, taskId)
    if (path !== undefined) throw companyFail('task/dependency-cycle', `This dependency closes a cycle: ${[taskId, ...path].join(' → ')}.`, { task_id: taskId, path: [taskId, ...path], kind: 'dependency' })
  }
}

const assertParent = (state, project, taskId, parentId) => {
  if (parentId === null) return
  const parent = state.tasks?.[parentId]
  if (parent === undefined || parent.project_id !== project.id) throw companyFail('task/not-found', `No parent task ${parentId} in this project.`, { task_id: parentId })
  const path = [taskId]
  const seen = new Set()
  let cursor = parentId
  while (cursor !== null && cursor !== undefined) {
    path.push(cursor)
    if (cursor === taskId) throw companyFail('task/parent-cycle', `This parent closes a cycle: ${path.join(' → ')}.`, { task_id: taskId, path, kind: 'parent' })
    if (seen.has(cursor)) return
    seen.add(cursor)
    cursor = state.tasks?.[cursor]?.parent_id ?? null
  }
}

// What a Ready card must carry (contract §2). An input-ref list may be explicitly empty;
// the other five cannot be missing, and the acceptor must fit the derived requirement.
const readyProblems = (state, task) => {
  const problems = []
  const owner = task.owner_assignment_id === null ? undefined : state.members[task.owner_assignment_id]
  if (task.owner_assignment_id === null) problems.push({ field: 'owner_assignment_id', message: 'Name the owner.' })
  else if (owner === undefined || owner.project_id !== task.project_id || owner.membership_status !== 'active') problems.push({ field: 'owner_assignment_id', message: 'The owner is not an active member of this project.' })
  if (!Array.isArray(task.input_refs)) problems.push({ field: 'input_refs', message: 'List the inputs, even as an empty list.' })
  if (!Array.isArray(task.acceptance_checks) || task.acceptance_checks.length === 0) problems.push({ field: 'acceptance_checks', message: 'Name at least one acceptance check.' })
  if (task.acceptance_actor === null) problems.push({ field: 'acceptance_actor', message: 'Name the acceptor.' })
  else if (task.acceptance_actor === 'user') {
    if (task.acceptance_requirement === 'daily_independent_bot') problems.push({ field: 'acceptance_actor', message: 'Daily work is accepted by an independent Bot, not the owner.' })
  } else {
    const acceptor = state.employees[task.acceptance_actor]
    if (acceptor === undefined || acceptor.status !== 'active') problems.push({ field: 'acceptance_actor', message: 'The acceptor is not an active employee.' })
    else if (task.acceptance_requirement === 'owner_only') problems.push({ field: 'acceptance_actor', message: 'This delivery is accepted by the owner only.' })
  }
  if (task.authorization_scope_ref === null) problems.push({ field: 'authorization_scope_ref', message: 'Name the authorization scope.' })
  return problems
}

const assertReady = (state, task) => {
  const problems = readyProblems(state, task)
  if (problems.length === 0) return
  throw companyFail('task/missing-input', `Ready needs ${problems.map(problem => problem.field).join(', ')}.`, { task_id: task.id, missing: problems.map(problem => problem.field), problems })
}

const holdFor = (state, task) => {
  if (task.stage !== 'ready') return 'none'
  const unmet = (task.dependencies ?? []).some(id => state.tasks?.[id]?.stage !== 'done')
  return unmet ? 'dependency' : 'none'
}

export const unmetDependencies = (state, task) => (task.dependencies ?? [])
  .map(id => state.tasks?.[id])
  .filter(dependency => dependency !== undefined && dependency.stage !== 'done')
  .map(dependency => ({ task_id: dependency.id, title: dependency.title, stage: dependency.stage }))

export const bump = (task, now) => {
  task.task_revision += 1
  task.updated_at = now()
}

export const taskView = task => ({
  ...task,
  input_refs: [...(task.input_refs ?? [])],
  acceptance_checks: [...(task.acceptance_checks ?? [])],
  dependencies: [...(task.dependencies ?? [])],
  problem_ids: [...(task.problem_ids ?? [])],
  artifact_refs: [...(task.artifact_refs ?? [])],
  submissions: (task.submissions ?? []).map(entry => ({
    ...entry,
    artifact_refs: [...(entry.artifact_refs ?? [])],
    check_notes: [...(entry.check_notes ?? [])],
  })),
})

// The fields a coordinator may fill in or correct. `stage`, `hold_reason`,
// `acceptance_requirement`, `deliverable_class_source` and `independence_required` are
// derived here, never taken from the caller.
const applyFields = (state, project, task, payload, changes) => {
  if (payload.title !== undefined) {
    const next = text(payload.title, 'title', 200)
    if (next !== task.title) {
      task.title = next
      changes.push('title')
    }
  }
  if (payload.description !== undefined) {
    const next = optionalText(payload.description, 'description', 4000)
    if (next !== task.description) {
      task.description = next
      changes.push('description')
    }
  }
  if (payload.source_ref !== undefined) {
    const next = text(payload.source_ref, 'source_ref', 500)
    if (next !== task.source_ref) {
      task.source_ref = next
      changes.push('source_ref')
    }
  }
  if (payload.next_action !== undefined) {
    const next = optionalText(payload.next_action, 'next_action', 500)
    if (next !== task.next_action) {
      task.next_action = next
      changes.push('next_action')
    }
  }
  if (payload.deliverable_class !== undefined) {
    const next = classOf(payload.deliverable_class, 'deliverable_class')
    if (next !== task.deliverable_class) {
      if (task.stage !== 'draft' && SENSITIVE_CLASSES.has(task.deliverable_class) && !SENSITIVE_CLASSES.has(next)) {
        throw companyFail('task/downgrade-forbidden', 'A sensitive or final delivery cannot be lowered after draft.', { task_id: task.id, from: task.deliverable_class, to: next })
      }
      task.deliverable_class = next
      task.deliverable_class_source = 'request'
      changes.push('deliverable_class')
    }
  }
  // Derived after a possible class change, so the acceptor is checked against what the
  // task now needs.
  task.acceptance_requirement = requirementOf(project, task.deliverable_class)
  task.independence_required = task.acceptance_requirement === 'daily_independent_bot'
  if (payload.acceptance_actor !== undefined) {
    const next = actorOf(state, project, payload.acceptance_actor, task.acceptance_requirement, 'acceptance_actor')
    if (next !== task.acceptance_actor) {
      task.acceptance_actor = next
      changes.push('acceptance_actor')
    }
  }
  if (payload.owner_assignment_id !== undefined) {
    const next = payload.owner_assignment_id === null ? null : memberOf(state, project.id, payload.owner_assignment_id, 'owner_assignment_id').id
    if (next !== task.owner_assignment_id) {
      task.owner_assignment_id = next
      changes.push('owner_assignment_id')
    }
  }
  if (payload.parent_id !== undefined) {
    const next = payload.parent_id === null ? null : text(payload.parent_id, 'parent_id', 120)
    if (next !== null) assertParent(state, project, task.id, next)
    if (next !== task.parent_id) {
      task.parent_id = next
      changes.push('parent_id')
    }
  }
  if (payload.input_refs !== undefined) {
    const next = textList(payload.input_refs, 'input_refs', { maxItems: 50, maxLength: 500, allowEmpty: true })
    if (JSON.stringify(next) !== JSON.stringify(task.input_refs)) {
      task.input_refs = next
      changes.push('input_refs')
    }
  }
  if (payload.acceptance_checks !== undefined) {
    // Freeze the evidence contract while a review is open: the submission is checked
    // against exactly the list it was made with.
    if (task.stage === 'review') throw companyFail('task/state-conflict', 'A task in review keeps the checks it was submitted with; cancel it to stop.', { task_id: task.id, stage: 'review', field: 'acceptance_checks' })
    const next = textList(payload.acceptance_checks, 'acceptance_checks', { maxItems: 20, maxLength: 500, allowEmpty: true })
    if (JSON.stringify(next) !== JSON.stringify(task.acceptance_checks)) {
      task.acceptance_checks = next
      changes.push('acceptance_checks')
    }
  }
  if (payload.dependencies !== undefined) {
    const next = dependenciesOf(payload.dependencies)
    if (JSON.stringify(next) !== JSON.stringify(task.dependencies)) {
      assertDependencies(state, project, task.id, next)
      task.dependencies = next
      changes.push('dependencies')
    }
  }
  if (payload.authorization_scope_ref !== undefined) {
    const next = optionalText(payload.authorization_scope_ref, 'authorization_scope_ref', 500)
    if (next !== task.authorization_scope_ref) {
      task.authorization_scope_ref = next
      changes.push('authorization_scope_ref')
    }
  }
  return changes
}

const editable = (task) => {
  if (task.stage === 'review') throw companyFail('task/state-conflict', 'A task in review is decided by its acceptance, not edited.', { task_id: task.id, stage: 'review' })
  if (task.stage === 'done' || task.stage === 'cancelled') throw companyFail('task/state-conflict', `A task that is ${task.stage} is not edited; reopen it or make a new one.`, { task_id: task.id, stage: task.stage })
}

export function taskHandlers() {
  return {
    'task.create': ({ state, payload, now }) => {
      const project = projectOf(state, payload.project_id)
      const stage = payload.stage === undefined ? 'draft' : text(payload.stage, 'stage', 20)
      if (stage !== 'draft' && stage !== 'ready') throw companyFail('company/invalid', 'A task is created in draft or ready.', { field: 'stage', allowed: ['draft', 'ready'] })
      const id = newId('tsk')
      const createdAt = now()
      const task = {
        id,
        project_id: project.id,
        title: text(payload.title, 'title', 200),
        description: optionalText(payload.description, 'description', 4000),
        source_ref: text(payload.source_ref, 'source_ref', 500),
        parent_id: null,
        owner_assignment_id: null,
        stage: 'draft',
        hold_reason: 'none',
        next_action: optionalText(payload.next_action, 'next_action', 500),
        input_refs: [],
        acceptance_checks: [],
        acceptance_actor: null,
        deliverable_class: 'normal',
        deliverable_class_source: 'default',
        acceptance_requirement: requirementOf(project, 'normal'),
        independence_required: requirementOf(project, 'normal') === 'daily_independent_bot',
        dependencies: [],
        authorization_scope_ref: project.workspace_ref ?? null,
        task_revision: 1,
        problem_ids: [],
        artifact_refs: [],
        latest_run_id: null,
        submissions: [],
        ready_at: null,
        started_at: null,
        submitted_at: null,
        completed_at: null,
        reopened_at: null,
        reopen_reason: null,
        cancelled_at: null,
        cancelled_from: null,
        cancel_reason: null,
        created_at: createdAt,
        updated_at: createdAt,
      }
      if (task.acceptance_actor === null && project.acceptance_actor !== undefined && project.acceptance_actor !== null) {
        task.acceptance_actor = actorOf(state, project, project.acceptance_actor, task.acceptance_requirement, 'acceptance_actor')
      }
      applyFields(state, project, task, payload, [])
      if (stage === 'ready') {
        assertReady(state, task)
        task.stage = 'ready'
        task.hold_reason = holdFor(state, task)
      }
      if (state.tasks === undefined || !isTable(state.tasks)) state.tasks = {}
      state.tasks[id] = task
      return {
        aggregate_id: id,
        body: { task: taskView(task) },
        events: [{ type: 'task.created', data: { task_id: id, project_id: project.id, stage: task.stage, task_revision: task.task_revision } }],
      }
    },

    'task.update': ({ state, payload, now }) => {
      const task = taskOf(state, payload.task_id)
      const project = projectOf(state, task.project_id)
      const expected = revisionOf(payload)
      if (expected !== task.task_revision) throw companyFail('task/revision-conflict', `Task ${task.id} is at revision ${task.task_revision}, not ${expected}.`, { task_id: task.id, expected_revision: expected, revision: task.task_revision })
      editable(task)
      const changes = []
      applyFields(state, project, task, payload, changes)
      if (changes.length === 0) return { aggregate_id: task.id, body: { task: taskView(task) }, mutates: false }
      if (task.stage !== 'draft') assertReady(state, task)
      task.hold_reason = holdFor(state, task)
      bump(task, now)
      return {
        aggregate_id: task.id,
        body: { task: taskView(task) },
        events: [{ type: 'task.updated', data: { task_id: task.id, project_id: project.id, fields: changes, task_revision: task.task_revision } }],
      }
    },

    'task.move': ({ state, payload, now }) => {
      const task = taskOf(state, payload.task_id)
      const project = projectOf(state, task.project_id)
      const expected = revisionOf(payload)
      if (expected !== task.task_revision) throw companyFail('task/revision-conflict', `Task ${task.id} is at revision ${task.task_revision}, not ${expected}.`, { task_id: task.id, expected_revision: expected, revision: task.task_revision })
      const to = text(payload.to, 'to', 20)
      if (!STAGES.includes(to)) throw companyFail('company/invalid', `to is one of ${STAGES.join(', ')}.`, { field: 'to', allowed: STAGES })
      if (to === task.stage) return { aggregate_id: task.id, body: { task: taskView(task) }, mutates: false }
      if (task.stage === 'review' && (to === 'done' || to === 'ready')) {
        throw companyFail('task/acceptance-required', 'A review ends with an acceptance decision, not a move.', { task_id: task.id, stage: 'review', to, expected: 'acceptance.decide' })
      }
      const allowed = MOVES[task.stage] ?? []
      if (!allowed.includes(to)) throw companyFail('task/state-conflict', `A task cannot move from ${task.stage} to ${to}.`, { task_id: task.id, from: task.stage, to, allowed })
      const from = task.stage
      if (to === 'ready') {
        assertReady(state, task)
        task.stage = 'ready'
        task.hold_reason = holdFor(state, task)
        task.ready_at = now()
      } else if (to === 'doing') {
        // A dependency that is gone is not "done": refuse instead of starting work on a
        // card whose precondition no longer exists in the board.
        const missing = (task.dependencies ?? []).find(id => state.tasks?.[id] === undefined)
        if (missing !== undefined) {
          throw companyFail('task/dependency-missing', `No task ${missing} in this project.`, { task_id: task.id, dependency_id: missing })
        }
        const blocking = unmetDependencies(state, task)
        if (blocking.length > 0) throw companyFail('task/dependency-unmet', 'A dependency is not done yet.', { task_id: task.id, blocking })
        task.stage = 'doing'
        task.hold_reason = 'none'
        task.started_at = now()
      } else if (to === 'cancelled') {
        const reason = text(payload.reason, 'reason', 500)
        task.cancelled_from = from
        task.cancel_reason = reason
        task.cancelled_at = now()
        task.stage = 'cancelled'
        task.hold_reason = 'none'
      }
      bump(task, now)
      const events = to === 'cancelled'
        ? [{ type: 'task.cancelled', data: { task_id: task.id, project_id: project.id, from, task_revision: task.task_revision } }]
        : [{ type: 'task.moved', data: { task_id: task.id, project_id: project.id, from, to, task_revision: task.task_revision } }]
      return { aggregate_id: task.id, body: { task: taskView(task) }, events }
    },

    'task.submit': ({ state, payload, now }) => {
      const task = taskOf(state, payload.task_id)
      const project = projectOf(state, task.project_id)
      const expected = revisionOf(payload)
      if (expected !== task.task_revision) throw companyFail('task/revision-conflict', `Task ${task.id} is at revision ${task.task_revision}, not ${expected}.`, { task_id: task.id, expected_revision: expected, revision: task.task_revision })
      if (task.stage !== 'doing') throw companyFail('task/state-conflict', `Only a task being done can be submitted; this one is ${task.stage}.`, { task_id: task.id, stage: task.stage, expected: 'doing' })
      const owner = task.owner_assignment_id === null ? undefined : state.members[task.owner_assignment_id]
      if (owner === undefined || owner.membership_status !== 'active') throw companyFail('task/missing-input', 'The task has no active owner to submit for.', { task_id: task.id, missing: ['owner_assignment_id'] })
      const summary = text(payload.summary, 'summary', 2000)
      const artifactRefs = textList(payload.artifact_refs, 'artifact_refs', { maxItems: 50, maxLength: 1000, allowEmpty: false })
      const checks = task.acceptance_checks ?? []
      if (!Array.isArray(payload.check_notes) || payload.check_notes.length !== checks.length) {
        throw companyFail('company/invalid', `check_notes answers each of the ${checks.length} acceptance checks.`, { field: 'check_notes', expected: checks.length })
      }
      const checkNotes = payload.check_notes.map((note, index) => text(note, `check_notes[${index}]`, 1000))
      const submittedBy = payload.submitted_by_employee_id === undefined
        ? owner.employee_id
        : text(payload.submitted_by_employee_id, 'submitted_by_employee_id', 120)
      if (submittedBy !== owner.employee_id) throw companyFail('company/invalid', 'Only the owner submits this task.', { field: 'submitted_by_employee_id', owner_employee_id: owner.employee_id })
      task.submissions.push({
        task_revision: task.task_revision,
        summary,
        artifact_refs: artifactRefs,
        check_notes: checkNotes,
        submitted_by_employee_id: submittedBy,
        submitted_at: now(),
      })
      task.artifact_refs = [...new Set([...(task.artifact_refs ?? []), ...artifactRefs])]
      task.stage = 'review'
      task.hold_reason = 'none'
      task.submitted_at = now()
      bump(task, now)
      return {
        aggregate_id: task.id,
        body: { task: taskView(task) },
        events: [{ type: 'task.submitted', data: { task_id: task.id, project_id: project.id, stage: 'review', task_revision: task.task_revision } }],
      }
    },

    'task.reopen': ({ state, payload, now }) => {
      const task = taskOf(state, payload.task_id)
      const project = projectOf(state, task.project_id)
      const expected = revisionOf(payload)
      if (expected !== task.task_revision) throw companyFail('task/revision-conflict', `Task ${task.id} is at revision ${task.task_revision}, not ${expected}.`, { task_id: task.id, expected_revision: expected, revision: task.task_revision })
      if (task.stage !== 'done') throw companyFail('task/state-conflict', `Only a done task reopens; this one is ${task.stage}.`, { task_id: task.id, stage: task.stage, expected: 'done' })
      const reason = text(payload.reason, 'reason', 500)
      const changes = []
      applyFields(state, project, task, payload, changes)
      assertReady(state, task)
      task.stage = 'ready'
      task.hold_reason = holdFor(state, task)
      task.completed_at = null
      task.reopened_at = now()
      task.reopen_reason = reason
      bump(task, now)
      return {
        aggregate_id: task.id,
        body: { task: taskView(task) },
        events: [{ type: 'task.reopened', data: { task_id: task.id, project_id: project.id, task_revision: task.task_revision } }],
      }
    },

    'task.list': ({ state, payload }) => {
      const project = projectOf(state, payload.project_id, { writable: false })
      const stage = payload.stage === undefined ? undefined : text(payload.stage, 'stage', 20)
      if (stage !== undefined && !STAGES.includes(stage)) throw companyFail('company/invalid', `stage is one of ${STAGES.join(', ')}.`, { field: 'stage', allowed: STAGES })
      const owner = payload.owner_assignment_id === undefined ? undefined : text(payload.owner_assignment_id, 'owner_assignment_id', 120)
      const rows = Object.values(state.tasks ?? {})
        .filter(task => task.project_id === project.id)
        .filter(task => stage === undefined || task.stage === stage)
        .filter(task => owner === undefined || task.owner_assignment_id === owner)
        .sort((left, right) => (left.created_at ?? 0) - (right.created_at ?? 0) || left.id.localeCompare(right.id))
      return { aggregate_id: project.id, body: { tasks: rows.map(taskView) }, mutates: false }
    },
  }
}
