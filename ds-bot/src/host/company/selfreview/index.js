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
  sampleInAutoSessions: 0.1,
  forceDecision: null,
  readOnlyWhitelistAllow: true,
  hostOutcomeProjection: true,
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
  config.sampleInAutoSessions = inRange(raw.sampleInAutoSessions, config.sampleInAutoSessions)
  if (DECISIONS.includes(raw.forceDecision)) config.forceDecision = raw.forceDecision
  if (typeof raw.readOnlyWhitelistAllow === 'boolean') config.readOnlyWhitelistAllow = raw.readOnlyWhitelistAllow
  if (typeof raw.hostOutcomeProjection === 'boolean') config.hostOutcomeProjection = raw.hostOutcomeProjection
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
  const counters = { calls: 0, judged: 0, failed: 0, skipped: 0 }
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

  /** Turn the product answer into the gate value, and write the line for it. */
  const settle = ({ exec, host, local, request, verdict = {}, status, final, started }) => {
    counters.judged += 1
    if (status !== 'ok' && status !== 'auto-session' && status !== 'host-unknown') counters.failed += 1
    const latency = now() - started
    record(makeRecord({
      request,
      local: { ...local, rootCallId: exec?.rootCallId },
      verdict,
      decision: final,
      mode: config.mode,
      status,
      latencyMs: latency,
      host,
      call: { callId: exec?.callId, rootCallId: exec?.rootCallId },
    }))
    // Shadow records the answer and changes nothing: no listener result means `next()` runs.
    if (config.mode === 'shadow') return undefined
    const applied = config.forceDecision ?? final
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
      request = buildRequest({ exec, scope, local, host, config, now, home: rt.home })
    } catch {
      // Without a rule verdict there is nothing to send; fail closed with the record intact.
      return settle({ exec, scope, host, local, request, status: 'error', final: 'human-needed', started })
    }

    // A deny is final, and nothing about it needs a second opinion: no request leaves the
    // process, so a call that touches credentials is never described to the engine.
    if (local.decision === 'deny') return settle({ exec, scope, host, local, request, status: 'ok', final: 'deny', started })

    // §5.1: in an Auto Session the product layer refuses only what it can prove — a deny, which
    // is final (§4.1) — and leaves everything else to the host. The high-risk classes it cannot
    // see there are the d3 gap (`auto-session-uncovered`), reported rather than papered over.
    if (host.preset === 'auto') return settle({ exec, scope, host, local, request, status: 'auto-session', final: 'allow', started })

    // §4.2: an unreadable host approval mode means no judge call at all. Only the read-only
    // whitelist passes; everything else is asked, which a `never` Session turns into a refusal.
    if (host.source === 'unknown') {
      const readOnly = config.readOnlyWhitelistAllow === true
        && READ_ONLY_WHITELIST.has(exec.name)
        && local.rule_id === 'READ_ONLY'
        && local.decision === 'allow'
      return settle({ exec, scope, host, local, request, status: 'host-unknown', final: readOnly ? 'allow' : 'human-needed', started })
    }

    const answer = await judge({ endpoint: config.endpoint, token: tokenOf(), timeoutMs: config.timeoutMs, request, fetchImpl })
    const merged = mergeVerdict({ local, answer, mode: config.mode, minConfidence: config.minConfidence })
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

  return {
    config,
    mode: config.mode,
    gate,
    listener,
    stats: () => ({ mode: config.mode, ...counters, records: recorder.stats() }),
    /** Pure projection of one Session's events, exposed for 0d/0e and for tests. */
    project: ({ events = [], products = [], preset = 'unknown', policy = 'unknown', isolated = false } = {}) => projectEvents({ events, products, preset, policy, isolated }),
    async close() {
      await recorder.flush()
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
      stats: () => ({ mode: 'off', calls: 0, judged: 0, failed: 0, skipped: 0, records: { written: 0, failed: 0, last_error: null } }),
      project: () => [],
      close: async () => {},
    }
    return
  }
  const adaptor = createAdaptor({ rt, config, warn: message => rt.ctx?.logger?.warn?.(`[selfreview] ${message}`) })
  rt.selfReview = adaptor
  rt.ctx.on('tools/pre-execute', adaptor.listener, { prepend: true })
  rt.ctx.effect(() => () => adaptor.close(), 'ds-bot: company self-review records')
}
