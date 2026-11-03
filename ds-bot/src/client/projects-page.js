import { createElement as h, useEffect, useRef, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'
import { ProjectPage } from './project-page.js'
import { ProjectWizard } from './project-wizard.js'

const sample = () => ({
  company: { id: 'demo-company', name: 'DS Bot Company', status: 'active' },
  departments: [
    { id: 'demo-product', name: 'Product', chat_ref: 'demo-product-room', status: 'active' },
    { id: 'demo-engineering', name: 'Engineering', chat_ref: 'demo-engineering-room', status: 'active' },
  ],
  employees: [
    { id: 'demo-coordinator', name: 'Blueberry', department_id: 'demo-engineering', status: 'active', role: 'Coordinator', acceptance_role: 'coordinator', project_id: 'demo-project' },
    { id: 'demo-designer', name: 'Designer', department_id: 'demo-product', status: 'active', role: 'Product', acceptance_role: 'memory_keeper', project_id: 'demo-project' },
    { id: 'demo-writer', name: 'Writer', department_id: 'demo-engineering', status: 'active', role: 'Executor', acceptance_role: 'executor', bot_id: 'third-bot' },
  ],
  projects: [{ id: 'demo-project', name: 'DS Bot Company M1', goal: 'Make the project workspace usable for the team.', deliverable: 'Project pages and a bound group chat', acceptance: 'The project can be created, viewed and opened.', status: 'setup', source_department_ids: ['demo-product', 'demo-engineering'], coordinator_assignment_id: 'demo-member', group_chat_ref: 'demo-project-room', group_binding: { status: 'pending', room_id: 'demo-project-room', error: 'Sample: group members need reconciliation.' }, updated_at: Date.now(), revision: 1 }],
  members: [{ id: 'demo-member', project_id: 'demo-project', employee_id: 'demo-coordinator', role: 'coordinator', membership_status: 'active' }, { id: 'demo-member-2', project_id: 'demo-project', employee_id: 'demo-designer', role: 'executor', membership_status: 'active' }],
  group: { group_chat_ref: 'demo-project-room', group_binding: { status: 'pending', room_id: 'demo-project-room' }, members: [], drifted: true },
  revision: 1,
})

const freshKey = () => globalThis.crypto?.randomUUID?.() ?? `company-ui-${Date.now()}-${Math.random().toString(36).slice(2)}`
const empty = () => ({ company: null, departments: [], employees: [], projects: [], members: [], group: null, revision: null })
const message = failure => failure?.message ?? String(failure)

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
  const writeKeys = useRef(new Map())
  const box = useRef(null)
  const opener = useRef(null)
  const revision = useRef(null)
  const selected = page?.id
  const kind = page?.kind ?? 'list'
  const close = () => actions.closeCompanyPage()

  useEffect(() => {
    opener.current = document.activeElement
    box.current?.focus()
    const onKey = event => {
      if (event.key === 'Tab') {
        const focusable = [...box.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])') ?? []].filter(element => element.getClientRects().length > 0)
        if (!focusable.length) { event.preventDefault(); box.current?.focus(); return }
        const first = focusable[0], last = focusable[focusable.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === box.current)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        return
      }
      if (event.key !== 'Escape' || event.target instanceof HTMLSelectElement) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true); opener.current?.focus?.() }
  }, [])

  const load = async (signal, quiet = false) => {
    if (!quiet) { setLoading(true); setError('') }
    try {
      // One read for the whole company: the host's company-model route answers the same
      // shape these pages render, so the list does not need one call per area.
      const model = await call('company-model', {}, signal)
      if (signal?.aborted) return
      const next = { company: model.company ?? null, departments: model.departments ?? [], employees: model.employees ?? [], projects: model.projects ?? [], members: [], group: null, revision: model.revision }
      revision.current = model.revision
      setData(next)
    } catch (failure) { if (!signal?.aborted) { if (quiet) setNotice(message(failure)); else setError(message(failure)) } }
    finally { if (!signal?.aborted && !quiet) setLoading(false) }
  }
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [])

  useEffect(() => {
    if (!selected || preview) return
    const controller = new AbortController()
    setDetailLoading(true)
    setDetailError('')
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

  const previewData = () => { revision.current = 1; setPreview(true); setData(sample()); setError(''); setLoading(false); setNotice('') }
  const mutate = async (command, fields) => {
    if (preview) {
      if (command === 'department.update') {
        const department = { ...data.departments.find(item => item.id === fields.department_id), chat_ref: fields.chat_ref }
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
    const field = command === 'company.init' ? 'company' : command === 'department.create' || command === 'department.update' ? 'department' : command === 'employee.create' ? 'employee' : command === 'project.create' ? 'project' : null
    const created = field && result.body?.[field]
    if (created) setData(current => field === 'company' ? { ...current, company: created } : { ...current, [`${field}s`]: [...current[`${field}s`].filter(item => item.id !== created.id), created] })
    await load(undefined, true)
    if (result.warning) setNotice(t('Saved, but the project group needs reconciliation.'))
    return result
  }
  const openChat = project => {
    if (preview) { setNotice(t('Sample chat is unavailable. Nothing has been saved.')); return }
    if (project.group_binding?.status !== 'bound' || !project.group_chat_ref || !roster.roomsById?.[project.group_chat_ref]) {
      setNotice(t('The project group is not ready. Check its binding before opening chat.'))
      return
    }
    actions.openSession(project.group_chat_ref)
    close()
  }
  const project = data.projects.find(item => item.id === selected)
  const visible = data.projects.filter(item => (filter === 'archived' ? item.status === 'archived' : item.status !== 'archived') && item.name.toLowerCase().includes(query.trim().toLowerCase()))
  return h('div', { className: 'bc-surface', role: 'dialog', 'aria-modal': true, 'aria-label': t('Projects'), tabIndex: -1, ref: box },
    h('div', { className: 'bc-shell' },
      h('header', { className: 'bc-header' },
        h('button', { type: 'button', className: 'bc-brand', onClick: () => actions.openCompanyPage('list') }, t('Projects')),
        h('span', { className: 'bc-header-context' }, data.company?.name ?? t('Company workspace')),
        h('button', { type: 'button', className: 'bc-icon', 'aria-label': t('Close projects'), onClick: close }, '×')),
      preview ? h('div', { className: 'bc-preview', role: 'status' }, t('Preview · Local sample data. Nothing has been saved.')) : null,
      notice ? h('div', { className: 'bc-notice', role: 'status' }, notice, h('button', { type: 'button', 'aria-label': t('Dismiss notice'), onClick: () => setNotice('') }, '×')) : null,
      h('main', { className: 'bc-content' },
        kind === 'wizard' ? h(ProjectWizard, { data, roster, preview, loading, error, mutate, onBack: () => actions.openCompanyPage('list'), onCreated: result => actions.openCompanyPage('detail', result.body?.project?.id) })
          : kind === 'detail' ? h(ProjectPage, { project, data, preview, loading: loading || detailLoading, error: detailError || error, onBack: () => actions.openCompanyPage('list'), onChat: () => project && openChat(project), onRetry: () => setDetailAttempt(value => value + 1), onCommand: async (command, fields) => { const result = await mutate(command, fields); setDetailAttempt(value => value + 1); return result } })
            : h('section', { className: 'bc-page', 'aria-label': t('Project list') },
              h('div', { className: 'bc-lead' }, h('div', null, h('span', { className: 'bc-kicker' }, t('Workspace / Projects')), h('h1', null, t('Projects')), h('p', null, t('Browse work across departments and open a project to see its status.'))), h('button', { type: 'button', className: 'bc-button bc-primary', style: { flex: 'none', whiteSpace: 'nowrap' }, onClick: () => actions.openCompanyPage('wizard') }, t('New project'))),
              loading ? h('p', { className: 'bc-state', role: 'status' }, t('Loading projects…')) : error ? h('div', { className: 'bc-state bc-error', role: 'alert' }, h('strong', null, t('Projects could not be loaded.')), h('p', null, error), h('button', { type: 'button', className: 'bc-button', onClick: () => void load() }, t('Try again')), h('button', { type: 'button', className: 'bc-button', onClick: previewData }, t('Open local sample preview'))) : h('div', null,
                h('div', { className: 'bc-toolbar' }, h('div', { className: 'bc-filters', role: 'group', 'aria-label': t('Project status') }, ['active', 'archived'].map(value => h('button', { type: 'button', key: value, className: `bc-filter${filter === value ? ' bc-selected' : ''}`, 'aria-pressed': filter === value, onClick: () => setFilter(value) }, value === 'active' ? t('Current') : t('Archived')))), h('input', { type: 'search', className: 'bc-search', value: query, onChange: event => setQuery(event.target.value), placeholder: t('Search projects'), 'aria-label': t('Search projects') })),
                visible.length === 0 ? h('div', { className: 'bc-state' }, h('strong', null, query ? t('No matching projects') : t('No projects here yet')), h('p', null, query ? t('Try another name or status.') : t('Create a project to bring employees together around one goal.'))) : h('div', { className: 'bc-list' }, visible.map(item => {
                  const coordinator = data.employees.find(employee => employee.project_id === item.id && employee.acceptance_role === 'coordinator') ?? data.employees.find(employee => employee.id === data.members.find(member => member.id === item.coordinator_assignment_id)?.employee_id)
                  const sources = (item.source_department_ids ?? []).map(id => data.departments.find(department => department.id === id)?.name).filter(Boolean)
                  return h('button', { type: 'button', key: item.id, className: 'bc-project-row', onClick: () => actions.openCompanyPage('detail', item.id) }, h('span', { className: 'bc-project-main' }, h('strong', null, item.name), h('span', null, item.goal || t('No goal specified')), h('small', null, sources.join(' · ') || t('No source departments'))), h('span', { className: 'bc-project-meta' }, h('span', { className: `bc-status bc-${item.status}` }, statusLabel(item.status)), h('small', null, coordinator?.name ?? (item.coordinator_assignment_id ? t('Coordinator assigned') : t('Coordinator pending'))), h('span', { 'aria-hidden': true }, '↗')))
                }))))))
    )
}

export const statusLabel = status => ({ setup: t('Setup'), active: t('In progress'), paused: t('Paused'), archived: t('Archived') })[status] ?? t('Unknown status')

export const COMPANY_CSS = `
.bc-surface{--bc-small:11px;--bc-label:12px;--bc-body:13px;--bc-title:17px;--bc-radius:12px;position:fixed;inset:0;z-index:1100;background:var(--bt-main);color:var(--bt-ink);font-family:var(--bt-font);overflow:auto;overscroll-behavior:contain}.bc-surface *{box-sizing:border-box}.bc-shell{min-height:100vh;display:flex;flex-direction:column}.bc-header{height:52px;flex:none;display:flex;gap:12px;align-items:center;padding:0 max(20px,calc((100vw - 960px)/2));border-bottom:1px solid var(--bt-line);background:var(--bt-card)}.bc-brand{background:none;border:0;color:var(--bt-ink);font-size:15px;font-weight:700;cursor:pointer}.bc-header-context{color:var(--bt-ink-2);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bc-icon{margin-left:auto;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:var(--bt-ink);font-size:24px;cursor:pointer}.bc-content{width:min(100%,1000px);margin:0 auto;padding:32px 24px 64px}.bc-page{max-width:940px;margin:auto}.bc-kicker{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--bt-ink-2)}.bc-lead{display:flex;justify-content:space-between;align-items:end;gap:20px;margin:0 0 28px}.bc-lead h1{font-size:var(--bc-title);line-height:24px;margin:8px 0}.bc-lead p,.bc-muted{color:var(--bt-ink-2);line-height:1.5}.bc-lead p{margin:0;font-size:13px}.bc-button{border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);padding:9px 13px;min-height:36px;font:600 13px var(--bt-font);cursor:pointer}.bc-button:hover,.bc-icon:hover,.bc-filter:hover{background:var(--bt-hover)}.bc-primary{min-height:40px;border-radius:999px;background:var(--bt-accent);color:var(--bt-accent-ink,var(--bt-user-ink));border-color:var(--bt-accent)}.bc-primary:hover{filter:brightness(.94);background:var(--bt-accent)}.bc-button:disabled{opacity:.45;cursor:not-allowed}.bc-surface :is(button,input,textarea,select,summary):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}.bc-toolbar{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:12px}.bc-filters{display:flex;gap:4px;border:1px solid var(--bt-line);border-radius:8px;padding:3px}.bc-filter{border:0;border-radius:6px;background:transparent;color:var(--bt-ink-2);padding:7px 11px;font-size:12px;cursor:pointer}.bc-selected{background:var(--bt-active);color:var(--bt-ink);font-weight:600}.bc-search,.bc-field :is(input,textarea,select){border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);padding:9px 11px;font:13px var(--bt-font)}.bc-search{width:210px}.bc-list{border:1px solid var(--bt-line);border-radius:12px;overflow:hidden;background:var(--bt-card)}.bc-project-row{display:flex;width:100%;gap:20px;align-items:center;text-align:left;padding:17px 20px;border:0;border-bottom:1px solid var(--bt-line);background:transparent;color:var(--bt-ink);cursor:pointer}.bc-project-row:last-child{border:0}.bc-project-row:hover{background:var(--bt-hover)}.bc-project-main{min-width:0;flex:1;display:grid;gap:5px}.bc-project-main strong{font-size:14px}.bc-project-main span,.bc-project-main small,.bc-project-meta small{font-size:12px;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bc-project-meta{min-width:140px;display:grid;justify-items:end;gap:5px}.bc-status{display:inline-flex;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);font-size:11px;font-weight:700;padding:4px 7px}.bc-status.bc-active{color:var(--bt-green)}.bc-status.bc-paused,.bc-status.bc-pending{color:var(--bt-star)}.bc-status.bc-archived{color:var(--bt-ink-2)}.bc-state{border:1px dashed var(--bt-line-2);border-radius:12px;padding:32px;text-align:center;color:var(--bt-ink-2);font-size:13px}.bc-state strong{color:var(--bt-ink);font-size:15px}.bc-state .bc-button{margin:5px}.bc-error{border-color:var(--bt-danger)}.bc-preview{padding:8px 24px;background:var(--bt-tag-bg);text-align:center;color:var(--bt-ink);font-size:12px;font-weight:700}.bc-notice{display:flex;gap:12px;align-items:center;justify-content:center;padding:8px 20px;background:var(--bt-tag-bg);font-size:12px}.bc-notice button{border:0;background:transparent;color:var(--bt-ink);cursor:pointer}.bc-back{background:none;border:0;color:var(--bt-ink-2);font:600 12px var(--bt-font);padding:6px 0;cursor:pointer}.bc-back:hover{color:var(--bt-ink)}.bc-section{background:var(--bt-card);border:1px solid var(--bt-line);border-radius:12px;padding:20px;margin:16px 0}.bc-section h2{font-size:14px;margin:0 0 14px}.bc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.bc-field{display:grid;gap:6px;font-size:12px;font-weight:600}.bc-field :is(input,textarea,select){width:100%}.bc-field textarea{resize:vertical;min-height:72px}.bc-field small{font-weight:400;color:var(--bt-ink-2)}.bc-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.bc-detail-title{font-size:var(--bc-title);line-height:24px;margin:10px 0}.bc-detail-label{color:var(--bt-ink-2);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.bc-detail-value{font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.bc-member{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--bt-line);font-size:13px}.bc-member small{font-size:11px;color:var(--bt-ink-2)}.bc-steps{display:flex;flex-wrap:wrap;gap:6px;margin:24px 0}.bc-step{font-size:11px;color:var(--bt-ink-2);padding:7px 10px;border:1px solid var(--bt-line);border-radius:6px}.bc-step[aria-current=step]{color:var(--bt-ink);border-color:var(--bt-accent);font-weight:700}.bc-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.bc-choice{display:flex;align-items:center;gap:8px;padding:8px 0;font-size:13px}.bc-choice input{accent-color:var(--bt-accent)}.bc-exception{border-left:3px solid var(--bt-danger);padding:10px 12px;background:var(--bt-tag-bg);font-size:12px;line-height:1.5}.bc-exception strong{display:block}.bc-optional{margin-top:16px;border-top:1px solid var(--bt-line);padding-top:14px}.bc-optional summary{cursor:pointer;color:var(--bt-ink);font-size:13px;font-weight:600}.bc-optional[open] summary{margin-bottom:16px}.bc-start-reason{text-align:right;color:var(--bt-ink-2);font-size:12px;line-height:1.5}.bc-surface button{touch-action:manipulation}@media(max-width:620px){.bc-header{height:48px;padding:0 14px}.bc-content{padding:22px 14px 48px}.bc-lead{align-items:flex-start}.bc-lead h1{font-size:var(--bc-title)}.bc-toolbar{align-items:stretch;flex-direction:column}.bc-search{width:100%}.bc-project-row{padding:14px;gap:8px}.bc-project-meta{min-width:88px}.bc-grid{grid-template-columns:1fr}.bc-section{padding:16px}}
`
