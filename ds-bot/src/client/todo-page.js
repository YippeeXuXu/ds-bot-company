import { createElement as h, useState } from 'react'
import { CheckIcon, ShieldIcon } from './icons.js'
import { t } from './i18n.js'

// The decisions that wait for the owner: approvals first, then acceptances, then
// what has already been handled. Rows come from `company-todos`; the first nine
// fields are the ones the page always had, and the read route adds the rest:
//
// { id, card_kind: 'approval' | 'acceptance', state, title, project_name,
//   risk_text, requester, wait_minutes, opinion, project_id, ready, handled,
//   retry_available, suspended, stale, reason, reason_code, handled_at,
//   created_at, host_outcome, authorizer, host_reject_reason, risk_source,
//   host_risk_tier, approval_policy, host_preset, approval_id, answer_ref,
//   session_id, room_id, request_id, tool, target, acceptance_id, task_id,
//   submitted_version, acceptance_criteria, revision, owner_only,
//   requester_bot_id, coordinator_bot_id }

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
    case 'approved-human': return t('Approved')
    case 'approved-auto': return t('Allowed automatically')
    case 'returned': return t('Sent back')
    case 'rejected': return t('Rejected')
    case 'expired': return t('Expired')
    case 'cancelled': return t('Cancelled')
    case 'unavailable': return t('Host offline')
    case 'unobservable': return t('Awaiting receipt')
    case 'error': return t('Technical failure · retry later')
    default: return t('Handled')
  }
}

// A rejected approval carries the host's own words on its result row; the state
// word alone would drop the reason the request was not executed.
const resultWord = item => (item.card_kind === 'approval' && item.host_reject_reason
  ? item.host_reject_reason
  : stateLabel(item))

const metaOf = (item, handled) => {
  const approval = item.card_kind === 'approval'
  const parts = []
  if (item.project_name) parts.push(item.project_name)
  parts.push(approval ? t('Approval') : t('Acceptance review'))
  if (handled) parts.push(resultWord(item))
  else if (approval) {
    if (item.risk_text) parts.push(item.risk_text)
    parts.push(`${t('Waiting')} ${waitText(item.wait_minutes)}`)
  } else {
    if (item.requester) parts.push(t('Submitted by {name}', { name: item.requester }))
    // An acceptance is not a risk card, but its risk word belongs in the meta line
    // when the service sends one; the badge keeps showing the confirmation state.
    if (item.risk_text) parts.push(item.risk_text)
    parts.push(`${t('Waiting')} ${waitText(item.wait_minutes)}`)
  }
  return parts.join(' · ')
}

const badgeOf = (item, handled) => {
  if (handled) return resultWord(item)
  if (item.card_kind === 'approval') return item.risk_text || t('Needs your approval')
  return t('Pending')
}

// The service already words `reason` in the owner's language; these keys only
// stand in when a row arrives with a code but no sentence.
const REASON_KEYS = {
  suspended: 'Suspended · waiting',
  'host-pending': 'Awaiting receipt',
  'host-offline': 'Host offline',
  'error-retry': 'Technical failure · retry later',
  'private-chat': 'Please handle it in the private chat',
  expired: 'Expired',
  'policy-unknown': 'Policy unknown · manual approval',
  'authorizer-pending': 'Authorizer pending',
  'request-changed': 'Request changed · decide again',
  'owner-only': 'Only the owner can answer',
  unsynced: 'Not synced · reconcile later',
}

const reasonOf = item => {
  if (item.reason) return item.reason
  const key = REASON_KEYS[item.reason_code]
  return t(key ?? 'Cannot be answered here')
}

const byWait = (a, b) => (Number(b.wait_minutes) || 0) - (Number(a.wait_minutes) || 0)
  || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))

export function TodoPage({ todos = [], counts = null, read_at = null, loading = false, error = '', onRetry, actions = {} }) {
  const [noteFor, setNoteFor] = useState(null)
  const [draft, setDraft] = useState('')
  // A note is written first and travels with the decision; until then it stays
  // on this row and a refresh drops it (the service has no note-only state).
  const [notes, setNotes] = useState({})
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')

  const openNote = item => { setNoteFor(item.id); setDraft(notes[item.id] ?? '') }
  const saveNote = item => {
    const text = draft.trim()
    setNoteFor(null)
    setNotes(current => {
      const next = { ...current }
      if (text) next[item.id] = text
      else delete next[item.id]
      return next
    })
    actions.onNote?.(item, text)
  }

  const decide = async (item, action) => {
    if (busy) return
    const opinion = notes[item.id] ?? ''
    setBusy(item.id)
    setNotice('')
    try {
      const result = await actions.onDecide?.(item, action, { opinion })
      // A row answered elsewhere turns read-only; the row itself says so.
      if (!result?.stale) {
        setNotes(current => {
          const next = { ...current }
          delete next[item.id]
          return next
        })
      }
    } catch (failure) {
      // A card the host will not answer from this view keeps its place; the notice
      // stays neutral so a refused answer cannot read like a success.
      setNotice(failure?.code === 'todo/unsupported'
        ? t('This card cannot be answered from here.')
        : (failure?.message ?? String(failure)))
    } finally {
      setBusy('')
    }
  }

  const card = (item, handled = false) => {
    const approval = item.card_kind === 'approval'
    const title = item.title || ''
    const waiting = !handled
    const canDecide = waiting && item.ready === true && !item.stale
    const reasonRow = waiting && !item.stale && !item.ready
      ? (item.suspended
        ? h('div', { className: 'td-suspended' }, reasonOf(item))
        : h('p', { className: 'td-reason' }, reasonOf(item)))
      : null
    const investigate = h('button', {
      type: 'button',
      className: 'td-action',
      disabled: Boolean(busy) || (!item.coordinator_bot_id && !item.requester_bot_id && !item.session_id),
      onClick: () => actions.onInvestigate?.(item),
    }, t('Look into it'))
    const actionsRow = h('div', { className: 'td-actions', role: 'group', 'aria-label': t('Actions for {title}', { title }) },
      canDecide ? h('button', {
        type: 'button',
        className: 'td-action td-action-primary',
        disabled: busy === item.id,
        onClick: () => void decide(item, 'approve'),
      }, approval ? t('Agree') : t('Pass')) : null,
      canDecide ? h('button', {
        type: 'button',
        className: 'td-action',
        disabled: busy === item.id,
        onClick: () => void decide(item, 'return'),
      }, t('Return')) : null,
      investigate,
      canDecide ? h('button', {
        type: 'button',
        className: 'td-action td-action-text',
        disabled: busy === item.id,
        onClick: () => openNote(item),
      }, t('Add a note')) : null)
    return h('article', { key: item.id, className: handled ? 'td-card td-card-done' : 'td-card' },
      h('div', { className: 'td-card-top' },
        h('span', { className: 'td-icon', 'aria-hidden': true }, approval ? h(ShieldIcon) : h(CheckIcon)),
        h('div', { className: 'td-grow' },
          h('div', { className: 'td-title' }, title),
          h('div', { className: 'td-meta' }, metaOf(item, handled))),
        h('span', { className: 'bc-tag' }, badgeOf(item, handled)),
        // The only way into the project: the actions row never repeats it.
        item.project_id
          ? h('button', { type: 'button', className: 'td-link', onClick: () => actions.onOpenProject?.(item) }, t('View project'))
          : null),
      reasonRow,
      item.stale ? h('p', { className: 'td-reason' }, t('Handled elsewhere.')) : null,
      notes[item.id] && noteFor !== item.id
        ? h('p', { className: 'td-pending-note' }, `${t('Note')}: ${notes[item.id]}`)
        : null,
      actionsRow,
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
            if (event.key === 'Enter') { event.preventDefault(); saveNote(item) }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setNoteFor(null) }
          },
        }))
        : null)
  }

  const section = (key, label, count, items, handled = false, extra = null) => h('section', { key, className: 'td-section' },
    h('h2', null, `${t(label)} ${count}`),
    extra,
    items.map(item => card(item, handled)))

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

  const rows = Array.isArray(todos) ? todos : []
  const waiting = rows.filter(item => !item.handled)
  const handled = rows.filter(item => item.handled)
  const count = (key, fallback) => (Number.isInteger(counts?.[key]) ? counts[key] : fallback)
  const approvals = waiting.filter(item => item.card_kind === 'approval').sort(byWait)
  const acceptances = waiting.filter(item => item.card_kind === 'acceptance').sort(byWait)
  const approvalsCount = count('waiting_approvals', approvals.length)
  const acceptancesCount = count('waiting_acceptances', acceptances.length)
  const handledCount = count('handled_total', handled.length)
  const hasMore = handledCount > handled.length
  const nothingWaiting = approvalsCount === 0 && acceptancesCount === 0
  const body = nothingWaiting
    ? empty
    : h('div', { className: 'td-sections' },
      approvalsCount ? section('approvals', 'Approvals to confirm', approvalsCount, approvals) : null,
      acceptancesCount ? section('acceptances', 'Acceptances to confirm', acceptancesCount, acceptances) : null)
  // The service keeps the handled group in handled_at order; the page does not
  // re-sort it by wait time. The count is the full total, not just this window.
  const handledSection = handledCount > 0 || handled.length > 0
    ? section('handled', 'Handled', handledCount, handled, true,
      hasMore ? h('p', { className: 'td-note-more' }, t('Only the most recent {n} are shown.', { n: handled.length })) : null)
    : null

  return h('section', { className: 'bc-page td-page', 'aria-label': t('Todos'), 'data-read-at': read_at ?? undefined },
    h('div', { className: 'bc-head' },
      h('div', { className: 'bc-grow' },
        h('span', { className: 'bc-crumb' }, t('Workspace / Todos')),
        h('h1', null, t('Todos')))),
    loading ? skeleton
      : error ? failure
        : h('div', null,
          notice ? h('p', { className: 'td-notice', role: 'alert' }, notice) : null,
          body,
          handledSection))
}

export const TODO_CSS = `
.td-page{max-width:760px}
.td-sections{display:flex;flex-direction:column;gap:18px}
.td-section h2{font-size:var(--bc-text-heading);line-height:22px;font-weight:600;margin:0 0 8px}
.td-note-more{font-size:var(--bc-text-sm);line-height:16px;color:var(--bt-ink-3);margin:-4px 0 8px}
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
.td-suspended{margin:0 14px 10px;padding:8px 10px;border-radius:var(--bc-radius-field);background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:var(--bc-text-sm);line-height:16px}
.td-reason{font-size:var(--bc-text-sm);line-height:16px;color:var(--bt-ink-3);margin:0 14px 10px}
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
.td-pending-note{margin:0 14px 10px;font-size:var(--bc-text-sm);line-height:18px;color:var(--bt-ink-2)}
.td-note{margin:0 14px 12px}
.td-note input{width:100%;height:var(--bc-control-md);padding:0 11px;border:1px solid var(--bt-line-2);border-radius:var(--bc-radius-field);background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:var(--bc-text-content)}
.td-notice{margin:0 0 12px;padding:8px 10px;border-radius:var(--bc-radius-field);background:var(--bt-tag-bg);color:var(--bt-ink);font-size:var(--bc-text-sm);line-height:16px}
.td-skel-heading{width:30%;height:18px;margin-bottom:10px}
.td-skeleton .td-card-top{padding:12px 14px}
.td-skeleton .td-grow{display:grid;gap:8px}
@media(max-width:620px){
  .td-card-top{flex-wrap:wrap;padding:10px}
  .td-title,.td-meta{white-space:normal}
  .td-actions{margin:0 10px 10px}
  .td-suspended,.td-reason,.td-opinion,.td-pending-note,.td-note{margin:0 10px 10px}
}
`
