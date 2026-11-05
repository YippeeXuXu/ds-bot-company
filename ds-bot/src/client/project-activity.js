import { t } from './i18n.js'
import { waitText } from './wait-text.js'

// Reading surfaces for one project's waiting decisions and company events (C-02,
// spec v0.4.1 §1). Everything here returns display strings: raw kinds, ids and
// operation keys never reach the drawer, and unknown events are dropped silently
// instead of being shown as an audit log.

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const PENDING_IN_DRAWER = 5
const PENDING_PINNED = 3
const ACTIVITY_IN_DRAWER = 5

// Relative time in the words the project list already uses (§1.2).
export const agoText = (at, now = Date.now()) => {
  if (!Number.isFinite(at)) return ''
  const ago = Math.max(0, now - at)
  if (ago < MINUTE) return t('Just now')
  if (ago < HOUR) return `${Math.max(1, Math.round(ago / MINUTE))} ${t('minutes ago')}`
  if (ago < DAY) return `${Math.max(1, Math.round(ago / HOUR))} ${t('hours ago')}`
  if (ago < 7 * DAY) return `${Math.max(1, Math.floor(ago / DAY))} ${t('days ago')}`
  const date = new Date(at)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

const nameOf = (names, employeeId) => {
  const known = names instanceof Map ? names.get(employeeId) : names?.[employeeId]
  return typeof known === 'string' && known.trim() ? known.trim() : ''
}

// The nine kinds the drawer may show (§1.2); anything else stays out of view.
const ACTIVITY_KINDS = new Map([
  ['project.created', () => t('Project created')],
  ['project.updated', () => t('Project details updated')],
  ['project.started', () => t('Project started')],
  ['project.archived', () => t('Project archived')],
  ['project.member.added', (data, names) => t('{name} joined the project', { name: nameOf(names, data?.employee_id) || t('Member') })],
  ['project.member.removed', (data, names) => t('{name} left the project', { name: nameOf(names, data?.employee_id) || t('Member') })],
  ['project.group.bound', () => t('Project group bound')],
  ['acceptance.submitted', (data, names) => {
    const name = nameOf(names, data?.employee_id)
    return name ? t('{name} submitted an acceptance', { name }) : t('Acceptance submitted')
  }],
  ['acceptance.decided', data => (data?.decision === 'return' ? t('Acceptance sent back') : t('Acceptance passed'))],
])

export const activityLine = (event, context = {}) => {
  const format = ACTIVITY_KINDS.get(event?.type)
  if (!format) return null
  const text = format(event?.data ?? {}, context.names)
  if (!text) return null
  const when = agoText(event?.at, context.now)
  return when ? `${text} · ${when}` : text
}

// `company-events` returns { cursor, events, has_more }; only the newest five lines
// are shown, newest first (§1.2). Sort here as well so an oldest-first answer, or a
// server that ignores `order`, still ends up as the latest five lines.
export const activityLines = (body, context = {}) => {
  const events = Array.isArray(body?.events) ? body.events : []
  const stamp = event => (Number.isFinite(event?.at) ? event.at : Number(event?.cursor) || 0)
  return events
    .slice()
    .sort((a, b) => stamp(b) - stamp(a))
    .map(event => activityLine(event, context))
    .filter(line => typeof line === 'string' && line.length > 0)
    .slice(0, ACTIVITY_IN_DRAWER)
}

const KIND_TEXT = { approval: 'Approval', acceptance: 'Acceptance review' }

const byWait = (a, b) => (Number(b?.wait_minutes) || 0) - (Number(a?.wait_minutes) || 0)

// The number the status bar, the pinned card and the drawer all show: this project's
// waiting_total from the same read, never a second counter (§0, §2).
export const waitingTotal = todos => {
  const counts = todos?.counts ?? {}
  return Number.isFinite(counts.waiting_total) ? counts.waiting_total : 0
}

// `sub` carries the type and waiting time (and the reason when the row is blocked);
// the drawer renders it under the title, so the card markup needs no change (§1.1).
export const pendingRow = (item, onOpen) => {
  const parts = [t(KIND_TEXT[item?.card_kind] ?? 'Approval')]
  if (Number.isFinite(item?.wait_minutes)) parts.push(`${t('Waiting')} ${waitText(item.wait_minutes)}`)
  if (item?.ready === false) {
    parts.push(t('Suspended · waiting'))
    if (typeof item?.reason === 'string' && item.reason.trim()) parts.push(item.reason.trim())
  }
  return { id: item?.id ?? '', title: item?.title ?? '', who: parts.join(' · '), onOpen }
}

export const pendingRows = (todos, onOpen) => {
  const waiting = Array.isArray(todos?.waiting) ? todos.waiting : []
  return waiting.slice().sort(byWait).slice(0, PENDING_IN_DRAWER).map(item => pendingRow(item, onOpen))
}

export const pinnedRows = todos => {
  const waiting = Array.isArray(todos?.waiting) ? todos.waiting : []
  return waiting.slice().sort(byWait).slice(0, PENDING_PINNED).map(item => pendingRow(item, null))
}
