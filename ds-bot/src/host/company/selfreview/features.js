// The structured facts one tool call is judged on — M1b-1 item 1.
//
// The request used to carry a per-argument preview: a short string per key, with contents and
// credentials replaced. That still let prose, file names and command lines travel, and it made
// the judge read English rather than facts. This module projects the call into facts instead:
// which tool, how many arguments, which keys existed, the normalized target path and whether it
// falls in the authorized folder, and — for a shell call — the first word, the flags by name,
// the paths the line names, the programs an `-exec` would run and the redirect targets.
//
// What is never carried: file bodies, message text, the command line itself, flag values
// (`--password=…`, `-p…`, the word after `-H`), the argument of a nested `-c` command, tokens,
// the right side of a `NAME=value` assignment anywhere on the line, a quoted sentence where a
// path or a program would go, and the query or fragment of a word that looks like an endpoint
// (`…/x?token=…`) — and the local rule verdict. A key whose name says it holds a document is reported by name
// only, and a key whose name says it holds a credential is reported by name only as well.
// A value that `secrets.js` already knows as a saved secret hides its key the same way, so the
// host's own secret store — not a second word list — decides what counts as a credential.
//
// `truncated` means the facts themselves are incomplete — more keys, flags, paths or programs
// than the caps hold, a target that could not be resolved, a flag whose tail may have carried a
// value, or a nested command whose words were not examined. Omitting a body is not truncation:
// the body was never meant to travel, and the facts describe it by key name and shape instead.
// That distinction is the point of this module: M1b-0 could only answer "I did not see the body"
// for every shell call, so every shell call asked a human.
import { isAbsolute, resolve } from 'node:path'
import { insidePath } from './rules.js'

/** Bumped when the shape below changes, so a stored record can be read with the right parser. */
export const FEATURES_VERSION = '3'

const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** Shell flags whose next word is a program, not a path. */
const EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** Shell flags whose next word is a command line: neither a path nor a fact that travels. */
const COMMAND_FLAGS = new Set(['-c', '--command', '-Command', '-EncodedCommand', '/c', '/k'])

/**
 * Flags whose next word is a body or a credential — a header, a payload, a token, a password.
 * The word is skipped whole; only the flag's name is kept, because the value is exactly what
 * §3.3 forbids the request to carry.
 */
const VALUE_FLAGS = new Set([
  '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-urlencode',
  '-b', '--cookie', '-u', '--user', '-e', '--execute', '-X', '--request', '-A', '--user-agent',
  '-E', '--cert', '--key', '-K', '--config', '-P', '--password', '--token', '--api-key',
  '--apikey', '--authorization', '-x', '--proxy', '-F', '--form', '-ExecutionPolicy',
])

/** Flags whose next word names a place: an output file, an upload, a script. */
const PATH_FLAGS = new Set(['-o', '--output', '-T', '--upload-file', '-File'])

/** File tools, with the argument that names their target. */
const WRITE_ARG = new Map([['write', 'file_path'], ['edit', 'file_path'], ['str_replace_editor', 'path']])

/** Arguments that name a place, in the order they are preferred. */
const PATH_KEYS = ['file_path', 'path', 'file', 'dir', 'cwd', 'cd', 'base', 'root', 'target']

/**
 * Key-name hints for credentials. `secrets.js` is the authority — a value it knows is a secret
 * hides its key on its own — but a credential that was typed inline and never saved has no entry
 * there, so its name still has to say what it holds. Names are compared with the separators
 * removed, so `accessToken`, `access_token` and `ACCESS_TOKEN` all hide a value.
 */
const SECRET_NAME_HINTS = ['token', 'secret', 'password', 'passwd', 'apikey', 'credential', 'authorization', 'cookie', 'privatekey', 'sessionkey']

/**
 * Keys that carry a document: the body of a write, the strings of an edit, a chat message, a
 * prompt, a patch, a file's bytes. §3.3 forbids contents in the request, so only the name goes.
 */
const CONTENT_KEYS = /^(?:content|contents|body|text|message|messages|prompt|prompts|query|queries|script|snippet|command|commands|patch|diff|source|code|data|bytes|base64|old_?str(?:ing)?|new_?str(?:ing)?|old_?content|new_?content|old_?text|new_?text|file_?text|input)$/i

/** A leading `NAME=value` word sets the environment; its value is not a fact that travels. */
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A bare command name: no path separator, no quoting, no payload. */
const BARE_NAME = /^[A-Za-z][\w.+-]*$/

/**
 * A shell word that can name a place. Whitespace means the word was quoted: it is a command line
 * or a sentence, not a path. `?` and `#` start a query and a fragment, and a query is where an
 * inline credential hides (`…/x?token=…`). Neither can be part of a place, so the word is not
 * carried as one and the call reports shortened facts.
 */
const PLACE_SHAPED = /^[^\s?#]+$/

/**
 * A path taken from a structured argument, not from a shell line. A real file name may hold
 * spaces (`My Documents`), so only a query or a fragment disqualifies it.
 */
const ARG_PATH = /^[^?#]*$/

/** A cluster of short flag names: `-rf`, `-la`, `-rn`. Anything longer may carry a value. */
const SHORT_CLUSTER = /^-[A-Za-z]{1,3}$/

/**
 * The first letter of every short flag that takes a value (`-p` in `mysql -pSECRET`, `-u` in
 * `curl -uuser:pass`, `-d` in `curl -dDATA`). A cluster that starts with one of them is not a
 * cluster: `-pab` may be `-p ab`, so only the letter is kept and the call reports shortened
 * facts. The cost is `tar -czf` reading as `-c`, and that cost is named rather than paid by
 * letting a two-letter password travel.
 *
 * `-p` is listed on its own because no tool takes it as a separate word: `mysql -p db` and
 * `ssh -p 22` mean different things, so it must not swallow the next word the way `-u` does.
 */
const VALUE_LETTERS = new Set(
  [...VALUE_FLAGS, ...PATH_FLAGS, ...COMMAND_FLAGS, '-p']
    .filter(name => name.length === 2 && name.startsWith('-'))
    .map(name => name[1]),
)

/**
 * The letters of short flags whose next word is a command line (`-c`). A cluster ending in one of
 * them (`-lc`) carries a body in the word after it, so that word is dropped and the call reports
 * shortened facts.
 */
const BODY_LETTERS = new Set(
  [...COMMAND_FLAGS]
    .filter(name => name.length === 2 && name.startsWith('-'))
    .map(name => name[1]),
)

const MAX_FIELDS = 16
const MAX_FLAGS = 8
const MAX_PATHS = 4
const MAX_PROGRAMS = 4
const WORD_MAX = 40
const PATH_MAX = 120

const secretKey = (key) => {
  const name = String(key).replace(/[_-]/g, '').toLowerCase()
  return SECRET_NAME_HINTS.some(word => name === word || name.endsWith(word))
}

const text = value => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined)
const slashed = value => value.replace(/\\/g, '/')

/** Replace the host home with a tag, so a record never spells out where the instance lives. */
const pathRedactor = (home) => {
  const root = typeof home === 'string' && home !== '' ? slashed(resolve(home)) : undefined
  return (value) => {
    const path = slashed(value)
    if (root === undefined) return path
    if (path === root) return '<dsh-home>'
    return path.startsWith(`${root}/`) ? `<dsh-home>${path.slice(root.length)}` : path
  }
}

/** Split a command line into words, keeping single- and double-quoted runs together. */
const wordsOf = (command) => (command.match(/(?:[^\s'"]+|'[^']*'|"[^"]*")+/g) ?? [])
  .map(word => word.replace(/^['"]|['"]$/g, ''))

/**
 * A flag's name, never its value.
 *
 * `--password=…` keeps `--password`; the value is a value and never travels. `-rf` is a cluster
 * of three-letter names and keeps as it is. `-pSECRET` and `-rf0` look the same as a cluster but
 * may carry a value, so only the first letter is kept and the call reports shortened facts —
 * a dropped tail is a fact the judge did not get, not a value it was owed.
 */
const flagName = (word) => {
  if (word.startsWith('--')) {
    const at = word.indexOf('=')
    return at === -1 ? { name: word.slice(0, WORD_MAX), cut: false } : { name: word.slice(0, Math.min(at, WORD_MAX)), cut: false }
  }
  if (SHORT_CLUSTER.test(word)) {
    // A one-letter word has no tail to hide a value in; a longer one that starts with a
    // value-taking letter does, and only the letter is kept.
    if (word.length > 2 && VALUE_LETTERS.has(word[1])) return { name: word.slice(0, 2), cut: true }
    // `bash -lc "…"` is `-l -c`: the cluster ends in a flag whose word is a command line, so the
    // cluster keeps its name and the caller drops the body. The alternative, keeping the cluster
    // as a plain flag, would let a body stand where the facts say nothing was left out.
    if (word.length > 2 && BODY_LETTERS.has(word[word.length - 1])) return { name: word, cut: true, body: true }
    return { name: word, cut: false }
  }
  return { name: word.slice(0, 2), cut: true }
}

const resolveTarget = ({ value, base, workspace, redact }) => {
  const raw = text(value)
  if (raw === undefined) return undefined
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '')
  if (trimmed === '' || trimmed === '-') return undefined
  const absolute = isAbsolute(trimmed) ? resolve(trimmed) : base === undefined ? undefined : resolve(base, trimmed)
  if (absolute === undefined) return undefined
  return {
    value: redact(absolute).slice(0, PATH_MAX),
    inside_scope: workspace === undefined ? null : insidePath(absolute, workspace),
  }
}

/**
 * One call's structured facts.
 *
 * @param {object} input
 * @param {string} input.tool        the tool's name, as the host reports it
 * @param {object} [input.args]      its arguments
 * @param {string} [input.base]      the folder relative arguments resolve against
 * @param {object} [input.scope]     `{ workspaceRef }`, for the in/out of scope fact
 * @param {string} [input.home]      the DSH home, redacted to `<dsh-home>`
 * @param {Function} [input.redact]  the host's secret redactor (`rt.redactSecrets`): every string
 *                                   that leaves this module passes through it, and a value it
 *                                   rewrites is a credential whose key is reported by name only
 */
export function callFeatures({ tool, args, base, scope = {}, home, redact } = {}) {
  const names = args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : []
  const viaHome = pathRedactor(home)
  const scrub = typeof redact === 'function' ? redact : undefined
  const redactText = (value) => {
    const tagged = viaHome(String(value))
    return scrub === undefined ? tagged : scrub(tagged)
  }
  const knownSecret = (value) => scrub !== undefined && typeof value === 'string' && value !== '' && scrub(value) !== value
  const resolvedBase = typeof base === 'string' && base !== '' ? resolve(base) : undefined
  const workspace = typeof scope.workspaceRef === 'string' && scope.workspaceRef !== '' ? resolve(scope.workspaceRef) : undefined

  const features = {
    version: FEATURES_VERSION,
    tool: typeof tool === 'string' ? tool : '',
    arg_count: names.length,
    fields: names.slice(0, MAX_FIELDS),
    content_fields: names.filter(name => CONTENT_KEYS.test(name)),
    // A credential is reported by name only whether its name says so or the secret store knows
    // its value: the two sources answer the same question and either one is enough.
    secret_fields: names.filter(name => secretKey(name) || knownSecret(args?.[name])),
    // Only a cut key list means the shape below is missing arguments; a hidden body is by design.
    truncated: names.length > MAX_FIELDS,
    path: null,
    shell: null,
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = text(args?.command) ?? text(args?.input)
    if (command === undefined || command.trim() === '') {
      // A shell call with no words at all: the judge has nothing to read.
      features.truncated = true
    } else {
      const words = wordsOf(command)
      const flags = []
      const paths = []
      const programs = []
      let cut = false
      const pushPath = (value) => {
        if (paths.length >= MAX_PATHS) { cut = true; return }
        const target = resolveTarget({ value, base: resolvedBase, workspace, redact: redactText })
        if (target === undefined) cut = true
        else paths.push(target.value)
      }
      // `FOO=bar cmd`: the assignment is a value, and a value may be a credential.
      let start = 0
      while (start < words.length && ENV_ASSIGN.test(words[start])) start += 1
      for (let at = start; at < words.length; at += 1) {
        const word = words[at]
        if (EXEC_FLAGS.has(word)) {
          const program = words[at + 1]
          // A quoted program is a command line: `-exec "curl http://…?token=…"` carries the whole
          // sentence, so the program slot stays empty and the call says its facts are shortened.
          if (program !== undefined && !PLACE_SHAPED.test(program)) cut = true
          else if (program !== undefined) {
            if (programs.length < MAX_PROGRAMS) programs.push(redactText(program).slice(0, WORD_MAX))
            else cut = true
          }
          continue
        }
        // `bash -c "<command>"`: the next word is a command line, not a path. It is not carried,
        // and the words inside it are not examined, so the call says its facts are shortened.
        if (COMMAND_FLAGS.has(word)) {
          at += 1
          cut = true
          continue
        }
        // A header, a payload, a token: the name is the fact, and the value never travels.
        if (VALUE_FLAGS.has(word)) {
          if (flags.length < MAX_FLAGS) flags.push(word.slice(0, WORD_MAX))
          else cut = true
          at += 1
          continue
        }
        if (PATH_FLAGS.has(word)) {
          const value = words[at + 1]
          at += 1
          if (value !== undefined) pushPath(value)
          continue
        }
        if (word === '--' || word === '-') continue
        // `FOO=bar` anywhere on the line — after `sudo`, inside a `sh -c` tail — sets the
        // environment, and its right side is a value that may be a credential. Only the leading
        // assignments are skipped above to find the command name; these are skipped for the same
        // reason: the value is not a fact that travels. The name is not carried either, so the
        // call says its facts are shortened.
        if (ENV_ASSIGN.test(word)) { cut = true; continue }
        if (word.startsWith('-')) {
          const flag = flagName(word)
          if (flags.length < MAX_FLAGS) flags.push(flag.name)
          else cut = true
          if (flag.cut) cut = true
          // `-lc "…"`: the cluster ends in a command flag, so the next word is a body, not a path.
          if (flag.body === true) at += 1
          continue
        }
        // A URL is an endpoint, not a path: it leaves the machine, which is the judge's call.
        const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(word)
        if (!isUrl && (word.includes('/') || word.startsWith('.') || word.startsWith('~'))) {
          if (!PLACE_SHAPED.test(word)) { cut = true; continue }
          pushPath(word)
        }
      }
      // A redirect target is the path the shell writes to; it belongs with the other paths, but
      // stays separate so a judge can tell a bare argument from a write.
      const redirects = []
      for (const match of command.matchAll(/(?:^|\s)\d*>>?\s*([^\s;&|]+)/g)) {
        if (redirects.length >= MAX_PATHS) { cut = true; break }
        // A redirect target is a place; one that carries a query or a fragment is not, and the
        // tail is exactly the part that must not travel.
        if (!PLACE_SHAPED.test(match[1])) { cut = true; continue }
        const target = resolveTarget({ value: match[1], base: resolvedBase, workspace, redact: redactText })
        if (target === undefined) cut = true
        else redirects.push(target.value)
      }
      const first = start < words.length ? words[start] : ''
      features.shell = {
        // A first word that is a path or a quoted payload is not a command name; it is reported
        // as a path instead, so the judge never reads a sentence where a name belongs.
        first_word: BARE_NAME.test(first) ? redactText(first).slice(0, WORD_MAX) : null,
        flags,
        paths,
        programs,
        segments: command.split(/&&|\|\||[;|\n]/).filter(segment => segment.trim() !== '').length,
        redirects,
      }
      features.truncated = features.truncated || cut
    }
  }

  const key = WRITE_ARG.get(tool) ?? PATH_KEYS.find(name => names.includes(name))
  if (key !== undefined) {
    // A structured path may hold spaces, but not a query: the query is where an inline credential
    // hides, so a value that carries one is reported as an unknown place instead of a path.
    const raw = text(args[key])
    const target = raw !== undefined && ARG_PATH.test(raw.trim())
      ? resolveTarget({ value: args[key], base: resolvedBase, workspace, redact: redactText })
      : undefined
    if (target !== undefined) features.path = target
    else features.truncated = true
  }

  return features
}
