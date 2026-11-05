import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The overlay draws through the browser's React; bundle it with a minimal stand-in, as
// the other client tests do. Effects are collected so the visit and room styles the host
// pill owns can be asserted without a full renderer.
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
let effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useState: initial => [initial, () => {}],
  useEffect: effect => { effects.push(effect) },
  useLayoutEffect: effect => { effects.push(effect) },
  useMemo: make => make(),
  useCallback: fn => fn,
  useRef: current => ({ current }),
  createContext: initial => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useId: () => 'id',
}
const module = { exports: {} }
const sandbox = {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : new Proxy({}, { get: () => () => null })),
  window: dom.window,
  document: dom.window.document,
  setTimeout: () => 0,
  clearTimeout: () => {},
  Date,
}
runInNewContext(outputFiles[0].text, sandbox)
const { ProjectChatSurface, ProjectChatDrawer, HeaderPill } = module.exports

// Component elements only become markup when rendered; expand the plain-function
// components first, leaving HeaderPill as an element we can identify.
const resolve = node => {
  if (Array.isArray(node)) return node.map(resolve)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function' && node.type !== HeaderPill) return resolve(node.type(node.props))
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
