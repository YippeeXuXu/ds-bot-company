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
  const tree = page({ actions: { onOpenProjects: () => { opened += 1 } } })
  assert.match(text(tree), /No decisions waiting for you\./)
  assert.deepEqual(headings(tree), [])
  click(button(tree, 'Look at projects'))
  assert.equal(opened, 1)
})

test('approvals, acceptances and handled rows each land in their own section', () => {
  const approval = { id: 'a1', card_kind: 'approval', state: 'pending', title: 'Deploy to production', project_name: 'Project A', risk_text: 'High risk', wait_minutes: 90 }
  const acceptance = { id: 'k1', card_kind: 'acceptance', state: 'pending', title: 'Accept the report', project_name: 'Project B', requester: 'Keyboard', wait_minutes: 12 }
  const handled = { id: 'a0', card_kind: 'approval', state: 'approved', title: 'Archive the old room', project_name: 'Project A', wait_minutes: 5 }
  const tree = page({ todos: [approval, acceptance, handled] })
  assert.deepEqual(headings(tree), ['Approvals to confirm 1', 'Acceptances to confirm 1', 'Handled 1'])
  assert.match(text(tree), /Project A · Approval · High risk · Waiting 1 h 30 min/)
  assert.match(text(tree), /Project B · Acceptance review · Submitted by Keyboard · Waiting 12 min/)
  assert.match(text(tree), /Project A · Approval · Approved/)
})

test('a pending card carries the four ways to decide', () => {
  const calls = []
  const approval = { id: 'a1', card_kind: 'approval', state: 'pending', title: 'Deploy', project_name: 'Project A', risk_text: 'High risk', wait_minutes: 1 }
  const acceptance = { id: 'k1', card_kind: 'acceptance', state: 'pending', title: 'Accept', project_name: 'Project B', requester: 'Writer', wait_minutes: 2 }
  const actions = {
    onDecide: (item, decision) => { calls.push(['decide', item.id, decision]) },
    onInvestigate: item => { calls.push(['investigate', item.id]) },
    onOpenProject: item => { calls.push(['open', item.id]) },
  }
  const tree = page({ todos: [approval, acceptance], actions })
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
    ['decide', 'a1', 'approve'],
    ['decide', 'a1', 'return'],
    ['decide', 'k1', 'approve'],
    ['investigate', 'a1'],
    ['open', 'a1'],
  ])
})

test('a handled card keeps the way back but loses its decision actions', () => {
  const handled = { id: 'a0', card_kind: 'approval', state: 'returned', title: 'Deploy', project_name: 'Project A', wait_minutes: 5, opinion: 'Needs a rollback plan' }
  const tree = page({ todos: [handled] })
  // No pending rows: the empty sentence still names the state of waiting, and the
  // handled section below carries what happened.
  assert.match(text(tree), /No decisions waiting for you\./)
  assert.deepEqual(headings(tree), ['Handled 1'])
  const labels = buttons(tree).map(text)
  assert.equal(labels.includes('Agree'), false)
  assert.equal(labels.includes('Return'), false)
  assert.equal(labels.includes('Add a note'), false)
  assert.ok(labels.includes('Look into it'))
  assert.match(text(tree), /Sent back/)
  assert.match(text(tree), /Note: Needs a rollback plan/)
})

test('the longest wait leads its section', () => {
  const short = { id: 'a1', card_kind: 'approval', state: 'pending', title: 'Short wait', wait_minutes: 5 }
  const long = { id: 'a2', card_kind: 'approval', state: 'pending', title: 'Long wait', wait_minutes: 600 }
  const tree = page({ todos: [short, long] })
  const titles = collect(tree, node => node.props?.className === 'td-title').map(text)
  assert.deepEqual(titles, ['Long wait', 'Short wait'])
})

test('the whole card is not one big button', () => {
  const item = { id: 'a1', card_kind: 'approval', state: 'pending', title: 'Deploy', wait_minutes: 1 }
  const tree = page({ todos: [item] })
  const cards = collect(tree, node => node.props?.className === 'td-card')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].props.onClick, undefined)
  assert.equal(cards[0].props.role, undefined)
})

test('the copy avoids internal words and the sheet keeps the theme tokens', () => {
  const item = { id: 'a1', card_kind: 'approval', state: 'pending', title: 'Deploy', project_name: 'Project A', risk_text: 'High risk', wait_minutes: 61 }
  assert.doesNotMatch(text(page({ todos: [item] })), /\b(M1|M2|M3|PRD)\b|蓝图|本原型|演示|样例|四态|宿主|blockers/)
  assert.match(TODO_CSS, /\.td-card\{/)
  assert.match(TODO_CSS, /var\(--bt-/)
  assert.doesNotMatch(TODO_CSS, /#[0-9a-fA-F]{3,8}\b/)
})
