// The company layer: <home>/company/ holds the company, its departments, its employees and
// its projects, next to the Bot team rather than inside it. Install runs after the roster
// and privacy modules; their lookups are used at run time, never while installing.
//
// Projects live in group chats, so the project commands are handed a small adapter over
// the roster rather than the roster itself: the adapter is the only place that knows how a
// group is made, read and re-membered. A project group is allowed to hold a single Bot
// (Q1); no other group is.
import { join } from 'node:path'
import { ROW_REVISION_COMMANDS, acceptanceHandlers, submitWithAcceptance } from './acceptances.js'
import { createCompanyApi } from './api.js'
import { seedBuiltinTemplates } from './builtin-templates.js'
import { createCommands } from './commands.js'
import { orgHandlers } from './org.js'
import { projectHandlers } from './projects.js'
import { pathRedactor } from './selfreview/features.js'
import { spawnHandlers } from './spawn.js'
import { MEMORY_ROW_REVISION_COMMANDS, appendMemory, memoryHandlers, memoryRow, withDoneMemory } from './memories.js'
import { companyFail, createCompanyStore } from './store.js'
import { TASK_ROW_REVISION_COMMANDS, taskHandlers } from './tasks.js'
import { RUN_ROW_REVISION_COMMANDS, runHandlers } from './runs.js'
import { templateHandlers } from './templates.js'
import { nameProblem } from '../../shared/mentions.js'
import { templateIoHandlers } from './template-io.js'

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
  // The department group commands read the room to bind one made elsewhere (M1a-4).
  roomOf: roomId => (typeof rt.roomOf === 'function' ? rt.roomOf(roomId) : undefined),
  setMembers: async (roomId, members) => {
    if (typeof rt.updateRoom !== 'function') throw new Error('The roster does not change groups here.')
    if (typeof rt.roomOf === 'function' && rt.roomOf(roomId) === undefined) throw new Error(`No group chat ${roomId}.`)
    await rt.updateRoom(roomId, { members }, undefined, { allowSingle: true })
  },
})

// The roster side of hiring from a template (M1b-3.4). Three host calls make one employee:
// `createBot`, one `capabilityEndpoint` per skill, then the profile. `undo` is the way back,
// and it answers whether the Bot is still there instead of swallowing the fact: a Bot that
// cannot be deleted must reach the caller, not the log alone. `has` answers undefined when
// the library cannot be read, so a host without it lets the attach call decide.
const botRoster = (rt, warn) => ({
  create: (options) => {
    if (typeof rt.createBot !== 'function') throw new Error('This dsh does not create Bots.')
    return rt.createBot(options)
  },
  byName: name => (typeof rt.findBot === 'function' ? rt.findBot(name) : undefined),
  problem: name => nameProblem(name),
  has: (name) => {
    if (typeof rt.capabilityLibraryView !== 'function') return undefined
    return rt.capabilityLibraryView().some(item => item?.name === name)
  },
  attach: async (botId, name) => {
    if (typeof rt.capabilityEndpoint !== 'function') throw new Error('This dsh does not attach capabilities.')
    await rt.capabilityEndpoint('bot-capability', { botId, name, attached: true })
  },
  undo: async (botId, attached) => {
    for (const name of [...attached].reverse()) {
      try {
        await rt.capabilityEndpoint?.('bot-capability', { botId, name, attached: false })
      } catch (error) {
        warn('ds-bot: could not detach %s from %s: %s', name, botId, error instanceof Error ? error.message : String(error))
      }
    }
    if (typeof rt.deleteBot !== 'function') return true
    try {
      await rt.deleteBot(botId)
      return false
    } catch (error) {
      warn('ds-bot: could not delete %s: %s', botId, error instanceof Error ? error.message : String(error))
      return true
    }
  },
})

export function install(rt) {
  const dir = join(rt.home, 'company')
  const now = () => Date.now()
  const warn = typeof rt.warn === 'function' ? rt.warn : (...args) => rt.ctx?.logger?.warn?.(...args)
  const store = createCompanyStore({ dir, now, warn })
  // Two redactions in one lookup: the home becomes `<dsh-home>`, then the host's secret
  // redactor runs over the result. A memory is written from live text, so this is the one
  // place that must redact before saving rather than at read time (B-5).
  const redact = (text) => {
    const tagged = pathRedactor(rt.home)(text)
    return typeof rt.redactSecrets === 'function' ? rt.redactSecrets(tagged) : tagged
  }
  const org = orgHandlers({ botOf: id => rt.botOf?.(id), isPrivate: id => rt.isPrivate?.(id) === true, groups: groupAdapter(rt) })
  // The task commands are kept in a local so `task.submit` can be wrapped below without
  // duplicating the other five. The wrapper creates the delivery's pending acceptance in
  // the same draft, so commands.js commits both objects and their two events together.
  const taskCommands = taskHandlers()
  // Kept in a local for the same reason: `acceptance.decide` is wrapped so the decision and
  // the memory it leaves are committed together (M1b-5.1).
  const acceptanceCommands = acceptanceHandlers()
  const commands = createCommands({
    store,
    now,
    // `acceptance.decide` is answered with the revision of the acceptance itself (the to-do
    // row carries it, contract A12), and every task command that writes is answered with the
    // task's own revision, so the envelope leaves those comparisons to their handlers.
    rowRevisionCommands: new Set([...ROW_REVISION_COMMANDS, ...TASK_ROW_REVISION_COMMANDS, ...RUN_ROW_REVISION_COMMANDS, ...MEMORY_ROW_REVISION_COMMANDS]),
    handlers: {
      ...org,
      // A new company is born with the nine builtin templates: they ride in the same commit
      // as the company, so no screen ever shows a company without them. A company that is
      // missing one (a file written before 3.6b that was read-only at startup) is topped up
      // on the next call, which is why this one handler answers even when nothing else wrote.
      'company.init': (args) => {
        const outcome = org['company.init'](args)
        const added = seedBuiltinTemplates(args.state, args.now)
        if (added.length === 0) return outcome
        return {
          ...outcome,
          mutates: true,
          events: [...(outcome.events ?? []), { type: 'template.builtin-seeded', data: { count: added.length } }],
        }
      },
      ...projectHandlers({ groups: groupAdapter(rt) }),
      ...acceptanceCommands,
      // The card reaching Done leaves one decision row in the same commit (M1b-5.1), so a
      // decision cannot be remembered without being made.
      'acceptance.decide': withDoneMemory(acceptanceCommands['acceptance.decide'], { redact: text => redact(text) }),
      // The project board's cards: one table and the five commands a card moves through.
      ...taskCommands,
      // `task.submit` moves the card and creates its pending acceptance in one commit
      // (contract §5.3.4). The row shape and the one-pending rule live in acceptances.js,
      // so the task command itself stays about the card.
      'task.submit': submitWithAcceptance(taskCommands['task.submit']),
      // Dispatch: one Run per dispatch, the brief is delivered before the row is committed.
      ...runHandlers({ rt }),
      ...templateHandlers(),
      // The profile is written by the same handler `employee.create` uses, so the
      // one-active-profile rule and the role lists have one implementation.
      ...spawnHandlers({ roster: botRoster(rt, warn), createEmployee: org['employee.create'], warn }),
      ...templateIoHandlers(),
      // The memory page's three commands (M1b-5.1). Writing happens on the two host events
      // below, never from a screen.
      ...memoryHandlers(),
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
    // The answer note saves outside the command envelope, so it borrows the command queue:
    // a note committed over a command's half-written state would lose that command's write.
    runExclusive: commands.runExclusive,
    groups: groupAdapter(rt),
    now,
    approvals: () => rt.approvalsView?.() ?? [],
    sessionBot: id => rt.selfOf?.(id),
    home: rt.home,
    // Two redactions in one lookup: the home becomes `<dsh-home>`, then the host's secret
    // redactor runs over the result, exactly as the SelfReview features do it. Read time is
    // when this runs, so a target already on disk is tagged too (B-5).
    redact,
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
  // ambiguous. The same save tops up the builtin templates a file written before 3.6b cannot
  // have: the nine rows are added once, in the file, not on every screen that lists them.
  // A read-only company keeps both for the next writable start.
  //
  // Neither the upgrade nor the seed moves the company revision: no screen has seen the older
  // shape, and a bump here would only make the first command after an upgrade look stale.
  const migration = store.migration()
  if (store.readOnly() === undefined) {
    void (async () => {
      const draft = structuredClone(store.state)
      const seeded = seedBuiltinTemplates(draft, now)
      if (migration === undefined && seeded.length === 0) return
      const events = [
        ...(migration === undefined ? [] : [{
          id: 'evt_migrated',
          cursor: draft.revision,
          at: new Date(now()).toISOString(),
          type: 'company/migrated',
          data: migration,
        }]),
        ...(seeded.length === 0 ? [] : [{
          id: 'evt_builtin_templates',
          cursor: draft.revision,
          at: new Date(now()).toISOString(),
          type: 'company/builtin-templates-seeded',
          data: { count: seeded.length },
        }]),
      ]
      try {
        await store.commit(draft)
        await store.appendEvents(events)
        store.clearMigration()
      } catch (error) {
        warn('ds-bot: could not write the company upgrade: %s', error?.message ?? String(error))
      }
    })()
  }
  // `rt.company` is what the HTTP layer and the tools call.
  rt.company = { dir, store, execute, commands: commands.commands, api, close: () => store.close() }
  Object.assign(rt, { companyExecute: execute, companyStore: store, companyApi: api, companyState: () => store.state })
  // M1b-5.1: a Bot's turn inside a project group is worth keeping, and so is a card reaching
  // Done (wrapped above). Neither rides the command envelope: a turn is not a screen action,
  // and bumping the company revision for every message would make an open board look stale
  // to the next click. Both still write through the command queue, so a row never lands on
  // another command's half-written state; the revision stays where the last command left it.
  const memoryEvent = (row) => ({
    id: `evt_${row.id}`,
    cursor: store.state.revision,
    at: new Date(row.created_at).toISOString(),
    type: 'memory.created',
    data: {
      memory_id: row.id,
      ownership_level: row.ownership_level,
      scope_id: row.scope_id,
      kind: row.kind,
      source_kind: row.source_refs?.[0]?.type ?? 'turn',
    },
  })
  const keepMemory = async (build) => {
    try {
      await commands.runExclusive(async () => {
        const draft = structuredClone(store.state)
        const row = build(draft)
        if (row === undefined) return
        const added = appendMemory(draft, row)
        if (!added.created) return
        const events = [memoryEvent(added.row)]
        if (added.pruned.length > 0) {
          events.push({
            id: `evt_pruned_${added.row.id}`,
            cursor: draft.revision,
            at: new Date(added.row.created_at).toISOString(),
            type: 'memory.pruned',
            data: { count: added.pruned.length, oldest_created_at: added.prunedOldest },
          })
        }
        await store.commit(draft)
        await store.appendEvents(events)
      })
    } catch (error) {
      // A memory that cannot be kept must not fail the turn that produced it.
      warn('ds-bot: could not keep a memory: %s', error instanceof Error ? error.message : String(error))
    }
  }
  // A turn's text arrives as assistant messages between turn/start and turn/end; the end is
  // the moment the row is written, and only for a session that speaks in a group.
  const turnText = new Map()
  const onSessionEvent = (session, event) => {
    if (event?.type === 'assistant/message') {
      const text = (event.data?.message?.content ?? [])
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text)
        .join('\n')
        .trim()
      if (text === '') return
      // The last piece of text is the one that stands for the turn: earlier pieces are the
      // Bot thinking out loud before it settles on the answer.
      turnText.set(session.id, { turn: event.data?.turn, text, messageId: event.data?.message?.id ?? null })
      return
    }
    if (event?.type !== 'turn/end') return
    const held = turnText.get(session.id)
    turnText.delete(session.id)
    if (held === undefined || held.text === '') return
    const turn = held.turn ?? event.data?.turn
    if (turn === undefined) return
    const owner = rt.groupOwners?.get?.(session.id)
    if (owner === undefined) return
    const { botId, roomId } = owner
    void keepMemory((draft) => {
      const project = Object.values(draft.projects ?? {}).find(entry => entry.group_chat_ref === roomId)
      if (project === undefined) return undefined
      const employee = Object.values(draft.employees ?? {}).find(profile => profile.bot_id === botId && profile.status === 'active')
      return memoryRow({
        at: now(),
        projectId: project.id,
        kind: 'fact',
        statement: redact(held.text),
        sourceRefs: [{ type: 'message_anchor', id: held.messageId ?? `${session.id}:${turn}`, anchor: `${session.id}#${turn}` }],
        employeeId: employee?.id ?? null,
        botId,
        origin: { session_id: session.id, turn },
        idempotencyKey: `turn:${session.id}:${turn}`,
      })
    })
  }
  if (typeof rt.ctx?.on === 'function') {
    const off = rt.ctx.on('session/event', onSessionEvent)
    // The listener lasts exactly as long as the plugin, the way the HTTP route does.
    if (typeof off === 'function') rt.ctx.effect?.(() => off, 'ds-bot: company memory')
  }
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
