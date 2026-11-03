// The company layer: <home>/company/ holds the company, its departments and its
// employees, next to the Bot team rather than inside it. Install runs after the roster
// and privacy modules; their lookups are used at run time, never while installing.
import { join } from 'node:path'
import { createCommands } from './commands.js'
import { orgHandlers } from './org.js'
import { createCompanyStore } from './store.js'

export function install(rt) {
  const dir = join(rt.home, 'company')
  const now = () => Date.now()
  const warn = typeof rt.warn === 'function' ? rt.warn : (...args) => rt.ctx?.logger?.warn?.(...args)
  const store = createCompanyStore({ dir, now, warn })
  const commands = createCommands({
    store,
    now,
    handlers: orgHandlers({ botOf: id => rt.botOf?.(id), isPrivate: id => rt.isPrivate?.(id) === true }),
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
