// The fields the project screens read next to the project itself: how many decisions
// wait for the owner, which of them the pinned card shows, and what happened recently.
//
// The waiting rows are not re-derived here. They come from `todos.read`, the same read
// the to-do page uses, so the chat header, the pinned card and the to-do count cannot
// disagree about how many decisions are waiting — a second projection would drift the
// first time one of them learned a new refusal.
//
// Activity is projected from the company state rather than from the event journal: the
// journal grows without bound, and every project screen opening the company model would
// otherwise re-read a whole file. The state keeps the timestamps this list needs (project
// creation and edits, membership changes, acceptance submissions and decisions), so the
// answer is derived, not cached.
const PIN_LIMIT = 3
const PENDING_LIMIT = 20
const ACTIVITY_LIMIT = 6

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

const EMPTY_VIEW = Object.freeze({ pending_count: 0, pending_decisions: [], pinned_decisions: [], activity: [] })

// Timestamps leave this module as ISO strings, so a caller can sort or render them
// without knowing whether the store wrote a number or a string.
const isoOf = value => {
  const time = typeof value === 'number' ? value : Date.parse(String(value ?? ''))
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null
}

const nameOf = (state, employeeId) => {
  const employee = employeeId == null ? undefined : state.employees?.[employeeId]
  return typeof employee?.name === 'string' && employee.name !== '' ? employee.name : null
}

const activityOf = (state, project) => {
  const rows = []
  const created = isoOf(project.created_at)
  if (created !== null) rows.push({ at: created, kind: 'project.created', name: null })
  const updated = isoOf(project.updated_at)
  // A project is created and first saved in the same write; the second row would only
  // repeat the first one under a different word.
  if (updated !== null && updated !== created) rows.push({ at: updated, kind: 'project.updated', name: null })
  for (const member of Object.values(state.members ?? {})) {
    if (!isObject(member) || member.project_id !== project.id) continue
    const name = nameOf(state, member.employee_id)
    const joined = isoOf(member.joined_at)
    if (joined !== null) rows.push({ at: joined, kind: 'member.joined', name })
    const left = isoOf(member.left_at)
    if (left !== null) rows.push({ at: left, kind: 'member.left', name })
  }
  for (const acceptance of Object.values(state.acceptances ?? {})) {
    if (!isObject(acceptance) || acceptance.project_id !== project.id) continue
    const name = nameOf(state, acceptance.requester_employee_id)
    const submitted = isoOf(acceptance.created_at)
    if (submitted !== null) rows.push({ at: submitted, kind: 'acceptance.submitted', name })
    const decided = isoOf(acceptance.decided_at)
    if (decided !== null) rows.push({ at: decided, kind: acceptance.state === 'accepted' ? 'acceptance.accepted' : 'acceptance.returned', name: null })
  }
  // Newest first. Equal timestamps fall back to the kind so a screen does not reshuffle
  // between two reads that saw the same state.
  rows.sort((left, right) => (left.at === right.at ? left.kind.localeCompare(right.kind) : right.at.localeCompare(left.at)))
  return rows.slice(0, ACTIVITY_LIMIT)
}

// One view per project, keyed by project id. Projects with nothing waiting and no
// activity still get an entry, so a caller can spread it without a missing-field branch.
export function projectViewsOf({ state, waiting = [] }) {
  const views = new Map()
  const viewOf = projectId => {
    let view = views.get(projectId)
    if (view === undefined) {
      view = { pending_count: 0, pending_decisions: [], pinned_decisions: [], activity: [] }
      views.set(projectId, view)
    }
    return view
  }
  for (const row of waiting) {
    // A card whose room named no project belongs to the private chat, not to any
    // project screen (contract §4.4 B-1): adding it here would invent an owner.
    if (!isObject(row) || typeof row.project_id !== 'string') continue
    const view = viewOf(row.project_id)
    view.pending_count += 1
    const item = {
      id: typeof row.id === 'string' ? row.id : null,
      title: typeof row.title === 'string' ? row.title : '',
      who: typeof row.requester === 'string' ? row.requester : '',
    }
    if (view.pending_decisions.length < PENDING_LIMIT) view.pending_decisions.push(item)
    if (view.pinned_decisions.length < PIN_LIMIT) view.pinned_decisions.push(item)
  }
  for (const project of Object.values(state.projects ?? {})) {
    if (!isObject(project)) continue
    viewOf(project.id).activity = activityOf(state, project)
  }
  return views
}

export const projectViewOf = (views, projectId) => views.get(projectId) ?? EMPTY_VIEW
