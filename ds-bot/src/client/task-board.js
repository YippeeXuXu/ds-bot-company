import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

// P06: five columns by default, Cancelled never owns a column. The card still speaks
// in four words — the contract keeps one stage per task and the board maps it.
export const TASK_COLUMNS = [
  { status: 'draft', label: 'Draft' },
  { status: 'ready', label: 'Ready' },
  { status: 'doing', label: 'Doing' },
  { status: 'review', label: 'Review' },
  { status: 'done', label: 'Done' },
]

export const TASK_STAGE_WORDS = {
  draft: 'Not started',
  ready: 'Not started',
  doing: 'In progress',
  review: 'Waiting for acceptance',
  done: 'Done',
  cancelled: 'Cancelled',
}

export const TASK_MOVES = {
  draft: ['ready'],
  ready: ['doing'],
  doing: [],
  review: [],
  done: [],
  cancelled: [],
}

export const TASK_TABS = [
  { id: 'detail', label: 'Details' },
  { id: 'results', label: 'Results' },
  { id: 'history', label: 'Run history' },
  { id: 'discussion', label: 'Discussion' },
]

// The contract keeps one `stage` per task (v1.12 §5.3.6). Older fixtures used
// `status`, so read either, but never invent one.
export const taskStage = task => (typeof task === 'string' ? task : task?.stage ?? task?.status ?? '')
export const taskStatusLabel = value => {
  const task = typeof value === 'string' ? null : value
  const stage = taskStage(value) === 'cancelled' ? task?.cancelled_from ?? 'cancelled' : taskStage(value)
  return t(TASK_STAGE_WORDS[stage] ?? 'Unknown status')
}
export const taskMoveTargets = status => TASK_MOVES[status] ?? []
export const taskRevision = task => {
  if (Number.isInteger(task?.task_revision)) return task.task_revision
  return Number.isInteger(task?.revision) ? task.revision : 0
}
export const taskOwnerId = task => task.owner_employee_id ?? task.assignee_id ?? task.owner_id ?? ''
export const taskOwnerName = (task, employees = []) => {
  const owner = employees.find(employee => employee.id === taskOwnerId(task))
  return owner?.name ?? task.owner_name ?? ''
}
export const taskDependencyCount = task => {
  if (Number.isInteger(task.dependency_count)) return task.dependency_count
  return Array.isArray(task.dependencies) ? task.dependencies.length : 0
}
export const taskArtifacts = task => task.submission?.artifact_refs ?? task.result_refs ?? task.artifacts ?? []
export const taskRuns = task => task.runs ?? task.history ?? []
export const taskAcceptance = task => task.acceptance ?? task.acceptance_record ?? null
export const taskChecks = task => (Array.isArray(task?.acceptance_checks) ? task.acceptance_checks : [])
export const acceptanceReady = task => {
  const record = taskAcceptance(task)
  return Boolean(record?.id) && Number.isInteger(record?.revision)
}
export const taskBadges = task => [
  task.waiting_on === 'approval' || task.waiting === 'approval' ? t('Waiting for approval') : null,
  task.waiting_on === 'input' || task.waiting === 'input' ? t('Waiting for input') : null,
  task.last_run_status === 'failed' ? t('Last run failed') : null,
  task.blocker ? t('Blocked') : null,
  task.priority === 'high' ? t('High priority') : null,
].filter(Boolean)

// One request per action, shaped by the v1.12 contract: every write carries the task's
// own revision, and review only leaves through acceptance.decide.
export const taskActionCommand = (action, task) => {
  if (!task?.id) return null
  const base = { task_id: task.id, expected_revision: taskRevision(task) }
  return {
    start: ['task.dispatch', base],
    'to-ready': ['task.move', { ...base, to: 'ready' }],
    submit: ['task.submit', base],
    accept: ['acceptance.decide', base],
    return: ['acceptance.decide', base],
    reopen: ['task.reopen', base],
  }[action] ?? null
}

export const taskSubmitCommand = (task, { summary = '', artifacts = [], notes = [] } = {}) => ({
  task_id: task.id,
  expected_revision: taskRevision(task),
  summary,
  artifact_refs: artifacts,
  check_notes: notes,
})

export const taskFailCommand = (task, reason) => ({
  task_id: task.id,
  run_id: task.latest_run_id,
  expected_revision: taskRevision(task),
  reason,
})

export const taskReopenCommand = (task, reason) => ({
  task_id: task.id,
  expected_revision: taskRevision(task),
  reason,
})

export const taskDecideCommand = (task, decision, opinion = '') => {
  const record = taskAcceptance(task)
  if (!record?.id) return null
  return {
    acceptance_id: record.id,
    expected_revision: Number.isInteger(record.revision) ? record.revision : 0,
    decision,
    opinion,
  }
}

export function taskErrorText(failure) {
  const code = failure?.code
  const known = {
    'task/acceptance-required': t('Done is only written by an acceptance decision. Submit this task for review first.'),
    'task/state-conflict': t('This task cannot move that way. Reload and try again.'),
    'task/revision-conflict': t('Someone else changed this task. Reload and try again.'),
    'task/not-found': t('This task no longer exists.'),
    'task/dependency-unmet': t('A dependency is still open. Finish it before starting this task.'),
    'task/dependency-missing': t('A dependency of this task no longer exists.'),
    'task/missing-input': t('This change needs more input before it can be saved.'),
    'run/deliver-failed': t('The brief did not reach the Bot. The task is still Ready; try again or mark the dispatch failed.'),
    'run/not-found': t('This dispatch no longer exists. Reload the board.'),
    'run/state-conflict': t('This dispatch already ended. Reload the board.'),
    'company/unsupported': t('This employee has no Bot to dispatch to.'),
    'acceptance/not-pending': t('This task is no longer waiting for acceptance.'),
    'acceptance/state-conflict': t('This task already has a pending acceptance record.'),
    'company/revision-conflict': t('The board changed elsewhere. Reload and try again.'),
  }[code]
  if (known) {
    const blocking = failure?.details?.blocking
    if (code === 'task/dependency-unmet' && Array.isArray(blocking) && blocking.length) {
      return `${known} ${blocking.map(item => item.title ?? item.task_id).join(', ')}`
    }
    return known
  }
  return failure?.message ? String(failure.message) : t('The change could not be saved.')
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
export const taskWhen = value => {
  if (!Number.isFinite(value)) return ''
  const ago = Date.now() - value
  if (ago < MINUTE) return t('Just now')
  if (ago < HOUR) return `${Math.max(1, Math.round(ago / MINUTE))} ${t('minutes ago')}`
  if (ago < DAY) return `${Math.max(1, Math.round(ago / HOUR))} ${t('hours ago')}`
  if (ago < 7 * DAY) return `${Math.max(1, Math.floor(ago / DAY))} ${t('days ago')}`
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

function TaskCard({ task, employees, selected, busy, dragging, ...handlers }) {
  const owner = taskOwnerName(task, employees)
  const badges = taskBadges(task)
  const dependencies = taskDependencyCount(task)
  const next = task.next_step ?? ''
  const when = taskWhen(task.latest_artifact_at ?? task.updated_at)
  const stage = taskStage(task)
  const targets = taskMoveTargets(stage)
  const options = [{ status: stage, label: TASK_COLUMNS.find(column => column.status === stage)?.label ?? 'Cancelled' }]
    .concat(targets.map(status => TASK_COLUMNS.find(column => column.status === status)).filter(Boolean))
  return h('article', {
    className: `bc-tb-card${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''}`,
    role: 'button',
    tabIndex: 0,
    'aria-label': task.title,
    'aria-pressed': selected ? 'true' : 'false',
    draggable: true,
    onClick: () => handlers.onSelect(task.id),
    onKeyDown: event => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handlers.onSelect(task.id) }
    },
    onDragStart: event => {
      event.dataTransfer?.setData('text/plain', task.id)
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
      handlers.onDragStart(task.id)
    },
    onDragEnd: () => handlers.onDragEnd(),
  },
    h('strong', { className: 'bc-tb-title' }, task.title),
    badges.length ? h('div', { className: 'bc-tb-badges' }, badges.map(badge => h('span', { key: badge, className: 'bc-tb-badge' }, badge))) : null,
    h('div', { className: 'bc-tb-meta' },
      owner ? h('span', null, owner) : null,
      dependencies ? h('span', null, `${dependencies} ${t(dependencies === 1 ? 'dependency' : 'dependencies')}`) : null),
    next ? h('p', { className: 'bc-tb-next' }, next) : null,
    h('div', { className: 'bc-tb-cardfoot' },
      when ? h('span', { className: 'bc-tb-time' }, when) : h('span', null),
      targets.length ? h('select', {
        className: 'bc-tb-move',
        value: stage,
        'aria-label': t('Change status of {name}', { name: task.title }),
        disabled: busy,
        onClick: event => event.stopPropagation(),
        onChange: event => { event.stopPropagation(); handlers.onMoveTo(task, event.target.value) },
      }, options.map(option => h('option', { key: option.status, value: option.status, disabled: option.status === stage }, t(option.label)))) : null),
  )
}

function TaskColumn({ column, tasks, employees, selectedId, busy, dropTarget, ...handlers }) {
  return h('section', {
    className: `bc-tb-col${dropTarget === column.status ? ' is-drop' : ''}`,
    'data-status': column.status,
    'aria-label': t(column.label),
    onDragOver: event => { event.preventDefault(); handlers.onDragOver(column.status) },
    onDragLeave: () => handlers.onDragLeave(column.status),
    onDrop: event => {
      event.preventDefault()
      const id = event.dataTransfer?.getData('text/plain') || handlers.draggingId
      if (id) handlers.onDrop(id, column.status)
    },
  },
    h('header', { className: 'bc-tb-colhead' },
      h('strong', null, t(column.label)),
      h('span', { className: 'bc-tb-count' }, String(tasks.length))),
    h('div', { className: 'bc-tb-cards' }, tasks.map(task => h(TaskCard, {
      key: task.id, task, employees, selected: selectedId === task.id, busy,
      dragging: handlers.draggingId === task.id, onSelect: handlers.onSelect, onMoveTo: handlers.onMoveTo,
      onDragStart: handlers.onDragStart, onDragEnd: handlers.onDragEnd,
    }))),
    tasks.length ? null : h('p', { className: 'bc-tb-emptycol' }, t('Drop a task here')),
  )
}

function TaskDetail({ task, employees, tab, busy, error, onTab, onClose, onAction, onChat }) {
  const acceptance = taskAcceptance(task)
  const artifacts = taskArtifacts(task)
  const runs = taskRuns(task)
  const owner = taskOwnerName(task, employees)
  const stage = taskStage(task)
  const actions = []
  if (stage === 'draft') actions.push(['to-ready', t('Move to Ready')])
  if (stage === 'ready') actions.push(['start', t('Start')])
  if (stage === 'doing') actions.push(['submit', t('Submit for acceptance')], ['fail', t('Mark dispatch failed')])
  if (stage === 'review') actions.push(['accept', t('Accept')], ['return', t('Return to Ready')])
  if (stage === 'done') actions.push(['reopen', t('Reopen')])
  const blocked = stage === 'review' && !acceptanceReady(task)
  const canFail = stage !== 'doing' || Boolean(task.latest_run_id)
  const rows = [
    [t('Owner'), owner || t('Not assigned')],
    [t('Priority'), task.priority ? String(task.priority) : t('Not set')],
    [t('Dependencies'), taskDependencyCount(task) ? String(taskDependencyCount(task)) : t('None')],
    [t('Next step'), task.next_step || '—'],
    [t('Acceptance'), acceptance ? t('Recorded') : t('Not recorded yet')],
  ]
  return h('div', { className: 'bc-tb-detailwrap' },
    h('div', { className: 'bc-tb-detailmask', onClick: onClose }),
    h('aside', { className: 'bc-tb-detail', role: 'dialog', 'aria-modal': 'true', 'aria-label': task.title },
      h('header', { className: 'bc-tb-detailhead' },
        h('div', null,
          h('span', { className: `bc-tb-status is-${stage}` }, taskStatusLabel(task)),
          h('h3', null, task.title)),
        h('button', { type: 'button', className: 'bc-tb-close', onClick: onClose, 'aria-label': t('Close task') }, '×')),
      h('div', { className: 'bc-tb-tabs', role: 'tablist' }, TASK_TABS.map(item => h('button', {
        key: item.id, type: 'button', role: 'tab', className: `bc-tb-tab${tab === item.id ? ' is-selected' : ''}`,
        'aria-selected': tab === item.id ? 'true' : 'false', onClick: () => onTab(item.id),
      }, t(item.label)))),
      tab === 'detail' ? h('div', { className: 'bc-tb-panel', role: 'tabpanel' },
        task.goal || task.description ? h('p', { className: 'bc-tb-doc' }, task.goal ?? task.description) : h('p', { className: 'bc-muted' }, t('No description yet.')),
        h('dl', { className: 'bc-tb-kv' }, rows.map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value)))),
        blocked ? h('p', { className: 'bc-muted bc-tb-hint' }, t('This task has no acceptance record yet. Submit it for review, then accept it — Done cannot be reached by dragging.')) : null,
        stage === 'doing' && !task.latest_run_id ? h('p', { className: 'bc-muted bc-tb-hint' }, t('This task was moved to Doing without a dispatch, so there is no run to mark failed.')) : null) : null,
      tab === 'results' ? h('div', { className: 'bc-tb-panel', role: 'tabpanel' },
        artifacts.length ? h('ul', { className: 'bc-tb-list' }, artifacts.map((artifact, index) => h('li', { key: artifact.id ?? artifact.path ?? index },
          h('strong', null, artifact.name ?? artifact.title ?? artifact.path ?? String(artifact)),
          artifact.at || artifact.created_at ? h('span', null, taskWhen(artifact.at ?? artifact.created_at)) : null))) : h('p', { className: 'bc-muted' }, t('No results yet.'))) : null,
      tab === 'history' ? h('div', { className: 'bc-tb-panel', role: 'tabpanel' },
        runs.length ? h('ol', { className: 'bc-tb-runs' }, runs.map((run, index) => h('li', { key: run.id ?? index },
          h('div', null,
            h('strong', null, run.state === 'failed' ? t('Dispatch failed') : t('Dispatched')),
            run.failure_reason ? h('p', { className: 'bc-muted bc-tb-runreason' }, run.failure_reason) : null),
          h('span', null, taskWhen(run.dispatched_at ?? run.created_at))))) : h('p', { className: 'bc-muted' }, t('No runs yet.'))) : null,
      tab === 'discussion' ? h('div', { className: 'bc-tb-panel', role: 'tabpanel' },
        h('p', { className: 'bc-muted' }, t('Tasks are discussed in the project chat, so the record stays with the project.')),
        h('button', { type: 'button', className: 'bc-button', onClick: () => onChat?.(task) }, t('Open project chat'))) : null,
      error ? h('p', { className: 'bc-exception', role: 'alert' }, error) : null,
      actions.length ? h('div', { className: 'bc-tb-actions' }, actions.map(([action, label]) => h('button', {
        key: action, type: 'button',
        className: `bc-button${action === 'start' || action === 'accept' ? ' bc-primary' : ''}`,
        disabled: busy || (blocked && (action === 'accept' || action === 'return')) || (action === 'fail' && !canFail),
        onClick: () => onAction(action, task),
      }, label))) : null,
    ))
}

function TaskDialog({ dialog, busy, error, onClose, onSend }) {
  const task = dialog.task
  const checks = taskChecks(task)
  const [summary, setSummary] = useState('')
  const [artifacts, setArtifacts] = useState('')
  const [notes, setNotes] = useState(() => checks.map(() => ''))
  const [reason, setReason] = useState('')
  const [opinion, setOpinion] = useState('')
  const title = dialog.kind === 'submit' ? t('Submit for acceptance')
    : dialog.kind === 'reopen' ? t('Reopen task')
      : dialog.kind === 'fail' ? t('Mark dispatch failed')
        : dialog.decision === 'accept' ? t('Accept task') : t('Return task')
  const artifactList = artifacts.split('\n').map(line => line.trim()).filter(Boolean)
  const notesFilled = notes.length === checks.length && notes.every(note => note.trim())
  const canSubmit = dialog.kind === 'submit'
    ? Boolean(summary.trim()) && artifactList.length > 0 && artifactList.length <= 50 && notesFilled
    : dialog.kind === 'reopen' || dialog.kind === 'fail'
      ? Boolean(reason.trim()) && reason.trim().length <= 500
      : dialog.decision === 'accept' ? true : Boolean(opinion.trim())
  const send = () => {
    if (!canSubmit) return
    if (dialog.kind === 'submit') {
      onSend(taskSubmitCommand(task, { summary: summary.trim(), artifacts: artifactList, notes: notes.map(note => note.trim()) }))
    } else if (dialog.kind === 'reopen') {
      onSend(taskReopenCommand(task, reason.trim()))
    } else if (dialog.kind === 'fail') {
      onSend(taskFailCommand(task, reason.trim()))
    } else {
      onSend(taskDecideCommand(task, dialog.decision, opinion.trim()))
    }
  }
  return h('div', { className: 'bc-tb-modal' },
    h('div', { className: 'bc-tb-modalcard', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', { className: 'bc-co-pop-head' },
        h('strong', null, title),
        h('span', { className: 'bc-co-pop-name' }, task.title),
        h('button', { type: 'button', className: 'bc-co-pop-close', 'aria-label': t('Close'), onClick: onClose }, '×')),
      h('div', { className: 'bc-co-create-fields' },
        dialog.kind === 'submit' ? h('label', { className: 'bc-field' }, h('span', null, t('Summary of the work')),
          h('textarea', { rows: 4, maxLength: 2000, value: summary, onChange: event => setSummary(event.target.value) })) : null,
        dialog.kind === 'submit' ? h('label', { className: 'bc-field' }, h('span', null, t('Artifacts')),
          h('textarea', { rows: 3, value: artifacts, placeholder: t('One link or path per line.'), onChange: event => setArtifacts(event.target.value) })) : null,
        dialog.kind === 'submit' && checks.length ? h('div', { className: 'bc-tb-checks' },
          h('p', { className: 'bc-co-note' }, t('Answer each acceptance check.')),
          checks.map((check, index) => h('label', { key: index, className: 'bc-field' }, h('span', null, check),
            h('input', { value: notes[index] ?? '', maxLength: 1000, onChange: event => setNotes(current => current.map((note, position) => position === index ? event.target.value : note)) })))) : null,
        dialog.kind === 'reopen' || dialog.kind === 'fail' ? h('label', { className: 'bc-field' }, h('span', null, dialog.kind === 'fail' ? t('Why did the dispatch fail?') : t('Reason')),
          h('input', { value: reason, maxLength: 500, onChange: event => setReason(event.target.value) })) : null,
        dialog.kind === 'decide' ? h('label', { className: 'bc-field' }, h('span', null, t('Opinion')),
          h('textarea', { rows: 3, maxLength: 2000, value: opinion, onChange: event => setOpinion(event.target.value) })) : null,
        error ? h('p', { className: 'bc-exception', role: 'alert' }, error) : null,
      ),
      h('div', { className: 'bc-co-create-actions' },
        h('span', { className: 'bc-co-spacer' }),
        h('button', { type: 'button', className: 'bc-button', onClick: onClose }, t('Cancel')),
        h('button', { type: 'button', className: 'bc-button bc-primary', disabled: busy || !canSubmit, onClick: send },
          busy ? t('Saving…') : dialog.kind === 'decide' ? (dialog.decision === 'accept' ? t('Accept') : t('Return to Ready')) : t('Save')))),
  )
}

export function TaskBoardView({
  tasks = [], employees = [], selectedId = '', tab = 'detail', busy = false, error = '', dialog = null, dialogError = '',
  draggingId = '', dropTarget = '', showCancelled = false, onToggleCancelled, onSelect, onClose,
  onTab, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop, onMoveTo, onAction, onChat,
  onDialogClose, onDialogSend,
}) {
  const live = tasks.filter(task => taskStage(task) !== 'cancelled')
  const cancelled = tasks.filter(task => taskStage(task) === 'cancelled')
  const selected = tasks.find(task => task.id === selectedId) ?? null
  const handlers = { employees, selectedId, busy, draggingId, dropTarget, onSelect, onMoveTo, onDragStart, onDragEnd, onDragOver, onDragLeave, onDrop }
  return h('section', { className: 'bc-taskboard' },
    h('div', { className: 'bc-tb-head' },
      h('div', null, h('h2', null, t('Tasks')), h('p', { className: 'bc-sub' }, t('Drag a card to ask for a new status. The board does not move it until the service agrees.'))),
      h('button', { type: 'button', className: 'bc-chip', 'aria-pressed': showCancelled ? 'true' : 'false', onClick: onToggleCancelled }, t('Show cancelled'))),
    error ? h('p', { className: 'bc-exception', role: 'alert' }, error) : null,
    h('div', { className: 'bc-tb-cols' }, TASK_COLUMNS.map(column => h(TaskColumn, {
      key: column.status, column, tasks: live.filter(task => taskStage(task) === column.status), ...handlers,
    }))),
    h('div', { className: 'bc-tb-listview' }, TASK_COLUMNS.map(column => {
      const group = live.filter(task => taskStage(task) === column.status)
      return group.length ? h('div', { key: column.status, className: 'bc-tb-listgroup' },
        h('h3', null, `${t(column.label)} · ${group.length}`),
        group.map(task => h('button', { key: task.id, type: 'button', className: 'bc-tb-listrow', onClick: () => onSelect(task.id) },
          h('strong', null, task.title),
          h('span', null, `${taskOwnerName(task, employees) || t('Unassigned')} · ${taskStatusLabel(task)}`)))) : null
    })),
    showCancelled && cancelled.length ? h('div', { className: 'bc-tb-cancelled' },
      h('h3', null, t('Cancelled')),
      cancelled.map(task => h('button', { key: task.id, type: 'button', className: 'bc-tb-listrow', onClick: () => onSelect(task.id) },
        h('strong', null, task.title), h('span', null, taskWhen(task.updated_at))))) : null,
    selected ? h(TaskDetail, { task: selected, employees, tab, busy, error, onTab, onClose, onAction, onChat }) : null,
    dialog ? h(TaskDialog, { dialog, busy, error: dialogError, onClose: onDialogClose, onSend: onDialogSend }) : null,
  )
}

export function TaskBoard({ tasks = [], employees = [], preview = false, loading = false, error: loadError = '', onCommand, onChat }) {
  const [selectedId, setSelectedId] = useState('')
  const [tab, setTab] = useState('detail')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState(null)
  const [dialogError, setDialogError] = useState('')
  const [draggingId, setDraggingId] = useState('')
  const [dropTarget, setDropTarget] = useState('')
  const [showCancelled, setShowCancelled] = useState(false)
  const selected = tasks.find(task => task.id === selectedId)
  useEffect(() => {
    if (!selected && !dialog) return undefined
    const onKey = event => {
      if (event.key !== 'Escape') return
      if (dialog) { setDialog(null); setDialogError('') } else setSelectedId('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, dialog])
  const send = async (command, fields, target = 'page') => {
    if (busy || preview || !onCommand) return false
    setBusy(true)
    if (target === 'page') setError(''); else setDialogError('')
    try { await onCommand(command, fields); return true }
    catch (failure) {
      const text = taskErrorText(failure)
      if (target === 'page') setError(text); else setDialogError(text)
      return false
    }
    finally { setBusy(false) }
  }
  const move = async (task, status) => {
    if (!task || status === taskStage(task)) return
    await send('task.move', { task_id: task.id, expected_revision: taskRevision(task), to: status })
  }
  const act = (action, task) => {
    if (!task) return
    if (action === 'submit' || action === 'reopen') {
      setDialogError('')
      setDialog({ kind: action, task })
      return
    }
    if (action === 'fail') {
      if (!task.latest_run_id) { setError(t('This task has no dispatch to mark failed.')); return }
      setDialogError('')
      setDialog({ kind: 'fail', task })
      return
    }
    if (action === 'accept' || action === 'return') {
      if (!acceptanceReady(task)) { setError(t('This task has no acceptance record yet. Submit it for review, then accept it — Done cannot be reached by dragging.')); return }
      setDialogError('')
      setDialog({ kind: 'decide', task, decision: action === 'accept' ? 'accept' : 'return' })
      return
    }
    const request = taskActionCommand(action, task)
    if (request) void send(request[0], request[1])
  }
  const dialogSend = async fields => {
    const command = dialog.kind === 'submit' ? 'task.submit' : dialog.kind === 'reopen' ? 'task.reopen' : dialog.kind === 'fail' ? 'run.fail' : 'acceptance.decide'
    const ok = await send(command, fields, 'dialog')
    if (ok) { setDialog(null); setDialogError('') }
  }
  return h(TaskBoardView, {
    tasks, employees, selectedId, tab, busy, error: error || loadError, dialog, dialogError,
    draggingId, dropTarget, showCancelled,
    onToggleCancelled: () => setShowCancelled(value => !value),
    onSelect: id => { setSelectedId(id); setTab('detail'); setError('') },
    onClose: () => { setSelectedId(''); setError('') },
    onTab: setTab,
    onDragStart: id => setDraggingId(id),
    onDragEnd: () => { setDraggingId(''); setDropTarget('') },
    onDragOver: status => setDropTarget(status),
    onDragLeave: status => setDropTarget(current => current === status ? '' : current),
    onDrop: (id, status) => { const task = tasks.find(item => item.id === id); setDraggingId(''); setDropTarget(''); void move(task, status) },
    onMoveTo: (task, status) => void move(task, status),
    onAction: act,
    onChat,
    onDialogClose: () => { setDialog(null); setDialogError('') },
    onDialogSend: fields => void dialogSend(fields),
  })
}

export const TASK_BOARD_CSS = `
.bc-taskboard{container:bc-tb/inline-size;margin:16px 0 0;padding:20px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bc-tb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin:0 0 14px}
.bc-tb-head h2{font-size:14px;margin:0 0 4px}
.bc-tb-head .bc-sub{margin:0}
.bc-tb-cols{display:flex;gap:10px;overflow-x:auto;padding-bottom:4px;align-items:flex-start}
.bc-tb-col{flex:1 0 196px;min-height:120px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-main);padding:8px;transition:border-color .12s,background .12s}
.bc-tb-col.is-drop{border-color:var(--bt-accent);background:var(--bt-tag-bg)}
.bc-tb-colhead{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 8px;font-size:12px;color:var(--bt-ink-2)}
.bc-tb-colhead strong{font-size:12px;color:var(--bt-ink);font-weight:600}
.bc-tb-count{min-width:18px;text-align:center;border-radius:999px;background:var(--bt-tag-bg);padding:1px 6px;font-size:11px;font-variant-numeric:tabular-nums}
.bc-tb-cards{display:flex;flex-direction:column;gap:8px}
.bc-tb-card{position:relative;display:block;width:100%;text-align:left;padding:10px 11px;border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);box-shadow:var(--bc-shadow-raised,0 1px 2px rgba(0,0,0,.04));cursor:grab;color:var(--bt-ink)}
.bc-tb-card:hover{border-color:var(--bt-ink-2)}
.bc-tb-card:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bc-tb-card.is-selected{border-color:var(--bt-accent)}
.bc-tb-card.is-dragging{opacity:.45}
.bc-tb-title{display:block;font-size:13px;line-height:18px;font-weight:600;overflow-wrap:anywhere}
.bc-tb-badges{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 0}
.bc-tb-badge{border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:10px;line-height:16px;padding:0 6px;white-space:nowrap}
.bc-tb-badge:first-child{color:var(--bt-star)}
.bc-tb-meta{display:flex;flex-wrap:wrap;gap:4px 10px;margin:6px 0 0;font-size:11px;line-height:15px;color:var(--bt-ink-2)}
.bc-tb-next{margin:6px 0 0;font-size:11px;line-height:15px;color:var(--bt-ink-2);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bc-tb-cardfoot{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:8px 0 0}
.bc-tb-time{font-size:10px;color:var(--bt-ink-3)}
.bc-tb-move{max-width:96px;border:1px solid var(--bt-line);border-radius:6px;background:var(--bt-card);color:var(--bt-ink-2);font-size:10px;padding:2px 4px;cursor:pointer}
.bc-tb-emptycol{margin:8px 4px;border:1px dashed var(--bt-line);border-radius:8px;padding:14px 6px;text-align:center;font-size:11px;color:var(--bt-ink-3)}
.bc-tb-listview{display:none}
.bc-tb-listgroup h3,.bc-tb-cancelled h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--bt-ink-3);margin:14px 0 6px}
.bc-tb-listrow{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:10px 12px;border:1px solid var(--bt-line);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);margin-bottom:6px;cursor:pointer;font:inherit}
.bc-tb-listrow strong{font-size:13px}
.bc-tb-listrow span{font-size:11px;color:var(--bt-ink-2)}
.bc-tb-cancelled{margin-top:8px;border-top:1px solid var(--bt-line);padding-top:6px}
.bc-tb-detailwrap{position:fixed;inset:0;z-index:1300;display:flex;justify-content:flex-end}
.bc-tb-detailmask{position:absolute;inset:0;background:color-mix(in srgb,var(--bt-ink) 22%,transparent)}
.bc-tb-detail{position:relative;width:min(420px,100%);height:100%;overflow:auto;background:var(--bt-card);border-left:1px solid var(--bt-line-2);padding:18px 20px 28px;box-shadow:-16px 0 32px -18px color-mix(in srgb,var(--bt-ink) 28%,transparent);animation:bc-tb-in .14s ease-out}
@keyframes bc-tb-in{from{transform:translateX(16px);opacity:.4}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.bc-tb-detail{animation:none}}
.bc-tb-detailhead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.bc-tb-detailhead h3{font-size:16px;line-height:22px;margin:6px 0 0;overflow-wrap:anywhere}
.bc-tb-close{border:0;background:transparent;color:var(--bt-ink-2);font-size:20px;line-height:1;padding:2px 6px;border-radius:6px;cursor:pointer}
.bc-tb-close:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bc-tb-status{display:inline-flex;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;font-weight:700;padding:3px 7px}
.bc-tb-status.is-done{color:var(--bt-green)}
.bc-tb-status.is-review{color:var(--bt-star)}
.bc-tb-tabs{display:flex;gap:2px;margin:16px 0 12px;border-bottom:1px solid var(--bt-line)}
.bc-tb-tab{border:0;background:none;color:var(--bt-ink-2);font:600 12px var(--bt-font);padding:8px 10px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.bc-tb-tab.is-selected{color:var(--bt-ink);border-bottom-color:var(--bt-accent)}
.bc-tb-doc{margin:0 0 14px;font-size:13px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}
.bc-tb-kv{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0}
.bc-tb-kv dt{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--bt-ink-3)}
.bc-tb-kv dd{margin:2px 0 0;font-size:13px;line-height:18px;overflow-wrap:anywhere}
.bc-tb-hint{margin:12px 0 0;font-size:11px;line-height:16px}
.bc-tb-list,.bc-tb-runs{list-style:none;margin:0;padding:0}
.bc-tb-list li,.bc-tb-runs li{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--bt-line);font-size:13px}
.bc-tb-list li:first-child,.bc-tb-runs li:first-child{border-top:0}
.bc-tb-list span,.bc-tb-runs span{font-size:11px;color:var(--bt-ink-3);white-space:nowrap}
.bc-tb-runs li>div{min-width:0}
.bc-tb-runreason{margin:3px 0 0;font-size:11px;line-height:16px;color:var(--bt-danger,var(--bt-ink-2));overflow-wrap:anywhere}
.bc-tb-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:18px;border-top:1px solid var(--bt-line);padding-top:14px}
.bc-tb-modal{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--bt-ink) 26%,transparent)}
.bc-tb-modalcard{width:min(460px,100%);max-height:calc(100vh - 48px);overflow:auto;padding:16px;border:1px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);box-shadow:0 18px 48px -16px color-mix(in srgb,var(--bt-ink) 34%,transparent)}
.bc-tb-checks{display:flex;flex-direction:column;gap:10px;padding:10px;border:1px dashed var(--bt-line-2);border-radius:8px}
@container bc-tb (max-width:720px){.bc-tb-cols{display:none}.bc-tb-listview{display:block}}
@media (max-width:720px){.bc-tb-detail{width:100%;border-left:0}.bc-taskboard{padding:14px}}
`
