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
    contents: "export { ProjectChatSurface, ProjectChatDrawer, ProjectChatHeaderSlot } from './src/client/project-chat-overlay.js'\nexport { HeaderPill } from './src/client/header.js'",
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
const { ProjectChatSurface, ProjectChatDrawer, ProjectChatHeaderSlot, HeaderPill } = module.exports

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
const mountSlot = async () => {
  const root = {
    root: true, next: 0, slots: [], queue: [], cleanups: [], dirty: false, tree: null,
    schedule() { root.dirty = true },
  }
  const render = () => {
    root.next = 0
    root.queue = []
    outer.push(frame)
    frame = root
    try { root.tree = ProjectChatHeaderSlot(slotProps()) } finally { frame = outer.pop() ?? null }
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
const slotProject = { id: 'prj_1', name: '官网改版', status: 'active', goal: '上线新首页', pending_count: 2, pinned_decisions: [], group_binding: { room_id: 'room-1' } }
const companyModel = { projects: [slotProject], employees: [{ id: 'emp_1', name: '键盘' }] }
const companyModelResponses = detail => (endpoint, payload) => endpoint === 'company-model'
  ? (payload?.project_id ? detail : companyModel)
  : undefined

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
  assert.deepEqual(headings, ['Goal'])
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
  assert.deepEqual(requests.filter(entry => entry.payload?.project_id), [{ endpoint: 'company-model', payload: { project_id: 'prj_1' } }])
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
  assert.doesNotMatch(text(drawer), /键盘/)
})
