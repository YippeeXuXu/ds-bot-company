// Where a judgement is kept: one JSON line per judged call, in
// <home>/company/selfreview.jsonl, rotated at 8MB and kept five deep.
//
// The record is written for every judged call, allow included — the shadow audit (§8.1 a) is a
// set difference between the calls the session log shows and the requests this file carries, so
// a missing allow line would look like a missing judgement. Writes are ordered by a promise
// chain, never awaited on the tool path, and a failed write is counted instead of thrown: losing
// a line must not change a decision (§6.3).
import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Rotate at 8MB, five older files (§6.3). */
export const FILE_MAX_BYTES = 8 * 1024 * 1024
export const KEEP_FILES = 5

/** The §6.1 fields, in record order. Extensions after `created_at` are documented in the plan. */
export const RECORD_FIELDS = [
  'id', 'request_id', 'operation_fingerprint',
  'project_id', 'task_id', 'run_id',
  'project_revision', 'task_revision', 'run_revision',
  'policy_version', 'model_id', 'model_version', 'input_digest',
  'decision', 'probability', 'policy_hits', 'status',
  'sensitive_flag', 'predicted_risk_tier', 'authorizer', 'created_at',
]

const emptyStats = () => ({ written: 0, failed: 0, last_error: null })

/**
 * Build one record from what the adaptor already holds.
 *
 * `null` is used where the value does not exist yet (task, run, engine model when the rule
 * layer answered alone), so the line keeps a stable shape for the tools that read it later.
 */
export function makeRecord({
  request = {},
  local = {},
  verdict = {},
  decision,
  judged,
  forced = false,
  mode,
  status,
  latencyMs,
  host = {},
  call = {},
  now = Date.now(),
} = {}) {
  const answeredBy = verdict.modelId === undefined ? null : verdict.modelId
  return {
    id: typeof request.request_id === 'string' ? request.request_id : null,
    request_id: request.request_id ?? null,
    operation_fingerprint: request.operation_fingerprint ?? null,
    project_id: request.project_id ?? null,
    task_id: null,
    run_id: null,
    project_revision: request.project_revision ?? null,
    task_revision: null,
    run_revision: null,
    policy_version: request.policy_version ?? null,
    model_id: answeredBy,
    model_version: verdict.modelVersion ?? null,
    input_digest: verdict.inputDigest ?? null,
    // The decision that governs the call: the merged answer, or the one `forceDecision`
    // substituted for it during the 0f smoke. `judged_decision` keeps the answer the layers
    // actually produced, so a forced line can never be mistaken for a judgement.
    decision: decision ?? judged ?? verdict.decision ?? local.decision ?? null,
    judged_decision: forced ? (judged ?? null) : (decision ?? judged ?? verdict.decision ?? local.decision ?? null),
    forced,
    probability: typeof verdict.probability === 'number' ? verdict.probability : local.probability ?? null,
    policy_hits: Array.isArray(verdict.policyHits) && verdict.policyHits.length > 0 ? verdict.policyHits : local.policy_hits ?? [],
    status: status ?? 'ok',
    sensitive_flag: request.sensitive_flag === true,
    predicted_risk_tier: verdict.predictedRiskTier ?? null,
    authorizer: verdict.authorizer ?? 'none',
    created_at: new Date(now).toISOString(),
    // Extensions: identity and correlation. `answered_actor` stays unknown — M1b-0 does not
    // claim to know who answered a card (§12.3 B3-1).
    company_id: request.company_id ?? null,
    department_id: request.department_id ?? null,
    mode: mode ?? 'off',
    latency_ms: typeof latencyMs === 'number' ? Math.max(0, Math.round(latencyMs)) : null,
    call_id: call.callId ?? (request.request_id?.startsWith('sr_') === true ? request.request_id.slice(3) : null),
    root_call_id: call.rootCallId ?? null,
    host_preset: host.preset ?? 'unknown',
    host_policy: host.policy ?? 'unknown',
    answered_actor: 'unknown',
    // The rule layer's own verdict, kept next to the product answer so M1b-1 can compare them.
    rule_id: local.rule_id ?? null,
    rule_decision: local.decision ?? null,
    tool: request.tool ?? null,
    target: typeof request.target === 'string' ? request.target : null,
  }
}

/**
 * An append-only line writer with rotation and a failure count.
 *
 * `write` enqueues and returns the promise for that line; callers on the tool path ignore it,
 * tests and the shutdown path use `flush`.
 */
export function createRecorder({ dir, file = 'selfreview.jsonl', maxBytes = FILE_MAX_BYTES, keep = KEEP_FILES, warn } = {}) {
  const path = join(dir, file)
  const stats = emptyStats()
  let queue = Promise.resolve()
  let ready = null
  let size = 0
  let sized = false

  const ensureDir = () => {
    if (ready === null) ready = mkdir(dir, { recursive: true }).then(() => undefined)
    return ready
  }

  const rotate = async () => {
    for (let index = keep - 1; index >= 1; index -= 1) {
      await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(() => {})
    }
    await rename(path, `${path}.1`).catch(() => {})
    await unlink(`${path}.${keep + 1}`).catch(() => {})
    size = 0
  }

  const append = async (record) => {
    const line = `${JSON.stringify(record)}\n`
    try {
      await ensureDir()
      if (!sized) {
        size = await stat(path).then(entry => entry.size).catch(() => 0)
        sized = true
      }
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) await rotate()
      await appendFile(path, line, 'utf8')
      size += Buffer.byteLength(line)
      stats.written += 1
    } catch (error) {
      stats.failed += 1
      stats.last_error = error instanceof Error ? error.message : String(error)
      if (typeof warn === 'function') warn(`selfreview record write failed: ${stats.last_error}`)
    }
  }

  return {
    path,
    write(record) {
      queue = queue.then(() => append(record))
      return queue
    },
    async flush() {
      await queue
    },
    stats() {
      return { ...stats }
    },
  }
}
