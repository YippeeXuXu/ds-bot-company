// The company over HTTP: the browser's screens, and any local tool that speaks JSON, ask
// these three routes instead of reaching into the host's objects.
//
// Nothing here binds a port. The routes are registered on Connection's fetch carrier
// (`ctx.connection.fetch`, the same one the client channel uses), so they sit inside the
// host's authentication fence: a request without the local owner's session is refused
// before it reaches this module. That is also why no route carries an auth check of its
// own — a second check here would only repeat the fence with less information.
//
// One table turns `area/kind` error codes into status codes, so a caller can branch
// without matching message text. A command's own refusal is the company layer's decision
// and keeps its code in the body; HTTP only says what kind of answer it is.
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { departmentView } from './org.js'
import { templateView } from './templates.js'
import { projectDetailOf } from './projects.js'
import { createTodos, TODOS_ANSWER_PATH, TODOS_PATH } from './todos.js'

export const COMMAND_PATH = '/api/company/command'
export const MODEL_PATH = '/api/company/model'
export const EVENTS_PATH = '/api/company/events'

const JSON_HEADERS = { 'content-type': 'application/json' }

// 409 = "the company changed under you, or it cannot be written right now"; 422 = "the
// request was understood and refused"; 404 = "no such object"; 500 = our own failure.
const STATUS = new Map([
  ['company/not-found', 404],
  ['department/not-found', 404],
  ['employee/not-found', 404],
  ['project/not-found', 404],
  ['project/member-not-found', 404],
  ['company/idempotency-conflict', 409],
  ['company/revision-conflict', 409],
  ['company/read-only', 409],
  ['company/state.corrupt', 409],
  ['department.name-taken', 409],
  // A department lead who is not one of its active employees: understood, refused.
  ['department/invalid', 422],
  // The department's group chat (M1a-4): a room that is gone, a room another department
  // already owns, a roster that refused, employees with no Bot, too few Bots to group.
  ['department/group-not-found', 404],
  ['department/group-bound', 409],
  ['department/group-failed', 409],
  ['department/group-missing-bots', 422],
  ['department/group-too-small', 422],
  // Employee templates (M1b-3.2): a template that is gone, a name already used, a
  // builtin that must be copied before it changes, an archived one that cannot be edited.
  ['template/not-found', 404],
  ['template/name-taken', 409],
  ['template/builtin-readonly', 422],
  ['template/archived', 409],
  // Hiring from a template (M1b-3.4): a name the team already shows, a skill the library does
  // not hold, a host that refused the Bot, a skill that failed after the Bot existed. The last
  // three are the request understood and refused, even though a Bot was made and undone.
  ['employee/bot-name-taken', 409],
  ['employee/capability-missing', 422],
  ['employee/capability-failed', 422],
  ['employee/bot-create-failed', 422],
  // Template files (M1b-3.5): one bad row refuses the whole file, so a half-imported set of
  // jobs never looks like success on the second profile.
  ['template/import-invalid', 422],
  // v1.18: a soul template cannot be the job a Bot is hired from, and vice versa.
  ['template/kind-mismatch', 422],
  ['employee.bot_already_employed', 409],
  ['project/member-exists', 409],
  ['project/member-busy', 409],
  // The coordinator post is one: promoting a second member is a conflict, not a server error.
  ['project/coordinator-exists', 409],
  ['project/state-conflict', 409],
  // 4.5: archiving is refused while a delivery was never accepted or a dispatched Run is
  // still working; those are conflicts with live work, not malformed input.
  ['project/acceptance-required', 409],
  ['project/runs-active', 409],
  ['project/group-pending', 409],
  ['project/group-failed', 409],
  ['company/invalid', 422],
  ['company/unknown-command', 422],
  // A host that cannot do what the command needs (a Bot that cannot be delivered to).
  ['company/unsupported', 422],
  ['employee/unknown-bot', 422],
  ['employee/private-bot', 422],
  ['employee/immutable-field', 422],
  // A profile may be dismissed (M1b-2.4). Refusing a dismissal that live work still
  // depends on is a conflict the screen resolves by handing the work over; naming a
  // dismissed employee anywhere else is a request that is understood and refused.
  ['employee/still-referenced', 409],
  ['employee/inactive', 422],
  ['project/invalid', 422],
  // A coordinator whose profile has no Bot yet: understood, refused before any room is made.
  ['project/coordinator-without-bot', 422],
  ['project/owner-required', 422],
  ['project/missing-input', 422],
  // Acceptance objects: answering one that is not there, or that was decided already.
  ['acceptance/not-found', 404],
  ['acceptance/state-conflict', 409],
  // Project tasks (M1b-3.3): a card that is gone or changed under the caller, a move the
  // state machine does not take, a review that only an acceptance record may close, a
  // dependency that closes a loop or is not done yet, and a sensitive class that cannot be
  // lowered after draft.
  ['task/not-found', 404],
  ['task/state-conflict', 409],
  ['task/revision-conflict', 409],
  ['task/dependency-unmet', 409],
  ['task/acceptance-required', 409],
  ['task/missing-input', 422],
  ['task/dependency-cycle', 422],
  ['task/dependency-missing', 422],
  ['task/parent-cycle', 422],
  ['task/downgrade-forbidden', 422],
  // Task runs (M1b-4.3): a dispatch that is gone or already failed, a host that cannot
  // deliver a brief, and a delivery that did not reach the Bot.
  ['run/not-found', 404],
  ['run/state-conflict', 409],
  ['run/deliver-failed', 422],
  // The to-do view's own refusals: a bad window, a card that is gone, a card that changed
  // under the caller, an answer this build cannot give, and the D7 acceptance refusal.
  ['todo/invalid', 422],
  ['todo/unknown', 404],
  ['todo/changed', 409],
  ['todo/stale', 409],
  ['todo/unsupported', 422],
  ['owner_only_requires_user', 422],
])

export const statusOf = code => STATUS.get(code) ?? 500

const failureBody = error => ({
  code: typeof error?.code === 'string' ? error.code : 'company/internal',
  message: error?.message ?? String(error),
  details: error?.details ?? {},
})

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

// A query string as a plain object. Repeated keys keep the last value: every route here
// takes scalars, so an array would only make a malformed request look valid.
export const queryOf = url => {
  const query = {}
  for (const [name, value] of new URL(url).searchParams) query[name] = value
  return query
}

export function createCompanyApi({ store, execute, groups = {}, now = Date.now, approvals = () => [], sessionBot, home, redact = value => value, answerApproval, runExclusive, warn = () => {} }) {
  const roomMembers = project => {
    if (typeof groups.members !== 'function' || project.group_chat_ref == null) return undefined
    return groups.members(project.group_chat_ref)
  }

  // The to-do read is the one answer assembled from several sources rather than projected
  // from one table. It is created once so the route and the client channel cannot drift.
  const todos = createTodos({ store, approvals, sessionBot, home: home ?? dirname(store.dir), now, redact, answerApproval, runExclusive, warn })
  const todosRead = (input = {}) => {
    try {
      return { status: 200, body: todos.read(input ?? {}) }
    } catch (error) {
      return { status: statusOf(error?.code), body: failureBody(error) }
    }
  }
  // Answering is a write: the card is relayed to the host and the answer is noted. It is
  // async because the note is saved, where the read never writes anything.
  const todosAnswer = async (input = {}) => {
    try {
      return { status: 200, body: await todos.answer(input ?? {}) }
    } catch (error) {
      return { status: statusOf(error?.code), body: failureBody(error) }
    }
  }

  // The read model: the whole company in one answer, or one project in detail. A company
  // that does not exist yet is `company: null` with 200, not a 404 — the first screen has
  // to render the empty state, and "nobody created it" is a valid state, not a bad URL.
  const model = (input = {}) => {
    // A caller may pass null where it means "no filter": `/api/bot` forwards a client's
    // payload as-is, and a default parameter only covers `undefined`. Reading it as an
    // empty query keeps that mistake from turning into a 500 in the middle of a screen.
    const query = input ?? {}
    const state = store.state
    const company = Object.values(state.companies).find(entry => entry.status !== 'archived') ?? null
    const byCreated = (left, right) => (left.created_at ?? 0) - (right.created_at ?? 0)
    const mine = entry => company === null || entry.company_id === company.id
    const body = {
      revision: state.revision,
      activity_cursor: String(state.revision),
      server_time: now(),
      company,
      // The company's default at the top level (M1b-2.5), so a screen reads it without
      // digging into `company`; an install from before the field reads as standard.
      conversation_mode: company?.conversation_mode === 'ptc' ? 'ptc' : 'standard',
      // `room_id` rides on every department row (M1a-4): the roster knows nothing about
      // departments, so the binding lives here and the room side is derived from it.
      departments: Object.values(state.departments).filter(mine).sort(byCreated).map(departmentView),
      // Every row carries its mode, so a screen never has to know the default (M1b-2.5).
      employees: Object.values(state.employees).filter(mine).sort(byCreated)
        .map(employee => ({ ...employee, conversation_mode: employee.conversation_mode ?? 'follow' })),
      projects: Object.values(state.projects).filter(mine).sort(byCreated),
      // Templates read like every other table (M1b-3.2); `source` says which can be
      // edited and which must be copied first.
      templates: Object.values(state.templates ?? {}).filter(mine).sort(byCreated).map(templateView),
    }
    if (query.project_id !== undefined && query.project_id !== '') {
      const project = state.projects[query.project_id]
      if (project === undefined) return { status: 404, body: { code: 'project/not-found', message: `No project ${query.project_id}.`, details: { project_id: query.project_id } } }
      const detail = projectDetailOf(state, project, roomMembers)
      body.project = { ...detail.project, members: detail.members, group: detail.group }
    }
    return { status: 200, body }
  }

  // Which project an event is about. The subject rides on the event itself: a project
  // command names the project in `aggregate_id`, an acceptance submission carries
  // `data.project_id`, and a decision journaled before that field existed is resolved
  // through the acceptance record. An older line keeps its original text — the
  // attribution is computed at read time, so an old journal reads like a new one.
  const eventProject = event => {
    const announced = event?.data?.project_id
    if (typeof announced === 'string') return announced
    if (typeof event?.aggregate_id === 'string' && store.state.projects?.[event.aggregate_id] !== undefined) return event.aggregate_id
    const acceptanceId = event?.data?.acceptance_id
    if (typeof acceptanceId !== 'string') return null
    const acceptance = store.state.acceptances?.[acceptanceId]
    return typeof acceptance?.project_id === 'string' ? acceptance.project_id : null
  }

  // Events are appended once per committed command, so the file is already in cursor
  // order and a page is a slice. A torn last line (a write cut short) is skipped rather
  // than failing the read: the journal tolerates one missing audit line.
  //
  // `project_id` narrows the page to one project's own events. `order=desc` walks backwards:
  // matches come newest first and its `cursor` is the oldest event on the page, so passing
  // it back returns the ones before it — a recent-activity panel asks once for its window.
  // The default stays the ascending cursor page the incremental readers poll.
  const events = async (input = {}) => {
    const query = input ?? {}
    const wantedProject = query.project_id === undefined || query.project_id === null || query.project_id === ''
      ? null
      : String(query.project_id)
    if (wantedProject !== null && store.state.projects?.[wantedProject] === undefined) {
      return { status: 404, body: { code: 'project/not-found', message: `No project ${wantedProject}.`, details: { project_id: wantedProject } } }
    }
    const since = Number.parseInt(String(query.cursor ?? '0'), 10)
    const from = Number.isInteger(since) && since > 0 ? since : 0
    const asked = Number.parseInt(String(query.limit ?? '200'), 10)
    const limit = clamp(Number.isInteger(asked) ? asked : 200, 1, 500)
    const newestFirst = query.order === 'desc'
    let text = ''
    try {
      text = await readFile(store.eventsPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    // The whole file is read anyway, so the remaining count is known rather than guessed:
    // `has_more` is false on the last page, and a caller that polls until it is false does
    // not make one empty request at the end.
    const pending = []
    for (const line of text.split('\n')) {
      if (line === '') continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      const value = Number(event?.cursor)
      if (!Number.isFinite(value)) continue
      // Ascending pages walk forward from the cursor; descending pages walk back from it,
      // so the same `cursor` request means "the page after this one" in both directions.
      if (newestFirst ? from > 0 && value >= from : value <= from) continue
      if (wantedProject !== null && eventProject(event) !== wantedProject) continue
      pending.push(event)
    }
    if (newestFirst) {
      const page = pending.slice(Math.max(0, pending.length - limit)).reverse()
      const cursor = page.length === 0 ? from : Number(page[page.length - 1].cursor)
      return { status: 200, body: { cursor: String(cursor), events: page, has_more: pending.length > limit } }
    }
    const page = pending.slice(0, limit)
    const cursor = page.length === 0 ? from : Number(page[page.length - 1].cursor)
    return { status: 200, body: { cursor: String(cursor), events: page, has_more: pending.length > limit } }
  }

  // The command entry: the same envelope the plugin's tools call, over JSON. The fields
  // `operation_key` and `expected_revision` may sit at the top of the body or inside
  // `payload`; both describe the request, not the object being changed.
  const command = async (body = {}) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { status: 400, body: { code: 'company/invalid', message: 'The command body must be a JSON object.', details: {} } }
    }
    const name = body.command
    if (typeof name !== 'string' || name.trim() === '') {
      return { status: 422, body: { code: 'company/invalid', message: 'A company command needs `command`.', details: { field: 'command' } } }
    }
    // Spreading a missing payload is a no-op, so no fallback object is needed.
    const payload = { ...body.payload }
    if (body.operation_key !== undefined) payload.operation_key = body.operation_key
    if (body.expected_revision !== undefined) payload.expected_revision = body.expected_revision
    if (typeof payload.operation_key !== 'string' || payload.operation_key.trim() === '') {
      return { status: 422, body: { code: 'company/invalid', message: 'A company command needs `operation_key`.', details: { field: 'operation_key' } } }
    }
    try {
      return { status: 200, body: await execute(name, payload) }
    } catch (error) {
      return { status: statusOf(error?.code), body: failureBody(error) }
    }
  }

  const respond = result => new Response(JSON.stringify(result.body), { status: result.status, headers: JSON_HEADERS })

  // Registered like the client channel's own route: an exact Fetch route on the shared
  // carrier, disposed with the plugin. Returns the disposer for `ctx.effect`.
  const register = ctx => {
    const read = handler => request => Promise.resolve(handler(queryOf(request.url))).then(respond)
    const disposers = [
      ctx.connection.fetch.register({
        path: COMMAND_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return respond({ status: 400, body: { code: 'company/invalid', message: 'The command body is not JSON.', details: {} } })
          }
          return respond(await command(body))
        },
      }),
      ctx.connection.fetch.register({ path: MODEL_PATH, methods: ['GET'], requestBody: 'buffered', fetch: read(model) }),
      ctx.connection.fetch.register({ path: EVENTS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: read(events) }),
      ctx.connection.fetch.register({ path: TODOS_PATH, methods: ['GET'], requestBody: 'buffered', fetch: read(todosRead) }),
      // The answer to one waiting card: the write half of the to-do view. A POST body is
      // read the same way the command entry reads its own, so a malformed request is a 400
      // and never reaches the card.
      ctx.connection.fetch.register({
        path: TODOS_ANSWER_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let body
          try {
            body = await request.json()
          } catch {
            return respond({ status: 400, body: { code: 'todo/invalid', message: 'The answer body is not JSON.', details: {} } })
          }
          return respond(await todosAnswer(body))
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) dispose?.()
    }
  }

  return { command, model, events, todos: todosRead, answer: todosAnswer, register }
}
