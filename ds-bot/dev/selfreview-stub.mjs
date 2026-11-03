#!/usr/bin/env node
// The M1b-0 judgement stand-in: a local HTTP process that answers /v1/systemone from the very
// rule table the adaptor already has in `src/host/company/selfreview/rules.js`.
//
// It exists so the adapter, the records and the shadow run can be exercised end to end before a
// real engine is available. It is not a model: it replays the same deterministic rules, which
// means a disagreement between the record's `rule_decision` and `decision` can only come from
// the request path, never from the stub's judgement. M1b-0 therefore claims a pilot, not R5.
//
//   DSH_SECRET_SELFREVIEW_TOKEN   required; the same value the plugin reads from its secrets
//   DSH_SELFREVIEW_PORT           optional, defaults to 7361
//   DSH_SELFREVIEW_HOST           optional, must stay a loopback address
//
// Run: node dev/selfreview-stub.mjs
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { HIGH_RISK_RULES, classify } from '../src/host/company/selfreview/rules.js'

const TOKEN_NAMES = ['DSH_SECRET_SELFREVIEW_TOKEN', 'SELFREVIEW_TOKEN']
const DEFAULT_PORT = 7361
const DEFAULT_HOST = '127.0.0.1'
const BODY_MAX_BYTES = 256 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

const token = TOKEN_NAMES.map(name => process.env[name]).find(value => typeof value === 'string' && value !== '')
if (token === undefined) {
  process.stderr.write(`selfreview stub: set ${TOKEN_NAMES[0]} to the shared token; refusing to start without one.\n`)
  process.exitCode = 2
  throw new Error('missing token')
}

const host = process.env.DSH_SELFREVIEW_HOST ?? DEFAULT_HOST
if (!LOOPBACK.has(host)) {
  process.stderr.write(`selfreview stub: ${host} is not a loopback address; the stub only listens locally.\n`)
  process.exitCode = 2
  throw new Error('non-loopback host')
}

const port = Number(process.env.DSH_SELFREVIEW_PORT ?? DEFAULT_PORT)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('selfreview stub: DSH_SELFREVIEW_PORT is not a port number.\n')
  process.exitCode = 2
  throw new Error('bad port')
}

const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const expected = Buffer.from(`Bearer ${token}`, 'utf8')

const authorized = (header) => {
  if (typeof header !== 'string') return false
  const given = Buffer.from(header, 'utf8')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const reply = (response, status, body) => {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

// The request carries argument previews, not the arguments; the rules are replayed on exactly
// what a judge would see, so the stub cannot be more informed than the real engine will be.
const argumentsOf = (parameters) => {
  const args = {}
  if (parameters === null || typeof parameters !== 'object') return args
  for (const [key, entry] of Object.entries(parameters)) {
    if (entry !== null && typeof entry === 'object' && typeof entry.preview === 'string') args[key] = entry.preview
  }
  return args
}

const scopeOf = (request) => {
  const workspaceRef = request?.effective_authorization_scope?.workspace_ref
  return {
    workspaceRef: typeof workspaceRef === 'string' ? workspaceRef : undefined,
    projectStatus: request?.effective_authorization_scope?.project_status ?? undefined,
    foreignWorkspaces: [],
  }
}

const bodyText = (request) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  request.on('data', (chunk) => {
    size += chunk.length
    if (size > BODY_MAX_BYTES) {
      reject(new Error('body-too-large'))
      request.destroy()
      return
    }
    chunks.push(chunk)
  })
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  request.on('error', reject)
})

// A request whose arguments arrived as previews leaves too little to replay: the adaptor sends
// a shell call as its first word, and the stub cannot pretend to re-derive the rest. In that
// case it answers from the rule hint the adaptor attached, and says so by keeping the rule id.
const hinted = (request) => {
  const hint = request?.rule_hint
  if (hint === null || typeof hint !== 'object') return undefined
  if (!['allow', 'deny', 'human-needed'].includes(hint.decision)) return undefined
  const ruleId = typeof hint.rule_id === 'string' ? hint.rule_id : 'UNKNOWN_TOOL'
  return {
    decision: hint.decision,
    rule_id: ruleId,
    policy_hits: [ruleId],
    probability: hint.decision === 'allow' ? 1 : 0.9,
    risk_tier: HIGH_RISK_RULES.includes(ruleId) || hint.sensitive_flag === true ? 'high' : hint.decision === 'allow' ? 'low' : 'medium',
    sensitive_flag: hint.sensitive_flag === true,
    target: typeof hint.target === 'string' ? hint.target : undefined,
  }
}

const judge = (request) => {
  const tool = typeof request?.tool === 'string' ? request.tool : ''
  const scope = scopeOf(request)
  const replayed = request?.arguments_truncated === true ? hinted(request) : undefined
  const verdict = replayed ?? classify({ tool, args: argumentsOf(request?.parameters), scope, base: scope.workspaceRef, truncated: request?.arguments_truncated === true })
  const outsideScope = verdict.rule_id === 'SCOPE_VIOLATION' ? 0.9 : verdict.decision === 'deny' ? 0.2 : 0.05
  return {
    status: 'ok',
    model_id: 'rules-stub',
    model_version: 'sr-2026-11-03.1',
    input_digest: sha256(JSON.stringify(request ?? null)),
    answers: [
      { id: 'decision', choice: verdict.decision, probability: verdict.probability },
      { id: 'outside_scope', probability: outsideScope },
    ],
    predicted_risk_tier: verdict.risk_tier,
    // The stub never claims to know who authorized a call; the projection decides that.
    authorizer: 'none',
    policy_hits: verdict.policy_hits ?? [verdict.rule_id],
    evaluated_at: new Date().toISOString(),
  }
}

const started = Date.now()

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/healthz' || url.pathname === '/health') {
    return reply(response, 200, { status: 'ok', model_id: 'rules-stub', uptime_ms: Date.now() - started })
  }
  if (url.pathname !== '/v1/systemone') return reply(response, 404, { status: 'error', detail: 'not-found' })
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    return reply(response, 405, { status: 'error', detail: 'method' })
  }
  if (!authorized(request.headers.authorization)) return reply(response, 401, { status: 'error', detail: 'unauthorized' })
  let body
  try {
    body = JSON.parse(await bodyText(request))
  } catch (error) {
    return reply(response, error instanceof Error && error.message === 'body-too-large' ? 413 : 400, { status: 'invalid', detail: 'json' })
  }
  return reply(response, 200, judge(body))
})

server.listen(port, host, () => {
  const address = server.address()
  const bound = typeof address === 'object' && address !== null ? `${host}:${address.port}` : `${host}:${port}`
  process.stdout.write(`selfreview stub listening on http://${bound}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
