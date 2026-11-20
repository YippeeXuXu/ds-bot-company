import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

// Usage (M2 batch 3 / G3 3.6): who spent what, cut three ways. The company page carries
// only the entry; this panel reads `usage.summary` and shows one cut at a time. The
// numbers come from the host's usage ledger, so a call with no token count is shown as
// "counted only" rather than as a zero — the call happened, the tokens were not reported.

export const USAGE_CUTS = [
  { by: 'person', label: 'People' },
  { by: 'project', label: 'Projects' },
  { by: 'time', label: 'Time' },
]

export const USAGE_WINDOWS = [
  { days: 0, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
]

const DAY = 86_400_000

// The window a cut asks for. `days: 0` means "since local midnight", which is what a
// person means by today even when the server keeps its ledger in UTC.
export const usageWindow = (days, at = Date.now()) => {
  if (days > 0) return { from: at - days * DAY, to: at }
  const start = new Date(at)
  start.setHours(0, 0, 0, 0)
  return { from: start.getTime(), to: at }
}

export const usageTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

const number = value => new Intl.NumberFormat().format(Number(value) || 0)

const usageErrorText = failure => {
  const known = {
    'company/forbidden': 'You do not have permission to read usage.',
    'company/unsupported': 'This build has no usage ledger to read from yet.',
    'company/invalid': 'The window is not valid.',
  }[failure?.code]
  const text = known ? t(known) : failure?.message
  return text ? String(text) : t('Usage could not be read.')
}

const nameOf = (row, by) => by === 'person' ? row.name : by === 'project' ? row.name : row.day

const detailOf = (row, by) => {
  if (by === 'person') {
    if (row.status === 'disabled') return t('Dismissed')
    return row.bot_id ? t('Bot {bot}', { bot: row.bot_id }) : ''
  }
  if (by === 'project') return row.status === 'archived' ? t('Archived') : ''
  return ''
}

const cutLabel = by => t(USAGE_CUTS.find(cut => cut.by === by)?.label ?? 'People')

const nameHeading = by => by === 'person' ? t('Person') : by === 'project' ? t('Project') : t('Day')

export function UsagePanelView(props) {
  const { data, by, days, busy, error } = props
  const rows = data?.rows ?? []
  const totals = data?.totals ?? { calls: 0, tokens: 0 }
  const unattributed = data?.unattributed ?? { calls: 0, tokens: 0, reason: 'none' }

  const table = h('table', { className: 'bc-co-usage-table' },
    h('thead', null, h('tr', null,
      h('th', { scope: 'col' }, nameHeading(by)),
      h('th', { scope: 'col', className: 'bc-co-usage-num' }, t('Calls')),
      h('th', { scope: 'col', className: 'bc-co-usage-num' }, t('Tokens')))),
    h('tbody', null, rows.map(row => h('tr', { key: `${row.kind}-${row.employee_id ?? row.project_id ?? row.day}` },
      h('th', { scope: 'row' },
        h('span', { className: 'bc-co-usage-name' }, nameOf(row, by)),
        detailOf(row, by) ? h('span', { className: 'bc-co-usage-detail' }, detailOf(row, by)) : null),
      h('td', { className: 'bc-co-usage-num' }, number(row.calls)),
      h('td', { className: 'bc-co-usage-num' }, row.counted_only ? t('Counted only') : number(row.tokens))))),
    h('tfoot', null, h('tr', null,
      h('th', { scope: 'row' }, t('Total')),
      h('td', { className: 'bc-co-usage-num' }, number(totals.calls)),
      h('td', { className: 'bc-co-usage-num' }, number(totals.tokens)))))

  const note = () => {
    if (!(unattributed.calls > 0)) return null
    // A person cut cannot hold a group chat's calls, and a project cut cannot hold a Bot's
    // own chat before any task was dispatched. Say where the rest went instead of hiding it.
    const text = unattributed.reason === 'group'
      ? t('Group chats, not counted for a person: {calls} calls, {tokens} tokens', { calls: number(unattributed.calls), tokens: number(unattributed.tokens) })
      : t('Calls before any task was dispatched: {calls} calls, {tokens} tokens', { calls: number(unattributed.calls), tokens: number(unattributed.tokens) })
    return h('p', { className: 'bc-co-usage-note' }, text)
  }

  return h('div', { className: 'bc-co-pop bc-co-usage', role: 'dialog', 'aria-label': t('Usage'), 'aria-modal': 'true' },
    h('div', { className: 'bc-co-pop-head' },
      h('div', { className: 'bc-co-usage-titles' },
        h('span', { className: 'bc-co-pop-name' }, t('Usage')),
        h('span', { className: 'bc-co-usage-sub' }, t('Read from the host usage ledger'))),
      h('button', { type: 'button', className: 'bc-co-pop-close', 'aria-label': t('Close'), onClick: props.onClose }, '×')),
    h('div', { className: 'bc-co-usage-bar' },
      h('div', { className: 'bc-co-usage-seg', role: 'group', 'aria-label': t('Group by') },
        USAGE_CUTS.map(cut => h('button', {
          key: cut.by,
          type: 'button',
          className: 'bc-co-usage-seg-btn' + (by === cut.by ? ' is-on' : ''),
          'aria-pressed': by === cut.by,
          onClick: () => props.onCut(cut.by),
        }, t(cut.label)))),
      h('div', { className: 'bc-co-usage-seg', role: 'group', 'aria-label': t('Time range') },
        USAGE_WINDOWS.map(option => h('button', {
          key: option.days,
          type: 'button',
          className: 'bc-co-usage-seg-btn' + (days === option.days ? ' is-on' : ''),
          'aria-pressed': days === option.days,
          onClick: () => props.onWindow(option.days),
        }, t(option.label))))),
    busy ? h('p', { className: 'bc-co-usage-state', role: 'status' }, t('Reading usage…'))
      : error ? h('div', { className: 'bc-co-usage-state', role: 'alert' },
        h('p', null, error),
        h('button', { type: 'button', className: 'bc-button bc-button-sm', onClick: props.onRetry }, t('Retry')))
        : rows.length === 0 ? h('p', { className: 'bc-co-usage-state', role: 'status' }, t('No usage in this window yet.'))
          : h('div', { className: 'bc-co-usage-body' }, table, note()),
    h('p', { className: 'bc-co-usage-foot' }, t('{cut} · times shown in {zone}', { cut: cutLabel(by), zone: usageTimeZone() })))
}

export function UsagePanel(props) {
  const [by, setBy] = useState('person')
  const [days, setDays] = useState(30)
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!props.onRead) return undefined
    let live = true
    setBusy(true)
    setError('')
    const { from, to } = usageWindow(days)
    // A read, not a write: no operation key, and no model reload follows it.
    Promise.resolve(props.onRead('usage.summary', { by, from, to, time_zone: usageTimeZone() }))
      .then(body => { if (live) setData(body) })
      .catch(failure => { if (live) setError(usageErrorText(failure)) })
      .finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [by, days, attempt])

  return h(UsagePanelView, {
    data, by, days, busy, error,
    onClose: props.onClose,
    onCut: value => { setBy(value); setData(null) },
    onWindow: value => { setDays(value); setData(null) },
    onRetry: () => setAttempt(value => value + 1),
  })
}

export const COMPANY_USAGE_CSS = `
.bc-co-usage{position:absolute;left:50%;top:28px;transform:translateX(-50%);width:min(760px,calc(100% - 48px));max-height:calc(100% - 56px);display:flex;flex-direction:column;z-index:12}
.bc-co-usage-titles{display:flex;flex-direction:column;gap:2px;min-width:0}
.bc-co-usage-sub{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bc-co-usage-bar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--bt-line)}
.bc-co-usage-seg{display:inline-flex;padding:2px;border:1px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card)}
.bc-co-usage-seg-btn{border:0;background:none;padding:4px 10px;border-radius:6px;font:500 12px/18px var(--bt-font);color:var(--bt-ink-2);cursor:pointer}
.bc-co-usage-seg-btn:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bc-co-usage-seg-btn.is-on{background:var(--bt-ink);color:var(--bt-card)}
.bc-co-usage-seg-btn:focus-visible{outline:2px solid var(--bt-accent);outline-offset:1px}
.bc-co-usage-body{flex:1;min-height:0;overflow:auto;padding:4px 18px 12px}
.bc-co-usage-table{width:100%;border-collapse:collapse;font:400 13px/20px var(--bt-font);color:var(--bt-ink)}
.bc-co-usage-table th,.bc-co-usage-table td{padding:7px 8px;border-bottom:1px solid var(--bt-line);text-align:left;vertical-align:top}
.bc-co-usage-table thead th{font:500 12px/16px var(--bt-font);color:var(--bt-ink-3);border-bottom:1px solid var(--bt-line-2)}
.bc-co-usage-table tbody th{font-weight:500}
.bc-co-usage-table tfoot th,.bc-co-usage-table tfoot td{font-weight:600;border-bottom:0;border-top:1px solid var(--bt-line-2)}
.bc-co-usage-num{text-align:right;font-variant-numeric:tabular-nums}
.bc-co-usage-name{display:block}
.bc-co-usage-detail{display:block;font:400 11px/15px var(--bt-font);color:var(--bt-ink-3)}
.bc-co-usage-note{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.bc-co-usage-state{margin:0;padding:22px 18px;font-size:13px;color:var(--bt-ink-2)}
.bc-co-usage-state p{margin:0 0 10px}
.bc-co-usage-foot{flex:none;margin:0;padding:8px 18px 10px;border-top:1px solid var(--bt-line);font-size:11px;line-height:16px;color:var(--bt-ink-3)}
`
