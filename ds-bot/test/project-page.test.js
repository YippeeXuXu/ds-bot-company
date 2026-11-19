import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The page draws through the browser's React; bundle it with a stand-in, as the other client
// tests do. The member row keeps its pending state in the page, so the stand-in keeps hook
// slots and re-renders when a handler sets one.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: { contents: "export { ProjectPage } from './src/client/project-page.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})

const slots = []
let frame = null
const render = () => { frame = { next: 0 }; return projectPage(projectProps) }
const useState = initial => {
  const index = frame.next++
  const value = slots[index] === undefined ? (typeof initial === 'function' ? initial() : initial) : slots[index]
  const set = next => {
    const settled = typeof next === 'function' ? next(slots[index]) : next
    if (Object.is(settled, slots[index])) return
    slots[index] = settled
    tree = render()
  }
  return [value, set]
}
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useState,
  useEffect() {},
  useRef: current => ({ current }),
}
const module = { exports: {} }
const sandbox = { module, exports: module.exports, require: name => (name === 'react' ? react : {}), window: {} }
runInNewContext(outputFiles[0].text, sandbox)
const { ProjectPage: projectPage } = module.exports

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
const selects = tree => collect(tree, node => node.type === 'select')
const click = node => { node.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); tree = render() }

const department = (patch = {}) => ({ id: 'dep_1', company_id: 'co_1', name: '研发部', chat_ref: 'room_1', status: 'active', lead_employee_id: null, ...patch })
const employee = (patch = {}) => ({ id: 'emp_1', company_id: 'co_1', bot_id: 'bot_1', department_id: 'dep_1', name: '键盘', role: 'executor', status: 'active', project_id: null, ...patch })
const member = (patch = {}) => ({ id: 'pm_1', project_id: 'prj_1', employee_id: 'emp_1', role: 'executor', membership_status: 'active', ...patch })
const project = (patch = {}) => ({
  id: 'prj_1', company_id: 'co_1', name: '官网改版', status: 'active', source_department_ids: ['dep_1'],
  goal: '改版', deliverable: '站点', acceptance: '评审', group_chat_ref: 'room_2',
  group_binding: { status: 'bound' }, coordinator_assignment_id: null,
  acceptance_actor: null, memory_assignment_id: null, workspace_ref: '/tmp/workspace', ...patch,
})
const data = (patch = {}) => ({
  departments: [department()], employees: [employee(), employee({ id: 'emp_2', name: '橙子', status: 'disabled' })],
  projects: [], members: [member()], ...patch,
})
const baseProps = () => ({
  project: project(), data: data(), preview: false, loading: false, error: '',
  onBack() {}, onChat() {}, onRetry() {}, onCommand: () => Promise.resolve(),
})
let projectProps = baseProps()
let tree
const mount = (patch = {}) => { projectProps = { ...baseProps(), ...patch }; slots.length = 0; tree = render(); return tree }

test('a member row changes its role through project.member.update', async () => {
  const commands = []
  mount({ onCommand: (command, fields) => { commands.push([command, fields]); return Promise.resolve() } })
  const roles = selects(tree).filter(node => String(node.props.className ?? '').includes('bc-member-role'))
  assert.equal(roles.length, 1)
  assert.equal(roles[0].props.value, 'executor')
  roles[0].props.onChange({ target: { value: 'coordinator' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [['project.member.update', { project_id: 'prj_1', employee_id: 'emp_1', role: 'coordinator' }]])
})

test('removing a member asks once, then runs project.member.remove', async () => {
  const commands = []
  mount({ onCommand: (command, fields) => { commands.push([command, fields]); return Promise.resolve() } })
  click(button(tree, 'Remove member'))
  assert.equal(button(tree, 'Remove member'), undefined)
  const confirm = button(tree, 'Confirm removal')
  assert.ok(confirm, 'the second step names the removal')
  click(confirm)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [['project.member.remove', { project_id: 'prj_1', employee_id: 'emp_1' }]])
})

test('a member who left stays visible as history without controls', () => {
  mount({ data: data({ members: [member({ membership_status: 'left' })] }) })
  assert.equal(selects(tree).filter(node => String(node.props.className ?? '').includes('bc-member-role')).length, 0)
  assert.equal(button(tree, 'Remove member'), undefined)
  assert.match(text(tree), /Left/)
  assert.match(text(tree), /keep their history/)
})

test('dismissed employees are never offered as new project members', () => {
  mount({ data: data({ members: [] }) })
  const add = selects(tree).find(node => text(node).includes('Choose an employee'))
  assert.ok(add, 'the add control is there for active staff')
  assert.match(text(add), /键盘/)
  assert.doesNotMatch(text(add), /橙子/)
})

test('a legacy member role reads as text and can still be removed', () => {
  mount({ data: data({ members: [member({ role: 'member' })] }) })
  assert.equal(selects(tree).filter(node => String(node.props.className ?? '').includes('bc-member-role')).length, 0)
  assert.match(text(tree), /member · Active/)
  assert.ok(button(tree, 'Remove member'), 'the row still offers the hand-over')
})

test('archiving asks once and spells out what will close', () => {
  mount({
    tasks: [
      { id: 't1', title: '画草图', stage: 'doing' },
      { id: 't2', title: '写文案', stage: 'ready' },
      { id: 't3', title: '已交的活', stage: 'review', acceptance: { id: 'acc_1', state: 'pending', revision: 1 } },
    ],
  })
  click(button(tree, 'Archive project'))
  const panel = text(tree)
  assert.match(panel, /This will close 3 unfinished tasks and 1 pending acceptances/)
  assert.match(panel, /Nothing can be added after archiving/)
  assert.match(panel, /画草图/)
  assert.match(panel, /写文案/)
})

test('confirming archive reports what the service closed', async () => {
  const commands = []
  mount({
    tasks: [{ id: 't1', title: '画草图', stage: 'doing' }],
    onCommand: (command, fields) => {
      commands.push([command, fields])
      return Promise.resolve({ body: {
        unresolved: [{ kind: 'task', task_id: 't1', title: '画草图', stage: 'doing' }, { kind: 'acceptance', acceptance_id: 'acc_1', title: '独立验收', task_id: null }],
        closed_tasks: [{ task_id: 't1' }],
      } })
    },
  })
  click(button(tree, 'Archive project'))
  const confirm = buttons(tree).filter(item => text(item).includes('Archive project')).pop()
  click(confirm)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [['project.archive', { project_id: 'prj_1' }]])
  assert.match(text(tree), /The project is archived/)
  assert.match(text(tree), /Closed 1 tasks and 1 acceptances/)
  assert.match(text(tree), /画草图/)
})

test('the archive check counts a pending acceptance that has no task', async () => {
  mount({
    tasks: [],
    onArchiveData: () => Promise.resolve({ tasks: [], acceptances: [{ id: 'acc_1', title: '独立验收', state: 'pending', task_id: null }] }),
  })
  click(button(tree, 'Archive project'))
  await new Promise(resolve => setImmediate(resolve))
  assert.match(text(tree), /0 unfinished tasks and 1 pending acceptances/)
  assert.match(text(tree), /独立验收/)
})

test('the archive check blocks confirmation when a fresh read fails', async () => {
  mount({
    tasks: [{ id: 't1', title: '画草图', stage: 'doing' }],
    onArchiveData: () => Promise.reject(new Error('task.list failed')),
  })
  click(button(tree, 'Archive project'))
  await new Promise(resolve => setImmediate(resolve))
  assert.match(text(tree), /The archive check could not be loaded/)
  assert.match(text(tree), /task.list failed/)
  const confirm = buttons(tree).filter(item => text(item).includes('Archive project')).pop()
  assert.equal(confirm.props.disabled, true)
  assert.doesNotMatch(text(tree), /0 unfinished tasks/)
})
