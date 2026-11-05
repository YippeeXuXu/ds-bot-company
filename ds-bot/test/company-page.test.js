import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The page renders through the browser's React; bundle it with the same minimal
// stand-in the other client tests use, so the component runs as a plain function.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { CompanyPage, CompanyPageView, COMPANY_PAGE_CSS, botOpenable } from './src/client/company-page.js'\nexport { COMPANY_CSS } from './src/client/projects-page.js'",
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
const sandbox = { module, exports: module.exports, require: name => (name === 'react' ? react : {}) }
runInNewContext(outputFiles[0].text, sandbox)
const { CompanyPage, CompanyPageView, COMPANY_PAGE_CSS, COMPANY_CSS, botOpenable } = module.exports

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
const button = (tree, label) => buttons(tree).find(item => text(item) === label)
const click = node => node.props.onClick?.({ preventDefault() {}, stopPropagation() {} })
const key = (node, name) => node.props.onKeyDown?.({ key: name, preventDefault() {}, stopPropagation() {} })

const department = (patch = {}) => ({ id: 'dep_1', company_id: 'co_1', name: '工程部', description: '', chat_ref: null, status: 'active', created_at: 1, ...patch })
const employee = (patch = {}) => ({ id: 'emp_1', company_id: 'co_1', bot_id: 'bot_1', department_id: 'dep_1', name: '键盘', role: '前端', acceptance_role: null, status: 'active', project_id: 'prj_1', ...patch })
const project = (patch = {}) => ({ id: 'prj_1', company_id: 'co_1', name: '官网改版', status: 'active', created_at: 2, ...patch })
const model = (patch = {}) => ({
  company: { id: 'co_1', name: '小晚科技', status: 'active' },
  departments: [department()],
  employees: [employee()],
  projects: [project()],
  ...patch,
})

const view = (patch = {}) => CompanyPageView({
  data: model(),
  loading: false,
  error: '',
  todos: { counts: { waiting_total: 0 }, todos: [], read_at: null },
  todoLoading: false,
  todoError: '',
  tab: 'overview',
  deptId: null,
  chain: null,
  overflow: false,
  wrapRef: { current: null },
  tabRefs: { current: new Map() },
  deptButtons: { current: new Map() },
  backRef: { current: null },
  onSelectTab() {},
  onTabKey() {},
  onShowDept() {},
  onBackToOrg() {},
  onChain() {},
  onOpenEmployee() {},
  onRetry() {},
  onRetryTodos() {},
  ...patch,
})

const cls = node => String(node.props?.className ?? '').split(/\s+/)
const has = (node, name) => cls(node).includes(name)
const cards = tree => collect(tree, node => node.type === 'div' && has(node, 'bc-co-stat'))
const tabs = tree => collect(tree, node => node.props?.role === 'tab')
const tablist = tree => collect(tree, node => node.props?.role === 'tablist')[0]
const panels = (tree, name) => collect(tree, node => node.props?.['aria-labelledby'] === name)
const chainNodes = tree => buttons(tree).filter(item => has(item, 'bc-co-node'))
const allNodes = tree => collect(tree, node => has(node, 'bc-co-node'))

test('two tabs only, in order, both in the Tab order and announcing their panel', () => {
  const tree = view()
  const list = tabs(tree)
  assert.deepEqual(list.map(item => text(item)), ['Overview', 'Organization'])
  assert.deepEqual(list.map(item => item.props['aria-selected']), ['true', 'false'])
  assert.deepEqual(list.map(item => item.props.tabIndex), [0, 0])
  assert.match(tablist(tree).props['aria-label'], /Company sections/)
  assert.equal(panels(tree, 'bc-co-tab-overview').length, 1)
})

test('left and right arrows switch tabs, and only those two keys do', () => {
  let next = null
  const tree = view({ tab: 'overview', onSelectTab: value => { next = value } })
  key(tablist(tree), 'ArrowRight')
  assert.equal(next, 'org')
  next = null
  key(tablist(tree), 'ArrowLeft')
  assert.equal(next, 'org')
  next = null
  key(tablist(tree), 'ArrowDown')
  assert.equal(next, null)
  key(tablist(tree), 'Enter')
  assert.equal(next, null)
})

test('the overview shows the four counts in the copy-spec order', () => {
  const tree = view({ todos: { counts: { waiting_total: 2 } }, data: model({
    departments: [department(), department({ id: 'dep_2', name: '设计部', created_at: 2 })],
    employees: [employee(), employee({ id: 'emp_2', name: '橙子', project_id: null }), employee({ id: 'emp_3', name: '小蓝', project_id: null, department_id: 'dep_2' })],
    projects: [project(), project({ id: 'prj_2', status: 'setup' }), project({ id: 'prj_3', status: 'archived' })],
  }) })
  const list = cards(tree)
  assert.equal(list.length, 4)
  assert.deepEqual(list.map(card => text(collect(card, node => node.type === 'span' && /bc-co-stat-label/.test(node.props.className))[0])),
    ['Waiting for you', 'Projects in progress', 'Departments', 'Employees'])
  assert.match(text(list[0]), /2/)
  assert.match(text(list[0]), /Includes approvals and acceptances/)
  assert.match(text(list[1]), /^Projects in progress1$/)
  assert.match(text(list[2]), /^Departments2$/)
  assert.match(text(list[3]), /3/)
  assert.match(text(list[3]), /2 outside projects/)
})

test('a decided count of zero drops the sub-line and the accent', () => {
  const tree = view({ data: model({}, {}) , todos: { counts: { waiting_total: 0 } } })
  const first = cards(tree)[0]
  assert.equal(first.props.className.includes('is-strong'), false)
  assert.doesNotMatch(text(first), /Includes approvals and acceptances/)
  assert.match(text(first), /^Waiting for you0$/)
})

test('a failed decision count dims only its own card and offers a retry there', () => {
  let retried = 0
  const tree = view({ todoError: 'network down', onRetryTodos: () => { retried += 1 } })
  assert.equal(collect(tree, node => node.props?.role === 'alert').length, 0, 'no page-level error for one route')
  const first = cards(tree)[0]
  assert.match(text(first), /Waiting for you—/)
  assert.doesNotMatch(text(first), /0/)
  assert.equal(cards(tree).length, 4, 'the other three cards keep their numbers')
  assert.match(text(cards(tree)[1]), /Projects in progress1/)
  click(button(first, 'Could not read. Click to try again.'))
  assert.equal(retried, 1)
})

test('the four cards sit in the Tab order and open nothing', () => {
  const tree = view()
  for (const card of cards(tree)) {
    assert.equal(card.props.tabIndex, 0)
    assert.equal(card.type, 'div', 'a card is not a button: it has no destination yet')
    assert.equal(card.props.onClick, undefined)
  }
})

test('a failed company read keeps the header and tabs, and retries in place', () => {
  let retried = 0
  const tree = view({ error: 'network down', onRetry: () => { retried += 1 } })
  assert.match(text(tree), /Company information could not be loaded\./)
  assert.match(text(tree), /network down/)
  assert.equal(tabs(tree).length, 2)
  click(button(tree, 'Try again'))
  assert.equal(retried, 1)
})

test('loading and "no company yet" are separate states, never the same words', () => {
  const loading = view({ loading: true })
  assert.equal(collect(loading, node => node.props?.role === 'status').length, 1)
  assert.doesNotMatch(text(loading), /No company information yet/)
  const empty = view({ data: model({ company: null }) })
  assert.match(text(empty), /No company information yet/)
  assert.equal(collect(empty, node => node.props?.role === 'alert').length, 0)
})

test('the chart runs company, department, its employees, then the next department', () => {
  const tree = view({ tab: 'org', data: model({
    departments: [department(), department({ id: 'dep_2', name: '设计部', created_at: 3, chat_ref: 'room_1' })],
    employees: [
      employee({ id: 'emp_1', name: '键盘', department_id: 'dep_1' }),
      employee({ id: 'emp_2', name: '橙子', department_id: 'dep_2', project_id: null }),
      employee({ id: 'emp_3', name: '白菜', department_id: 'dep_1', project_id: null }),
    ],
  }) })
  const nodes = allNodes(tree)
  assert.deepEqual(nodes.map(item => collect(item, node => node.type === 'strong').map(text).join('')), ['小晚科技', '工程部', '键盘', '白菜', '设计部', '橙子'])
  assert.deepEqual(nodes.map(item => item.type), ['div', 'button', 'button', 'button', 'button', 'button'])
  assert.match(text(nodes[0]), /小晚科技2 departments · 3 employees · 1 active projects/)
  assert.equal(nodes[0].props.tabIndex, undefined, 'the company node is a label, not a Tab stop')
  assert.equal(nodes[0].props.onClick, undefined, 'and it opens nothing')
  assert.match(nodes[1].props['aria-label'], /Department: 工程部, 2 people/)
  assert.match(text(nodes[1]), /2 people · Department group not bound/)
  assert.match(text(nodes[4]), /1 people · Department group bound/)
  assert.equal(nodes[2].props.tabIndex, 0, 'every node stays reachable from the keyboard')
})

test('the Tab order starts at the first department, not at the company label', () => {
  const stops = chainNodes(view({ tab: 'org' }))
  assert.equal(has(stops[0], 'bc-co-dept'), true, 'the first Tab stop is the department')
  assert.equal(stops.some(item => has(item, 'bc-co-company')), false)
})

test('an empty department keeps its head and says so out of the Tab order', () => {
  const tree = view({ tab: 'org', data: model({ employees: [] }) })
  assert.match(text(tree), /No employees yet/)
  const none = collect(tree, node => has(node, 'bc-co-none'))[0]
  assert.equal(none.type, 'span', 'the empty line is not a focus stop')
})

test('no departments at all is an empty state, not a broken chart', () => {
  const tree = view({ tab: 'org', data: model({ departments: [], employees: [] }) })
  assert.match(text(tree), /No departments yet/)
  assert.match(text(tree), /Employees get a department once departments exist\./)
  assert.equal(chainNodes(tree).length, 0)
})

test('archived departments, employees and projects stay out of the chart and the counts', () => {
  const tree = view({ tab: 'org', data: model({
    departments: [department(), department({ id: 'dep_2', name: '旧部门', status: 'archived' })],
    employees: [employee(), employee({ id: 'emp_2', name: '旧人', status: 'archived' })],
    projects: [project(), project({ id: 'prj_2', name: '旧项目', status: 'archived' })],
  }) })
  const body = text(tree)
  assert.doesNotMatch(body, /旧部门/)
  assert.doesNotMatch(body, /旧人/)
  assert.match(body, /1 departments · 1 employees · 1 active projects/)
})

test('the employee line carries the role only when there is one, then the project', () => {
  const withRole = view({ tab: 'org' })
  assert.match(text(withRole), /键盘前端 · Project: 官网改版/)
  const noRole = view({ tab: 'org', data: model({ employees: [employee({ role: null })] }) })
  assert.match(text(noRole), /键盘Project: 官网改版/)
  assert.doesNotMatch(text(noRole), /未分配|Not assigned/)
  const outside = view({ tab: 'org', data: model({ employees: [employee({ project_id: null })] }) })
  assert.match(text(outside), /键盘前端 · Outside projects/)
  const missing = view({ tab: 'org', data: model({ employees: [employee({ project_id: 'prj_gone' })] }) })
  assert.match(text(missing), /Project information missing/)
  const archived = view({ tab: 'org', data: model({ employees: [employee({ project_id: 'prj_2' })], projects: [project(), project({ id: 'prj_2', name: '旧项目', status: 'archived' })] }) })
  assert.match(text(archived), /Project: 旧项目 \(archived\)/)
})

test('an employee without a Bot stays focusable, announces itself as disabled, and opens nothing', () => {
  let opened = 0
  const tree = view({ tab: 'org', data: model({ employees: [employee({ bot_id: null })] }), onOpenEmployee: () => { opened += 1 } })
  const node = buttons(tree).find(item => has(item, 'bc-co-emp'))
  assert.equal(node.type, 'button')
  assert.equal(node.props.disabled, undefined, 'native disabled would drop it out of the Tab order')
  assert.equal(node.props['aria-disabled'], 'true')
  assert.equal(node.props.tabIndex, 0)
  assert.equal(node.props.title, 'This employee has no Bot yet.')
  click(node)
  assert.equal(opened, 0)
})

test('a bound Bot the roster cannot resolve takes the same disabled shape with its own title', () => {
  let opened = 0
  const tree = view({ tab: 'org', roster: { ready: true, byId: {} }, onOpenEmployee: () => { opened += 1 } })
  const node = buttons(tree).find(item => has(item, 'bc-co-emp'))
  assert.equal(node.props['aria-disabled'], 'true')
  assert.equal(node.props.tabIndex, 0)
  assert.equal(node.props.title, 'This employee cannot open a private chat right now.')
  click(node)
  assert.equal(opened, 0)
})

test('a roster that is still assembling is not a verdict, so nothing flashes disabled', () => {
  assert.equal(botOpenable(employee(), { ready: false, byId: {} }), true, 'not ready is not "unknown Bot"')
  assert.equal(botOpenable(employee(), undefined), true)
  assert.equal(botOpenable(employee(), { ready: true, byId: { bot_1: { id: 'bot_1' } } }), true)
  assert.equal(botOpenable(employee(), { ready: true, byId: {} }), false)
  assert.equal(botOpenable(employee({ bot_id: null }), { ready: false, byId: {} }), false, 'no Bot is never openable')
  const opening = view({ tab: 'org', roster: { ready: false, byId: {} } })
  const node = buttons(opening).find(item => has(item, 'bc-co-emp'))
  assert.equal(node.props['aria-disabled'], undefined)
  assert.equal(node.props.title, 'Chat privately with 键盘')
})

test('an employee with a Bot opens the private chat', () => {
  const opened = []
  const tree = view({ tab: 'org', onOpenEmployee: item => opened.push(item) })
  const node = buttons(tree).find(item => has(item, 'bc-co-emp'))
  assert.equal(node.props['aria-disabled'], undefined)
  assert.equal(node.props.title, 'Chat privately with 键盘')
  click(node)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].bot_id, 'bot_1')
})

test('a department node opens the department page on activation', () => {
  let opened = null
  const tree = view({ tab: 'org', onShowDept: id => { opened = id } })
  click(buttons(tree).find(item => has(item, 'bc-co-dept')))
  assert.equal(opened, 'dep_1')
})

test('hovering or focusing a branch lights only that chain', () => {
  const chains = []
  const tree = view({ tab: 'org', onChain: value => chains.push(value) })
  const departmentNode = buttons(tree).find(item => has(item, 'bc-co-dept'))
  departmentNode.props.onMouseEnter()
  departmentNode.props.onFocus()
  departmentNode.props.onMouseLeave()
  departmentNode.props.onBlur()
  assert.deepEqual(chains, ['dep_1', 'dep_1', null, null])
  const lit = view({ tab: 'org', chain: 'dep_1' })
  const chart = collect(lit, node => has(node, 'bc-co'))[0]
  assert.match(chart.props.className, /is-dim/)
  const nodes = allNodes(lit)
  assert.match(nodes[1].props.className, /is-lit/)
  assert.match(nodes[2].props.className, /is-lit/)
  assert.equal(nodes[0].props.className.includes('is-lit'), true, 'the company end of the chain stays lit')
})

test('a narrow chart says how to reach the rest, and only when it really overflows', () => {
  assert.doesNotMatch(text(view({ tab: 'org' })), /Scroll sideways/)
  assert.match(text(view({ tab: 'org', overflow: true })), /Scroll sideways on a narrow screen to see the whole structure\./)
  assert.match(COMPANY_PAGE_CSS, /\.bc-co\{[^}]*min-width:720px/)
  assert.match(COMPANY_PAGE_CSS, /\.bc-co-branch::before\{[^}]*height:1px/, 'a line joins each department row to the company node')
  assert.doesNotMatch(COMPANY_PAGE_CSS, /bc-co-pill/, 'the department header pill is gone')
  assert.match(COMPANY_PAGE_CSS, /\.bc-co-wrap\{[^}]*overflow-x:auto/)
  assert.match(COMPANY_CSS, /^\n?\.bc-co-page/, 'the page styles ship with the surface styles')
})

test('the department page shows the group state, the staff, and nothing it cannot fill', () => {
  let back = 0
  const tree = view({ tab: 'org', deptId: 'dep_1', onBackToOrg: () => { back += 1 }, data: model({
    departments: [department({ chat_ref: 'room_1' })],
    employees: [employee({ name: '键盘' }), employee({ id: 'emp_2', name: '橙子', role: null, project_id: null })],
  }) })
  assert.match(text(tree), /工程部/)
  assert.match(text(tree), /2 people/)
  assert.match(text(tree), /Department group bound/)
  assert.doesNotMatch(text(tree), /Linked/, 'the header does not repeat the group state')
  assert.doesNotMatch(text(tree), /Not bound yet/)
  assert.match(text(tree), /键盘前端 · Project: 官网改版/)
  assert.match(text(tree), /橙子Outside projects/)
  assert.doesNotMatch(text(tree), /Owner|Capability|Memory keeper/)
  assert.equal(collect(tree, node => node.type === 'h3').length, 2, 'only the group and employee blocks exist')
  click(button(tree, '←'))
  assert.equal(back, 1)
})

test('the department page reads the project the same way the chart does', () => {
  const tree = view({ tab: 'org', deptId: 'dep_1', data: model({
    employees: [employee({ project_id: 'prj_2' }), employee({ id: 'emp_2', name: '橙子', project_id: 'prj_gone' })],
    projects: [project(), project({ id: 'prj_2', name: '旧项目', status: 'archived' })],
  }) })
  assert.match(text(tree), /Project: 旧项目 \(archived\)/)
  assert.match(text(tree), /Project information missing/)
})

test('a department that vanished from the read model says so and offers the way back', () => {
  let back = 0
  const tree = view({ tab: 'org', deptId: 'dep_gone', onBackToOrg: () => { back += 1 } })
  assert.match(text(tree), /This department no longer exists\./)
  click(button(tree, 'Back to organization'))
  assert.equal(back, 1)
})

test('the department page keeps its employees openable, including the ones without a Bot', () => {
  const opened = []
  const tree = view({ tab: 'org', deptId: 'dep_1', data: model({ employees: [employee({ bot_id: null })] }), onOpenEmployee: item => opened.push(item) })
  const row = buttons(tree).find(item => has(item, 'bc-co-row'))
  assert.equal(row.props['aria-disabled'], 'true')
  assert.equal(row.props.tabIndex, 0)
  click(row)
  assert.equal(opened.length, 0)
})

test('the stateful page opens on the overview and reads the decision count through the surface', () => {
  const tree = CompanyPage({
    data: model(),
    loading: false,
    error: '',
    todos: { counts: { waiting_total: 3 } },
    todoLoading: false,
    todoError: '',
    escapeGuard: { current: null },
    onRetry() {},
    onRetryTodos() {},
    onOpenEmployee() {},
  })
  assert.match(text(tree), /Waiting for you3/)
  assert.deepEqual(tabs(tree).map(item => item.props['aria-selected']), ['true', 'false'])
})
