import { createElement as h, useRef, useState } from 'react'
import { t } from './i18n.js'

// P12: the company page inside the project surface, laid out like the 01 screen of the
// virtual prototype: one page, no tabs. A header carries the company name, the counts and
// the two create actions; below it a pannable canvas holds the company node over one
// column per department, each column pairing the department card with its employees.
// A department opens its overview in place, over the canvas, instead of swapping the page.

const archived = item => item?.status === 'archived'

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
  const { data, loading, error, roster, openDept, creating, pan, dragging } = props
  const departments = (data.departments ?? []).filter(item => !archived(item))
  const employees = (data.employees ?? []).filter(item => !archived(item))
  const projects = data.projects ?? []
  const botReady = employee => botOpenable(employee, roster)
  const openEmployee = employee => { if (botReady(employee)) props.onOpenEmployee(employee) }
  const employeeTitle = employee => {
    if (!employee.bot_id) return t('This employee has no Bot yet.')
    if (!botReady(employee)) return t('This employee cannot open a private chat right now.')
    return t('Chat privately with {name}', { name: employee.name })
  }
  const department = openDept === null ? null : departments.find(item => item.id === openDept) ?? null

  const avatar = (employee, size = 'sm') => h('span', { className: `bc-co-face bc-co-face-${size}`, 'aria-hidden': true }, initialOf(employee.name))

  const employeeRow = employee => {
    const disabled = !botReady(employee)
    const detail = employee.role ? String(employee.role) : projectText(projects, employee)
    return h('button', {
      key: employee.id,
      type: 'button',
      className: 'bc-co-emp' + (disabled ? ' is-disabled' : ''),
      'aria-label': t('Employee: {name}, {detail}', { name: employee.name, detail }),
      'aria-disabled': disabled ? 'true' : undefined,
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

  const overview = department => {
    const staff = employees.filter(item => item.department_id === department.id)
    const lead = leadOf(employees, department)
    const bound = Boolean(department.chat_ref)
    // Only employees of this department can lead it, and only while they are active:
    // the server rejects anything else, so the list never offers it.
    const canLead = staff.filter(item => item.status !== 'archived')
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
      staff.length
        ? h('div', { className: 'bc-co-pop-emps' }, staff.map(employee => h('button', {
          key: employee.id,
          type: 'button',
          className: 'bc-co-row' + (botReady(employee) ? '' : ' is-disabled'),
          'aria-disabled': botReady(employee) ? undefined : 'true',
          title: employeeTitle(employee),
          onClick: () => openEmployee(employee),
        },
          avatar(employee),
          h('span', { className: 'bc-co-row-main' }, h('strong', null, employee.name), h('span', { className: 'bc-co-sub' }, employeeDetailFor(projects, employee))),
          h('span', { className: 'bc-co-row-go', 'aria-hidden': true }, '›'))))
        : h('p', { className: 'bc-co-muted' }, t('This department has no employees yet.')))
  }

  const createPanel = () => {
    if (!creating) return null
    const departmentOptions = departments.map(item => h('option', { key: item.id, value: item.id }, item.name))
    const bots = (roster?.bots ?? []).filter(bot => !employees.some(employee => employee.bot_id === bot.id && employee.status === 'active') && !bot.private)
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
        h('button', { type: 'button', className: 'bc-button bc-primary', disabled: props.draftBusy || !props.draftName.trim(), onClick: props.onCreate }, props.draftBusy ? t('Saving…') : t('Create'))))
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
    h('div', { className: 'bc-co-stage' }, body,
      department ? overview(department) : null,
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
    try { await props.onCommand('department.update', { department_id: department.id, lead_employee_id: employeeId || null }) }
    catch (failure) { setDraftError(failure?.message ?? String(failure)) }
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
    } catch (failure) { setDraftError(failure?.message ?? String(failure)) }
    finally { setDraftBusy(false) }
  }

  return CompanyPageView({
    ...props,
    openDept,
    creating,
    pan,
    dragging,
    canvasRef,
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
.bc-co-emp.is-disabled{color:var(--bt-ink-2);cursor:default}
.bc-co-emp.is-disabled:hover{background:none}
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
.bc-co-row.is-disabled{cursor:default;color:var(--bt-ink-2)}
.bc-co-row.is-disabled:hover{background:none}
.bc-co-row-main{display:flex;flex:1;flex-direction:column;gap:0;min-width:0}
.bc-co-row-main strong{font-size:12px;line-height:16px;font-weight:600}
.bc-co-row-go{font-size:13px;color:var(--bt-ink-3)}
.bc-co-create-fields{display:flex;flex-direction:column;gap:10px}
.bc-co-create-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
.bc-co-loading{display:flex;flex-direction:column;gap:8px;padding:20px 32px}
`
