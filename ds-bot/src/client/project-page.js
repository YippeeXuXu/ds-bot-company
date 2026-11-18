import { createElement as h, useState } from 'react'
import { t } from './i18n.js'
import { TaskBoard } from './task-board.js'

const label = value => ({ setup: t('Setup'), active: t('In progress'), paused: t('Paused'), archived: t('Archived') })[value] ?? t('Unknown status')
const relation = (project, data) => (project?.source_department_ids ?? []).map(id => data.departments.find(item => item.id === id)?.name ?? id)

const statusLabel = value => ({ active: t('Active'), invited: t('Invited'), left: t('Left'), removed: t('Removed'), archived_readonly: t('Left (read-only)') })[value] ?? value
const roleLabel = value => roleOptions().find(([option]) => option === value)?.[1] ?? value
const roleOptions = () => [['executor', t('Executor')], ['coordinator', t('Coordinator')], ['acceptor', t('Independent acceptor')], ['memory_keeper', t('Memory keeper')]]
const memberError = failure => {
  const known = {
    'project/coordinator-exists': t('The project already has a coordinator. The current one steps down first.'),
    'project/member-exists': t('This employee is already in the project.'),
    'project/member-busy': t('This employee is already in another active project.'),
    'project/member-not-found': t('This member is no longer active in the project.'),
    'project/state-conflict': t('A project in this state cannot change members.'),
  }[failure?.code]
  return known ?? (failure?.message ? String(failure.message) : t('The change could not be saved.'))
}

export function ProjectPage({ project, data, tasks = [], tasksError = '', preview, loading, error, onBack, onChat, onRetry, onCommand, onTaskCommand, onArchiveData }) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [selectedEmployee, setSelectedEmployee] = useState('')
  const [pendingRemove, setPendingRemove] = useState(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveBusy, setArchiveBusy] = useState(false)
  const [archiveError, setArchiveError] = useState('')
  const [archiveResult, setArchiveResult] = useState(null)
  const [archiveCheck, setArchiveCheck] = useState(null)
  const [archiveChecking, setArchiveChecking] = useState(false)
  const [archiveCheckError, setArchiveCheckError] = useState('')
  const run = async (command, fields = {}) => {
    if (busy || preview || !project) return
    setBusy(true)
    setActionError('')
    try { await onCommand(command, { project_id: project.id, ...fields }); return true }
    catch (failure) { setActionError(memberError(failure)); return false }
    finally { setBusy(false) }
  }
  if (loading && !project) return h('section', { className: 'bc-state', role: 'status' }, t('Loading project…'))
  if (error) return h('section', { className: 'bc-state bc-error', role: 'alert' }, h('strong', null, t('Project could not be loaded.')), h('p', null, error), h('button', { type: 'button', className: 'bc-button', onClick: onRetry }, t('Try again')), h('button', { type: 'button', className: 'bc-button', onClick: onBack }, t('Back to projects')))
  if (!project) return h('section', { className: 'bc-state' }, h('strong', null, t('Project not found')), h('p', null, t('Its record may have changed. Return to the project list.')), h('button', { type: 'button', className: 'bc-button', onClick: onBack }, t('Back to projects')))
  const binding = preview ? project.group_binding : data.group?.group_binding ?? project.group_binding
  const unbound = binding?.status === 'unbound' && !project.group_chat_ref
  const pending = binding?.status !== 'bound' || (!preview && data.group?.drifted === true)
  const members = preview ? (data.members ?? []).filter(member => member.project_id === project.id) : data.members ?? []
  const coordinator = members.find(member => member.id === project.coordinator_assignment_id || member.role === 'coordinator')
  const employeeName = id => data.employees.find(employee => employee.id === id)?.name ?? id
  const invalidMember = members.some(member => {
    const employee = data.employees.find(item => item.id === member.employee_id)
    const department = data.departments.find(item => item.id === employee?.department_id)
    return !employee || employee.status !== 'active' || !department || department.status !== 'active'
  })
  const missingDepartmentChat = members.some(member => {
    const employee = data.employees.find(item => item.id === member.employee_id)
    return employee && !data.departments.find(item => item.id === employee.department_id)?.chat_ref
  })
  const startBlockers = [preview ? t('Local sample cannot be started') : null,
    !coordinator ? t('assign a project coordinator') : null,
    invalidMember ? t('resolve inactive members or departments') : null,
    missingDepartmentChat ? t('bind department chats') : null,
    pending && !unbound ? t('reconcile the project group') : null,
    !project.acceptance_actor ? t('assign an acceptance Bot') : null, !project.memory_assignment_id ? t('assign a memory keeper') : null,
    !project.workspace_ref ? t('set a workspace folder') : null].filter(Boolean)
  const candidates = data.employees.filter(employee => employee.status === 'active' && (project.source_department_ids ?? []).includes(employee.department_id)
    && !members.some(member => member.employee_id === employee.id && ['active', 'invited', 'archived_readonly'].includes(member.membership_status))
    && !data.projects.some(item => item.id === employee.project_id && ['active', 'paused', 'delivering'].includes(item.status)))
  // The archive check is a fresh read of both lists, not the board's cache: a pending
  // acceptance may have no task at all, and a failed task read must not look like zero.
  const checkTasks = archiveCheck?.tasks ?? []
  const checkAcceptances = archiveCheck?.acceptances ?? []
  const openTasks = checkTasks.filter(task => !['done', 'cancelled'].includes(task.stage ?? task.status))
  const pendingAcceptanceRecords = checkAcceptances.filter(record => (record.state ?? 'pending') === 'pending')
  const pendingAcceptances = pendingAcceptanceRecords.length
  const independentPending = pendingAcceptanceRecords.filter(record => !record.task_id)
  const archiveChecked = Boolean(archiveCheck) && !archiveChecking && !archiveCheckError
  const canArchive = ['setup', 'active', 'paused'].includes(project.status) && !preview
  const openArchive = () => {
    setArchiveOpen(true)
    setArchiveError('')
    setArchiveResult(null)
    setArchiveCheck(null)
    setArchiveCheckError('')
    if (!onArchiveData) {
      if (tasksError) { setArchiveCheckError(tasksError); return }
      setArchiveCheck({ tasks, acceptances: tasks.flatMap(task => Array.isArray(task.acceptances) ? task.acceptances : task.acceptance ? [task.acceptance] : []) })
      return
    }
    setArchiveChecking(true)
    void onArchiveData(project.id)
      .then(snapshot => {
        if (!snapshot) throw new Error(t('The archive check could not be loaded.'))
        setArchiveCheck({ tasks: snapshot.tasks ?? [], acceptances: snapshot.acceptances ?? [] })
      })
      .catch(failure => setArchiveCheckError(failure?.message ? String(failure.message) : t('The archive check could not be loaded.')))
      .finally(() => setArchiveChecking(false))
  }
  const archive = async () => {
    if (archiveBusy || !archiveChecked) return
    setArchiveBusy(true)
    setArchiveError('')
    try {
      const result = await onCommand('project.archive', { project_id: project.id })
      setArchiveResult(result?.body ?? { unresolved: [] })
    } catch (failure) {
      setArchiveError(failure?.message ? String(failure.message) : t('The project could not be archived.'))
    } finally { setArchiveBusy(false) }
  }
  const unresolved = archiveResult?.unresolved ?? []
  return h('article', { className: 'bc-page' },
    h('button', { type: 'button', className: 'bc-back', onClick: onBack }, `← ${t('All projects')}`),
    h('div', { className: 'bc-row' }, h('div', null, h('span', { className: 'bc-kicker' }, t('Workspace / Project')), h('h1', { className: 'bc-detail-title' }, project.name)),
      h('div', { className: 'bc-actions' },
        h('span', { className: `bc-status bc-${project.status}` }, label(project.status)),
        canArchive ? h('button', { type: 'button', className: 'bc-button bc-danger', disabled: busy || archiveBusy, onClick: openArchive }, t('Archive project')) : null)),
    h('div', { className: 'bc-section' },
      h('div', { className: 'bc-row' }, h('strong', null, t('Project chat')), h('button', { type: 'button', className: 'bc-button', onClick: onChat, disabled: pending || preview || project.status === 'archived', title: preview ? t('Sample chat is unavailable') : undefined }, t('Open chat'))),
      h('p', { className: 'bc-muted' }, unbound ? t('The project group is created when a member joins or the project starts.') : pending ? t('Group binding needs attention before chat can be opened.') : project.status === 'archived' ? t('Archived project. The group history remains available for reading.') : t('Project group is linked. Open the existing chat to continue.')),
      pending && !unbound ? h('div', { className: 'bc-exception', role: 'status' }, h('strong', null, t('Group needs reconciliation')), t('Group changes are not synced. An authorized operator must reconcile the group before starting work.'), binding?.error && !preview ? h('p', null, binding.error) : null,
        project.status !== 'archived' ? h('button', { type: 'button', className: 'bc-button', disabled: busy || preview, onClick: () => void run('project.group.reconcile') }, t('Reconcile group')) : null) : null),
    h('div', { className: 'bc-grid' },
      h('section', { className: 'bc-section' }, h('h2', null, t('Purpose and delivery')), h('div', { className: 'bc-detail-label' }, t('Goal')), h('p', { className: 'bc-detail-value' }, project.goal || '—'), h('div', { className: 'bc-detail-label' }, t('Deliverable')), h('p', { className: 'bc-detail-value' }, project.deliverable || '—'), h('div', { className: 'bc-detail-label' }, t('Acceptance')), h('p', { className: 'bc-detail-value' }, project.acceptance || '—')),
      h('section', { className: 'bc-section' }, h('h2', null, t('People and departments')), h('div', { className: 'bc-detail-label' }, t('Source departments')), h('p', { className: 'bc-detail-value' }, relation(project, data).join(' · ') || '—'), h('div', { className: 'bc-detail-label' }, t('Coordinator')), h('p', { className: 'bc-detail-value' }, coordinator ? employeeName(coordinator.employee_id) : t('Not assigned')),
        members.length ? members.map(member => {
          const status = member.membership_status ?? member.status
          const active = status === 'active'
          return h('div', { className: 'bc-member bc-member-edit', key: member.id },
            h('span', { className: 'bc-member-name' }, employeeName(member.employee_id)),
            active && ['setup', 'active'].includes(project.status) && roleOptions().some(([option]) => option === member.role)
              ? h('select', {
                className: 'bc-member-role',
                value: member.role,
                'aria-label': t('Change role of {name}', { name: employeeName(member.employee_id) }),
                disabled: busy || preview,
                onChange: event => void run('project.member.update', { employee_id: member.employee_id, role: event.target.value }),
              }, roleOptions().map(([value, text]) => h('option', { key: value, value }, text)))
              : h('small', { className: 'bc-member-status' }, `${roleLabel(member.role)} · ${statusLabel(status)}`),
            active && ['setup', 'active'].includes(project.status)
              ? (pendingRemove === member.id
                ? h('span', { className: 'bc-member-actions' },
                  h('button', { type: 'button', className: 'bc-button bc-danger', disabled: busy || preview, onClick: async () => { if (await run('project.member.remove', { employee_id: member.employee_id })) setPendingRemove(null) } }, t('Confirm removal')),
                  h('button', { type: 'button', className: 'bc-button', onClick: () => setPendingRemove(null) }, t('Cancel')))
                : h('button', { type: 'button', className: 'bc-member-remove', 'aria-label': t('Remove {name} from the project', { name: employeeName(member.employee_id) }), disabled: busy || preview, onClick: () => setPendingRemove(member.id) }, t('Remove member')))
              : null)
        }) : h('p', { className: 'bc-muted' }, t('No members to show yet.')),
        members.some(member => member.membership_status === 'left' || member.membership_status === 'removed')
          ? h('p', { className: 'bc-muted' }, t('Members who left keep their history in the project.')) : null,
        ['setup', 'active'].includes(project.status) && candidates.length ? h('div', { className: 'bc-actions' },
          h('label', { className: 'bc-field' }, t('Add a project member'), h('select', { value: selectedEmployee, onChange: event => setSelectedEmployee(event.target.value) }, h('option', { value: '' }, t('Choose an employee')), candidates.map(employee => h('option', { value: employee.id, key: employee.id }, employee.name)))),
          h('button', { type: 'button', className: 'bc-button', disabled: busy || preview || !selectedEmployee, onClick: async () => { if (await run('project.member.add', { employee_id: selectedEmployee, role: 'executor' })) setSelectedEmployee('') } }, t('Add member'))) : null)),
    h('section', { className: 'bc-section' }, h('h2', null, t('Current state')), h('p', { className: 'bc-detail-value' }, `${t('Stage')}: ${label(project.status)} · ${t('Group')}: ${unbound ? t('Not created yet') : pending ? t('Needs attention') : t('Linked')}`),
      h('div', { className: 'bc-detail-label' }, t('Acceptance actor')), h('p', { className: 'bc-detail-value' }, project.acceptance_actor === 'user' ? t('Owner') : project.acceptance_actor ? employeeName(project.acceptance_actor) : t('Not assigned')),
      h('div', { className: 'bc-detail-label' }, t('Memory keeper')), h('p', { className: 'bc-detail-value' }, project.memory_assignment_id ? employeeName(project.memory_assignment_id) : t('Not assigned')),
      h('div', { className: 'bc-detail-label' }, t('Workspace folder')), h('p', { className: 'bc-detail-value' }, project.workspace_ref || t('Not assigned')),
      project.status === 'setup' ? h('div', null, h('div', { className: 'bc-actions' }, h('button', { type: 'button', className: 'bc-button bc-primary', disabled: busy || startBlockers.length > 0, onClick: () => void run('project.start') }, busy ? t('Saving…') : t('Start project'))),
        startBlockers.length ? h('p', { className: 'bc-start-reason', role: 'status' }, t('Before starting: {items}.', { items: startBlockers.join(', ') })) : null) : null,
      actionError ? h('p', { className: 'bc-exception', role: 'alert' }, actionError) : null,
      h(TaskBoard, {
        tasks,
        employees: data.employees,
        members,
        projectId: project.id,
        workspaceRef: project.workspace_ref ?? '',
        preview,
        error: tasksError,
        onCommand: onTaskCommand,
        onChat: () => onChat?.(),
      })),
    archiveOpen ? h('div', { className: 'bc-tb-modal' },
      h('div', { className: 'bc-tb-modalcard', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Archive project') },
        h('header', { className: 'bc-co-pop-head' },
          h('strong', null, t('Archive project')),
          h('span', { className: 'bc-co-pop-name' }, project.name),
          h('button', { type: 'button', className: 'bc-co-pop-close', 'aria-label': t('Close'), disabled: archiveBusy, onClick: () => setArchiveOpen(false) }, '×')),
        h('div', { className: 'bc-co-create-fields' },
          archiveResult
            ? h('p', null, t('The project is archived. The group history stays available to read.'))
            : archiveChecking
              ? h('p', { className: 'bc-muted', role: 'status' }, t('Checking tasks and acceptances…'))
              : archiveCheckError
                ? h('div', { className: 'bc-exception', role: 'alert' }, h('strong', null, t('The archive check could not be loaded.')), h('p', null, archiveCheckError), h('button', { type: 'button', className: 'bc-button', onClick: openArchive }, t('Try again')))
                : h('p', null, t('This will close {tasks} unfinished tasks and {acceptances} pending acceptances.', { tasks: openTasks.length, acceptances: pendingAcceptances })),
          archiveResult
            ? h('p', { className: 'bc-muted' }, t('Closed {tasks} tasks and {acceptances} acceptances. This cannot be undone.', { tasks: Array.isArray(archiveResult.closed_tasks) ? archiveResult.closed_tasks.length : Number(archiveResult.closed_tasks ?? 0), acceptances: unresolved.filter(item => item.kind === 'acceptance').length }))
            : archiveChecked
              ? h('p', { className: 'bc-muted' }, t('The project and its group history are kept. Nothing can be added after archiving, and this cannot be undone.'))
              : null,
          archiveResult && unresolved.length ? h('div', null,
            h('p', { className: 'bc-detail-label' }, t('Closed on archive')),
            h('ul', { className: 'bc-tb-list' }, unresolved.map((item, index) => h('li', { key: item.task_id ?? item.acceptance_id ?? index },
              h('span', null, item.kind === 'acceptance' ? t('Acceptance: {title}', { title: item.title }) : item.title),
              h('span', null, item.stage ?? ''))))) : null,
          !archiveResult && archiveChecked && (openTasks.length || independentPending.length) ? h('div', null,
            h('p', { className: 'bc-detail-label' }, t('Will be closed')),
            h('ul', { className: 'bc-tb-list' }, [
              ...openTasks.map(task => h('li', { key: task.id }, h('span', null, task.title), h('span', null, task.stage ?? task.status ?? ''))),
              ...independentPending.map(record => h('li', { key: record.id }, h('span', null, t('Acceptance: {title}', { title: record.title ?? record.id })), h('span', null, t('Waiting for acceptance')))),
            ])) : null,
          archiveError ? h('p', { className: 'bc-exception', role: 'alert' }, archiveError) : null),
        h('div', { className: 'bc-co-create-actions' },
          h('span', { className: 'bc-co-spacer' }),
          archiveResult
            ? h('button', { type: 'button', className: 'bc-button bc-primary', onClick: () => setArchiveOpen(false) }, t('Close'))
            : h('button', { type: 'button', className: 'bc-button', disabled: archiveBusy, onClick: () => setArchiveOpen(false) }, t('Cancel')),
          archiveResult ? null : h('button', { type: 'button', className: 'bc-button bc-danger', disabled: archiveBusy || busy || !archiveChecked, onClick: () => void archive() }, archiveBusy ? t('Archiving…') : t('Archive project'))))) : null)
}
