import { createElement as h, useEffect, useRef, useState } from 'react'
import { t } from './i18n.js'
import { SPRING_SHAPE, SPRING_TAP } from './motion.js'
import { statusLabel } from './projects-page.js'
import { call } from './api.js'
import { HeaderPill } from './header.js'

// P04 项目群聊叠加件（原型 v2.11 / 设计语言 v0.2.7 §4.6）。
// 消息流与输入区由宿主会话 surface 提供，本模块只渲染浮动群头、状态条、
// 置顶卡、成员坞和右侧详情栏。槽位由宿主 client 注入点决定，见
// `清单-新IA实现落点.md`；这里先提供可独立挂载的组件与页面骨架。

const initial = name => (typeof name === 'string' && name.trim() ? name.trim().slice(0, 1).toUpperCase() : '·')

const swallow = () => {}

export function ProjectChatHeader({ projectName, stage, faces, goal, pendingCount, nextStep, onBack, onOpenDetails, expanded }) {
  const hasCount = Number.isFinite(pendingCount) && pendingCount > 0
  const statRows = []
  if (goal) statRows.push(h('div', { key: 'goal', className: 'pc-stat-row' }, h('span', { className: 'pc-stat-key' }, t('Goal')), h('span', { className: 'pc-stat-text' }, goal)))
  if (hasCount || nextStep) {
    statRows.push(
      h(
        'div',
        { key: 'pending', className: 'pc-stat-row' },
        hasCount ? h('span', { className: 'pc-stat-key' }, t('Waiting for you')) : null,
        hasCount ? h('span', { className: 'pc-stat-count' }, String(pendingCount)) : null,
        nextStep ? h('span', { className: 'pc-stat-text' }, `\u00b7 ${nextStep}`) : null
      )
    )
  }
  return h(
    'div',
    { className: `pc-head${statRows.length ? ' has-stat' : ''}` },
    h(
      'div',
      { className: 'pc-headbar' },
      h('button', { type: 'button', className: 'pc-back', onClick: onBack, 'aria-label': t('Back to projects') }, '\u2039'),
      h(
        'button',
        {
          type: 'button',
          className: 'pc-pill',
          title: t('Open project details'),
          'aria-label': `${projectName || t('Project details')}\uff0c${t('Open project details')}`,
          'aria-expanded': expanded ? 'true' : 'false',
          onClick: onOpenDetails,
        },
        h(
          'span',
          { className: 'pc-faces' },
          (faces || []).slice(0, 3).map((face, index) => h('span', { key: index, className: 'pc-face' }, initial(face)))
        ),
        h('span', { className: 'pc-name' }, projectName || t('Project details')),
        stage ? h('span', { className: 'pc-stage' }, stage) : null,
        h('span', { className: 'pc-chevron', 'aria-hidden': 'true' }, '\u203a')
      )
    ),
    statRows.length ? h('div', { className: 'pc-stat' }, statRows) : null
  )
}

export function ProjectChatStatus({ goal, pendingCount, nextStep }) {
  const count = Number.isFinite(pendingCount) ? pendingCount : 0
  return h(
    'div',
    { className: 'pc-stat' },
    h('div', { className: 'pc-stat-row' }, h('span', { className: 'pc-stat-key' }, t('Goal')), h('span', { className: 'pc-stat-text' }, goal || t('No goal specified'))),
    h(
      'div',
      { className: 'pc-stat-row' },
      h('span', { className: 'pc-stat-key' }, t('Waiting for you')),
      h('span', { className: 'pc-stat-count' }, String(count)),
      h('span', { className: 'pc-stat-text' }, nextStep ? `\u00b7 ${nextStep}` : null)
    )
  )
}

export function ProjectChatPinned({ count, items }) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return null
  return h(
    'div',
    { className: 'pc-pin' },
    h('div', { className: 'pc-pin-head' }, h('span', { className: 'pc-pin-title' }, t('Waiting for you')), h('span', { className: 'pc-pin-sub' }, `\u00b7 ${t('Pinned')} ${Number.isFinite(count) ? count : list.length}`)),
    list.map((item, index) =>
      h(
        'div',
        { key: item?.id ?? index, className: 'pc-pin-row' },
        h('span', { className: 'pc-pin-text' }, item?.title ?? ''),
        item?.who ? h('span', { className: 'pc-pin-who' }, item.who) : null
      )
    )
  )
}

export function ProjectChatDock({ faces, label, waiting, leaving, expanded, onOpen }) {
  return h(
    'div',
    { className: `pc-dock${leaving ? ' is-out' : ''}` },
    h(
      'button',
      {
        type: 'button',
        className: `pc-dock-pill${waiting ? ' is-wait' : ''}`,
        'aria-expanded': expanded ? 'true' : 'false',
        'aria-label': label || t('Open project details'),
        onClick: onOpen,
      },
      h(
        'span',
        { className: 'pc-dock-in' },
        h(
          'span',
          { className: 'pc-faces' },
          (faces || []).slice(0, 2).map((face, index) => h('span', { key: index, className: 'pc-face' }, initial(face)))
        ),
        h('span', { className: 'pc-dock-label' }, label || t('Working'))
      )
    )
  )
}

export function ProjectChatDrawer({ projectName, goal, stage, members, pending, activity, onClose, onOpenConfig }) {
  const closeRef = useRef(null)
  useEffect(() => {
    closeRef.current?.focus?.()
  }, [])
  const rows = Array.isArray(members) ? members : []
  const pendingRows = Array.isArray(pending) ? pending : []
  const activityRows = Array.isArray(activity) ? activity : []
  return h(
    'aside',
    { className: 'pc-drawer', role: 'dialog', 'aria-label': t('Project details') },
    h('div', { className: 'pc-drawer-top' }, h('button', { ref: closeRef, type: 'button', className: 'pc-round', onClick: onClose, 'aria-label': t('Close') }, '\u00d7')),
    h(
      'div',
      { className: 'pc-drawer-id' },
      h('span', { className: 'pc-drawer-name' }, projectName || t('Project details')),
      h('span', { className: 'pc-drawer-role' }, stage || statusLabel('setup'))
    ),
    h(
      'div',
      { className: 'pc-drawer-body' },
      h('section', { className: 'pc-sec' }, h('h3', null, t('Goal')), h('p', null, goal || t('No goal specified'))),
      h(
        'section',
        { className: 'pc-sec' },
        h('h3', null, t('Members')),
        rows.length ? rows.map((row, index) => h('button', { key: index, type: 'button', className: 'pc-member', onClick: row.onOpen ?? swallow }, h('span', null, row.name ?? ''), h('small', null, row.role ?? ''))) : h('p', null, t('No members yet'))
      ),
      h(
        'section',
        { className: 'pc-sec' },
        h('h3', null, t('Waiting for you')),
        pendingRows.length ? pendingRows.map((row, index) => h('button', { key: index, type: 'button', className: 'pc-wait', onClick: row.onOpen ?? swallow }, h('span', null, row.title ?? ''), h('small', null, row.who ?? ''))) : h('p', null, t('All clear'))
      ),
      h(
        'section',
        { className: 'pc-sec' },
        h('h3', null, t('Last activity')),
        activityRows.length ? activityRows.map((row, index) => h('p', { key: index }, row)) : h('p', null, t('No recent activity'))
      )
    ),
    h('div', { className: 'pc-drawer-foot' }, h('button', { type: 'button', className: 'pc-btn pc-btn-primary', onClick: onOpenConfig }, t('Open project settings')))
  )
}

// 页面骨架：叠加件 + 宿主会话槽位（slot）。注入点确定后由 index.js 传入。
export function ProjectChatPage({ project, stage: stageProp, faces, goal, nextStep, pendingCount, pinned, dock, members, pending, activity, onBack, onOpenConfig, slot }) {
  const [open, setOpen] = useState(false)
  const openerRef = useRef(null)
  const close = () => {
    setOpen(false)
    const opener = openerRef.current
    if (opener && typeof opener.focus === 'function') opener.focus()
  }
  useEffect(() => {
    if (!open) return
    const onKey = event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        const opener = openerRef.current
        if (opener && typeof opener.focus === 'function') opener.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  const openDrawer = event => {
    openerRef.current = event?.currentTarget ?? null
    setOpen(true)
  }
  const [leaving, setLeaving] = useState(false)
  const reduced = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  const goBack = () => {
    if (leaving) return
    if (reduced()) {
      onBack?.()
      return
    }
    setLeaving(true)
    window.setTimeout(() => onBack?.(), 170)
  }
  const stage = stageProp || statusLabel(project?.status)
  const headRef = useRef(null)
  const [pinTop, setPinTop] = useState(0)
  useEffect(() => {
    const measure = () => {
      const el = headRef.current
      if (el) setPinTop(Math.round(el.getBoundingClientRect().height) + 8)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [project?.name, goal, pendingCount, nextStep, stage])
  const pinnedEl = pinned?.items?.length ? h(ProjectChatPinned, { count: pinned?.count, items: pinned.items }) : null
  return h(
    'div',
    { className: 'pc-page' },
    h(
      'div',
      { ref: headRef, className: 'pc-head-holder' },
      h(ProjectChatHeader, {
        projectName: project?.name,
        stage,
        faces,
        goal: goal ?? project?.goal,
        pendingCount,
        nextStep,
        expanded: open,
        onBack: goBack,
        onOpenDetails: openDrawer,
      })
    ),
    pinnedEl ? h('div', { className: 'pc-pin-layer', style: { top: `${pinTop}px` } }, pinnedEl) : null,
    h('div', { className: 'pc-body' }, slot ?? null),
    h(ProjectChatDock, {
      faces: dock?.faces ?? faces,
      label: dock?.label,
      waiting: dock?.waiting,
      leaving,
      expanded: open,
      onOpen: openDrawer,
    }),
    open
      ? h(ProjectChatDrawer, {
          projectName: project?.name,
          goal: goal ?? project?.goal,
          stage,
          members,
          pending,
          activity,
          onClose: close,
          onOpenConfig,
        })
      : null
  )
}

export const PROJECT_CHAT_CSS = `
header[class*="_header"]:has(.pc-head){position:absolute;top:0;left:0;right:0;z-index:8;display:flex;justify-content:center;padding:0;background:transparent;pointer-events:none;height:auto!important;overflow:visible!important}
header[class*="_header"]:has(.pc-head)::before{content:"";position:absolute;inset:0 0 auto;height:calc(100% + 26px);background:linear-gradient(to bottom,var(--bt-main),color-mix(in srgb,var(--bt-main) 0%,transparent));pointer-events:none;z-index:-1}
.pc-frame{position:relative;display:flex;flex-direction:column;width:100%;pointer-events:none}
.pc-page{--pc-main:var(--bt-main);--pc-ring:var(--bt-line-2);--pc-ink-3:var(--bt-ink-3);position:relative;display:flex;flex-direction:column;min-height:0;flex:1;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font)}
.pc-page *{box-sizing:border-box}
.pc-head-holder{position:absolute;inset:0 0 auto;z-index:8;pointer-events:none}
.pc-head{display:flex;flex-direction:column;background:transparent;pointer-events:none}
.pc-head::before{content:none;background:linear-gradient(to bottom,var(--bt-main),color-mix(in srgb,var(--bt-main) 0%,transparent));pointer-events:none;z-index:-1}
.pc-head.has-stat::before{height:calc(var(--bc-mask-header,60px) + 48px)}
.pc-headbar{position:relative;display:flex;justify-content:center;align-items:flex-start;padding:10px 0 0;pointer-events:none}
.pc-back{position:absolute;left:12px;top:10px;pointer-events:auto;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:999px;background:transparent;color:var(--bt-ink-2);font-size:18px;line-height:1;cursor:pointer}
.pc-back::after{content:"";position:absolute;inset:-8px}
.pc-back:hover{background:var(--bt-hover);color:var(--bt-ink)}
.pc-pill{position:relative;pointer-events:auto;display:inline-flex;align-items:center;gap:8px;height:40px;padding:7px 13px 7px 7px;border-radius:999px;border:.5px solid var(--pc-ring);background:var(--bt-main);color:var(--bt-ink);font:500 15px/22px var(--bt-font);box-shadow:0 2px 8px -1px color-mix(in srgb,var(--bt-ink) 6%,transparent),0 1px 2px color-mix(in srgb,var(--bt-ink) 4%,transparent);cursor:pointer;max-width:70%}
.pc-pill:hover{background:color-mix(in srgb,var(--bt-main),var(--bt-ink) 6%)}
.pc-pill:active{transform:scale(.965)}
.pc-faces{display:inline-flex;align-items:center;flex:none}
.pc-face{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font:600 10px/1 var(--bt-font);box-shadow:0 0 0 2px var(--bt-main)}
.pc-face+.pc-face{margin-left:-5px}
.pc-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-stage{flex:none;padding:2px 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font:400 11px/16px var(--bt-font)}
.pc-chevron{color:var(--pc-ink-3);font-size:14px;line-height:1}
.pc-pill:hover .pc-chevron,.pc-pill:focus-visible .pc-chevron{color:var(--bt-accent)}
.pc-page :is(button,input,textarea,select,summary):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.pc-stat{position:relative;z-index:7;display:flex;flex-direction:column;gap:2px;padding:8px 16px 0;pointer-events:none;font-size:12px;line-height:16px}
.pc-stat-row{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:16px}
.pc-stat-key{flex:none;color:var(--pc-ink-3)}
.pc-stat-text{color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pc-stat-count{font-weight:700;color:var(--bt-ink)}
.pc-pin-layer{position:absolute;left:0;right:0;top:calc(100% + 8px);z-index:9;display:flex;justify-content:center;padding:0 12px;pointer-events:none}
.pc-pin{width:min(100%,var(--dsh-chat-content-width,960px));max-height:72px;overflow:hidden;margin:0;padding:10px 14px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-card);pointer-events:none}
.pc-pin-head{display:flex;align-items:baseline;gap:6px;font-size:12px;line-height:16px}
.pc-pin-title{font-weight:600;color:var(--bt-ink)}
.pc-pin-sub{color:var(--pc-ink-3)}
.pc-pin-row{display:flex;justify-content:space-between;gap:12px;margin-top:8px;font-size:13px;line-height:18px;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pc-pin-who{flex:none;font-size:12px;color:var(--bt-ink-2)}
.pc-body{flex:1;min-height:0;overflow:auto;padding:12px 16px 64px}
.pc-dock{position:sticky;bottom:8px;z-index:6;display:flex;justify-content:center;pointer-events:none;padding:0 16px}
.pc-dock-pill{pointer-events:auto;display:inline-flex;align-items:center;height:32px;padding:0;border:0;border-radius:999px;overflow:hidden;background:var(--bt-main);color:var(--bt-ink-2);cursor:pointer;box-shadow:0 0 0 .5px var(--pc-ring),0 2px 8px -2px color-mix(in srgb,var(--bt-ink) 12%,transparent);transform-origin:50% 100%;animation:pc-dock-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing} backwards,pc-dock-veil .18s ease-out backwards;transition:background-color .12s ease,scale ${SPRING_TAP.duration}ms ${SPRING_TAP.easing}}
.pc-dock-pill:hover{background:color-mix(in srgb,var(--bt-ink) 4%,var(--bt-main))}
.pc-dock-pill:active{scale:.97}
.pc-dock-in{display:inline-flex;align-items:center;gap:8px;flex:none;padding:0 13px 0 6px;white-space:nowrap}
.pc-dock-label{font:400 13px/18px var(--bt-font);max-width:min(420px,58vw);overflow:hidden;text-overflow:ellipsis}
.pc-dock-pill.is-wait{color:var(--bt-ink-2)}
.pc-drawer{position:fixed;top:0;right:0;bottom:0;z-index:40;width:380px;max-width:calc(100% - 56px);display:flex;flex-direction:column;background:var(--bt-main);border-left:.5px solid var(--pc-ring);color:var(--bt-ink);animation:pc-pane-in .3s cubic-bezier(.2,0,0,1)}
.pc-drawer-top{display:flex;justify-content:flex-end;gap:8px;padding:12px 17px 6px 12px}
.pc-round{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:999px;background:transparent;color:var(--bt-ink);font-size:20px;line-height:1;cursor:pointer}
.pc-round:hover{background:var(--bt-hover)}
.pc-drawer-id{display:flex;flex-direction:column;align-items:center;padding:14px 16px 0}
.pc-drawer-name{font:500 17px/24px var(--bt-font);text-align:center}
.pc-drawer-role{margin-top:6px;font-size:12px;line-height:16px;color:var(--pc-ink-3);text-align:center}
.pc-drawer-body{flex:1;overflow-y:auto;padding:20px 16px 16px;font-size:13px;line-height:18px;display:flex;flex-direction:column;gap:16px}
.pc-sec h3{margin:0 0 8px;font-size:11px;line-height:16px;font-weight:600;color:var(--pc-ink-3);text-transform:uppercase;letter-spacing:.06em}
.pc-sec p{margin:0;color:var(--bt-ink-2)}
.pc-member,.pc-wait{display:flex;justify-content:space-between;align-items:baseline;gap:12px;width:100%;padding:8px 0;border:0;border-top:1px solid var(--bt-line);background:transparent;color:var(--bt-ink);font:13px/18px var(--bt-font);text-align:left;cursor:pointer}
.pc-member:hover,.pc-wait:hover{color:var(--bt-accent)}
.pc-member small,.pc-wait small{font-size:11px;color:var(--pc-ink-3)}
.pc-drawer-foot{padding:12px 16px 16px;border-top:1px solid var(--bt-line)}
.pc-btn{width:100%;min-height:40px;border:0;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink,var(--bt-user-ink));font:500 13px/18px var(--bt-font);cursor:pointer}
.pc-btn:hover{filter:brightness(.94)}
@keyframes pc-dock-in{from{opacity:0;transform:translateY(8px) scale(.94)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes pc-dock-veil{from{opacity:0}to{opacity:1}}
@keyframes pc-dock-out{to{opacity:0;transform:translateY(6px) scale(.96);filter:blur(3px)}}
.pc-dock.is-out .pc-dock-pill{animation:pc-dock-out .16s cubic-bezier(.4,0,1,1) forwards;pointer-events:none}
@keyframes pc-pane-in{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}
@media (prefers-reduced-motion:reduce){.pc-dock-pill{animation:none}.pc-drawer{animation:none}}
@media (max-width:640px){.pc-pill{max-width:78%}.pc-stat{padding:8px 12px 0}.pc-body{padding:12px 12px 56px}.pc-pin{max-height:56px;padding:8px 12px}.pc-pin-row{margin-top:4px}}
`


// ---- 宿主槽位接线（P04 运行态） -------------------------------------------
// 群头槽由本仓整体替换成 HeaderPill；群会话里我们改画 P04 浮层，私聊与单聊
// 仍回 HostPill。项目数据走 company-model 只读接口，按 group_binding.room_id
// 或 group_chat_ref 对上当前会话房间。

let companyPromise = null
const loadCompany = () => {
  if (!companyPromise) {
    companyPromise = call('company-model', {}).catch(() => null)
    companyPromise.then(model => { if (!model) companyPromise = null })
  }
  return companyPromise
}

export const projectOfRoom = (model, roomId) => {
  if (!model || !roomId) return null
  const projects = model.projects || []
  const project = projects.find(item => item.group_binding?.room_id === roomId || item.group_chat_ref === roomId)
  if (!project) return null
  const members = (model.members || []).filter(item => item.project_id === project.id && item.membership_status !== 'left')
  const employees = model.employees || []
  const names = members.map(item => employees.find(entry => entry.id === item.employee_id)?.name).filter(Boolean)
  return { project, members, names }
}

export function ProjectChatHeaderSlot(props) {
  const roster = props.useRoster(value => value)
  const room = roster?.roomsById?.[props.sessionId]
  const roomId = room?.id ?? room?.sessionId
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  const opener = useRef(null)
  useEffect(() => {
    if (!roomId) { setData(null); return }
    let live = true
    loadCompany().then(model => { if (live) setData(projectOfRoom(model, roomId)) })
    return () => { live = false }
  }, [roomId])
  useEffect(() => {
    if (!open) return
    const onKey = event => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      setOpen(false)
      opener.current?.focus?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
  if (!data) return h(HeaderPill, props)
  const project = data.project
  const pending = Number.isFinite(project.pending_count) ? project.pending_count : 0
  const close = () => { setOpen(false); opener.current?.focus?.() }
  return h('div', { className: 'pc-frame' },
    h(ProjectChatHeader, {
      projectName: project.name,
      stage: statusLabel(project.status),
      faces: data.names,
      goal: project.goal || '',
      pendingCount: 0,
      onBack: () => props.actions.openCompanyPage('list'),
      onOpenDetails: event => { opener.current = event?.currentTarget ?? null; setOpen(true) },
      expanded: open,
    }),
    pending > 0 ? h('div', { className: 'pc-pin-layer' }, h(ProjectChatPinned, { count: pending, items: project.pinned_decisions || [] })) : null,
    open ? h(ProjectChatDrawer, {
      projectName: project.name,
      goal: project.goal || '',
      stage: statusLabel(project.status),
      members: data.names,
      pending: [],
      activity: [],
      onClose: close,
      onOpenConfig: () => { props.actions.openCompanyPage('detail', project.id); close() },
    }) : null)
}
