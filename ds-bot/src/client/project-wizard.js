import { createElement as h, useState } from 'react'
import { t } from './i18n.js'

const stages = ['Company', 'Departments', 'Employees', 'Project']
const field = (label, value, set, placeholder, multiline = false, required = true, maxLength = 120) => h('label', { className: 'bc-field' }, label, multiline
  ? h('textarea', { value, onChange: event => set(event.target.value), placeholder, maxLength: 2000, required })
  : h('input', { value, onChange: event => set(event.target.value), placeholder, maxLength, required }))

export function ProjectWizard({ data, roster, preview, loading, error: loadError, mutate, onBack, onCreated }) {
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [departmentName, setDepartmentName] = useState('')
  const [selected, setSelected] = useState([])
  const [botId, setBotId] = useState('')
  const [employeeName, setEmployeeName] = useState('')
  const [employeeDepartment, setEmployeeDepartment] = useState('')
  const [employeeRole, setEmployeeRole] = useState('coordinator')
  const [departmentChat, setDepartmentChat] = useState('')
  const [coordinatorId, setCoordinatorId] = useState('')
  const [acceptanceRequirement, setAcceptanceRequirement] = useState('daily_independent_bot')
  const [acceptanceActor, setAcceptanceActor] = useState('')
  const [memoryEmployeeId, setMemoryEmployeeId] = useState('')
  const [workspaceRef, setWorkspaceRef] = useState('')
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [deliverable, setDeliverable] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const activeDepartments = data.departments.filter(department => department.status === 'active')
  const eligible = data.employees.filter(employee => employee.status === 'active' && selected.includes(employee.department_id) && !data.projects.some(project => project.id === employee.project_id && ['active', 'paused', 'delivering'].includes(project.status)))
  const availableBots = (roster?.bots ?? []).filter(bot => !data.employees.some(employee => employee.bot_id === bot.id && employee.status === 'active') && !bot.private)
  const memoryKeepers = data.employees.filter(employee => employee.status === 'active' && employee.acceptance_role === 'memory_keeper')
  const acceptanceBots = data.employees.filter(employee => employee.status === 'active' && employee.id !== coordinatorId && employee.acceptance_role !== 'memory_keeper')
  const selectedDepartments = activeDepartments.filter(department => selected.includes(department.id))
  const unbound = selectedDepartments.filter(department => !department.chat_ref || (!preview && (!roster?.ready || !roster.roomsById?.[department.chat_ref])))
  const submit = async task => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await task() } catch (failure) { setError(failure?.message ?? String(failure)) }
    finally { setBusy(false) }
  }
  const toggle = id => setSelected(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  const createDepartment = () => submit(async () => {
    if (!departmentName.trim()) return
    const result = await mutate('department.create', { name: departmentName.trim() })
    const id = result.body?.department?.id
    if (id) setSelected(current => [...current, id])
    setDepartmentName('')
    setDepartmentChat('')
  })
  const bindDepartment = departmentId => submit(async () => {
    if (!departmentChat) return
    await mutate('department.update', { department_id: departmentId, chat_ref: departmentChat })
    setDepartmentChat('')
  })
  const createEmployee = () => submit(async () => {
    if (!botId || !employeeDepartment || !selected.includes(employeeDepartment)) return
    const result = await mutate('employee.create', { bot_id: botId, name: employeeName.trim() || (roster?.byId?.[botId]?.name ?? botId), department_id: employeeDepartment, acceptance_role: employeeRole })
    if (employeeRole === 'coordinator') setCoordinatorId(result.body?.employee?.id ?? '')
    if (employeeRole === 'memory_keeper') setMemoryEmployeeId(result.body?.employee?.id ?? '')
    if (employeeRole === 'acceptor') setAcceptanceActor(result.body?.employee?.id ?? '')
    setBotId('')
    setEmployeeName('')
  })
  const createProject = () => submit(async () => {
    if (!name.trim() || !goal.trim() || !deliverable.trim() || !acceptance.trim() || !coordinatorId || !memoryEmployeeId || !workspaceRef.trim() || (acceptanceRequirement !== 'owner_only' && !acceptanceActor) || unbound.length) return
    const result = await mutate('project.create', {
      name: name.trim(), goal: goal.trim(), deliverable: deliverable.trim(), acceptance: acceptance.trim(),
      source_department_ids: selected, coordinator_employee_id: coordinatorId,
      acceptance_requirement: acceptanceRequirement, acceptance_actor: acceptanceRequirement === 'owner_only' ? 'user' : acceptanceActor,
      memory_employee_id: memoryEmployeeId, workspace_ref: workspaceRef.trim(),
    })
    onCreated(result)
  })
  if (loading) return h('section', { className: 'bc-state', role: 'status' }, t('Loading organization…'))
  if (loadError) return h('section', { className: 'bc-state bc-error', role: 'alert' }, h('strong', null, t('Organization could not be loaded.')), h('p', null, loadError), h('button', { type: 'button', className: 'bc-button', onClick: onBack }, t('Back to projects')))
  return h('section', { className: 'bc-page', 'aria-label': t('Create a project') },
    h('button', { type: 'button', className: 'bc-back', onClick: onBack }, `← ${t('All projects')}`),
    h('span', { className: 'bc-kicker' }, t('New project / Step {current} of 4', { current: step + 1 })),
    h('h1', { className: 'bc-detail-title' }, t('Create a project')),
    h('div', { className: 'bc-steps', role: 'list', 'aria-label': t('Creation stages') }, stages.map((stage, index) => h('span', { key: stage, className: 'bc-step', role: 'listitem', 'aria-current': step === index ? 'step' : undefined }, `${index + 1}. ${t(stage)}`))),
    step === 0 ? h('div', { className: 'bc-section' }, h('h2', null, t('Company')), data.company
      ? h('p', { className: 'bc-detail-value' }, data.company.name)
      : h('div', null, h('p', { className: 'bc-muted' }, t('Create the company before adding departments.')), field(t('Company name'), companyName, setCompanyName, t('Company name'))),
      h('div', { className: 'bc-actions' }, h('button', { type: 'button', className: 'bc-button bc-primary', disabled: busy || (!data.company && !companyName.trim()), onClick: () => submit(async () => { if (!data.company) await mutate('company.init', { name: companyName.trim() }); setStep(1) }) }, busy ? t('Saving…') : t('Continue')))) : null,
    step === 1 ? h('div', { className: 'bc-section' }, h('h2', null, t('Source departments')), h('p', { className: 'bc-muted' }, t('Choose source departments. Add their employees from the project page after creation.')), activeDepartments.length ? activeDepartments.map(department => h('label', { className: 'bc-choice', key: department.id }, h('input', { type: 'checkbox', checked: selected.includes(department.id), onChange: () => toggle(department.id) }), department.name)) : h('p', { className: 'bc-muted' }, t('No departments yet. Add one below.')),
      h('div', { className: 'bc-row' }, field(t('New department'), departmentName, setDepartmentName, t('Department name'), false, true, 80), h('button', { type: 'button', className: 'bc-button', disabled: busy || !departmentName.trim(), onClick: createDepartment }, t('Add department'))),
      unbound.length ? h('div', { className: 'bc-exception', role: 'status' }, h('strong', null, t('Bind department chats before creating a project.')), h('p', null, t('Create a group chat with at least two Bots in Chats, then select it here.')), h('label', { className: 'bc-field' }, t('Existing group chat'), h('select', { value: departmentChat, onChange: event => setDepartmentChat(event.target.value) }, h('option', { value: '' }, t('Choose a group chat')), (roster?.rooms ?? []).map(room => h('option', { key: room.id, value: room.id }, room.name)))), unbound.map(department => h('button', { type: 'button', className: 'bc-button', key: department.id, disabled: busy || !departmentChat, onClick: () => bindDepartment(department.id) }, t('Bind chat to {name}', { name: department.name })))) : null,
      h('div', { className: 'bc-actions' }, h('button', { type: 'button', className: 'bc-button', onClick: () => setStep(0) }, t('Back')), h('button', { type: 'button', className: 'bc-button bc-primary', disabled: selected.length === 0 || unbound.length > 0, onClick: () => setStep(2) }, t('Continue')))) : null,
    step === 2 ? h('div', { className: 'bc-section' }, h('h2', null, t('Project coordinator')), h('p', { className: 'bc-muted' }, t('Choose an active employee from a source department who is not assigned to another active project.')),
      h('label', { className: 'bc-field' }, t('Employee'), h('select', { value: coordinatorId, onChange: event => setCoordinatorId(event.target.value) }, h('option', { value: '' }, t('Choose an employee')), eligible.map(employee => h('option', { value: employee.id, key: employee.id }, employee.name)))),
      h('h2', { style: { marginTop: 24 } }, t('Add an employee profile')), h('p', { className: 'bc-muted' }, t('Select a team Bot to create an employee profile in one selected department.')),
      h('div', { className: 'bc-grid' }, h('label', { className: 'bc-field' }, t('Bot'), h('select', { value: botId, onChange: event => setBotId(event.target.value) }, h('option', { value: '' }, t('Choose a Bot')), availableBots.map(bot => h('option', { value: bot.id, key: bot.id }, bot.name)))), h('label', { className: 'bc-field' }, t('Department'), h('select', { value: employeeDepartment, onChange: event => setEmployeeDepartment(event.target.value) }, h('option', { value: '' }, t('Choose a department')), activeDepartments.filter(department => selected.includes(department.id)).map(department => h('option', { value: department.id, key: department.id }, department.name))))),
      h('label', { className: 'bc-field' }, t('Employee role'), h('select', { value: employeeRole, onChange: event => setEmployeeRole(event.target.value) }, h('option', { value: 'coordinator' }, t('Coordinator')), h('option', { value: 'acceptor' }, t('Independent acceptor')), h('option', { value: 'memory_keeper' }, t('Memory keeper')))),
      field(t('Employee display name (optional)'), employeeName, setEmployeeName, t('Use Bot name'), false, false),
      h('div', { className: 'bc-actions' }, h('button', { type: 'button', className: 'bc-button', disabled: busy || !botId || !employeeDepartment, onClick: createEmployee }, t('Add employee')), h('button', { type: 'button', className: 'bc-button', onClick: () => setStep(1) }, t('Back')), h('button', { type: 'button', className: 'bc-button bc-primary', disabled: !coordinatorId, onClick: () => setStep(3) }, t('Continue')))) : null,
    step === 3 ? h('div', { className: 'bc-section' }, h('h2', null, t('Project brief')), h('div', { className: 'bc-grid' }, field(t('Project name'), name, setName, t('Project name'), false, true, 80), h('div', { className: 'bc-field' }, t('Coordinator'), h('p', null, data.employees.find(employee => employee.id === coordinatorId)?.name ?? '—'))), field(t('Goal'), goal, setGoal, t('Describe the goal'), true), field(t('Deliverable'), deliverable, setDeliverable, t('Describe the deliverable'), true), field(t('Acceptance criteria'), acceptance, setAcceptance, t('Describe how to accept the deliverable'), true),
      h('div', { className: 'bc-grid' }, h('label', { className: 'bc-field' }, t('Acceptance mode'), h('select', { value: acceptanceRequirement, onChange: event => setAcceptanceRequirement(event.target.value) }, h('option', { value: 'daily_independent_bot' }, t('Independent Bot acceptance')), h('option', { value: 'owner_only' }, t('Owner acceptance')))),
        acceptanceRequirement === 'owner_only' ? h('p', { className: 'bc-muted' }, t('The owner will accept this project.')) : h('label', { className: 'bc-field' }, t('Acceptance Bot'), h('select', { value: acceptanceActor, onChange: event => setAcceptanceActor(event.target.value) }, h('option', { value: '' }, t('Choose an acceptance Bot')), acceptanceBots.map(employee => h('option', { key: employee.id, value: employee.id }, employee.name))))),
      h('div', { className: 'bc-grid' }, h('label', { className: 'bc-field' }, t('Memory keeper'), h('select', { value: memoryEmployeeId, onChange: event => setMemoryEmployeeId(event.target.value) }, h('option', { value: '' }, t('Choose a memory keeper')), memoryKeepers.map(employee => h('option', { key: employee.id, value: employee.id }, employee.name)))), field(t('Workspace folder'), workspaceRef, setWorkspaceRef, t('Path to the project workspace'), false, true, 500)),
      !memoryKeepers.length || acceptanceRequirement !== 'owner_only' && !acceptanceBots.length ? h('p', { className: 'bc-exception', role: 'status' }, t('Add a memory keeper and an acceptance Bot in the previous step, or choose owner acceptance.')) : null,
      h('p', { className: 'bc-muted' }, t('A new project starts in setup. Group binding and launch checks are shown on its project page.')),
      h('div', { className: 'bc-actions' }, h('button', { type: 'button', className: 'bc-button', onClick: () => setStep(2) }, t('Back')), h('button', { type: 'button', className: 'bc-button bc-primary', disabled: busy || !name.trim() || !goal.trim() || !deliverable.trim() || !acceptance.trim() || !memoryEmployeeId || !workspaceRef.trim() || (acceptanceRequirement !== 'owner_only' && !acceptanceActor) || unbound.length, onClick: createProject }, busy ? t('Creating…') : preview ? t('Create sample project') : t('Create project')))) : null,
    error ? h('p', { className: 'bc-exception', role: 'alert' }, error) : null)
}
