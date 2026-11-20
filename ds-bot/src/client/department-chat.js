import { createElement as h, useEffect, useRef } from 'react'
import { t } from './i18n.js'
import { agoText } from './project-activity.js'

// P11/P12 部门群：群头、成员坞与部门概况抽屉（原型 v2.11 / 设计语言 v0.2.7 §4.6）。
// 与项目群共用同一套宿主槽位和公司只读模型，但部门没有项目阶段、待决定与任务，
// 所以这里只说自己知道的事：门在哪里、有谁、最近发生了什么。

const initial = name => (typeof name === 'string' && name.trim() ? name.trim().slice(0, 1).toUpperCase() : '\u00b7')

const archived = item => item?.status === 'archived'

// The one selector both the header and the drawer read: a room is a department's room
// when the department carries its id in chat_ref (or the mirrored room_id). Keeping the
// lookup here means the header and the drawer can never disagree about which department
// a room belongs to.
export const departmentOfRoom = (model, roomId) => {
  if (!model || !roomId) return null
  const departments = Array.isArray(model.departments) ? model.departments : []
  const department = departments.find(item => !archived(item) && (item.room_id === roomId || item.chat_ref === roomId))
  if (!department) return null
  const employees = (Array.isArray(model.employees) ? model.employees : []).filter(item => !archived(item) && item.department_id === department.id)
  const projects = (Array.isArray(model.projects) ? model.projects : []).filter(item => Array.isArray(item.source_department_ids) && item.source_department_ids.includes(department.id))
  const lead = employees.find(item => item.id === department.lead_employee_id) ?? null
  return { department, employees, projects, lead }
}

const DEPARTMENT_ACTIVITY = new Map([
  ['department.created', () => t('Department created')],
  ['department.updated', () => t('Department details updated')],
  ['department.group.created', () => t('Department group created')],
  ['department.group.bound', () => t('Department group bound')],
])

// Only the events that name this department (or one of its people) are shown; the page
// is read once and filtered here because the events API narrows by project, not by
// department. Unknown kinds stay out rather than turning the drawer into an audit log.
export const departmentActivityLines = (body, context = {}) => {
  const events = Array.isArray(body?.events) ? body.events : []
  const departmentId = context.departmentId
  const memberIds = context.memberIds && typeof context.memberIds.has === 'function' ? context.memberIds : new Set(context.memberIds || [])
  const names = context.names && typeof context.names.get === 'function' ? context.names : new Map()
  const lines = []
  for (const event of events) {
    if (!event?.type) continue
    let text = null
    if (event.aggregate_id === departmentId && DEPARTMENT_ACTIVITY.has(event.type)) text = DEPARTMENT_ACTIVITY.get(event.type)(event.data ?? {})
    else if (event.type === 'employee.created' && event.data?.department_id === departmentId) text = t('{name} joined the department', { name: names.get(event.aggregate_id) || t('Member') })
    else if (event.type === 'employee.updated' && memberIds.has(event.aggregate_id)) text = t('{name} updated their profile', { name: names.get(event.aggregate_id) || t('Member') })
    if (!text) continue
    const when = agoText(event.at, context.now)
    lines.push(when ? `${text} \u00b7 ${when}` : text)
  }
  return lines.slice(0, 5)
}

export function DepartmentChatHeader({ department, memberCount, projectCount, onOpenDetails, onOpenConfig, expanded }) {
  const name = department?.name || t('Department group')
  const subtitle = t('Department group · Inherits company settings · Ask every time')
  return h(
    'div',
    { className: 'dc-head' },
    h(
      'div',
      { className: 'dc-headbar' },
      h(
        'button',
        {
          type: 'button',
          className: 'dc-pill',
          title: t('Open department overview'),
          'aria-label': `${name}\uff0c${t('Open department overview')}`,
          'aria-expanded': expanded ? 'true' : 'false',
          onClick: onOpenDetails,
        },
        h('span', { className: 'dc-face', 'aria-hidden': 'true' }, initial(name)),
        h(
          'span',
          { className: 'dc-titles' },
          h('span', { className: 'dc-name' }, t('{name} · {count} members', { name, count: memberCount })),
          h('span', { className: 'dc-sub' }, subtitle)
        ),
        projectCount > 0 ? h('span', { className: 'dc-tag' }, t('{count} projects', { count: projectCount })) : null,
        h('span', { className: 'dc-chevron', 'aria-hidden': 'true' }, '\u203a')
      ),
      h(
        'div',
        { className: 'dc-head-actions' },
        h('button', { type: 'button', className: 'dc-action', onClick: onOpenDetails, 'aria-expanded': expanded ? 'true' : 'false' }, t('Department overview'), h('span', { className: 'dc-action-go', 'aria-hidden': 'true' }, '\u203a')),
        onOpenConfig ? h('button', { type: 'button', className: 'dc-more', onClick: onOpenConfig, 'aria-label': t('Department settings') }, '\u22ef') : null
      )
    )
  )
}

export function DepartmentChatDrawer({ department, members, lead, projects, activity, onClose, onOpenConfig }) {
  const closeRef = useRef(null)
  useEffect(() => {
    closeRef.current?.focus?.()
  }, [])
  const rows = Array.isArray(members) ? members : []
  const activities = Array.isArray(activity) ? activity : []
  const projectList = Array.isArray(projects) ? projects : []
  const sections = [h('section', { className: 'dc-sec' }, h('h3', null, t('Overview')),
    h('div', { className: 'dc-leadcard' },
      h('span', { className: 'dc-lead-face' }, lead?.name ? [...lead.name][0] : '\u2014'),
      h('span', { className: 'dc-lead-copy' },
        h('strong', null, lead?.name || t('No lead yet')),
        h('small', null, t('Department lead')))))]
  if (department?.description) {
    sections.push(h('section', { className: 'dc-sec' }, h('h3', null, t('Goal')), h('p', null, department.description)))
  }
  sections.push(h('section', { className: 'dc-sec' }, h('h3', null, t('Members')), h('p', { className: 'dc-sec-note' }, lead ? t('{count} people · Lead {name}', { count: rows.length, name: lead.name }) : t('{count} people', { count: rows.length })),
    rows.map((row, index) => h('div', { key: row.id ?? index, className: 'dc-member' },
      h('span', { className: 'dc-member-name' }, row.name ?? ''),
      row.role ? h('small', null, row.role) : null,
      lead && row.id === lead.id ? h('span', { className: 'dc-lead' }, t('Lead')) : null))))
  if (projectList.length) {
    sections.push(h('section', { className: 'dc-sec' }, h('h3', null, t('Projects')), projectList.map((project, index) => h('div', { key: project.id ?? index, className: 'dc-project' },
      h('span', null, project.name ?? ''),
      h('small', null, project.status === 'active' ? t('In progress') : project.status === 'archived' ? t('Archived') : t('Setup'))))))
  }
  if (activities.length) {
    sections.push(h('section', { className: 'dc-sec' }, h('h3', null, t('Last activity')), activities.map((line, index) => h('p', { key: index }, line))))
  }
  sections.push(h('section', { className: 'dc-sec' }, h('h3', null, t('Settings')),
    h('div', { className: 'dc-kv' }, h('span', null, t('Approval mode')), h('strong', null, t('Inherits company settings · Ask every time'))),
    h('p', { className: 'dc-sec-note' }, t('Auto review is a session setting; a department keeps none of its own.'))))
  return h(
    'aside',
    { className: 'dc-drawer', role: 'dialog', 'aria-label': t('Department overview') },
    h('div', { className: 'dc-drawer-top' }, h('button', { ref: closeRef, type: 'button', className: 'dc-round', onClick: onClose, 'aria-label': t('Close') }, '\u00d7')),
    h(
      'div',
      { className: 'dc-drawer-id' },
      h('span', { className: 'dc-drawer-kicker' }, t('Department group')),
      h('span', { className: 'dc-drawer-name' }, department?.name || t('Department group')),
      h('span', { className: 'dc-drawer-role' }, `${t('{count} members', { count: rows.length })}${projectList.length ? ` \u00b7 ${t('{count} projects', { count: projectList.length })}` : ''}`)
    ),
    h('div', { className: 'dc-drawer-body' }, sections),
    h('div', { className: 'dc-drawer-foot' }, h('button', { type: 'button', className: 'dc-btn', onClick: onOpenConfig }, t('Open department settings')))
  )
}

// The surface a department room gets instead of the project overlay: the host pill
// stays mounted (hidden) for visit tracking and new-message pills, as with a project.
export function DepartmentChatSurface({ data, open, onOpenDetails, onClose, onOpenConfig, island }) {
  return h(
    'div',
    { className: 'dc-frame' },
    h(DepartmentChatHeader, {
      department: data.department,
      memberCount: data.employees.length,
      projectCount: data.projects.length,
      expanded: open,
      onOpenDetails,
      onOpenConfig,
    }),
    island ? h('div', { className: 'dc-goal' }, island) : null,
    open ? h(DepartmentChatDrawer, { department: data.department, members: data.employees, lead: data.lead, projects: data.projects, activity: data.activity, onClose, onOpenConfig }) : null
  )
}

export const DEPARTMENT_CHAT_CSS = `
.dc-frame{position:relative;display:flex;flex-direction:column;width:100%;pointer-events:none}
.dc-goal{display:flex;justify-content:center;padding:2px 0 0;pointer-events:none}
.dc-head{display:flex;flex-direction:column;pointer-events:none}
.dc-headbar{position:relative;display:flex;justify-content:center;align-items:flex-start;padding:10px 0 0;pointer-events:none}
.dc-pill{position:relative;pointer-events:auto;display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:7px 13px 7px 7px;border-radius:999px;border:.5px solid var(--bt-line-2);background:var(--bt-main);color:var(--bt-ink);font:500 15px/22px var(--bt-font);box-shadow:0 2px 8px -1px color-mix(in srgb,var(--bt-ink) 6%,transparent),0 1px 2px color-mix(in srgb,var(--bt-ink) 4%,transparent);cursor:pointer;max-width:70%}
.dc-pill:hover{background:color-mix(in srgb,var(--bt-main),var(--bt-ink) 6%)}
.dc-pill:active{transform:scale(.965)}
.dc-face{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font:600 11px/1 var(--bt-font)}
.dc-titles{display:grid;min-width:0;text-align:left}
.dc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dc-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-3);font:400 11px/15px var(--bt-font);max-width:360px}
.dc-tag{flex:none;padding:2px 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font:400 11px/16px var(--bt-font)}
.dc-chevron{color:var(--bt-ink-3);font-size:14px;line-height:1}
.dc-head-actions{position:absolute;right:12px;top:10px;display:flex;align-items:center;gap:8px;pointer-events:auto}
.dc-action{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 11px;border:.5px solid var(--bt-line-2);border-radius:999px;background:color-mix(in srgb,var(--bt-main) 86%,transparent);color:var(--bt-ink-2);font:500 12px/1 var(--bt-font);cursor:pointer;white-space:nowrap}
.dc-action:hover{color:var(--bt-ink);background:var(--bt-hover)}
.dc-action-go{font-size:14px;color:var(--bt-ink-3)}
.dc-more{width:28px;height:28px;border:0;border-radius:999px;background:transparent;color:var(--bt-ink-2);font:500 16px/1 var(--bt-font);cursor:pointer}
.dc-more:hover{background:var(--bt-hover);color:var(--bt-ink)}
.dc-frame :is(button):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.dc-drawer{position:fixed;top:0;right:0;bottom:0;z-index:40;width:380px;max-width:calc(100% - 56px);display:flex;flex-direction:column;background:var(--bt-main);border-left:.5px solid var(--bt-line-2);color:var(--bt-ink);animation:dc-pane-in .3s cubic-bezier(.2,0,0,1)}
.dc-drawer-top{display:flex;justify-content:flex-end;padding:12px 17px 6px 12px}
.dc-round{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:999px;background:transparent;color:var(--bt-ink);font-size:20px;line-height:1;cursor:pointer}
.dc-round:hover{background:var(--bt-hover)}
.dc-drawer-id{display:flex;flex-direction:column;align-items:center;padding:14px 16px 0;gap:4px}
.dc-drawer-kicker{font-size:11px;line-height:16px;color:var(--bt-ink-3);letter-spacing:.04em}
.dc-drawer-name{font:500 17px/24px var(--bt-font);text-align:center}
.dc-drawer-role{font-size:12px;line-height:16px;color:var(--bt-ink-3);text-align:center}
.dc-drawer-body{flex:1;overflow-y:auto;padding:20px 16px 16px;font-size:13px;line-height:18px;display:flex;flex-direction:column;gap:16px}
.dc-sec h3{margin:0 0 8px;font-size:11px;line-height:16px;font-weight:600;color:var(--bt-ink-3);text-transform:uppercase;letter-spacing:.06em}
.dc-sec p{margin:0;color:var(--bt-ink-2)}
.dc-sec-note{color:var(--bt-ink-3)!important;font-size:12px}
.dc-leadcard{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--bt-line)}
.dc-lead-face{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font:600 12px/1 var(--bt-font)}
.dc-lead-copy{display:grid;min-width:0}
.dc-lead-copy strong{font-weight:500;color:var(--bt-ink)}
.dc-lead-copy small{font-size:11px;color:var(--bt-ink-3)}
.dc-member{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:8px 0;border-top:1px solid var(--bt-line)}
.dc-member-name{color:var(--bt-ink)}
.dc-member small{font-size:11px;color:var(--bt-ink-3)}
.dc-lead{flex:none;font-size:11px;color:var(--bt-accent)}
.dc-project{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:8px 0;border-top:1px solid var(--bt-line)}
.dc-project small{font-size:11px;color:var(--bt-ink-3)}
.dc-kv{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:8px 0;border-top:1px solid var(--bt-line);color:var(--bt-ink-2);font-size:12px}
.dc-kv strong{color:var(--bt-ink);font-weight:500}
.dc-drawer-foot{padding:12px 16px 16px;border-top:1px solid var(--bt-line)}
.dc-btn{width:100%;min-height:40px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink,var(--bt-user-ink));font:500 13px/18px var(--bt-font);cursor:pointer}
.dc-btn:hover{filter:brightness(.94)}
@keyframes dc-pane-in{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}
@media (prefers-reduced-motion:reduce){.dc-drawer{animation:none}}
@media (max-width:640px){.dc-pill{max-width:78%}.dc-sub{max-width:200px}}
`
