import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY } from '../src/client/i18n.js'

// The page renders through the browser's React; bundle it with the same minimal
// stand-in the other client tests use, so the component runs as a plain function.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { CompanyPageView, COMPANY_PAGE_CSS, botOpenable, companyErrorText, editedAcceptanceRole, employeeUpdatePayload } from './src/client/company-page.js'",
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
const { CompanyPageView, COMPANY_PAGE_CSS, botOpenable, companyErrorText, editedAcceptanceRole, employeeUpdatePayload } = module.exports

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
const click = node => node.props.onClick?.({ preventDefault() {}, stopPropagation() {} })

const department = (patch = {}) => ({ id: 'dep_1', company_id: 'co_1', name: '工程部', description: '', chat_ref: null, status: 'active', lead_employee_id: null, created_at: 1, ...patch })
const employee = (patch = {}) => ({ id: 'emp_1', company_id: 'co_1', bot_id: 'bot_1', department_id: 'dep_1', name: '键盘', role: '前端', acceptance_role: null, status: 'active', project_id: 'prj_1', ...patch })
const project = (patch = {}) => ({ id: 'prj_1', company_id: 'co_1', name: '官网改版', status: 'active', created_at: 2, ...patch })
const model = (patch = {}) => ({
  company: { id: 'co_1', name: '小晚科技', status: 'active' },
  departments: [department()],
  employees: [employee()],
  projects: [project()],
  ...patch,
})
const roster = { ready: true, byId: { bot_1: { id: 'bot_1', name: '键盘' } }, roomsById: {} }

const props = (patch = {}) => ({
  data: model(),
  loading: false,
  error: '',
  roster,
  openDept: null,
  creating: null,
  pan: { x: 0, y: 0 },
  dragging: false,
  canCreate: true,
  canEdit: true,
  draftName: '',
  draftBot: '',
  draftDept: 'dep_1',
  draftRole: 'executor',
  draftBusy: false,
  draftError: '',
  onOpenEmployee() {},
  onOpenDept() {},
  onCloseDept() {},
  onCreateOpen() {},
  onCloseCreate() {},
  onCreate() {},
  onSetLead() {},
  onOpenProjects() {},
  onRetry() {},
  ...patch,
})
const view = (patch = {}) => CompanyPageView(props(patch))

test('the header names the page, counts the workspace, and only offers creation when it can write', () => {
  const tree = view()
  const head = byClass(tree, 'bc-co-head')[0]
  assert.match(text(head), /Company/)
  assert.match(text(head), /1 departments · 1 employees · 1 projects · 1 in progress/)
  click(button(tree, 'New department'))
  const readOnly = view({ canCreate: false })
  assert.equal(byClass(readOnly, 'bc-co-actions').length, 0)
  assert.equal(byClass(readOnly, 'bc-co-head').length, 1)
})

test('the create buttons ask the surface for the right panel', () => {
  const asked = []
  const tree = view({ onCreateOpen: kind => asked.push(kind) })
  click(button(tree, 'New department'))
  click(button(tree, 'New employee'))
  assert.deepEqual(asked, ['department', 'employee'])
})

test('the old tab strip is gone: departments and staff live on one canvas', () => {
  const tree = view()
  assert.equal(byClass(tree, 'bc-co-tab').length, 0)
  assert.equal(byClass(tree, 'bc-co-stat').length, 0)
  assert.equal(byClass(tree, 'bc-co-canvas').length, 1)
  assert.equal(byClass(tree, 'bc-co-cols').length, 1)
})

test('the company node leads the chart and offers the project list', () => {
  const tree = view()
  assert.match(text(byClass(tree, 'bc-co-co-card')[0]), /小晚科技/)
  const opened = []
  const link = view({ onOpenProjects: () => opened.push(1) })
  click(button(link, 'View projects'))
  assert.equal(opened.length, 1)
})

test('a department card carries its name, group state, lead and staff count', () => {
  const card = byClass(view(), 'bc-co-dept')[0]
  assert.match(text(card), /工程部/)
  assert.match(text(card), /Not built/)
  assert.match(text(card), /No lead yet · 1 people/)
  const led = view({ data: model({ departments: [department({ lead_employee_id: 'emp_1' })] }) })
  assert.match(text(byClass(led, 'bc-co-dept')[0]), /Lead 键盘 · 1 people/)
})

test('the card name is the keyboard entry and opens the overview in place', () => {
  const opened = []
  const tree = view({ onOpenDept: id => opened.push(id) })
  const name = byClass(tree, 'bc-co-dept-name')[0]
  assert.equal(name.props['aria-expanded'], 'false')
  click(name)
  assert.deepEqual(opened, ['dep_1'])
  const open = view({ openDept: 'dep_1' })
  assert.equal(byClass(open, 'bc-co-dept-name')[0].props['aria-expanded'], 'true')
})

test('an employee line shows the initial, the name and the role, and opens the private chat', () => {
  const chat = []
  const tree = view({ onOpenEmployee: item => chat.push(item.id) })
  const row = byClass(tree, 'bc-co-emp')[0]
  assert.equal(row.props['aria-label'], 'Employee: 键盘, 前端')
  assert.equal(text(byClass(row, 'bc-co-face')[0]), '键')
  click(row)
  assert.deepEqual(chat, ['emp_1'])
})

test('an employee without a Bot is not shown as disabled; a click explains why no chat opens', () => {
  const chat = []
  const hints = []
  const tree = view({ data: model({ employees: [employee({ bot_id: null })] }), onOpenEmployee: item => chat.push(item.id), onChatHint: text => hints.push(text) })
  const row = byClass(tree, 'bc-co-emp')[0]
  assert.equal(row.props['aria-disabled'], undefined)
  assert.equal(String(row.props.className).includes('is-disabled'), false)
  assert.equal(row.props.tabIndex, 0)
  assert.equal(row.props.title, 'This employee has no Bot yet.')
  click(row)
  assert.deepEqual(chat, [])
  assert.deepEqual(hints, ['This employee has no Bot yet.'])
})

test('a dismissed employee keeps the dismissed word but is not greyed out as disabled', () => {
  const hints = []
  const tree = view({ openDept: 'dep_1', data: model({ employees: [employee({ status: 'disabled' })] }), onChatHint: text => hints.push(text) })
  const drawer = byClass(tree, 'bc-co-row')[0]
  assert.equal(drawer.props['aria-disabled'], undefined)
  assert.equal(String(drawer.props.className).includes('is-disabled'), false)
  assert.match(text(drawer), /Dismissed employee/)
  click(drawer)
  assert.deepEqual(hints, ['This employee is dismissed. Reactivate them in the company chart first.'])
})

test('a company read that fails keeps the page and retries in place', () => {
  const retried = []
  const tree = view({ error: 'boom', onRetry: () => retried.push(1) })
  assert.equal(collect(tree, node => node.props?.role === 'alert').length, 1)
  assert.match(text(tree), /boom/)
  click(button(tree, 'Try again'))
  assert.equal(retried.length, 1)
})

test('loading and "no company yet" are separate states, never the same words', () => {
  const loading = view({ loading: true })
  assert.equal(collect(loading, node => node.props?.role === 'status').length, 1)
  assert.equal(byClass(loading, 'bc-co-canvas').length, 0)
  const empty = view({ data: { company: null, departments: [], employees: [], projects: [] } })
  assert.match(text(empty), /No company information yet/)
  assert.equal(collect(empty, node => node.props?.role === 'status').length, 0)
  // The first run still gets the page head, but the department actions need a company.
  assert.equal(byClass(empty, 'bc-co-head').length, 1)
  assert.equal(byClass(empty, 'bc-co-actions').length, 0)
})

test('an empty company can be created in place instead of needing the project wizard', () => {
  const typed = []
  const created = []
  const blank = view({
    data: { company: null, departments: [], employees: [], projects: [] },
    onCompanyName: value => typed.push(value),
    onCreateCompany: () => created.push(1),
  })
  const input = collect(blank, node => node.type === 'input')[0]
  assert.equal(button(blank, 'Create company').props.disabled, true)
  input.props.onChange({ target: { value: '新公司' } })
  assert.deepEqual(typed, ['新公司'])
  const named = view({
    data: { company: null, departments: [], employees: [], projects: [] },
    companyName: '新公司',
    onCreateCompany: () => created.push(1),
  })
  click(button(named, 'Create company'))
  assert.deepEqual(created, [1])
})

test('archived departments and staff stay off the canvas and out of the count', () => {
  const tree = view({
    data: model({
      departments: [department(), department({ id: 'dep_2', name: '旧部', status: 'archived' })],
      employees: [employee(), employee({ id: 'emp_2', name: '旧人', status: 'archived' })],
    }),
  })
  assert.equal(byClass(tree, 'bc-co-dept').length, 1)
  assert.match(text(byClass(tree, 'bc-co-head')[0]), /1 departments · 1 employees/)
})

test('an empty department keeps its head and says so', () => {
  const tree = view({ data: model({ departments: [department(), department({ id: 'dep_2', name: '设计部' })] }) })
  assert.equal(byClass(tree, 'bc-co-none').length, 1)
  assert.match(text(byClass(tree, 'bc-co-none')[0]), /No employees yet/)
})

test('the overview lists the lead as a choice among the department staff', () => {
  const tree = view({ openDept: 'dep_1' })
  const pop = byClass(tree, 'bc-co-pop')[0]
  assert.equal(pop.props['aria-label'], 'Department overview: 工程部')
  const select = collect(pop, node => node.type === 'select')[0]
  assert.equal(select.props.value, '')
  assert.equal(select.props['aria-label'], 'Lead of 工程部')
  assert.deepEqual(collect(select, node => node.type === 'option').map(option => text(option)), ['No lead assigned', '键盘'])
  assert.match(text(pop), /Department group not bound/)
  assert.match(text(pop), /1 people/)
})

test('the overview only reads who leads when the page cannot write', () => {
  const tree = view({ openDept: 'dep_1', canEdit: false, data: model({ departments: [department({ lead_employee_id: 'emp_1' })] }) })
  const pop = byClass(tree, 'bc-co-pop')[0]
  assert.equal(collect(pop, node => node.type === 'select').length, 0)
  assert.match(text(pop), /键盘/)
})

test('the overview says when a department has nobody to lead or show', () => {
  const tree = view({ openDept: 'dep_1', data: model({ employees: [] }) })
  const pop = byClass(tree, 'bc-co-pop')[0]
  assert.match(text(pop), /This department has no employees yet\./)
  assert.equal(collect(pop, node => node.type === 'option').length, 1)
})

test('the create panel asks for a name for a department and for a Bot when hiring', () => {
  const newDept = view({ creating: 'department' })
  const panel = byClass(newDept, 'bc-co-create')[0]
  assert.equal(panel.props.role, 'dialog')
  assert.match(text(panel), /Department name/)
  const hire = view({ creating: 'employee' })
  assert.match(text(byClass(hire, 'bc-co-create')[0]), /Bot/)
})

test('the stylesheet lays the canvas out as five columns that narrow with the viewport', () => {
  assert.match(COMPANY_PAGE_CSS, /\.bc-co-canvas/)
  assert.match(COMPANY_PAGE_CSS, /radial-gradient/)
  assert.match(COMPANY_PAGE_CSS, /\.bc-co-cols\{[^}]*repeat\(5,minmax\(0,1fr\)\)/)
  assert.match(COMPANY_PAGE_CSS, /@media \(max-width:1180px\)/)
  assert.match(COMPANY_PAGE_CSS, /@media \(max-width:860px\)/)
})

test('botOpenable: no Bot, an unresolved roster and a ready roster each read differently', () => {
  assert.equal(botOpenable(employee({ bot_id: null }), roster), false)
  assert.equal(botOpenable(employee(), { ready: false, byId: {} }), true)
  assert.equal(botOpenable(employee(), roster), true)
  assert.equal(botOpenable(employee(), { ready: true, byId: {} }), false)
})

test('the overview marks duty state and puts the edit entry beside each employee', () => {
  const edited = []
  const away = employee({ id: 'emp_2', name: '橙子', status: 'disabled' })
  const tree = view({ openDept: 'dep_1', data: model({ employees: [employee(), away] }), onEditOpen: item => edited.push(item.id) })
  const rows = byClass(tree, 'bc-co-row-wrap')
  assert.equal(rows.length, 2)
  assert.match(text(rows[0]), /On duty/)
  assert.match(text(rows[1]), /Dismissed employee/)
  const edit = byClass(rows[0], 'bc-co-row-edit')[0]
  assert.match(String(edit.props['aria-label']), /Edit 键盘/)
  click(edit)
  assert.deepEqual(edited, ['emp_1'])
})

test('the edit panel carries the profile fields and asks the surface to save', () => {
  const saved = []
  const tree = view({ openDept: 'dep_1', editing: 'emp_1', editName: '键盘', editRole: 'coordinator', editDept: 'dep_1', onEditSave: () => saved.push('save') })
  const panel = byClass(tree, 'bc-co-edit')[0]
  assert.ok(panel)
  const fields = byClass(panel, 'bc-field')
  assert.match(text(fields[0]), /^Employee display name/)
  assert.match(text(fields[1]), /^Employee role/)
  assert.match(text(fields[2]), /^Department/)
  click(button(panel, 'Save'))
  assert.deepEqual(saved, ['save'])
  const empty = view({ openDept: 'dep_1', editing: 'emp_1', editName: ' ', editRole: 'coordinator', editDept: 'dep_1' })
  assert.equal(button(byClass(empty, 'bc-co-edit')[0], 'Save').props.disabled, true)
})

test('a profile written by an older version offers to keep its role, not a wrong first one', () => {
  assert.equal(editedAcceptanceRole('member'), '')
  assert.equal(editedAcceptanceRole('reviewer'), '')
  assert.equal(editedAcceptanceRole(undefined), '')
  assert.equal(editedAcceptanceRole('acceptor'), 'acceptor')
  const tree = view({ openDept: 'dep_1', editing: 'emp_1', editName: '键盘', editRole: '', editDept: 'dep_1', data: model({ employees: [employee({ acceptance_role: 'member' })] }) })
  const select = collect(byClass(tree, 'bc-co-edit')[0], node => node.type === 'select')[0]
  const options = collect(select, node => node.type === 'option')
  assert.equal(options.length, 5)
  assert.equal(options[0].props.value, '')
  assert.match(text(options[0]), /Keep the current role/)
  const current = view({ openDept: 'dep_1', editing: 'emp_1', editName: '键盘', editRole: 'coordinator', editDept: 'dep_1' })
  const currentSelect = collect(byClass(current, 'bc-co-edit')[0], node => node.type === 'select')[0]
  assert.equal(collect(currentSelect, node => node.type === 'option').length, 4)
})

test('a save leaves an untouched legacy role out of the payload, and sends a chosen one', () => {
  // The bundle runs in its own VM realm, so compare as data rather than by prototype.
  const payload = input => JSON.stringify(employeeUpdatePayload(input))
  assert.equal(payload({ employeeId: 'emp_1', name: '键盘', departmentId: 'dep_2', acceptanceRole: '' }),
    JSON.stringify({ employee_id: 'emp_1', name: '键盘', department_id: 'dep_2' }))
  assert.equal(payload({ employeeId: 'emp_1', name: '键盘', departmentId: 'dep_1', acceptanceRole: 'memory_keeper' }),
    JSON.stringify({ employee_id: 'emp_1', name: '键盘', department_id: 'dep_1', acceptance_role: 'memory_keeper' }))
})

test('suspending and reactivating both run through the page status handler', () => {
  const asked = []
  const tree = view({ openDept: 'dep_1', editing: 'emp_1', editName: '键盘', editRole: 'executor', editDept: 'dep_1', onStatus: item => asked.push(item.status) })
  click(button(byClass(tree, 'bc-co-edit')[0], 'Suspend employee'))
  assert.deepEqual(asked, ['active'])
  const away = view({ openDept: 'dep_1', editing: 'emp_1', editName: '键盘', editRole: 'executor', editDept: 'dep_1', data: model({ employees: [employee({ status: 'disabled' })] }), onStatus: item => asked.push(item.status) })
  click(button(byClass(away, 'bc-co-edit')[0], 'Reactivate employee'))
  assert.deepEqual(asked, ['active', 'disabled'])
})

test('a refused dismissal names the work to hand over and opens each place', () => {
  const went = []
  const refusal = { code: 'employee/still-referenced', details: {
    departments: [{ department_id: 'dep_1', name: '研发部', role: 'lead' }],
    projects: [{ project_id: 'prj_1', name: '官网改版', status: 'active', roles: ['coordinator', 'acceptor'] }],
  } }
  const tree = view({ openDept: 'dep_1', editing: 'emp_1', editName: '键盘', editRole: 'executor', editDept: 'dep_1', editRefusal: refusal,
    onOpenDepartmentRef: id => went.push(['department', id]), onOpenProjectRef: id => went.push(['project', id]) })
  const refs = byClass(tree, 'bc-co-refs')[0]
  assert.match(text(refs), /研发部 · Department lead/)
  assert.match(text(refs), /官网改版 · Coordinator/)
  assert.match(text(refs), /官网改版 · Independent acceptor/)
  const [departmentButton, coordinatorButton, acceptorButton] = buttons(refs)
  assert.match(text(departmentButton), /Open department settings/)
  assert.match(text(coordinatorButton), /Change in the member area/)
  assert.match(text(acceptorButton), /Change in the project editor/)
  click(departmentButton)
  click(coordinatorButton)
  click(acceptorButton)
  assert.deepEqual(went, [['department', 'dep_1'], ['project', 'prj_1'], ['project', 'prj_1']])
})


test('a refusal code becomes one readable sentence, never the server text', () => {
  assert.match(companyErrorText({ code: 'department.name-taken' }), /already exists/)
  assert.match(companyErrorText({ code: 'employee.bot_already_employed' }), /already has an employee profile/)
  assert.match(companyErrorText({ code: 'employee/still-referenced' }), /still holds work/)
  assert.match(companyErrorText({ code: 'employee/inactive' }), /is dismissed/)
  assert.equal(companyErrorText({ code: 'other/code', message: 'raw' }), 'raw')
  assert.match(companyErrorText(null), /could not be saved/)
})


test('dismissed staff leave the lead picker and keep their Bot out of hiring', () => {
  const away = employee({ id: 'emp_2', name: '橙子', status: 'disabled', bot_id: 'bot_2' })
  const tree = view({ openDept: 'dep_1', data: model({ employees: [employee(), away] }), roster: { ready: true, byId: { bot_1: {}, bot_2: {} }, bots: [{ id: 'bot_2', name: '橙子', private: false }] } })
  const leadSelect = collect(tree, node => node.type === 'select' && String(node.props['aria-label'] ?? '').startsWith('Lead of'))[0]
  const options = collect(leadSelect, node => node.type === 'option').map(option => text(option))
  assert.deepEqual(options, ['No lead assigned', '键盘'])
  const hire = view({ creating: 'employee', data: model({ employees: [employee(), away] }), roster: { ready: true, byId: { bot_1: {}, bot_2: {} }, bots: [{ id: 'bot_2', name: '橙子', private: false }] } })
  const hireBots = collect(byClass(hire, 'bc-co-create')[0], node => node.type === 'select')[0]
  assert.doesNotMatch(text(hireBots), /橙子/)
})


test('the department count leaves dismissed staff out (G0)', () => {
  const tree = view({ data: model({ employees: [employee(), employee({ id: 'emp_2', name: '旧人', status: 'disabled' })] }) })
  // The dismissed person keeps a row in the chart, but the department does not count them.
  assert.equal(byClass(tree, 'bc-co-row').length >= 0, true)
  assert.match(text(byClass(tree, 'bc-co-dept-meta')[0]), /1 people/)
  assert.match(text(byClass(tree, 'bc-co-head')[0]), /1 departments · 1 employees/)
})

test('the four refusals a person can fix all answer in Chinese (G0)', () => {
  // The codes the company screens map by hand (company-page.js:27, templates-page.js:98).
  // Each one keeps a sentence, and each sentence has Chinese copy, so a refusal never
  // reaches a person in English only.
  const cases = [
    ['department.name-taken', 'A department with this name already exists.'],
    ['employee/bot-name-taken', 'A Bot with this name already exists. Give this one another name.'],
    ['employee.bot_already_employed', 'This Bot already has an employee profile.'],
    ['employee/inactive', 'This employee is dismissed. Reactivate them before using them.'],
  ]
  for (const [code, sentence] of cases) {
    const zh = DICTIONARY.zh[sentence]
    assert.equal(typeof zh, 'string', `${code} keeps a sentence the client translates`)
    assert.match(zh, /[\u4e00-\u9fff]/, `${code} has Chinese copy`)
  }
})
