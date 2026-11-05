import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'

// P12: the company page inside the project surface. Two tabs (overview, organization)
// share the single `company-model` read the surface already makes, so switching tabs
// never re-reads. A department opens inside the chart tab as a second layer instead of
// a new route, and an employee node leaves the panel for that Bot's private chat.
// Everything here is read-only: no create, bind, assign or start action exists yet.

const archived = item => item?.status === 'archived'

// The employee's second line: the role only when the read model has one, then the
// project in one of four states — outside any project, the project's name, an archived
// project's name, or a missing project. The same function feeds the chart node and the
// department page row so both always read one rule.
const projectText = (projects, employee) => {
  if (!employee.project_id) return t('Outside projects')
  const project = projects.find(item => item.id === employee.project_id)
  if (!project) return t('Project information missing')
  if (archived(project)) return t('Project: {name} (archived)', { name: project.name })
  return t('Project: {name}', { name: project.name })
}
const employeeDetail = (projects, employee) => [employee.role ? String(employee.role) : '', projectText(projects, employee)].filter(Boolean).join(' · ')

const departmentLine = (staff, department) => `${t('{count} people', { count: staff.length })} · ${department.chat_ref ? t('Department group bound') : t('Department group not bound')}`
const companyLine = (departments, employees, projects) => t('{d} departments · {e} employees · {p} active projects', {
  d: departments.length,
  e: employees.length,
  p: projects.filter(item => item.status === 'active').length,
})

// A Bot id opens a chat only once the roster resolves it. The roster is assembled
// asynchronously, so "not assembled yet" must not read as "unknown Bot": until it is
// ready the node stays openable and the first frame never flashes a disabled row.
export const botOpenable = (employee, roster) => {
  if (!employee?.bot_id) return false
  if (!roster?.ready) return true
  return Boolean(roster.byId?.[employee.bot_id] ?? roster.bots?.find(bot => bot.id === employee.bot_id))
}

export function CompanyPageView(props) {
  const { data, loading, error, todos, todoLoading, todoError, tab, deptId, chain, overflow, wrapRef, tabRefs, deptButtons, backRef } = props
  const departments = (data.departments ?? []).filter(item => !archived(item))
  const employees = (data.employees ?? []).filter(item => !archived(item))
  const projects = data.projects ?? []
  const outside = employees.filter(item => !item.project_id)
  // A failed read is not a zero: the card shows a dash and its own retry, and stale
  // numbers from an earlier read must not be mistaken for the current count.
  const waiting = !todoError && Number.isInteger(todos?.counts?.waiting_total) ? todos.counts.waiting_total : null
  const department = deptId === null ? null : departments.find(item => item.id === deptId) ?? null
  const dim = chain !== null && chain !== 'co'
  const lit = nodeDepartment => chain === null || chain === 'co' || chain === nodeDepartment
  // A bound Bot the roster cannot resolve cannot open a chat either, so both cases take
  // the same disabled shape; only the title tells the user which one it is.
  const botReady = employee => botOpenable(employee, props.roster)
  const openEmployee = employee => { if (botReady(employee)) props.onOpenEmployee(employee) }
  const employeeTitle = employee => {
    if (!employee.bot_id) return t('This employee has no Bot yet.')
    if (!botReady(employee)) return t('This employee cannot open a private chat right now.')
    return t('Chat privately with {name}', { name: employee.name })
  }

  const tabButton = (value, label) => h('button', {
    key: value,
    type: 'button',
    role: 'tab',
    id: `bc-co-tab-${value}`,
    'aria-selected': tab === value ? 'true' : 'false',
    'aria-controls': `bc-co-panel-${value}`,
    tabIndex: 0,
    className: 'bc-co-tab' + (tab === value ? ' is-active' : ''),
    ref: element => { if (element) tabRefs.current.set(value, element) },
    onClick: () => props.onSelectTab(value),
  }, label)
  const onTabKey = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const next = tab === 'overview' ? 'org' : 'overview'
    props.onSelectTab(next)
    tabRefs.current.get(next)?.focus?.()
  }
  const tabs = h('div', { className: 'bc-co-tabs', role: 'tablist', 'aria-label': t('Company sections'), onKeyDown: onTabKey },
    [tabButton('overview', t('Overview')), tabButton('org', t('Organization'))])

  const statCard = (label, value, sub, options = {}) => h('div', {
    key: label,
    className: 'bc-co-stat' + (options.strong ? ' is-strong' : ''),
    tabIndex: 0,
    role: 'group',
    'aria-label': `${label} ${value}${sub ? `，${sub}` : ''}${options.retry ? `，${t('Could not read. Click to try again.')}` : ''}`,
  },
    h('span', { className: 'bc-co-stat-label' }, label),
    h('span', { className: 'bc-co-stat-value' }, value),
    options.retry
      ? h('button', { type: 'button', className: 'bc-co-stat-retry', onClick: options.retry }, t('Could not read. Click to try again.'))
      : sub ? h('span', { className: 'bc-co-stat-sub' }, sub) : null)

  const overview = h('div', { className: 'bc-co-overview', role: 'tabpanel', id: 'bc-co-panel-overview', 'aria-labelledby': 'bc-co-tab-overview' },
    h('div', { className: 'bc-co-stats' },
      // The decision count reads its own route: a failure here dims this card only and
      // never replaces the whole page with an error.
      statCard(t('Waiting for you'), waiting === null ? '—' : String(waiting), waiting > 0 ? t('Includes approvals and acceptances') : null, {
        strong: waiting > 0,
        retry: todoError ? props.onRetryTodos : null,
      }),
      statCard(t('Projects in progress'), String(projects.filter(item => item.status === 'active').length)),
      statCard(t('Departments'), String(departments.length)),
      statCard(t('Employees'), String(employees.length), t('{count} outside projects', { count: outside.length }))),
    todoLoading && !todos && !todoError
      ? h('p', { className: 'bc-co-hint', role: 'status' }, t('Reading the decision count…'))
      : null)

  const employeeButton = (employee, staff) => {
    const disabled = !botReady(employee)
    const detail = employeeDetail(projects, employee)
    return h('button', {
      key: employee.id,
      type: 'button',
      className: 'bc-co-node bc-co-emp' + (lit(staff.id) ? ' is-lit' : '') + (disabled ? ' is-disabled' : ''),
      'aria-label': t('Employee: {name}, {detail}', { name: employee.name, detail }),
      'aria-disabled': disabled ? 'true' : undefined,
      // A native `disabled` button cannot take focus, and every node has to stay in the
      // Tab order; `aria-disabled` keeps it focusable while blocking the action.
      tabIndex: 0,
      title: employeeTitle(employee),
      onMouseEnter: () => props.onChain(staff.id),
      onMouseLeave: () => props.onChain(null),
      onFocus: () => props.onChain(staff.id),
      onBlur: () => props.onChain(null),
      onClick: () => openEmployee(employee),
    },
      h('span', { className: 'bc-co-node-text' },
        h('strong', null, employee.name),
        h('span', { className: 'bc-co-sub' }, detail)))
  }

  const departmentButton = (department, staff) => h('button', {
    key: department.id,
    type: 'button',
    className: 'bc-co-node bc-co-dept' + (lit(department.id) ? ' is-lit' : ''),
    'aria-label': t('Department: {name}, {count} people', { name: department.name, count: staff.length }),
    tabIndex: 0,
    ref: element => { if (element) deptButtons.current.set(department.id, element) },
    onMouseEnter: () => props.onChain(department.id),
    onMouseLeave: () => props.onChain(null),
    onFocus: () => props.onChain(department.id),
    onBlur: () => props.onChain(null),
    onClick: () => props.onShowDept(department.id),
  },
    h('span', { className: 'bc-co-node-text' },
      h('strong', null, department.name),
      h('span', { className: 'bc-co-sub' }, departmentLine(staff, department))))

  const chart = !data.company ? null : h('div', { className: 'bc-co-wrap', ref: wrapRef },
    h('div', { className: 'bc-co' + (dim ? ' is-dim' : ''), role: 'group', 'aria-label': t('Organization chart') },
      // The company node is the root of the chart, not an action: it labels the
      // structure, stays lit at all times and never takes focus or a click.
      h('div', { className: 'bc-co-node bc-co-company is-lit' },
        h('span', { className: 'bc-co-node-text' },
          h('strong', null, data.company.name),
          h('span', { className: 'bc-co-sub' }, companyLine(departments, employees, projects)))),
      h('div', { className: 'bc-co-branches' },
        departments.map(department => {
          const staff = employees.filter(item => item.department_id === department.id)
          return h('div', { className: 'bc-co-branch', key: department.id },
            departmentButton(department, staff),
            h('div', { className: 'bc-co-emps' },
              staff.length
                ? staff.map(employee => employeeButton(employee, department))
                : h('span', { className: 'bc-co-none' }, t('No employees yet'))))
        }))),
    overflow ? h('p', { className: 'bc-co-hint', role: 'note' }, t('Scroll sideways on a narrow screen to see the whole structure.')) : null)

  const organization = h('div', { className: 'bc-co-org', role: 'tabpanel', id: 'bc-co-panel-org', 'aria-labelledby': 'bc-co-tab-org' },
    departments.length
      ? chart
      : h('div', { className: 'bc-state bc-co-state' },
        h('strong', null, t('No departments yet')),
        h('p', null, t('Employees get a department once departments exist.'))))

  const departmentPage = department => {
    if (!department) {
      return h('div', { className: 'bc-state bc-co-state' },
        h('strong', null, t('This department no longer exists.')),
        h('button', { type: 'button', className: 'bc-button', onClick: props.onBackToOrg }, t('Back to organization')))
    }
    const staff = employees.filter(item => item.department_id === department.id)
    const bound = Boolean(department.chat_ref)
    const row = employee => {
      const disabled = !botReady(employee)
      const detail = employeeDetail(projects, employee)
      return h('button', {
        key: employee.id,
        type: 'button',
        className: 'bc-co-row' + (disabled ? ' is-disabled' : ''),
        'aria-disabled': disabled ? 'true' : undefined,
        tabIndex: 0,
        title: employeeTitle(employee),
        onClick: () => openEmployee(employee),
      },
        h('span', { className: 'bc-co-row-main' },
          h('strong', null, employee.name),
          h('span', { className: 'bc-co-sub' }, detail)),
        h('span', { className: 'bc-co-row-go', 'aria-hidden': true }, '→'))
    }
    return h('section', { className: 'bc-co-deptpage', 'aria-label': department.name },
      h('div', { className: 'bc-co-depthead' },
        h('button', {
          type: 'button',
          className: 'bc-co-back',
          'aria-label': t('Back to organization'),
          title: t('Back to organization'),
          ref: backRef,
          onClick: props.onBackToOrg,
        }, '←'),
        h('div', { className: 'bc-co-depttitle' },
          h('h2', null, department.name),
          h('p', null, t('{count} people', { count: staff.length }))),
        h('span', { className: 'bc-co-pill' + (bound ? ' is-bound' : '') }, bound ? t('Linked') : t('Not bound yet'))),
      // Only the two blocks the read model can fill. Capability allocation and the
      // department owner have no fields yet, so they render nothing rather than an
      // empty shell.
      h('section', { className: 'bc-co-block' },
        h('h3', null, t('Department group')),
        bound
          ? h('p', { className: 'bc-co-line' }, t('Department group bound'))
          : h('div', null,
            h('p', { className: 'bc-co-line' }, t('Department group not bound')),
            h('p', { className: 'bc-co-muted' }, t('Department chats are needed before the project starts.')))),
      h('section', { className: 'bc-co-block' },
        h('h3', null, t('Employees')),
        staff.length
          ? h('div', { className: 'bc-co-rows' }, staff.map(row))
          : h('p', { className: 'bc-co-muted' }, t('This department has no employees yet.'))))
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
    body = h('div', { className: 'bc-state bc-co-state' }, h('strong', null, t('No company information yet')))
  } else if (tab === 'overview') {
    body = overview
  } else if (deptId !== null) {
    body = departmentPage(department)
  } else {
    body = organization
  }

  return h('section', { className: 'bc-co-page', 'aria-label': t('Company') }, tabs, body)
}

export function CompanyPage(props) {
  const { escapeGuard } = props
  const [tab, setTab] = useState('overview')
  const [deptId, setDeptId] = useState(null)
  const [chain, setChain] = useState(null)
  const [overflow, setOverflow] = useState(false)
  const tabRefs = useRef(new Map())
  const deptButtons = useRef(new Map())
  const wrapRef = useRef(null)
  const backRef = useRef(null)
  const pendingFocus = useRef(null)

  const selectTab = next => { setTab(next); setDeptId(null); setChain(null) }
  const showDept = id => { setDeptId(id); setChain(null) }
  const backToOrg = () => { pendingFocus.current = deptId; setDeptId(null); setChain(null) }

  // The surface owns Escape for the whole panel; while a department page is open it
  // has to come back here first, so the guard runs before the panel closes.
  if (escapeGuard) {
    escapeGuard.current = () => {
      if (deptId === null) return false
      backToOrg()
      return true
    }
  }

  useEffect(() => {
    if (deptId !== null) { backRef.current?.focus?.(); return }
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    deptButtons.current.get(target)?.focus?.()
  }, [deptId])

  // The hint only shows when the chart really is wider than its container: the page
  // itself never scrolls sideways.
  useEffect(() => {
    const measure = () => {
      const element = wrapRef.current
      if (!element) return
      setOverflow(Number(element.scrollWidth ?? 0) > Number(element.clientWidth ?? 0) + 1)
    }
    measure()
    const observer = typeof ResizeObserver === 'function' && wrapRef.current ? new ResizeObserver(measure) : null
    if (observer) observer.observe(wrapRef.current)
    if (typeof window !== 'undefined') window.addEventListener('resize', measure)
    return () => {
      if (observer) observer.disconnect()
      if (typeof window !== 'undefined') window.removeEventListener('resize', measure)
    }
  }, [tab, deptId, props.data.departments, props.data.employees, props.loading, props.error])

  return CompanyPageView({
    ...props,
    tab,
    deptId,
    chain,
    overflow,
    wrapRef,
    tabRefs,
    deptButtons,
    backRef,
    onSelectTab: selectTab,
    onShowDept: showDept,
    onBackToOrg: backToOrg,
    onChain: setChain,
  })
}

export const COMPANY_PAGE_CSS = `
.bc-co-page{display:flex;flex-direction:column;min-height:0}
.bc-co-tabs{display:flex;gap:4px;border-bottom:1px solid var(--bt-line);margin:0 0 20px}
.bc-co-tab{position:relative;border:0;background:none;padding:9px 12px;min-height:36px;font:600 13px var(--bt-font);color:var(--bt-ink-2);cursor:pointer;border-radius:8px 8px 0 0}
.bc-co-tab:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bc-co-tab[aria-selected="true"]{color:var(--bt-ink)}
.bc-co-tab[aria-selected="true"]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:999px;background:var(--bt-accent)}
.bc-co-tab:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bc-co-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
@media (max-width:720px){.bc-co-stats{grid-template-columns:repeat(2,minmax(0,1fr))}}
.bc-co-stat{display:flex;flex-direction:column;gap:4px;min-height:96px;padding:14px 16px;text-align:left;background:var(--bt-card);border:1px solid var(--bt-line);border-radius:12px;box-shadow:var(--bc-shadow-raised)}
.bc-co-stat:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bc-co-stat-label{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bc-co-stat-value{font:600 26px/32px var(--bt-font);color:var(--bt-ink);font-variant-numeric:tabular-nums}
.bc-co-stat.is-strong .bc-co-stat-value{color:var(--bt-accent)}
.bc-co-stat-sub{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bc-co-stat-retry{margin-top:auto;align-self:flex-start;border:0;background:none;padding:0;min-height:28px;font:600 12px var(--bt-font);color:var(--bt-accent);cursor:pointer;border-radius:4px}
.bc-co-stat-retry:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bc-co-wrap{overflow-x:auto;overscroll-behavior-x:contain;padding:4px 2px 8px}
.bc-co{display:flex;gap:24px;align-items:flex-start;min-width:720px}
.bc-co-node{display:grid;grid-template-columns:14px 1fr;gap:8px;align-items:start;background:none;border:0;padding:6px 10px 6px 0;font:inherit;color:var(--bt-ink);text-align:left;cursor:pointer;border-radius:8px;transition:opacity .12s ease}
.bc-co-node::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--bt-accent);margin:7px auto 0}
.bc-co-node:hover{background:var(--bt-hover)}
.bc-co-node:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bc-co-node-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.bc-co-node-text strong{font-size:14px;line-height:20px;font-weight:600}
.bc-co-sub{font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bc-co.is-dim .bc-co-node{opacity:.34}
.bc-co.is-dim .bc-co-node.is-lit{opacity:1}
.bc-co-company{flex:none;min-width:200px;cursor:default}
.bc-co-company:hover{background:none}
.bc-co.is-dim .bc-co-company{opacity:1}
.bc-co-branches{display:flex;flex-direction:column;gap:14px;flex:1}
.bc-co-branch{display:flex;align-items:flex-start}
.bc-co-dept{width:200px;flex:none;margin-right:10px}
.bc-co-emps{display:flex;flex-direction:column;gap:2px;min-width:240px;padding-left:18px;position:relative}
.bc-co-emps::before{content:"";position:absolute;left:6px;top:10px;bottom:10px;width:1px;background:var(--bt-line)}
.bc-co-emp{position:relative}
.bc-co-emp::after{content:"";position:absolute;left:-12px;top:16px;width:12px;height:1px;background:var(--bt-line)}
.bc-co-none{display:block;padding:6px 0 6px 2px;font-size:12px;line-height:17px;color:var(--bt-ink-3)}
.bc-co-node.is-disabled{color:var(--bt-ink-2);cursor:default}
.bc-co-node.is-disabled:hover{background:none}
.bc-co-hint{margin:10px 0 0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bc-co-deptpage{display:flex;flex-direction:column;gap:22px}
.bc-co-depthead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.bc-co-back{flex:none;width:36px;height:36px;border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font-size:18px;line-height:1;cursor:pointer}
.bc-co-back:hover{background:var(--bt-hover)}
.bc-co-back:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bc-co-depttitle h2{margin:0;font-size:17px;line-height:24px;font-weight:600}
.bc-co-depttitle p{margin:2px 0 0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bc-co-pill{margin-left:auto;padding:4px 10px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:12px;line-height:16px}
.bc-co-block{display:flex;flex-direction:column;gap:8px;padding-top:16px;border-top:1px solid var(--bt-line)}
.bc-co-block h3{margin:0;font-size:13px;line-height:18px;font-weight:600;color:var(--bt-ink-2)}
.bc-co-line{margin:0;font-size:13px;line-height:18px}
.bc-co-muted{margin:0;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bc-co-rows{display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card)}
.bc-co-row{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;border:0;border-bottom:1px solid var(--bt-line);background:var(--bt-card);font:inherit;color:var(--bt-ink);text-align:left;cursor:pointer}
.bc-co-row:last-child{border-bottom:0}
.bc-co-row:hover{background:var(--bt-hover)}
.bc-co-row:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bc-co-row.is-disabled{color:var(--bt-ink-2);cursor:default}
.bc-co-row.is-disabled:hover{background:var(--bt-card)}
.bc-co-row-main{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.bc-co-row-main strong{font-size:13px;line-height:18px;font-weight:600}
.bc-co-row-go{color:var(--bt-ink-3);font-size:14px}
.bc-co-state{padding:28px 0}
.bc-co-loading{display:flex;flex-direction:column;gap:8px;padding:20px 0}
`
