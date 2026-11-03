// The rule layer: one deterministic reading of a tool call, shared by the judgement stub
// (dev/selfreview-stub.mjs) and the adaptor's local guard. Sharing one table is the point —
// the stub and the adaptor classify the same call the same way, so a shadow record can be
// read next to the engine's answer without a second implementation drifting away, and a
// missing engine still fails closed on the same conservative reading.
//
// Nothing here reads a file, calls a model or looks at the clock. The input is the tool name,
// its arguments (or the truncated previews the adaptor sends), and the authorization scope;
// the output is one of the three answers the host understands. §3.5 of the M1b plan is the
// table this implements: `READ_ONLY` and `WRITE_INSIDE` allow, the high-risk classes ask a
// human, and credentials or a scope breach are denied outright.
import { isAbsolute, resolve } from 'node:path'

/** The three answers the judgement layer may give, in the order the questions ask for them. */
export const DECISIONS = Object.freeze(['allow', 'deny', 'human-needed'])

/** Rules that mark a call as sensitive. §8.1 `d3` recomputes the same six classes locally. */
export const HIGH_RISK_RULES = Object.freeze([
  'WRITE_OUTSIDE',
  'IRREVERSIBLE_DELETE',
  'PRODUCTION',
  'EXTERNAL_SEND',
  'PAYMENT',
  'SECRET_EXFIL',
])

const ALLOW = 'allow'
const DENY = 'deny'
const HUMAN = 'human-needed'
const INACTIVE_PROJECT = new Set(['archived', 'closed', 'cancelled', 'completed'])

// Tools that only read: the workspace, a Session log, the roster, or the open Web. Their
// answer is allow unless the target itself is a credential file.
const READ_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep',
  'read_own_chat', 'read_group_chat', 'read_browser',
  'recall', 'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'list_agents', 'list_bots', 'list_bot_models', 'list_capabilities', 'list_secrets',
  'schedule_list', 'job_list', 'job_output', 'team_task_list', 'team_task_get',
  'search_context', 'decompress', 'skill', 'web_search', 'web_fetch',
  'acp_status', 'acp_cache', 'acp_read_original_image',
])

// The file tools, with the argument that names their target.
const WRITE_TOOLS = new Map([
  ['write', 'file_path'],
  ['edit', 'file_path'],
  ['str_replace_editor', 'path'],
])

const SHELL_TOOLS = new Set(['bash', 'pwsh'])

// Control-plane tools: they change the team's own records — a task, a schedule, a Bot's
// settings — but neither write the project workspace nor leave the machine. Judging them as
// unknown would drown the seed set in asks that no one can act on.
const INTERNAL_TOOLS = new Set([
  'message_bot', 'send_message', 'post_to_group', 'group_relay', 'present', 'show_view', 'ask_user',
  'todo_write', 'remember', 'forget', 'request_secret', 'update_bot', 'create_bot', 'create_group',
  'update_group', 'save_capability', 'attach_capability', 'detach_capability', 'create_worktree',
  'stop_bot', 'interrupt_agent', 'spawn_teammate', 'subagent', 'subagent_fork', 'workflow',
  'compress', 'job_kill', 'schedule_create', 'schedule_update', 'schedule_delete',
  'team_task_create', 'team_task_update',
])

// Deleting a team object is not a file edit: the object is gone for good.
const DELETE_TOOLS = new Set(['delete_group', 'delete_capability', 'delete_bot'])

// Credential shapes. The rule is about the target, not about words in the command: a path
// that names key material is never read, copied or shipped without a human.
const SECRET_PATH = new RegExp([
  '(^|/)(\\.ssh|\\.aws|\\.gnupg|\\.docker/config\\.json|\\.npmrc|\\.netrc|\\.git-credentials|\\.kube)(/|$)',
  '(^|/)(id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)(\\.|/|$)',
  '\\.(pem|key|p12|pfx|kdbx|jks)$',
  '(^|/)\\.env(\\.|$)',
].join('|'))

const PRODUCTION_PATH = /(^|[/_.-])(prod|production)([/_.-]|$)|(^|\/)deploy(ments?)?(\/|$)/

// Shell vocabulary. The sets are deliberately short: anything not listed is unknown, and
// unknown asks a human instead of guessing.
const SHELL_READ = new Set([
  'ls', 'll', 'pwd', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'file', 'stat', 'tree', 'du', 'df',
  'ps', 'whoami', 'id', 'uname', 'sw_vers', 'date', 'echo', 'printf', 'which', 'type', 'command',
  'realpath', 'basename', 'dirname', 'rg', 'grep', 'egrep', 'fgrep', 'fd', 'find', 'diff', 'cmp',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'sed', 'awk', 'true', 'false', 'test', '[', 'wc',
])

// Commands that write: their non-flag words are checked against the authorized workspace.
const SHELL_WRITE = new Set([
  'cp', 'mv', 'install', 'mkdir', 'touch', 'chmod', 'chown', 'ln', 'tee', 'dd', 'patch',
  'unzip', 'zip', 'tar', 'gzip', 'gunzip', 'npm', 'pnpm', 'yarn', 'npx', 'pip', 'pip3',
  'poetry', 'uv', 'cargo', 'go', 'make', 'cmake', 'ninja', 'docker', 'podman', 'brew',
])

const SHELL_DELETE = new Set(['rm', 'rmdir', 'unlink', 'shred', 'truncate'])

const SHELL_EXTERNAL = new Set([
  'curl', 'wget', 'nc', 'netcat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'mail', 'sendmail',
  'aws', 'gcloud', 'az', 'open', 'osascript',
])

const SHELL_PAYMENT = new Set(['stripe', 'paypal', 'square', 'braintree', 'checkout', 'billing', 'purchase'])

const SHELL_PRODUCTION = new Set(['kubectl', 'helm', 'terraform', 'ansible', 'systemctl', 'launchctl', 'pm2', 'deploy'])

const SHELL_WRAPPERS = new Set(['sudo', 'command', 'time', 'nohup', 'exec', 'builtin', 'nice'])

// A command may not be read safely: substitution, here-documents and eval can build a
// different command than the one the words spell.
const SHELL_OPAQUE = /\$\(|`|<<[^-]|\beval\b|\bxargs\b|\b(?:sh|bash|zsh|fish)\s+-c\b/

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'blame', 'ls-files', 'ls-tree', 'config', 'remote', 'branch'])
const GIT_DELETE = new Set(['clean', 'rm', 'prune'])
const GIT_EXTERNAL = new Set(['push', 'fetch', 'pull', 'clone', 'submodule', 'lfs'])

const text = value => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined)
// A resolved path carries the host's separator; the shapes below are written with `/` so the
// same rule reads the same on every platform.
const slashed = value => (typeof value === 'string' ? value.replace(/\\/g, '/') : value)
const isSecretPath = value => SECRET_PATH.test(slashed(value))
const isProductionPath = value => PRODUCTION_PATH.test(slashed(value))
const unquote = value => value.replace(/^['"]|['"]$/g, '')
const cleanPath = value => unquote(value.trim())
const trimmed = (value) => {
  const path = slashed(value)
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}
// Both sides are compared with `/` and without a trailing separator, so one authorization scope
// reads the same on every platform and with either separator in it.
export const insidePath = (inner, outer) => {
  if (typeof inner !== 'string' || typeof outer !== 'string' || outer === '') return false
  const a = trimmed(inner)
  const b = trimmed(outer)
  return a === b || a.startsWith(`${b}/`)
}
const absolute = (value, base) => {
  if (typeof value !== 'string') return undefined
  const raw = cleanPath(value)
  if (raw === '' || raw === '-') return undefined
  if (isAbsolute(raw)) return resolve(raw)
  return base === undefined ? undefined : resolve(base, raw)
}

// The target a record shows and the engine sees: the file path, the command's first word, or
// the endpoint — never a whole argument.
const targetOf = ({ tool, args, base }) => {
  const key = WRITE_TOOLS.get(tool)
  if (key !== undefined) return absolute(text(args?.[key]), base) ?? tool
  const path = absolute(text(args?.path), base) ?? absolute(text(args?.file_path), base)
  if (path !== undefined) return path
  const command = text(args?.command)
  if (command !== undefined) return command.trim().split(/\s+/).slice(0, 2).join(' ')
  return tool
}

const verdict = (rule, decision, { policyHits = [rule], probability = 1, target, reason } = {}) => ({
  decision,
  rule_id: rule,
  policy_hits: policyHits,
  probability,
  risk_tier: decision === DENY ? 'high' : decision === HUMAN ? 'medium' : 'low',
  sensitive_flag: decision !== ALLOW || HIGH_RISK_RULES.includes(rule),
  ...(target === undefined ? {} : { target }),
  ...(reason === undefined ? {} : { reason }),
})

// A verdict from the findings of one shell command, in the plan's priority order: credentials
// and scope breaches stop the call, the high-risk classes ask, and only a fully understood
// read or an in-workspace write is allowed.
const decideShell = (found) => {
  const hits = []
  const push = list => { for (const rule of list) if (!hits.includes(rule)) hits.push(rule) }
  if (found.secret) push(['SECRET_EXFIL'])
  if (found.violations) push(['SCOPE_VIOLATION'])
  if (found.deletes) push(['IRREVERSIBLE_DELETE'])
  if (found.productions) push(['PRODUCTION'])
  if (found.payments) push(['PAYMENT'])
  if (found.externals) push(['EXTERNAL_SEND'])
  if (found.outside) push(['WRITE_OUTSIDE'])
  if (found.inside) push(['WRITE_INSIDE'])
  if (found.reads) push(['READ_ONLY'])
  const target = found.target
  if (hits.includes('SECRET_EXFIL') || hits.includes('SCOPE_VIOLATION')) return verdict(hits[0], DENY, { policyHits: hits, target, reason: 'The call touches credentials or leaves the authorized scope.' })
  if (found.unknown !== undefined) return verdict('UNKNOWN_EFFECT', HUMAN, { policyHits: hits, probability: 0.6, target, reason: found.unknown })
  if (hits.some(rule => HIGH_RISK_RULES.includes(rule))) return verdict(hits.find(rule => HIGH_RISK_RULES.includes(rule)), HUMAN, { policyHits: hits, probability: 0.6, target })
  if (hits.includes('WRITE_INSIDE')) return verdict('WRITE_INSIDE', ALLOW, { policyHits: hits, target })
  if (hits.includes('READ_ONLY')) return verdict('READ_ONLY', ALLOW, { policyHits: hits, target })
  return verdict('UNKNOWN_EFFECT', HUMAN, { target, reason: 'The command could not be classified.' })
}

// One shell segment's words, with `sudo`/`env VAR=…` noise removed. A bare `env` stays: it
// prints the environment, which is a credential dump rather than a wrapper.
const wordsOf = (segment) => {
  const words = (segment.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? []).map(unquote)
  let at = 0
  while (at < words.length) {
    const word = words[at]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { at += 1; continue }
    if (word === 'env') {
      const rest = words.slice(at + 1)
      if (rest.some(entry => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(entry))) { at += 1; continue }
      break
    }
    if (SHELL_WRAPPERS.has(word)) { at += 1; continue }
    break
  }
  return words.slice(at)
}

const segmentsOf = command => command.split(/&&|\|\||[;|\n]/).map(segment => segment.trim()).filter(Boolean)

// Redirect targets: `> out`, `>> out`, `2> err`. Device files are not workspace writes.
const redirectsOf = (segment) => {
  const targets = []
  for (const match of segment.matchAll(/(?:^|\s)\d*(>>?)\s*([^\s;&|]+)/g)) {
    const value = cleanPath(match[2])
    if (value.startsWith('/dev/') || value === '&1' || value === '&2') continue
    targets.push(value)
  }
  return targets
}

// The scope arrives from company state, where the folder is an absolute host path. Resolving it
// once keeps the comparison honest when the host separator differs from the one in the record.
const authorizedScope = (scope) => {
  const resolved = value => (typeof value === 'string' && value.trim() !== '' ? resolve(value) : undefined)
  const foreign = (scope.foreignWorkspaces ?? []).map(resolved).filter(value => value !== undefined)
  return { ...scope, workspaceRef: resolved(scope.workspaceRef), foreignWorkspaces: foreign }
}

const pathWordsOf = words => words.filter(word => !word.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))

// Reading tools that can write or run another program: `find -exec`, `sort -o`, an awk program
// that calls `system`, a sed `-i`. A command that observes and acts is no longer a read.
const readSideEffect = (head, rest) => {
  const line = rest.join(' ')
  if (head === 'find') {
    return rest.some(word => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fls', '-fprint', '-fprint0', '-fprintf'].includes(word))
      || /\s-delete(\s|$)/.test(` ${line} `)
  }
  if (head === 'sort') return rest.some(word => word === '-o' || word === '--output' || word.startsWith('--output=') || /^-o./.test(word))
  if (head === 'awk' || head === 'gawk' || head === 'mawk' || head === 'nawk') {
    return /system\s*\(|print(?:f)?[^;|]*>|&>|\|\s*(?:"|')/.test(line)
  }
  if (head === 'sed') return /--in-place|\bsystem\s*\(|(?:^|[\s'"])(?:e|w)\s+[^\s'"]+/.test(line)
  return false
}

// Classify one shell command. `scope.workspaceRef` is the authorized project folder; a word
// that names a path resolves against the Session's folder first, as the shell would.
const classifyShell = ({ command, base, scope }) => {
  const found = { secret: false, violations: false, deletes: false, productions: false, payments: false, externals: false, inside: false, outside: false, reads: false, unknown: undefined, target: undefined }
  const workspace = scope.workspaceRef
  const foreign = scope.foreignWorkspaces ?? []
  const writePath = (value) => {
    const path = absolute(value, base)
    if (path === undefined) { found.unknown ??= 'The command writes, but its target could not be resolved.'; return }
    found.target ??= path
    if (isSecretPath(path)) found.secret = true
    if (isProductionPath(path)) found.productions = true
    if (foreign.some(outer => insidePath(path, outer))) found.violations = true
    else if (insidePath(path, workspace)) found.inside = true
    else found.outside = true
  }
  if (SHELL_OPAQUE.test(command)) found.unknown = 'The command builds its own command line (substitution, here-document or eval).'
  for (const segment of segmentsOf(command)) {
    for (const target of redirectsOf(segment)) writePath(target)
    const words = wordsOf(segment)
    if (words.length === 0) continue
    const head = words[0]
    const rest = words.slice(1)
    const paths = pathWordsOf(rest)
    found.target ??= head
    if (SHELL_PAYMENT.has(head)) found.payments = true
    else if (SHELL_PRODUCTION.has(head)) found.productions = true
    else if (SHELL_DELETE.has(head)) found.deletes = true
    else if (SHELL_EXTERNAL.has(head)) found.externals = true
    else if (head === 'git') {
      const sub = rest[0]
      if (sub === undefined) found.reads = true
      else if (GIT_EXTERNAL.has(sub)) found.externals = true
      else if (GIT_DELETE.has(sub)) found.deletes = true
      else if (GIT_READ.has(sub)) found.reads = true
      else found.writes = true
      if (sub === 'reset' && rest.includes('--hard')) found.deletes = true
    } else if (SHELL_WRITE.has(head)) {
      // No path words at all (`npm install`, `make`) work in the folder the command runs in.
      if (paths.length === 0) writePath(base ?? workspace ?? '.'); else for (const path of paths) writePath(path)
    } else if (SHELL_READ.has(head)) {
      if (head === 'sed' && rest.some(word => /^-[a-zA-Z]*i/.test(word))) { for (const path of paths) writePath(path) }
      else if (readSideEffect(head, rest)) {
        // A read command carrying a write or an exec flag is not a read: it becomes unknown, and
        // unknown asks a human (B2 in the r1 review).
        found.unknown ??= `The read command "${head}" can write or run another program.`
      } else found.reads = true
      if (head === 'find' && rest.includes('-delete')) found.deletes = true
      for (const path of paths) if (isSecretPath(path) && ['cat', 'head', 'tail', 'less', 'more', 'cp', 'scp', 'rsync', 'tee', 'grep', 'rg'].includes(head)) found.secret = true
    } else if (head === 'env' || head === 'printenv') {
      found.secret = true
    } else {
      found.unknown ??= `The command "${head}" is not in the rule table.`
    }
    for (const word of paths) if (isSecretPath(word)) found.secret = true
    if (paths.some(word => isProductionPath(word))) found.productions = true
  }
  if (!found.target) found.target = segmentsOf(command)[0]
  return decideShell(found)
}

/**
 * Classify one tool call.
 *
 * @param {object} input
 * @param {string} input.tool        the tool's name, as the host reports it
 * @param {object} [input.args]      its arguments, or truncated previews of them
 * @param {object} [input.scope]     `{ workspaceRef, projectStatus, member, foreignWorkspaces }`
 * @param {string} [input.base]      the folder relative arguments resolve against
 * @param {boolean} [input.truncated] true when the arguments are previews, not the real values
 * @returns {{decision: string, rule_id: string, policy_hits: string[], probability: number,
 *   risk_tier: string, sensitive_flag: boolean, target?: string, reason?: string}}
 */
export function classify({ tool, args = {}, scope = {}, base, truncated = false }) {
  const target = targetOf({ tool, args, base })
  const authorized = authorizedScope(scope)
  if (typeof tool !== 'string' || tool === '') return verdict('UNKNOWN_TOOL', HUMAN, { target: 'unknown', reason: 'The call has no tool name.' })
  if (INACTIVE_PROJECT.has(scope.projectStatus)) return verdict('SCOPE_VIOLATION', DENY, { target, reason: `Project ${scope.projectStatus} is not open.` })
  if (scope.member === false) return verdict('SCOPE_VIOLATION', DENY, { target, reason: 'The employee is not a member of the project.' })
  if (DELETE_TOOLS.has(tool)) return verdict('IRREVERSIBLE_DELETE', HUMAN, { target })
  if (SHELL_TOOLS.has(tool)) {
    const command = text(args?.command) ?? text(args?.input) ?? ''
    if (command.trim() === '') return verdict('UNKNOWN_EFFECT', HUMAN, { target, reason: 'The shell call has no command text.' })
    if (truncated) return verdict('UNKNOWN_EFFECT', HUMAN, { target, reason: 'The arguments were truncated before classification.' })
    return classifyShell({ command, base, scope: authorized })
  }
  if (WRITE_TOOLS.has(tool)) {
    const path = absolute(text(args?.[WRITE_TOOLS.get(tool)]), base)
    if (path === undefined) return verdict('UNKNOWN_EFFECT', HUMAN, { target, reason: 'The write has no resolvable target.' })
    if (isSecretPath(path)) return verdict('SECRET_EXFIL', DENY, { target: path, reason: 'The write targets a credential file.' })
    if (isProductionPath(path)) return verdict('PRODUCTION', HUMAN, { target: path })
    if ((authorized.foreignWorkspaces ?? []).some(outer => insidePath(path, outer))) return verdict('SCOPE_VIOLATION', DENY, { target: path, reason: 'The target belongs to another project.' })
    if (insidePath(path, authorized.workspaceRef)) return verdict('WRITE_INSIDE', ALLOW, { target: path })
    return verdict('WRITE_OUTSIDE', HUMAN, { target: path })
  }
  if (READ_TOOLS.has(tool)) {
    const path = absolute(text(args?.file_path), base) ?? absolute(text(args?.path), base)
    if (path !== undefined && isSecretPath(path)) return verdict('SECRET_EXFIL', DENY, { target: path, reason: 'The read targets a credential file.' })
    return verdict('READ_ONLY', ALLOW, { target: path ?? target })
  }
  if (INTERNAL_TOOLS.has(tool)) return verdict('INTERNAL', ALLOW, { target })
  return verdict('UNKNOWN_TOOL', HUMAN, { target, reason: `The tool "${tool}" is not in the rule table.` })
}

/** Whether a decision lets the call through. The adaptor maps the other two onto the host. */
export const allows = (decision) => decision === ALLOW
