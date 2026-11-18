import { createElement as h, useRef, useState } from 'react'
import { t } from './i18n.js'

// P12: the company page inside the project surface, laid out like the 01 screen of the
// virtual prototype: one page, no tabs. A header carries the company name, the counts and
// the two create actions; below it a pannable canvas holds the company node over one
// column per department, each column pairing the department card with its employees.
// A department opens its overview in place, over the canvas, instead of swapping the page.

const archived = item => item?.status === 'archived'

// The server accepts exactly these four acceptance roles. Profiles written by an older
// version can still carry `member` or `reviewer`; the edit panel must not send one back,
// or a rename or a department move would be refused with a 422 about a field the person
// never touched. An unknown value therefore reads as "keep what is there".
export const ACCEPTANCE_ROLES = ['executor', 'coordinator', 'acceptor', 'memory_keeper']
export const editedAcceptanceRole = value => (ACCEPTANCE_ROLES.includes(value) ? value : '')
// The edit panel's save payload. A role left on "keep the current role" is not sent at
// all, so an employee with an older role can still be renamed or moved between departments.
export const employeeUpdatePayload = ({ employeeId, name, departmentId, acceptanceRole }) => {
  const change = { employee_id: employeeId, name, department_id: departmentId }
  if (acceptanceRole) change.acceptance_role = acceptanceRole
  return change
}

// A refusal from the server carries a stable code. The ones a person can act on get a
// sentence in their own language; anything unknown keeps the server's own words.
export const companyErrorText = failure => {
  const known = {
    'department.name-taken': 'A department with this name already exists.',
    'employee.bot_already_employed': 'This Bot already has an employee profile.',
    'department/invalid': 'That employee cannot take this department or lead it.',
    'employee/immutable-field': 'An employee keeps its Bot; hire the other Bot instead.',
    'employee/inactive': 'This employee is dismissed. Reactivate them before using them.',
    'employee/still-referenced': 'This employee still holds work. Hand it over first.',
    'company/revision-conflict': 'The record changed while you were editing. Close it and try again.',
  }[failure?.code]
  const text = known ? t(known) : failure?.message
  return text ? String(text) : t('The change could not be saved.')
}

// The first glyph of a name, whole: a grapheme cluster, never half of a surrogate pair.
const initialOf = name => {
  const text = typeof name === 'string' ? name.trim() : ''
  if (!text) return '·'
  try {
    const step = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]().next()
    const glyph = step.done ? text.slice(0, 1) : step.value.segment
    return String(glyph || text.slice(0, 1)).toUpperCase()
  } catch { return text.slice(0, 1).toUpperCase() }
}

// The employee's second line: the role when the read model has one, otherwise the project
// in one of four states — outside any project, the project's name, an archived project's
// name, or a missing project.
const projectText = (projects, employee) => {
  if (!employee.project_id) return t('Outside projects')
  const project = projects.find(item => item.id === employee.project_id)
  if (!project) return t('Project information missing')
  if (archived(project)) return t('Project: {name} (archived)', { name: project.name })
  return t('Project: {name}', { name: project.name })
}

const companyLine = (departments, employees, projects) => t('{d} departments · {e} employees · {p} projects · {a} in progress', {
  d: departments.length,
  e: employees.length,
  p: projects.length,
  a: projects.filter(item => item.status === 'active').length,
})

// A Bot id opens a chat only once the roster resolves it. The roster is assembled
// asynchronously, so "not assembled yet" must not read as "unknown Bot": until it is
// ready the node stays openable and the first frame never flashes a disabled row.
export const botOpenable = (employee, roster) => {
  if (!employee?.bot_id) return false
  if (!roster?.ready) return true
  return Boolean(roster.byId?.[employee.bot_id] ?? roster.bots?.find(bot => bot.id === employee.bot_id))
}

const leadOf = (employees, department) => employees.find(item => item.id === department.lead_employee_id) ?? null

export function CompanyPageView(props) {
  const { data, loading, error, roster, openDept, creating, pan, dragging, leadError, editing } = props
  const departments = (data.departments ?? []).filter(item => !archived(item))
  const employees = (data.employees ?? []).filter(item => !archived(item))
  const projects = data.projects ?? []
  const botReady = employee => botOpenable(employee, roster)
  const openEmployee = employee => {
    if (botReady(employee) && employee.status === 'active') props.onOpenEmployee(employee)
    else props.onChatHint?.(employeeTitle(employee))
  }
  const employeeTitle = employee => {
    if (employee.status !== 'active') return t('This employee is dismissed. Reactivate them in the company chart first.')
    if (!employee.bot_id) return t('This employee has no Bot yet.')
    if (!botReady(employee)) return t('This employee cannot open a private chat right now.')
    return t('Chat privately with {name}', { name: employee.name })
  }
  const department = openDept === null ? null : departments.find(item => item.id === openDept) ?? null

  const avatar = (employee, size = 'sm') => h('span', { className: `bc-co-face bc-co-face-${size}`, 'aria-hidden': true }, initialOf(employee.name))

  const employeeRow = employee => {
    const chatOpen = botReady(employee) && employee.status === 'active'
    const detail = employee.role ? String(employee.role) : projectText(projects, employee)
    // An employee whose Bot is not running looks like any other row: the state is said in
    // words when it matters instead of a greyed-out control the person cannot use.
    return h('button', {
      key: employee.id,
      type: 'button',
      className: 'bc-co-emp' + (chatOpen ? '' : ' is-static'),
      'aria-label': t('Employee: {name}, {detail}', { name: employee.name, detail }),
      tabIndex: 0,
      title: employeeTitle(employee),
      onClick: event => { event.stopPropagation(); openEmployee(employee) },
    },
      avatar(employee),
      h('span', { className: 'bc-co-emp-text' },
        h('strong', null, employee.name),
        h('span', { className: 'bc-co-sub' }, detail)),
      h('span', { className: 'bc-co-emp-go', 'aria-hidden': true }, '›'))
  }

  const departmentCard = department => {
    const staff = employees.filter(item => item.department_id === department.id)
    const lead = leadOf(employees, department)
    const bound = Boolean(department.chat_ref)
    // A whole card opens the overview, as in the prototype; the name inside is the
    // keyboard and screen-reader entry, because a card cannot hold its own employees
    // as buttons and be a button itself.
    return h('div', {
      key: department.id,
      className: 'bc-co-dept' + (openDept === department.id ? ' is-open' : ''),
      onClick: () => props.onOpenDept(department.id),
    },
      h('div', { className: 'bc-co-dept-head' },
        h('button', {
          type: 'button',
          className: 'bc-co-dept-name',
          'aria-expanded': openDept === department.id ? 'true' : 'false',
          onClick: event => { event.stopPropagation(); props.onOpenDept(department.id) },
        }, department.name),
        h('span', { className: 'bc-co-tag' + (bound ? ' is-ok' : '') }, bound ? t('Group built') : t('Not built'))),
      h('p', { className: 'bc-co-dept-meta' }, lead ? t('Lead {name} · {count} people', { name: lead.name, count: staff.length }) : t('No lead yet · {count} people', { count: staff.length })),
      department.description ? h('p', { className: 'bc-co-dept-desc' }, department.description) : null,
      h('div', { className: 'bc-co-emps' },
        staff.length
          ? staff.map(employee => employeeRow(employee))
          : h('span', { className: 'bc-co-none' }, t('No employees yet'))))
  }

  const chart = !data.company ? null : h('div', {
    className: 'bc-co-canvas' + (dragging ? ' is-panning' : ''),
    role: 'group',
    'aria-label': t('Organization chart'),
    ref: props.canvasRef,
    onPointerDown: props.onPanStart,
    onPointerMove: props.onPanMove,
    onPointerUp: props.onPanEnd,
    onPointerCancel: props.onPanEnd,
  },
    h('div', { className: 'bc-co-band', style: { transform: `translate(${pan.x}px, ${pan.y}px)` } },
      h('div', { className: 'bc-co-co' },
        h('div', { className: 'bc-co-co-card' },
          h('strong', null, data.company.name),
          h('span', { className: 'bc-co-sub' }, companyLine(departments, employees, projects))),
        props.onOpenProjects
          ? h('button', { type: 'button', className: 'bc-co-co-link', onClick: props.onOpenProjects }, `${t('View projects')} ›`)
          : null),
      h('div', { className: 'bc-co-cols' }, departments.map(departmentCard))),
    h('p', { className: 'bc-co-hint', role: 'note' }, t('Drag empty space to pan · Click a department for its overview')))

  const employeeDetailFor = (projects, employee) => employee.role ? String(employee.role) : projectText(projects, employee)

  // A refusal to dismiss names every live place that still holds the employee. Each line
  // leads where the hand-over happens: the department overview, or the project detail.
  const roleText = value => ({
    lead: t('Department lead'),
    coordinator: t('Coordinator'),
    acceptor: t('Independent acceptor'),
    'memory keeper': t('Memory keeper'),
    executor: t('Member'),
    member: t('Member'),
  })[value] ?? value
  // Each place a dismissed employee still holds gets its own line, because the place to
  // hand it over differs by role: a lead moves in the department overview, a coordinator
  // or a member in the project's member area, an acceptor or a memory keeper in its editor.
  const roleAction = value => ({
    coordinator: t('Change in the member area'),
    acceptor: t('Change in the project editor'),
    'memory keeper': t('Change in the project editor'),
    member: t('Remove in the member area'),
  })[value] ?? t('Open project')
  const referencedList = failure => {
    const details = failure?.details ?? {}
    const departments = details.departments ?? []
    const projects = details.projects ?? []
    const rows = []
    departments.forEach(item => rows.push(h('div', { key: `d-${item.department_id}`, className: 'bc-co-ref' },
      h('span', { className: 'bc-co-ref-name' }, `${item.name} · ${t('Department lead')}`),
      h('button', { type: 'button', className: 'bc-co-ref-go', onClick: () => props.onOpenDepartmentRef(item.department_id) }, `${t('Open department settings')} ›`))))
    projects.forEach(item => {
      const roles = (item.roles ?? []).length > 0 ? item.roles : ['member']
      roles.forEach(role => rows.push(h('div', { key: `p-${item.project_id}-${role}`, className: 'bc-co-ref' },
        h('span', { className: 'bc-co-ref-name' }, `${item.name} · ${roleText(role)}`),
        h('button', { type: 'button', className: 'bc-co-ref-go', onClick: () => props.onOpenProjectRef(item.project_id) }, `${roleAction(role)} ›`))))
    })
    return h('div', { className: 'bc-co-refs', role: 'alert' },
      h('strong', null, t('Hand the work over before dismissing:')),
      rows)
  }

  const overview = department => {
    const staff = employees.filter(item => item.department_id === department.id)
    const lead = leadOf(employees, department)
    const bound = Boolean(department.chat_ref)
    // Only employees of this department can lead it, and only while they are active:
    // the server rejects anything else, so the list never offers it.
    const canLead = staff.filter(item => item.status === 'active')
    return h('aside', {
      className: 'bc-co-pop',
      role: 'dialog',
      'aria-label': t('Department overview: {name}', { name: department.name }),
      onClick: event => event.stopPropagation(),
    },
      h('div', { className: 'bc-co-pop-head' },
        h('strong', null, t('Department overview')),
        h('span', { className: 'bc-co-pop-name' }, department.name),
        h('button', { type: 'button', className: 'bc-co-pop-close', 'aria-label': t('Close'), onClick: props.onCloseDept }, '×')),
      h('dl', { className: 'bc-co-kv' },
        h('dt', null, t('Lead')),
        h('dd', null, props.canEdit
          ? h('select', {
            value: department.lead_employee_id ?? '',
            'aria-label': t('Lead of {name}', { name: department.name }),
            onChange: event => props.onSetLead(department, event.target.value),
          }, h('option', { value: '' }, t('No lead assigned')), canLead.map(item => h('option', { key: item.id, value: item.id }, item.name)))
          : lead?.name ?? t('No lead assigned')),
        h('dt', null, t('Members')),
        h('dd', null, t('{count} people', { count: staff.length })),
        h('dt', null, t('Department group')),
        h('dd', { className: bound ? undefined : 'bc-co-muted' }, bound ? t('Department group bound') : t('Department group not bound'))),
      leadError ? h('p', { className: 'bc-exception', role: 'alert' }, leadError) : null,
      staff.length
        ? h('div', { className: 'bc-co-pop-emps' }, staff.map(employee => h('div', { key: employee.id, className: 'bc-co-row-wrap' },
          h('button', {
            type: 'button',
            className: 'bc-co-row' + (botReady(employee) && employee.status === 'active' ? '' : ' is-static'),
            title: employeeTitle(employee),
            onClick: () => openEmployee(employee),
          },
            avatar(employee),
            h('span', { className: 'bc-co-row-main' },
              h('strong', null, employee.name),
              h('span', { className: 'bc-co-sub' }, employeeDetailFor(projects, employee),
                h('span', { className: 'bc-co-tag' }, employee.status === 'disabled' ? t('Dismissed employee') : t('On duty')))),
            h('span', { className: 'bc-co-row-go', 'aria-hidden': true }, '›')),
          props.canEdit
            ? h('button', {
              type: 'button',
              className: 'bc-co-row-edit',
              'aria-label': t('Edit {name}', { name: employee.name }),
              title: t('Edit employee'),
              onClick: event => { event.stopPropagation(); props.onEditOpen(employee) },
            }, '✎')
            : null)))
        : h('p', { className: 'bc-co-muted' }, t('This department has no employees yet.')))
  }

  const createPanel = () => {
    if (!creating) return null
    const departmentOptions = departments.map(item => h('option', { key: item.id, value: item.id }, item.name))
    const bots = (roster?.bots ?? []).filter(bot => !employees.some(employee => employee.bot_id === bot.id) && !bot.private)
    return h('div', { className: 'bc-co-create', role: 'dialog', 'aria-label': creating === 'department' ? t('New department') : t('New employee') },
      h('div', { className: 'bc-co-pop-head' },
        h('strong', null, creating === 'department' ? t('New department') : t('New employee')),
        h('button', { type: 'button', className: 'bc-co-pop-close', 'aria-label': t('Close'), onClick: props.onCloseCreate }, '×')),
      creating === 'department'
        ? h('label', { className: 'bc-field' }, t('Department name'),
          h('input', { value: props.draftName, maxLength: 80, onChange: event => props.onDraftName(event.target.value), placeholder: t('Department name') }))
        : h('div', { className: 'bc-co-create-fields' },
          h('label', { className: 'bc-field' }, t('Bot'),
            h('select', { value: props.draftBot, onChange: event => props.onDraftBot(event.target.value) },
              h('option', { value: '' }, t('Choose a Bot')),
              bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
          h('label', { className: 'bc-field' }, t('Department'),
            h('select', { value: props.draftDept, onChange: event => props.onDraftDept(event.target.value) },
              h('option', { value: '' }, t('Choose a department')),
              departmentOptions)),
          h('label', { className: 'bc-field' }, t('Employee display name (optional)'),
            h('input', { value: props.draftName, maxLength: 80, onChange: event => props.onDraftName(event.target.value), placeholder: t('Use Bot name') })),
          h('label', { className: 'bc-field' }, t('Employee role'),
            h('select', { value: props.draftRole, onChange: event => props.onDraftRole(event.target.value) },
              h('option', { value: 'executor' }, t('Executor')),
              h('option', { value: 'coordinator' }, t('Coordinator')),
              h('option', { value: 'acceptor' }, t('Independent acceptor')),
              h('option', { value: 'memory_keeper' }, t('Memory keeper'))))),
      props.draftError ? h('p', { className: 'bc-exception', role: 'alert' }, props.draftError) : null,
      h('div', { className: 'bc-co-create-actions' },
        h('button', { type: 'button', className: 'bc-button', onClick: props.onCloseCreate }, t('Cancel')),
        h('button', { type: 'button', className: 'bc-button bc-primary', disabled: props.draftBusy || (creating === 'department' ? !props.draftName.trim() : (!props.draftBot || !props.draftDept)), onClick: props.onCreate }, props.draftBusy ? t('Saving…') : t('Create'))))
  }

  const editingEmployee = editing === null ? null : employees.find(item => item.id === editing) ?? null
  const editPanel = () => {
    if (!editingEmployee) return null
    const roles = [['executor', t('Executor')], ['coordinator', t('Coordinator')], ['acceptor', t('Independent acceptor')], ['memory_keeper', t('Memory keeper')]]
    // A profile from an older version holds a role outside the four. Show that honestly as
    // "keep the current role" instead of a wrong first option that state never agrees with.
    const roleOptions = props.editRole ? roles : [['', t('Keep the current role')], ...roles]
    return h('div', { className: 'bc-co-create bc-co-edit', role: 'dialog', 'aria-label': t('Edit employee') },
      h('div', { className: 'bc-co-pop-head' },
        h('strong', null, t('Edit employee')),
        h('span', { className: 'bc-co-pop-name' }, editingEmployee.name),
        h('button', { type: 'button', className: 'bc-co-pop-close', 'aria-label': t('Close'), onClick: props.onEditClose }, '×')),
      h('div', { className: 'bc-co-create-fields' },
        h('label', { className: 'bc-field' }, t('Employee display name'),
          h('input', { value: props.editName, maxLength: 80, onChange: event => props.onEditName(event.target.value), placeholder: t('Employee display name') })),
        h('label', { className: 'bc-field' }, t('Employee role'),
          h('select', { value: props.editRole, onChange: event => props.onEditRole(event.target.value) }, roleOptions.map(([value, label]) => h('option', { key: value || 'keep', value }, label)))),
        h('label', { className: 'bc-field' }, t('Department'),
          h('select', { value: props.editDept, onChange: event => props.onEditDept(event.target.value) }, departments.map(item => h('option', { key: item.id, value: item.id }, item.name))))),
      props.editError ? h('p', { className: 'bc-exception', role: 'alert' }, props.editError) : null,
      props.editRefusal ? referencedList(props.editRefusal) : null,
      h('p', { className: 'bc-co-note' }, editingEmployee.status === 'disabled'
        ? t('Dismissed employees keep their profile and history and can be reactivated at any time.')
        : t('Dismissing keeps the profile and history, and can be undone at any time.')),
      h('div', { className: 'bc-co-create-actions' },
        props.onStatus
          ? h('button', { type: 'button', className: 'bc-button bc-danger', disabled: props.editBusy, onClick: () => props.onStatus(editingEmployee) },
            editingEmployee.status === 'disabled' ? t('Reactivate employee') : t('Suspend employee'))
          : null,
        h('span', { className: 'bc-co-spacer' }),
        h('button', { type: 'button', className: 'bc-button', onClick: props.onEditClose }, t('Cancel')),
        h('button', { type: 'button', className: 'bc-button bc-primary', disabled: props.editBusy || !props.editName.trim(), onClick: props.onEditSave }, props.editBusy ? t('Saving…') : t('Save'))))
  }

  let body
  if (error) {
    body = h('div', { className: 'bc-state bc-error', role: 'alert' },
      h('strong', null, t('Company information could not be loaded.')),
      h('p', null, error),
      h('button', { type: 'button', className: 'bc-button', onClick: props.onRetry }, t('Try again')))
  } else if (loading) {
    body = h('div', { className: 'bc-co-loading', role: 'status', 'aria-label': t('Loading company information…') },
      [0, 1, 2].map(index => h('span', { key: index, className: 'bc-skel bc-skel-line' + (index === 2 ? ' short' : '') })))
  } else if (data.company === null) {
    body = h('div', { className: 'bc-state bc-co-state' },
      h('strong', null, t('No company information yet')),
      h('p', null, t('Create the company before adding departments.')))
  } else {
    body = chart
  }

  return h('section', { className: 'bc-co-page', 'aria-label': t('Company') },
    data.company ? h('div', { className: 'bc-co-head' },
      h('div', { className: 'bc-co-grow' },
        h('h1', null, t('Company')),
        h('p', null, companyLine(departments, employees, projects))),
      props.canCreate ? h('div', { className: 'bc-co-actions' },
        h('button', { type: 'button', className: 'bc-button', onClick: () => props.onCreateOpen('department') }, `＋ ${t('New department')}`),
        h('button', { type: 'button', className: 'bc-button', onClick: () => props.onCreateOpen('employee') }, `＋ ${t('New employee')}`)) : null) : null,
    props.chatHint ? h('div', { className: 'bc-co-hintbar', role: 'status' },
      h('span', null, props.chatHint),
      h('button', { type: 'button', className: 'bc-co-hintbar-close', 'aria-label': t('Close'), onClick: () => props.onChatHint?.('') }, '×')) : null,
    h('div', { className: 'bc-co-stage' }, body,
      editingEmployee ? editPanel() : department ? overview(department) : null,
      createPanel()))
}

export function CompanyPage(props) {
  const { escapeGuard } = props
  const [openDept, setOpenDept] = useState(null)
  const [creating, setCreating] = useState(null)
  const [draftName, setDraftName] = useState('')
  const [draftBot, setDraftBot] = useState('')
  const [draftDept, setDraftDept] = useState('')
  const [draftRole, setDraftRole] = useState('executor')
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftError, setDraftError] = useState('')
  const [leadError, setLeadError] = useState('')
  const [chatHint, setChatHint] = useState('')
  const [editing, setEditing] = useState(null)
  const [editName, setEditName] = useState('')
  const [editRole, setEditRole] = useState('executor')
  const [editDept, setEditDept] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [editRefusal, setEditRefusal] = useState(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const canvasRef = useRef(null)
  const drag = useRef(null)

  const closeDraft = () => { setCreating(null); setDraftError(''); setDraftName(''); setDraftBot(''); setDraftDept('') }
  const openCreate = kind => { closeDraft(); setCreating(kind) }
  // The surface owns Escape for the whole panel; the overview and the create panel take
  // one level each so the first Escape closes them instead of the page.
  if (escapeGuard) {
    escapeGuard.current = () => {
      if (editing !== null) { closeEdit(); return true }
      if (creating) { closeDraft(); return true }
      if (openDept !== null) { setOpenDept(null); return true }
      return false
    }
  }

  // Panning only starts on the canvas itself: a press that lands on a card, a button or
  // the overview keeps its own meaning.
  const onPanStart = event => {
    if (event.button !== 0) return
    const target = event.target
    if (target instanceof Element && target.closest('button, input, select, a, .bc-co-pop, .bc-co-create, .bc-co-dept')) return
    drag.current = { x: event.clientX, y: event.clientY, pan }
    setDragging(true)
    // A pointer that is already gone (a very fast click, a cancelled touch) cannot be
    // captured; the drag still ends in the pointerup handler, so this is not an error.
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* no active pointer */ }
  }
  const onPanMove = event => {
    if (!drag.current) return
    setPan({ x: drag.current.pan.x + (event.clientX - drag.current.x), y: drag.current.pan.y + (event.clientY - drag.current.y) })
  }
  const onPanEnd = () => { drag.current = null; setDragging(false) }

  const setLead = async (department, employeeId) => {
    if (!props.onCommand) return
    setLeadError('')
    try { await props.onCommand('department.update', { department_id: department.id, lead_employee_id: employeeId || null }) }
    catch (failure) { setLeadError(companyErrorText(failure)) }
  }

  const create = async () => {
    if (!props.onCommand || draftBusy) return
    setDraftBusy(true)
    setDraftError('')
    try {
      if (creating === 'department') {
        await props.onCommand('department.create', { name: draftName.trim() })
      } else {
        const bot = props.roster?.byId?.[draftBot]
        await props.onCommand('employee.create', {
          bot_id: draftBot,
          name: draftName.trim() || bot?.name || draftBot,
          department_id: draftDept,
          acceptance_role: draftRole,
        })
      }
      closeDraft()
    } catch (failure) { setDraftError(companyErrorText(failure)) }
    finally { setDraftBusy(false) }
  }

  const openEdit = employee => {
    closeDraft()
    setEditing(employee.id)
    setEditName(employee.name ?? '')
    setEditRole(editedAcceptanceRole(employee.acceptance_role))
    setEditDept(employee.department_id ?? '')
    setEditError('')
    setEditRefusal(null)
  }
  const closeEdit = () => { setEditing(null); setEditError(''); setEditRefusal(null) }
  const saveEdit = async () => {
    if (!props.onCommand || editBusy) return
    setEditBusy(true)
    setEditError('')
    setEditRefusal(null)
    try {
      await props.onCommand('employee.update', employeeUpdatePayload({
        employeeId: editing,
        name: editName.trim(),
        departmentId: editDept,
        acceptanceRole: editRole,
      }))
      closeEdit()
    } catch (failure) { setEditError(companyErrorText(failure)) }
    finally { setEditBusy(false) }
  }
  // Dismissing or reactivating never deletes anything: the server keeps the profile and
  // its history, and refuses a dismissal that would orphan live work.
  const setStatus = async employee => {
    if (!props.onCommand || editBusy) return
    setEditBusy(true)
    setEditError('')
    setEditRefusal(null)
    try {
      await props.onCommand('employee.update', {
        employee_id: employee.id,
        status: employee.status === 'disabled' ? 'active' : 'disabled',
      })
      closeEdit()
    } catch (failure) {
      setEditError(companyErrorText(failure))
      if (failure?.code === 'employee/still-referenced') setEditRefusal(failure)
    } finally { setEditBusy(false) }
  }

  return CompanyPageView({
    ...props,
    openDept,
    creating,
    pan,
    dragging,
    canvasRef,
    leadError,
    chatHint,
    editing,
    editName,
    editRole,
    editDept,
    editBusy,
    editError,
    editRefusal,
    onEditOpen: openEdit,
    onEditClose: closeEdit,
    onEditName: setEditName,
    onEditRole: setEditRole,
    onEditDept: setEditDept,
    onEditSave: () => void saveEdit(),
    onStatus: employee => void setStatus(employee),
    onOpenDepartmentRef: id => { closeEdit(); setOpenDept(id) },
    onOpenProjectRef: id => props.onOpenProject?.(id),
    onChatHint: setChatHint,
    draftName,
    draftBot,
    draftDept,
    draftRole,
    draftBusy,
    draftError,
    canCreate: Boolean(props.onCommand),
    canEdit: Boolean(props.onCommand),
    onOpenDept: setOpenDept,
    onCloseDept: () => setOpenDept(null),
    onCreateOpen: openCreate,
    onCloseCreate: closeDraft,
    onDraftName: setDraftName,
    onDraftBot: setDraftBot,
    onDraftDept: setDraftDept,
    onDraftRole: setDraftRole,
    onCreate: () => void create(),
    onSetLead: (department, employeeId) => void setLead(department, employeeId),
    onPanStart,
    onPanMove,
    onPanEnd,
  })
}

export const COMPANY_PAGE_CSS = `
.bc-surface-company{overflow:hidden}
.bc-surface-company .bc-shell{height:100vh}
.bc-surface-company .bc-content{display:flex;flex:1;min-height:0;width:100%;max-width:none;padding:0}
.bc-surface-company .bc-co-page{flex:1;min-height:0}
.bc-co-page{display:flex;flex-direction:column;min-height:0;height:100%}
.bc-co-head{flex:none;display:flex;align-items:flex-end;gap:16px;padding:18px 32px 14px;border-bottom:1px solid var(--bt-line)}
.bc-co-grow{flex:1;min-width:0}
.bc-co-head h1{margin:0;font:600 17px/24px var(--bt-font);color:var(--bt-ink)}
.bc-co-head p{margin:3px 0 0;font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.bc-co-actions{display:flex;gap:8px;flex:none}
.bc-co-stage{position:relative;flex:1;min-height:0}
.bc-co-canvas{position:relative;height:100%;min-height:420px;overflow:hidden;cursor:grab;background-image:radial-gradient(circle,var(--bt-line-2) 1px,transparent 1px);background-size:26px 26px;overscroll-behavior:contain}
.bc-co-canvas.is-panning{cursor:grabbing}
.bc-co-band{position:absolute;left:0;top:0;width:100%;padding:26px 28px 72px;transform-origin:0 0;transition:transform .18s ease}
.bc-co-canvas.is-panning .bc-co-band{transition:none}
.bc-co-co{display:flex;flex-direction:column;align-items:center;gap:4px}
.bc-co-co-card{display:flex;flex-direction:column;align-items:center;gap:2px;min-width:230px;padding:10px 16px;border:1px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);box-shadow:var(--bc-shadow-raised)}
.bc-co-co-card strong{font:600 14px/20px var(--bt-font);color:var(--bt-ink)}
.bc-co-co-link{align-self:center;border:0;background:none;padding:2px 6px;min-height:24px;font:600 12px var(--bt-font);color:var(--bt-ink-2);cursor:pointer;border-radius:6px}
.bc-co-co-link:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bc-co-cols{position:relative;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:20px;margin-top:30px;padding-top:20px;border-top:1px solid var(--bt-line)}
/* The tree: one stem from the company card down to the bus, then a short drop
   into every department card. Decoration only, so it stays behind the cards. */
.bc-co-cols::before{content:"";position:absolute;left:50%;top:-30px;width:1px;height:30px;background:var(--bt-line);pointer-events:none}
.bc-co-cols::after{content:"";position:absolute;left:50%;top:-3px;width:5px;height:5px;border-radius:50%;border:1px solid var(--bt-line-2);background:var(--bt-card);transform:translateX(-50%);pointer-events:none}
.bc-co-dept::before{content:"";position:absolute;left:50%;top:-20px;width:1px;height:20px;background:var(--bt-line);pointer-events:none}
@media (max-width:1180px){.bc-co-cols{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:860px){.bc-co-cols{grid-template-columns:repeat(2,minmax(0,1fr))}}
.bc-co-dept{position:relative;display:flex;flex-direction:column;padding:11px 13px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card);cursor:pointer;transition:border-color .12s ease,box-shadow .12s ease}
.bc-co-dept:hover{border-color:color-mix(in srgb,var(--bt-ink) 30%,transparent)}
.bc-co-dept.is-open{border-color:var(--bt-accent);box-shadow:0 0 0 1px var(--bt-accent)}
.bc-co-dept-head{display:flex;align-items:center;gap:6px;min-width:0}
.bc-co-dept-name{flex:1;min-width:0;border:0;background:none;padding:0;font:600 13px/18px var(--bt-font);color:var(--bt-ink);text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-co-dept-name:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:4px}
.bc-co-tag{flex:none;padding:1px 6px;border-radius:4px;border:1px solid var(--bt-line-2);font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bc-co-tag.is-ok{border-color:color-mix(in srgb,var(--bt-accent) 45%,transparent);color:var(--bt-accent)}
.bc-co-dept-meta{margin:4px 0 0;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bc-co-dept-desc{margin:4px 0 0;font-size:12px;line-height:17px;color:var(--bt-ink-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bc-co-emps{display:flex;flex-direction:column;gap:1px;margin-top:8px;padding-left:12px;border-left:1px solid var(--bt-line)}
.bc-co-emp{display:flex;align-items:center;gap:9px;width:100%;padding:5px 6px;border:0;border-radius:8px;background:none;font:inherit;color:var(--bt-ink);text-align:left;cursor:pointer}
.bc-co-emp:hover{background:var(--bt-hover)}
.bc-co-emp:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bc-co-emp.is-static{cursor:default}
.bc-co-emp.is-static:hover{background:none}
.bc-co-face{flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;background:var(--bt-main);border:1px solid var(--bt-line-2);color:var(--bt-ink-2);font:600 10px/1 var(--bt-font)}
.bc-co-face-sm{width:22px;height:22px}
.bc-co-emp-text{display:flex;flex:1;flex-direction:column;gap:0;min-width:0}
.bc-co-emp-text strong{font-size:12px;line-height:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-co-emp-go{flex:none;font-size:13px;color:var(--bt-ink-3);opacity:0;transition:opacity .12s ease}
.bc-co-emp:hover .bc-co-emp-go,.bc-co-emp:focus-visible .bc-co-emp-go{opacity:1}
.bc-co-sub{font-size:11px;line-height:15px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-co-none{display:block;padding:4px 2px;font-size:11px;line-height:15px;color:var(--bt-ink-3)}
.bc-co-hint{position:absolute;left:22px;bottom:16px;margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bc-co-pop,.bc-co-create{position:absolute;top:26px;right:32px;z-index:5;width:300px;max-height:calc(100% - 72px);overflow:auto;padding:14px;border:1px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);box-shadow:0 12px 32px -8px color-mix(in srgb,var(--bt-ink) 22%,transparent);animation:bc-co-pop-in .12s ease-out}
@keyframes bc-co-pop-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.bc-co-pop,.bc-co-create{animation:none}}
.bc-co-pop-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.bc-co-pop-head strong{font:600 13px/18px var(--bt-font)}
.bc-co-pop-name{flex:1;min-width:0;font-size:12px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-co-pop-close{flex:none;width:26px;height:26px;border:0;border-radius:8px;background:none;color:var(--bt-ink-2);font-size:18px;line-height:1;cursor:pointer}
.bc-co-pop-close:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bc-co-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;margin:0 0 10px;font-size:12px;line-height:17px}
.bc-co-kv dt{color:var(--bt-ink-2)}
.bc-co-kv dd{margin:0;color:var(--bt-ink);min-width:0}
.bc-co-kv select{width:100%;min-height:28px;border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;padding:0 6px}
.bc-co-muted{margin:0;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bc-co-pop-emps{display:flex;flex-direction:column;border-top:1px solid var(--bt-line);padding-top:8px}
.bc-co-row{display:flex;align-items:center;gap:9px;width:100%;padding:7px 6px;border:0;border-radius:8px;background:none;font:inherit;color:var(--bt-ink);text-align:left;cursor:pointer}
.bc-co-row:hover{background:var(--bt-hover)}
.bc-co-row:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bc-co-row.is-static{cursor:default}
.bc-co-row.is-static:hover{background:none}
.bc-co-row-main{display:flex;flex:1;flex-direction:column;gap:0;min-width:0}
.bc-co-row-main strong{font-size:12px;line-height:16px;font-weight:600}
.bc-co-row-go{font-size:13px;color:var(--bt-ink-3)}
.bc-co-tag{margin-left:8px;padding:0 6px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:10px;line-height:16px}
.bc-co-note{margin:10px 0 0;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bc-co-refs{display:flex;flex-direction:column;gap:6px;margin-top:10px;padding:10px 12px;border:1px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card)}
.bc-co-refs strong{font-size:12px;line-height:17px;font-weight:600}
.bc-co-ref{display:flex;align-items:center;gap:8px;min-width:0}
.bc-co-ref-name{flex:1;min-width:0;font-size:12px;line-height:17px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bc-co-ref-go{flex:none;border:0;border-radius:6px;background:none;padding:2px 4px;font:600 12px var(--bt-font);color:var(--bt-accent);cursor:pointer}
.bc-co-ref-go:hover{background:var(--bt-hover)}
.bc-co-ref-go:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bc-co-hintbar{display:flex;align-items:center;gap:10px;margin:0 22px 10px;padding:8px 12px;border:1px solid var(--bt-line-2);border-radius:10px;background:var(--bt-card);font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bc-co-hintbar span{flex:1;min-width:0}
.bc-co-hintbar-close{flex:none;border:0;background:none;padding:0 4px;font-size:14px;line-height:16px;color:var(--bt-ink-3);cursor:pointer}
.bc-co-hintbar-close:hover{color:var(--bt-ink)}
.bc-co-create-fields{display:flex;flex-direction:column;gap:10px}
.bc-co-create-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:12px}
.bc-co-spacer{flex:1}
.bc-co-row-wrap{display:flex;align-items:center;gap:2px}
.bc-co-row-wrap .bc-co-row{flex:1;min-width:0}
.bc-co-row-edit{flex:none;width:26px;height:26px;border:0;border-radius:8px;background:none;color:var(--bt-ink-3);font-size:13px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s ease}
.bc-co-row-wrap:hover .bc-co-row-edit,.bc-co-row-edit:focus-visible{opacity:1}
.bc-co-row-edit:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bc-co-row-edit:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
@media (hover:none){.bc-co-row-edit{opacity:1}}
.bc-co-loading{display:flex;flex-direction:column;gap:8px;padding:20px 32px}
`
