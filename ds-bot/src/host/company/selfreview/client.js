// The one network hop of the adaptor: POST /v1/systemone on the judgement layer.
//
// This module never throws and never guesses. Every way of failing — no token, refused
// connection, a slow engine, a non-2xx answer, JSON that does not match §3.2 — is turned into
// a `status` the caller can fail closed on. Timeouts are enforced here with an AbortController
// because a hung fetch would otherwise hold the tool call until the engine's own timeout.
import { DECISIONS } from './rules.js'

/** Failure kinds §4.2 turns into human-needed under enforce. */
export const FAILURES = ['timeout', 'unavailable', 'invalid', 'error']

const RISK_TIERS = ['low', 'medium', 'high']
const AUTHORIZERS = ['none', 'auto', 'human']
const isProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

const failure = (status, detail) => ({ status, ok: false, detail })

const choiceOf = (answers, id) => {
  if (!Array.isArray(answers)) return undefined
  return answers.find(answer => answer !== null && typeof answer === 'object' && answer.id === id)
}

/** Validate the §3.2 answer. A missing answer, an unknown choice or a probability outside
 *  [0,1] is `invalid`, so the caller fails closed instead of executing on a guess. */
export function readAnswer(body) {
  if (body === null || typeof body !== 'object') return failure('invalid', 'body')
  if (body.status !== 'ok') {
    const status = body.status === 'timeout' || body.status === 'unavailable' || body.status === 'invalid' ? body.status : 'error'
    return failure(status, typeof body.detail === 'string' ? body.detail : 'engine')
  }
  const decision = choiceOf(body.answers, 'decision')
  const outside = choiceOf(body.answers, 'outside_scope')
  if (decision === undefined || outside === undefined) return failure('invalid', 'answers')
  if (!DECISIONS.includes(decision.choice)) return failure('invalid', 'decision')
  if (!isProbability(decision.probability) || !isProbability(outside.probability)) return failure('invalid', 'probability')
  const policyHits = Array.isArray(body.policy_hits) ? body.policy_hits.filter(hit => typeof hit === 'string') : []
  return {
    ok: true,
    status: 'ok',
    verdict: {
      decision: decision.choice,
      probability: decision.probability,
      outsideScope: outside.probability,
      modelId: typeof body.model_id === 'string' ? body.model_id : 'unknown',
      modelVersion: typeof body.model_version === 'string' ? body.model_version : 'unknown',
      inputDigest: typeof body.input_digest === 'string' ? body.input_digest : null,
      predictedRiskTier: RISK_TIERS.includes(body.predicted_risk_tier) ? body.predicted_risk_tier : null,
      authorizer: AUTHORIZERS.includes(body.authorizer) ? body.authorizer : 'none',
      policyHits,
      evaluatedAt: typeof body.evaluated_at === 'string' ? body.evaluated_at : null,
    },
  }
}

/**
 * Ask the judgement layer about one call.
 *
 * `token` undefined means the secret is not configured; that is a local failure, and no
 * request is sent, so a misconfigured install cannot quietly talk to an unauthenticated port.
 */
export async function judge({ endpoint, token, timeoutMs = 800, request, fetchImpl = globalThis.fetch }) {
  if (typeof token !== 'string' || token === '') return failure('unavailable', 'token')
  if (typeof endpoint !== 'string' || endpoint === '') return failure('unavailable', 'endpoint')
  if (typeof fetchImpl !== 'function') return failure('unavailable', 'fetch')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/v1/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal: controller.signal,
    })
    if (!response.ok) return failure('unavailable', `http ${response.status}`)
    let body
    try {
      body = await response.json()
    } catch {
      return failure('invalid', 'json')
    }
    return readAnswer(body)
  } catch (error) {
    // Abort is the timeout path; anything else is a refused or broken connection.
    if (controller.signal.aborted) return failure('timeout', 'aborted')
    return failure('unavailable', error instanceof Error ? error.message : 'fetch')
  } finally {
    clearTimeout(timer)
  }
}
