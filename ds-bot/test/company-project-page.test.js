import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// ProjectPage renders through the browser's React; the same minimal stand-in as the
// other client tests lets it run as a plain function, without effects or state.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { ProjectPage } from './src/client/project-page.js'",
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
const { ProjectPage } = module.exports

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
const button = (tree, label) => collect(tree, node => node.type === 'button').find(item => text(item).includes(label))

const project = (patch = {}) => ({
  id: 'prj_1',
  company_id: 'co_1',
  name: '演示项目',
  status: 'setup',
  goal: '验证入口',
  deliverable: '一个能点的页面',
  acceptance: '走通',
  source_department_ids: ['dep_1'],
  coordinator_assignment_id: 'mem_1',
  group_binding: { status: 'unbound' },
  ...patch,
})
const data = (patch = {}) => ({
  departments: [{ id: 'dep_1', name: '产品部', status: 'active', chat_ref: 'room_dep' }],
  employees: [{ id: 'emp_1', name: '小蓝', department_id: 'dep_1', status: 'active', bot_id: 'bot_1' }],
  projects: [],
  members: [{ id: 'mem_1', employee_id: 'emp_1', role: 'coordinator', membership_status: 'active' }],
  group: { group_binding: { status: 'unbound' }, drifted: false },
  ...patch,
})
const render = patch => ProjectPage({
  project: patch.project ?? project(),
  data: patch.data ?? data(),
  tasks: [],
  tasksError: '',
  preview: false,
  loading: false,
  error: '',
  onBack() {},
  onChat() {},
  onRetry() {},
  onCommand: patch.onCommand ?? (() => {}),
  onTaskCommand: () => {},
  onArchiveData: async () => ({}),
})

test('an unbound project explains the missing group and offers a repair', async () => {
  const calls = []
  const tree = render({ onCommand: (command, fields) => { calls.push([command, fields]); return Promise.resolve({}) } })
  assert.match(text(tree), /The project group has not been created./)
  const retry = button(tree, 'Create project group')
  assert.ok(retry, 'the unbound state has a create-group button')
  retry.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'project.group.reconcile')
  assert.equal(calls[0][1].project_id, 'prj_1')
})

test('an unbound project without active members says what is missing instead of a dead button', () => {
  const tree = render({ data: data({ members: [] }) })
  assert.match(text(tree), /Add an active member before creating the project group./)
  assert.equal(button(tree, '建立项目群'), undefined)
})

test('a pending group still offers reconciliation', () => {
  const pending = { status: 'pending', room_id: 'room_1', error: 'setMembers failed' }
  const tree = render({ project: project({ group_chat_ref: 'room_1', group_binding: pending }), data: data({ group: { group_binding: pending, drifted: false } }) })
  assert.match(text(tree), /Group needs reconciliation/)
  assert.ok(button(tree, 'Reconcile group'))
})
