// The structured facts one tool call is judged on — M1b-1 item 1.
//
// The request used to carry a per-argument preview: a short string per key, with contents and
// credentials replaced. That still let prose, file names and command lines travel, and it made
// the judge read English rather than facts. This module projects the call into facts instead:
// which tool, how many arguments, which keys existed, the normalized target path and whether it
// falls in the authorized folder, and — for a shell call — the first word, the flags, the paths
// the line names, the programs an `-exec` would run and the redirect targets.
//
// What is never carried: file bodies, message text, the command line itself, tokens, and the
// local rule verdict. A key whose name says it holds a document is reported by name only, and a
// key whose name says it holds a credential is reported by name only as well.
//
// `truncated` means the facts themselves are incomplete — more keys, flags, paths or programs
// than the caps hold, or a target that could not be resolved. Omitting a body is not truncation:
// the body was never meant to travel, and the facts describe it by key name and shape instead.
// That distinction is the point of this module: M1b-0 could only answer "I did not see the body"
// for every shell call, so every shell call asked a human.
import { isAbsolute, resolve } from 'node:path'
import { insidePath } from './rules.js'

/** Bumped when the shape below changes, so a stored record can be read with the right parser. */
export const FEATURES_VERSION = '2'

const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/** Shell flags whose next word is a program, not a path. */
const EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** File tools, with the argument that names their target. */
const WRITE_ARG = new Map([['write', 'file_path'], ['edit', 'file_path'], ['str_replace_editor', 'path']])

/** Arguments that name a place, in the order they are preferred. */
const PATH_KEYS = ['file_path', 'path', 'file', 'dir', 'cwd', 'base', 'root', 'target']

/**
 * Keys whose value is never described, whatever it holds. Names are compared with the
 * separators removed, so `accessToken`, `access_token` and `ACCESS_TOKEN` all hide a value.
 */
const SECRET_WORDS = ['token', 'secret', 'password', 'passwd', 'apikey', 'credential', 'authorization', 'cookie', 'privatekey', 'sessionkey']

/**
 * Keys that carry a document: the body of a write, the strings of an edit, a chat message, a
 * prompt, a patch, a file's bytes. §3.3 forbids contents in the request, so only the name goes.
 */
const CONTENT_KEYS = /^(?:content|contents|body|text|message|messages|prompt|prompts|query|queries|script|snippet|command|commands|patch|diff|source|code|data|bytes|base64|old_?str(?:ing)?|new_?str(?:ing)?|old_?content|new_?content|old_?text|new_?text|file_?text|input)$/i

const MAX_FIELDS = 16
const MAX_FLAGS = 8
const MAX_PATHS = 4
const MAX_PROGRAMS = 4
const WORD_MAX = 40
const PATH_MAX = 120

const secretKey = (key) => {
  const name = String(key).replace(/[_-]/g, '').toLowerCase()
  return SECRET_WORDS.some(word => name === word || name.endsWith(word))
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
 */
export function callFeatures({ tool, args, base, scope = {}, home } = {}) {
  const names = args !== null && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : []
  const redact = pathRedactor(home)
  const resolvedBase = typeof base === 'string' && base !== '' ? resolve(base) : undefined
  const workspace = typeof scope.workspaceRef === 'string' && scope.workspaceRef !== '' ? resolve(scope.workspaceRef) : undefined

  const features = {
    version: FEATURES_VERSION,
    tool: typeof tool === 'string' ? tool : '',
    arg_count: names.length,
    fields: names.slice(0, MAX_FIELDS),
    content_fields: names.filter(name => CONTENT_KEYS.test(name)),
    secret_fields: names.filter(name => secretKey(name)),
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
      for (let at = 0; at < words.length; at += 1) {
        const word = words[at]
        if (EXEC_FLAGS.has(word)) {
          const program = words[at + 1]
          if (program !== undefined) {
            if (programs.length < MAX_PROGRAMS) programs.push(program.slice(0, WORD_MAX))
            else cut = true
          }
          continue
        }
        if (word.startsWith('-')) {
          if (flags.length < MAX_FLAGS) flags.push(word.slice(0, WORD_MAX))
          else cut = true
          continue
        }
        // A URL is an endpoint, not a path: it leaves the machine, which is the judge's call.
        const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(word)
        if (!isUrl && (word.includes('/') || word.startsWith('.') || word.startsWith('~'))) {
          if (paths.length < MAX_PATHS) {
            const target = resolveTarget({ value: word, base: resolvedBase, workspace, redact })
            if (target === undefined) cut = true
            else paths.push(target.value)
          } else cut = true
        }
      }
      // A redirect target is the path the shell writes to; it belongs with the other paths, but
      // stays separate so a judge can tell a bare argument from a write.
      const redirects = []
      for (const match of command.matchAll(/(?:^|\s)\d*>>?\s*([^\s;&|]+)/g)) {
        if (redirects.length >= MAX_PATHS) { cut = true; break }
        const target = resolveTarget({ value: match[1], base: resolvedBase, workspace, redact })
        if (target !== undefined) redirects.push(target.value)
      }
      features.shell = {
        first_word: (words[0] ?? '').slice(0, WORD_MAX),
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
    const target = resolveTarget({ value: args[key], base: resolvedBase, workspace, redact })
    if (target !== undefined) features.path = target
    else features.truncated = true
  }

  return features
}
