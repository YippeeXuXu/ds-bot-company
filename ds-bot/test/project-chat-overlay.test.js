import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The overlay draws through the browser's React; bundle it with a stand-in, as the other
// client tests do. The header slot fills its members through an async read, so the stand-in
// keeps hook state and re-renders when setState runs; effects still run between renders.
// Calling a component directly keeps the older collect-then-run behaviour for the overlay
// tests below.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>')

const { outputFiles } = await build({
  stdin: {
    contents: "export { ProjectChatSurface, ProjectChatDrawer, ProjectChatHeaderSlot, drawerPendingRows } from './src/client/project-chat-overlay.js'\nexport { HeaderPill } from './src/client/header.js'\nexport { installLocale } from './src/client/i18n.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const noop = () => {}
let effects = []
let frame = null
const outer = []

// One mounted component owns its hook slots; a child component is expanded on demand with
// throwaway slots, since the pieces below are pure functions of their props.
const renderComponent = (Component, props) => {
  const child = { next: 0, slots: [], root: false }
  outer.push(frame)
  frame = child
  try {
    return Component(props)
  } finally {
    frame = outer.pop() ?? null
  }
}

const useState = initial => {
  if (!frame) return [typeof initial === 'function' ? initial() : initial, noop]
  const owner = frame
  const index = owner.next++
  if (!owner.slots[index]) owner.slots[index] = { value: typeof initial === 'function' ? initial() : initial }
  const slot = owner.slots[index]
  const set = value => {
    const next = typeof value === 'function' ? value(slot.value) : value
    if (Object.is(next, slot.value)) return
    slot.value = next
    if (owner.root) owner.schedule()
  }
  return [slot.value, set]
}

const useEffect = (effect, deps) => {
  if (!frame) { effects.push(effect); return }
  if (!frame.root) return
  const index = frame.next++
  const slot = frame.slots[index] ?? { deps: undefined }
  frame.slots[index] = slot
  const changed = deps === undefined || slot.deps === undefined || deps.some((dep, i) => !Object.is(dep, slot.deps[i]))
  if (!changed) return
  slot.deps = deps !== undefined ? [...deps] : undefined
  frame.queue.push({ index, effect })
}

const useRef = current => {
  if (!frame) return { current }
  const index = frame.next++
  const slot = frame.slots[index] ?? { current }
  frame.slots[index] = slot
  return slot
}

const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useState,
  useEffect,
  useLayoutEffect: useEffect,
  useRef,
  useMemo: make => make(),
  useCallback: fn => fn,
  createContext: initial => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useId: () => 'id',
}
// Reads the company model through the same `fetch` the browser client uses.
let responses = () => undefined
let requests = []
const fetchStub = async (url, init) => {
  const body = JSON.parse(init.body)
  requests.push({ endpoint: body.endpoint, payload: body.payload })
  const value = responses(body.endpoint, body.payload)
  if (value === undefined) return { ok: false, status: 500, json: async () => ({ ok: false, error: { code: 'test/no-stub', message: 'no response stubbed' } }) }
  return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
}
const module = { exports: {} }
const sandbox = {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : new Proxy({}, { get: () => () => null })),
  window: dom.window,
  document: dom.window.document,
  fetch: fetchStub,
  setTimeout: () => 0,
  clearTimeout: () => {},
  Date,
}
runInNewContext(outputFiles[0].text, sandbox)
const { ProjectChatSurface, ProjectChatDrawer, ProjectChatHeaderSlot, drawerPendingRows, HeaderPill } = module.exports

// The interface runs in Chinese; the bundle carries its own copy of i18n, so install the
// dictionary through the bundled `installLocale` — the copy the user actually sees.
const dictionaries = new Map()
module.exports.installLocale({
  register: (namespace, locale, dictionary) => {
    dictionaries.set(`${namespace}:${locale}`, dictionary)
    return () => dictionaries.delete(`${namespace}:${locale}`)
  },
  bind: namespace => (key, params) => {
    const text = dictionaries.get(`${namespace}:zh`)?.[key] ?? key
    return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
  },
  getLocale: () => ({ active: 'zh' }),
})

// Component elements only become markup when rendered; expand the plain-function
// components first, leaving HeaderPill as an element we can identify.
const resolve = node => {
  if (Array.isArray(node)) return node.map(resolve)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function' && node.type !== HeaderPill) return resolve(renderComponent(node.type, node.props))
  return { ...node, props: { ...node.props, children: resolve(node.props?.children) } }
}

const collect = (node, predicate, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) { node.forEach(child => collect(child, predicate, found)); return found }
  if (predicate(node)) found.push(node)
  collect(node.props?.children, predicate, found)
  return found
}
const text = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return text(node.props?.children)
}
const hasClass = (node, name) => typeof node?.props?.className === 'string' && node.props.className.split(' ').includes(name)

// Mounts the slot the way the host does: render, then let the company reads settle and
// re-render for every state update their results cause.
const mountSlot = async (overrides = {}) => {
  const input = { ...slotProps(), ...overrides }
  const root = {
    root: true, next: 0, slots: [], queue: [], cleanups: [], dirty: false, tree: null,
    schedule() { root.dirty = true },
  }
  const render = () => {
    root.next = 0
    root.queue = []
    outer.push(frame)
    frame = root
    try { root.tree = ProjectChatHeaderSlot(input) } finally { frame = outer.pop() ?? null }
    for (const job of root.queue) {
      const previous = root.cleanups[job.index]
      if (typeof previous === 'function') previous()
      const cleanup = job.effect()
      root.cleanups[job.index] = typeof cleanup === 'function' ? cleanup : undefined
    }
  }
  const settle = async () => {
    for (let round = 0; round < 40; round++) {
      await new Promise(done => setTimeout(done, 0))
      if (!root.dirty) return root
      root.dirty = false
      render()
    }
    throw new Error('the header slot did not settle')
  }
  render()
  await settle()
  return { root, settle, tree: () => resolve(root.tree) }
}

const project = { id: 'p1', name: '官网改版', status: 'active', goal: '上线新首页', pending_count: 2, pinned_decisions: [] }
const members = [{ id: 'm1', name: '键盘', role: 'coordinator' }]
const room = { id: 'room-1', name: '官网改版', members: ['bot-1'] }
const roster = { bots: [], rooms: [room], agents: [], byId: {}, roomsById: { 'room-1': room }, ready: true }
const selector = fixture => fn => fn(fixture)
const props = {
  sessionId: 'room-1',
  useRoster: selector(roster),
  useSessions: selector({ byId: {}, projectionsBySession: {} }),
  useSessionStatus: selector(new Map()),
  useSession: selector({}),
  useActivity: selector({}),
  useMemoryNews: selector({}),
  useTurnClock: selector({}),
  useUi: selector({}),
  useLive: selector({}),
  useWork: selector({}),
  actions: { beginVisit() {}, endVisit() {} },
}
const slotProps = () => ({
  sessionId: 'room-1',
  useRoster: selector(roster),
  actions: { beginVisit: noop, endVisit: noop, openCompanyPage: noop },
})
// The model's own counters are stale on purpose: the surface must take the count and the
// pinned rows from the waiting read, not from `pending_count`/`pinned_decisions` (A15, B8).
const slotProject = { id: 'prj_1', name: '官网改版', status: 'active', goal: '上线新首页', pending_count: 99, pinned_decisions: [{ id: 'stale', title: '旧置顶', who: '不应出现' }], group_binding: { room_id: 'room-1' } }
const companyModel = { projects: [slotProject], employees: [{ id: 'emp_1', name: '键盘' }] }
// C-02 fixtures: one project's waiting decisions and recent events, read through the
// same two routes the drawer uses.
const todosBody = {
  read_at: '2026-11-05T19:00:00Z',
  company_id: 'company-1',
  counts: { waiting_approvals: 2, waiting_acceptances: 1, waiting_total: 3 },
  waiting: [
    { id: 'ac_1', card_kind: 'acceptance', title: '验收官网改版', wait_minutes: 3, ready: true },
    { id: 'ap_1', card_kind: 'approval', title: '私聊里的审批', wait_minutes: 40, ready: false, suspended: true, reason: '请在私聊中处理' },
    { id: 'ap_2', card_kind: 'approval', title: '发布到生产', wait_minutes: 12, ready: true },
  ],
  handled: [],
  handled_has_more: false,
}
const eventsAt = Date.now()
// Deliberately oldest first: the client must order and truncate by itself, not trust the
// array it received (A5).
const eventsBody = {
  cursor: '9',
  has_more: false,
  events: [
    { id: 'evt_6_0', cursor: 6, at: eventsAt - 26 * 60 * 60 * 1000, type: 'acceptance.decided', data: { acceptance_id: 'acc_1', decision: 'return' } },
    { id: 'evt_7_0', cursor: 7, at: eventsAt - 3 * 60 * 60 * 1000, type: 'project.group.reconciled', data: {} },
    { id: 'evt_8_0', cursor: 8, at: eventsAt - 2 * 60 * 60 * 1000, type: 'project.member.added', data: { employee_id: 'emp_1', role: 'coordinator' } },
    { id: 'evt_9_0', cursor: 9, at: eventsAt - 5 * 60 * 1000, type: 'project.updated', data: { fields: ['goal'] } },
    // B: a newly written acceptance carries the submitter; the client shows the real name.
    { id: 'evt_10_0', cursor: 10, at: eventsAt - 60 * 1000, type: 'acceptance.submitted', data: { acceptance_id: 'acc_2', project_id: 'prj_1', employee_id: 'emp_1' } },
    // An older acceptance has no employee id: K-12 asks for "成员", not a nameless line.
    { id: 'evt_11_0', cursor: 11, at: eventsAt - 10 * 60 * 1000, type: 'acceptance.submitted', data: { acceptance_id: 'acc_3', project_id: 'prj_1' } },
    // Two more mapped events push the list past five, so the client must cut the oldest.
    { id: 'evt_12_0', cursor: 12, at: eventsAt - 30 * 60 * 60 * 1000, type: 'project.started', data: { room_id: 'room-1' } },
    { id: 'evt_13_0', cursor: 13, at: eventsAt - 40 * 60 * 60 * 1000, type: 'project.created', data: { name: '官网改版' } },
  ],
}
const companyModelResponses = detail => (endpoint, payload) => {
  if (endpoint === 'company-model') return payload?.project_id ? detail : companyModel
  if (endpoint === 'company-todos') return todosBody
  if (endpoint === 'company-events') return eventsBody
  return undefined
}

test('the project header keeps the host pill mounted but hidden', () => {
  const tree = resolve(ProjectChatSurface({ props, project, members, pendingCount: 0, open: false, onOpenDetails() {}, onClose() {}, onOpenConfig() {} }))
  const frames = collect(tree, node => node.props?.className === 'pc-frame')
  assert.equal(frames.length, 1)
  const heads = collect(tree, node => typeof node.props?.className === 'string' && node.props.className.split(' ').includes('pc-head'))
  assert.equal(heads.length, 1, 'exactly one visible project header')
  const hostHeads = collect(tree, node => node.props?.className === 'pc-host-head')
  assert.equal(hostHeads.length, 1)
  assert.equal(hostHeads[0].props['aria-hidden'], 'true')
  // The hidden wrapper carries the host pill; without it visit tracking and the room
  // styles disappear from a project chat.
  const pills = collect(hostHeads[0], node => node.type === HeaderPill)
  assert.equal(pills.length, 1)
})

test('the host pill still marks the visit and the room it runs in', () => {
  const calls = []
  const visitProps = { ...props, actions: { beginVisit: id => calls.push(['beginVisit', id]), endVisit: id => calls.push(['endVisit', id]) } }
  effects = []
  dom.window.document.body.removeAttribute('data-bt-room')
  HeaderPill(visitProps)
  for (const effect of effects) effect()
  assert.deepEqual(calls[0], ['beginVisit', 'room-1'])
  assert.equal(dom.window.document.body.dataset.btRoom, '')
})

test('the drawer leaves out member, decision and activity sections without data', () => {
  const tree = ProjectChatDrawer({ projectName: '官网改版', goal: '上线新首页', stage: '进行中', members: [], onClose() {}, onOpenConfig() {} })
  const body = text(collect(tree, node => node.props?.className === 'pc-drawer-body')[0])
  assert.doesNotMatch(body, /No members yet/)
  assert.doesNotMatch(body, /All clear/)
  assert.doesNotMatch(body, /No recent activity/)
  const headings = collect(tree, node => node.type === 'h3').map(text)
  assert.deepEqual(headings, ['目标'])
})

test('the drawer renders real member rows, and decisions only when they exist', () => {
  const tree = ProjectChatDrawer({
    projectName: '官网改版', goal: '上线新首页', stage: '进行中', members,
    pending: [{ id: 't1', title: '同意发布', who: '官网改版' }], activity: [], onClose() {}, onOpenConfig() {},
  })
  assert.match(text(tree), /键盘/)
  assert.match(text(tree), /coordinator/)
  assert.match(text(tree), /同意发布/)
  assert.doesNotMatch(text(tree), /No recent activity/)
})

test('the slot falls back to the host header when the project list read fails', async () => {
  responses = () => undefined
  const slot = await mountSlot()
  const tree = slot.tree()
  assert.equal(collect(tree, node => node.type === HeaderPill).length, 1, 'the host pill is the whole header when the project read fails')
  assert.equal(collect(tree, node => hasClass(node, 'pc-frame')).length, 0, 'no project header is drawn on a failed read')
  assert.equal(collect(tree, node => hasClass(node, 'pc-face')).length, 0)
})

test('the slot keeps the project header when the detail read fails', async () => {
  responses = companyModelResponses(undefined)
  const slot = await mountSlot()
  const tree = slot.tree()
  assert.equal(collect(tree, node => hasClass(node, 'pc-frame')).length, 1, 'the project header still renders from the list read')
  assert.equal(collect(tree, node => hasClass(node, 'pc-face')).length, 0, 'no member faces without a detail read')
  assert.match(text(tree), /官网改版/)
})

test('the header slot renders member faces from the project detail read', async () => {
  requests = []
  responses = companyModelResponses({ project: { id: 'prj_1', members: [{ id: 'm1', employee_id: 'emp_1', role: 'coordinator' }] } })
  const slot = await mountSlot()
  const tree = slot.tree()
  const faces = collect(tree, node => hasClass(node, 'pc-face'))
  assert.equal(faces.length, 1, 'one face for the one member the detail read returned')
  assert.equal(text(faces[0]), '键')
  assert.match(text(tree), /官网改版/)
  assert.equal(collect(tree, node => node.props?.className === 'pc-host-head').length, 1, 'the host pill stays mounted under the P04 header')
  // C-02 adds the project's waiting read to the same entry pass as the member read.
  assert.deepEqual(requests.filter(entry => entry.payload?.project_id), [
    { endpoint: 'company-model', payload: { project_id: 'prj_1' } },
    { endpoint: 'company-todos', payload: { project_id: 'prj_1' } },
  ])
})

test('the header slot leaves the member area out when the detail read returns no members', async () => {
  responses = companyModelResponses({ project: { id: 'prj_1', members: [] } })
  const slot = await mountSlot()
  const closed = slot.tree()
  assert.equal(collect(closed, node => hasClass(node, 'pc-face')).length, 0, 'no face when the detail read has no members')
  const pill = collect(closed, node => hasClass(node, 'pc-pill'))[0]
  assert.ok(pill, 'the project pill owns the details drawer')
  pill.props.onClick({ currentTarget: { focus: noop } })
  await slot.settle()
  const drawer = collect(slot.tree(), node => hasClass(node, 'pc-drawer'))[0]
  assert.ok(drawer, 'the details drawer opens from the project pill')
  assert.equal(collect(drawer, node => hasClass(node, 'pc-member')).length, 0, 'no member rows')
  // The word itself can legitimately appear in an activity line (K-12 falls back to
  // "成员" when an event has no employee id), so look for the section heading only.
  const headings = collect(drawer, node => node.type === 'h3').map(node => text(node))
  assert.ok(!headings.includes('成员'), 'no member section heading')
})

test('the status bar and the pinned card show the project waiting read', async () => {
  requests = []
  responses = companyModelResponses({ project: { id: 'prj_1', members: [] } })
  const slot = await mountSlot()
  const tree = slot.tree()
  const pin = collect(tree, node => node.props?.className === 'pc-pin')
  assert.equal(pin.length, 1, 'the pinned card is drawn from the waiting read')
  assert.match(text(pin[0]), /待我决定/)
  assert.match(text(pin[0]), /已置顶 3/)
  // Neither the model's stale count (99) nor its stale pinned rows may leak in.
  assert.doesNotMatch(text(pin[0]), /99/)
  assert.doesNotMatch(text(pin[0]), /旧置顶/)
  // At most three rows, longest wait first, and each row carries the type, the waiting
  // time and, for a blocked row, the reason.
  const rows = collect(pin[0], node => hasClass(node, 'pc-pin-row'))
  assert.equal(rows.length, 3)
  assert.match(text(rows[0]), /私聊里的审批/)
  assert.match(text(rows[0]), /审批 · 已等待 40 分钟/)
  assert.match(text(rows[0]), /已挂起 · 等待中/)
  assert.match(text(rows[0]), /请在私聊中处理/)
  assert.match(text(rows[1]), /发布到生产/)
  assert.match(text(rows[2]), /验收官网改版/)
  assert.match(text(rows[2]), /验收 · 已等待 3 分钟/)
  assert.equal(requests.filter(entry => entry.endpoint === 'company-todos').length, 1, 'one waiting read for the whole surface')
  assert.equal(requests.filter(entry => entry.endpoint === 'company-events').length, 0, 'the event read waits for the drawer')
})

test('the drawer reads both sources once per opening and shows readable copy', async () => {
  requests = []
  responses = companyModelResponses({ project: { id: 'prj_1', members: [{ id: 'm1', employee_id: 'emp_1', role: 'coordinator' }] } })
  const slot = await mountSlot()
  const open = () => {
    collect(slot.tree(), node => hasClass(node, 'pc-pill'))[0].props.onClick({ currentTarget: { focus: noop } })
  }
  open()
  await slot.settle()
  const drawer = collect(slot.tree(), node => hasClass(node, 'pc-drawer'))[0]
  assert.ok(drawer, 'the drawer opens from the project pill')
  const body = text(drawer)
  assert.match(body, /私聊里的审批/)
  assert.match(body, /审批 · 已等待 40 分钟/)
  assert.match(body, /已挂起 · 等待中/)
  assert.match(body, /请在私聊中处理/)
  assert.match(body, /验收 · 已等待 3 分钟/)
  // The nine known event kinds become sentences with a relative time; anything else is
  // dropped rather than shown raw (§1.2, K-05).
  assert.match(body, /项目资料已更新 · 5 分钟前/)
  assert.match(body, /键盘 加入项目 · 2 小时前/)
  assert.match(body, /验收已退回 · 1 天前/)
  assert.match(body, /键盘 提交了验收 · 1 分钟前/)
  assert.match(body, /成员 提交了验收 · 10 分钟前/)
  assert.doesNotMatch(body, /project\.|evt_|operation_key|unknown/)
  // Seven mapped events were handed over; the drawer keeps the newest five (B-2, K-06).
  assert.equal(collect(drawer, node => node.type === 'p').length, 6, 'one goal line plus five activity lines')
  assert.doesNotMatch(body, /项目已启动|项目已创建/, 'the two oldest mapped events are cut')
  const todoReads = requests.filter(entry => entry.endpoint === 'company-todos')
  const eventReads = requests.filter(entry => entry.endpoint === 'company-events')
  assert.equal(todoReads.length, 2, 'the surface read plus one drawer read')
  assert.equal(eventReads.length, 1, 'one event read per opening')
  assert.deepEqual(eventReads[0].payload, { project_id: 'prj_1', order: 'desc', limit: 10 }, 'ask ten, show five, descending')
  // The stub answers oldest first; the client still shows the newest lines first.
  const shown = ['键盘 提交了验收 · 1 分钟前', '项目资料已更新 · 5 分钟前', '键盘 加入项目 · 2 小时前', '验收已退回 · 1 天前'].map(line => body.indexOf(line))
  assert.ok(shown.every(index => index >= 0), 'every mapped event is shown')
  assert.deepEqual(shown.slice().sort((a, b) => a - b), shown, 'newest first even when the read arrives oldest first')
  // Closing discards the rows; opening again reads once more instead of reusing them (§4).
  collect(drawer, node => hasClass(node, 'pc-round'))[0].props.onClick()
  await slot.settle()
  assert.equal(collect(slot.tree(), node => hasClass(node, 'pc-drawer')).length, 0, 'the drawer closes')
  open()
  await slot.settle()
  assert.equal(requests.filter(entry => entry.endpoint === 'company-events').length, 2, 'a second opening reads again')
})

test('a failed read leaves the drawer sections out without a placeholder', async () => {
  responses = (endpoint, payload) => endpoint === 'company-model'
    ? (payload?.project_id ? { project: { id: 'prj_1', members: [] } } : companyModel)
    : undefined
  const slot = await mountSlot()
  const closed = slot.tree()
  assert.equal(collect(closed, node => node.props?.className === 'pc-pin').length, 0, 'no pinned card without a waiting read')
  collect(closed, node => hasClass(node, 'pc-pill'))[0].props.onClick({ currentTarget: { focus: noop } })
  await slot.settle()
  const body = text(collect(slot.tree(), node => hasClass(node, 'pc-drawer'))[0])
  assert.doesNotMatch(body, /待我决定/)
  assert.doesNotMatch(body, /暂无/)
  assert.doesNotMatch(body, /\b0\b/)
  assert.doesNotMatch(body, /失败|错误|error/i)
})

test('an archived project keeps its waiting rows on show but takes the way in away', () => {
  const openTodos = () => {}
  const active = drawerPendingRows({ id: 'prj_1', status: 'active' }, todosBody, openTodos)
  assert.equal(active.length, 3)
  assert.ok(active.every(row => row.onOpen === openTodos), 'an active project keeps the way in')
  const archived = drawerPendingRows({ id: 'prj_1', status: 'archived' }, todosBody, openTodos)
  assert.equal(archived.length, 3, 'the remaining rows are still listed')
  assert.ok(archived.every(row => row.onOpen === null), 'an archived project takes the way in away')
  const drawer = resolve(ProjectChatDrawer({
    projectName: '官网改版', goal: '上线新首页', stage: '', members: [],
    pending: archived, activity: [], onClose: noop, onOpenConfig: noop,
  }))
  assert.match(text(drawer), /验收 · 已等待 3 分钟/, 'the rows stay readable')
  const rows = collect(drawer, node => hasClass(node, 'pc-wait'))
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => hasClass(row, 'is-readonly')), 'every row is marked read-only')
  assert.equal(rows.filter(row => row.type === 'button').length, 0, 'no button, so no answer entry')
  assert.ok(rows.every(row => row.props.onClick === undefined), 'nothing to click')
})

test('a waiting row opens the to-do page and closes the drawer', async () => {
  responses = companyModelResponses({ project: { id: 'prj_1', members: [] } })
  const opened = []
  const slot = await mountSlot({ actions: { beginVisit: noop, endVisit: noop, openCompanyPage: kind => opened.push(kind) } })
  collect(slot.tree(), node => hasClass(node, 'pc-pill'))[0].props.onClick({ currentTarget: { focus: noop } })
  await slot.settle()
  const row = collect(slot.tree(), node => hasClass(node, 'pc-wait'))[0]
  assert.ok(row, 'the drawer lists the waiting rows')
  row.props.onClick()
  await slot.settle()
  assert.deepEqual(opened, ['todos'])
  assert.equal(collect(slot.tree(), node => hasClass(node, 'pc-drawer')).length, 0, 'the drawer closes behind the page')
})
