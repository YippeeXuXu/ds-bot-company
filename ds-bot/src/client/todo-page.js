import { createElement as h, useState } from 'react'
import { CheckIcon, ShieldIcon } from './icons.js'
import { t } from './i18n.js'

// The decisions that wait for the owner: approvals first, then acceptances, then
// what has already been handled. The company task model owns these rows; until
// its read route exists the surface passes none, so the page rests on its
// page-level empty state.
//
// A row: { id, card_kind: 'approval' | 'acceptance', state, title, project_name,
//   risk_text, requester, wait_minutes, opinion }
const PENDING = 'pending'

const isPending = item => (item.state ?? PENDING) === PENDING

// Minutes read as "12 分钟" up to an hour, then "2 小时 5 分".
const waitText = value => {
  const total = Math.max(0, Math.round(Number(value) || 0))
  if (total < 60) return `${total} ${t('min')}`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest ? `${hours} ${t('h')} ${rest} ${t('min')}` : `${hours} ${t('h')}`
}

const stateLabel = item => {
  switch (item.state) {
    case 'accepted': return t('Passed')
    case 'approved':
    case 'approved-human': return t('Approved')
    case 'approved-auto': return t('Allowed automatically')
    case 'returned': return t('Sent back')
    case 'rejected': return t('Rejected')
    case 'expired': return t('Expired')
    default: return t('Handled')
  }
}

const metaOf = (item, handled) => {
  const approval = item.card_kind === 'approval'
  const parts = []
  if (item.project_name) parts.push(item.project_name)
  parts.push(approval ? t('Approval') : t('Acceptance review'))
  if (handled) parts.push(stateLabel(item))
  else if (approval) {
    parts.push(item.risk_text || t('Needs your approval'))
    parts.push(`${t('Waiting')} ${waitText(item.wait_minutes)}`)
  } else {
    if (item.requester) parts.push(t('Submitted by {name}', { name: item.requester }))
    parts.push(`${t('Waiting')} ${waitText(item.wait_minutes)}`)
  }
  return parts.join(' · ')
}

const badgeOf = (item, handled) => {
  if (handled) return stateLabel(item)
  if (item.card_kind === 'approval') return item.risk_text || t('Needs your approval')
  return t('Pending')
}

export function TodoPage({ todos = [], loading = false, error = '', onRetry, actions = {} }) {
  const [noteFor, setNoteFor] = useState(null)
  const [draft, setDraft] = useState('')

  const openNote = item => { setNoteFor(item.id); setDraft('') }
  const submitNote = item => {
    const text = draft.trim()
    setNoteFor(null)
    setDraft('')
    if (text) actions.onNote?.(item, text)
  }

  const card = (item, handled = false) => {
    const approval = item.card_kind === 'approval'
    const title = item.title || ''
    return h('article', { key: item.id, className: handled ? 'td-card td-card-done' : 'td-card' },
      h('div', { className: 'td-card-top' },
        h('span', { className: 'td-icon', 'aria-hidden': true }, approval ? h(ShieldIcon) : h(CheckIcon)),
        h('div', { className: 'td-grow' },
          h('div', { className: 'td-title' }, title),
          h('div', { className: 'td-meta' }, metaOf(item, handled))),
        h('span', { className: 'bc-tag' }, badgeOf(item, handled)),
        h('button', { type: 'button', className: 'td-link', onClick: () => actions.onOpenProject?.(item) }, t('View project'))),
      // A result row replaces the actions once decided; a handled card keeps the
      // way back to its project through the coordinator.
      h('div', { className: 'td-actions', role: 'group', 'aria-label': t('Actions for {title}', { title }) },
        handled ? null : h('button', { type: 'button', className: 'td-action td-action-primary', onClick: () => actions.onDecide?.(item, 'approve') }, approval ? t('Agree') : t('Pass')),
        handled ? null : h('button', { type: 'button', className: 'td-action', onClick: () => actions.onDecide?.(item, 'return') }, t('Return')),
        h('button', { type: 'button', className: 'td-action', onClick: () => actions.onInvestigate?.(item) }, t('Look into it')),
        handled ? null : h('button', { type: 'button', className: 'td-action td-action-text', onClick: () => openNote(item) }, t('Add a note'))),
      item.opinion ? h('p', { className: 'td-opinion' }, `${t('Note')}: ${item.opinion}`) : null,
      noteFor === item.id
        ? h('div', { className: 'td-note' }, h('input', {
          type: 'text',
          value: draft,
          autoFocus: true,
          placeholder: t('Write a note, optional'),
          'aria-label': t('Add a note'),
          onChange: event => setDraft(event.target.value),
          onKeyDown: event => {
            if (event.nativeEvent?.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); submitNote(item) }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setNoteFor(null) }
          },
        }))
        : null)
  }

  const section = (key, label, items, handled = false) => h('section', { key, className: 'td-section' },
    h('h2', null, `${t(label)} ${items.length}`),
    // Sorted by the longest wait first: the one blocking work the longest leads.
    items.slice().sort((a, b) => (Number(b.wait_minutes) || 0) - (Number(a.wait_minutes) || 0)).map(item => card(item, handled)))

  const skeleton = h('div', { className: 'td-sections', role: 'status', 'aria-label': t('Loading todos…') },
    [0, 1].map(index => h('div', { key: index, className: 'td-section' },
      h('span', { className: 'bc-skel td-skel-heading' }),
      [0, 1].map(line => h('div', { key: line, className: 'td-card td-skeleton' },
        h('div', { className: 'td-card-top' },
          h('span', { className: 'td-icon' }),
          h('div', { className: 'td-grow' },
            h('span', { className: 'bc-skel bc-skel-title' }),
            h('span', { className: 'bc-skel bc-skel-line' }))))))))

  const failure = h('div', { className: 'bc-state bc-error', role: 'alert' },
    h('strong', null, t('Todos could not be loaded.')),
    error ? h('p', null, String(error)) : null,
    h('button', { type: 'button', className: 'bc-button', onClick: () => onRetry?.() }, t('Try again')))

  const empty = h('div', { className: 'bc-state' },
    h('strong', null, t('No decisions waiting for you.')),
    h('button', { type: 'button', className: 'bc-button', onClick: () => actions.onOpenProjects?.() }, t('Look at projects')))

  const pending = todos.filter(isPending)
  const handled = todos.filter(item => !isPending(item))
  const body = pending.length === 0
    ? empty
    : h('div', { className: 'td-sections' },
      section('approvals', 'Approvals to confirm', pending.filter(item => item.card_kind === 'approval')),
      section('acceptances', 'Acceptances to confirm', pending.filter(item => item.card_kind === 'acceptance')))

  return h('section', { className: 'bc-page td-page', 'aria-label': t('Todos') },
    h('div', { className: 'bc-head' },
      h('div', { className: 'bc-grow' },
        h('span', { className: 'bc-crumb' }, t('Workspace / Todos')),
        h('h1', null, t('Todos')))),
    loading ? skeleton
      : error ? failure
        : h('div', null,
          body,
          handled.length ? section('handled', 'Handled', handled, true) : null))
}

export const TODO_CSS = `
.td-page{max-width:760px}
.td-sections{display:flex;flex-direction:column;gap:18px}
.td-section h2{font-size:var(--bc-text-heading);line-height:22px;font-weight:600;margin:0 0 8px}
.td-card{background:var(--bt-card);border:1px solid var(--bt-line);border-radius:var(--bc-radius-card);margin:0 0 8px;overflow:hidden}
.td-card:hover{border-color:var(--bt-line-2)}
.td-card-done{background:var(--bt-sidebar)}
.td-card-top{display:flex;align-items:center;gap:10px;padding:12px 14px}
.td-icon{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:var(--bt-tag-bg);color:var(--bt-ink-2)}
.td-grow{flex:1;min-width:0}
.td-title{font-size:var(--bc-text-content);line-height:20px;color:var(--bt-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.td-meta{font-size:var(--bc-text-xs);line-height:16px;color:var(--bt-ink-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.td-link{flex:none;border:0;background:none;padding:6px 0;font:inherit;font-size:var(--bc-text-sm);color:var(--bt-ink-2);cursor:pointer}
.td-link:hover{color:var(--bt-accent);text-decoration:underline}
.td-actions{display:flex;flex-wrap:wrap;align-items:center;gap:4px;margin:0 14px 12px}
.td-action{position:relative;height:var(--bc-control-md);padding:0 16px;border:1px solid var(--bt-line-2);border-radius:999px;background:transparent;color:var(--bt-ink);font:inherit;font-size:var(--bc-text-content);cursor:pointer}
.td-action:hover{background:var(--bt-hover)}
.td-action::after{content:"";position:absolute;inset:-4px}
.td-action-primary{border-color:transparent;background:var(--bt-accent);color:var(--bt-accent-ink)}
.td-action-primary:hover{background:var(--bt-accent);filter:brightness(.94)}
.td-action-text{border-color:transparent;background:transparent;padding:0 8px;font-size:13px;color:var(--bt-ink-2)}
.td-action-text:hover{background:transparent;color:var(--bt-ink)}
.td-action:disabled{opacity:.35;cursor:default}
.td-opinion{margin:0 14px 12px;font-size:var(--bc-text-sm);line-height:18px;color:var(--bt-ink-2)}
.td-note{margin:0 14px 12px}
.td-note input{width:100%;height:var(--bc-control-md);padding:0 11px;border:1px solid var(--bt-line-2);border-radius:var(--bc-radius-field);background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:var(--bc-text-content)}
.td-skel-heading{width:30%;height:18px;margin-bottom:10px}
.td-skeleton .td-card-top{padding:12px 14px}
.td-skeleton .td-grow{display:grid;gap:8px}
@media(max-width:620px){
  .td-card-top{flex-wrap:wrap;padding:10px}
  .td-title,.td-meta{white-space:normal}
  .td-actions{margin:0 10px 10px}
  .td-opinion,.td-note{margin:0 10px 10px}
}
`
