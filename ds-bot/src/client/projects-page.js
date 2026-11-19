import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { CompanyPage, COMPANY_PAGE_CSS, botOpenable } from './company-page.js'
import { t } from './i18n.js'
import { ProjectPage } from './project-page.js'
import { ProjectWizard } from './project-wizard.js'
import { TASK_BOARD_CSS } from './task-board.js'
import { TemplatesPage, TEMPLATES_CSS } from './templates-page.js'
import { TodoPage } from './todo-page.js'
import { SearchIcon } from './icons.js'

const sample = () => ({
  company: { id: 'demo-company', name: 'DS Company Company', status: 'active' },
  departments: [
    { id: 'demo-product', name: 'Product', chat_ref: 'demo-product-room', status: 'active' },
    { id: 'demo-engineering', name: 'Engineering', chat_ref: 'demo-engineering-room', status: 'active' },
  ],
  employees: [
    { id: 'demo-coordinator', name: 'Blueberry', department_id: 'demo-engineering', status: 'active', role: 'Coordinator', acceptance_role: 'coordinator', project_id: 'demo-project' },
    { id: 'demo-designer', name: 'Designer', department_id: 'demo-product', status: 'active', role: 'Product', acceptance_role: 'memory_keeper', project_id: 'demo-project' },
    { id: 'demo-writer', name: 'Writer', department_id: 'demo-engineering', status: 'active', role: 'Executor', acceptance_role: 'executor', bot_id: 'third-bot' },
  ],
  projects: [{ id: 'demo-project', name: 'DS Company Company M1', goal: 'Make the project workspace usable for the team.', deliverable: 'Project pages and a bound group chat', acceptance: 'The project can be created, viewed and opened.', status: 'setup', source_department_ids: ['demo-product', 'demo-engineering'], coordinator_assignment_id: 'demo-member', group_chat_ref: 'demo-project-room', group_binding: { status: 'pending', room_id: 'demo-project-room', error: 'Sample: group members need reconciliation.' }, updated_at: Date.now(), revision: 1 }],
  members: [{ id: 'demo-member', project_id: 'demo-project', employee_id: 'demo-coordinator', role: 'coordinator', membership_status: 'active' }, { id: 'demo-member-2', project_id: 'demo-project', employee_id: 'demo-designer', role: 'executor', membership_status: 'active' }],
  group: { group_chat_ref: 'demo-project-room', group_binding: { status: 'pending', room_id: 'demo-project-room' }, members: [], drifted: true },
  revision: 1,
})

const freshKey = () => globalThis.crypto?.randomUUID?.() ?? `company-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`
const empty = () => ({ company: null, departments: [], employees: [], projects: [], templates: [], members: [], group: null, tasks: [], revision: null })
const message = failure => failure?.message ?? String(failure)
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const formatActivity = updatedAt => {
  if (!Number.isFinite(updatedAt)) return ''
  const ago = Date.now() - updatedAt
  if (ago < MINUTE) return t('Just now')
  if (ago < HOUR) return `${Math.max(1, Math.round(ago / MINUTE))} ${t('minutes ago')}`
  if (ago < DAY) return `${Math.max(1, Math.round(ago / HOUR))} ${t('hours ago')}`
  if (ago < 7 * DAY) return `${Math.max(1, Math.floor(ago / DAY))} ${t('days ago')}`
  const date = new Date(updatedAt)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

export function CompanySurface({ page, actions, roster }) {
  const [data, setData] = useState(empty)
  const [preview, setPreview] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [filter, setFilter] = useState('active')
  const [query, setQuery] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [detailAttempt, setDetailAttempt] = useState(0)
  const [tasks, setTasks] = useState([])
  const [tasksError, setTasksError] = useState('')
  const [todosData, setTodosData] = useState(null)
  const [todoLoading, setTodoLoading] = useState(false)
  const [todoError, setTodoError] = useState('')
  const [todoAttempt, setTodoAttempt] = useState(0)
  const writeKeys = useRef(new Map())
  const box = useRef(null)
  const opener = useRef(null)
  const revision = useRef(null)
  const selected = page?.id
  const kind = page?.kind ?? 'list'
  // The surface stays mounted while the page changes, so the once-bound key
  // handler reads the current kind from a ref. A top-level page keeps Esc inert:
  // the owner leaves it through the sidebar, not by pressing Escape.
  const kindRef = useRef(kind)
  kindRef.current = kind
  // A page inside the panel may claim Escape for one level before the panel closes;
  // the company page uses it to step back from a department to the chart.
  const escapeGuard = useRef(null)
  const close = () => actions.closeCompanyPage()

  useEffect(() => {
    opener.current = document.activeElement
    box.current?.focus()
    const onKey = event => {
      if (event.key !== 'Escape' || event.target instanceof HTMLSelectElement) return
      event.preventDefault()
      event.stopPropagation()
      if (kindRef.current === 'todos') return
      if ((kindRef.current === 'company' || kindRef.current === 'templates') && escapeGuard.current?.()) return
      close()
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); opener.current?.focus?.() }
  }, [])

  // The sidebar's project chips are the same filter as this page; whichever the
  // user reaches first, the other follows.
  useEffect(() => {
    const onFilter = event => {
      const value = event.detail
      if (value === 'active' || value === 'setup' || value === 'archived' || value === 'all') setFilter(value)
    }
    window.addEventListener('bt-company-filter', onFilter)
    return () => window.removeEventListener('bt-company-filter', onFilter)
  }, [])

  const load = async (signal, quiet = false) => {
    if (!quiet) { setLoading(true); setError('') }
    try {
      // One read for the whole company: the host's company-model route answers the same
      // shape these pages render, so the list does not need one call per area.
      const model = await call('company-model', {}, signal)
      if (signal?.aborted) return
      const next = { company: model.company ?? null, departments: model.departments ?? [], employees: model.employees ?? [], projects: model.projects ?? [], templates: model.templates ?? [], members: [], group: null, tasks: model.tasks ?? [], revision: model.revision }
      revision.current = model.revision
      setData(next)
    } catch (failure) { if (!signal?.aborted) { if (quiet) setNotice(message(failure)); else setError(message(failure)) } }
    finally { if (!signal?.aborted && !quiet) setLoading(false) }
  }
  // The company read does not carry decision rows: they have their own route and
  // refresh rhythm, and the task/approval stores are scanned only when asked.
  const loadTodos = async (signal, quiet = false) => {
    if (!quiet) { setTodoLoading(true); setTodoError('') }
    try {
      const result = await call('company-todos', {}, signal)
      if (signal?.aborted) return
      setTodosData({
        todos: [...(result.waiting ?? []), ...(result.handled ?? [])],
        pending: result.waiting ?? [],
        counts: result.counts ?? {},
        read_at: result.read_at ?? null,
      })
    } catch (failure) { if (!signal?.aborted) setTodoError(message(failure)) }
    finally { if (!signal?.aborted && !quiet) setTodoLoading(false) }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [])
  useEffect(() => {
    if (kind !== 'todos' && kind !== 'company' && kind !== 'list') return
    const controller = new AbortController()
    void loadTodos(controller.signal)
    return () => controller.abort()
  }, [kind, todoAttempt])

  useEffect(() => {
    if (!selected || preview) return
    const controller = new AbortController()
    setDetailLoading(true)
    setDetailError('')
    setTasks([])
    setTasksError('')
    // Tasks live behind their own read command: the project answer does not carry the
    // board, and the board must tell an empty project from a failed read. A Review card
    // needs its pending acceptance to offer Accept/Return, a Done card needs the accepted
    // or returned record it ended on, and a Doing card needs its runs; the extra reads
    // attach both histories by task id, and either failing leaves only that part locked.
    void Promise.all([
      call('company-command', { command: 'task.list', payload: { project_id: selected, operation_key: `task-list-${freshKey()}` } }),
      call('company-command', { command: 'acceptance.list', payload: { project_id: selected, limit: 200, operation_key: `acceptance-list-${freshKey()}` } })
        .catch(() => null),
      call('company-command', { command: 'run.list', payload: { project_id: selected, limit: 200, operation_key: `run-list-${freshKey()}` } })
        .catch(() => null),
    ])
      .then(([result, acceptanceResult, runResult]) => {
        if (controller.signal.aborted) return
        const acceptancesByTask = new Map()
        for (const row of acceptanceResult?.body?.acceptances ?? []) {
          if (!row?.task_id) continue
          const list = acceptancesByTask.get(row.task_id) ?? []
          list.push(row)
          acceptancesByTask.set(row.task_id, list)
        }
        const runsByTask = new Map()
        for (const run of runResult?.body?.runs ?? []) {
          if (!run?.task_id) continue
          const list = runsByTask.get(run.task_id) ?? []
          list.push(run)
          runsByTask.set(run.task_id, list)
        }
        setTasks((result?.body?.tasks ?? []).map(task => {
          const runs = runsByTask.get(task.id) ?? []
          const latest = runs[0]
          const acceptances = (acceptancesByTask.get(task.id) ?? [])
            .slice()
            .sort((left, right) => (right.decided_at ?? right.updated_at ?? 0) - (left.decided_at ?? left.updated_at ?? 0))
          const pending = acceptances.find(record => record.state === 'pending')
          return {
            ...task,
            ...(acceptances.length ? { acceptances, acceptance: pending ?? acceptances[0] } : {}),
            ...(runs.length ? { runs, ...(latest?.state === 'failed' ? { last_run_status: 'failed' } : {}) } : {}),
          }
        }))
      })
      .catch(failure => { if (!controller.signal.aborted) setTasksError(message(failure)) })
    void call('company-model', { project_id: selected }, controller.signal)
      .then(model => {
        if (controller.signal.aborted) return
        const detail = model.project
        if (!detail) { setDetailError(t('The project is no longer available.')); return }
        if (Number.isInteger(model.revision)) revision.current = model.revision
        // The detail answer carries the project's members and group next to its own
        // fields; the list holds projects alone, so keep that object separate.
        const { members = [], group = null, ...project } = detail
        setData(current => ({ ...current,
          projects: current.projects.some(item => item.id === selected) ? current.projects.map(item => item.id === selected ? project : item) : [...current.projects, project],
          members, group }))
      })
      .catch(failure => { if (!controller.signal.aborted) setDetailError(message(failure)) })
      .finally(() => { if (!controller.signal.aborted) setDetailLoading(false) })
    return () => controller.abort()
  }, [selected, preview, detailAttempt])

  // Task commands take the task's own revision (already in the payload); the company
  // revision a member command sends would be the wrong number here.
  // Archive is irreversible, so its check is a fresh pair of reads rather than the
  // board cache. Acceptance rows can exist without a task, and either read failing must
  // leave the confirmation unavailable instead of showing a confident 0/0.
  const loadArchiveData = async projectId => {
    const [taskResult, acceptanceResult] = await Promise.all([
      call('company-command', { command: 'task.list', payload: { project_id: projectId, operation_key: `archive-task-list-${freshKey()}` } }),
      call('company-command', { command: 'acceptance.list', payload: { project_id: projectId, limit: 200, operation_key: `archive-acceptance-list-${freshKey()}` } }),
    ])
    return { tasks: taskResult?.body?.tasks ?? [], acceptances: acceptanceResult?.body?.acceptances ?? [] }
  }
  const sendTask = async (command, fields = {}) => {
    if (preview) throw Object.assign(new Error(t('Preview')), { code: 'preview' })
    const result = await call('company-command', { command, payload: { ...fields, operation_key: freshKey() } })
    if (Number.isInteger(result?.revision)) revision.current = result.revision
    setDetailAttempt(value => value + 1)
    return result
  }
  const previewData = () => { revision.current = 1; setPreview(true); setData(sample()); setError(''); setLoading(false); setNotice('') }
  const mutate = async (command, fields) => {
    if (preview) {
      if (command === 'department.update' || command === 'department.group.bind') {
        const chatRef = fields.chat_ref ?? fields.room_id
        const department = { ...data.departments.find(item => item.id === fields.department_id), chat_ref: chatRef, room_id: chatRef }
        setData(current => ({ ...current, departments: current.departments.map(item => item.id === department.id ? department : item) }))
        setNotice('')
        return { body: { department } }
      }
      // A sample department group is bound but never created: the preview keeps no rooms.
      if (command === 'department.group.create') {
        const roomId = `demo-room-${freshKey()}`
        const department = { ...data.departments.find(item => item.id === fields.department_id), chat_ref: roomId, room_id: roomId }
        setData(current => ({ ...current, departments: current.departments.map(item => item.id === department.id ? department : item) }))
        setNotice('')
        return { body: { department } }
      }
      const id = `demo-${freshKey()}`
      const field = command === 'company.init' ? 'company' : command === 'department.create' ? 'department' : command === 'employee.create' ? 'employee' : 'project'
      const member = fields.coordinator_employee_id ? { id: `${id}-member`, project_id: id, employee_id: fields.coordinator_employee_id, role: 'coordinator', membership_status: 'active' } : null
      const created = { ...fields, id, status: command === 'project.create' ? 'setup' : 'active', updated_at: Date.now(), ...(field === 'project' ? { coordinator_assignment_id: member?.id ?? null, memory_assignment_id: fields.memory_employee_id ?? null, group_chat_ref: null, group_binding: { status: 'unbound' } } : {}) }
      setData(current => ({ ...current, ...(field === 'company' ? { company: created } : { [`${field}s`]: [...current[`${field}s`], created] }), ...(field === 'project' && member ? { members: [...current.members, member] } : {}) }))
      setNotice('')
      return { body: { [field]: created }, warning: null }
    }
    const fingerprint = `${command}:${JSON.stringify(fields)}`
    let attempt = writeKeys.current.get(fingerprint)
    if (!attempt) { attempt = { key: freshKey(), revision: revision.current }; writeKeys.current.set(fingerprint, attempt) }
    // Keep the key after an uncertain network response: a retry must replay the same
    // operation instead of creating a second project or group.
    let result
    try { result = await call('company-command', { command, payload: { ...fields, operation_key: attempt.key, expected_revision: attempt.revision } }) }
    catch (failure) {
      // A 409 is a definite rejection (revision or key conflict). Refresh before a
      // new attempt; network errors keep the original key for safe server replay.
      if (failure?.code === 'HTTP_409' || failure?.code === 'company/revision-conflict' || failure?.code === 'company/idempotency-conflict') {
        writeKeys.current.delete(fingerprint)
        await load(undefined, true)
        setDetailAttempt(value => value + 1)
      }
      throw failure
    }
    writeKeys.current.delete(fingerprint)
    revision.current = result.revision
    const departmentCommands = ['department.create', 'department.update', 'department.group.create', 'department.group.bind']
    const field = command === 'company.init' ? 'company' : departmentCommands.includes(command) ? 'department' : command === 'employee.create' ? 'employee' : command === 'project.create' ? 'project' : null
    const created = field && result.body?.[field]
    if (created) setData(current => field === 'company' ? { ...current, company: created } : { ...current, [`${field}s`]: [...current[`${field}s`].filter(item => item.id !== created.id), created] })
    await load(undefined, true)
    window.dispatchEvent(new CustomEvent('bt-company-changed'))
    if (result.warning) setNotice(t('Saved, but the project group needs reconciliation.'))
    return result
  }
  const openChat = project => {
    if (preview) { setNotice(t('Sample chat is unavailable. Nothing has been saved.')); return }
    if (project.group_binding?.status !== 'bound' || !project.group_chat_ref || !roster.roomsById?.[project.group_chat_ref]) {
      setNotice(t('The project group is not ready. Check its binding before opening chat.'))
      return
    }
    actions.openSession(project.group_chat_ref, 'projects')
    close()
  }
  const project = data.projects.find(item => item.id === selected)
  const coordinatorOf = item => data.employees.find(employee => employee.project_id === item.id && employee.acceptance_role === 'coordinator') ?? data.employees.find(employee => employee.id === data.members.find(member => member.id === item.coordinator_assignment_id)?.employee_id)
  const departmentOf = item => (item.source_department_ids ?? []).map(id => data.departments.find(department => department.id === id)?.name).filter(Boolean)[0] ?? ''
  // A project row opens the project detail in both cases: its chat is one action inside
  // the detail, not the only way in. A bound group used to send the row straight to chat,
  // which left no path to the task board from the project list.
  const openProject = item => actions.openCompanyPage('detail', item.id)
  // A decision row answered elsewhere turns read-only instead of staying clickable.
  const markStale = item => setTodosData(current => (current
    ? { ...current, todos: current.todos.map(row => (row.id === item.id ? { ...row, stale: true, ready: false, reason: null, reason_code: null } : row)) }
    : current))
  // The answer came back from the host, so the row moves now; the next read is
  // still the authority on its final state and position.
  const applyDecided = (item, action, opinion) => setTodosData(current => {
    if (!current) return current
    const approval = item.card_kind === 'approval'
    const decided = {
      ...item,
      state: action === 'approve' ? (approval ? 'approved-human' : 'accepted') : (approval ? 'rejected' : 'returned'),
      handled: true,
      ready: false,
      suspended: false,
      stale: false,
      reason: null,
      reason_code: null,
      opinion: opinion || item.opinion || null,
      handled_at: new Date().toISOString(),
    }
    const counts = { ...current.counts }
    const waitingKey = approval ? 'waiting_approvals' : 'waiting_acceptances'
    if (Number.isInteger(counts.waiting_total)) counts.waiting_total = Math.max(0, counts.waiting_total - 1)
    if (Number.isInteger(counts[waitingKey])) counts[waitingKey] = Math.max(0, counts[waitingKey] - 1)
    if (Number.isInteger(counts.handled_total)) counts.handled_total += 1
    if (Number.isInteger(counts.handled_returned)) counts.handled_returned += 1
    return { ...current, counts, todos: [decided, ...current.todos.filter(row => row.id !== item.id)] }
  })
  const answerTodo = async (item, action, options = {}) => {
    const opinion = String(options.opinion ?? '').trim()
    try {
      if (item.card_kind === 'approval') {
        // Approvals are answered through the host's own card: a local "agree"
        // without that round trip would never reach the employee's tool call.
        await call('company-todo-answer', {
          todo_id: item.id,
          answer_ref: item.answer_ref ?? null,
          decision: action === 'approve' ? 'allow' : 'reject',
          opinion,
          operation_key: freshKey(),
        })
      } else {
        // Acceptances are a company command and carry the row's revision so a
        // request changed underneath the owner is refused, not silently applied.
        await call('company-command', {
          command: 'acceptance.decide',
          payload: {
            operation_key: freshKey(),
            expected_revision: item.revision ?? null,
            acceptance_id: item.acceptance_id ?? null,
            decision: action === 'approve' ? 'accept' : 'return',
            opinion,
          },
        })
      }
    } catch (failure) {
      const code = failure?.code
      if (code === 'todo/changed' || code === 'todo/unknown' || code === 'todo/stale') {
        markStale(item)
        return { stale: true }
      }
      if (code === 'company/revision-conflict' || code === 'acceptance/state-conflict') {
        await loadTodos(undefined, true)
        throw Object.assign(new Error(t('The request changed. Refreshed.')), { code })
      }
      throw failure
    }
    applyDecided(item, action, opinion)
    return { stale: false }
  }
  // Look into it opens the coordinator's private chat; a project without one
  // falls back to the employee who asked. A row with no project home came from
  // a private chat, so its source session is the place to return to.
  const investigateTodo = item => {
    const botId = (!item.project_id && item.session_id) || item.coordinator_bot_id || item.requester_bot_id
    if (!botId) return
    actions.openSession(botId)
    close()
  }
  const openTodoProject = item => {
    const target = data.projects.find(project => project.id === item.project_id)
    if (target) openProject(target)
    else actions.openCompanyPage('detail', item.project_id)
  }
  const wanted = query.trim().toLowerCase()
  const visible = data.projects
    .filter(item => filter === 'all' || (item.status ?? 'setup') === filter)
    .filter(item => !wanted || [item.name, item.goal].filter(Boolean).some(value => String(value).toLowerCase().includes(wanted)))
  const onTodos = kind === 'todos'
  const onCompany = kind === 'company'
  const onTemplates = kind === 'templates'
  // The four workspace pages live beside the sidebar; the todo list keeps the
  // dialog-style header because it can be opened from a project as a review step.
  const onWorkspace = kind !== 'todos'
  const surfaceLabel = onTodos ? t('Todos') : onTemplates ? t('Employee templates') : onCompany ? t('Company') : t('Projects')
  const closeLabel = onTodos ? t('Close todos') : onTemplates ? t('Close employee templates') : onCompany ? t('Close company page') : t('Close projects')
  const brandTarget = onTodos ? 'todos' : onTemplates ? 'company' : onCompany ? 'company' : 'list'
  // A Bot id is only openable while the roster still resolves it; a stale id would
  // otherwise switch the panel to a chat that cannot render. A roster that has not
  // been assembled yet is not a verdict on the Bot, so it opens the chat.
  const openEmployeeChat = employee => {
    const id = employee?.bot_id
    if (!botOpenable(employee, roster)) return
    // The panel and the chat are different views of the same right-hand space: close
    // first, then hand the id to the session opener, exactly as group settings does.
    close()
    actions.openSession(id)
  }
  return h('div', { className: 'bc-surface' + (onCompany ? ' bc-surface-company' : '') + (onWorkspace ? ' bc-surface-workspace' : ''), role: onWorkspace ? 'region' : 'dialog', 'aria-modal': onWorkspace ? undefined : true, 'aria-label': surfaceLabel, tabIndex: -1, ref: box },
    h('div', { className: 'bc-shell' },
      onWorkspace ? null : h('header', { className: 'bc-header' },
        h('button', { type: 'button', className: 'bc-brand', onClick: () => actions.openCompanyPage(brandTarget) }, surfaceLabel),
        h('span', { className: 'bc-header-context' }, data.company?.name ?? t('Company workspace')),
        h('button', { type: 'button', className: 'bc-icon', 'aria-label': closeLabel, onClick: close }, '×')),
      preview ? h('div', { className: 'bc-preview', role: 'status' }, t('Preview · Local sample data. Nothing has been saved.')) : null,
      notice ? h('div', { className: 'bc-notice', role: 'status' }, notice, h('button', { type: 'button', 'aria-label': t('Dismiss notice'), onClick: () => setNotice('') }, '×')) : null,
      h('main', { className: 'bc-content' + (onCompany ? ' bc-content-company' : '') },
        kind === 'wizard' ? h(ProjectWizard, { data, roster, preview, loading, error, mutate, onBack: () => actions.openCompanyPage('list'), onCreated: result => actions.openCompanyPage('detail', result.body?.project?.id) })
          : kind === 'detail' ? h(ProjectPage, { project, data, tasks, tasksError, preview, loading: loading || detailLoading, error: detailError || error, onBack: () => actions.openCompanyPage('list'), onChat: () => project && openChat(project), onRetry: () => setDetailAttempt(value => value + 1), onTaskCommand: sendTask, onArchiveData: loadArchiveData, onCommand: async (command, fields) => { const result = await mutate(command, fields); setDetailAttempt(value => value + 1); return result } })
            : onTemplates ? h(TemplatesPage, {
              data,
              roster,
              preview,
              loading,
              error,
              escapeGuard,
              actions,
              selectedId: page?.id ?? null,
              onSelectTemplate: id => actions.openCompanyPage('templates', id),
              onRetry: () => void load(),
              onCommand: mutate,
            })
              : onCompany ? h(CompanyPage, {
              data,
              loading,
              error,
              todos: todosData,
              todoLoading,
              todoError,
              escapeGuard,
              onRetry: () => void load(),
              onRetryTodos: () => setTodoAttempt(value => value + 1),
              onOpenEmployee: openEmployeeChat,
              onOpenProjects: () => actions.openCompanyPage('list'),
              onOpenProject: id => actions.openCompanyPage('detail', id),
              onCommand: mutate,
              roster,
            })
              : onTodos ? h(TodoPage, {
              todos: todosData?.todos ?? [],
              counts: todosData?.counts ?? null,
              read_at: todosData?.read_at ?? null,
              loading: todoLoading,
              error: todoError,
              onRetry: () => setTodoAttempt(value => value + 1),
              actions: {
                onOpenProjects: () => actions.openCompanyPage('list'),
                onOpenProject: openTodoProject,
                onDecide: answerTodo,
                onInvestigate: investigateTodo,
              },
            })
              : h('section', { className: 'bc-page', 'aria-label': t('Project list') },
              h('div', { className: 'bc-head' },
                h('div', { className: 'bc-grow' },
                  h('h1', null, t('Projects')),
                  h('p', { className: 'bc-sub' }, t('{count} projects', { count: visible.length })))),
              h('div', { className: 'bc-toolbar bc-toolbar-projects' },
                h('label', { className: 'bc-searchfield' },
                  h(SearchIcon),
                  h('input', { type: 'search', className: 'bc-search bc-search-wide', value: query, onChange: event => setQuery(event.target.value), placeholder: t('Search a project name or goal'), 'aria-label': t('Search projects') })),
                h('button', { type: 'button', className: 'bc-button bc-primary', style: { flex: 'none', whiteSpace: 'nowrap' }, onClick: () => actions.openCompanyPage('wizard') }, '+ ', t('New project'))),
              loading ? h('div', { className: 'bc-plist', role: 'status', 'aria-label': t('Loading projects…') }, [0, 1, 2].map(index => h('div', { key: index, className: 'bc-pcard bc-skeleton' }, h('span', { className: 'bc-skel bc-skel-title' }), h('span', { className: 'bc-skel bc-skel-line' }), h('span', { className: 'bc-skel bc-skel-line short' }))))
                : error ? h('div', { className: 'bc-state bc-error', role: 'alert' }, h('strong', null, t('Projects could not be loaded.')), h('p', null, error), h('button', { type: 'button', className: 'bc-button', onClick: () => void load() }, t('Try again')), h('button', { type: 'button', className: 'bc-button', onClick: previewData }, t('Open local sample preview')))
                  : data.projects.length === 0 ? h('div', { className: 'bc-state' }, h('strong', null, t('No projects here yet')), h('p', null, t('Create a project to bring employees together around one goal.')), h('button', { type: 'button', className: 'bc-button bc-primary', onClick: () => actions.openCompanyPage('wizard') }, t('New project')))
                    : visible.length === 0 ? h('div', { className: 'bc-state' }, h('strong', null, query.trim() ? t('No matching projects') : t('No projects in this view.')), h('p', null, query.trim() ? t('Try another name or status.') : t('Try another status, or view all projects.')), h('button', { type: 'button', className: 'bc-button', onClick: () => { if (query.trim()) setQuery(''); else setFilter('all') } }, query.trim() ? t('Clear search') : t('Show all projects')))
                      : h('div', { className: 'bc-tablewrap' },
                        h('table', { className: 'bc-table' },
                          h('thead', null, h('tr', null, [t('Project'), t('Stage'), t('Waiting for you'), t('Source department'), t('Coordinator'), t('Last activity'), ''].map((label, index) => h('th', { key: index, scope: 'col' }, label)))),
                          h('tbody', null, visible.map(item => {
                            const coordinator = coordinatorOf(item)
                            const department = departmentOf(item)
                            const activity = formatActivity(item.updated_at)
                            const pendingCount = project => (todosData?.pending ?? []).filter(todo => todo.project_id === project.id).length
                            return h('tr', { key: item.id, className: 'bc-trow', tabIndex: 0, onClick: () => openProject(item), onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProject(item) } } },
                              h('td', { className: 'bc-td-project' }, h('strong', null, item.name), h('span', null, item.goal || t('No goal specified'))),
                              h('td', null, h('span', { className: 'bc-tag' }, statusLabel(item.status))),
                              h('td', { className: 'bc-td-num' }, pendingCount(item) || '—'),
                              h('td', null, department || '—'),
                              h('td', null, coordinator?.name ?? t('Coordinator pending')),
                              h('td', null, activity || '—'),
                              h('td', { className: 'bc-td-more' }, h('button', { type: 'button', className: 'bc-more', 'aria-label': t('Open project details'), onClick: event => { event.stopPropagation(); openProject(item) } }, '…', h('span', null, t('Advanced')))))
                          }))))))
    )
    )
}

export const statusLabel = status => ({ setup: t('Setup'), active: t('In progress'), paused: t('Paused'), archived: t('Archived') })[status] ?? t('Unknown status')

export const COMPANY_CSS = COMPANY_PAGE_CSS + TEMPLATES_CSS + TASK_BOARD_CSS + `
.bc-surface{--bc-small:11px;--bc-label:12px;--bc-body:13px;--bc-title:17px;--bc-radius:12px;position:fixed;inset:0;z-index:1100;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font);overflow:auto;overscroll-behavior:contain}.bc-surface *{box-sizing:border-box}.bc-surface-workspace{left:var(--bt-company-left,0px)}.bc-shell{min-height:100vh;display:flex;flex-direction:column}.bc-header{height:52px;flex:none;display:flex;gap:12px;align-items:center;padding:0 max(20px,calc((100vw - 960px)/2));border-bottom:1px solid var(--bt-line);background:var(--bt-card)}.bc-brand{background:none;border:0;color:var(--bt-ink);font-size:15px;font-weight:700;cursor:pointer}.bc-header-context{color:var(--bt-ink-2);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bc-icon{margin-left:auto;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink);font-size:24px;cursor:pointer}.bc-content{width:min(100%,1000px);margin:0 auto;padding:32px 24px 64px}.bc-surface-workspace .bc-content{width:100%;max-width:none;padding:20px 32px 48px}.bc-surface-workspace .bc-page{max-width:none}.bc-surface-company .bc-content-company{padding:0}.bc-kicker{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--bt-ink-2)}.bc-lead{display:flex;justify-content:space-between;align-items:end;gap:20px;margin:0 0 28px}.bc-lead h1{font-size:var(--bc-title);line-height:24px;margin:8px 0}.bc-lead p,.bc-muted{color:var(--bt-ink-2);line-height:1.5}.bc-lead p{margin:0;font-size:13px}.bc-button{border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);padding:9px 13px;min-height:36px;font:600 13px var(--bt-font);cursor:pointer}.bc-button:hover,.bc-icon:hover,.bc-filter:hover{background:var(--bt-hover)}.bc-primary{min-height:40px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink,var(--bt-user-ink));border-color:var(--bt-accent)}.bc-primary:hover{filter:brightness(.94);background:var(--bt-accent)}.bc-button:disabled{opacity:.45;cursor:not-allowed}.bc-surface :is(button,input,textarea,select,summary):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}.bc-toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}.bc-filters{display:flex;gap:4px;border:1px solid var(--bt-line);border-radius:8px;padding:3px}.bc-filter{border:0;border-radius:6px;background:transparent;color:var(--bt-ink-2);padding:7px 11px;font-size:12px;cursor:pointer}.bc-selected{background:var(--bt-active);color:var(--bt-ink);font-weight:600}.bc-search,.bc-field :is(input,textarea,select){border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);padding:9px 11px;font:13px var(--bt-font)}.bc-search{width:210px}.bc-list{border:1px solid var(--bt-line);border-radius:12px;overflow:hidden;background:var(--bt-card)}.bc-project-row{display:flex;width:100%;gap:20px;align-items:center;text-align:left;padding:17px 20px;border:0;border-bottom:1px solid var(--bt-line);background:transparent;color:var(--bt-ink);cursor:pointer}.bc-project-row:last-child{border:0}.bc-project-row:hover{background:var(--bt-hover)}.bc-project-main{min-width:0;flex:1;display:grid;gap:5px}.bc-project-main strong{font-size:14px}.bc-project-main span,.bc-project-main small,.bc-project-meta small{font-size:12px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bc-project-meta{min-width:140px;display:grid;justify-items:end;gap:5px}.bc-status{display:inline-flex;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;font-weight:700;padding:4px 7px}.bc-status.bc-active{color:var(--bt-green)}.bc-status.bc-paused,.bc-status.bc-pending{color:var(--bt-star)}.bc-status.bc-archived{color:var(--bt-ink-2)}.bc-state{border:1px dashed var(--bt-line-2);border-radius:12px;padding:32px;text-align:center;color:var(--bt-ink-2);font-size:13px}.bc-state strong{color:var(--bt-ink);font-size:15px}.bc-state .bc-button{margin:5px}.bc-error{border-color:var(--bt-danger)}.bc-preview{padding:8px 24px;background:var(--bt-tag-bg);text-align:center;color:var(--bt-ink);font-size:12px;font-weight:700}.bc-notice{display:flex;gap:12px;align-items:center;justify-content:center;padding:8px 20px;background:var(--bt-tag-bg);font-size:12px}.bc-notice button{border:0;background:transparent;color:var(--bt-ink);cursor:pointer}.bc-back{background:none;border:0;color:var(--bt-ink-2);font:600 12px var(--bt-font);padding:6px 0;cursor:pointer}.bc-back:hover{color:var(--bt-ink)}.bc-section{background:var(--bt-card);border:1px solid var(--bt-line);border-radius:12px;padding:20px;margin:16px 0}.bc-section h2{font-size:14px;margin:0 0 14px}.bc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.bc-field{display:grid;gap:6px;font-size:12px;font-weight:600}.bc-field :is(input,textarea,select){width:100%}.bc-field textarea{resize:vertical;min-height:72px}.bc-field small{font-weight:400;color:var(--bt-ink-2)}.bc-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.bc-detail-title{font-size:var(--bc-title);line-height:24px;margin:10px 0}.bc-detail-label{color:var(--bt-ink-2);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.bc-detail-value{font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.bc-member{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--bt-line);font-size:13px}.bc-member small{font-size:11px;color:var(--bt-ink-2)}.bc-steps{display:flex;flex-wrap:wrap;gap:6px;margin:24px 0}.bc-step{font-size:11px;color:var(--bt-ink-2);padding:7px 10px;border:1px solid var(--bt-line);border-radius:6px}.bc-step[aria-current=step]{color:var(--bt-ink);border-color:var(--bt-accent);font-weight:700}.bc-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.bc-choice{display:flex;align-items:center;gap:8px;padding:8px 0;font-size:13px}.bc-choice input{accent-color:var(--bt-accent)}.bc-exception{border-left:3px solid var(--bt-danger);padding:10px 12px;background:var(--bt-tag-bg);font-size:12px;line-height:1.5}.bc-exception strong{display:block}.bc-optional{margin-top:16px;border-top:1px solid var(--bt-line);padding-top:14px}.bc-optional summary{cursor:pointer;color:var(--bt-ink);font-size:13px;font-weight:600}.bc-optional[open] summary{margin-bottom:16px}.bc-start-reason{text-align:right;color:var(--bt-ink-2);font-size:12px;line-height:1.5}.bc-surface button{touch-action:manipulation}@media(max-width:620px){.bc-header{height:48px;padding:0 14px}.bc-content{padding:22px 14px 48px}.bc-lead{align-items:flex-start}.bc-lead h1{font-size:var(--bc-title)}.bc-toolbar{align-items:stretch;flex-direction:column}.bc-search{width:100%}.bc-project-row{padding:14px;gap:8px}.bc-project-meta{min-width:88px}.bc-grid{grid-template-columns:1fr}.bc-section{padding:16px}}
.bc-surface{--bc-text-xs:11px;--bc-text-sm:12px;--bc-text-content:14px;--bc-text-heading:15px;--bc-text-title:17px;--bc-control-sm:28px;--bc-control-md:36px;--bc-control-lg:40px;--bc-radius-tag:4px;--bc-radius-field:8px;--bc-radius-row:10px;--bc-radius-card:12px;--bc-shadow-raised:0 2px 8px -1px color-mix(in srgb,var(--bt-ink) 6%,transparent),0 1px 2px color-mix(in srgb,var(--bt-ink) 4%,transparent);--bc-shadow-dock:0 0 0 .5px var(--bt-line-2),0 2px 8px -2px color-mix(in srgb,var(--bt-ink) 12%,transparent);--bc-mask-header:60px}
.bc-head{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:0 0 14px}.bc-head .bc-grow{flex:1;min-width:200px}.bc-head h1{font-size:var(--bc-text-title);line-height:24px;font-weight:600;margin:4px 0 0}.bc-crumb{font-size:var(--bc-text-xs);line-height:16px;color:var(--bt-ink-3)}.bc-chips{display:flex;gap:6px;flex-wrap:wrap}.bc-chip{height:var(--bc-control-sm);padding:0 10px;border-radius:999px;border:1px solid var(--bt-line-2);background:var(--bt-card);font-size:var(--bc-text-sm);line-height:16px;color:var(--bt-ink-2);cursor:pointer}.bc-chip:hover{background:var(--bt-hover)}.bc-chip[aria-pressed="true"]{background:var(--bt-accent);border-color:transparent;color:var(--bt-accent-ink);font-weight:500}.bc-search{height:36px;width:220px;max-width:100%;margin-left:auto;border:1px solid var(--bt-line-2);border-radius:var(--bc-radius-field);background:var(--bt-card);padding:0 10px;font-size:13px;color:var(--bt-ink)}.bc-plist{display:flex;flex-direction:column;gap:10px}.bc-pcard{display:block;width:100%;text-align:left;font:inherit;cursor:pointer;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:var(--bc-radius-card);padding:14px 16px;box-shadow:var(--bc-shadow-raised)}.bc-pcard:hover{border-color:var(--bt-line-2)}.bc-pcard-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.bc-pcard-top strong{font-size:var(--bc-text-heading);line-height:22px;font-weight:600;color:var(--bt-ink)}.bc-tag{display:inline-flex;align-items:center;gap:4px;padding:2px 6px;border-radius:var(--bc-radius-tag);background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:var(--bc-text-xs);line-height:16px;white-space:nowrap}.bc-pcard-goal{display:block;font-size:13px;line-height:18px;color:var(--bt-ink-2);margin:4px 0 8px}.bc-pcard-meta{display:flex;gap:6px 14px;flex-wrap:wrap;font-size:var(--bc-text-sm);line-height:16px;color:var(--bt-ink-2)}.bc-skeleton{cursor:default}.bc-skel{display:block;height:12px;border-radius:6px;background:var(--bt-tag-bg);position:relative;overflow:hidden}.bc-skel::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,var(--bt-hover),transparent);transform:translateX(-100%);animation:bc-sh 1.2s infinite}.bc-skel-title{width:40%;height:16px;margin-bottom:8px}.bc-skel-line{width:70%;margin-bottom:6px}.bc-skel-line.short{width:45%}@keyframes bc-sh{to{transform:translateX(100%)}}.bc-sub{margin:6px 0 0;color:var(--bt-ink-2);font-size:12px;line-height:18px}.bc-toolbar-projects{display:flex;align-items:center;gap:12px;margin:0 0 14px}.bc-search-wide{width:min(420px,100%);margin-left:0;flex:1}
.bc-searchfield{display:flex;align-items:center;gap:7px;flex:1;min-width:0;max-width:420px;height:36px;padding:0 11px;border:1px solid var(--bt-line-2);border-radius:var(--bc-radius-field);background:var(--bt-card);color:var(--bt-ink-3)}
.bc-searchfield svg{flex:none;width:14px;height:14px}
.bc-searchfield input{flex:1;min-width:0;height:auto;padding:0;margin:0;border:0;background:none;outline:none}
.bc-searchfield:focus-within{outline:2px solid var(--bt-accent);outline-offset:2px}.bc-tablewrap{border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);overflow:hidden}.bc-table{width:100%;border-collapse:collapse;table-layout:fixed}.bc-table th{height:40px;padding:0 14px;text-align:left;font-size:11px;font-weight:500;color:var(--bt-ink-3);border-bottom:1px solid var(--bt-line);background:var(--bt-card)}.bc-table td{height:58px;padding:8px 14px;border-bottom:1px solid var(--bt-line);font-size:12px;line-height:18px;color:var(--bt-ink-2);vertical-align:middle}.bc-table tr:last-child td{border-bottom:0}.bc-table th:nth-child(1){width:32%}.bc-table th:nth-child(2){width:10%}.bc-table th:nth-child(3){width:9%}.bc-table th:nth-child(4){width:12%}.bc-table th:nth-child(5){width:12%}.bc-table th:nth-child(6){width:14%}.bc-table th:nth-child(7){width:11%}.bc-trow{cursor:pointer;transition:background .12s}.bc-trow:hover{background:var(--bt-hover)}.bc-trow:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}.bc-td-project strong{display:block;font-size:13px;line-height:18px;color:var(--bt-ink);font-weight:600}.bc-td-project span{display:block;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-2);font-size:11px;line-height:16px;margin-top:2px}.bc-td-num{font-variant-numeric:tabular-nums}.bc-td-more{text-align:right;white-space:nowrap}.bc-more{border:0;background:transparent;color:var(--bt-ink-3);font:inherit;cursor:pointer;padding:4px 2px;border-radius:6px}.bc-more span{margin-left:4px}.bc-more:hover{color:var(--bt-ink);background:var(--bt-hover)}@media (max-width:900px){.bc-table th:nth-child(4),.bc-table td:nth-child(4),.bc-table th:nth-child(6),.bc-table td:nth-child(6){display:none}.bc-surface-workspace .bc-content{padding:16px}}`
