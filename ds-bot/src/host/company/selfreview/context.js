// The minimal context one tool call is judged on: which Bot, which employee, which project,
// which folder is authorized, and the structured facts of the call. §3.3 of the M1b plan is
// the contract — the JSON fields decide, the rendered `state` text is only a readable copy for
// the stub and for a person reading a record later.
//
// What never leaves this module: file contents, command output, conversation history,
// credentials, tokens, the whole company state, and other projects' data. The facts are
// projected in `features.js`; this module only adds the identity and the authorization scope.
import { createHash } from 'node:crypto'
import { callFeatures } from './features.js'
import { HIGH_RISK_RULES } from './rules.js'

/** Longest rendered `state` text; §3.3 caps the context at 2KB. */
const STATE_MAX = 2048

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`

const sortKeys = value => {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
}

const canonical = value => JSON.stringify(sortKeys(value))

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

// The readable copy of the context. Lines are dropped from the end when the cap is reached,
// so the identity and the request always survive; `state_truncated` says that happened.
// It describes the call and the authorization only: the verdict this process already took
// stays local, because telling a judge the answer first would anchor the judgement.
const renderState = ({ scope, tool, target, digest, mode, host }) => {
  const lines = [
    `policy_version: ${mode.policyVersion}`,
    'Three answers: allow runs the call, human-needed asks the human through the host, deny is final.',
    'A failed or unreadable judgement fails closed to human-needed.',
    // §3.3: the judge needs the host's own approval mode to read the call, and `unknown` is a
    // fact worth saying out loud — it is what makes the adaptor fail closed before judging.
    `host_approval_mode: preset=${host?.preset ?? 'unknown'} policy=${host?.policy ?? 'unknown'} source=${host?.source ?? 'unknown'}`,
    `company: ${scope.company?.id ?? 'unknown'} department: ${scope.department?.id ?? 'unknown'} project: ${scope.project.id} (${scope.project.status}) revision: ${scope.project.revision ?? 'unknown'}`,
    `actor: bot=${scope.botId} employee=${scope.employee.id} role=${scope.employee.role ?? scope.employee.acceptance_role ?? 'unknown'} session=${scope.sessionKind}${scope.roomId === undefined ? '' : ` room=${scope.roomId}`}`,
    `tool: ${tool} call: ${target === undefined ? 'unknown' : target}`,
    `parameter_digest: ${digest}`,
    `authorized_workspace: ${scope.workspaceRef ?? 'unknown'} project_status: ${scope.projectStatus ?? 'unknown'}`,
  ]
  const text = lines.join('\n')
  return { text: text.length > STATE_MAX ? text.slice(0, STATE_MAX) : text, truncated: text.length > STATE_MAX }
}

/**
 * Build the judgement request for one call.
 *
 * `local` is the rule verdict already taken in this process. Only facts travel with the
 * request — the target and the high-risk flag the local pass found; its rule id and its
 * decision do not, so the judge answers from the call itself rather than from a hint.
 */
export function buildRequest({ exec, scope, local, host, config, now = Date.now, home, redact }) {
  const args = exec.arguments
  // The judge reads facts, not text: `features.js` projects the call into the shape §3.3 asks
  // for and redacts the host home. `home` is the DSH home, so paths under it become `<dsh-home>`.
  const features = callFeatures({ tool: exec.name, args, base: scope.base, scope, home, redact })
  const callId = typeof exec.callId === 'string' ? exec.callId : 'unknown'
  // The digest identifies the call for dedupe and for the record without carrying its arguments;
  // it is computed here and never sent as text.
  const digest = sha256(canonical(args ?? {}))
  // The target is a fact, not a value: if it happens to spell out a secret the store knows, the
  // store's redactor scrubs it here too, so no field of the request can carry a credential.
  const raw = local.target ?? exec.name
  const target = typeof redact === 'function' ? redact(String(raw)) : raw
  const state = renderState({ scope, tool: exec.name, target, digest, mode: config, host })
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
    // §3.3: the judge reads facts, not text. `parameter_digest` above identifies the call;
    // `features` is its structured projection.
    features,
    arguments_truncated: features.truncated,
    questions: [
      { id: 'decision', type: 'choice', options: ['allow', 'deny', 'human-needed'] },
      { id: 'outside_scope', type: 'Noul' },
    ],
  }
}

/** The six high-risk classes, re-exported for the caller that fills `sensitive_flag`. */
export { HIGH_RISK_RULES }
