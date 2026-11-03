// The company layer: <home>/company/ holds the company, its departments, its employees and
// its projects, next to the Bot team rather than inside it. Install runs after the roster
// and privacy modules; their lookups are used at run time, never while installing.
//
// Projects live in group chats, so the project commands are handed a small adapter over
// the roster rather than the roster itself: the adapter is the only place that knows how a
// group is made, read and re-membered. A project group is allowed to hold a single Bot
// (Q1); no other group is.
import { join } from 'node:path'
import { createCommands } from './commands.js'
import { orgHandlers } from './org.js'
import { projectHandlers } from './projects.js'
import { createCompanyStore } from './store.js'

// The roster side of a project group. `members` returns undefined when the group is gone,
// which is how the project commands tell "missing" from "drifted".
const groupAdapter = (rt) => ({
  create: async ({ name, members }) => {
    if (typeof rt.createRoom !== 'function') throw new Error('The roster does not create groups here.')
    const room = await rt.createRoom({ name, members, allowSingle: true })
    return room?.id
  },
  members: (roomId) => {
    if (typeof rt.roomOf !== 'function') return undefined
    const room = rt.roomOf(roomId)
    return room === undefined ? undefined : [...room.members]
  },
  setMembers: async (roomId, members) => {
    if (typeof rt.updateRoom !== 'function') throw new Error('The roster does not change groups here.')
    if (typeof rt.roomOf === 'function' && rt.roomOf(roomId) === undefined) throw new Error(`No group chat ${roomId}.`)
    await rt.updateRoom(roomId, { members }, undefined, { allowSingle: true })
  },
})

export function install(rt) {
  const dir = join(rt.home, 'company')
  const now = () => Date.now()
  const warn = typeof rt.warn === 'function' ? rt.warn : (...args) => rt.ctx?.logger?.warn?.(...args)
  const store = createCompanyStore({ dir, now, warn })
  const commands = createCommands({
    store,
    now,
    handlers: {
      ...orgHandlers({ botOf: id => rt.botOf?.(id), isPrivate: id => rt.isPrivate?.(id) === true }),
      ...projectHandlers({ groups: groupAdapter(rt) }),
    },
  })
  const execute = commands.execute
  // `rt.company` is what the HTTP layer (M1a-5) and the tools (M1a-3) will call.
  rt.company = { dir, store, execute, commands: commands.commands, close: () => store.close() }
  Object.assign(rt, { companyExecute: execute, companyStore: store, companyState: () => store.state })
  // Released with the plugin, like the team file's lock in store.js: an unloaded plugin
  // must not leave a beating lock behind, which would hold the next host read-only
  // until the heartbeat went stale.
  rt.ctx?.effect?.(() => () => store.close(), 'ds-bot: company store')
}
