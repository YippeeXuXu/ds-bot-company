// The host's side of one call, projected from the session events alone (§6.2).
//
// Pure on purpose: M1b-0 ships the projection and its tests, the reading of a real session log
// arrives with 0d/0e. Nothing here consults the engine, a file or the clock — the caller hands
// in the events of one call and gets the seven-value outcome, the execution result and the
// authorizer, so the same input always produces the same line.
//
// The value the projection must not invent is *who* answered an approval card: events carry no
// actor. `human` is therefore only given to the isolated card of the 0f smoke run, and
// `answered_actor` never appears here at all.
export const HOST_OUTCOMES = [
  'allowed-by-policy',
  'approved-by-human',
  'rejected-by-human',
  'rejected-by-policy',
  'failed-execution',
  'unavailable',
  'unobservable',
]

export const EXECUTION_RESULTS = ['not-attempted', 'succeeded', 'failed(denied)', 'failed(execution)', 'unknown']

export const AUTHORIZERS = ['none', 'auto', 'human', 'unknown']

/** Denials the host writes when an approval card is answered (§6.2 word list). */
export const REJECTION_TEXT = /^the user rejected tool ".*"$/
export const CANCELLED_TEXT = /^approval for tool ".*" was cancelled$/
/** Denials the host writes when no card could ever be answered (§6.2 #3). */
export const NO_CHANNEL_TEXT = /^requires approval, but (?:no approval channel is available|the call has no agent to route it through)$/

/** dsh-tools prefixes a denial with `Error: `; the word list matches the reason itself. */
export const stripErrorPrefix = text => String(text ?? '').replace(/^Error:\s*/, '').trim()

const last = (list) => list[list.length - 1]

const resultOf = (event) => {
  const text = stripErrorPrefix(event?.text)
  return { isError: event?.isError === true, text }
}

/**
 * Group flat session events by the call they belong to, keeping arrival order.
 *
 * Approval events carry no `callId` in the session log, so the caller joins them to their call
 * first (0d/0e): an event without one is dropped here rather than guessed into a group.
 */
export function groupEvents(events) {
  const groups = new Map()
  for (const event of events ?? []) {
    const callId = typeof event?.callId === 'string' ? event.callId : undefined
    if (callId === undefined) continue
    if (!groups.has(callId)) groups.set(callId, [])
    groups.get(callId).push(event)
  }
  return groups
}

const executionResultOf = ({ result, decided }) => {
  if (result === undefined) return 'not-attempted'
  if (!result.isError) return 'succeeded'
  const { text } = result
  if (REJECTION_TEXT.test(text) || CANCELLED_TEXT.test(text) || NO_CHANNEL_TEXT.test(text)) return 'failed(denied)'
  if (decided?.outcome === 'rejected' || decided?.outcome === 'unavailable' || decided?.outcome === 'cancelled') return 'failed(denied)'
  return 'failed(execution)'
}

const authorizerOf = ({ asked, decided, preset, policy, isolated, result }) => {
  if (isolated && policy === 'ask' && (decided?.outcome === 'allowed-once' || decided?.outcome === 'rejected')) return 'human'
  if (asked === undefined && preset === 'auto' && result !== undefined && !result.isError) return 'auto'
  return 'unknown'
}

const projection = ({ callId, outcome, reason, executionResult, authorizer, product, asked, decided, preset, policy }) => ({
  call_id: callId ?? null,
  outcome,
  reason,
  execution_result: executionResult,
  authorizer,
  product_decision: product?.decision ?? null,
  approval_policy: policy,
  host_preset: preset,
  approval_outcome: decided?.outcome ?? null,
  approval_id: asked?.approvalId ?? null,
})

/**
 * Project one call.
 *
 * `product` is the SelfReview record for the same call, if the adaptor wrote one; it decides
 * the first branch (a product deny is `rejected-by-policy` whatever happened afterwards).
 * `isolated` is only set by the 0f probe, and is the sole route to `authorizer: 'human'`.
 */
export function projectHostOutcome({ callId, events = [], product, preset = 'unknown', policy = 'unknown', isolated = false } = {}) {
  const calls = events.filter(event => event?.type === 'tool/call')
  const asked = last(events.filter(event => event?.type === 'approval/asked'))
  const decided = asked === undefined
    ? undefined
    : last(events.filter(event => event?.type === 'approval/decided' && (asked.approvalId === undefined || event.approvalId === asked.approvalId)))
  const resultEvent = last(events.filter(event => event?.type === 'tool/result'))
  const result = resultEvent === undefined ? undefined : resultOf(resultEvent)
  const execution = executionResultOf({ result, decided })
  const authorizer = authorizerOf({ asked, decided, preset, policy, isolated, result })
  const base = { callId, executionResult: execution, authorizer, product, asked, decided, preset, policy }

  if (calls.length === 0) return projection({ ...base, outcome: 'unobservable', reason: 'no-call' })

  // 1. The adaptor itself refused the call.
  if (product?.decision === 'deny') return projection({ ...base, outcome: 'rejected-by-policy', reason: 'product-deny' })

  // 2. An approval card was asked and answered.
  if (asked !== undefined) {
    if (decided === undefined) return projection({ ...base, outcome: 'unobservable', reason: 'undecided' })
    // A missing policy means the log cannot tell `ask` from `never`; that is not evidence.
    if (policy !== 'ask' && policy !== 'never') return projection({ ...base, outcome: 'unobservable', reason: 'policy-unreadable' })
    if (decided.outcome === 'unavailable' || decided.outcome === 'cancelled') return projection({ ...base, outcome: 'unavailable', reason: `approval-${decided.outcome}` })
    if (policy === 'ask' && decided.outcome === 'allowed-once') return projection({ ...base, outcome: 'approved-by-human', reason: 'ask-allowed' })
    if (policy === 'ask' && decided.outcome === 'rejected') return projection({ ...base, outcome: 'rejected-by-human', reason: 'ask-rejected' })
    if (policy === 'never' && decided.outcome === 'rejected') return projection({ ...base, outcome: 'rejected-by-policy', reason: 'never-rejected' })
    return projection({ ...base, outcome: 'unobservable', reason: 'unexpected-outcome' })
  }

  // 3. No card at all: the host decides alone.
  if (result === undefined) return projection({ ...base, outcome: 'unobservable', reason: 'no-result' })
  if (!result.isError) return projection({ ...base, outcome: 'allowed-by-policy', reason: 'no-approval-succeeded' })
  if (NO_CHANNEL_TEXT.test(result.text)) return projection({ ...base, outcome: 'unavailable', reason: 'no-channel' })
  if (REJECTION_TEXT.test(result.text) || CANCELLED_TEXT.test(result.text)) {
    // A rejection message without its card events cannot be tied to an answer.
    return projection({ ...base, outcome: 'unobservable', reason: 'denial-without-asked' })
  }
  return projection({ ...base, outcome: 'failed-execution', reason: 'error-result' })
}

/**
 * Turn the events of a decoded `session.v4.jsonl` log into the flat shape this module groups.
 *
 * The log on disk is the only place the host's side of a call exists, and its field names do not
 * match the projection's: `tool/call` carries `data.name`, `tool/result` carries the call id and
 * the text inside `data.message`, and an approval is two events joined by `data.id`. A reader
 * that skips this step sees every result as ungrouped and reports `unobservable` for calls the
 * host in fact executed, so the mapping is code with tests, not a note.
 */
export function normalizeSessionEvents(events) {
  const askedById = new Map()
  const flat = []
  for (const raw of events ?? []) {
    const type = raw?.type
    const data = raw?.data ?? {}
    if (type === 'tool/call') {
      flat.push({ type, callId: data.callId, toolName: data.name })
      continue
    }
    if (type === 'tool/result') {
      const message = data.message ?? {}
      const text = Array.isArray(message.content)
        ? message.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
        : ''
      flat.push({ type, callId: message.toolCallId ?? data.callId, isError: message.isError === true, text })
      continue
    }
    if (type === 'approval/asked') {
      const entry = { type, approvalId: data.id, callId: data.callId, toolName: data.toolName }
      askedById.set(data.id, entry)
      flat.push(entry)
      continue
    }
    if (type === 'approval/decided') {
      // The decided event only names the card; the call it belongs to is the asked event's.
      const origin = askedById.get(data.id)
      flat.push({ type, approvalId: data.id, outcome: data.outcome, callId: origin?.callId, toolName: origin?.toolName })
      continue
    }
    if (type === 'approval/policy') {
      flat.push({ type, policy: data.policy })
      continue
    }
    if (type === 'permission/preset') {
      flat.push({ type, preset: data.preset })
      continue
    }
  }
  return flat
}

/**
 * Project a whole decoded log: the last `approval/policy` and `permission/preset` decide for the
 * Session, then every call is projected against its own group of events.
 */
export function projectSessionEvents({ events = [], products = [], isolated = false } = {}) {
  const flat = normalizeSessionEvents(events)
  const policy = flat.filter(event => event.type === 'approval/policy').at(-1)?.policy ?? 'unknown'
  const preset = flat.filter(event => event.type === 'permission/preset').at(-1)?.preset ?? 'unknown'
  return projectEvents({ events: flat, products, preset, policy, isolated })
}

/** Project every call in one session. `products` are SelfReview records of the same session. */
export function projectEvents({ events = [], products = [], preset = 'unknown', policy = 'unknown', isolated = false } = {}) {
  const productsByCall = new Map()
  for (const record of products) {
    if (typeof record?.call_id === 'string') productsByCall.set(record.call_id, record)
  }
  return [...groupEvents(events)].map(([callId, group]) => projectHostOutcome({
    callId,
    events: group,
    product: productsByCall.get(callId),
    preset,
    policy,
    isolated,
  }))
}
