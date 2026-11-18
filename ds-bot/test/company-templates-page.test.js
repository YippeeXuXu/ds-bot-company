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
    contents: "export { TemplatesPageView, TEMPLATES_CSS, sortedTemplates, overrideText, templateUpdatePayload, templateCopyPayload, createBotPayload, templateErrorText } from './src/client/templates-page.js'",
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
  TemplatesPageView, TEMPLATES_CSS, sortedTemplates, overrideText,
  templateUpdatePayload, templateCopyPayload, createBotPayload, templateErrorText,
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
const byClass = (tree, name) => collect(tree, node => String(node.props?.className ?? '').split(' ').includes(name))
const buttons = tree => collect(tree, node => node.type === 'button')
const button = (tree, label) => buttons(tree).find(item => text(item).includes(label))
const fields = tree => collect(tree, node => node.type === 'input' || node.type === 'select' || node.type === 'textarea')
const click = node => node.props.onClick?.({ preventDefault() {}, stopPropagation() {} })
// Values built inside the bundle belong to another realm; compare their data, not their prototypes.
const plain = value => JSON.parse(JSON.stringify(value))

const builtin = (patch = {}) => ({
  id: 'tpl_builtin', company_id: 'co_1', name: '项目统筹', source: 'builtin', origin_template_id: null,
  role: '项目统筹', instructions: '把项目拆成任务，每天汇报一次进度。', model: null, effort: null,
  skills: [], version: 1, status: 'active', created_at: 1, local_overrides: {}, ...patch,
})
const copy = (patch = {}) => ({
  id: 'tpl_copy', company_id: 'co_1', name: '项目统筹（前端）', source: 'copy', origin_template_id: 'tpl_builtin',
  role: '前端工程师', instructions: '写页面，保持键盘可用。', model: 'deepseek/deepseek-v4', effort: 'medium',
  skills: ['browser', 'docs'], version: 3, status: 'active', created_at: 2,
  local_overrides: { effort: 'medium', skills: ['browser', 'docs'] }, ...patch,
})
const roster = {
  ready: true,
  models: [{ ref: 'deepseek/deepseek-v4', name: 'DeepSeek V4', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }] } }],
  capabilities: [{ name: 'browser', kind: 'skill' }, { name: 'docs', kind: 'skill' }],
  byId: {}, roomsById: {},
}
const departments = [
  { id: 'dep_rd', name: '研发部', status: 'active' },
  { id: 'dep_design', name: '设计部', status: 'active' },
]
const handlers = (patch = {}) => ({
  onSelect() {}, onRetry() {}, onStartEdit() {}, onCancelEdit() {}, onForm() {}, onToggleSkill() {},
  onSave() {}, onStartCopy() {}, onCancelCopy() {}, onCopyName() {}, onCopy() {}, onStartBot() {},
  onBotCancel() {}, onBotField() {}, onCreateBot() {}, onArchiveArm() {}, onArchive() {}, ...patch,
})
const props = (patch = {}) => {
  const templates = patch.templates ?? sortedTemplates([copy(), builtin()])
  return {
    templates,
    template: patch.template ?? templates[0],
    departments,
    roster,
    effortOptions: [{ value: '', label: 'Model default' }, { value: 'low', label: 'Low' }],
    loading: false, error: '', failure: '', preview: false, flash: '', form: null,
    copyOpen: false, copyName: '', botDialog: null, archiveArmed: false, busy: false,
    handlers: handlers(patch.handlers),
    ...patch,
    handlers: handlers(patch.handlers),
  }
}

// --- the data shapes the page sends -----------------------------------------

test('the index keeps builtin templates first and drops archived ones', () => {
  const list = sortedTemplates([
    copy({ id: 'tpl_b', created_at: 5 }),
    builtin({ id: 'tpl_a', created_at: 9 }),
    copy({ id: 'tpl_old', status: 'archived', created_at: 1 }),
    builtin({ id: 'tpl_c', created_at: 2 }),
  ])
  assert.deepEqual(plain(list.map(item => item.id)), ['tpl_c', 'tpl_a', 'tpl_b'])
})

test('a copy payload names the copy only when one was typed', () => {
  assert.deepEqual(plain(templateCopyPayload({ id: 'tpl_1' }, '')), { from_template_id: 'tpl_1' })
  assert.deepEqual(plain(templateCopyPayload({ id: 'tpl_1' }, '  我的前端  ')), { from_template_id: 'tpl_1', name: '我的前端' })
})

test('saving the sheet sends null for cleared fields and a fresh skills list', () => {
  const skills = ['browser']
  const payload = templateUpdatePayload({ templateId: 'tpl_1', name: '前端', role: '', instructions: '', model: '', effort: '', skills })
  assert.deepEqual(plain(payload), { template_id: 'tpl_1', name: '前端', role: null, instructions: '', model: null, effort: null, skills: ['browser'] })
  skills.push('docs')
  assert.deepEqual(plain(payload.skills), ['browser'])
})

test('making a Bot sends only what differs from the defaults', () => {
  assert.deepEqual(
    plain(createBotPayload({ templateId: 'tpl_1', departmentId: 'dep_rd', name: '  ', botName: '  ', acceptanceRole: 'executor' })),
    { template_id: 'tpl_1', department_id: 'dep_rd', acceptance_role: 'executor' },
  )
  assert.deepEqual(
    plain(createBotPayload({ templateId: 'tpl_1', departmentId: 'dep_rd', name: '小前', botName: '小前', acceptanceRole: '' })),
    { template_id: 'tpl_1', department_id: 'dep_rd', name: '小前' },
  )
  assert.deepEqual(
    plain(createBotPayload({ templateId: 'tpl_1', departmentId: 'dep_rd', name: '小前', botName: 'Front', acceptanceRole: 'coordinator' })),
    { template_id: 'tpl_1', department_id: 'dep_rd', name: '小前', bot_name: 'Front', acceptance_role: 'coordinator' },
  )
})

test('a failed rollback tells the truth about what was left behind', () => {
  assert.match(templateErrorText({ code: 'employee/capability-missing', details: { missing: ['browser', 'docs'] } }), /browser, docs/)
  assert.match(templateErrorText({ code: 'employee/capability-failed', details: { skill: 'browser' } }), /removed again, so nothing is left behind/)
  assert.match(
    templateErrorText({ code: 'employee/capability-failed', details: { skill: 'browser', bot_left_behind: 'bot_9' } }),
    /Delete Bot bot_9 from the team yourself/,
  )
  assert.match(templateErrorText({ code: 'template/builtin-readonly' }), /read-only/)
  assert.match(templateErrorText({ code: 'something/unheard', message: 'host said no' }), /host said no/)
})

// --- the sheet ---------------------------------------------------------------

test('the head counts what the index holds', () => {
  const tree = TemplatesPageView(props())
  assert.ok(byClass(tree, 'bc-tpl-page').length === 1)
  assert.match(text(byClass(tree, 'bc-tpl-count')[0]), /2 templates/)
  assert.match(text(byClass(tree, 'bc-tpl-head')[0]), /Employee templates/)
  assert.match(text(byClass(tree, 'bc-tpl-head')[0]), /A template is a reusable job description/)
})

test('the index groups builtin templates apart from saved copies', () => {
  const tree = TemplatesPageView(props())
  const groups = byClass(tree, 'bc-tpl-group').map(item => text(item))
  assert.deepEqual(plain(groups), ['Builtin1', 'Saved copies1'])
  const items = byClass(tree, 'bc-tpl-item')
  assert.equal(items.length, 2)
  assert.equal(items[0].props['aria-current'], 'true')
  assert.match(text(items[1]), /No job title · No skills|项目统筹/)
  click(items[1])
})

test('choosing an entry asks for it by id', () => {
  const picked = []
  TemplatesPageView(props({ handlers: { onSelect: id => picked.push(id) } }))
  const tree = TemplatesPageView(props({ handlers: { onSelect: id => picked.push(id) } }))
  click(byClass(tree, 'bc-tpl-item')[1])
  assert.deepEqual(picked, ['tpl_copy'])
})

test('a builtin sheet is readable and offers only a copy', () => {
  const templates = sortedTemplates([builtin(), copy()])
  const tree = TemplatesPageView(props({ templates, template: templates[0] }))
  assert.match(text(byClass(tree, 'bc-kicker')[0]), /Builtin template/)
  assert.match(text(byClass(tree, 'bc-tpl-note')[0]), /read-only/)
  assert.ok(button(tree, 'Make a Bot'))
  assert.ok(button(tree, 'Save a copy'))
  assert.equal(button(tree, 'Edit'), undefined)
  assert.match(text(byClass(tree, 'bc-tpl-foot')[0]), /Builtin templates are read-only/)
})

test('a saved copy can be edited and archived after one confirmation', () => {
  const armed = []
  const templates = sortedTemplates([builtin(), copy()])
  const tree = TemplatesPageView(props({ templates, template: templates[1], handlers: { onArchiveArm: value => armed.push(value) } }))
  assert.match(text(byClass(tree, 'bc-kicker')[0]), /Saved copy/)
  assert.ok(button(tree, 'Edit'))
  click(button(tree, 'Archive this template'))
  assert.deepEqual(armed, [true])

  const confirming = TemplatesPageView(props({ templates, template: templates[1], archiveArmed: true }))
  assert.match(text(confirming), /Archive “项目统筹（前端）”\?/)
  assert.ok(button(confirming, 'Confirm archive'))
})

test('the sheet shows the instructions, the spec and which skills are missing here', () => {
  const templates = sortedTemplates([copy({ effort: 'medium', skills: ['browser', 'canvas'] })])
  const tree = TemplatesPageView(props({ templates, template: templates[0], effortOptions: [{ value: '', label: 'Model default' }, { value: 'medium', label: 'Medium' }] }))
  assert.match(text(byClass(tree, 'bc-tpl-doc-body')[0]), /写页面，保持键盘可用/)
  const skills = byClass(tree, 'bc-tpl-skill')
  assert.equal(skills.length, 2)
  assert.equal(skills[0].props.className.includes('is-missing'), false)
  assert.equal(skills[1].props.className.includes('is-missing'), true)
  assert.match(skills[1].props.title, /does not have this skill/)
  assert.match(text(tree), /Version/)
})

test('a thinking level without a model is flagged before anyone tries to make the Bot', () => {
  const templates = sortedTemplates([copy({ model: null, effort: 'medium' })])
  const tree = TemplatesPageView(props({ templates, template: templates[0] }))
  assert.match(text(byClass(tree, 'bc-exception')[0]), /sets a thinking level but no model/)
})

test('empty and failed loads each say what happened and what to do', () => {
  const empty = TemplatesPageView(props({ templates: [], template: null }))
  assert.match(text(empty), /No templates here yet/)
  const failed = TemplatesPageView(props({ templates: [], template: null, error: 'network down' }))
  assert.match(text(failed), /The templates could not be loaded./)
  assert.match(text(failed), /network down/)
  assert.ok(button(failed, 'Try again'))
})

test('the preview shows the library but offers no write actions', () => {
  const tree = TemplatesPageView(props({ preview: true }))
  assert.equal(button(tree, 'Make a Bot'), undefined)
  assert.equal(button(tree, 'Save a copy'), undefined)
  assert.equal(button(tree, 'Edit'), undefined)
})

// --- editing -----------------------------------------------------------------

test('the edit form starts from the template and cannot be saved without a name', () => {
  const form = { name: '前端工程师', role: '前端工程师', instructions: '写页面', model: 'deepseek/deepseek-v4', effort: 'medium', skills: ['browser'] }
  const tree = TemplatesPageView(props({ form }))
  const inputs = byClass(tree, 'bc-tpl-form')[0]
  const chips = byClass(tree, 'bc-tpl-skills-edit')[0]
  const pressed = collect(chips, node => node.type === 'button').filter(node => node.props['aria-pressed'])
  assert.equal(pressed.length, 1)
  assert.match(text(pressed[0]), /browser/)
  const save = button(tree, 'Save changes')
  assert.equal(save.props.disabled, false)

  const blank = TemplatesPageView(props({ form: { ...form, name: '   ' } }))
  assert.equal(button(blank, 'Save changes').props.disabled, true)
})

test('the edit form reports a refused save in place', () => {
  const form = { name: '前端', role: '', instructions: '', model: '', effort: '', skills: [] }
  const tree = TemplatesPageView(props({ form, failure: 'A template with this name already exists. Pick another name.' }))
  assert.match(text(byClass(tree, 'bc-exception')[0]), /already exists/)
})

test('the copy row asks for a name and hands the work back', () => {
  const done = []
  const tree = TemplatesPageView(props({ copyOpen: true, copyName: '我的副本', handlers: { onCopy: () => done.push('copy') } }))
  assert.ok(fields(tree).some(node => node.props.value === '我的副本'))
  click(button(tree, 'Save the copy'))
  assert.deepEqual(done, ['copy'])
})

test('a refused copy keeps its message inside the copy row', () => {
  const tree = TemplatesPageView(props({ copyOpen: true, copyName: '项目统筹', failure: 'A template with this name already exists. Pick another name.' }))
  assert.match(text(byClass(tree, 'bc-tpl-copyrow')[0]), /already exists/)
})

test('a refused archive says so on the sheet, not only in the form', () => {
  const tree = TemplatesPageView(props({ failure: 'This builtin template is read only.' }))
  assert.match(text(byClass(tree, 'bc-exception')[0]), /read only/)
})

// --- making a Bot ------------------------------------------------------------

test('the make-a-Bot dialog names the department, the employee and the Bot', () => {
  const dialog = { departmentId: 'dep_rd', name: '小前', botName: '', acceptanceRole: 'executor', error: '' }
  const tree = TemplatesPageView(props({ botDialog: dialog }))
  assert.equal(byClass(tree, 'bc-tpl-modal').length, 1)
  assert.match(text(byClass(tree, 'bc-tpl-modal-card')[0]), /Make a Bot from this template/)
  const selects = collect(byClass(tree, 'bc-tpl-modal-card')[0], node => node.type === 'select')
  assert.equal(selects[0].props.value, 'dep_rd')
  assert.equal(selects[1].props.value, 'executor')
  assert.equal(button(tree, 'Make the Bot').props.disabled, false)
})

test('the dialog will not submit without a department or a name', () => {
  const missingDept = TemplatesPageView(props({ botDialog: { departmentId: '', name: '小前', botName: '', acceptanceRole: 'executor', error: '' } }))
  assert.equal(button(missingDept, 'Make the Bot').props.disabled, true)
  const missingName = TemplatesPageView(props({ botDialog: { departmentId: 'dep_rd', name: '  ', botName: '', acceptanceRole: 'executor', error: '' } }))
  assert.equal(button(missingName, 'Make the Bot').props.disabled, true)
})

test('a refusal stays in the dialog, next to the values it is about', () => {
  const dialog = { departmentId: 'dep_rd', name: '小前', botName: '', acceptanceRole: 'executor', error: 'A Bot with this name already exists. Give this one another name.' }
  const tree = TemplatesPageView(props({ botDialog: dialog }))
  assert.match(text(byClass(tree, 'bc-tpl-modal-card')[0]), /A Bot with this name already exists/)
})

test('the fields report what was typed, and the close button gets out', () => {
  const seen = []
  const tree = TemplatesPageView(props({
    botDialog: { departmentId: 'dep_rd', name: '小前', botName: '', acceptanceRole: 'executor', error: '' },
    handlers: { onBotField: (key, value) => seen.push([key, value]), onBotCancel: () => seen.push(['cancel']) },
  }))
  const card = byClass(tree, 'bc-tpl-modal-card')[0]
  const inputs = collect(card, node => node.type === 'input')
  inputs[0].props.onChange({ target: { value: '小蓝' } })
  collect(card, node => node.type === 'select')[0].props.onChange({ target: { value: 'dep_design' } })
  click(byClass(card, 'bc-co-pop-close')[0])
  assert.deepEqual(seen, [['name', '小蓝'], ['departmentId', 'dep_design'], ['cancel']])
})

test('the fresh sheet says what a template is', () => {
  assert.match(TEMPLATES_CSS, /\.bc-tpl-page/)
  assert.match(TEMPLATES_CSS, /\.bc-tpl-modal-card/)
  const tree = TemplatesPageView(props({ flash: '“小前” is on the team with 2 skills.' }))
  assert.match(text(byClass(tree, 'bc-tpl-flash')[0]), /is on the team with 2 skills/)
})
