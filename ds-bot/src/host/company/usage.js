// Usage (M2 G3 3.6): what a company's Bots spent, read from the host's own ledger.
//
// The host already writes one row per model call into `usage.sqlite` (src/host/usage.js;
// PRD §13: use that book, never keep a second one), so this module keeps no table. What
// the ledger cannot know is who a call was for — a Bot's Session belongs to the Bot, a
// project group's Session to the room — and the company file knows both:
//
//   person  — the employee whose Bot owns the Session (the ledger's owner is the Bot's id)
//   project — a dispatch writes a Run on the Bot's Session, so a call belongs to the latest
//             Run dispatched to that Bot at or before the call's bucket; a call inside a
//             project's group room belongs to that project, never to one person
//   time    — the same calls cut by day in the caller's time zone
//
// A Run carries no end time until it fails (`run.fail`), so "the latest dispatch at or
// before the call" is the rule instead of a window: a Bot works on what it was last handed.
// The ledger buckets calls into 15-minute slots and keeps only the slot's start, so the
// comparison uses the slot's end: a dispatch inside the same slot as the calls it caused
// must still claim them, or a fresh dispatch would report its own work as unattributed.
// A call no Run covers yet stays with the person and is reported as an unattributed project,
// rather than invented into a project it may not belong to.
//
// A call whose usage chunk carried no tokens still happened. Those rows keep their count and
// say `counted_only: true`, so a screen shows 「按次统计」 instead of a false zero.
import { companyFail } from './store.js'

export const USAGE_GROUPS = ['person', 'project', 'time']

const DAY_MS = 86_400_000
const DEFAULT_DAYS = 30
// The ledger's bucket width (`SLOT_MS` in src/host/usage.js); call rows carry the slot start.
const SLOT_MS = 15 * 60_000

const isTimeZone = value => {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value })
    return true
  } catch {
    return false
  }
}

// Tallies are added to from both the ledger (`cacheRead`) and other tallies, so they keep
// the ledger's own names and are written in the contract's snake_case only at the edge.
const emptyTally = () => ({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

const addTally = (tally, slice) => {
  tally.calls += slice.calls ?? 0
  tally.input += slice.input ?? 0
  tally.cacheRead += slice.cacheRead ?? 0
  tally.cacheWrite += slice.cacheWrite ?? 0
  tally.output += slice.output ?? 0
}

const tokensOf = tally => tally.input + tally.cacheRead + tally.cacheWrite + tally.output

// A row is what a screen renders: the five numbers, their sum, and whether the count is all
// it has. `counted_only` is a fact about the row, not a zero with a flag.
const rowOf = (tally, fields) => {
  const tokens = tokensOf(tally)
  return {
    ...fields,
    calls: tally.calls,
    input: tally.input,
    cache_read: tally.cacheRead,
    cache_write: tally.cacheWrite,
    output: tally.output,
    tokens,
    counted_only: tokens === 0 && tally.calls > 0,
  }
}

const nameOf = row => String(row.name ?? row.day ?? row.project_id ?? '')

const byTokens = (left, right) => right.tokens - left.tokens
  || right.calls - left.calls
  || nameOf(left).localeCompare(nameOf(right))

// The day a call belongs to, in the time zone the caller asked for. `en-CA` writes the date
// as YYYY-MM-DD, which sorts as text and reads as a date in any locale.
const dayOf = (ms, timeZone) => new Intl.DateTimeFormat('en-CA', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date(ms))

// The company file as the ledger needs it: whose Bot each Session is, which project a room
// serves, and what each Bot was last dispatched. Built once per command, so a summary over a
// month of calls stays a walk over the ledger's rows, not over the company per row.
function companyIndexes(state) {
  const employeeByBot = new Map()
  for (const employee of Object.values(state.employees ?? {})) {
    if (typeof employee.bot_id === 'string' && employee.bot_id !== '') employeeByBot.set(employee.bot_id, employee)
  }
  const projectByRoom = new Map()
  for (const project of Object.values(state.projects ?? {})) {
    if (typeof project.group_chat_ref === 'string' && project.group_chat_ref !== '') projectByRoom.set(project.group_chat_ref, project)
  }
  const runsByBot = new Map()
  for (const run of Object.values(state.runs ?? {})) {
    if (typeof run.bot_id !== 'string' || run.bot_id === '') continue
    if (!Number.isFinite(run.dispatched_at)) continue
    const list = runsByBot.get(run.bot_id) ?? []
    list.push(run)
    runsByBot.set(run.bot_id, list)
  }
  for (const list of runsByBot.values()) list.sort((left, right) => left.dispatched_at - right.dispatched_at)
  // The Run a Bot was working on at a moment: the last one handed to it, not an interval.
  // A Run that failed still names what the Bot spent its calls on before it was given up.
  const projectOfCall = (botId, slotStart) => {
    const list = runsByBot.get(botId)
    if (list === undefined) return null
    const bucketEnd = slotStart + SLOT_MS
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index].dispatched_at < bucketEnd) return state.projects?.[list[index].project_id] ?? null
    }
    return null
  }
  return { employeeByBot, projectByRoom, projectOfCall }
}

// A call's company meaning, or null when the call is not company work at all (a Bot outside
// the roster, a chat no project owns). Null stays out of every total.
function attribute(indexes, row) {
  if (row.owner.startsWith('room:')) {
    const project = indexes.projectByRoom.get(row.owner.slice('room:'.length))
    return project === undefined ? null : { employee: null, project }
  }
  const employee = indexes.employeeByBot.get(row.owner)
  if (employee === undefined) return null
  return { employee, project: indexes.projectOfCall(employee.bot_id, row.time) }
}

export function usageHandlers({ rt }) {
  const callsOf = async () => {
    if (typeof rt?.usageCalls !== 'function') {
      throw companyFail('company/unsupported', 'This host build keeps no usage ledger, so the company cannot count calls.', { field: 'usage' })
    }
    const rows = await rt.usageCalls()
    return Array.isArray(rows) ? rows : []
  }

  const summary = async ({ state, payload, now }) => {
    const by = payload.by ?? 'person'
    if (!USAGE_GROUPS.includes(by)) {
      throw companyFail('company/invalid', `by must be one of ${USAGE_GROUPS.join(', ')}.`, { field: 'by', allowed: USAGE_GROUPS })
    }
    const end = payload.to ?? now()
    const start = payload.from ?? end - DEFAULT_DAYS * DAY_MS
    if (!Number.isInteger(start)) throw companyFail('company/invalid', 'from is epoch milliseconds.', { field: 'from' })
    if (!Number.isInteger(end)) throw companyFail('company/invalid', 'to is epoch milliseconds.', { field: 'to' })
    if (start > end) throw companyFail('company/invalid', 'from must not be after to.', { field: 'from' })
    const timeZone = payload.time_zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
    if (!isTimeZone(timeZone)) throw companyFail('company/invalid', 'time_zone is not a known zone.', { field: 'time_zone' })

    const indexes = companyIndexes(state)
    const slices = (await callsOf()).filter(row => row.time >= start && row.time <= end)

    const people = new Map()
    const projects = new Map()
    const days = new Map()
    // A call that is company work but has no person (a group room's calls) or no project (a
    // Bot that has not been dispatched anything yet) still amounts to something, and the
    // screen has to say so: it is reported apart instead of folded into a name it lacks.
    const noPerson = emptyTally()
    const noProject = emptyTally()
    const company = emptyTally()

    for (const row of slices) {
      const found = attribute(indexes, row)
      if (found === null) continue
      addTally(company, row)
      if (found.employee !== null) {
        const id = found.employee.id
        const tally = people.get(id) ?? emptyTally()
        addTally(tally, row)
        people.set(id, tally)
      } else {
        addTally(noPerson, row)
      }
      if (found.project !== null) {
        const id = found.project.id
        const tally = projects.get(id) ?? emptyTally()
        addTally(tally, row)
        projects.set(id, tally)
      } else {
        addTally(noProject, row)
      }
      const day = dayOf(row.time, timeZone)
      const tally = days.get(day) ?? emptyTally()
      addTally(tally, row)
      days.set(day, tally)
    }

    const window = { by, from: start, to: end, time_zone: timeZone }

    if (by === 'person') {
      const peopleCalls = emptyTally()
      for (const tally of people.values()) addTally(peopleCalls, tally)
      const rows = [...people].map(([id, tally]) => {
        const employee = state.employees[id] ?? {}
        return rowOf(tally, { kind: 'person', employee_id: id, name: employee.name ?? id, bot_id: employee.bot_id ?? null, status: employee.status ?? null })
      }).sort(byTokens)
      // The group rooms' calls are the difference between this screen and the project one.
      return { aggregate_id: null, mutates: false, body: { ...window, rows, totals: rowOf(peopleCalls, { kind: 'total' }), unattributed: rowOf(noPerson, { kind: 'unattributed', reason: 'group' }) } }
    }

    if (by === 'project') {
      const projectCalls = emptyTally()
      for (const tally of projects.values()) addTally(projectCalls, tally)
      const rows = [...projects].map(([id, tally]) => {
        const project = state.projects[id] ?? {}
        return rowOf(tally, { kind: 'project', project_id: id, name: project.name ?? id, status: project.status ?? null })
      }).sort(byTokens)
      // A person's calls that no dispatch covers yet stay out of every project's row.
      return { aggregate_id: null, mutates: false, body: { ...window, rows, totals: rowOf(projectCalls, { kind: 'total' }), unattributed: rowOf(noProject, { kind: 'unattributed', reason: 'no-run' }) } }
    }

    const rows = [...days].map(([day, tally]) => rowOf(tally, { kind: 'day', day })).sort((left, right) => left.day.localeCompare(right.day))
    // Time sees every company call: a clock is all a call needs to be cut by day.
    return { aggregate_id: null, mutates: false, body: { ...window, rows, totals: rowOf(company, { kind: 'total' }), unattributed: rowOf(emptyTally(), { kind: 'unattributed', reason: 'none' }) } }
  }

  return { 'usage.summary': summary }
}
