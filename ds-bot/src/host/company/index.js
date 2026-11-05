// The company layer: <home>/company/ holds the company, its departments, its employees and
// its projects, next to the Bot team rather than inside it. Install runs after the roster
// and privacy modules; their lookups are used at run time, never while installing.
//
// Projects live in group chats, so the project commands are handed a small adapter over
// the roster rather than the roster itself: the adapter is the only place that knows how a
// group is made, read and re-membered. A project group is allowed to hold a single Bot
// (Q1); no other group is.
import { join } from 'node:path'
import { ROW_REVISION_COMMANDS, acceptanceHandlers } from './acceptances.js'
import { createCompanyApi } from './api.js'
import { createCommands } from './commands.js'
import { orgHandlers } from './org.js'
import { projectHandlers } from './projects.js'
import { pathRedactor } from './selfreview/features.js'
import { companyFail, createCompanyStore } from './store.js'

// The roster side of a project group. `members` returns undefined when the group is gone,
// which is how the project commands tell "missing" from "drifted".
const groupAdapter = (rt) => ({
  create: async ({ name, members, admin }) => {
    if (typeof rt.createRoom !== 'function') throw new Error('The roster does not create groups here.')
    // `admin` is the project coordinator when the project has one (M1b-1 item 4); without it the
    // roster's own default applies, which is what a draft with no coordinator should get.
    const room = await rt.createRoom({ name, members, ...(admin === undefined ? {} : { admin }), allowSingle: true })
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
    // `acceptance.decide` is answered with the revision of the acceptance itself (the to-do
    // row carries it, contract A12), so the envelope leaves that comparison to its handler.
    rowRevisionCommands: ROW_REVISION_COMMANDS,
    handlers: {
      ...orgHandlers({ botOf: id => rt.botOf?.(id), isPrivate: id => rt.isPrivate?.(id) === true }),
      ...projectHandlers({ groups: groupAdapter(rt) }),
      ...acceptanceHandlers(),
    },
  })
  const execute = commands.execute
  // The HTTP layer and the client channel read the same three answers; the groups adapter
  // is shared so a screen's `group` block comes from the roster, not a copy of it.
  // The to-do view reads what the other modules already know: the live cards, the review
  // records, the host facts, and the host's secret redactor for its titles. The three are
  // passed as lookups, not values, because the roster and the approval queue change after
  // install.
  const api = createCompanyApi({
    store,
    execute,
    groups: groupAdapter(rt),
    now,
    approvals: () => rt.approvalsView?.() ?? [],
    sessionBot: id => rt.selfOf?.(id),
    home: rt.home,
    // Two redactions in one lookup: the home becomes `<dsh-home>`, then the host's secret
    // redactor runs over the result, exactly as the SelfReview features do it. Read time is
    // when this runs, so a target already on disk is tagged too (B-5).
    redact: (text) => {
      const tagged = pathRedactor(rt.home)(text)
      return typeof rt.redactSecrets === 'function' ? rt.redactSecrets(tagged) : tagged
    },
    // Answering a card is relaying to the host, never a company-level decision of its own
    // (contract §5.1). A lookup, because the approvals module installs before or after this
    // one depending on load order.
    answerApproval: (id, choice) => {
      if (typeof rt.answerApproval !== 'function') throw companyFail('todo/unsupported', 'This dsh cannot answer approval cards.', {})
      return rt.answerApproval(id, choice)
    },
    warn,
  })
  // A company file written by an older plugin is read as the current version in memory; the
  // upgrade is saved back once, with the one event that records it, so the file stops being
  // ambiguous. A read-only company keeps the pending upgrade for the next writable start.
  const migration = store.migration()
  if (migration !== undefined && store.readOnly() === undefined) {
    void (async () => {
      try {
        await store.commit(store.state)
        await store.appendEvents([{
          id: 'evt_migrated',
          cursor: store.state.revision,
          at: new Date(now()).toISOString(),
          type: 'company/migrated',
          data: migration,
        }])
        store.clearMigration()
      } catch (error) {
        warn('ds-bot: could not write the company upgrade: %s', error?.message ?? String(error))
      }
    })()
  }
  // `rt.company` is what the HTTP layer and the tools call.
  rt.company = { dir, store, execute, commands: commands.commands, api, close: () => store.close() }
  Object.assign(rt, { companyExecute: execute, companyStore: store, companyApi: api, companyState: () => store.state })
  // Routes live exactly as long as the plugin: the channel's own route is disposed the
  // same way, and a host reload must not leave three stale handlers on the carrier.
  if (typeof rt.ctx?.connection?.fetch?.register === 'function') {
    rt.ctx.effect(() => api.register(rt.ctx), 'ds-bot: company api')
  }
  // Released with the plugin, like the team file's lock in store.js: an unloaded plugin
  // must not leave a beating lock behind, which would hold the next host read-only
  // until the heartbeat went stale.
  rt.ctx?.effect?.(() => () => store.close(), 'ds-bot: company store')
}
