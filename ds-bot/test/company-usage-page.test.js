import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY } from '../src/client/i18n.js'

// The panel renders through the browser's React; bundle it with the same stand-in the
// other client tests use, then read the tree as plain objects.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { UsagePanelView, UsagePanel, USAGE_CUTS, USAGE_WINDOWS, usageWindow, COMPANY_USAGE_CSS } from './src/client/company-usage.js'\nexport { CompanyPageView, COMPANY_PAGE_CSS } from './src/client/company-page.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useState: initial => [initial, () => {}],
  useEffect() {},
  useRef: current => ({ current }),
}
const module = { exports: {} }
const sandbox = { module, exports: module.exports, require: name => (name === 'react' ? react : {}), window: {} }
runInNewContext(outputFiles[0].text, sandbox)
const {
  UsagePanelView, UsagePanel, USAGE_CUTS, USAGE_WINDOWS, usageWindow, COMPANY_USAGE_CSS, CompanyPageView, COMPANY_PAGE_CSS,
} = module.exports

const text = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return text(node.props?.children)
}
const collect = (node, predicate, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) { node.forEach(child => collect(child, predicate, found)); return found }
  if (predicate(node)) found.push(node)
  collect(node.props?.children, predicate, found)
  return found
}
const buttons = tree => collect(tree, node => node.type === 'button')
const button = (tree, label) => buttons(tree).find(item => text(item).includes(label))
const byClass = (tree, name) => collect(tree, node => String(node.props?.className ?? '').split(' ').includes(name))
const heading = tree => text(collect(tree, node => node.type === 'th')[0])
const click = node => node.props.onClick?.({ preventDefault() {}, stopPropagation() {} })

const totals = { calls: 15, tokens: 3400 }
const personData = {
  by: 'person', from: 1, to: 2, time_zone: 'UTC',
  rows: [
    { kind: 'person', employee_id: 'emp_1', name: '键盘', bot_id: 'bot_1', status: 'active', calls: 12, tokens: 3400, counted_only: false },
    { kind: 'person', employee_id: 'emp_2', name: '橙子', bot_id: 'bot_2', status: 'disabled', calls: 3, tokens: 0, counted_only: true },
  ],
  totals,
  unattributed: { calls: 2, tokens: 900, reason: 'group' },
}
const projectData = {
  by: 'project', from: 1, to: 2, time_zone: 'UTC',
  rows: [{ kind: 'project', project_id: 'prj_1', name: '官网改版', status: 'active', calls: 9, tokens: 1200, counted_only: false }],
  totals: { calls: 9, tokens: 1200 },
  unattributed: { calls: 1, tokens: 300, reason: 'no-run' },
}
const timeData = {
  by: 'time', from: 1, to: 2, time_zone: 'UTC',
  rows: [{ kind: 'time', day: '2026-11-19', calls: 4, tokens: 700, counted_only: false }],
  totals: { calls: 4, tokens: 700 },
  unattributed: { calls: 0, tokens: 0, reason: 'none' },
}
const view = (patch = {}) => UsagePanelView({
  data: personData, by: 'person', days: 30, busy: false, error: '',
  onClose() {}, onCut() {}, onWindow() {}, onRetry() {},
  ...patch,
})

test('the panel offers the three cuts and the three windows, one selected at a time', () => {
  const tree = view()
  for (const cut of USAGE_CUTS) assert.ok(button(tree, cut.label), `cut ${cut.label}`)
  for (const option of USAGE_WINDOWS) assert.ok(button(tree, option.label), `window ${option.label}`)
  const pressed = buttons(tree).filter(item => item.props['aria-pressed'] === true)
  assert.deepEqual(pressed.map(text), ['People', '30 days'])
  assert.equal(heading(tree), 'Person')
})

test('the cuts and the windows ask the container for a new read', () => {
  const cuts = []
  const windows = []
  const tree = view({ onCut: by => cuts.push(by), onWindow: days => windows.push(days) })
  click(button(tree, 'Projects'))
  click(button(tree, 'Time'))
  click(button(tree, 'Today'))
  click(button(tree, '7 days'))
  assert.deepEqual(cuts, ['project', 'time'])
  assert.deepEqual(windows, [0, 7])
})

test('each row carries its calls and tokens, and a call without a token count reads as counted only', () => {
  const tree = view()
  const rows = collect(tree, node => node.type === 'tr')
  const keyboard = rows.map(text).find(line => line.includes('键盘'))
  assert.match(keyboard, /12/)
  assert.match(keyboard, /3,400/)
  assert.match(keyboard, /Bot bot_1/)
  const orange = rows.map(text).find(line => line.includes('橙子'))
  assert.match(orange, /Counted only/)
  assert.match(orange, /Dismissed/)
  // A zero would claim the call spent nothing; the row has no number in the token column.
  assert.doesNotMatch(orange, / 0( |$)/)
  const total = rows.map(text).find(line => line.startsWith('Total'))
  assert.match(total, /15/)
  assert.match(total, /3,400/)
})

test('the note says where calls the cut cannot hold went', () => {
  assert.match(text(view()), /Group chats, not counted for a person: 2 calls, 900 tokens/)
  assert.match(text(view({ data: projectData, by: 'project' })), /Calls before any task was dispatched: 1 calls, 300 tokens/)
  assert.doesNotMatch(text(view({ data: timeData, by: 'time' })), /not counted|before any task/)
})

test('the project cut names projects, and the time cut names days', () => {
  const projects = view({ data: projectData, by: 'project' })
  assert.equal(heading(projects), 'Project')
  assert.match(text(projects), /官网改版/)
  const days = view({ data: timeData, by: 'time' })
  assert.equal(heading(days), 'Day')
  assert.match(text(days), /2026-11-19/)
})

test('an empty window, a refusal and a slow read each say what is happening', () => {
  const empty = view({ data: { rows: [], totals: { calls: 0, tokens: 0 }, unattributed: { calls: 0, tokens: 0, reason: 'none' } } })
  assert.match(text(empty), /No usage in this window yet\./)
  assert.equal(byClass(empty, 'bc-co-usage-table').length, 0)
  const refused = view({ error: 'You do not have permission to read usage.' })
  assert.equal(byClass(refused, 'bc-co-usage-table').length, 0)
  assert.match(text(refused), /You do not have permission to read usage\./)
  assert.ok(button(refused, 'Retry'))
  const busy = view({ busy: true })
  assert.match(text(busy), /Reading usage…/)
})

test('the window helper takes today from local midnight and other windows from now', () => {
  const at = new Date(2026, 10, 20, 15, 30, 0, 0).getTime()
  const today = usageWindow(0, at)
  assert.equal(today.to, at)
  const start = new Date(today.from)
  assert.deepEqual([start.getHours(), start.getMinutes(), start.getSeconds()], [0, 0, 0])
  assert.equal(usageWindow(7, at).from, at - 7 * 86_400_000)
  assert.equal(usageWindow(30, at).to, at)
})

const companyModel = () => ({
  company: { id: 'co_1', name: '小晚科技', status: 'active' },
  departments: [{ id: 'dep_1', company_id: 'co_1', name: '工程部', description: '', chat_ref: null, status: 'active', lead_employee_id: null, created_at: 1 }],
  employees: [],
  projects: [],
})

test('the company page carries the entry and the panel, and ships its styles', () => {
  const opened = []
  const tree = CompanyPageView({
    data: companyModel(),
    loading: false, error: '', roster: { ready: true, byId: {}, roomsById: {} },
    openDept: null, creating: null, pan: { x: 0, y: 0 }, dragging: false,
    canCreate: true, canEdit: true, canReadUsage: true, usageOpen: true,
    onUsageOpen: () => opened.push(true),
    onUsageClose: () => opened.push(false),
    onRead: async () => personData,
    onCreateOpen() {}, onCloseDept() {}, onCloseCreate() {}, onOpenDept() {}, onSetLead() {},
  })
  click(button(tree, 'Usage'))
  assert.deepEqual(opened, [true])
  // The page mounts the container, not a bare view: the container owns the cut and the
  // window, so the page only has to say where to read and how to close it.
  const mounted = collect(tree, node => node.type === UsagePanel)[0]
  assert.ok(mounted)
  assert.equal(typeof mounted.props.onRead, 'function')
  assert.equal(typeof mounted.props.onClose, 'function')
  // Without a read path (preview, or a build with no ledger) the entry stays hidden.
  const readOnly = CompanyPageView({
    data: companyModel(), loading: false, error: '', roster: { ready: true, byId: {}, roomsById: {} },
    openDept: null, creating: null, pan: { x: 0, y: 0 }, dragging: false, canCreate: true, canEdit: true,
  })
  assert.equal(button(readOnly, 'Usage'), undefined)
  assert.ok(COMPANY_PAGE_CSS.includes('.bc-co-usage{'))
  assert.ok(COMPANY_PAGE_CSS.includes('.bc-co-usage-table'))
  assert.equal(COMPANY_USAGE_CSS.includes('.bc-co-usage{'), true)
})

test('the panel copy is translated when the interface speaks Chinese', () => {
  for (const key of ['People', 'Person', 'Day', 'Tokens', 'Total', 'Counted only', 'Reading usage…', 'No usage in this window yet.']) {
    assert.ok(Object.hasOwn(DICTIONARY.zh, key), `zh entry for ${key}`)
  }
  assert.equal(DICTIONARY.zh['Counted only'], '按次统计')
})
