// Company store: the company's own objects in <home>/company/state.json, apart from the
// Bot team in state.json. The team file is a live document that every plugin version
// migrates; business objects stay here so the company layer can be reset, backed up or
// uninstalled without touching the Bots, their chats or their memory.
//
// One writer per company directory, using the same home-lock scheme as the team file.
// A file that does not parse, or that carries two active employees for one Bot, puts
// the store in read-only mode and is left as it is: starting from an empty company
// would silently drop the real one.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from '../files.js'
import { homeLock } from '../home-lock.js'

export const COMPANY_VERSION = 6
// v1 files carry the same six tables; v2 adds the two to-do tables; v3 adds the employee
// templates; v4 adds the project task table; v5 adds dispatch runs; v6 adds the human
// actors and their grants. An older file is read as the current version in memory
// (revision untouched) and saved back as the current version on the next commit;
// `migration` reports that upgrade once, so the caller can record one `company/migrated`
// event. A v6 reader always finds the owner actor, whether the file was written by v6 or
// upgraded on the way in, so the local user keeps the identity the older fields recorded
// as the plain string `'user'`.
const READABLE_VERSIONS = [1, 2, 3, 4, 5, 6]
// The owner never appears in a grant: full rights are inherent to the row itself. The id
// stays `'user'` so every field written before v6 (acceptance_actor, assigned_by, …) still
// names the same person.
export const OWNER_ACTOR_ID = 'user'
export const ACTOR_KINDS = ['owner', 'human']

// Error codes follow the plugin's `area/kind` shape, so the HTTP layer (M1a-5) can turn
// them into status codes without matching on message text.
export const companyFail = (code, message, details) => Object.assign(new Error(message), { code, details })

// The owner is a real row, not a special case hidden in code: the settings screen lists
// people from this table, and every historical `'user'` field resolves through it. It is
// seeded on load rather than in `emptyCompanyState()` because a row needs a timestamp.
const ensureOwnerActor = (state, now) => {
  if (state.actors[OWNER_ACTOR_ID] !== undefined) return
  const at = now()
  state.actors[OWNER_ACTOR_ID] = {
    id: OWNER_ACTOR_ID,
    kind: 'owner',
    name: '老板',
    status: 'active',
    created_at: at,
    updated_at: at,
  }
}

export const emptyCompanyState = () => ({
  version: COMPANY_VERSION,
  revision: 0,
  // Tables are filled by the command modules; projects and members arrive with M1a-3.
  companies: {},
  departments: {},
  employees: {},
  projects: {},
  members: {},
  // One entry per committed operation_key: the replay record behind idempotency.
  operation_log: {},
  // v2: acceptance objects (M1b-2b) and the append-only record of answers given from the
  // to-do view. Both are empty on a v1 file, so the upgrade loses nothing.
  acceptances: {},
  todo_log: {},
  // v3: employee templates (M1b-3.2), builtin and custom in one table.
  templates: {},
  // v4: project tasks (M1b-3.3), one row per card on a project's board.
  tasks: {},
  // v5: dispatch runs, one row per card handed to an employee.
  runs: {},
  // v6: the people behind the commands (owner + invited humans) and the grants that give
  // a non-owner a slice of them. Both fill in on load, so an upgraded file and a new one
  // both carry the owner actor.
  actors: {},
  grants: {},
})

const isTable = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const TABLES = ['companies', 'departments', 'employees', 'projects', 'members', 'operation_log', 'acceptances', 'todo_log', 'templates', 'tasks', 'runs', 'actors', 'grants']

// A file written by a newer plugin is not a file this version can edit: its tables may
// mean something else, so it counts as corrupt rather than being rewritten in the old
// shape.
function shapeTrouble(parsed) {
  if (!isTable(parsed)) return 'the file does not hold an object'
  if (!READABLE_VERSIONS.includes(parsed.version)) return `version ${parsed.version} is not ${COMPANY_VERSION}`
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) return 'revision is not a whole number'
  for (const name of TABLES) if (parsed[name] !== undefined && !isTable(parsed[name])) return `${name} is not a table`
  return undefined
}

export function createCompanyStore({ dir, now = Date.now, warn = () => {}, useLock = true } = {}) {
  const statePath = join(dir, 'state.json')
  const eventsPath = join(dir, 'events.jsonl')
  const lockPath = join(dir, 'state.lock')
  let state = emptyCompanyState()
  let loaded = false
  // Why the file cannot be used: parse trouble, a newer version, two active employees
  // for one Bot. The file stays untouched until someone fixes or moves it.
  let stuck
  // The v1 → v2 upgrade noticed on load, or undefined once written back.
  let migration
  // The other dsh holding state.lock while this one may only read.
  let holder
  let disposed = false
  const lock = useLock ? homeLock(lockPath) : undefined
  // Built from the employees table on load and after every commit; never serialized.
  let byBotId = new Map()

  const rebuildIndex = () => {
    const next = new Map()
    for (const profile of Object.values(state.employees)) {
      if (profile?.status !== 'active') continue
      // An unbound profile holds no Bot, so several of them are fine.
      if (profile.bot_id === null || profile.bot_id === undefined || profile.bot_id === '') continue
      if (next.has(profile.bot_id)) {
        stuck = `two active employees share Bot ${profile.bot_id}`
        return next
      }
      next.set(profile.bot_id, profile.id)
    }
    return next
  }

  function load() {
    if (loaded) return state
    loaded = true
    if (lock !== undefined) {
      try {
        mkdirSync(dir, { recursive: true })
        holder = lock.claim()
      } catch (error) {
        // An unusable lock must not stop the company from being read; a write that then
        // cannot happen still rejects.
        warn('ds-bot: cannot lock %s, so another dsh on the same company could undo changes: %s', dir, error)
        holder = undefined
      }
    }
    let text
    try {
      text = readFileSync(statePath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        ensureOwnerActor(state, now)
        return state
      }
      stuck = error?.code ?? error?.message ?? String(error)
      warn('ds-bot: unreadable company %s: %s', statePath, error)
      return state
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      stuck = `invalid JSON (${error?.message ?? error})`
      warn('ds-bot: company %s is not JSON: %s', statePath, error)
      return state
    }
    const trouble = shapeTrouble(parsed)
    if (trouble !== undefined) {
      stuck = trouble
      warn('ds-bot: company %s is unusable: %s', statePath, trouble)
      return state
    }
    for (const name of TABLES) if (parsed[name] === undefined) parsed[name] = {}
    if (parsed.version !== COMPANY_VERSION) {
      migration = { from: parsed.version, to: COMPANY_VERSION }
      parsed.version = COMPANY_VERSION
    }
    ensureOwnerActor(parsed, now)
    state = parsed
    byBotId = rebuildIndex()
    if (stuck !== undefined) warn('ds-bot: company %s is unusable: %s', statePath, stuck)
    return state
  }

  // undefined while this store may write; the code and message otherwise.
  const blocked = () => {
    load()
    if (stuck !== undefined) return { code: 'company.state.corrupt', message: `The company file ${statePath} cannot be used (${stuck}). DS Bot does not change it; fix or move the file and reload.`, reason: stuck }
    if (holder !== undefined) {
      const where = holder.pid ? `pid ${holder.pid}${holder.host ? ` on ${holder.host}` : ''}` : 'unknown process'
      return { code: 'company/read-only', message: `The company in ${dir} is open in another dsh (${where}). This window can read it but not change it; close the other one and reload.`, reason: 'locked' }
    }
    return undefined
  }
  const readOnly = () => blocked()?.message
  const assertWritable = () => {
    const why = disposed ? { code: 'company/closed', message: 'The company store is closed.', reason: 'closed' } : blocked()
    if (why !== undefined) throw companyFail(why.code, why.message, { path: statePath, reason: why.reason })
  }

  // Replaces the saved company with `next`: the temp file is written whole, then moved
  // over the old one, and only then does memory follow. A failed write therefore leaves
  // both the file and the in-memory state on the previous revision.
  async function commit(next) {
    assertWritable()
    await mkdir(dir, { recursive: true })
    const temp = join(dir, `state.${process.pid}.${randomUUID()}.tmp`)
    await writeFile(temp, JSON.stringify(next))
    await replaceFile(temp, statePath, () => assertWritable())
    state = next
    byBotId = rebuildIndex()
    if (stuck !== undefined) warn('ds-bot: company %s is unusable: %s', statePath, stuck)
  }

  // Appended after the state is saved: an event without its state change would read as
  // an action that never happened; a state change without its event loses one audit
  // line, which the journal tolerates better than a false one.
  async function appendEvents(events) {
    if (events.length === 0) return
    await mkdir(dir, { recursive: true })
    await appendFile(eventsPath, events.map(event => `${JSON.stringify(event)}\n`).join(''))
  }

  function close() {
    disposed = true
    lock?.release()
  }

  return {
    dir,
    statePath,
    eventsPath,
    get state() {
      return load()
    },
    readOnly,
    byBotId: () => {
      load()
      return byBotId
    },
    assertWritable,
    commit,
    appendEvents,
    close,
    now,
    // The pending v1 → v2 upgrade, undefined when there is none or it was written back.
    // Reading it loads the file first: the upgrade is noticed while loading, and a caller
    // that only looks here must not be told "nothing to do" before the file was read.
    migration: () => {
      load()
      return migration
    },
    clearMigration: () => {
      migration = undefined
    },
  }
}
