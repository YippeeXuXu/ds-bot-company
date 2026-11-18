import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { TaskBoardView, TASK_BOARD_CSS, TASK_COLUMNS, TASK_TABS, TASK_STAGE_WORDS, taskActionCommand, taskSubmitCommand, taskFailCommand, taskReopenCommand, taskDecideCommand, acceptanceReady, taskRevision, taskMoveTargets, taskStatusLabel, taskStage, taskErrorText, taskBadges, taskDependencyCount, taskOwnerName, taskWhen } from './src/client/task-board.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
})
const react = {
  // Components in this page are plain functions; call them so the tree is fully rendered.
  createElement: (type, props, ...children) => (typeof type === 'function'
    ? type({ ...props, children })
    : { type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {},
  useRef: current => ({ current }),
}
const module = { exports: {} }
const sandbox = { module, exports: module.exports, require: name => (name === 'react' ? react : {}), window: { addEventListener() {}, removeEventListener() {} } }
runInNewContext(outputFiles[0].text, sandbox)
const {
  TaskBoardView, TASK_BOARD_CSS, TASK_COLUMNS, TASK_TABS, taskActionCommand,
  taskSubmitCommand, taskFailCommand, taskReopenCommand, taskDecideCommand, acceptanceReady, taskRevision, taskMoveTargets,
  taskStatusLabel, taskStage, taskErrorText, taskBadges, taskDependencyCount, taskOwnerName, taskWhen,
} = module.exports

const plain = value => JSON.parse(JSON.stringify(value))
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
const selects = tree => collect(tree, node => node.type === 'select')

const employees = [{ id: 'emp_1', name: '键盘' }, { id: 'emp_2', name: '橙子' }]
const task = (patch = {}) => ({
  id: 'task_1', project_id: 'prj_1', title: '搭任务板', stage: 'doing', owner_employee_id: 'emp_1',
  next_step: '把五列排好', latest_artifact_at: Date.now() - 30 * 60 * 1000, ...patch,
})
const tasks = () => [
  task({ id: 'task_draft', title: '起草案', stage: 'draft' }),
  task({ id: 'task_ready', title: '准备开工', stage: 'ready' }),
  task({ id: 'task_doing', title: '搭任务板', stage: 'doing', dependency_count: 2 }),
  task({ id: 'task_review', title: '等验收', stage: 'review', waiting_on: 'approval' }),
  task({ id: 'task_done', title: '已完成的活', stage: 'done' }),
  task({ id: 'task_cancelled', title: '取消的活', stage: 'cancelled' }),
]
const view = (patch = {}) => TaskBoardView({
  tasks: tasks(), employees, selectedId: '', tab: 'detail', busy: false, error: '', draggingId: '',
  dropTarget: '', showCancelled: false, onToggleCancelled() {}, onSelect() {}, onClose() {}, onTab() {},
  onDragStart() {}, onDragEnd() {}, onDragOver() {}, onDragLeave() {}, onDrop() {}, onMoveTo() {},
  onAction() {}, onChat() {}, ...patch,
})

test('the board shows five columns and keeps cancelled out of them', () => {
  const tree = view()
  const columns = byClass(tree, 'bc-tb-col')
  assert.deepEqual(plain(columns.map(column => column.props['data-status'])), plain(TASK_COLUMNS.map(column => column.status)))
  assert.equal(text(byClass(tree, 'bc-tb-cols')[0]).includes('取消的活'), false)
  assert.equal(text(tree).includes('Show cancelled'), true)
  const shown = view({ showCancelled: true, onToggleCancelled() {} })
  assert.equal(text(shown).includes('取消的活'), true)
})

test('every column carries its own count', () => {
  const tree = view()
  const counts = byClass(tree, 'bc-tb-count').map(text)
  assert.deepEqual(plain(counts), ['1', '1', '1', '1', '1'])
})

test('a card shows title, owner, dependency count, next step and its badges', () => {
  const tree = view()
  const card = byClass(tree, 'bc-tb-card').find(item => text(item).includes('搭任务板'))
  assert.ok(card)
  assert.match(text(card), /键盘/)
  assert.match(text(card), /2 dependencies/)
  assert.match(text(card), /把五列排好/)
  const waiting = byClass(tree, 'bc-tb-card').find(item => text(item).includes('等验收'))
  assert.match(text(waiting), /Waiting for approval/)
})

test('dragging asks the board for a status change instead of moving the card', () => {
  const drags = []
  const drops = []
  const tree = view({ onDragStart: id => drags.push(id), onDrop: (id, status) => drops.push([id, status]) })
  const card = byClass(tree, 'bc-tb-card').find(item => text(item).includes('搭任务板'))
  const transfer = { setData() {}, getData: () => 'task_doing', effectAllowed: '' }
  card.props.onDragStart({ dataTransfer: transfer })
  assert.deepEqual(plain(drags), ['task_doing'])
  const doing = byClass(tree, 'bc-tb-col').find(column => column.props['data-status'] === 'done')
  doing.props.onDrop({ preventDefault() {}, dataTransfer: transfer })
  assert.deepEqual(plain(drops), [['task_doing', 'done']])
  // The rendered card never changes column on its own: the model passed in is unchanged.
  assert.equal(text(byClass(tree, 'bc-tb-card').find(item => text(item).includes('搭任务板'))).includes('搭任务板'), true)
})

test('the card menu asks for the same move, and a Drop target highlights', () => {
  const moves = []
  const tree = view({ onMoveTo: (item, status) => moves.push([item.id, status]) })
  const move = selects(tree)[0]
  move.props.onChange({ target: { value: 'ready' }, stopPropagation() {} })
  assert.deepEqual(plain(moves), [['task_draft', 'ready']])
  const drop = view({ dropTarget: 'review' })
  assert.equal(byClass(drop, 'bc-tb-col').find(column => column.props['data-status'] === 'review').props.className.includes('is-drop'), true)
})

test('the detail panel opens on four tabs and shows the record', () => {
  const tree = view({ selectedId: 'task_doing' })
  const panel = byClass(tree, 'bc-tb-detail')[0]
  assert.ok(panel)
  assert.equal(panel.props.role, 'dialog')
  assert.deepEqual(plain(byClass(tree, 'bc-tb-tab').map(tab => tab.props.role)), ['tab', 'tab', 'tab', 'tab'])
  assert.deepEqual(plain(byClass(tree, 'bc-tb-tab').map(text)), plain(TASK_TABS.map(item => item.label)))
  assert.match(text(tree), /键盘/)
  assert.match(text(tree), /2 dependencies/)
})

test('each tab renders its own empty state', () => {
  const results = text(view({ selectedId: 'task_doing', tab: 'results' }))
  assert.match(results, /No results yet/)
  const history = text(view({ selectedId: 'task_doing', tab: 'history' }))
  assert.match(history, /No runs yet/)
  const discussion = text(view({ selectedId: 'task_doing', tab: 'discussion' }))
  assert.match(discussion, /Open project chat/)
})

test('the actions follow the column of the task', () => {
  const labelsFor = stage => {
    const tree = view({ selectedId: `task_${stage}`, tasks: [task({ id: `task_${stage}`, stage })] })
    return byClass(tree, 'bc-tb-actions')[0] ? text(byClass(tree, 'bc-tb-actions')[0]) : ''
  }
  assert.match(labelsFor('draft'), /Move to Ready/)
  assert.match(labelsFor('ready'), /Start/)
  assert.match(labelsFor('doing'), /Submit for acceptance/)
  assert.match(labelsFor('doing'), /Mark dispatch failed/)
  assert.match(labelsFor('review'), /Accept/)
  assert.match(labelsFor('review'), /Return to Ready/)
  assert.match(labelsFor('done'), /Reopen/)
})

test('actions and drops map to the contract commands', () => {
  assert.deepEqual(plain(taskActionCommand('start', { id: 't1', task_revision: 4 })), ['task.dispatch', { task_id: 't1', expected_revision: 4 }])
  assert.deepEqual(plain(taskActionCommand('to-ready', { id: 't1', task_revision: 2 })), ['task.move', { task_id: 't1', expected_revision: 2, to: 'ready' }])
  assert.deepEqual(plain(taskActionCommand('submit', { id: 't1', task_revision: 3 })), ['task.submit', { task_id: 't1', expected_revision: 3 }])
  assert.deepEqual(plain(taskActionCommand('reopen', { id: 't1', task_revision: 5 })), ['task.reopen', { task_id: 't1', expected_revision: 5 }])
  assert.equal(taskActionCommand('retry', { id: 't1' }), null)
  assert.equal(taskActionCommand('nope', { id: 't1' }), null)
  assert.equal(taskRevision({ task_revision: 7 }), 7)
  assert.deepEqual(plain(taskMoveTargets('draft')), ['ready'])
  assert.deepEqual(plain(taskMoveTargets('review')), [])
})

test('a task without an acceptance record explains why Done refuses it', () => {
  assert.match(taskErrorText({ code: 'task/acceptance-required' }), /Done is only written by an acceptance decision/)
  assert.match(taskErrorText({ code: 'task/dependency-unmet', details: { blocking: [{ title: '先修登录' }] } }), /先修登录/)
  assert.match(taskErrorText({ code: 'task/revision-conflict' }), /Reload and try again/)
  assert.equal(taskErrorText({ code: 'x', message: 'server said no' }), 'server said no')
  assert.equal(taskErrorText(null), 'The change could not be saved.')
})

test('the four stage words come from the stage, and cancelled keeps the word it left', () => {
  assert.equal(taskStatusLabel('draft'), 'Not started')
  assert.equal(taskStatusLabel('ready'), 'Not started')
  assert.equal(taskStatusLabel('doing'), 'In progress')
  assert.equal(taskStatusLabel('review'), 'Waiting for acceptance')
  assert.equal(taskStatusLabel('done'), 'Done')
  assert.equal(taskStatusLabel({ stage: 'cancelled', cancelled_from: 'doing' }), 'In progress')
  assert.equal(taskStatusLabel({ status: 'cancelled', cancelled_from: 'doing' }), 'In progress')
})

test('submit, reopen and acceptance payloads only carry what the contract asks for', () => {
  const item = { id: 't1', task_revision: 9, acceptance: { id: 'acc_1', revision: 2, state: 'pending' } }
  assert.deepEqual(plain(taskSubmitCommand(item, { summary: '做完了', artifacts: ['a.md'], notes: ['过了'] })),
    { task_id: 't1', expected_revision: 9, summary: '做完了', artifact_refs: ['a.md'], check_notes: ['过了'] })
  assert.deepEqual(plain(taskReopenCommand(item, '验收标准变了')), { task_id: 't1', expected_revision: 9, reason: '验收标准变了' })
  assert.deepEqual(plain(taskDecideCommand(item, 'return', '还差一条')), { acceptance_id: 'acc_1', expected_revision: 2, decision: 'return', opinion: '还差一条' })
  assert.equal(taskDecideCommand({ id: 't1' }, 'accept'), null)
  assert.equal(acceptanceReady(item), true)
  assert.equal(acceptanceReady({ id: 't1' }), false)
})

test('a dispatch can be marked failed with its run and a reason', () => {
  assert.deepEqual(plain(taskFailCommand({ id: 't1', task_revision: 6, latest_run_id: 'run_1' }, 'Bot 没有响应')),
    { task_id: 't1', run_id: 'run_1', expected_revision: 6, reason: 'Bot 没有响应' })
  const dispatched = view({ selectedId: 'task_doing', tasks: [task({ id: 'task_doing', stage: 'doing', latest_run_id: 'run_1' })] })
  const fail = button(byClass(dispatched, 'bc-tb-actions')[0], 'Mark dispatch failed')
  assert.equal(fail.props.disabled, false)
  const legacy = view({ selectedId: 'task_doing', tasks: [task({ id: 'task_doing', stage: 'doing' })] })
  assert.equal(button(byClass(legacy, 'bc-tb-actions')[0], 'Mark dispatch failed').props.disabled, true)
  assert.match(text(byClass(legacy, 'bc-tb-hint')[0]), /without a dispatch/)
  const dialog = view({ dialog: { kind: 'fail', task: task({ stage: 'doing', latest_run_id: 'run_1' }) }, onDialogSend() {}, onDialogClose() {} })
  assert.match(text(byClass(dialog, 'bc-tb-modalcard')[0]), /Mark dispatch failed/)
  assert.match(text(byClass(dialog, 'bc-tb-modalcard')[0]), /Why did the dispatch fail/)
  assert.equal(button(byClass(dialog, 'bc-tb-modalcard')[0], 'Save').props.disabled, true)
})

test('the history tab shows dispatched and failed runs with the failure reason', () => {
  const item = task({ id: 'task_doing', stage: 'doing', latest_run_id: 'run_2', last_run_status: 'failed', runs: [
    { id: 'run_2', state: 'failed', failure_reason: 'Bot 没有响应', dispatched_at: Date.now() - 5 * 60 * 1000 },
    { id: 'run_1', state: 'dispatched', dispatched_at: Date.now() - 30 * 60 * 1000 },
  ] })
  const tree = view({ selectedId: 'task_doing', tab: 'history', tasks: [item] })
  const history = text(byClass(tree, 'bc-tb-panel')[0])
  assert.match(history, /Dispatch failed/)
  assert.match(history, /Bot 没有响应/)
  assert.match(history, /Dispatched/)
  assert.match(text(byClass(tree, 'bc-tb-card')[0]), /Last run failed/)
})

test('a review task without an acceptance record cannot be accepted or returned', () => {
  const tree = view({ selectedId: 'task_review' })
  const labels = byClass(tree, 'bc-tb-actions')[0]
  assert.ok(labels)
  const actionButtons = buttons(labels)
  assert.equal(actionButtons.length, 2)
  assert.equal(actionButtons.every(item => item.props.disabled === true), true)
  assert.match(text(byClass(tree, 'bc-tb-hint')[0]), /no acceptance record yet/)
})

test('the submit dialog asks for the summary, artifacts and every check', () => {
  const tree = view({ dialog: { kind: 'submit', task: task({ acceptance_checks: ['测试全绿', '文档更新'] }) }, onDialogSend() {}, onDialogClose() {} })
  const card = byClass(tree, 'bc-tb-modalcard')[0]
  assert.match(text(card), /Summary of the work/)
  assert.match(text(card), /Artifacts/)
  assert.match(text(card), /测试全绿/)
  assert.match(text(card), /文档更新/)
  const save = buttons(card).find(item => text(item).includes('Save'))
  assert.equal(save.props.disabled, true)
})

test('the reopen dialog asks for a reason and the decide dialog names its decision', () => {
  const reopen = view({ dialog: { kind: 'reopen', task: task({ stage: 'done' }) }, onDialogSend() {}, onDialogClose() {} })
  assert.match(text(byClass(reopen, 'bc-tb-modalcard')[0]), /Reopen task/)
  assert.match(text(byClass(reopen, 'bc-tb-modalcard')[0]), /Reason/)
  const decide = view({ dialog: { kind: 'decide', task: task({ stage: 'review', acceptance: { id: 'acc_1', revision: 1 } }), decision: 'return' }, onDialogSend() {}, onDialogClose() {} })
  assert.match(text(byClass(decide, 'bc-tb-modalcard')[0]), /Return task/)
  assert.match(text(byClass(decide, 'bc-tb-modalcard')[0]), /Opinion/)
})

test('task.list returns stage, and the board places it without a status field', () => {
  assert.equal(taskStage({ stage: 'review' }), 'review')
  assert.equal(taskStage({ status: 'doing' }), 'doing')
  assert.equal(taskStage({}), '')
  const tree = view({ tasks: [{ id: 'task_server', title: '服务端形状', stage: 'review', task_revision: 2 }] })
  const review = byClass(tree, 'bc-tb-col').find(column => column.props['data-status'] === 'review')
  assert.match(text(review), /服务端形状/)
  const detail = view({ selectedId: 'task_server', tasks: [{ id: 'task_server', title: '服务端形状', stage: 'review', task_revision: 2 }] })
  assert.match(text(byClass(detail, 'bc-tb-actions')[0]), /Accept/)
})

test('helpers tolerate the contract arriving in older shapes', () => {
  assert.equal(taskOwnerName({ assignee_id: 'emp_2' }, employees), '橙子')
  assert.equal(taskOwnerName({ owner_name: '小蓝' }), '小蓝')
  assert.equal(taskOwnerName({ owner_assignment_id: 'pmm_2' }, employees, [{ id: 'pmm_2', employee_id: 'emp_2' }]), '橙子')
  assert.equal(taskDependencyCount({ dependencies: [1, 2, 3] }), 3)
  assert.equal(taskDependencyCount({}), 0)
  assert.deepEqual(plain(taskBadges({ waiting_on: 'input' })), ['Waiting for input'])
  assert.equal(taskWhen(undefined), '')
})

test('the empty board still shows where a card can go', () => {
  const tree = view({ tasks: [] })
  assert.equal(byClass(tree, 'bc-tb-col').length, 5)
  assert.match(text(tree), /Drop a task here/)
})

test('a load error is shown as an alert above the columns', () => {
  const tree = view({ error: '任务读取失败' })
  const alert = collect(tree, node => node.props?.role === 'alert')[0]
  assert.ok(alert)
  assert.match(text(alert), /任务读取失败/)
})

test('narrow containers switch to a list instead of squeezing the columns', () => {
  assert.match(TASK_BOARD_CSS, /@container bc-tb \(max-width:720px\)/)
  assert.match(TASK_BOARD_CSS, /\.bc-tb-listview\{display:block\}/)
  const tree = view()
  assert.equal(byClass(tree, 'bc-tb-listrow').length, 5)
})

test('a done card shows the submissions that ended it, not an empty results tab', () => {
  const done = task({
    id: 'task_done', stage: 'done',
    submissions: [
      { task_revision: 4, summary: '首屏骨架排完了', artifact_refs: ['/tmp/skeleton.md'], check_notes: ['布局一致'], submitted_by_employee_id: 'emp_1', submitted_at: 1795006274047 },
      { task_revision: 6, summary: '间距改成 24', artifact_refs: ['/tmp/skeleton-v2.md'], check_notes: ['24/24 对齐'], submitted_by_employee_id: 'emp_1', submitted_at: 1795006279147 },
    ],
    artifact_refs: ['/tmp/skeleton.md', '/tmp/skeleton-v2.md'],
  })
  const tree = view({ tasks: [done], selectedId: 'task_done', tab: 'results' })
  const panel = text(tree)
  assert.match(panel, /首屏骨架排完了/)
  assert.match(panel, /间距改成 24/)
  assert.match(panel, /\/tmp\/skeleton-v2.md/)
  assert.match(panel, /键盘/)
  assert.doesNotMatch(panel, /No results yet/)
})

test('a done card shows its acceptance record and checks in the detail tab', () => {
  const done = task({
    id: 'task_done', stage: 'done', acceptance_checks: ['布局与草图一致'],
    acceptances: [{ id: 'acc_1', task_id: 'task_done', state: 'accepted', acceptance_criteria: '布局与草图一致', opinion: '间距核对通过', decided_at: 1795006279160, revision: 2 }],
  })
  const tree = view({ tasks: [done], selectedId: 'task_done', tab: 'detail' })
  const panel = text(tree)
  assert.match(panel, /布局与草图一致/)
  assert.match(panel, /间距核对通过/)
  assert.match(panel, /Accepted/)
})

test('a new task form asks for the scope and checks a Ready card needs', () => {
  const tree = view({ dialogue: null, dialog: { kind: 'create' }, projectId: 'prj_1', workspaceRef: '/work/prj_1' })
  const labels = collect(tree, node => node.type === 'label').map(text)
  assert.ok(labels.some(value => /Title/.test(value)))
  assert.ok(labels.some(value => /Acceptance checks/.test(value)))
  assert.ok(labels.some(value => /Authorization scope/.test(value)))
  const scope = collect(tree, node => node.type === 'input' && node.props.value === '/work/prj_1')
  assert.equal(scope.length, 1)
  const create = button(tree, 'Create task')
  assert.ok(create)
  assert.equal(create.props.disabled, true)
})
