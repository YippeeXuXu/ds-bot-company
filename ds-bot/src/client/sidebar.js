import { createElement as h, Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { FishLogo } from './dsh-primitives.js'
import { isMainOf } from './sources.js'
import { currentPart, previewOf, relativeShort } from './text.js'
import { PlusIcon, SearchIcon, SidebarIcon, GaugeIcon, ClockIcon, GearIcon, PinMarkIcon, ConnectorIcon, SwitchIcon, CloudDownloadIcon, SignOutIcon } from './icons.js'
import { MAIN_LOOK } from './characters.js'
import { botState, BotMark, BotAvatar, RoomAvatar } from './mark.js'
import { reducedMotion } from './activity-row.js'
import { Shimmer, workPhrase } from './cells.js'
import { springEasing, SPRING_SHAPE, useViewport, viewBottom } from './motion.js'
import { hostText, t } from './i18n.js'
import { clientErrors } from './diagnostics.js'
import { showsDshRow } from './dsh-offer.js'
import { frameLayout, dragColumn, RAIL_WIDTH, FALLBACK_SIDEBAR_WIDTH, userSidebarToggle } from './frame-layout.js'
import { chatRoom, dshCollapsed } from './frame-watch.js'
import { call } from './api.js'

// -------------------------------------------------------------------------
// Sidebar

// Manual "Mark as Unread" lasts until the conversation is opened again.
function useMarkedUnread(id, active, marked, actions) {
  useEffect(() => {
    if (active && marked) actions.clearUnread(id)
  }, [active, marked])
}

const PinMark = () => h('span', { className: 'bt-pin', 'aria-hidden': true }, h(PinMarkIcon))

// The rail shows a row's name only on hover; the wide list does so when the name is
// cut, which only the laid-out row can tell, so it is measured as the pointer enters.
const nameIfCut = (event) => {
  const row = event.currentTarget
  const name = row.querySelector('.bt-row-title')
  if (name && name.scrollWidth > name.clientWidth) row.title = name.textContent
  else row.removeAttribute('title')
}

// Whether an approval waits for the user: for a Bot, in any of its Sessions; for a group,
// from any of its members there.
const useApproval = (useWork, match) => (useWork ? useWork(work => (work.approvals ?? []).some(match)) : false)

// Work running in group Sessions, as "botId|tool" keys so a row redraws only when it
// changes: the groups one Bot works in, or the members at work in one group.
// Picked as text, so a row redraws only when what it shows changes.
const useGroupWork = (useWork, pick) => (useWork ? useWork(work => JSON.stringify(pick(work.rooms ?? {}))) : '[]')
const workKeys = text => JSON.parse(text)
const doingOf = ({ tool, said, note, target, switching }) => ({ tool, said, note, target, switching })
const workLine = (lead, doing, more) => h(Shimmer, null, `${lead} · ${workPhrase(doing)}…${more > 0 ? ` +${more}` : ''}`)
// The row already names the Bot; its own-chat preview is just what it is doing.
const doingLine = doing => h(Shimmer, null, `${workPhrase(doing)}…`)
// The Bots and groups a Bot waits for (handoffs.js), by the names they have now.
const waitingFor = (roster, waits) => {
  const names = [...(waits?.bots ?? []).map(id => roster.byId[id]?.name), ...(waits?.rooms ?? []).map(id => roster.roomsById[id]?.name)].filter(Boolean)
  return names.length === 0 ? '' : t('Waiting for {names}', { names: names.join(t(' and ')) })
}

function BotRow({ bot, roster, actions, useSessions, useSessionStatus, useSessionRetainInfo, useActivity, useWork, wide, marked }) {
  const id = bot.id
  const part = currentPart(bot)
  const preview = useSessions(list => previewOf(list, part, roster.exchangeTurns[part]))
  const running = useSessionStatus(map => map.get(part)?.running === true)
  const active = useSessionRetainInfo(part, info => (info?.retainedBy?.mainView ?? 0) > 0)
  const unread = useSessionStatus(map => map.get(part)?.completionUnread === true || map.get(part)?.pendingInteraction !== undefined) || (marked && !active)
  useMarkedUnread(id, active, marked, actions)
  const main = isMainOf(roster, id)
  const tile = roster.mainBotId === id
  const approval = useApproval(useWork, entry => entry.botId === id)
  const alert = roster.questions?.[part] !== undefined || approval
  const doing = useActivity(map => map[id])
  // Work in a group runs in a Session of its own, so the Bot's chat stays idle meanwhile.
  const groups = workKeys(useGroupWork(useWork, rooms => Object.entries(rooms).flatMap(([roomId, entries]) => entries.filter(entry => entry.botId === id).map(entry => ({ id: roomId, ...doingOf(entry) })))))
  const away = !running && groups.length > 0
  const state = botState(running || away, doing, alert)
  // A Bot running in its own chat previews what it is doing, like a group's row.
  const runningLine = running && doing ? doingLine(doing) : null
  const awayLine = away ? workLine(roster.roomsById[groups[0].id]?.name ?? t('a group chat'), groups[0], groups.length - 1) : null
  const waits = workKeys(useWork ? useWork(work => JSON.stringify(work.waiting?.[id] ?? null)) : 'null')
  const waitsFor = state === 'waiting' ? waitingFor(roster, waits) : ''
  if (bot.hidden && !active && !main) return null
  const onContextMenu = (event) => {
    event.preventDefault()
    actions.openMenu({ kind: 'bot', id, x: event.clientX, y: event.clientY })
  }
  const pinned = bot.pinned === true && !tile
  const label = [bot.name, main ? t('Main Bot') : '', pinned ? t('Pinned') : '', running || away ? t('Working') : '', waitsFor, approval ? t('Waiting for your approval') : alert ? t('Waiting for your answer') : '', unread ? t('Unread activity') : ''].filter(Boolean).join(', ')
  if (tile && wide) {
    return h('div', { className: 'bt-tile-wrap' }, h('button', {
      type: 'button', className: 'bt-tile', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
      'data-bot-id': id, title: preview || bot.name, onClick: () => actions.openSession(id), onContextMenu,
    },
    h(BotAvatar, { bot, size: 60, state, main: true }),
    h('span', { className: 'bt-tile-name' }, bot.name),
    bot.role ? h('span', { className: 'bt-chip' }, bot.role) : null))
  }
  return h('button', {
    type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
    'data-bot-id': id, title: wide ? undefined : bot.name, onMouseEnter: wide ? nameIfCut : undefined, onClick: () => actions.openSession(id), onContextMenu,
  },
  h(BotAvatar, { bot, size: wide ? 36 : 44, state, main }),
  pinned && !wide ? h(PinMark) : null,
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, bot.name), pinned ? h(PinMark) : null),
    runningLine ? h('span', { className: 'bt-row-preview' }, runningLine)
      : awayLine ? h('span', { className: 'bt-row-preview' }, awayLine)
        : waitsFor ? h('span', { className: 'bt-row-preview' }, waitsFor)
          : preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
  wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true })
    : !wide && !active && (alert || unread) ? h('span', { className: `bt-dot${alert ? ' bt-dot-wait' : ''}`, 'aria-hidden': true }) : null)
}

function RoomRow({ room, roster, actions, useSessions, useSessionStatus, useSessionRetainInfo, useWork, wide, marked }) {
  const id = room.id
  // The group's own Session is a chain of parts; the row shows the current one.
  const sessionId = room.sessionId ?? id
  const fallback = useSessions(list => previewOf(list, sessionId))
  const preview = room.preview?.replace(/\s+/g, ' ').trim() || fallback
  const active = useSessionRetainInfo(sessionId, info => (info?.retainedBy?.mainView ?? 0) > 0)
  const unread = useSessionStatus(map => map.get(sessionId)?.completionUnread === true) || (marked && !active)
  useMarkedUnread(id, active, marked, actions)
  const approval = useApproval(useWork, entry => entry.roomId === id)
  const members = workKeys(useGroupWork(useWork, rooms => (rooms[id] ?? []).filter(entry => entry.botId !== undefined).map(entry => ({ id: entry.botId, ...doingOf(entry) }))))
  const first = roster.byId[members[0]?.id]
  const workingLine = first ? workLine(first.name, members[0], members.length - 1) : null
  if (room.hidden && !active) return null
  const pinned = room.pinned === true
  const label = [room.name, pinned ? t('Pinned') : '', members.length > 0 ? t('Working') : '', approval ? t('Waiting for your approval') : ''].filter(Boolean).join(', ')
  return h('button', {
    type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
    'data-room-id': id, title: wide ? undefined : room.name, onMouseEnter: wide ? nameIfCut : undefined, onClick: () => actions.openSession(id),
    onContextMenu: (event) => { event.preventDefault(); actions.openMenu({ kind: 'room', id, x: event.clientX, y: event.clientY }) },
  },
  h(RoomAvatar, { room, roster, size: wide ? 36 : 44 }),
  pinned && !wide ? h(PinMark) : null,
  wide ? h('span', { className: 'bt-row-body' },
    h('span', { className: 'bt-row-name' }, h('span', { className: 'bt-row-title' }, room.name), pinned ? h(PinMark) : null),
    workingLine ? h('span', { className: 'bt-row-preview' }, workingLine) : preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
  wide && approval && !active ? h('span', { className: 'bt-unread bt-unread-wait', 'aria-hidden': true })
    : wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true })
      : !wide && !active && (approval || unread) ? h('span', { className: `bt-dot${approval ? ' bt-dot-wait' : ''}`, 'aria-hidden': true }) : null)
}

// One expanded DSH Agent Session row: title, relative stamp, rename field, and a
// context menu for rename/archive.
function AgentSessionRow({ session, agent, actions, renaming, index }) {
  const input = useRef(null)
  useLayoutEffect(() => {
    if (!renaming) return
    input.current?.focus()
    input.current?.select()
  }, [renaming])
  if (renaming) {
    const commit = (keep) => {
      const value = input.current?.value ?? ''
      if (!keep || value.trim() === '' || value.trim() === session.title) { actions.endAgentRename(); return }
      // The editor closes only after the rename landed; a failure keeps it open.
      void (async () => {
        try {
          await actions.renameAgentSession(agent.id, session.id, value)
          actions.endAgentRename()
        } catch (error) {
          actions.reportError(error, 'agent-rename')
        }
      })()
    }
    return h('div', { className: 'bt-agent-sub-row bt-agent-edit', style: { '--i': index } },
      h('input', {
        ref: input, defaultValue: session.title, 'aria-label': t('Rename'),
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') commit(true)
          else if (event.key === 'Escape') commit(false)
        },
        onBlur: () => commit(true),
      }))
  }
  return h('button', {
    type: 'button', className: 'bt-agent-sub-row', 'aria-current': session.active ? 'page' : undefined, style: { '--i': index },
    onClick: () => actions.openAgentSession(session.id),
    onContextMenu: (event) => {
      event.preventDefault()
      event.stopPropagation()
      actions.openMenu({ kind: 'agent-session', id: session.id, agentId: agent.id, x: event.clientX, y: event.clientY })
    },
  },
  h('span', { className: 'bt-agent-sub-title' }, session.title),
  h('span', { className: 'bt-agent-sub-time' }, session.at > 0 ? relativeShort(session.at) : ''))
}

// The DSH Agent row: a plain dsh Session list lives in the Bot workspace, so it
// sits among the Bots with the harness's own whale mark.
function AgentRow({ agent, actions, useSessions, useSessionStatus, useUi, wide, marked }) {
  const info = useSessions(list => JSON.stringify(agent.sessions.map((id) => {
    const row = list.byId[id]
    return {
      id,
      // A blank Session's title is the workspace folder name; show the label instead.
      title: row?.blank === true ? '' : (row?.displayTitle ?? row?.title ?? ''),
      at: row?.updatedAt ?? 0,
      running: row?.running === true,
      active: (row?.retainedBy?.mainView ?? 0) > 0,
    }
  }).sort((a, b) => b.at - a.at)))
  const statusInfo = useSessionStatus(map => JSON.stringify(agent.sessions.map(id => ({
    id, running: map.get(id)?.running === true, unread: map.get(id)?.completionUnread === true,
  }))))
  const statuses = Object.fromEntries(JSON.parse(statusInfo).map(entry => [entry.id, entry]))
  const sessions = JSON.parse(info).map(session => ({
    ...session,
    running: statuses[session.id]?.running ?? session.running,
    unread: statuses[session.id]?.unread ?? false,
    title: session.title === '' ? t('New session') : session.title,
  }))
  const renaming = useUi(value => value.renameAgent)
  const active = sessions.some(session => session.active)
  const running = sessions.some(session => session.running)
  const unread = sessions.some(session => session.unread) || (marked && !active)
  useMarkedUnread(agent.id, active, marked, actions)
  const preview = sessions[0]?.title ?? t('New session')
  const label = ['DSH Agent', running ? t('Working') : '', unread ? t('Unread activity') : ''].filter(Boolean).join(', ')
  const open = active && wide
  return h('div', { className: 'bt-agent' },
    h('button', {
      type: 'button', className: 'bt-row', 'aria-label': label, 'aria-current': active ? 'page' : undefined,
      'data-agent-id': agent.id, title: wide ? undefined : 'DSH Agent', onClick: () => actions.openAgent(agent.id),
      onContextMenu: (event) => { event.preventDefault(); actions.openMenu({ kind: 'agent', id: agent.id, x: event.clientX, y: event.clientY }) },
    },
    h('span', { className: `bt-agent-ava${running ? ' bt-run' : ''}` }, h(FishLogo, { size: wide ? 22 : 24 })),
    wide ? h('span', { className: 'bt-row-body' },
      h('span', { className: 'bt-row-name' }, 'DSH Agent'),
      preview ? h('span', { className: 'bt-row-preview' }, preview) : null) : null,
    wide && unread && !active ? h('span', { className: 'bt-unread', 'aria-hidden': true })
      : !wide && unread && !active ? h('span', { className: 'bt-dot', 'aria-hidden': true }) : null),
    h('div', { className: 'bt-agent-sub', 'data-open': open || undefined },
      h('div', { className: 'bt-agent-sub-in' },
        h('button', { type: 'button', className: 'bt-agent-sub-row bt-agent-new', style: { '--i': 0 }, onClick: () => { void actions.newAgentSession(agent.id).catch(error => actions.reportError(error, 'agent-session')) } },
          h(PlusIcon), h('span', { className: 'bt-agent-sub-title' }, t('New session'))),
        sessions.map((session, index) => h(AgentSessionRow, {
          key: session.id, session, agent, actions, index: index + 1,
          renaming: renaming === session.id,
        })))))
}

// List rows glide to new places on a spring.
const GLIDE = springEasing(1000, 63)

function useListGlide(listRef, layout, key) {
  const tops = useRef({ layout, map: new Map() })
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const next = new Map()
    const still = reducedMotion() || tops.current.layout !== layout
    for (const row of list.querySelectorAll('[data-bot-id],[data-room-id],[data-agent-id]')) {
      const id = row.dataset.botId ?? row.dataset.roomId ?? row.dataset.agentId
      // offsetTop ignores transforms, so a glide in flight does not skew the next one.
      const top = row.offsetTop
      next.set(id, top)
      const before = tops.current.map.get(id)
      if (!still && before !== undefined && Math.abs(before - top) > 0.5) {
        row.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], GLIDE)
      }
    }
    tops.current = { layout, map: next }
  }, [layout, key])
}

// In the Bot view the left column is ours, drawn on <body> over the shell's
// collapsed sidebar: the open column or the avatar rail push the conversation
// over, the drawer floats above it. Its right edge drags the open width, and
// down to the rail.
function LeftColumn({ mode, width, onGrip, children }) {
  return createPortal(h('div', { className: 'bt-leftcol', 'data-left': mode, style: { width: `${width}px` } },
    children,
    h('div', { className: 'bt-leftcol-grip', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': t('Resize sidebar'), title: t('Resize sidebar'), onPointerDown: onGrip })), document.body)
}

// The top-left switch hides the whole column and brings it back. Under a
// Windows title bar it takes the shell's own place in the title band; elsewhere
// it shows only while the column is hidden, since the column's own top row
// carries it otherwise.
function TitleToggle({ hidden, onToggle }) {
  if (typeof document === 'undefined') return null
  const titlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  if (!titlebar && !hidden) return null
  const label = t(hidden ? 'Expand sidebar' : 'Collapse sidebar')
  return createPortal(h('button', {
    type: 'button', className: titlebar ? 'bt-title-toggle' : 'bt-round bt-title-toggle', 'aria-label': label, title: label, onClick: onToggle,
  }, h(SidebarIcon)), document.body)
}

// The Bot-API-down hint cannot send the user to Settings → Feedback: its
// diagnostics request needs the same API. What still works in this state is
// the last error this window recorded, and the engine's own startup output —
// its console, or the app's startup error box (#516).
const bootHint = () => {
  const last = clientErrors().at(-1)?.text
  return last === undefined
    ? t('The Bot team could not start. The engine’s startup output — its console, or the app’s startup error box — has the cause.')
    : t('The Bot team could not start. {error}. The engine’s startup output — its console, or the app’s startup error box — has the cause.', { error: last })
}

// The company model feeds the sidebar's company header and its context lists.
// It is read through the same Bot API as the company pages, and the pages say
// when they changed something so the column does not keep a stale name or count.
function useCompanyModel(pageKey) {
  const [model, setModel] = useState(null)
  useEffect(() => {
    let live = true
    const load = () => {
      call('company-model', {}, undefined).then(value => { if (live) setModel(value) }, () => {})
    }
    load()
    const onChange = () => load()
    window.addEventListener('bt-company-changed', onChange)
    return () => { live = false; window.removeEventListener('bt-company-changed', onChange) }
  }, [pageKey])
  return model
}

// The project chat's column needs the same decision count the page shows.
// A failure stays silent here: the column is navigation, not the source of truth.
function useCompanyTodos(pageKey) {
  const [data, setData] = useState(null)
  useEffect(() => {
    let live = true
    const load = () => {
      call('company-todos', {}, undefined).then(value => { if (live) setData(value) }, () => {})
    }
    load()
    const onChange = () => load()
    window.addEventListener('bt-company-changed', onChange)
    return () => { live = false; window.removeEventListener('bt-company-changed', onChange) }
  }, [pageKey])
  return data
}

// The three marks the prototype uses: a building, a grid, a chat bubble.
const NAV_PATHS = {
  company: 'M4 20V6.5A2.5 2.5 0 0 1 6.5 4H14a2 2 0 0 1 2 2v14M16 10h2.5A1.5 1.5 0 0 1 20 11.5V20M2 20h20M7 8h4M7 12h4M7 16h4',
  projects: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  chats: 'M20 12a8 8 0 0 1-8 8H7l-4 3v-6.5A8 8 0 0 1 11 4h1a8 8 0 0 1 8 8z',
}
const CoIcon = ({ name }) => h('svg', {
  className: 'bt-co-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
}, h('path', { d: NAV_PATHS[name] }))

const projectStage = status => status === 'active' ? t('In progress') : status === 'archived' ? t('Archived') : status === 'paused' ? t('Paused') : t('Setup')

export function TeamSidebar(props) {
  const { wide, useRoster, useUi, useSessions, actions } = props
  const listRef = useRef(null)
  const roster = useRoster(value => value)
  const markedUnread = useUi(value => value.unread)
  const uiNow = useUi(value => value)
  const pageKey = uiNow.companyPage ? `${uiNow.companyPage.kind}:${uiNow.companyPage.id ?? ''}` : 'chat'
  const company = useCompanyModel(pageKey)
  const companyTodos = useCompanyTodos(pageKey)
  const activeSession = useSessions(list => Object.values(list.byId ?? {}).find(session => (session?.retainedBy?.mainView ?? 0) > 0)?.id ?? null)
  const [projectFilter, setProjectFilter] = useState('active')
  const [chatQuery, setChatQuery] = useState('')
  props.useRegistry(value => value)
  const frameSnap = props.useFrame ? props.useFrame(value => value) : { viewport: typeof window === 'undefined' ? 0 : window.innerWidth, sidebarWidth: FALLBACK_SIDEBAR_WIDTH, collapsedWidth: 0 }
  const pref = props.useSidebarPref ? props.useSidebarPref(value => value) : 'open'
  const layout = frameLayout({
    viewport: frameSnap.viewport, sidebarWidth: frameSnap.sidebarWidth,
    pref, drawer: uiNow.leftDrawer === true,
    panel: uiNow.details ? { view: uiNow.view, yielded: uiNow.panelYield === true } : null,
  })
  // A drag of the column's edge shows where it would land, live.
  const [drag, setDrag] = useState(null)
  const mode = drag?.left ?? layout.left
  const wideContent = mode !== 'rail'
  const updated = useSessions(list => {
    const stamps = {}
    for (const id of list.ids) stamps[id] = list.byId[id]?.updatedAt ?? 0
    return JSON.stringify(stamps)
  })
  const order = useMemo(() => {
    const stamps = JSON.parse(updated)
    const entries = [
      ...roster.bots.filter(bot => bot.id !== roster.mainBotId).map(bot => ({ kind: 'bot', item: bot, at: stamps[currentPart(bot)] ?? bot.createdAt })),
      ...roster.rooms.map(room => ({ kind: 'room', item: room, at: stamps[room.id] ?? room.createdAt })),
      // The Agent sorts by its most recent Session, falling back to when it was added.
      ...(roster.agents ?? []).map(agent => ({ kind: 'agent', item: agent, at: Math.max(0, ...agent.sessions.map(id => stamps[id] ?? 0)) || agent.createdAt })),
    ]
    return entries.sort((a, b) => Number(Boolean(b.item.pinned)) - Number(Boolean(a.item.pinned)) || b.at - a.at)
  }, [roster, updated])
  const main = roster.byId[roster.mainBotId]
  useListGlide(listRef, wideContent, order.map(entry => entry.item.id).join(','))
  useLandOnMainBot(roster, useSessions, actions)

  // Our column pushes the conversation over by what it takes beyond the shell's
  // collapsed track; a drawer floats over the rail's place, so it pushes as much
  // as the rail and the chat stays put when it opens or closes.
  const openWidth = drag?.width ?? frameSnap.sidebarWidth
  const ourWidth = mode === 'rail' ? RAIL_WIDTH : openWidth
  const pushed = mode === 'open' ? openWidth : mode === 'hidden' ? 0 : RAIL_WIDTH
  useLayoutEffect(() => {
    if (typeof document === 'undefined') return
    chatRoom.setLeft(Math.max(0, pushed - (frameSnap.collapsedWidth ?? 0)))
    // The company pages stand beside the column rather than over it; this is the
    // offset their fixed surface starts from.
    document.documentElement.style.setProperty('--bt-company-left', `${pushed}px`)
  }, [pushed, frameSnap.collapsedWidth])
  useEffect(() => () => {
    if (typeof document === 'undefined') return
    chatRoom.setLeft(null)
    document.documentElement.style.removeProperty('--bt-company-left')
  }, [])

  // The edge drag: live while the pointer moves, the column's new state on release.
  // Per frame the drag writes the column's own inline style and each conversation
  // column's inline margin — the same path the panel's resize takes — so nothing
  // re-renders or restyles the chat while the pointer moves. A render only happens
  // when the drag crosses the rail's snap line, and the spring (`data-folding`)
  // rides that switch alone: it comes off when the switch settles, so a drag that
  // keeps going afterwards follows the cursor frame by frame again.
  const settleTimer = useRef(0)
  const springTimer = useRef(0)
  const startDrag = (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    clearTimeout(settleTimer.current)
    clearTimeout(springTimer.current)
    const grip = event.currentTarget
    const column = grip.parentElement
    // A re-grab can land while a previous spring still stands: the new drag owns
    // the column from here, so its fold state starts clean.
    delete column.dataset.folding
    grip.setPointerCapture?.(event.pointerId)
    chatRoom.hold(true)
    const columns = chatRoom.columns()
    for (const col of columns) col.style.setProperty('transition', 'none', 'important')
    const offLeft = frameSnap.collapsedWidth ?? 0
    let last = null
    let liveLeft = mode
    let done = false
    const write = (at) => {
      const width = at.left === 'rail' ? RAIL_WIDTH : at.width
      column.style.width = `${width}px`
      column.style.setProperty('--bt-lc-w', `${width}px`)
      const push = Math.max(0, (at.left === 'open' ? width : RAIL_WIDTH) - offLeft)
      for (const col of columns) col.style.setProperty('margin-left', `${push}px`, 'important')
    }
    // A snap crossing arms the spring for the switch's glide; the timer takes it
    // back off once the switch has had its duration.
    let springUntil = 0
    const springOff = () => {
      springUntil = 0
      delete column.dataset.folding
      for (const col of columns) col.style.setProperty('transition', 'none', 'important')
    }
    const springOn = () => {
      column.dataset.folding = ''
      for (const col of columns) col.style.setProperty('transition', `margin-left ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}`, 'important')
      springUntil = performance.now() + SPRING_SHAPE.duration
      clearTimeout(springTimer.current)
      springTimer.current = setTimeout(springOff, SPRING_SHAPE.duration)
    }
    const track = (x) => {
      last = dragColumn(x, window.innerWidth)
      if (last.left !== liveLeft) {
        liveLeft = last.left
        if (!reducedMotion()) springOn()
        setDrag(last)
      }
      write(last)
    }
    const onMove = (move) => track(move.clientX)
    // The rules and props take the landed geometry back over; while the fold's
    // spring still runs this waits it out so the landing does not snap. The
    // inline `width` stays: it is the landed geometry, and React writes its width
    // prop only when the value changes, so removing it would leave the edge at
    // its CSS fallback (57px on the rail).
    const finish = () => {
      clearTimeout(springTimer.current)
      if (column.isConnected && last !== null) chatRoom.setLeft(Math.max(0, (last.left === 'open' ? last.width : RAIL_WIDTH) - offLeft))
      for (const col of columns) { col.style.removeProperty('margin-left'); col.style.removeProperty('transition') }
      column.style.removeProperty('--bt-lc-w')
      delete column.dataset.folding
      chatRoom.hold(false)
    }
    const ends = ['pointerup', 'pointercancel', 'lostpointercapture']
    const onEnd = (end) => {
      if (done) return
      done = true
      if (end.type === 'pointerup') track(end.clientX)
      grip.removeEventListener('pointermove', onMove)
      for (const name of ends) grip.removeEventListener(name, onEnd)
      setDrag(null)
      if (last === null) { finish(); return }
      // The drag is the latest explicit gesture: it takes back a yielded panel's room.
      actions.setPanelYield?.(false)
      if (last.left === 'rail') { actions.setLeftDrawer?.(false); actions.setSidebarPref?.('rail') }
      else {
        actions.setSidebarWidth?.(last.width)
        actions.setSidebarPref?.('open')
        actions.setLeftDrawer?.(last.left === 'drawer')
      }
      if (springUntil === 0) finish()
      else settleTimer.current = setTimeout(finish, Math.max(0, springUntil - performance.now()) + 60)
    }
    grip.addEventListener('pointermove', onMove)
    for (const name of ends) grip.addEventListener(name, onEnd)
  }

  // In the Bot view the shell's own sidebar stays collapsed under our column. A
  // flip we did not ask for is the user's own switch gesture (the shell's button
  // or shortcut where it still reaches), unless the width just crossed the
  // shell's auto-collapse line, which re-applies the shell's own rule.
  const dsh = useRef(null)
  const requested = useRef(false)
  // The request mark always lapses on its own: a re-render before the shell's
  // flip must not leave it set, or the user's next switch would read as ours.
  // A lapse checks the shell again, since our flip and another one landing in
  // the same frame cancel out and no flip arrives to settle it.
  const requestLapse = useRef(0)
  const [lapsed, setLapsed] = useState(0)
  useEffect(() => () => clearTimeout(requestLapse.current), [])
  // The window's own resize event lands before the shell's next-frame measure,
  // so it dates a width change even while our frame source still holds the old one.
  const resizedAt = useRef(0)
  useEffect(() => {
    const onResize = () => { resizedAt.current = performance.now() }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const quiet = (on) => {
    // Our own collapse of the shell's sidebar lands at once: its slide would drag
    // the conversation across under our column.
    if (on) document.documentElement.setAttribute('data-bt-collapsing', '')
    else document.documentElement.removeAttribute('data-bt-collapsing')
  }
  useEffect(() => () => quiet(false), [])
  useLayoutEffect(() => {
    if (typeof document === 'undefined' || typeof actions.toggleSidebar !== 'function') return undefined
    const collapsed = dshCollapsed() ?? !wide
    const prev = dsh.current
    const viewport = window.innerWidth
    dsh.current = { collapsed, viewport }
    if (prev !== null && collapsed !== prev.collapsed) {
      if (requested.current) requested.current = false
      else if (!collapsed && userSidebarToggle({ before: prev, after: { collapsed, viewport }, sinceResize: performance.now() - resizedAt.current })) {
        toggleRef.current()
      }
    }
    if (collapsed) { requested.current = false; quiet(false); return undefined }
    if (requested.current) return undefined
    requested.current = true
    quiet(true)
    actions.toggleSidebar()
    clearTimeout(requestLapse.current)
    requestLapse.current = setTimeout(() => { requested.current = false; quiet(false); setLapsed(value => value + 1) }, 300)
    return undefined
  }, [wide, frameSnap.viewport, lapsed])

  // The drawer closes on a row pick, on Escape and on a press outside it.
  useEffect(() => {
    if (mode !== 'drawer') return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && event.target.closest('.bt-leftcol')) return
      actions.setLeftDrawer?.(false)
    }
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      actions.setLeftDrawer?.(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [mode])

  const navigate = (open, id) => {
    const result = open(id)
    if (uiNow.leftDrawer === true) actions.setLeftDrawer?.(false)
    return result
  }
  const rowActions = {
    ...actions,
    openSession: id => navigate(actions.openSession, id),
    openAgent: id => navigate(actions.openAgent, id),
    openAgentSession: id => navigate(actions.openAgentSession, id),
    newAgentSession: id => navigate(actions.newAgentSession, id),
  }
  const rowProps = { roster, actions: rowActions, useSessions, useUi, useSessionStatus: props.useSessionStatus, useSessionRetainInfo: props.useSessionRetainInfo, useActivity: props.useActivity, useWork: props.useWork, wide: wideContent }
  // Typing while the sidebar has focus starts a search.
  const typeToSearch = (event) => {
    if (event.defaultPrevented || event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return
    if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable]')) return
    event.preventDefault()
    actions.openPalette(event.key)
  }
  // The switch (top-left button, the shortcut) hides the whole column or brings
  // back the one it hid.
  const onToggle = () => actions.toggleLeftHidden?.()
  // The shell's sidebar shortcut is caught on its way down, before the shell's
  // own listener on window sees it: left to the shell, it would expand the shell's
  // sidebar first and our sync would pull it back, a visible flash.
  const toggleRef = useRef(onToggle)
  toggleRef.current = onToggle
  useEffect(() => {
    const onKey = (event) => {
      if (event.defaultPrevented || event.isComposing || !pressesShellShortcut(event, 'sidebar.left.toggle')) return
      if (event.target instanceof Element && event.target.closest('.xterm')) return
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      event.stopPropagation()
      toggleRef.current()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [])
  const page = uiNow.companyPage
  const companyData = company ?? {}
  const companyInfo = companyData.company ?? null
  const departments = companyData.departments ?? []
  const employees = companyData.employees ?? []
  const projects = companyData.projects ?? []
  const activeProjects = projects.filter(item => item.status === 'active').length
  // A project chat keeps the project column visible even though the page state is
  // null: the room is bound to one project and that is the context the user needs.
  const activeRoom = activeSession ? roster.roomsById?.[activeSession] : null
  const activeProject = !page && activeRoom ? projects.find(item => item.group_chat_ref === activeSession) ?? null : null
  const kind = activeProject ? 'projectchat' : page?.kind ?? 'chat'
  const currentProject = activeProject ?? (kind === 'detail' ? projects.find(item => item.id === page?.id) : null)
  const todoCount = companyTodos?.counts?.waiting_total ?? 0
  const companyName = companyInfo?.name ?? 'DS Company'
  const wantedChat = chatQuery.trim().toLowerCase()
  const chatEntries = order.filter(entry => !wantedChat || String(entry.item.name ?? '').toLowerCase().includes(wantedChat))
  const pinnedEntries = chatEntries.filter(entry => entry.item.pinned)
  const otherEntries = chatEntries.filter(entry => !entry.item.pinned)
  const mainEntry = main ? { kind: 'bot', item: main, at: 0 } : null
  const allEntries = mainEntry ? [mainEntry, ...otherEntries.filter(entry => entry.item.id !== main.id)] : otherEntries
  const renderEntry = entry => (entry.kind === 'bot'
    ? h(BotRow, { key: entry.item.id, ...rowProps, bot: entry.item, marked: markedUnread[entry.item.id] === true })
    : entry.kind === 'room'
      ? h(RoomRow, { key: entry.item.id, ...rowProps, room: entry.item, marked: markedUnread[entry.item.id] === true })
      : h(AgentRow, { key: entry.item.id, ...rowProps, agent: entry.item, marked: markedUnread[entry.item.id] === true }))
  const navButton = (mark, label, count, active, onClick) => h('button', {
    type: 'button', className: active ? 'is-active' : '', 'aria-current': active ? 'page' : undefined, onClick,
  },
    h(CoIcon, { name: mark }),
    h('span', { className: 'bt-co-nav-label' }, label),
    count === null ? null : h('span', { className: 'bt-co-count' }, count))
  const companyLink = (label, meta, active, onClick) => h(onClick ? 'button' : 'div', {
    type: onClick ? 'button' : undefined, className: 'bt-co-link' + (active ? ' is-active' : ''), onClick,
  },
    h('span', { className: 'bt-co-link-label' }, label),
    meta === null ? null : h('span', { className: 'bt-co-meta' }, meta))
  const projectVisible = item => projectFilter === 'all' || (projectFilter === 'archived' ? item.status === 'archived' : projectFilter === 'active' ? item.status === 'active' : item.status === 'setup')
  const projectRow = item => {
    const department = (item.source_department_ids ?? []).map(id => departments.find(entry => entry.id === id)?.name).filter(Boolean)[0] ?? ''
    const coordinator = employees.find(entry => entry.id === item.acceptance_actor) ?? null
    return h('button', {
      type: 'button', key: item.id, className: 'bt-co-proj' + (currentProject?.id === item.id ? ' is-active' : ''),
      title: item.goal || undefined,
      onClick: () => {
        if (item.group_binding?.status === 'bound' && item.group_chat_ref && roster.roomsById?.[item.group_chat_ref]) actions.openSession(item.group_chat_ref)
        else actions.openCompanyPage('detail', item.id)
      },
    },
      h('span', { className: 'bt-co-proj-top' }, h('strong', null, item.name), h('span', { className: 'bt-co-proj-stage' }, projectStage(item.status))),
      h('span', { className: 'bt-co-proj-sub' }, [department, coordinator?.name].filter(Boolean).join(' · ') || t('No coordinator yet')))
  }
  const companySection = h('section', { className: 'bt-co-sec', 'aria-label': t('Company overview') },
    h('header', { className: 'bt-co-sec-head' }, h('span', null, t('Company overview'))),
    h('div', { className: 'bt-co-summary' },
      h('strong', null, companyName),
      h('span', null, t('{departments} departments · {employees} employees · {projects} projects', { departments: departments.length, employees: employees.length, projects: projects.length }))),
    h('div', { className: 'bt-co-links' },
      companyLink(t('Org chart'), t('{count} departments', { count: departments.length }), true, () => actions.openCompanyPage('company')),
      companyLink(t('Projects'), t('{count} projects', { count: projects.length }), false, () => actions.openCompanyPage('list')),
      companyLink(t('Active projects'), String(activeProjects), false, () => actions.openCompanyPage('list')),
      companyLink(t('Team'), t('{count} people', { count: employees.length }), false, null)))
  const projectSection = h('section', { className: 'bt-co-sec', 'aria-label': t('Projects') },
    h('header', { className: 'bt-co-sec-head' },
      h('span', null, t('Projects')),
      h('button', { type: 'button', className: 'bt-co-linkbtn', onClick: () => actions.openCompanyPage('list') }, t('Project list'), ' ›')),
    h('div', { className: 'bt-co-chips', role: 'group', 'aria-label': t('Project status') },
      [['active', 'In progress'], ['setup', 'Setup'], ['archived', 'Archived'], ['all', 'All']].map(([value, label]) => h('button', {
        type: 'button', key: value, className: 'bt-co-chip', 'aria-pressed': projectFilter === value,
        onClick: () => { setProjectFilter(value); window.dispatchEvent(new CustomEvent('bt-company-filter', { detail: value })) },
      }, t(label)))),
    h('div', { className: 'bt-co-plist' },
      projects.filter(projectVisible).length === 0
        ? h('p', { className: 'bt-co-empty' }, t('No projects in this view.'))
        : projects.filter(projectVisible).map(projectRow)),
    currentProject ? h('div', { className: 'bt-co-current' },
      h('span', { className: 'bt-co-group-label' }, t('This project')),
      h('strong', null, currentProject.name),
      h('button', { type: 'button', className: 'bt-co-linkbtn', onClick: () => actions.openCompanyPage('detail', currentProject.id) }, t('Project overview'), ' ›')) : null)
  // A bound project chat is still the Projects area: the column keeps the list
  // and adds the project's own overview links instead of the chat list.
  const projectChatSection = h('section', { className: 'bt-co-sec', 'aria-label': t('Projects') },
    h('header', { className: 'bt-co-sec-head' },
      h('span', null, t('Projects')),
      h('button', { type: 'button', className: 'bt-co-linkbtn', onClick: () => actions.openCompanyPage('list') }, t('Project list'), ' ›')),
    h('div', { className: 'bt-co-plist' }, projects.map(projectRow)),
    activeProject ? h('div', { className: 'bt-co-current' },
      h('span', { className: 'bt-co-group-label' }, t('This project')),
      h('strong', null, activeProject.name),
      h('div', { className: 'bt-co-links' },
        companyLink(t('Project overview'), null, false, () => actions.openCompanyPage('detail', activeProject.id)),
        companyLink(t('Waiting for you'), t('{count} cards', { count: todoCount }), false, () => actions.openCompanyPage('todos')),
        companyLink(t('Last activity'), t('Today'), false, null))) : null)
  const chatSection = h('section', { className: 'bt-co-sec bt-co-chatsec', 'aria-label': t('Chats') },
    h('header', { className: 'bt-co-sec-head' },
      h('span', null, t('Chats')),
      h('button', { type: 'button', className: 'bt-co-linkbtn', onClick: () => actions.openNewChat('new') }, '+ ', t('New'))),
    h('label', { className: 'bt-co-search' }, h(SearchIcon),
      h('input', { type: 'search', value: chatQuery, onChange: event => setChatQuery(event.target.value), placeholder: t('Search chats'), 'aria-label': t('Search chats') })),
    pinnedEntries.length > 0 ? h('div', { className: 'bt-co-group' },
      h('span', { className: 'bt-co-group-label' }, t('Pinned')),
      pinnedEntries.map(renderEntry)) : null,
    h('div', { className: 'bt-co-group' },
      h('span', { className: 'bt-co-group-label' }, t('All conversations')),
      allEntries.length > 0 ? allEntries.map(renderEntry) : h('p', { className: 'bt-co-empty' }, t('No chats match this search.'))))
  const top = wideContent
    ? h('div', { className: 'bt-co-brand' },
        h('span', { className: 'bt-co-mark', 'aria-hidden': true }, companyName.slice(0, 1)),
        h('span', { className: 'bt-co-brandtext' }, h('strong', null, companyName), h('small', null, t('Enterprise services · Intelligent workspace'))),
        h('button', { type: 'button', className: 'bt-round bt-side-collapse', 'aria-label': t('Collapse sidebar'), title: t('Collapse sidebar'), onClick: onToggle }, h(SidebarIcon)))
    : h('div', { className: 'bt-rail-top' },
        h(UpdateButton, { useUpdate: props.useUpdate, actions }),
        h('button', { type: 'button', className: 'bt-round bt-side-collapse', 'aria-label': t('Collapse sidebar'), title: t('Collapse sidebar'), onClick: onToggle }, h(SidebarIcon)),
        main ? h(BotRow, { ...rowProps, bot: main, marked: markedUnread[main.id] === true }) : roster.ready ? null : h('div', { className: 'bt-hint' }, uiNow.bootFailed ? bootHint() : t('Setting up your Main Bot…')),
        h('span', { className: 'bt-rail-sep', 'aria-hidden': true }))
  // The foot stands in for the shell's hidden footer: the account avatar, and on
  // the rail the new-chat button above it.
  const foot = wideContent
    ? h('div', { className: 'bt-leftcol-foot' }, h(AccountLauncher, { seat: false, actions }))
    : h('div', { className: 'bt-leftcol-foot bt-leftcol-foot-rail' },
        h('button', { type: 'button', className: 'bt-round', 'aria-label': t('New…'), title: t('New…'), onClick: () => actions.openNewChat('new') }, h(PlusIcon)),
        h(AccountLauncher, { seat: false, actions }))
  const railNav = h('nav', { className: 'bt-company-nav bt-company-rail', 'aria-label': t('Workspace navigation') },
    h('button', { type: 'button', 'aria-label': t('Company'), 'aria-current': kind === 'company' ? 'page' : undefined, title: t('Company'), onClick: () => actions.openCompanyPage('company') }, h('span', { 'aria-hidden': true }, '⌂')),
    h('button', { type: 'button', 'aria-label': t('Projects'), 'aria-current': kind !== 'company' && kind !== 'chat' ? 'page' : undefined, title: t('Projects'), onClick: () => actions.openCompanyPage('list') }, h('span', { 'aria-hidden': true }, '▦')),
    h('button', { type: 'button', 'aria-label': t('Chats'), 'aria-current': kind === 'chat' ? 'page' : undefined, title: t('Chats'), onClick: () => actions.closeCompanyPage() }, h('span', { 'aria-hidden': true }, '◉')))
  const content = h('div', { className: wideContent ? 'bt-side bt-side-company' : 'bt-side bt-rail', onKeyDown: typeToSearch },
    top,
    wideContent
      ? h('nav', { className: 'bt-co-nav', 'aria-label': t('Workspace navigation') },
          navButton('company', t('Company'), null, kind === 'company', () => actions.openCompanyPage('company')),
          navButton('projects', t('Projects'), projects.length, kind !== 'company' && kind !== 'chat', () => actions.openCompanyPage('list')),
          navButton('chats', t('Chats'), order.length + (main ? 1 : 0), kind === 'chat', () => {
            // A project chat keeps the Projects column; leaving it for Chats means
            // landing on a conversation outside the project as well.
            actions.closeCompanyPage()
            if (activeProject && main?.id) actions.openSession(main.id)
          }))
      : railNav,
    wideContent && roster.readOnly ? h('div', { className: 'bt-hint bt-read-only', role: 'status' }, hostText(roster.readOnly)) : null,
    h('div', { ref: listRef, className: wideContent ? 'bt-list bt-co-scroll' : 'bt-list', role: 'region', 'aria-label': t('Bot list') },
      wideContent
        ? (kind === 'company' ? companySection : kind === 'chat' ? chatSection : kind === 'projectchat' ? projectChatSection : projectSection)
        : (main ? h(BotRow, { ...rowProps, bot: main, marked: markedUnread[main.id] === true }) : roster.ready ? null : h('div', { className: 'bt-hint' }, uiNow.bootFailed ? bootHint() : t('Setting up your Main Bot…'))),
      wideContent ? null : order.map(renderEntry)),
    foot)
  return h(Fragment, null,
    h(TitleToggle, { hidden: mode === 'hidden', onToggle }),
    mode === 'hidden' ? null : h(LeftColumn, { mode, width: ourWidth, onGrip: startDrag }, content))
}

// The update button at the sidebar's top right: a cloud while a newer DS Bot —
// or a newer verified DSH — is available, then the install's progress and
// result. Its card has one row each for the bot and DSH, with their versions,
// the release notes link, and each row's own button.
function UpdateButton({ useUpdate, actions }) {
  const update = useUpdate(value => value)
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState(null)
  const [error, setError] = useState('')
  const [dshError, setDshError] = useState('')
  const button = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && (event.target.closest('.bt-update-pop') || button.current?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  const phase = update?.phase ?? 'idle'
  const dsh = update?.dsh
  const dshPhase = dsh?.phase ?? 'idle'
  const dshRow = showsDshRow(dsh, update?.app)
  // Hooks first: an update that turns visible after the sidebar mounted would
  // otherwise add hooks on a later render and crash the slot.
  const tick = useViewport()
  useLayoutEffect(() => {
    if (!open) return
    const rect = button.current?.getBoundingClientRect()
    if (rect) setBox({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: rect.bottom + 6 })
  }, [open, tick])
  if (!update?.available && !dshRow && phase === 'idle' && dshPhase === 'idle') return null
  const cloudPhase = phase === 'installing' || dshPhase === 'installing' ? 'installing' : phase !== 'idle' ? phase : dshPhase
  const toggle = () => setOpen(value => !value)
  const start = () => {
    setError('')
    void actions.installUpdate().catch(failure => setError(hostText(failure?.message ?? String(failure))))
  }
  const startDsh = () => {
    setDshError('')
    void actions.installDshUpdate().catch(failure => setDshError(hostText(failure?.message ?? String(failure))))
  }
  const label = phase === 'installing' ? t('Updating DS Company…')
    : dshPhase === 'installing' ? t('Updating DSH…')
      : phase === 'installed' ? t('DS Company {version} is installed. Restart DSH to use it.', { version: update.installed ?? update.latest })
        : phase === 'updated' ? t('DS Company {version} is installed.', { version: update.installed ?? update.latest })
        : dshPhase === 'installed' ? t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
          : update?.available ? t('DS Company {version} is available', { version: update.latest })
            : t('DSH {version} is available', { version: dsh?.verified })
  const message = error || (phase === 'failed' ? update.error : '')
  const dshMessage = dshError || (dshPhase === 'failed' ? dsh?.error : '')
  const dshText = dshPhase === 'installed'
    ? t('Restart DSH to start using DSH {version}.', { version: dsh.installed ?? dsh.verified })
    : dsh?.available === false && dsh?.blockedBy
      ? t('Update DS Company {version} first.', { version: dsh.blockedBy })
      : t('You have {version}.', { version: dsh?.current })
  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-round bt-update', 'data-phase': cloudPhase, 'aria-label': label, title: label,
      'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: toggle,
    }, h(CloudDownloadIcon, { done: phase === 'installed' || phase === 'updated' }), phase === 'failed' || dshPhase === 'failed' ? h('span', { className: 'bt-update-dot', 'aria-hidden': true }) : null),
    open && box ? createPortal(h('div', { className: 'bt-update-pop', role: 'dialog', 'aria-label': update?.available || phase !== 'idle' ? t('DS Company update') : t('DSH update'), style: box },
      update?.available || phase !== 'idle' ? h(Fragment, null,
        h('div', { className: 'bt-update-title' }, phase === 'installed' || phase === 'updated' ? t('Update installed') : t('DS Company {version}', { version: update.latest })),
        h('div', { className: 'bt-update-text' }, phase === 'installed'
          ? t('Restart DSH to start using DS Company {version}.', { version: update.installed ?? update.latest })
          : phase === 'updated' ? t('DS Company {version} is installed.', { version: update.installed ?? update.latest })
            : t('You have {version}.', { version: update.current })),
        message ? h('div', { className: 'bt-update-error', role: 'alert' }, t('The update did not finish: {reason}', { reason: message })) : null,
        h('div', { className: 'bt-update-actions' },
          update.notesUrl ? h('a', { className: 'bt-update-notes', href: update.notesUrl, target: '_blank', rel: 'noopener noreferrer' }, t("What's new")) : null,
          phase === 'installed' || phase === 'updated' ? null : h('button', {
            type: 'button', className: 'bt-update-go', disabled: phase === 'installing', onClick: start,
          }, phase === 'installing' ? t('Updating…') : phase === 'failed' ? t('Try again') : t('Update')))) : null,
      dshRow ? h('div', { className: 'bt-update-dsh' },
        h('div', { className: 'bt-update-title' }, t('DSH {version}', { version: dsh.verified })),
        h('div', { className: 'bt-update-text' }, dshText),
        dshMessage ? h('div', { className: 'bt-update-error', role: 'alert' }, t('The update did not finish: {reason}', { reason: dshMessage })) : null,
        h('div', { className: 'bt-update-actions' },
          dsh.kind === 'app' ? (dsh.available
            ? h('button', { type: 'button', className: 'bt-update-go', onClick: () => void actions.openAppUpdates(dsh.verified).catch(() => {}) }, t('Open updates'))
            : null)
            : !dsh.available && dshPhase === 'idle' ? null
              : dshPhase === 'installed' ? null
                : h('button', {
                  type: 'button', className: 'bt-update-go', disabled: dshPhase === 'installing', onClick: startDsh,
                }, dshPhase === 'installing' ? t('Updating…') : dshPhase === 'failed' ? t('Try again') : t('Update')))) : null), document.body) : null)
}

// Account seat of the Settings trigger: the visible label stays for assistive tech only.
export function YouAvatar() {
  return h('span', { className: 'bt-you-wrap' },
    h('span', { className: 'bt-you', 'aria-hidden': true }, h(BotMark, { look: MAIN_LOOK, size: 24 })),
    h('span', { style: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' } }, t('Settings')))
}

let openShellSettings = null
let openShellOnboarding = null
let shellShortcuts = null

export function holdShellShortcuts(shortcuts) {
  shellShortcuts = shortcuts
  return () => { if (shellShortcuts === shortcuts) shellShortcuts = null }
}

// DeepSeek Harness hands its settings opener only to the settings.launcher seat. When
// the Desktop's account menu holds that seat, its first item (Settings) is the way in;
// the Desktop on Windows and macOS takes shortcuts natively, so a synthetic key press
// reaches the shell only where the page delivers them (the Web, Linux).
export function openHarnessSettings() {
  // A frame first, so a Bot dialog that closes on this click leaves the modal stack.
  requestAnimationFrame(() => {
    if (openShellSettings) { openShellSettings(); return }
    const desktop = document.querySelector('button[aria-haspopup="menu"][data-signed-out]')
    if (desktop) openThroughMenu(desktop)
    else pressSettingsShortcut()
  })
}

// Opens one of the shell's own onboarding editors, such as the DeepSeek API key form.
export function openHarnessOnboarding(id) {
  requestAnimationFrame(() => {
    if (openShellOnboarding) openShellOnboarding(id)
    else openHarnessSettings()
  })
}

function openThroughMenu(trigger) {
  const before = new Set(document.querySelectorAll('[role="menu"]'))
  trigger.click()
  let frames = 0
  const look = () => {
    const menu = [...document.querySelectorAll('[role="menu"]')].find(node => !before.has(node))
    const item = menu?.querySelector('button[role="menuitem"]')
    if (item) item.click()
    else if (++frames < 30) requestAnimationFrame(look)
    else pressSettingsShortcut()
  }
  requestAnimationFrame(look)
}

function pressSettingsShortcut() {
  const binding = shellShortcuts?.catalog.getSnapshot().find(row => row.id === 'settings.open')?.binding
  if (!binding) return
  const held = new Set(binding.modifiers)
  window.dispatchEvent(new KeyboardEvent('keydown', {
    code: binding.code, key: binding.code === 'Comma' ? ',' : '', bubbles: true, cancelable: true,
    ctrlKey: held.has('control'), altKey: held.has('alt'), shiftKey: held.has('shift'), metaKey: held.has('meta'),
  }))
}

// Whether a key press is the shell's current binding for one of its shortcuts.
function pressesShellShortcut(event, id) {
  const binding = shellShortcuts?.catalog.getSnapshot().find(row => row.id === id)?.binding
  if (!binding) return false
  const held = new Set(binding.modifiers)
  return event.code === binding.code && event.ctrlKey === held.has('control') && event.altKey === held.has('alt')
    && event.shiftKey === held.has('shift') && event.metaKey === held.has('meta')
}

const NO_SUBSCRIBE = () => () => {}
const NO_SNAPSHOT = () => null

// The footer avatar opens an account menu above itself, with Bot settings as one
// entry. Shell panels hidden from the Bot sidebar (plugins, automation) live here too.
// `seat` is the shell's settings.launcher seat: at priority -10 the whale wins it
// over a shell account plugin's own launcher (the Desktop's "··· More"), which comes
// back in Agent mode; FooterAccount stands in while no seat exists at all.
export function AccountLauncher({ seat = true, settingsOpen, openSettings, openOnboarding, actions }) {
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    if (!seat) return undefined
    actions.seatAccount(true)
    return () => actions.seatAccount(false)
  }, [seat])
  const [box, setBox] = useState(null)
  const button = useRef(null)
  useEffect(() => { if (settingsOpen) setOpen(false) }, [settingsOpen])
  // The settings dialog links back to the shell's own settings (models, providers).
  useEffect(() => {
    if (!openSettings) return undefined
    openShellSettings = openSettings
    return () => { if (openShellSettings === openSettings) openShellSettings = null }
  }, [openSettings])
  useEffect(() => {
    if (!openOnboarding) return undefined
    openShellOnboarding = openOnboarding
    return () => { if (openShellOnboarding === openOnboarding) openShellOnboarding = null }
  }, [openOnboarding])
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (event.target instanceof Element && (event.target.closest('.bt-account-menu') || button.current?.contains(event.target))) return
      setOpen(false)
    }
    const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); button.current?.focus() } }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  // The shell's account plugin lends its sign-out operation; the item shows only
  // when the plugin's entry is there and its account snapshot says signed in. The
  // entry can arrive after this mounts, so its operations follow the entry.
  const signIn = actions.signInEntry?.() ?? null
  const ops = useMemo(() => signIn?.inject?.() ?? {}, [signIn])
  const accountSource = ops.hooks?.account
  const account = useSyncExternalStore(accountSource?.subscribe ?? NO_SUBSCRIBE, accountSource ? () => accountSource.getSnapshot() : NO_SNAPSHOT)
  const signedIn = signIn !== null && typeof ops.signOut === 'function' && account?.view?.status === 'credential-stored'
  const accountT = actions.accountT?.() ?? (key => key)
  const [confirm, setConfirm] = useState(null)
  const [busy, setBusy] = useState(false)
  const [signOutError, setSignOutError] = useState('')
  const askSignOut = async () => {
    setSignOutError('')
    let state = 'none'
    try {
      if (await ops.hasRunningAccountTasks?.()) state = 'running'
    } catch { state = 'unknown' }
    setConfirm(state)
  }
  const cancelSignOut = () => { setConfirm(null); setSignOutError('') }
  const runSignOut = async () => {
    setBusy(true)
    setSignOutError('')
    try {
      await ops.signOut()
      setConfirm(null)
      setOpen(false)
    } catch (error) {
      setSignOutError(String(error?.message ?? error))
    } finally {
      setBusy(false)
    }
  }
  const tick = useViewport()
  const anchor = () => {
    const rect = button.current?.getBoundingClientRect()
    if (rect) setBox({ left: rect.left, bottom: viewBottom() - rect.top + 5 })
  }
  useLayoutEffect(() => { if (open) anchor() }, [open, tick])
  const toggle = () => { if (!open) anchor(); setOpen(value => !value) }
  // Closing the menu drops a half-finished sign-out confirm with it.
  useEffect(() => {
    if (open) return
    setConfirm(null)
    setSignOutError('')
    setBusy(false)
  }, [open])
  const groups = [
    [
      [t('Usage'), GaugeIcon, () => actions.openSettings('usage')],
      [t('Connectors'), ConnectorIcon, () => actions.openConnectors()],
      [t('Automation tasks'), ClockIcon, () => actions.selectPanel('schedules')],
      [t('Bot settings'), GearIcon, () => actions.openSettings('general')],
    ],
    [
      [t('Switch to classic Agent mode'), SwitchIcon, () => actions.setSurface('agent')],
    ],
  ]
  if (signedIn) groups.push([[accountT('signOut'), SignOutIcon, askSignOut, undefined, true]])
  return h(Fragment, null,
    h('button', { ref: button, type: 'button', className: 'bt-account', 'aria-label': t('Account'), 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: toggle },
      h('span', { className: 'bt-you', 'aria-hidden': true }, h(BotMark, { look: MAIN_LOOK, size: 24 }))),
    open && box ? createPortal(h('div', { className: 'bt-menu bt-menu-up bt-account-menu', role: 'menu', 'aria-label': t('Account'), style: box },
      confirm !== null ? h('div', { className: 'bt-confirm', role: 'alertdialog', 'aria-label': accountT('signOut') },
        h('p', { className: 'bt-confirm-text' }, accountT(confirm === 'running' ? 'signOutRunningDescription' : confirm === 'unknown' ? 'signOutUnknownDescription' : 'signOutDescription')),
        signOutError !== '' ? h('p', { className: 'bt-confirm-error', role: 'alert' }, signOutError) : null,
        h('div', { className: 'bt-confirm-row' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: cancelSignOut }, t('Cancel')),
          h('button', { type: 'button', className: 'bt-confirm-go', disabled: busy, onClick: () => { void runSignOut() } }, accountT('signOut'))))
        : groups.map((group, index) => h(Fragment, { key: index },
          index > 0 ? h('div', { className: 'bt-menu-sep', role: 'separator' }) : null,
          group.map(([label, Icon, run, hint, stay]) => h('button', {
            key: label, type: 'button', role: 'menuitem',
            onClick: () => { if (stay !== true) setOpen(false); void Promise.resolve(run()).catch(error => actions.reportError(error, 'menu')) },
          }, h(Icon), h('span', { className: 'bt-menu-label' }, label), hint ? h('span', { className: 'bt-menu-hint' }, hint) : null))))), document.body) : null)
}

// Opens the Main Bot whenever the main view holds no Bot conversation, the way
// The view always lands on a Bot rather than an empty New Session page.
// When a Bot's chat moves on to a fresh part, the shell clears the view of the part
// it archived; the chat then goes on in the Bot's current part instead.
function useLandOnMainBot(roster, useSessions, actions) {
  const mainView = useSessions((list) => {
    const row = Object.values(list.byId).find(session => (session?.retainedBy?.mainView ?? 0) > 0)
    return row ? `${row.id}|${row.blank ? 1 : 0}` : ''
  })
  const lastBot = useRef(null)
  useEffect(() => {
    if (!roster.ready || !roster.mainBotId) return undefined
    const [id, blank] = mainView.split('|')
    const bot = id === '' ? undefined : roster.byId[id]
    if (bot !== undefined) {
      lastBot.current = { botId: bot.id, sessionId: id }
      if (currentPart(bot) !== id) actions.landOn(bot.id)
      return undefined
    }
    // The group's own Session moves on like a Bot's chat does: the part it archived
    // is cleared, and the view goes on in the fresh one.
    const room = id === '' ? undefined : roster.roomsById[id]
    if (room !== undefined) {
      lastBot.current = null
      if ((room.sessionId ?? room.id) !== id) actions.openSession(room.id)
      return undefined
    }
    // A DSH Agent Session, blank or not, is a real destination: it stays.
    if (id !== '' && ((actions.isAgentSession?.(id) ?? roster.agentOf[id] !== undefined) || blank !== '1')) {
      lastBot.current = null
      return undefined
    }
    const last = lastBot.current
    const timer = setTimeout(() => actions.landOn(roster.mainBotId, last), last ? 0 : 400)
    return () => clearTimeout(timer)
  }, [mainView, roster])
}

export function FooterAccount(props) {
  const seated = props.useUi(value => value.accountSeated === true)
  if (seated) return null
  return h('span', { className: 'bt-foot-account' }, h(AccountLauncher, { ...props, seat: false }))
}

// The only entry registered in every mode: in Agent mode the whole Bot surface is
// withdrawn, and this button in the shell's own footer is the way back.
export function BotReturn({ wide, useSurface, actions }) {
  const mode = useSurface(value => value.mode)
  if (mode !== 'agent') return null
  return h('button', { type: 'button', className: 'bt-return', 'aria-label': t('DS Company'), title: t('DS Company'), onClick: () => actions.setSurface('bot') },
    h(BotMark, { look: MAIN_LOOK, size: 20 }),
    wide ? h('span', { className: 'bt-return-name' }, t('DS Company')) : null)
}

// Agent mode has none of the shell-group styles, so the return button carries its own.
export const RETURN_CSS = `
.bt-return{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:0 14px;border:0;border-radius:999px;background:none;color:inherit;font:inherit;font-size:14px;line-height:20px;cursor:pointer;transition:background-color .12s ease}
.bt-return:hover{background:rgba(127,127,127,.14)}
.bt-return:active{transform:scale(.96)}
.bt-return .bt-mark{display:inline-flex;flex:none;line-height:0}
.bt-return .bt-mark svg{width:100%;height:100%;overflow:visible}
/* Shell styles carry --bt-ink-deepseek and Agent mode withdraws them; pin it here. */
.bt-return .bt-mark{--bt-ink-deepseek:#4D6BFE}
.bt-return-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`

export function BrandMark({ size = 24 }) {
  return h('span', { className: 'bt-brand-whale' }, h(BotMark, { look: MAIN_LOOK, size }))
}
export function BrandName() {
  return h('span', { style: { fontWeight: 600, fontSize: 14 } }, 'DS Company')
}

// With the whale holding the settings seat, the Bot row is just the account menu;
// FooterAccount only shows when the seat went to no one. The shell's footer classes
// are CSS-module names, so they match on their stems.
export const SIDEBAR_CSS = `
.bt-company-nav{display:flex;gap:4px;padding:6px 10px 9px;border-bottom:1px solid var(--bt-line)}
.bt-company-nav button{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:8px;min-height:34px;background:none;color:var(--bt-ink-2);font:600 12px var(--bt-font);cursor:pointer}
.bt-company-nav button:hover{background:var(--bt-hover)}
.bt-company-nav button[aria-current=page]{background:var(--bt-active);color:var(--bt-ink)}
.bt-company-nav button:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-company-nav button span{font-size:15px;line-height:1}
.bt-company-rail{display:grid;gap:3px;padding:6px 7px}
.bt-company-rail button{width:100%;min-height:38px}
.bt-confirm{width:260px;max-width:72vw;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px}
.bt-confirm-text{margin:0;font-size:13px;line-height:19px;color:var(--bt-ink-2)}
.bt-confirm-error{margin:0;font-size:12px;line-height:17px;color:var(--bt-danger);overflow-wrap:anywhere}
.bt-confirm-row{display:flex;justify-content:flex-end;gap:8px}
.bt-menu .bt-confirm button{width:auto;min-height:0}
.bt-confirm-go{height:28px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .12s ease}
.bt-confirm-go:hover:not(:disabled){opacity:.9}
.bt-confirm-go:disabled{opacity:.6;cursor:default}
.bt-side-top .bt-brand{cursor:default;padding-left:6px}
.bt-side-top .bt-brand:hover{background:none}
.bt-brand .bt-mark{flex:none}
.bt-pin{flex:none;display:inline-flex;color:var(--bt-ink-3)}
.bt-rail .bt-row{position:relative}
.bt-rail .bt-pin{position:absolute;top:1px;left:calc(50% + 14px)}
.bt-side .bt-read-only{margin:4px 8px 6px;padding:8px 10px;border-radius:10px;background:var(--bt-hover);font-size:12px;line-height:1.45;text-align:left}
[class*="_footArea"]:has(.bt-foot-account){grid-template-columns:auto minmax(0,1fr) auto;column-gap:6px}
[class*="_footArea"]>[class*="_footerActions"]>div>.bt-foot-account{grid-column:1;order:1;display:inline-flex}
[class*="_footArea"]:has(.bt-foot-account)>[class*="_settingsArea"]{grid-column:3}
[class*="_footArea"]:has(.bt-foot-account)>[class*="_settingsArea"] button[class*="_trigger"] [class*="_label"]{display:none!important}

/* The update cloud springs in when a newer DS Bot shows up; its arrow drops in a
   loop while the install runs. */
.bt-round.bt-update{position:relative;color:var(--bt-accent,#4D6BFE);animation:bt-update-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-round.bt-update svg{width:17px;height:17px}
.bt-round.bt-update[data-phase=installed]{color:var(--bt-ink-2)}
@keyframes bt-update-in{from{opacity:0;transform:scale(.6);filter:blur(4px)}}
.bt-update[data-phase=installing] .bt-cloud-arrow{animation:bt-cloud-drop 1.1s cubic-bezier(.45,0,.55,1) infinite}
@keyframes bt-cloud-drop{0%{transform:translateY(-3px);opacity:0}35%{opacity:1}70%{transform:translateY(1px);opacity:1}100%{transform:translateY(2px);opacity:0}}
.bt-update-dot{position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:#E5484D;box-shadow:0 0 0 1.5px var(--bt-sidebar)}
.bt-update-pop{position:fixed;z-index:60;width:280px;padding:14px 14px 12px;border-radius:14px;background:var(--bt-main);border:.5px solid var(--bt-line-2);box-shadow:0 10px 20px -3px rgba(0,0,0,.1),0 4px 6px -4px rgba(0,0,0,.1);color:var(--bt-ink);box-sizing:border-box;transform-origin:top left;font-family:var(--bt-font);animation:bt-update-pop ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
@keyframes bt-update-pop{from{opacity:0;transform:scale(.96);filter:blur(4px)}}
.bt-update-title{font-size:14px;line-height:20px;font-weight:600}
.bt-update-text{margin-top:2px;font-size:12.5px;line-height:18px;color:var(--bt-ink-2)}
.bt-update-error{margin-top:8px;font-size:12px;line-height:17px;color:var(--bt-danger);overflow-wrap:anywhere;max-height:90px;overflow:auto}
.bt-update-actions{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:12px}
.bt-update-notes{margin-right:auto;font-size:12.5px;color:var(--bt-ink-2);text-decoration:none}
.bt-update-notes:hover{color:var(--bt-ink);text-decoration:underline}
.bt-update-go{height:30px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-accent,#4D6BFE);color:var(--bt-accent-ink,#fff);font:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:opacity .12s ease,transform .12s ease}
.bt-update-go:hover:not(:disabled){opacity:.9}
.bt-update-go:active:not(:disabled){transform:scale(.96)}
.bt-update-go:disabled{opacity:.6;cursor:default}
.bt-update-dsh:not(:first-child){margin-top:12px;padding-top:12px;border-top:.5px solid var(--bt-line-2)}
@media (prefers-reduced-motion:reduce){.bt-round.bt-update,.bt-update-pop,.bt-update .bt-cloud-arrow{animation:none}}

/* The DSH Agent row and its expanding Session list. The black whale is the
   harness's own mark, so the row reads as "plain dsh" next to the Bot marks. */
.bt-agent-ava{flex:none;width:36px;height:36px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-hover);color:var(--bt-ink)}
.bt-agent-ava.bt-run{animation:bt-agent-pulse 1.4s ease-in-out infinite}
@keyframes bt-agent-pulse{0%,100%{opacity:1}50%{opacity:.55}}
.bt-agent-sub{display:grid;grid-template-rows:0fr;transition:grid-template-rows ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
.bt-agent-sub[data-open]{grid-template-rows:1fr}
.bt-agent-sub-in{overflow:hidden;min-height:0;margin-left:44px}
.bt-agent-sub-row{display:flex;align-items:center;gap:8px;width:100%;padding:5px 10px 5px 8px;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.bt-agent-sub-row:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-agent-sub-row[aria-current=page]{background:var(--bt-hover);color:var(--bt-ink);font-weight:500}
.bt-agent-sub-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-agent-sub-time{flex:none;font-size:11px;color:var(--bt-ink-3)}
.bt-agent-new{color:var(--bt-ink-3)}
.bt-agent-new svg{width:14px;height:14px;flex:none}
.bt-agent-edit{padding:3px 10px 3px 4px}
.bt-agent-edit input{width:100%;border:0;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;line-height:20px;padding:2px 8px;outline:none;box-shadow:inset 0 0 0 .5px var(--bt-line-2)}
.bt-agent-sub[data-open] .bt-agent-sub-row{animation:bt-agent-row-in .24s ease both;animation-delay:calc(var(--i, 0)*30ms)}
@keyframes bt-agent-row-in{from{opacity:0;filter:blur(4px)}to{opacity:1;filter:blur(0)}}
@media (prefers-reduced-motion:reduce){.bt-agent-sub{transition:none}.bt-agent-sub .bt-agent-sub-row{animation:none}}

/* The company shell: a quiet brand header, three primary destinations, and
   one context section that follows the page the user is on. */
.bt-side-company{padding:0 10px 8px 0}
.bt-co-brand{display:flex;align-items:center;gap:10px;padding:14px 6px 12px 14px;flex:none}
.bt-co-mark{flex:none;width:32px;height:32px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;background:var(--bt-accent);color:var(--bt-accent-ink,#fff);font-size:14px;font-weight:600;line-height:1}
.bt-co-brandtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-co-brandtext strong{font-size:13.5px;line-height:18px;font-weight:600;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-co-brandtext small{font-size:10.5px;line-height:14px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-co-brand .bt-side-collapse{width:28px;height:28px;flex:none}
.bt-co-nav{display:flex;flex-direction:column;gap:1px;padding:0 6px 8px;flex:none}
.bt-co-nav button{display:flex;align-items:center;gap:10px;width:100%;height:34px;padding:0 10px;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer}
.bt-co-nav button:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-co-nav button.is-active{background:var(--bt-active);color:var(--bt-ink);font-weight:500}
.bt-co-ico{flex:none;width:16px;height:16px;opacity:.9}
.bt-co-nav-label{flex:1;min-width:0}
.bt-co-count{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-co-scroll{display:flex;flex-direction:column;min-height:0;padding:0 6px}
.bt-co-sec{padding:10px 0 12px;border-top:.5px solid var(--bt-line)}
.bt-co-sec:first-child{border-top:0;padding-top:2px}
.bt-co-sec-head{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:24px;padding:2px 6px 6px;font-size:11px;line-height:16px;font-weight:600;color:var(--bt-ink-3)}
.bt-co-linkbtn{border:0;background:none;padding:2px 0;color:var(--bt-ink-2);font:inherit;font-size:11px;line-height:16px;cursor:pointer;white-space:nowrap}
.bt-co-linkbtn:hover{color:var(--bt-ink)}
.bt-co-summary{display:flex;flex-direction:column;gap:2px;padding:0 6px 8px}
.bt-co-summary strong{font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink)}
.bt-co-summary span{font-size:11px;line-height:15px;color:var(--bt-ink-3)}
.bt-co-links{display:flex;flex-direction:column;gap:1px}
.bt-co-link{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:30px;padding:0 6px;border:0;border-radius:6px;background:none;color:var(--bt-ink-2);font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer}
.bt-co-link:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-co-link.is-active{color:var(--bt-ink);font-weight:500}
.bt-co-link-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-co-meta{flex:none;font-size:11px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-co-chips{display:flex;flex-wrap:wrap;gap:4px;padding:0 4px 8px}
.bt-co-chip{height:24px;padding:0 9px;border:.5px solid var(--bt-line-2);border-radius:6px;background:none;color:var(--bt-ink-2);font:inherit;font-size:11px;line-height:16px;cursor:pointer}
.bt-co-chip:hover{background:var(--bt-hover)}
.bt-co-chip[aria-pressed=true]{background:var(--bt-accent);border-color:var(--bt-accent);color:var(--bt-accent-ink,#fff)}
.bt-co-plist{display:flex;flex-direction:column;gap:1px}
.bt-co-proj{display:flex;flex-direction:column;gap:1px;width:100%;padding:7px 8px;border:0;border-radius:7px;background:none;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}
.bt-co-proj:hover{background:var(--bt-hover)}
.bt-co-proj.is-active{background:var(--bt-active)}
.bt-co-proj-top{display:flex;align-items:center;gap:8px;min-width:0}
.bt-co-proj-top strong{flex:1;min-width:0;font-size:12.5px;line-height:18px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-co-proj-stage{flex:none;font-size:10px;line-height:15px;color:var(--bt-ink-3)}
.bt-co-proj-sub{font-size:10.5px;line-height:15px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-co-current{display:flex;flex-direction:column;gap:2px;margin-top:6px;padding:8px 6px 0;border-top:.5px solid var(--bt-line)}
.bt-co-current strong{font-size:12px;line-height:17px;font-weight:500;color:var(--bt-ink)}
.bt-co-group{display:flex;flex-direction:column;gap:1px;margin:2px 0 6px}
.bt-co-group-label{padding:4px 6px 4px;font-size:10.5px;line-height:15px;font-weight:600;color:var(--bt-ink-3)}
.bt-co-search{display:flex;align-items:center;gap:7px;margin:0 2px 8px;padding:0 9px;height:30px;border:.5px solid var(--bt-line-2);border-radius:7px;background:var(--bt-card);color:var(--bt-ink-3)}
.bt-co-search svg{flex:none;width:14px;height:14px}
.bt-co-search input{flex:1;min-width:0;border:0;background:none;color:var(--bt-ink);font:inherit;font-size:12px;line-height:18px;outline:none}
.bt-co-search input::placeholder{color:var(--bt-ink-3)}
.bt-co-empty{margin:4px 6px;font-size:11px;line-height:16px;color:var(--bt-ink-3)}
`

