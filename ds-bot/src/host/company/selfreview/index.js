// M1b's self-review adaptor: one listener on `tools/pre-execute` that judges a project Bot's
// tool call before it runs, and turns four answers into three host outcomes.
//
//   allow        → `next()`: the host runs the call exactly as it does today
//   human-needed → `{ kind: 'ask' }`: the host's own approval path decides
//   deny         → `{ kind: 'deny' }`: final, no human override (§4.1)
//
// `mode` decides how much of that is real. `off` builds nothing and registers nothing, so a
// default install changes no behaviour at all. `shadow` writes the record and returns
// `undefined` — the call runs whatever the judgement said, which is what makes shadow safe to
// run on a live project and useful for calibration. `enforce` applies the answer. An unknown
// `mode` value is treated as `enforce`, because a typo must not silently downgrade a guard.
//
// The layer stays silent for Sessions that are not a project employee's: the boss's own chats,
// group members that are not company employees, and every host Session outside a company. It
// also fails closed when it cannot read the host's approval mode (§4.2) — it then returns only
// read-only calls to the host and asks about everything else, without calling the judge.
import { join } from 'node:path'
import { judge } from './client.js'
import { buildRequest, hostApprovalMode, resolveScope } from './context.js'
import { projectEvents } from './host-outcome.js'
import { createHostLog, hostLogPath } from './host-log.js'
import { createRecorder, makeRecord } from './records.js'
import { classify } from './rules.js'

/** The three modes §7 allows. */
export const MODES = ['off', 'shadow', 'enforce']

/** Every setting, with the defaults §7 fixes. `mode: 'off'` is today's behaviour. */
export const DEFAULT_CONFIG = {
  mode: 'off',
  endpoint: 'http://127.0.0.1:7361',
  tokenSecret: 'SELFREVIEW_TOKEN',
  timeoutMs: 800,
  minConfidence: 0.8,
  policyVersion: 'sr-2026-11-03.1',
  judgeRunCodeOuter: false,
  forceDecision: null,
  readOnlyWhitelistAllow: true,
  // Item 3: the same call judged again within this window reuses the first answer and writes
  // no second record. `0` turns the cache off, which is what a calibration run may want.
  dedupeWindowMs: 60_000,
}

/** §4.2: the only tools that pass while the host's approval mode is unreadable. */
export const READ_ONLY_WHITELIST = new Set(['read', 'glob', 'grep', 'read_image', 'session_search'])

/** Nested calls of `run_code` are judged once, at the outer call, unless asked otherwise. */
const RUN_CODE = 'run_code'

const DECISIONS = ['allow', 'human-needed', 'deny']
const RANK = { allow: 0, 'human-needed': 1, deny: 2 }
const stronger = (left, right) => (RANK[left] >= RANK[right] ? left : right)

const ASK_REASON = 'This action needs a human decision before it runs.'
const DENY_REASON = 'This action was denied by the self-review policy.'

const askDisplay = (tool) => ({
  en: `Self-review: "${tool}" is risky and needs your approval before it runs.`,
  zh: `自审查：「${tool}」属于风险操作，需要你确认后才会执行。`,
})

const inRange = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback)

/**
 * Read the settings, never throwing on a bad value: an unknown `mode` becomes `enforce`, and
 * the rest falls back to its default (§7).
 */
export function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG }
  if (raw === null || typeof raw !== 'object') return config
  if (raw.mode !== undefined) config.mode = MODES.includes(raw.mode) ? raw.mode : 'enforce'
  if (typeof raw.endpoint === 'string' && raw.endpoint !== '') config.endpoint = raw.endpoint
  if (typeof raw.tokenSecret === 'string' && raw.tokenSecret !== '') config.tokenSecret = raw.tokenSecret
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) config.timeoutMs = Math.min(60_000, raw.timeoutMs)
  config.minConfidence = inRange(raw.minConfidence, config.minConfidence)
  if (typeof raw.policyVersion === 'string' && raw.policyVersion !== '') config.policyVersion = raw.policyVersion
  if (typeof raw.judgeRunCodeOuter === 'boolean') config.judgeRunCodeOuter = raw.judgeRunCodeOuter
  if (DECISIONS.includes(raw.forceDecision)) config.forceDecision = raw.forceDecision
  if (typeof raw.readOnlyWhitelistAllow === 'boolean') config.readOnlyWhitelistAllow = raw.readOnlyWhitelistAllow
  if (typeof raw.dedupeWindowMs === 'number' && Number.isFinite(raw.dedupeWindowMs) && raw.dedupeWindowMs >= 0) config.dedupeWindowMs = Math.min(3_600_000, raw.dedupeWindowMs)
  // `sampleInAutoSessions` and `hostOutcomeProjection` are M1b-1 settings: the first has no
  // sampler and the second has no writer in M1b-0, and a knob that changes nothing would read
  // as a feature that works.
  return config
}

/**
 * Merge the rule layer's verdict with the judge's answer (§3.2 normalization + §4.2 matrix).
 *
 * A failed judgement is never an allow under `enforce`: the caller sees `human-needed` and the
 * record keeps the failure `status`. Under `shadow` nothing changes either way, so the
 * would-be allow is recorded and no gate value is returned by the caller.
 */
export function mergeVerdict({ local, answer, mode, minConfidence }) {
  if (answer === undefined || answer.ok !== true) {
    return { decision: mode === 'shadow' ? 'allow' : 'human-needed', failed: true }
  }
  const verdict = answer.verdict
  let decision = verdict.decision
  if (verdict.outsideScope >= 0.5) decision = 'deny'
  else if (verdict.probability < minConfidence) decision = 'human-needed'
  return { decision: stronger(decision, local.decision ?? 'allow'), failed: false }
}

/**
 * The adaptor itself, without `install`: tests drive `gate` directly and the plugin wires it to
 * the listener. A recorder is created here only because `mode` is not `off` — `install` returns
 * before this function in `off`, so nothing is built (not the recorder, not the client, not the
 * token lookup).
 */
export function createAdaptor({ rt, config: raw, warn, now = Date.now, fetchImpl } = {}) {
  const config = normalizeConfig(raw)
  const recorder = createRecorder({ dir: join(rt.home, 'company'), warn })
  // Item 2: the host's side is written while the turn runs, so the projection is rebuilt from
  // facts instead of decoded from a multi-frame session log later.
  const hostLog = createHostLog({ dir: join(rt.home, 'company'), warn, now })
  const counters = { calls: 0, judged: 0, failed: 0, skipped: 0, deduped: 0, host_events: 0 }
  const dedupe = new Map()
  let tokenRead = false
  let token

  const tokenOf = () => {
    if (tokenRead) return token
    tokenRead = true
    try {
      const value = rt.secretValue?.(config.tokenSecret)
      token = typeof value === 'string' && value !== '' ? value : undefined
    } catch {
      token = undefined
    }
    return token
  }

  const record = (entry) => recorder.write(entry)

  /**
   * Approvals that are about to be asked, in the order they were asked: the card's call,
   * remembered until its row arrives. The host's `approval/request` event names the call but no
   * card, and the `approval/asked` session event may name neither, so the two are joined here.
   * The Session is part of the entry: two Sessions can wait on the same tool at the same time, and
   * a call id from one must never be bound to the other's card.
   */
  const pendingAsks = []
  const noteAsk = (callId, tool, sessionId) => {
    if (typeof callId !== 'string' || callId === '') return
    if (pendingAsks.some(entry => entry.callId === callId)) return
    pendingAsks.push({
      callId,
      tool,
      sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined,
      at: now(),
    })
    while (pendingAsks.length > 8) pendingAsks.shift()
  }
  const answerWith = (answer, exec, sessionId) => {
    if (answer?.kind === 'ask') {
      const known = typeof sessionId === 'string' && sessionId !== ''
        ? sessionId
        : exec?.agent?.session?.header?.id ?? exec?.agent?.id
      noteAsk(exec?.callId, exec?.name, known)
    }
    return answer
  }
  /**
   * The call an approval card belongs to: the oldest pending ask for the same tool in the same
   * Session. An ask that names its own call needs no binding, and its queue entry is dropped here
   * so a later card cannot inherit it.
   */
  const bindPending = (event, sessionId) => {
    if (event?.type !== 'approval/asked') return undefined
    const data = event.data ?? {}
    const named = typeof data.callId === 'string' && data.callId !== '' ? data.callId : undefined
    if (named !== undefined) {
      const queued = pendingAsks.findIndex(entry => entry.callId === named)
      if (queued !== -1) pendingAsks.splice(queued, 1)
      return undefined
    }
    const tool = typeof data.toolName === 'string' ? data.toolName : undefined
    const at = pendingAsks.findIndex(entry => (tool === undefined || entry.tool === undefined || entry.tool === tool)
      && (entry.sessionId === undefined || entry.sessionId === sessionId))
    if (at === -1) return undefined
    return pendingAsks.splice(at, 1)[0].callId
  }

  /**
   * What the gate does with a decision: `shadow` records and lets the host run, `enforce`
   * applies it. Split from `settle` because a deduped call replays this answer without writing
   * a second record — the judgement is the same, so the file keeps one line per call.
   */
  const applyDecision = ({ exec, local, request, final }) => {
    // What actually governs the call: during the 0f smoke `forceDecision` overrides the merged
    // answer, and the gate must obey the decision the record shows, not the one it replaced.
    const applied = config.forceDecision ?? final
    if (config.mode === 'shadow') return undefined
    if (applied === 'allow') return undefined
    if (applied === 'deny') {
      return {
        kind: 'deny',
        reason: DENY_REASON,
        info: `self-review ${config.policyVersion}: ${(local.policy_hits ?? []).join(',') || local.rule_id || 'policy'} target=${request?.target ?? 'unknown'}`,
      }
    }
    return { kind: 'ask', reason: ASK_REASON, displayReason: askDisplay(exec?.name ?? 'tool') }
  }

  /** Turn the product answer into the gate value, and write the line for it. */
  const settle = ({ exec, scope, host, local, request, verdict = {}, status, final, started }) => {
    counters.judged += 1
    if (status !== 'ok' && status !== 'auto-session' && status !== 'host-unknown') counters.failed += 1
    const latency = now() - started
    const applied = config.forceDecision ?? final
    record(makeRecord({
      request,
      local: { ...local, rootCallId: exec?.rootCallId },
      verdict,
      decision: applied,
      judged: final,
      forced: applied !== final,
      mode: config.mode,
      status,
      latencyMs: latency,
      host,
      call: { callId: exec?.callId, rootCallId: exec?.rootCallId },
    }))
    return answerWith(applyDecision({ exec, local, request, final }), exec, scope.sessionId)
  }

  // Item 3: one key for "the same operation in the same place". The fingerprint names the call;
  // the scope ids and revisions name where it ran, so two projects asking the same thing are two
  // judgements rather than one; and the local verdict is part of the key, so a cached answer
  // never replaces a rule the rules layer would have refused.
  const dedupeKey = (request, host, local) => [
    request?.operation_fingerprint ?? '',
    host?.preset ?? '',
    host?.policy ?? '',
    request?.company_id ?? '',
    request?.project_id ?? '',
    request?.company_revision ?? '',
    request?.project_revision ?? '',
    request?.effective_authorization_scope?.workspace_ref ?? '',
    local?.rule_id ?? '',
    local?.decision ?? '',
  ].join('|')

  const cachedDecision = (key) => {
    if (config.dedupeWindowMs <= 0) return undefined
    const entry = dedupe.get(key)
    if (entry === undefined) return undefined
    if (now() - entry.at > config.dedupeWindowMs) {
      dedupe.delete(key)
      return undefined
    }
    return entry
  }

  const rememberDecision = (key, decision) => {
    if (config.dedupeWindowMs <= 0) return
    dedupe.set(key, { decision, at: now() })
    while (dedupe.size > 256) dedupe.delete(dedupe.keys().next().value)
  }

  /**
   * Judge one call. Returns `undefined` (run it), `{ kind: 'ask' }` or `{ kind: 'deny' }`, and
   * never throws: an exception inside the adaptor is itself a fail-closed answer.
   */
  const gate = async (exec) => {
    const started = now()
    counters.calls += 1
    // Not a project employee's Session: today's behaviour, and no record, because there is no
    // product answer to compare against (§2.4).
    const scope = resolveScope({ rt, exec })
    if (scope === undefined) {
      counters.skipped += 1
      return undefined
    }
    if (config.judgeRunCodeOuter === false && exec.parent === undefined && exec.name === RUN_CODE) {
      counters.skipped += 1
      return undefined
    }
    const host = hostApprovalMode({ rt, exec })
    let local = { decision: 'human-needed', rule_id: 'ERROR', policy_hits: [], probability: 0, risk_tier: 'high' }
    let request
    try {
      local = classify({ tool: exec.name, args: exec.arguments, scope, base: scope.base })
      request = buildRequest({ exec, scope, local, host, config, now, home: rt.home, redact: typeof rt.redactSecrets === 'function' ? rt.redactSecrets : undefined })
    } catch {
      // Without a rule verdict there is nothing to send; fail closed with the record intact.
      return settle({ exec, scope, host, local, request, status: 'error', final: 'human-needed', started })
    }

    // A deny is final, and nothing about it needs a second opinion: no request leaves the
    // process, so a call that touches credentials is never described to the engine.
    if (local.decision === 'deny') return settle({ exec, scope, host, local, request, status: 'ok', final: 'deny', started })

    // §4.2: an unreadable host approval mode means no judge call at all. Only the read-only
    // whitelist passes; everything else is asked, which a `never` Session turns into a refusal.
    // This branch runs before the Auto branch: an unknown policy is not evidence of Auto, and
    // reading it as Auto would let an out-of-scope write through (B3 in the r1 review).
    if (host.source === 'unknown') {
      const readOnly = config.readOnlyWhitelistAllow === true
        && READ_ONLY_WHITELIST.has(exec.name)
        && local.rule_id === 'READ_ONLY'
        && local.decision === 'allow'
      return settle({ exec, scope, host, local, request, status: 'host-unknown', final: readOnly ? 'allow' : 'human-needed', started })
    }

    // §5.1: in an Auto Session the product layer refuses only what it can prove — a deny, which
    // is final (§4.1) — and leaves everything else to the host. The high-risk classes it cannot
    // see there are the d3 gap (`auto-session-uncovered`), reported rather than papered over.
    if (host.preset === 'auto') return settle({ exec, scope, host, local, request, status: 'auto-session', final: 'allow', started })

    // Item 3: the same call inside the window reuses the first answer instead of asking the
    // engine twice, and writes no second record — a repeat is one judgement, one line.
    const key = dedupeKey(request, host, local)
    const cached = cachedDecision(key)
    if (cached !== undefined) {
      counters.deduped += 1
      return answerWith(applyDecision({ exec, local, request, final: cached.decision }), exec, scope.sessionId)
    }

    const answer = await judge({ endpoint: config.endpoint, token: tokenOf(), timeoutMs: config.timeoutMs, request, fetchImpl })
    const merged = mergeVerdict({ local, answer, mode: config.mode, minConfidence: config.minConfidence })
    rememberDecision(key, merged.decision)
    return settle({
      exec,
      scope,
      host,
      local,
      request,
      verdict: answer.ok === true ? answer.verdict : {},
      status: answer.ok === true ? 'ok' : answer.status,
      final: merged.decision,
      started,
    })
  }

  /** The listener body: any throw becomes a fail-closed answer instead of a broken tool path. */
  const listener = async (exec, next) => {
    let result
    try {
      result = await gate(exec)
    } catch (error) {
      counters.failed += 1
      if (typeof warn === 'function') warn(`selfreview gate failed: ${error instanceof Error ? error.message : String(error)}`)
      if (config.mode === 'shadow') return next()
      return { kind: 'ask', reason: ASK_REASON, displayReason: askDisplay(exec?.name ?? 'tool') }
    }
    return result === undefined ? next() : result
  }

  // Only a company employee's Session is written down: the boss's own chats, plain groups and
  // every Session outside the company keep their facts to themselves. The Bot → employee index
  // is read through the store, cached for a moment because it is consulted on every event.
  let ownersAt = 0
  let owners
  const ownersOf = () => {
    const store = rt.companyStore
    if (store === undefined || typeof store.byBotId !== 'function') return undefined
    if (owners === undefined || now() - ownersAt > 5000) {
      owners = store.byBotId()
      ownersAt = now()
    }
    return owners
  }
  const isCompanySession = (sessionId) => {
    try {
      const botId = typeof rt.selfOf === 'function' ? rt.selfOf(sessionId) : undefined
      if (botId === undefined) return false
      const index = ownersOf()
      const employeeId = index?.get?.(botId)
      const employee = typeof employeeId === 'string' ? rt.companyStore?.state?.employees?.[employeeId] : undefined
      return employee !== undefined && employee.status === 'active'
    } catch {
      return false
    }
  }

  /** One host event, appended when it says something about a company call. */
  const hostEvent = (session, event) => {
    const sessionId = session?.id ?? session?.sessionId
    if (typeof sessionId !== 'string' || isCompanySession(sessionId) === false) return
    hostLog.append(session, event, bindPending(event, sessionId))
    counters.host_events += 1
  }

  return {
    config,
    mode: config.mode,
    gate,
    listener,
    hostEvent,
    /**
     * A host ask for one call. The request carries the asking agent, so the queue entry knows its
     * Session; a request from outside the company record is not a company card and is not queued.
     */
    noteApprovalRequest: (request) => {
      const sessionId = request?.agent?.session?.id
      if (typeof sessionId === 'string' && isCompanySession(sessionId) === false) return
      noteAsk(request?.callId, request?.toolName, sessionId)
    },
    hostLogPath: hostLogPath(rt.home),
    stats: () => ({ mode: config.mode, ...counters, records: recorder.stats(), host_log: hostLog.stats() }),
    /** Pure projection of one Session's events, exposed for 0d/0e and for tests. */
    project: ({ events = [], products = [], preset = 'unknown', policy = 'unknown', isolated = false } = {}) => projectEvents({ events, products, preset, policy, isolated }),
    async close() {
      await recorder.flush()
      await hostLog.flush()
    },
  }
}

/**
 * Mount the adaptor. In `off` nothing is created and no listener is registered, so the tool
 * path is exactly the one the host had before this module existed.
 */
export function install(rt) {
  const config = normalizeConfig(rt.config?.selfReview)
  if (config.mode === 'off') {
    rt.selfReview = {
      mode: 'off',
      config,
      gate: async () => undefined,
      stats: () => ({ mode: 'off', calls: 0, judged: 0, failed: 0, skipped: 0, deduped: 0, host_events: 0, records: { written: 0, failed: 0, last_error: null }, host_log: { written: 0, failed: 0, rotate_failed: 0, last_error: null } }),
      project: () => [],
      close: async () => {},
    }
    return
  }
  const adaptor = createAdaptor({ rt, config, warn: message => rt.ctx?.logger?.warn?.(`[selfreview] ${message}`) })
  rt.selfReview = adaptor
  rt.ctx.on('tools/pre-execute', adaptor.listener, { prepend: true })
  // The host's approval hook names the call but not the card. This listener only observes: it
  // hands the hook straight on, so the host's own answerers still decide the approval.
  rt.ctx.on('approval/request', (request, next) => {
    try { adaptor.noteApprovalRequest(request) } catch {}
    return typeof next === 'function' ? next() : undefined
  })
  rt.ctx.on('session/event', (session, event) => adaptor.hostEvent(session, event))
  rt.ctx.effect(() => () => adaptor.close(), 'ds-bot: company self-review records')
}
