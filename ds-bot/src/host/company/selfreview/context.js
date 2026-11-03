// The minimal context one tool call is judged on: which Bot, which employee, which project,
// which folder is authorized, and a redacted summary of the arguments. §3.3 of the M1b plan
// is the contract — the JSON fields decide, the rendered `state` text is only a readable copy
// for the stub and for a person reading a record later.
//
// What never leaves this module: file contents, command output, conversation history,
// credentials, tokens, the whole company state, and other projects' data. Argument values are
// cut to a short preview after the diagnostics cleaner has removed credential shapes, and a
// key that names a secret keeps no preview at all.
import { createHash } from 'node:crypto'
import { cleanText } from '../../diagnostics.js'
import { HIGH_RISK_RULES } from './rules.js'

/** Longest argument preview kept; §3.3 asks for ≤200 characters. */
export const PREVIEW_MAX = 200

/** Longest rendered `state` text; §3.3 caps the context at 2KB. */
const STATE_MAX = 2048

/**
 * Keys whose value is never previewed, whatever it looks like. Names are compared with the
 * separators removed, so `accessToken`, `access_token` and `ACCESS_TOKEN` all hide a value.
 */
const SECRET_WORDS = ['token', 'secret', 'password', 'passwd', 'apikey', 'credential', 'authorization', 'cookie', 'privatekey', 'sessionkey']
const secretKey = (key) => {
  const name = String(key).replace(/[_-]/g, '').toLowerCase()
  return SECRET_WORDS.some(word => name === word || name.endsWith(word))
}

/**
 * Keys that carry a document: the body of a write, the strings of an edit, a chat message, a
 * command line, a prompt, a patch, a file's bytes. §3.3 forbids contents in the request, so
 * only the type goes through.
 */
const CONTENT_KEYS = /^(?:content|contents|body|text|message|messages|prompt|prompts|query|queries|script|snippet|command|commands|patch|diff|source|code|data|bytes|base64|old_?str(?:ing)?|new_?str(?:ing)?|old_?content|new_?content|old_?text|new_?text|file_?text)$/i

/** Free text under a key that names nothing is cut here; past it a digest replaces the words,
 *  because a long string is a message or a document rather than a short label. */
const FREE_TEXT_MAX = 64

/** Keys that name a place, an object or a short label; their text may be previewed as is. */
const SAFE_TEXT_KEYS = /^(?:path|paths|file_?path|file_?paths|dir|dirs|directory|cwd|base|root|name|target|targets|pattern|patterns|glob|globs|url|urls|endpoint|host|port|id|ids|tool|tools|role|roles|model|preset|policy|mode|status|kind|type|title|label|tag|tags|email|project_?id|employee_?id|department_?id|company_?id|session_?id|bot_?id|room_?id|call_?id|query_?id)$/i

/** The first word of a command line is the only part a shell call needs to describe itself. */
const FIRST_WORD_MAX = 40
const firstWord = (value) => {
  const word = value.trim().split(/\s+/, 1)[0] ?? ''
  return word.length > FIRST_WORD_MAX ? word.slice(0, FIRST_WORD_MAX) : word
}

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`

const sortKeys = value => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
}

const canonical = value => JSON.stringify(sortKeys(value))

const typeOf = (value) => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array[${value.length}]`
  if (typeof value === 'object') return 'object'
  return typeof value
}

const sessionOf = exec => exec?.agent?.session

/**
 * Session → Bot → employee → project. `undefined` means this is not a company project
 * Session, which is the one case the adaptor stays silent about: the boss's own chats and
 * every non-project Session keep today's behaviour.
 */
export function resolveScope({ rt, exec }) {
  const session = sessionOf(exec)
  const sessionId = session?.header?.id ?? exec?.agent?.id
  if (typeof sessionId !== 'string') return undefined
  const selfOf = typeof rt.selfOf === 'function' ? rt.selfOf : undefined
  const store = rt.companyStore
  if (store === undefined || typeof store.byBotId !== 'function') return undefined
  let botId
  let employee
  let state
  try {
    botId = selfOf?.(sessionId)
    if (botId === undefined) return undefined
    // The store indexes Bot → employee *id*; the profile itself is the state row.
    const employeeId = store.byBotId().get(botId)
    state = store.state
    employee = typeof employeeId === 'string' ? state.employees?.[employeeId] : undefined
  } catch {
    // A company file that cannot be read leaves the employee unknown: no judging, exactly
    // the plan's "从未映射 → 不判" branch (§2.4). The adaptor records the degradation instead
    // of inventing an answer.
    return undefined
  }
  if (employee === undefined || employee.status !== 'active') return undefined
  const project = employee.project_id == null ? undefined : state.projects?.[employee.project_id]
  if (project === undefined) return undefined
  const groupOwners = rt.groupOwners
  const owned = typeof groupOwners?.get === 'function' ? groupOwners.get(sessionId) : undefined
  const roomId = owned?.roomId
  const roomProject = roomId === undefined ? undefined : Object.values(state.projects ?? {}).find(entry => entry.group_chat_ref === roomId)
  const department = state.departments?.[employee.department_id]
  const company = Object.values(state.companies ?? {}).find(entry => entry.status !== 'archived')
  const workspaceRef = typeof project.workspace_ref === 'string' && project.workspace_ref !== '' ? project.workspace_ref : undefined
  const foreignWorkspaces = Object.values(state.projects ?? {})
    .filter(entry => entry.id !== project.id && entry.status !== 'archived' && entry.status !== 'closed')
    .map(entry => entry.workspace_ref)
    .filter(ref => typeof ref === 'string' && ref !== '')
  const cwd = session?.header?.cwd
  return {
    sessionId,
    botId,
    employee,
    project,
    department,
    company,
    sessionKind: roomId === undefined ? 'chat' : 'group',
    roomId,
    workspaceRef,
    projectStatus: project.status,
    // Only evidence of working in another project's group counts as a breach; a missing
    // membership row is "unknown", not "not a member", so a young project cannot deny itself.
    member: roomProject !== undefined && roomProject.id !== project.id ? false : undefined,
    foreignWorkspaces,
    base: typeof cwd === 'string' && cwd !== '' ? cwd : workspaceRef,
  }
}

/** The host's own approval mode. A missing service, or a session the service does not know,
 *  is `unknown`, and `unknown` is what makes the adaptor fail closed without calling Jev. */
export function hostApprovalMode({ rt, exec }) {
  const session = sessionOf(exec)
  let preset
  let policy
  // The host exposes its services both as context properties and through `get`; a plugin that
  // only reads one of the two would silently lose the mode on some host versions.
  // Read through `get`: a plain property read on a service a plugin did not inject throws,
  // so the previous `??` chain never reached the second arm.
  const presets = rt.ctx?.get?.('permissionPresets')
  const approval = rt.ctx?.get?.('approval')
  try {
    preset = presets?.current?.(session)
  } catch {}
  try {
    policy = approval?.effectivePolicy?.(session)
  } catch {}
  const source = typeof preset === 'string' && typeof policy === 'string' ? 'read' : 'unknown'
  return { preset: typeof preset === 'string' ? preset : 'unknown', policy: typeof policy === 'string' ? policy : 'unknown', source }
}

/** Argument summaries for the request: key, type, and a short redacted preview. */
export function summarizeArguments(args, { home } = {}) {
  const parameters = {}
  let truncated = false
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { parameters, truncated }
  for (const key of Object.keys(args).slice(0, 32)) {
    const value = args[key]
    if (value === undefined) continue
    const type = typeOf(value)
    if (typeof value === 'string') {
      if (secretKey(key)) { parameters[key] = { type, preview: '[hidden]' }; truncated = true; continue }
      if (/^(?:command|commands)$/i.test(key)) {
        // §3.3 limits a shell call's description to its first word. The line itself can carry a
        // payload, a path or a token, and the rule layer already read it in this process.
        parameters[key] = { type, preview: firstWord(value), digest: sha256(value) }
        truncated = true
        continue
      }
      if (CONTENT_KEYS.test(key)) { parameters[key] = { type, preview: '[content omitted]' }; truncated = true; continue }
      const cleaned = cleanText(value, home === undefined ? {} : { home })
      if (!SAFE_TEXT_KEYS.test(key) && cleaned.length > FREE_TEXT_MAX) {
        // Prose rather than a name: keep its shape, not its words.
        parameters[key] = { type, length: cleaned.length, digest: sha256(cleaned) }
        truncated = true
        continue
      }
      const preview = cleaned.slice(0, PREVIEW_MAX)
      if (cleaned.length > PREVIEW_MAX) truncated = true
      parameters[key] = { type, preview }
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') { parameters[key] = { type, preview: String(value) }; continue }
    parameters[key] = { type, preview: type.startsWith('array') ? '[…]' : '{…}' }
    truncated = true
  }
  if (Object.keys(args).length > 32) truncated = true
  return { parameters, truncated }
}

/** Fold a parameter summary back into the values `classify` reads (previews, not originals). */
export const previewArguments = (parameters) => Object.fromEntries(Object.entries(parameters ?? {}).map(([key, entry]) => [key, entry?.preview]))

// The readable copy of the context. Lines are dropped from the end when the cap is reached,
// so the identity and the request always survive; `state_truncated` says that happened.
const renderState = ({ scope, tool, target, digest, mode, local }) => {
  const lines = [
    `policy_version: ${mode.policyVersion}`,
    'Three answers: allow runs the call, human-needed asks the human through the host, deny is final.',
    'A failed or unreadable judgement fails closed to human-needed.',
    `company: ${scope.company?.id ?? 'unknown'} department: ${scope.department?.id ?? 'unknown'} project: ${scope.project.id} (${scope.project.status}) revision: ${scope.project.revision ?? 'unknown'}`,
    `actor: bot=${scope.botId} employee=${scope.employee.id} role=${scope.employee.role ?? scope.employee.acceptance_role ?? 'unknown'} session=${scope.sessionKind}${scope.roomId === undefined ? '' : ` room=${scope.roomId}`}`,
    `tool: ${tool} call: ${target === undefined ? 'unknown' : target}`,
    `parameter_digest: ${digest}`,
    `authorized_workspace: ${scope.workspaceRef ?? 'unknown'} project_status: ${scope.projectStatus ?? 'unknown'}`,
    `rule_hint: ${local.rule_id} ${local.decision} sensitive: ${local.sensitive_flag === true}`,
  ]
  const text = lines.join('\n')
  return { text: text.length > STATE_MAX ? text.slice(0, STATE_MAX) : text, truncated: text.length > STATE_MAX }
}

/**
 * Build the judgement request for one call.
 *
 * `local` is the rule verdict already taken in this process; it only passes its summary on,
 * so the judgement layer does not need the arguments themselves.
 */
export function buildRequest({ exec, scope, local, host, config, now = Date.now, home }) {
  const args = exec.arguments
  // `home` is the DSH home, so paths under it are redacted like any other host folder.
  const { parameters, truncated } = summarizeArguments(args, { home })
  const callId = typeof exec.callId === 'string' ? exec.callId : 'unknown'
  const digest = sha256(canonical(parameters))
  const target = local.target ?? exec.name
  const state = renderState({ scope, tool: exec.name, target, digest, mode: config, local })
  return {
    schema_version: '1',
    request_id: `sr_${callId}`,
    operation_fingerprint: sha256(`${scope.botId}|${exec.name}|${target}|${digest}`),
    company_id: scope.company?.id ?? null,
    department_id: scope.department?.id ?? null,
    project_id: scope.project.id,
    task_id: null,
    run_id: null,
    company_revision: scope.company?.revision ?? null,
    project_revision: scope.project.revision ?? null,
    actor: {
      tool: exec.name,
      bot_id: scope.botId,
      employee_id: scope.employee.id,
      role: scope.employee.role ?? scope.employee.acceptance_role ?? null,
      session_kind: scope.sessionKind,
      room_id: scope.roomId ?? null,
    },
    tool: exec.name,
    target,
    parameter_digest: digest,
    effective_authorization_scope: { workspace_ref: scope.workspaceRef ?? null, project_status: scope.projectStatus ?? null },
    policy_version: config.policyVersion,
    sensitive_flag: local.sensitive_flag === true,
    host_approval_mode: host,
    timestamp: new Date(now()).toISOString(),
    state: state.text,
    state_truncated: state.truncated,
    // §3.3 asks the request to carry the parameter summary; structured is easier to judge
    // than the same summary rendered into `state`.
    parameters,
    arguments_truncated: truncated,
    // The verdict taken in this process travels as a hint, not as an answer: a judge may
    // disagree and the record keeps both. It also lets the stub answer a request whose command
    // line was reduced to its first word.
    rule_hint: {
      rule_id: local.rule_id ?? null,
      decision: ['allow', 'deny', 'human-needed'].includes(local.decision) ? local.decision : null,
      sensitive_flag: local.sensitive_flag === true,
      target: local.target ?? null,
    },
    questions: [
      { id: 'decision', type: 'choice', options: ['allow', 'deny', 'human-needed'] },
      { id: 'outside_scope', type: 'Noul' },
    ],
  }
}

/** The six high-risk classes, re-exported for the caller that fills `sensitive_flag`. */
export { HIGH_RISK_RULES }
