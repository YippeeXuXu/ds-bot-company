// M1b-0a/0b: the adaptor, the rule table, the records and the stub.
//
// The tests are written the way the plan's acceptance reads: `off` must be indistinguishable
// from the host without this module, `shadow` must never change a decision, `enforce` must
// answer the three ways, every judged call must leave one line, and a failed judgement must
// fail closed. The stub is exercised over real HTTP on loopback, not by importing its handler.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { judge, readAnswer } from '../src/host/company/selfreview/client.js'
import { buildRequest, hostApprovalMode, resolveScope, summarizeArguments } from '../src/host/company/selfreview/context.js'
import { projectEvents, projectHostOutcome, groupEvents } from '../src/host/company/selfreview/host-outcome.js'
import { DEFAULT_CONFIG, createAdaptor, install, mergeVerdict, normalizeConfig, MODES, READ_ONLY_WHITELIST } from '../src/host/company/selfreview/index.js'
import { createRecorder, makeRecord, RECORD_FIELDS } from '../src/host/company/selfreview/records.js'
import { classify } from '../src/host/company/selfreview/rules.js'

const WORKSPACE = '/work/ds-bot'
const OTHER_WORKSPACE = '/work/other'
const DS_BOT_DIR = fileURLToPath(new URL('..', import.meta.url))
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-selfreview-'))
const recordPath = home => join(home, 'company', 'selfreview.jsonl')

const linesOf = path => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

const companyState = () => ({
  revision: 9,
  companies: { co: { id: 'co', name: 'DS Bot Company', revision: 3, status: 'active' } },
  departments: { dept: { id: 'dept', name: '工程', revision: 4 } },
  employees: {
    emp: { id: 'emp', bot_id: 'bot_a', department_id: 'dept', name: '键盘', role: 'engineer', status: 'active', project_id: 'proj', revision: 5 },
  },
  projects: {
    proj: { id: 'proj', name: '研发线', status: 'active', workspace_ref: WORKSPACE, group_chat_ref: 'room_proj', revision: 6 },
    other: { id: 'other', name: '另一个项目', status: 'active', workspace_ref: OTHER_WORKSPACE, group_chat_ref: 'room_other', revision: 2 },
  },
  members: {},
})

// A Session-owning Bot only in the two Sessions the tests use; anything else is not a company
// Session and must stay untouched.
const owners = { sess_chat: 'bot_a', sess_group: 'bot_a', sess_other: 'bot_a' }

function fakeCtx({ preset = 'ask', policy = 'ask', silent = false } = {}) {
  const listeners = new Map()
  const disposers = []
  const presets = silent ? undefined : { current: () => preset }
  const approval = silent ? undefined : { effectivePolicy: () => policy }
  return {
    listeners,
    disposers,
    logger: { warn() {} },
    permissionPresets: presets,
    approval,
    get: name => (name === 'permissionPresets' ? presets : name === 'approval' ? approval : undefined),
    on(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
}

function rtOf({ home, ctx = fakeCtx(), state = companyState(), groups = new Map(), secret, onSecret, botOwner = owners } = {}) {
  const byBot = new Map(Object.values(state.employees).map(employee => [employee.bot_id, employee]))
  return {
    home,
    ctx,
    config: {},
    companyStore: { state, byBotId: () => byBot },
    selfOf: sessionId => botOwner[sessionId],
    botOf: id => ({ id, name: id }),
    groupOwners: groups,
    secretValue(name) {
      if (typeof onSecret === 'function') onSecret(name)
      return secret
    },
  }
}

const execOf = ({ name = 'read', args = { file_path: `${WORKSPACE}/README.md` }, sessionId = 'sess_chat', callId = 'call_1', parent, rootCallId } = {}) => ({
  name,
  arguments: args,
  callId,
  rootCallId: rootCallId ?? callId,
  parent,
  agent: { id: sessionId, session: { header: { id: sessionId, cwd: WORKSPACE } } },
})

const okFetch = (choice = 'allow', probability = 0.95, extra = {}) => async () => ({
  ok: true,
  json: async () => ({
    status: 'ok',
    model_id: 'fake-engine',
    model_version: '1',
    input_digest: 'sha256:stub',
    answers: [
      { id: 'decision', choice, probability },
      { id: 'outside_scope', probability: 0.05 },
    ],
    predicted_risk_tier: 'low',
    authorizer: 'none',
    policy_hits: [],
    evaluated_at: '2026-11-03T00:00:00.000Z',
    ...extra,
  }),
})

const adaptorOf = ({ home = tempHome(), rt, config = {}, fetchImpl } = {}) => {
  const options = {
    rt: rt ?? rtOf({ home, secret: 'token' }),
    config: { mode: 'enforce', timeoutMs: 100, ...config },
    warn: () => {},
  }
  // Omitted on purpose means "use the host's fetch"; the end-to-end test relies on that.
  if (fetchImpl !== undefined) options.fetchImpl = fetchImpl
  else if (config.endpoint === undefined) options.fetchImpl = okFetch()
  return createAdaptor(options)
}

// ── settings ──────────────────────────────────────────────────────────────────────────────

test('the settings default to off, and an unknown mode fails closed to enforce', () => {
  assert.equal(normalizeConfig(undefined).mode, 'off')
  assert.equal(normalizeConfig({}).mode, DEFAULT_CONFIG.mode)
  for (const mode of MODES) assert.equal(normalizeConfig({ mode }).mode, mode)
  // A typo must not silently remove the guard.
  assert.equal(normalizeConfig({ mode: 'enforced' }).mode, 'enforce')
  assert.equal(normalizeConfig({ mode: 'OFF' }).mode, 'enforce')
  assert.equal(normalizeConfig({ timeoutMs: -5 }).timeoutMs, DEFAULT_CONFIG.timeoutMs)
  assert.equal(normalizeConfig({ timeoutMs: 1e9 }).timeoutMs, 60_000)
  assert.equal(normalizeConfig({ minConfidence: 7 }).minConfidence, DEFAULT_CONFIG.minConfidence)
  assert.equal(normalizeConfig({ forceDecision: 'maybe' }).forceDecision, null)
})

test('off builds nothing: no listener, no record, no token lookup', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const looked = []
  const rt = rtOf({ home, ctx, secret: 'token', onSecret: name => looked.push(name) })
  install(rt)
  assert.equal(rt.selfReview.mode, 'off')
  assert.equal(ctx.listeners.has('tools/pre-execute'), false)
  assert.deepEqual(looked, [])
  // The exposed gate stays silent even if something calls it.
  assert.equal(await rt.selfReview.gate(execOf({})), undefined)
  assert.deepEqual(readdirSync(home), [])
  rmSync(home, { recursive: true, force: true })
})

test('shadow mounts one prepended listener and keeps the record', async () => {
  const home = tempHome()
  const ctx = fakeCtx()
  const rt = rtOf({ home, ctx, secret: 'token' })
  rt.config = { selfReview: { mode: 'shadow' } }
  install(rt)
  assert.equal(ctx.listeners.get('tools/pre-execute').length, 1)
  let nexted = 0
  const answer = await rt.selfReview.listener(execOf({}), async () => { nexted += 1 })
  assert.equal(answer, undefined)
  assert.equal(nexted, 1)
  await rt.selfReview.close()
  assert.equal(linesOf(recordPath(home)).length, 1)
  rmSync(home, { recursive: true, force: true })
})

// ── the three answers ────────────────────────────────────────────────────────────────────

test('enforce allows a read inside the project and records it', async () => {
  const home = tempHome()
  const adaptor = adaptorOf({ home })
  assert.equal(await adaptor.gate(execOf({})), undefined)
  await adaptor.close()
  const [record] = linesOf(recordPath(home))
  assert.equal(record.decision, 'allow')
  assert.equal(record.rule_id, 'READ_ONLY')
  assert.equal(record.mode, 'enforce')
  assert.equal(record.call_id, 'call_1')
  assert.equal(record.host_preset, 'ask')
  assert.equal(record.status, 'ok')
  rmSync(home, { recursive: true, force: true })
})

test('a deny never reaches the judgement layer', async () => {
  const home = tempHome()
  let called = 0
  const adaptor = adaptorOf({ home, fetchImpl: async () => { called += 1; return okFetch()() } })
  const answer = await adaptor.gate(execOf({ args: { file_path: '/home/dev/.ssh/id_rsa' } }))
  assert.equal(answer.kind, 'deny')
  assert.equal(called, 0)
  await adaptor.close()
  const [record] = linesOf(recordPath(home))
  assert.equal(record.decision, 'deny')
  assert.equal(record.rule_id, 'SECRET_EXFIL')
  rmSync(home, { recursive: true, force: true })
})

test('human-needed becomes an ask with a bilingual display reason', async () => {
  const home = tempHome()
  const adaptor = adaptorOf({ home })
  const answer = await adaptor.gate(execOf({ name: 'write', args: { file_path: '/etc/passwd', content: 'x' } }))
  assert.equal(answer.kind, 'ask')
  assert.equal(typeof answer.reason, 'string')
  assert.equal(typeof answer.displayReason.zh, 'string')
  assert.equal(typeof answer.displayReason.en, 'string')
  assert.equal(answer.displayReason.zh.includes('write'), true)
  await adaptor.close()
  const [record] = linesOf(recordPath(home))
  assert.equal(record.rule_decision, 'human-needed')
  assert.equal(record.decision, 'human-needed')
  rmSync(home, { recursive: true, force: true })
})

test('shadow records the answer it would have given and changes nothing', async () => {
  const home = tempHome()
  const adaptor = adaptorOf({ home, config: { mode: 'shadow' } })
  const answer = await adaptor.gate(execOf({ args: { file_path: '/home/dev/.ssh/id_rsa' } }))
  assert.equal(answer, undefined)
  await adaptor.close()
  const [record] = linesOf(recordPath(home))
  assert.equal(record.decision, 'deny')
  assert.equal(record.mode, 'shadow')
  rmSync(home, { recursive: true, force: true })
})

// ── fail-closed ──────────────────────────────────────────────────────────────────────────

test('a missing token is a local failure: no request, human-needed under enforce', async () => {
  const home = tempHome()
  let called = 0
  const adaptor = adaptorOf({ home, rt: rtOf({ home, secret: undefined }), fetchImpl: async () => { called += 1; return okFetch()() } })
  const answer = await adaptor.gate(execOf({}))
  assert.equal(answer.kind, 'ask')
  assert.equal(called, 0)
  await adaptor.close()
  assert.equal(linesOf(recordPath(home))[0].status, 'unavailable')
  rmSync(home, { recursive: true, force: true })
})

test('a slow engine times out and fails closed; shadow only records it', async () => {
  const hanging = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const home = tempHome()
  const enforced = adaptorOf({ home, timeoutMs: 20, fetchImpl: hanging })
  const answer = await enforced.gate(execOf({}))
  assert.equal(answer.kind, 'ask')
  await enforced.close()
  assert.equal(linesOf(recordPath(home))[0].status, 'timeout')

  const shadowHome = tempHome()
  const shadow = adaptorOf({ home: shadowHome, config: { mode: 'shadow' }, timeoutMs: 20, fetchImpl: hanging })
  assert.equal(await shadow.gate(execOf({})), undefined)
  await shadow.close()
  assert.equal(linesOf(recordPath(shadowHome))[0].status, 'timeout')
  rmSync(home, { recursive: true, force: true })
  rmSync(shadowHome, { recursive: true, force: true })
})

test('a malformed answer is invalid, not an allow', async () => {
  const home = tempHome()
  for (const body of [
    { status: 'ok' },
    { status: 'ok', answers: [{ id: 'decision', choice: 'maybe', probability: 0.9 }, { id: 'outside_scope', probability: 0 }] },
    { status: 'ok', answers: [{ id: 'decision', choice: 'allow', probability: 4 }, { id: 'outside_scope', probability: 0 }] },
    { status: 'unavailable' },
  ]) {
    const answer = readAnswer(body)
    assert.equal(answer.ok, false)
  }
  const adaptor = adaptorOf({ home, fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'ok' }) }) })
  assert.equal((await adaptor.gate(execOf({}))).kind, 'ask')
  await adaptor.close()
  assert.equal(linesOf(recordPath(home))[0].status, 'invalid')
  rmSync(home, { recursive: true, force: true })
})

test('the merge takes the stricter answer and turns a low probability into human-needed', async () => {
  const local = { decision: 'allow', probability: 1 }
  assert.equal(mergeVerdict({ local, answer: { ok: true, verdict: { decision: 'allow', probability: 0.9, outsideScope: 0.1 } }, mode: 'enforce', minConfidence: 0.8 }).decision, 'allow')
  assert.equal(mergeVerdict({ local, answer: { ok: true, verdict: { decision: 'allow', probability: 0.2, outsideScope: 0.1 } }, mode: 'enforce', minConfidence: 0.8 }).decision, 'human-needed')
  assert.equal(mergeVerdict({ local, answer: { ok: true, verdict: { decision: 'allow', probability: 0.99, outsideScope: 0.7 } }, mode: 'enforce', minConfidence: 0.8 }).decision, 'deny')
  // The rule layer cannot be talked down by the engine.
  assert.equal(mergeVerdict({ local: { decision: 'human-needed' }, answer: { ok: true, verdict: { decision: 'allow', probability: 0.99, outsideScope: 0.05 } }, mode: 'enforce', minConfidence: 0.8 }).decision, 'human-needed')
  // A failed judgement is only a pass under shadow.
  assert.equal(mergeVerdict({ local, answer: { ok: false }, mode: 'enforce', minConfidence: 0.8 }).decision, 'human-needed')
  assert.equal(mergeVerdict({ local, answer: { ok: false }, mode: 'shadow', minConfidence: 0.8 }).decision, 'allow')
})

// ── the host's own mode (§4.2, §5.1) ────────────────────────────────────────────────────

test('an unreadable host mode allows only the read-only whitelist and asks about the rest', async () => {
  const home = tempHome()
  let called = 0
  const rt = rtOf({ home, ctx: fakeCtx({ silent: true }), secret: 'token' })
  const adaptor = adaptorOf({ home, rt, fetchImpl: async () => { called += 1; return okFetch()() } })
  assert.deepEqual(hostApprovalMode({ rt, exec: execOf({}) }), { preset: 'unknown', policy: 'unknown', source: 'unknown' })
  assert.equal(await adaptor.gate(execOf({})), undefined)
  assert.equal((await adaptor.gate(execOf({ name: 'write', args: { file_path: `${WORKSPACE}/a.md`, content: 'x' } }))).kind, 'ask')
  assert.equal(called, 0)
  await adaptor.close()
  const records = linesOf(recordPath(home))
  assert.deepEqual(records.map(record => record.status), ['host-unknown', 'host-unknown'])
  assert.equal(READ_ONLY_WHITELIST.has('read'), true)
  rmSync(home, { recursive: true, force: true })
})

test('an Auto Session is left to the host: allowed, not sent, counted as uncovered', async () => {
  const home = tempHome()
  let called = 0
  const rt = rtOf({ home, ctx: fakeCtx({ preset: 'auto', policy: 'ask' }), secret: 'token' })
  const adaptor = adaptorOf({ home, rt, fetchImpl: async () => { called += 1; return okFetch('deny', 0.99)() } })
  assert.equal(await adaptor.gate(execOf({ name: 'write', args: { file_path: '/etc/x', content: 'x' } })), undefined)
  assert.equal(called, 0)
  await adaptor.close()
  const [record] = linesOf(recordPath(home))
  assert.equal(record.status, 'auto-session')
  assert.equal(record.host_preset, 'auto')
  rmSync(home, { recursive: true, force: true })
})

test('a Session outside the company is not judged and not recorded', async () => {
  const home = tempHome()
  const rt = rtOf({ home, botOwner: {} })
  const adaptor = adaptorOf({ home, rt })
  assert.equal(await adaptor.gate(execOf({ sessionId: 'someone_else' })), undefined)
  assert.equal(await adaptor.gate(execOf({ name: 'run_code', args: {} , parent: undefined })), undefined)
  await adaptor.close()
  assert.deepEqual(readdirSync(home), [])
  rmSync(home, { recursive: true, force: true })
})

// ── the record ───────────────────────────────────────────────────────────────────────────

test('a record carries the planned fields, a digest, and no argument value', async () => {
  const home = tempHome()
  const adaptor = adaptorOf({ home })
  const secret = 'sk-live-abcdef1234567890'
  await adaptor.gate(execOf({ name: 'write', args: { file_path: `${WORKSPACE}/a.md`, content: secret } }))
  await adaptor.close()
  const raw = readFileSync(recordPath(home), 'utf8')
  const [record] = linesOf(recordPath(home))
  for (const field of RECORD_FIELDS) assert.equal(field in record, true, `missing ${field}`)
  assert.equal(record.answered_actor, 'unknown')
  assert.equal(record.root_call_id, 'call_1')
  assert.equal(record.host_policy, 'ask')
  assert.equal(record.request_id, 'sr_call_1')
  assert.equal(raw.includes(secret), false)
  assert.equal(raw.includes('content'), false)
  assert.match(record.operation_fingerprint, /^sha256:[0-9a-f]{64}$/)
  rmSync(home, { recursive: true, force: true })
})

test('the parameter summary hides secret values and keeps the shape short', () => {
  const { parameters, truncated } = summarizeArguments({ token: 'abc', content: 'x'.repeat(500), nested: { a: 1 }, list: [1, 2, 3], count: 3 }, {})
  assert.equal(parameters.token.preview, '[hidden]')
  assert.equal(parameters.content.preview.length, 200)
  assert.equal(parameters.nested.preview, '{…}')
  assert.equal(parameters.list.type, 'array[3]')
  assert.equal(parameters.count.preview, '3')
  assert.equal(truncated, true)
})

test('the request matches §3.2 and its state stays under 2KB', () => {
  const state = companyState()
  const rt = rtOf({ home: '/tmp/unused', state, secret: 'token' })
  const exec = execOf({ name: 'bash', args: { command: 'npm test' } })
  const scope = resolveScope({ rt, exec })
  assert.equal(scope.project.id, 'proj')
  assert.equal(scope.workspaceRef, WORKSPACE)
  const local = classify({ tool: exec.name, args: exec.arguments, scope, base: scope.base })
  const request = buildRequest({ exec, scope, local, host: { preset: 'ask', policy: 'ask', source: 'read' }, config: normalizeConfig({ mode: 'shadow' }) })
  assert.equal(request.schema_version, '1')
  assert.equal(request.request_id, 'sr_call_1')
  assert.equal(request.project_id, 'proj')
  assert.equal(request.task_id, null)
  assert.equal(request.run_id, null)
  assert.equal(request.actor.bot_id, 'bot_a')
  assert.equal(request.actor.employee_id, 'emp')
  assert.equal(request.effective_authorization_scope.workspace_ref, WORKSPACE)
  assert.equal(request.questions.length, 2)
  assert.equal(request.questions[0].id, 'decision')
  assert.equal(request.host_approval_mode.preset, 'ask')
  assert.equal(Buffer.byteLength(request.state, 'utf8') <= 2048, true)
  assert.equal(request.policy_version, 'sr-2026-11-03.1')
})

test('a call from another project group is a scope breach', async () => {
  const home = tempHome()
  const groups = new Map([['sess_other', { botId: 'bot_a', roomId: 'room_other' }]])
  const rt = rtOf({ home, groups, secret: 'token' })
  const adaptor = adaptorOf({ home, rt })
  const answer = await adaptor.gate(execOf({ sessionId: 'sess_other' }))
  assert.equal(answer.kind, 'deny')
  await adaptor.close()
  assert.equal(linesOf(recordPath(home))[0].rule_id, 'SCOPE_VIOLATION')
  rmSync(home, { recursive: true, force: true })
})

test('an unreadable company file leaves the call unjudged', () => {
  const rt = rtOf({ home: '/tmp/unused', secret: 'token' })
  rt.companyStore = { byBotId: () => { throw new Error('state is broken') } }
  assert.equal(resolveScope({ rt, exec: execOf({}) }), undefined)
})

test('the recorder rotates at its size limit and keeps the planned depth', async () => {
  const home = tempHome()
  const recorder = createRecorder({ dir: join(home, 'company'), maxBytes: 200, keep: 2 })
  for (let index = 0; index < 12; index += 1) recorder.write({ index, pad: 'x'.repeat(40) })
  await recorder.flush()
  const files = readdirSync(join(home, 'company')).sort()
  assert.equal(files.includes('selfreview.jsonl'), true)
  assert.equal(files.includes('selfreview.jsonl.1'), true)
  assert.equal(files.includes('selfreview.jsonl.2'), true)
  assert.equal(files.includes('selfreview.jsonl.3'), false)
  assert.equal(recorder.stats().written, 12)
  rmSync(home, { recursive: true, force: true })
})

test('makeRecord keeps a stable shape when there is no engine answer', () => {
  const record = makeRecord({
    request: { request_id: 'sr_c1', project_id: 'proj' },
    local: { decision: 'human-needed', rule_id: 'WRITE_OUTSIDE', policy_hits: ['WRITE_OUTSIDE'] },
    mode: 'enforce',
    status: 'host-unknown',
    latencyMs: 3.4,
    host: { preset: 'ask', policy: 'never' },
    call: { callId: 'c1', rootCallId: 'c0' },
  })
  assert.equal(record.model_id, null)
  assert.equal(record.decision, 'human-needed')
  assert.equal(record.latency_ms, 3)
  assert.equal(record.call_id, 'c1')
  assert.equal(record.root_call_id, 'c0')
  assert.equal(record.task_id, null)
})

// ── the host outcome (§6.2) ─────────────────────────────────────────────────────────────

const call = (extra = {}) => ({ type: 'tool/call', callId: 'c1', ...extra })
const asked = (extra = {}) => ({ type: 'approval/asked', callId: 'c1', approvalId: 'a1', ...extra })
const decided = (outcome, extra = {}) => ({ type: 'approval/decided', callId: 'c1', approvalId: 'a1', outcome, ...extra })
const result = (isError = false, text) => ({ type: 'tool/result', callId: 'c1', isError, text })

test('the projection reads the host side in the planned priority order', () => {
  const project = (events, options = {}) => projectHostOutcome({ callId: 'c1', events, ...options })
  assert.equal(project([call(), asked(), decided('allowed-once'), result(false)], { policy: 'ask' }).outcome, 'approved-by-human')
  assert.equal(project([call(), asked(), decided('rejected'), result(true, 'the user rejected tool "write"')], { policy: 'ask' }).outcome, 'rejected-by-human')
  assert.equal(project([call(), asked(), decided('rejected'), result(true, 'Error: requires approval, but no approval channel is available')], { policy: 'never' }).outcome, 'rejected-by-policy')
  assert.equal(project([call(), asked(), decided('unavailable')], { policy: 'ask' }).outcome, 'unavailable')
  assert.equal(project([call(), asked(), decided('cancelled')], { policy: 'ask' }).outcome, 'unavailable')
  assert.equal(project([call(), asked()], { policy: 'ask' }).outcome, 'unobservable')
  assert.equal(project([call(), asked(), decided('allowed-once')], { policy: 'unknown' }).outcome, 'unobservable')
  assert.equal(project([call(), result(false)]).outcome, 'allowed-by-policy')
  assert.equal(project([call(), result(true, 'requires approval, but the call has no agent to route it through')]).outcome, 'unavailable')
  assert.equal(project([call(), result(true, 'the user rejected tool "write"')]).outcome, 'unobservable')
  assert.equal(project([call(), result(true, 'boom')]).outcome, 'failed-execution')
  assert.equal(project([call()]).outcome, 'unobservable')
  assert.equal(project([]).outcome, 'unobservable')
  // A product deny is the first branch, whatever the host did afterwards.
  assert.equal(project([call(), result(false)], { product: { decision: 'deny' } }).outcome, 'rejected-by-policy')
})

test('the execution result separates a refusal from a failure', () => {
  const executed = (events, options = {}) => projectHostOutcome({ callId: 'c1', events, ...options }).execution_result
  assert.equal(executed([call()]), 'not-attempted')
  assert.equal(executed([call(), result(false)]), 'succeeded')
  assert.equal(executed([call(), asked(), decided('rejected'), result(true, 'the user rejected tool "write"')], { policy: 'ask' }), 'failed(denied)')
  assert.equal(executed([call(), result(true, 'the command failed')]), 'failed(execution)')
})

test('only the isolated 0f card may be called human', () => {
  const events = [call(), asked(), decided('allowed-once'), result(false)]
  assert.equal(projectHostOutcome({ callId: 'c1', events, policy: 'ask' }).authorizer, 'unknown')
  assert.equal(projectHostOutcome({ callId: 'c1', events, policy: 'ask', isolated: true }).authorizer, 'human')
  assert.equal(projectHostOutcome({ callId: 'c1', events: [call(), result(false)], preset: 'auto' }).authorizer, 'auto')
  assert.equal(projectHostOutcome({ callId: 'c1', events: [call(), result(true, 'boom')], preset: 'auto' }).authorizer, 'unknown')
})

test('projectEvents joins the product records by call id', () => {
  const events = [
    { type: 'tool/call', callId: 'c1' },
    { type: 'tool/result', callId: 'c1', isError: false },
    { type: 'tool/call', callId: 'c2' },
    { type: 'tool/result', callId: 'c2', isError: true, text: 'boom' },
  ]
  assert.equal(groupEvents(events).size, 2)
  const rows = projectEvents({ events, products: [{ call_id: 'c2', decision: 'deny' }] })
  assert.deepEqual(rows.map(row => row.outcome), ['allowed-by-policy', 'rejected-by-policy'])
  assert.deepEqual(rows.map(row => row.product_decision), [null, 'deny'])
})

// ── the stub over HTTP ───────────────────────────────────────────────────────────────────

const stubEnv = token => ({
  ...process.env,
  DSH_SECRET_SELFREVIEW_TOKEN: token,
  DSH_SELFREVIEW_PORT: '0',
})

async function startStub({ token = 'test-token', env = {} } = {}) {
  const child = spawn(process.execPath, ['dev/selfreview-stub.mjs'], {
    cwd: DS_BOT_DIR,
    env: { ...stubEnv(token), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const port = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`stub did not start: ${out}`)), 10_000)
    child.stdout.on('data', (chunk) => {
      out += chunk
      const match = out.match(/http:\/\/127\.0\.0\.1:(\d+)/)
      if (match !== null) {
        clearTimeout(timer)
        resolve(Number(match[1]))
      }
    })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`stub exited with ${code}: ${out}`)) })
  })
  return { child, base: `http://127.0.0.1:${port}`, port }
}

const request = {
  tool: 'read',
  parameters: { file_path: { type: 'string', preview: `${WORKSPACE}/README.md` } },
  effective_authorization_scope: { workspace_ref: WORKSPACE, project_status: 'active' },
  arguments_truncated: false,
}

test('the stub answers health, refuses a wrong token, and replays the rule table', async () => {
  const token = 'stub-shared-token'
  const stub = await startStub({ token })
  try {
    const health = await fetch(`${stub.base}/healthz`)
    assert.equal(health.status, 200)
    assert.equal((await health.json()).status, 'ok')
    assert.equal((await fetch(`${stub.base}/health`)).status, 200)

    const denied = await fetch(`${stub.base}/v1/systemone`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: JSON.stringify(request) })
    assert.equal(denied.status, 401)

    const allowed = await fetch(`${stub.base}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.equal(allowed.status, 200)
    const answer = await allowed.json()
    assert.equal(answer.status, 'ok')
    assert.equal(answer.model_id, 'rules-stub')
    assert.equal(answer.answers[0].choice, 'allow')

    const secret = await fetch(`${stub.base}/v1/systemone`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, parameters: { file_path: { type: 'string', preview: '/home/dev/.ssh/id_rsa' } } }),
    })
    const secretAnswer = await secret.json()
    assert.equal(secretAnswer.answers[0].choice, 'deny')
    assert.deepEqual(secretAnswer.policy_hits, ['SECRET_EXFIL'])

    assert.equal((await fetch(`${stub.base}/nowhere`)).status, 404)
    assert.equal((await fetch(`${stub.base}/v1/systemone`, { headers: { authorization: `Bearer ${token}` } })).status, 405)
    const badJson = await fetch(`${stub.base}/v1/systemone`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{' })
    assert.equal(badJson.status, 400)
  } finally {
    stub.child.kill('SIGTERM')
  }
})

test('the adaptor and the stub agree end to end over loopback', async () => {
  const token = 'end-to-end-token'
  const stub = await startStub({ token })
  const home = tempHome()
  try {
    const adaptor = adaptorOf({
      home,
      config: { mode: 'shadow', endpoint: stub.base, tokenSecret: 'SELFREVIEW_TOKEN' },
      rt: rtOf({ home, secret: token }),
      fetchImpl: undefined,
    })
    // `fetchImpl` is undefined, so the client uses the host's fetch and really speaks HTTP.
    assert.equal(await adaptor.gate(execOf({})), undefined)
    await adaptor.close()
    const [record] = linesOf(recordPath(home))
    assert.equal(record.status, 'ok')
    assert.equal(record.decision, 'allow')
    assert.equal(record.model_id, 'rules-stub')
    assert.equal(record.rule_decision, 'allow')
  } finally {
    stub.child.kill('SIGTERM')
    rmSync(home, { recursive: true, force: true })
  }
})

test('the client fails locally when the token or the endpoint is missing', async () => {
  let called = 0
  const fetchImpl = async () => { called += 1; return { ok: true, json: async () => ({}) } }
  assert.equal((await judge({ endpoint: 'http://127.0.0.1:1', token: undefined, request, fetchImpl })).status, 'unavailable')
  assert.equal((await judge({ endpoint: '', token: 'x', request, fetchImpl })).status, 'unavailable')
  assert.equal(called, 0)
  // A non-2xx answer is unavailable, not a silent allow.
  const refused = await judge({ endpoint: 'http://127.0.0.1:1', token: 'x', request, fetchImpl: async () => ({ ok: false, status: 502 }) })
  assert.equal(refused.status, 'unavailable')
})
