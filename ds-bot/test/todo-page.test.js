import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The page renders through the browser's React; bundle it with the minimal stand-in
// the other client tests use, so the component runs as a plain function.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { TodoPage, TODO_CSS } from './src/client/todo-page.js'",
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
const { TodoPage, TODO_CSS } = module.exports

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
const headings = tree => collect(tree, node => node.type === 'h2').map(heading => text(heading))
const page = (props = {}) => TodoPage({ todos: [], loading: false, error: '', actions: {}, ...props })
const approval = (patch = {}) => ({ id: 'a1', card_kind: 'approval', state: 'pending', ready: true, title: 'Deploy', project_id: 'p1', project_name: 'Project A', risk_text: 'High risk', wait_minutes: 90, ...patch })
const acceptance = (patch = {}) => ({ id: 'k1', card_kind: 'acceptance', state: 'pending', ready: true, title: 'Accept', project_id: 'p2', project_name: 'Project B', requester: 'Keyboard', wait_minutes: 12, ...patch })
const handled = (patch = {}) => ({ id: 'a0', card_kind: 'approval', state: 'approved-human', handled: true, ready: false, title: 'Archive', project_id: 'p1', project_name: 'Project A', wait_minutes: 5, ...patch })

test('the page announces loading once before any decision arrives', () => {
  const tree = page({ loading: true })
  const status = collect(tree, node => node.props?.role === 'status')
  assert.equal(status.length, 1)
  assert.equal(status[0].props['aria-label'], 'Loading todos…')
  assert.equal(button(tree, 'Look at projects'), undefined)
})

test('a failed read offers a retry', () => {
  let retried = 0
  const tree = page({ error: 'network down', onRetry: () => { retried += 1 } })
  const alert = collect(tree, node => node.props?.role === 'alert')
  assert.equal(alert.length, 1)
  assert.match(text(alert[0]), /Todos could not be loaded\./)
  assert.match(text(alert[0]), /network down/)
  click(button(tree, 'Try again'))
  assert.equal(retried, 1)
})

test('no decision reads as the page-level empty state with one way out', () => {
  let opened = 0
  const tree = page({ counts: { waiting_approvals: 0, waiting_acceptances: 0, handled_total: 0 }, actions: { onOpenProjects: () => { opened += 1 } } })
  assert.match(text(tree), /No decisions waiting for you\./)
  assert.deepEqual(headings(tree), [])
  click(button(tree, 'Look at projects'))
  assert.equal(opened, 1)
})

test('approvals, acceptances and handled rows each land in their own section', () => {
  const tree = page({ todos: [approval(), acceptance(), handled()] })
  assert.deepEqual(headings(tree), ['Approvals to confirm 1', 'Acceptances to confirm 1', 'Handled 1'])
  assert.match(text(tree), /Project A · Approval · High risk · Waiting 1 h 30 min/)
  assert.match(text(tree), /Project B · Acceptance review · Submitted by Keyboard · Waiting 12 min/)
  assert.match(text(tree), /Project A · Approval · Approved/)
})

test('a submitted acceptance shows its version, and only when the service sent one', () => {
  const pending = acceptance({ submitted_version: 3 })
  const done = handled({ card_kind: 'acceptance', state: 'accepted', project_name: 'Project B', submitted_version: 2 })
  const tree = page({ todos: [pending, done, acceptance({ id: 'k2', submitted_version: null })] })
  assert.match(text(tree), /Project B · Acceptance review · Version 3 · Submitted by Keyboard · Waiting 12 min/)
  assert.match(text(tree), /Project B · Acceptance review · Version 2 · Passed/)
  assert.doesNotMatch(text(tree), /Version null/)
})

test('counts drive the headings, and a truncated handled group says so', () => {
  const tree = page({
    todos: [approval(), handled()],
    counts: { waiting_approvals: 3, waiting_acceptances: 0, handled_total: 7 },
  })
  assert.deepEqual(headings(tree), ['Approvals to confirm 3', 'Handled 7'])
  assert.match(text(tree), /Only the most recent 1 are shown\./)
})

test('a ready card carries the four ways to decide', () => {
  const calls = []
  const actions = {
    onDecide: (item, decision, options) => { calls.push(['decide', item.id, decision, options?.opinion]) },
    onInvestigate: item => { calls.push(['investigate', item.id]) },
    onOpenProject: item => { calls.push(['open', item.id]) },
  }
  const tree = page({ todos: [approval(), acceptance()], actions })
  const labels = buttons(tree).map(text)
  for (const label of ['Agree', 'Pass', 'Return', 'Look into it', 'Add a note', 'View project']) assert.ok(labels.includes(label), `${label} missing`)
  const primary = buttons(tree).filter(item => item.props.className?.includes('td-action-primary'))
  assert.deepEqual(primary.map(text), ['Agree', 'Pass'])
  click(button(tree, 'Agree'))
  click(button(tree, 'Return'))
  click(button(tree, 'Pass'))
  click(button(tree, 'Look into it'))
  const viewProject = buttons(tree).filter(item => text(item) === 'View project')
  click(viewProject[0])
  assert.deepEqual(calls, [
    ['decide', 'a1', 'approve', ''],
    ['decide', 'a1', 'return', ''],
    ['decide', 'k1', 'approve', ''],
    ['investigate', 'a1'],
    ['open', 'a1'],
  ])
})

test('a card that cannot be answered keeps its reason but loses the decisions', () => {
  const tree = page({ todos: [approval({ ready: false, suspended: true, reason: '已挂起 · 等待中' })] })
  const labels = buttons(tree).map(text)
  for (const label of ['Agree', 'Return', 'Add a note']) assert.equal(labels.includes(label), false)
  assert.ok(labels.includes('Look into it'))
  assert.match(text(tree), /已挂起 · 等待中/)
  assert.equal(collect(tree, node => node.props?.className === 'td-suspended').length, 1)
})

test('a stale row reads as handled elsewhere instead of offering a decision', () => {
  const tree = page({ todos: [approval({ stale: true })] })
  const labels = buttons(tree).map(text)
  assert.equal(labels.includes('Agree'), false)
  assert.ok(labels.includes('Look into it'))
  assert.match(text(tree), /Handled elsewhere\./)
})

test('a handled card keeps one way back and loses its decision actions', () => {
  const tree = page({ todos: [handled({ state: 'returned', opinion: 'Needs a rollback plan' })] })
  assert.match(text(tree), /No decisions waiting for you\./)
  assert.deepEqual(headings(tree), ['Handled 1'])
  const labels = buttons(tree).map(text)
  for (const label of ['Agree', 'Return', 'Add a note']) assert.equal(labels.includes(label), false)
  assert.ok(labels.includes('Look into it'))
  assert.match(text(tree), /Sent back/)
  assert.match(text(tree), /Note: Needs a rollback plan/)
  // View project lives on the card head only, never in the action row.
  assert.equal(buttons(tree).filter(item => text(item) === 'View project').length, 1)
})

test('handled rows keep the order the service returned', () => {
  const tree = page({ todos: [handled({ id: 'h1', title: 'Newer', wait_minutes: 5, handled_at: '2026-11-05T10:00:00Z' }), handled({ id: 'h2', title: 'Older', wait_minutes: 900, handled_at: '2026-11-04T10:00:00Z' })] })
  const titles = collect(tree, node => node.props?.className === 'td-title').map(text)
  assert.deepEqual(titles, ['Newer', 'Older'])
})

test('the longest wait leads its section', () => {
  const short = approval({ id: 'a1', title: 'Short wait', wait_minutes: 5 })
  const long = approval({ id: 'a2', title: 'Long wait', wait_minutes: 600 })
  const tree = page({ todos: [short, long] })
  const titles = collect(tree, node => node.props?.className === 'td-title').map(text)
  assert.deepEqual(titles, ['Long wait', 'Short wait'])
})

test('a row without a project home gives no project link', () => {
  const calls = []
  const tree = page({
    todos: [approval({ project_id: null, project_name: '私聊', ready: false, reason: '请在私聊中处理', reason_code: 'private-chat', session_id: 'session-1', requester_bot_id: null, coordinator_bot_id: null })],
    actions: { onInvestigate: item => { calls.push(['investigate', item.id]) } },
  })
  assert.equal(button(tree, 'View project'), undefined)
  assert.match(text(tree), /请在私聊中处理/)
  // The source session is the way back into a private-chat row.
  const look = button(tree, 'Look into it')
  assert.equal(look.props.disabled, false)
  click(look)
  assert.deepEqual(calls, [['investigate', 'a1']])
})

test('a row with nowhere to look into keeps the action disabled', () => {
  const tree = page({ todos: [approval({ project_id: null, project_name: '私聊', ready: false, reason: '请在私聊中处理', session_id: null, requester_bot_id: null, coordinator_bot_id: null })] })
  assert.equal(button(tree, 'Look into it').props.disabled, true)
})

test('the whole card is not one big button', () => {
  const tree = page({ todos: [approval()] })
  const cards = collect(tree, node => node.props?.className === 'td-card')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].props.onClick, undefined)
  assert.equal(cards[0].props.role, undefined)
})

test('the copy avoids internal words and the sheet keeps the theme tokens', () => {
  const tree = page({ todos: [approval({ wait_minutes: 61 })] })
  assert.match(text(tree), /Waiting 1 h 1 min/)
  assert.doesNotMatch(text(tree), /\b(M1|M2|M3|PRD)\b|蓝图|本原型|演示|样例|四态|宿主|blockers/)
  assert.match(TODO_CSS, /\.td-card\{/)
  assert.match(TODO_CSS, /var\(--bt-/)
  assert.doesNotMatch(TODO_CSS, /#[0-9a-fA-F]{3,8}\b/)
})
