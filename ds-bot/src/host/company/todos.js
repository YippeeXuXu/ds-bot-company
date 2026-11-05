// The to-do view: one read-only aggregation over three sources — the live approval cards,
// the SelfReview records and the host's own fact log — plus the acceptance objects. Nothing
// here writes to disk; every derived value (`ready`, `handled`, `suspended`, the counts) is
// computed on read, exactly as the contract says (§2.4), so a screen never sees a cached
// judgement about a card that has since been answered.
//
// The join key is the host's call id. A live approval entry carries it (approvals.js), a
// SelfReview record carries it, and the host fact lines bind to it through the
// `approval/asked` line that names both the approval and the call. The host log's own
// `callBinder` is not exported, so this module rebuilds the same two-step binding for the
// per-call facts it needs (session and last activity); the seven-value projection itself
// still comes from `rebuildHostOutcomes`, which is the single place that decides what a
// call's outcome was.
//
// A private-chat card has no room, so it cannot be answered from here: the host keeps its
// own card in that chat. It is still listed, as an unassigned row with
// `reason_code: 'private-chat'`, because the PRD says private-chat approvals are summarised
// in the to-do view even though they are answered where they were asked (B-1, v1.0).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newId } from './projects.js'
import { companyFail } from './store.js'
import { hostLogPath, rebuildHostOutcomes } from './selfreview/host-log.js'

export const TODOS_PATH = '/api/company/todos'
export const TODOS_ANSWER_PATH = '/api/company/todos/answer'

// How far back the history scan reads, in fact lines (both files together). A window, not a
// promise of full history: `handled_total_capped` says when it ran out.
export const TODOS_HISTORY_SCAN_MAX = 20_000

const HANDLED_LIMIT_DEFAULT = 50
const HANDLED_LIMIT_MAX = 200

// `cancelled` is a terminal state here: the host cancels a card when its turn ends, so a
// cancelled approval is answered history, not a waiting one (B-3).
const HANDLED_STATES = new Set(['approved-human', 'approved-auto', 'rejected', 'accepted', 'returned', 'cancelled', 'expired'])

const TITLE_FALLBACK = '操作详情待核实'
const UNKNOWN_REQUESTER = '未知发起人'
const PRIVATE_CHAT_NAME = '私聊'

// The only risk words a screen may show (A-4). The host has no risk field, so the word comes
// from SelfReview's prediction; a missing prediction stays unknown rather than guessed.
const RISK_TEXT = new Map([
  ['low', '低风险'],
  ['medium', '需要授权'],
  ['high', '高风险'],
])

// Reasons a waiting row cannot be answered from here, and the one line shown to the person
// (D-3). Only the first five can appear in M1; the rest are reserved for later cards.
const REASON_TEXT = new Map([
  ['suspended', '已挂起 · 等待中'],
  ['host-pending', '宿主待回执'],
  ['host-offline', '宿主失联 · 待对账'],
  ['error-retry', '技术失败 · 待重试'],
  ['private-chat', '请在私聊中处理'],
])

const REJECT_TEXT = new Map([
  ['rejected-by-human', '已拒绝 · 未执行'],
  ['rejected-by-policy', '策略未批准 · 未执行'],
])

// `<verb> <redacted object>`: the verb comes from the tool, never from its arguments.
const TOOL_VERBS = [
  [['bash', 'shell', 'exec', 'spawn'], '运行命令'],
  [['write', 'edit', 'apply_patch', 'create_file'], '写入文件'],
  [['rm', 'delete', 'move'], '删除或移动文件'],
  [['chmod', 'chown', 'permission'], '更改权限'],
  [['message', 'send', 'email', 'webhook'], '发送消息'],
  [['fetch', 'http', 'curl'], '访问网络'],
]

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const liveProject = project => isObject(project) && project.status !== 'archived'

const isoOf = value => {
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  return null
}

const waitMinutes = (createdAt, at) => {
  const from = Date.parse(createdAt ?? '')
  return Number.isNaN(from) ? 0 : Math.max(0, Math.floor((at - from) / 60_000))
}

const shorten = (text, max = 80) => {
  const value = String(text).replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

// Answer payloads: an answer names a card that must exist and a decision that this build can
// carry out. Absent optional text stays null rather than becoming the string "undefined".
const requiredText = (value, field, max) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed === '') throw companyFail('todo/invalid', `${field} is required.`, { field })
  if (trimmed.length > max) throw companyFail('todo/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return trimmed
}

const optionalText = (value, field, max) => {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw companyFail('todo/invalid', `${field} must be text.`, { field })
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > max) throw companyFail('todo/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return trimmed
}

const verbOf = tool => {
  const name = String(tool ?? '').toLowerCase()
  for (const [words, verb] of TOOL_VERBS) {
    if (words.some(word => name.includes(word))) return verb
  }
  return '执行操作'
}

const targetOf = (record, entry) => {
  if (typeof record?.target === 'string' && record.target.trim() !== '') return record.target
  if (typeof entry?.detail?.code === 'string' && entry.detail.code.trim() !== '') return entry.detail.code
  return ''
}

const titleOf = ({ record, entry, redact }) => {
  const raw = targetOf(record, entry)
  if (raw === '') return TITLE_FALLBACK
  const object = shorten(redact(raw))
  return object === '' ? TITLE_FALLBACK : `${verbOf(record?.tool ?? entry?.tool)} ${object}`
}

const riskOf = record => {
  const tier = typeof record?.predicted_risk_tier === 'string' ? record.predicted_risk_tier : null
  const text = RISK_TEXT.get(tier)
  return { text: text ?? '风险待核实', source: text === undefined ? 'none' : 'predicted' }
}

const policyOf = value => (value === 'ask' || value === 'never' ? value : null)

// The seven host outcomes become one to-do state, one `handled` and at most one reason
// (§3.6). The approval outcome is read first because a cancelled card is `unavailable`
// upstream, and cancelling is the fact a screen must show.
const mapOutcome = projection => {
  if (!isObject(projection)) return undefined
  if (projection.approval_outcome === 'cancelled') return { state: 'cancelled' }
  switch (projection.outcome) {
    case 'approved-by-human':
      return { state: 'approved-human' }
    case 'allowed-by-policy':
      return { state: 'approved-auto' }
    case 'rejected-by-human':
      return { state: 'rejected', hostRejectReason: REJECT_TEXT.get('rejected-by-human') }
    case 'rejected-by-policy':
      return { state: 'rejected', hostRejectReason: REJECT_TEXT.get('rejected-by-policy') }
    case 'unavailable':
      return { state: 'unavailable', reasonCode: 'host-offline' }
    case 'unobservable':
      return { state: 'unobservable', reasonCode: 'host-pending' }
    case 'failed-execution':
      return { state: 'error', reasonCode: 'error-retry' }
    default:
      return undefined
  }
}

// The row the contract asks for (§4.4), with the nine P09 fields first so a renderer can
// read them positionally as well as by name.
const blankRow = () => ({
  id: null,
  card_kind: null,
  state: 'pending',
  title: TITLE_FALLBACK,
  project_name: '',
  risk_text: '风险待核实',
  requester: UNKNOWN_REQUESTER,
  wait_minutes: 0,
  opinion: null,
  project_id: null,
  ready: false,
  handled: false,
  retry_available: false,
  suspended: false,
  stale: false,
  reason: null,
  reason_code: null,
  handled_at: null,
  created_at: null,
  host_outcome: null,
  authorizer: null,
  host_reject_reason: null,
  risk_source: 'none',
  host_risk_tier: null,
  approval_policy: null,
  host_preset: null,
  approval_id: null,
  answer_ref: null,
  session_id: null,
  room_id: null,
  request_id: null,
  tool: null,
  target: null,
  acceptance_id: null,
  task_id: null,
  submitted_version: null,
  acceptance_criteria: null,
  revision: null,
  owner_only: false,
  requester_bot_id: null,
  coordinator_bot_id: null,
})

const projectOfRoom = (state, roomId) => {
  if (typeof roomId !== 'string') return undefined
  return Object.values(state.projects ?? {}).find(project => liveProject(project) && project.group_chat_ref === roomId)
}

const projectById = (state, projectId) => {
  if (typeof projectId !== 'string') return undefined
  const project = state.projects?.[projectId]
  return liveProject(project) ? project : undefined
}

const employeeOfBot = (state, botId) => {
  if (typeof botId !== 'string') return undefined
  return Object.values(state.employees ?? {}).find(profile => profile?.status === 'active' && profile.bot_id === botId)
}

const projectOfEmployee = (state, employeeId) => {
  if (typeof employeeId !== 'string') return undefined
  const owned = Object.values(state.members ?? {}).filter(member => isObject(member) && member.membership_status === 'active' && member.employee_id === employeeId)
  for (const member of owned) {
    const project = projectById(state, member.project_id)
    if (project !== undefined) return project
  }
  return undefined
}

const coordinatorBotId = (state, project) => {
  if (!isObject(project) || typeof project.coordinator_assignment_id !== 'string') return null
  const assignment = state.members?.[project.coordinator_assignment_id]
  const employee = assignment === undefined ? undefined : state.employees?.[assignment.employee_id]
  return typeof employee?.bot_id === 'string' ? employee.bot_id : null
}

const requesterName = (state, botId) => employeeOfBot(state, botId)?.name ?? UNKNOWN_REQUESTER

const redactedTarget = (record, entry, redact) => {
  const raw = targetOf(record, entry)
  return raw === '' ? null : shorten(redact(raw))
}

// The to-do `opinion` of a decided card comes from the decision record, when one was left.
const collectOpinions = state => {
  const opinions = new Map()
  for (const entry of Object.values(state.todo_log ?? {})) {
    if (!isObject(entry)) continue
    if (typeof entry.call_id !== 'string' || typeof entry.opinion !== 'string' || entry.opinion === '') continue
    if (!opinions.has(entry.call_id)) opinions.set(entry.call_id, entry.opinion)
  }
  return opinions
}

// The call index: which Session a call ran in and when it last appeared in the fact log.
// The binding mirrors host-log's `callBinder` (ask line names approval + call).
const indexCalls = rows => {
  const askedCall = new Map()
  const byCall = new Map()
  for (const row of rows) {
    if (!isObject(row)) continue
    if (row.type === 'approval/asked' && typeof row.approval_id === 'string' && typeof row.call_id === 'string') {
      askedCall.set(row.approval_id, row.call_id)
    }
    const callId = typeof row.call_id === 'string' && row.call_id !== ''
      ? row.call_id
      : (typeof row.approval_id === 'string' ? askedCall.get(row.approval_id) : undefined)
    if (callId === undefined) continue
    const entry = byCall.get(callId) ?? { sessionId: null, firstAt: null, lastAt: null }
    if (entry.sessionId === null && typeof row.session_id === 'string') entry.sessionId = row.session_id
    const at = isoOf(row.at)
    if (at !== null) {
      if (entry.firstAt === null || at < entry.firstAt) entry.firstAt = at
      if (entry.lastAt === null || at > entry.lastAt) entry.lastAt = at
    }
    byCall.set(callId, entry)
  }
  return byCall
}

// What an answer note needs from the same history the read joins against: the project the
// call belonged to (its review record) and the host's own card id (the `approval/asked`
// fact line). Both are optional by contract; a rotated-away log leaves null, not a guess.
const factsOfCall = (home, callId) => {
  const history = scanHistory(home)
  const record = history.records.get(callId)
  let approvalId = null
  for (const row of history.rows) {
    if (!isObject(row)) continue
    if (row.call_id === callId && typeof row.approval_id === 'string') approvalId = row.approval_id
  }
  return {
    approvalId,
    projectId: typeof record?.project_id === 'string' ? record.project_id : null,
  }
}

const readJsonRows = path => {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // A missing log is an empty log, and so is an unreadable one: the to-do view is a read
    // model, and failing the whole screen because one history file is damaged would hide
    // the cards that are still live.
    return []
  }
  const rows = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (isObject(row)) rows.push(row)
    } catch {
      // A half-written last line is skipped, as in host-log's own reader.
    }
  }
  return rows
}

// The history window: newest rows first, from the live file and its rotations, and the host
// facts. `capped` says the window ran out before the files did.
const scanHistory = home => {
  const dir = join(home, 'company')
  const records = new Map()
  let budget = TODOS_HISTORY_SCAN_MAX
  let capped = false
  const recordPaths = [join(dir, 'selfreview.jsonl')]
  for (let index = 1; index <= 5; index += 1) recordPaths.push(join(dir, 'selfreview.jsonl.'.concat(String(index))))
  for (const path of recordPaths) {
    if (budget <= 0) {
      capped = true
      break
    }
    const rows = readJsonRows(path)
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (budget <= 0) {
        capped = true
        break
      }
      budget -= 1
      const record = rows[index]
      const callId = typeof record?.call_id === 'string' && record.call_id !== '' ? record.call_id : undefined
      if (callId !== undefined && !records.has(callId)) records.set(callId, record)
    }
  }
  const facts = readJsonRows(hostLogPath(home))
  const keep = Math.max(0, budget)
  const rows = facts.length > keep ? facts.slice(facts.length - keep) : facts
  if (facts.length > keep) capped = true
  return { records, rows, capped }
}

const handledLimitOf = value => {
  if (value === undefined || value === null || value === '') return HANDLED_LIMIT_DEFAULT
  // A page size counts rows: `1.5` and `"2x"` are not counts, and parseInt would silently
  // shorten either into one instead of refusing it (§3.10).
  const text = String(value).trim()
  const parsed = /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > HANDLED_LIMIT_MAX) {
    throw companyFail('todo/invalid', `handled_limit is a whole number from 1 to ${HANDLED_LIMIT_MAX}.`, { field: 'handled_limit', max: HANDLED_LIMIT_MAX })
  }
  return parsed
}

const byWait = (left, right) => {
  if (right.wait_minutes !== left.wait_minutes) return right.wait_minutes - left.wait_minutes
  return String(left.created_at ?? '').localeCompare(String(right.created_at ?? ''))
}

const byHandledAt = (left, right) => {
  const order = String(right.handled_at ?? '').localeCompare(String(left.handled_at ?? ''))
  return order !== 0 ? order : String(right.created_at ?? '').localeCompare(String(left.created_at ?? ''))
}

/**
 * Build the to-do reader. Every source is asked at read time, so a card answered a second
 * ago, a card the host cancelled, and a record written after install are all in the same
 * answer.
 *
 * @param {object} input
 * @param {object} input.store            the company store (state is read, never written)
 * @param {Function} [input.approvals]    `rt.approvalsView`, asked per read
 * @param {Function} [input.sessionBot]   `rt.selfOf`: session id → Bot id
 * @param {string} input.home             the DS Bot home (`<home>/company/` holds the logs)
 * @param {Function} [input.now]          clock, for tests
 * @param {Function} [input.redact]       the host's secret redactor through `rt.redactSecrets`
 * @param {Function} [input.answerApproval] `rt.answerApproval`: relays an answer to the host
 * @param {Function} [input.warn]         where a lost answer note is reported
 */
export function createTodos({ store, approvals = () => [], sessionBot, home, now = Date.now, redact = value => value, answerApproval, warn = () => {} }) {
  const clean = value => {
    const text = typeof value === 'string' ? value : String(value ?? '')
    return typeof redact === 'function' ? String(redact(text)) : text
  }

  const liveRow = ({ state, entry, record, projection, at }) => {
    const project = projectOfRoom(state, entry.roomId)
    const requesterBotId = typeof entry.botId === 'string' ? entry.botId : null
    const risk = riskOf(record)
    const row = blankRow()
    row.card_kind = 'approval'
    row.state = 'pending'
    row.id = `ap_${entry.id}`
    row.tool = typeof entry.tool === 'string' ? entry.tool : null
    row.target = redactedTarget(record, entry, clean)
    row.title = titleOf({ record, entry, redact: clean })
    row.risk_text = risk.text
    row.risk_source = risk.source
    row.requester_bot_id = requesterBotId
    row.requester = requesterName(state, requesterBotId)
    row.session_id = typeof entry.sessionId === 'string' ? entry.sessionId : null
    row.room_id = typeof entry.roomId === 'string' ? entry.roomId : null
    row.request_id = typeof record?.request_id === 'string' ? record.request_id : null
    row.created_at = isoOf(record?.created_at) ?? isoOf(entry.at)
    row.wait_minutes = waitMinutes(row.created_at, at)
    row.approval_id = typeof projection?.approval_id === 'string' ? projection.approval_id : null
    row.approval_policy = policyOf(projection?.approval_policy ?? record?.host_policy)
    row.host_preset = typeof (projection?.host_preset ?? record?.host_preset) === 'string' ? (projection?.host_preset ?? record?.host_preset) : null
    // A card that is still waiting has no result yet (§4.4:370), and this view cannot tell
    // who will authorize it, so the word stays unknown rather than guessed (B-2).
    row.authorizer = 'unknown'
    if (project === undefined) {
      // No room means no answering surface here: the card lives in the private chat, where
      // the host drew it. This row only tells the person it exists and where it is (B-1).
      row.project_id = null
      row.project_name = PRIVATE_CHAT_NAME
      row.ready = false
      row.suspended = false
      row.reason_code = 'private-chat'
      row.reason = REASON_TEXT.get('private-chat')
      row.answer_ref = null
      // The card lives in a private chat, so this row must not name the room it was asked
      // in; a renderer reading `room_id` would mistake it for a project row (§3.3:164).
      row.room_id = null
      row.coordinator_bot_id = null
      return row
    }
    row.project_id = project.id ?? null
    row.project_name = typeof project.name === 'string' ? project.name : ''
    row.coordinator_bot_id = coordinatorBotId(state, project)
    row.answer_ref = typeof entry.id === 'string' ? entry.id : null
    row.ready = entry.answerable === true
    row.suspended = row.ready === false
    row.reason_code = row.ready ? null : 'suspended'
    row.reason = row.ready ? null : REASON_TEXT.get('suspended')
    return row
  }

  const settledRow = ({ state, projection, record, meta, opinions }) => {
    const mapped = mapOutcome(projection)
    if (mapped === undefined) return undefined
    const sessionId = typeof meta?.sessionId === 'string' ? meta.sessionId : null
    const requesterBotId = typeof sessionBot === 'function' && sessionId !== null ? sessionBot(sessionId) : undefined
    const employee = employeeOfBot(state, requesterBotId)
    const project = projectById(state, record?.project_id) ?? projectOfEmployee(state, employee?.id)
    const risk = riskOf(record)
    const handled = HANDLED_STATES.has(mapped.state)
    const row = blankRow()
    row.card_kind = 'approval'
    row.state = mapped.state
    row.handled = handled
    row.id = `ap_${typeof projection.approval_id === 'string' ? projection.approval_id : projection.call_id}`
    row.tool = typeof record?.tool === 'string' ? record.tool : null
    row.target = redactedTarget(record, undefined, clean)
    row.title = titleOf({ record, redact: clean })
    row.risk_text = risk.text
    row.risk_source = risk.source
    row.requester_bot_id = typeof requesterBotId === 'string' ? requesterBotId : null
    row.requester = requesterBotId === undefined ? UNKNOWN_REQUESTER : requesterName(state, requesterBotId)
    row.session_id = sessionId
    row.room_id = null
    row.request_id = typeof record?.request_id === 'string' ? record.request_id : null
    row.created_at = isoOf(record?.created_at) ?? meta?.firstAt ?? null
    row.approval_id = typeof projection.approval_id === 'string' ? projection.approval_id : null
    row.approval_policy = policyOf(projection.approval_policy ?? record?.host_policy)
    row.host_preset = typeof (projection.host_preset ?? record?.host_preset) === 'string' ? (projection.host_preset ?? record?.host_preset) : null
    row.host_outcome = typeof projection.outcome === 'string' ? projection.outcome : null
    // The host names who authorized a decided call; nothing else may fill this in (B-2).
    row.authorizer = typeof projection.authorizer === 'string' ? projection.authorizer : null
    row.host_reject_reason = mapped.hostRejectReason ?? null
    row.answer_ref = null
    row.revision = null
    row.opinion = typeof projection.call_id === 'string' ? (opinions.get(projection.call_id) ?? null) : null
    if (project === undefined) {
      row.project_id = null
      row.project_name = PRIVATE_CHAT_NAME
      row.coordinator_bot_id = null
    } else {
      row.project_id = project.id ?? null
      row.project_name = typeof project.name === 'string' ? project.name : ''
      row.coordinator_bot_id = coordinatorBotId(state, project)
    }
    if (handled) {
      row.ready = false
      row.suspended = false
      row.handled_at = meta?.lastAt ?? row.created_at
    } else {
      row.ready = false
      row.suspended = false
      row.reason_code = mapped.reasonCode ?? null
      row.reason = mapped.reasonCode === undefined ? null : (REASON_TEXT.get(mapped.reasonCode) ?? null)
    }
    // A handled row waited until it was decided, not until this read (§4.4:358).
    row.wait_minutes = waitMinutes(row.created_at, handled ? (Date.parse(row.handled_at ?? '') || now()) : now())
    return row
  }

  const acceptanceRow = ({ state, acceptance, at }) => {
    const project = projectById(state, acceptance.project_id)
    if (project === undefined) return undefined
    const ownerOnly = acceptance.owner_only === true || project.acceptance_requirement === 'owner_only'
    if (acceptance.acceptance_actor !== 'user' && !ownerOnly) return undefined
    const employee = state.employees?.[acceptance.requester_employee_id]
    const row = blankRow()
    row.card_kind = 'acceptance'
    row.id = `ac_${acceptance.id}`
    row.state = typeof acceptance.state === 'string' ? acceptance.state : 'pending'
    row.title = typeof acceptance.title === 'string' ? acceptance.title : TITLE_FALLBACK
    row.project_id = project.id ?? null
    row.project_name = typeof project.name === 'string' ? project.name : ''
    row.risk_text = '待确认'
    row.risk_source = 'none'
    row.requester = typeof employee?.name === 'string' ? employee.name : UNKNOWN_REQUESTER
    row.requester_bot_id = typeof employee?.bot_id === 'string' ? employee.bot_id : null
    row.coordinator_bot_id = coordinatorBotId(state, project)
    row.room_id = typeof project.group_chat_ref === 'string' ? project.group_chat_ref : null
    row.session_id = typeof acceptance.session_id === 'string' ? acceptance.session_id : null
    row.tool = null
    row.target = null
    row.request_id = null
    row.acceptance_id = acceptance.id ?? null
    row.task_id = typeof acceptance.task_id === 'string' ? acceptance.task_id : null
    row.submitted_version = typeof acceptance.submitted_version === 'string' ? acceptance.submitted_version : null
    row.acceptance_criteria = typeof acceptance.acceptance_criteria === 'string' ? acceptance.acceptance_criteria : null
    row.revision = typeof acceptance.revision === 'number' ? acceptance.revision : null
    row.owner_only = ownerOnly
    row.created_at = isoOf(acceptance.created_at)
    row.answer_ref = null
    row.handled = HANDLED_STATES.has(row.state)
    row.ready = row.handled === false && row.state === 'pending'
    row.suspended = false
    row.stale = false
    row.retry_available = false
    row.host_outcome = null
    row.authorizer = 'unknown'
    row.host_risk_tier = null
    if (row.handled) {
      row.handled_at = isoOf(acceptance.decided_at) ?? row.created_at
      row.opinion = typeof acceptance.opinion === 'string' && acceptance.opinion !== '' ? acceptance.opinion : null
    }
    row.wait_minutes = waitMinutes(row.created_at, row.handled ? (Date.parse(row.handled_at ?? '') || at) : at)
    return row
  }

  const read = (input = {}) => {
    const query = isObject(input) ? input : {}
    const at = now()
    const handledLimit = handledLimitOf(query.handled_limit)
    const wantedProject = query.project_id === undefined || query.project_id === null || query.project_id === '' ? null : String(query.project_id)
    const state = store.state
    if (wantedProject !== null && state.projects?.[wantedProject] === undefined) {
      throw companyFail('project/not-found', `No project ${wantedProject}.`, { project_id: wantedProject })
    }
    const company = Object.values(state.companies ?? {}).find(entry => isObject(entry) && entry.status !== 'archived') ?? null
    const history = scanHistory(home)
    const callIndex = indexCalls(history.rows)
    const projections = rebuildHostOutcomes({ rows: history.rows, records: [...history.records.values()] })
    const outcomesByCall = new Map()
    for (const projection of projections) {
      if (typeof projection?.call_id === 'string') outcomesByCall.set(projection.call_id, projection)
    }
    const opinions = collectOpinions(state)
    const liveEntries = (typeof approvals === 'function' ? approvals() : []).filter(isObject)
    const liveCalls = new Set(liveEntries.map(entry => entry.callId).filter(callId => typeof callId === 'string'))

    const waiting = []
    const handled = []
    for (const entry of liveEntries) {
      const callId = typeof entry.callId === 'string' ? entry.callId : null
      const record = callId === null ? undefined : history.records.get(callId)
      const projection = callId === null ? undefined : outcomesByCall.get(callId)
      waiting.push(liveRow({ state, entry, record, projection, at }))
    }
    for (const projection of projections) {
      const mapped = mapOutcome(projection)
      if (mapped === undefined) continue
      // A card only exists if the host ever asked for one. A self-review denial or an
      // allowed-by-policy call leaves no approval behind, so it is not a to-do row (§3.4).
      if (projection.approval_id == null && projection.approval_outcome == null) continue
      const callId = typeof projection.call_id === 'string' ? projection.call_id : null
      if (callId !== null && liveCalls.has(callId) && projection.reason === 'undecided') continue
      const row = settledRow({ state, projection, record: callId === null ? undefined : history.records.get(callId), meta: callId === null ? undefined : callIndex.get(callId), opinions })
      if (row === undefined) continue
      ;(row.handled ? handled : waiting).push(row)
    }
    for (const acceptance of Object.values(state.acceptances ?? {})) {
      if (!isObject(acceptance)) continue
      const row = acceptanceRow({ state, acceptance, at })
      if (row === undefined) continue
      ;(row.handled ? handled : waiting).push(row)
    }

    const inScope = row => wantedProject === null || row.project_id === wantedProject
    const waitingRows = waiting.filter(inScope).sort(byWait)
    const handledRows = handled.filter(inScope).sort(byHandledAt)
    const page = handledRows.slice(0, handledLimit)
    const counts = {
      waiting_approvals: waitingRows.filter(row => row.card_kind === 'approval').length,
      waiting_acceptances: waitingRows.filter(row => row.card_kind === 'acceptance').length,
      waiting_total: waitingRows.length,
      handled_total: handledRows.length,
      handled_total_capped: history.capped,
      handled_returned: page.length,
      waiting_unassigned: waitingRows.filter(row => row.project_id === null).length,
    }
    const readAt = new Date(at).toISOString()
    return {
      read_at: readAt,
      server_time: readAt,
      company_id: company === null ? null : company.id,
      counts,
      waiting: waitingRows,
      handled: page,
      handled_has_more: handledRows.length > page.length,
    }
  }

  // Answer one waiting approval from the to-do view: hand the decision to the host, then
  // note what was said. The host owns the card — a company-level "allow" the host never
  // received would leave the Bot waiting forever — so the relay is the answer itself and
  // the `todo_log` row only records it (contract §5.1).
  const answer = async (input = {}) => {
    const body = isObject(input) ? input : {}
    const todoId = requiredText(body.todo_id, 'todo_id', 200)
    // An acceptance row is answered through `acceptance.decide`; allow/reject does not
    // describe it, so this endpoint refuses the combination rather than deciding wrongly.
    if (todoId.startsWith('ac_')) {
      throw companyFail('todo/unsupported', 'Acceptance rows are answered by acceptance.decide, not by allow/reject.', { todo_id: todoId, card_kind: 'acceptance' })
    }
    const decision = body.decision
    if (decision !== 'allow' && decision !== 'reject') {
      throw companyFail('todo/invalid', 'decision is allow or reject.', { field: 'decision', allowed: ['allow', 'reject'] })
    }
    // Named by the contract for the call, although the host card itself is what makes a
    // repeated answer land on `todo/unknown` rather than applying twice.
    requiredText(body.operation_key, 'operation_key', 200)
    const opinion = optionalText(body.opinion, 'opinion', 500)
    // An unassigned row has no card here: the host keeps it in the private chat (B-1), so
    // answering it is the same as answering a card that is no longer open.
    const answerRef = typeof body.answer_ref === 'string' ? body.answer_ref.trim() : ''
    if (answerRef === '') {
      throw companyFail('todo/unknown', 'This row has no card to answer here.', { todo_id: todoId })
    }
    store.assertWritable()
    const entry = (typeof approvals === 'function' ? approvals() : []).filter(isObject).find(item => item.id === answerRef)
    if (entry === undefined) {
      throw companyFail('todo/unknown', 'The approval card is no longer open.', { todo_id: todoId })
    }
    if (`ap_${entry.id}` !== todoId) {
      throw companyFail('todo/stale', 'The to-do row no longer names this card.', { todo_id: todoId, answer_ref: answerRef })
    }
    if (entry.answerable !== true || typeof answerApproval !== 'function') {
      throw companyFail('todo/unsupported', 'This card cannot be answered from the to-do view.', { todo_id: todoId })
    }
    try {
      await answerApproval(entry.id, decision)
    } catch (error) {
      // The two host refusals have different meanings on screen: a card answered elsewhere
      // moves group, a request this build could not carry out does not (contract §5.1/§4.6).
      if (error?.code === 'bot/stale') throw companyFail('todo/changed', 'The card was answered elsewhere.', { todo_id: todoId })
      if (error?.code === 'bot/invalid') throw companyFail('todo/unsupported', error.message ?? 'The host refused this answer.', { todo_id: todoId })
      throw error
    }
    // The host already has the answer. The note is best effort: losing it must not turn the
    // card back into waiting, so a failed save is a warning and not a failure (§5.1 step 4).
    const callId = typeof entry.callId === 'string' && entry.callId !== '' ? entry.callId : null
    if (callId === null) {
      warn('ds-bot: answered approval %s without a call id, so the answer was not recorded', entry.id)
    } else {
      const facts = factsOfCall(home, callId)
      const row = {
        id: newId('tdl'),
        card_kind: 'approval',
        call_id: callId,
        answer_ref: entry.id,
        approval_id: facts.approvalId,
        project_id: facts.projectId,
        decision,
        opinion,
        at: now(),
      }
      const next = structuredClone(store.state)
      next.todo_log[row.id] = row
      try {
        await store.commit(next)
      } catch (error) {
        warn('ds-bot: could not record the answer to %s: %s', callId, error?.message ?? String(error))
      }
    }
    return { ok: true, todo_id: todoId, host_outcome: decision === 'allow' ? 'allowed-once' : 'rejected', handled: true }
  }

  return { read, answer }
}
