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

export function ProjectPage({ project, data, tasks = [], tasksError = '', preview, loading, error, onBack, onChat, onRetry, onCommand, onTaskCommand }) {
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')
  const [selectedEmployee, setSelectedEmployee] = useState('')
  const [pendingRemove, setPendingRemove] = useState(null)
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
  return h('article', { className: 'bc-page' },
    h('button', { type: 'button', className: 'bc-back', onClick: onBack }, `← ${t('All projects')}`),
    h('div', { className: 'bc-row' }, h('div', null, h('span', { className: 'bc-kicker' }, t('Workspace / Project')), h('h1', { className: 'bc-detail-title' }, project.name)), h('span', { className: `bc-status bc-${project.status}` }, label(project.status))),
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
        preview,
        error: tasksError,
        onCommand: onTaskCommand,
        onChat: () => onChat?.(),
      })))
}
