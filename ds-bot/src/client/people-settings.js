// People and permissions (M2 batch 3 / G3 3.5, contract v1.19).
//
// The settings page over `actor.list`, `actor.invite`, `actor.update`,
// `grant.create` and `grant.revoke`: who is in the company, whether they are
// still around, and what each person may do in the whole company or in one
// project.
//
// The owner row is shown but never edited. The owner already holds every
// permission, so `actor.update` and `grant.create` refuse that row; the page
// mirrors the refusal instead of offering buttons that would bounce back.
//
// A grant is not a property of the person: one row names one scope and the
// permissions it carries, so the same person can dispatch in one project and be
// refused in the next. The list therefore groups grants per person and never
// adds them up into a "role".
//
// Not here: signing in, passwords, invitations that reach another machine
// (batch 6). A person invited here exists in the company record; how she reaches
// the company is a later batch.
import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { t } from './i18n.js'

// The five permissions in PRD order, with what each one lets a person do. `view`
// is everyone's from the start (`DEFAULT_PERMISSIONS` in access.js), so only the
// other four are ever granted here.
export const PEOPLE_PERMISSIONS = [
  ['view', 'View data', 'Read the company, its projects, tasks and templates.'],
  ['dispatch', 'Dispatch tasks', 'Create tasks, move them, and hand work to a Bot.'],
  ['accept', 'Accept work', 'Decide a delivery that is waiting for acceptance.'],
  ['configure', 'Change settings', 'Change the company, departments, projects and templates.'],
  ['members', 'Manage people', 'Invite people, suspend them, and grant permissions.'],
]
const GRANTABLE = PEOPLE_PERMISSIONS.slice(1).map(([name]) => name)
export const PERMISSION_LABEL = Object.fromEntries(PEOPLE_PERMISSIONS.map(([name, label]) => [name, label]))

const freshKey = () => globalThis.crypto?.randomUUID?.() ?? `company-people-${Date.now()}-${Math.random().toString(36).slice(2)}`

// Only the fields each command names: the server rejects the rest, and a value
// the row did not have would read as a change.
export const invitePayload = name => ({ name: String(name ?? '').trim() })
export const statusPayload = (actor, status) => ({ actor_id: actor.id, expected_revision: actor.revision, status })
export const grantPayload = ({ actorId, scopeType, projectId, permissions }) => {
  const payload = { actor_id: actorId, scope_type: scopeType, permissions: [...permissions] }
  if (scopeType === 'project') payload.scope_id = projectId ?? ''
  return payload
}
export const revokePayload = grant => ({ grant_id: grant.id, expected_revision: grant.revision })

// The page shows the command's own failure in the language of the interface:
// the codes are stable, the server's English text is not worth a translator.
export const peopleErrorText = failure => {
  const details = failure?.details ?? {}
  const code = failure?.code
  if (code === 'company/forbidden') {
    const missing = Array.isArray(details.missing) ? details.missing.filter(name => PERMISSION_LABEL[name] !== undefined) : []
    return missing.length === 0
      ? t('You do not have permission to do this.')
      : t('This needs the {permissions} permission. Ask the owner for it.', { permissions: missing.map(name => t(PERMISSION_LABEL[name])).join(' · ') })
  }
  if (code === 'actor/name-taken') return t('Someone in the company already has this name, suspended people included.')
  if (code === 'actor/inactive') return t('This person is suspended. Restore her before granting permissions.')
  if (code === 'actor/immutable-field') return t('The owner holds every permission; this row cannot be changed.')
  if (code === 'actor/not-found') return t('That person is no longer here. The list has been refreshed.')
  if (code === 'grant/exists') return t('This person already has a grant in that scope. Revoke it first to change it.')
  if (code === 'grant/not-found') return t('That grant is gone. The list has been refreshed.')
  if (code === 'company/revision-conflict') return t('Someone else changed this row. Load the page again and retry.')
  if (code === 'project/not-found') return t('That project no longer exists.')
  if (code === 'company/invalid') return t('That change did not pass the check.')
  return failure?.message || t('The change could not be saved.')
}

export const permissionOrder = names => PEOPLE_PERMISSIONS.map(([name]) => name).filter(name => (names ?? []).includes(name))

export const grantScopeText = (grant, projects) => {
  if (grant.scope_type === 'company') return t('Whole company')
  const project = (projects ?? []).find(row => row.id === grant.scope_id)
  return project ? t('Project: {name}', { name: project.name }) : t('A project')
}

const initialOf = name => {
  const trimmed = String(name ?? '').trim()
  return trimmed === '' ? '?' : [...trimmed][0].toUpperCase()
}

function Card({ title, children }) {
  return h('section', { className: 'bt-set-section' }, title ? h('h3', null, title) : null, h('div', { className: 'bt-set-card' }, children))
}

function permissionChip(name) {
  return h('span', { key: name, className: 'bt-ppl-chip' }, t(PERMISSION_LABEL[name]))
}

function Face({ name }) {
  return h('span', { className: 'bt-ppl-face', 'aria-hidden': 'true' }, initialOf(name))
}

export function InviteSection({ name, busy, onChange, onInvite }) {
  const inviting = busy === 'invite'
  return h(Card, { title: t('Invite a member') },
    h('form', { className: 'bt-ppl-invite', onSubmit: event => { event.preventDefault(); if (name.trim() !== '') onInvite() } },
      h('label', { className: 'bt-ppl-invite-copy', htmlFor: 'bt-ppl-invite-name' },
        h('span', { className: 'bt-ppl-label' }, t('Name')),
        h('span', { className: 'bt-set-hint' }, t('Signs in on this device with her own name. Names are unique, suspended people included.'))),
      h('span', { className: 'bt-set-control bt-ppl-invite-control' },
        h('input', {
          id: 'bt-ppl-invite-name', className: 'bt-input bt-ppl-invite-input', type: 'text', value: name, maxLength: 60,
          placeholder: t('Name'), 'aria-label': t('Name'), autoComplete: 'off', spellCheck: false,
          onChange: event => onChange(event.target.value),
        }),
        h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: inviting || name.trim() === '' }, inviting ? t('Inviting…') : t('Invite')))))
}

export function GrantForm({ projects, busy, onSubmit, onCancel }) {
  const [scopeType, setScopeType] = useState('company')
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [picked, setPicked] = useState([])
  const [error, setError] = useState('')
  const toggle = name => setPicked(list => (list.includes(name) ? list.filter(item => item !== name) : [...list, name]))
  const submit = async event => {
    if (event?.preventDefault) event.preventDefault()
    if (picked.length === 0) { setError(t('Choose at least one permission.')); return }
    if (scopeType === 'project' && projectId === '') { setError(t('Choose a project.')); return }
    const failure = await onSubmit({ scopeType, projectId, permissions: permissionOrder(picked) })
    if (failure) setError(failure)
  }
  const scopeChoice = (value, label) => h('label', { key: value, className: 'bt-ppl-check' },
    h('input', { type: 'radio', name: 'bt-ppl-scope', checked: scopeType === value, onChange: () => setScopeType(value) }),
    h('span', null, label))
  return h('form', { className: 'bt-ppl-form', onSubmit: submit },
    h('div', { className: 'bt-ppl-field' },
      h('span', { className: 'bt-ppl-label' }, t('Applies to')),
      h('div', { className: 'bt-ppl-choices', role: 'radiogroup', 'aria-label': t('Applies to') },
        scopeChoice('company', t('Whole company')),
        scopeChoice('project', t('One project')))),
    scopeType === 'project'
      ? h('label', { className: 'bt-ppl-field' },
        h('span', { className: 'bt-ppl-label' }, t('Project')),
        h('select', {
          className: 'bt-select', value: projectId, 'aria-label': t('Project'),
          onChange: event => setProjectId(event.target.value),
        },
        projects.length === 0
          ? h('option', { value: '' }, t('No active project'))
          : projects.map(row => h('option', { key: row.id, value: row.id }, row.name))))
      : null,
    h('div', { className: 'bt-ppl-field' },
      h('span', { className: 'bt-ppl-label' }, t('Permissions')),
      h('div', { className: 'bt-ppl-choices' }, GRANTABLE.map(name => h('label', { key: name, className: 'bt-ppl-check' },
        h('input', { type: 'checkbox', checked: picked.includes(name), onChange: () => toggle(name) }),
        h('span', null, t(PERMISSION_LABEL[name])))))),
    error ? h('p', { className: 'bt-error bt-ppl-form-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-ppl-form-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onCancel }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: busy }, busy ? t('Granting…') : t('Grant'))))
}

// One grant row: its scope, the permissions it carries, and the way to take it
// back. Revoking is armed first like the other destructive rows in settings: the
// row itself has to be re-read (`expected_revision`), so a stray click would
// otherwise bounce off a stale revision.
function grantRow(actor, grant, { projects, busy, confirm, onArm, onRevoke }) {
  const armed = confirm?.kind === 'grant' && confirm.id === grant.id
  const scope = grantScopeText(grant, projects)
  return h('div', { key: grant.id, className: 'bt-ppl-grant' },
    h('span', { className: 'bt-ppl-scope' }, scope),
    h('span', { className: 'bt-ppl-chips' },
      permissionOrder(grant.permissions).length > 0
        ? permissionOrder(grant.permissions).map(name => permissionChip(name))
        : h('span', { className: 'bt-set-hint' }, t('No permission in this grant.'))),
    h('button', {
      type: 'button',
      className: armed ? 'bt-ppl-revoke is-armed' : 'bt-ppl-revoke',
      disabled: busy === `revoke:${grant.id}`,
      'data-confirm': armed || undefined,
      'aria-label': armed ? t('Click again to revoke {scope}.', { scope }) : t('Revoke {scope}', { scope }),
      onClick: () => (armed ? onRevoke(actor, grant) : onArm({ kind: 'grant', id: grant.id })),
    }, armed ? t('Revoke?') : t('Revoke')))
}

function statusButton(actor, { busy, confirm, onArm, onStatus }) {
  const disabled = actor.status === 'disabled'
  const armed = confirm?.kind === 'status' && confirm.id === actor.id
  const busyKey = `status:${actor.id}`
  return h('button', {
    type: 'button',
    className: armed ? 'bt-soft bt-soft-sm bt-ppl-danger is-armed' : disabled ? 'bt-soft bt-soft-sm' : 'bt-soft bt-soft-sm bt-ppl-danger',
    disabled: busy === busyKey,
    'data-confirm': armed || undefined,
    'aria-pressed': armed || undefined,
    title: armed ? t('Click again to suspend her. Her profile and history stay.') : disabled ? t('Back in the company, with the same grants.') : undefined,
    onClick: () => {
      if (disabled) { onStatus(actor, 'active'); return }
      if (armed) { onStatus(actor, 'disabled'); return }
      onArm({ kind: 'status', id: actor.id })
    },
  }, disabled ? t('Restore') : armed ? t('Confirm suspend') : t('Suspend'))
}

function personRow(actor, props) {
  const disabled = actor.status === 'disabled'
  const grants = actor.grants ?? []
  const open = props.openGrant === actor.id
  const granting = props.busy === `grant:${actor.id}`
  return h('div', { key: actor.id, className: 'bt-ppl-person', 'data-disabled': disabled || undefined },
    h('div', { className: 'bt-ppl-head' },
      h(Face, { name: actor.name }),
      h('span', { className: 'bt-ppl-who' },
        h('span', { className: 'bt-ppl-name' }, actor.name),
        h('span', { className: 'bt-ppl-meta' },
          disabled ? t('Suspended') : grants.length === 0 ? t('No grants yet') : t('{n} in force', { n: grants.length }))),
      h('span', { className: 'bt-ppl-acts' },
        disabled ? null : h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: props.busy !== '' && !granting,
          'aria-expanded': open, 'aria-label': open ? t('Close the grant form') : t('Grant {name} more permissions', { name: actor.name }),
          onClick: () => props.onOpenGrant(open ? '' : actor.id),
        }, open ? t('Close') : t('Grant')),
        statusButton(actor, props))),
    h('div', { className: 'bt-ppl-grants' },
      grants.length === 0
        ? h('p', { className: 'bt-ppl-hint' }, t('Everyone can view data. Nothing else is granted yet.'))
        : grants.map(grant => grantRow(actor, grant, props))),
    open ? h(GrantForm, {
      projects: props.projects, busy: granting,
      onSubmit: fields => props.onGrant(actor, fields),
      onCancel: () => props.onOpenGrant(''),
    }) : null)
}

function ownerRow(actor) {
  return h('div', { key: actor.id, className: 'bt-ppl-person bt-ppl-owner' },
    h('div', { className: 'bt-ppl-head' },
      h(Face, { name: actor.name }),
      h('span', { className: 'bt-ppl-who' },
        h('span', { className: 'bt-ppl-name' }, actor.name, h('span', { className: 'bt-tag bt-ppl-tag' }, t('Owner'))),
        h('span', { className: 'bt-ppl-meta' }, t('This device’s owner'))),
      h('span', { className: 'bt-ppl-acts' }, h('span', { className: 'bt-set-hint' }, t('Not editable')))),
    h('div', { className: 'bt-ppl-grants' }, h('span', { className: 'bt-ppl-chips' },
      PEOPLE_PERMISSIONS.map(([name]) => permissionChip(name)))),
    h('p', { className: 'bt-ppl-hint' }, t('Every permission, always. The owner row cannot be renamed, suspended or granted.')))
}

export function MembersSection({ actors, projects, busy = '', confirm = null, openGrant = '', onArm, onOpenGrant, onGrant, onRevoke, onStatus }) {
  const people = actors ?? []
  const owner = people.find(actor => actor.kind === 'owner')
  const humans = people.filter(actor => actor.kind === 'human')
  const props = { projects, busy, confirm, openGrant, onArm, onOpenGrant, onGrant, onRevoke, onStatus }
  return h(Card, { title: t('Members · {n}', { n: people.length }) },
    owner ? ownerRow(owner) : null,
    humans.map(actor => personRow(actor, props)),
    humans.length === 0 ? h('p', { className: 'bt-ppl-hint' }, t('Nobody else is here yet. Invite someone above.')) : null,
    owner ? null : h('p', { className: 'bt-ppl-hint bt-error' }, t('The company record has no owner row. This is a data problem, not a permission one.')))
}

export function PermissionGuide() {
  return h(Card, { title: t('What each permission allows') },
    PEOPLE_PERMISSIONS.map(([name, label, hint]) => h('div', { key: name, className: 'bt-ppl-guide' },
      h('span', { className: 'bt-ppl-guide-name' }, t(label)),
      h('span', { className: 'bt-set-hint' }, t(hint)))),
    h('p', { className: 'bt-ppl-hint bt-ppl-guide-foot' }, t('Everyone starts with view data; the other four are granted above. The owner holds all five.')))
}

export function PeoplePage() {
  const [actors, setActors] = useState(null)
  const [projects, setProjects] = useState([])
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState('')
  const [confirm, setConfirm] = useState(null)
  const [openGrant, setOpenGrant] = useState('')
  const [invite, setInvite] = useState('')

  // The page reads two things: the people (a command, so it can refuse) and the
  // projects a grant can point at (the read model). A failed project read is not
  // worth a whole error page, so the grant form then offers the company scope only.
  useEffect(() => {
    const controller = new AbortController()
    setLoadError('')
    Promise.all([
      call('company-command', { command: 'actor.list', payload: { operation_key: freshKey() } }, controller.signal),
      call('company-model', {}, controller.signal).catch(() => null),
    ]).then(([result, model]) => {
      if (controller.signal.aborted) return
      setActors(Array.isArray(result?.body?.actors) ? result.body.actors : [])
      setProjects((model?.projects ?? []).filter(row => row.status !== 'archived'))
    }).catch(failure => {
      if (controller.signal.aborted) return
      setActors([])
      setLoadError(peopleErrorText(failure))
    })
    return () => controller.abort()
  }, [attempt])

  // Both kinds of confirmation fall back on their own after a moment, the way
  // every other two-step button in settings does.
  useEffect(() => {
    if (confirm === null) return undefined
    const timer = setTimeout(() => setConfirm(null), 4000)
    return () => clearTimeout(timer)
  }, [confirm])

  useEffect(() => {
    if (notice === null) return undefined
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  // A failure shows once: the grant form keeps its own error line beside the
  // controls, everything else reports at the top of the page.
  const send = async (command, fields, busyKey, quiet = false) => {
    setBusy(busyKey)
    setConfirm(null)
    try {
      await call('company-command', { command, payload: { ...fields, operation_key: freshKey() } })
      setAttempt(value => value + 1)
      return null
    } catch (failure) {
      const text = peopleErrorText(failure)
      if (!quiet) setNotice({ tone: 'bad', text })
      return text
    } finally {
      setBusy('')
    }
  }

  const invitePerson = async () => {
    const name = invite.trim()
    if (name === '') return
    const failure = await send('actor.invite', invitePayload(name), 'invite')
    if (failure !== null) return
    setInvite('')
    setNotice({ tone: 'good', text: t('{name} is in the company now.', { name }) })
  }

  const setStatus = async (actor, status) => {
    const failure = await send('actor.update', statusPayload(actor, status), `status:${actor.id}`)
    if (failure !== null) return
    setNotice({
      tone: 'good',
      text: status === 'disabled'
        ? t('{name} is suspended. Her profile and history stay.', { name: actor.name })
        : t('{name} is back, with the grants she had.', { name: actor.name }),
    })
  }

  const createGrant = async (actor, fields) => {
    const failure = await send('grant.create', grantPayload({
      actorId: actor.id, scopeType: fields.scopeType, projectId: fields.projectId, permissions: fields.permissions,
    }), `grant:${actor.id}`, true)
    if (failure !== null) return failure
    setOpenGrant('')
    setNotice({ tone: 'good', text: t('{name} can do that now.', { name: actor.name }) })
    return null
  }

  const revokeGrant = async (actor, grant) => {
    const failure = await send('grant.revoke', revokePayload(grant), `revoke:${grant.id}`)
    if (failure !== null) return
    setNotice({ tone: 'good', text: t('Revoked {name}’s grant for {scope}.', { name: actor.name, scope: grantScopeText(grant, projects) }) })
  }

  const retry = () => { setActors(null); setAttempt(value => value + 1) }

  const members = loadError !== ''
    ? h('section', { className: 'bt-set-section', key: 'members' }, h('h3', null, t('Members')), h('div', { className: 'bt-set-card' },
      h('div', { className: 'bt-ppl-empty' },
        h('p', { className: 'bt-error', role: 'alert' }, loadError),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: retry }, t('Try again')))))
    : h(MembersSection, {
      key: 'members', actors, projects, busy, confirm, openGrant,
      onArm: setConfirm,
      onOpenGrant: setOpenGrant,
      onGrant: createGrant,
      onRevoke: revokeGrant,
      onStatus: setStatus,
    })

  return [
    notice === null ? null : h('p', {
      key: 'notice',
      className: notice.tone === 'bad' ? 'bt-ppl-notice bt-ppl-notice-bad' : 'bt-ppl-notice',
      role: notice.tone === 'bad' ? 'alert' : 'status',
    }, notice.text),
    h(InviteSection, { key: 'invite', name: invite, busy, onChange: setInvite, onInvite: invitePerson }),
    actors === null && loadError === ''
      ? h('section', { key: 'members', className: 'bt-set-section' }, h('h3', null, t('Members')), h('div', { className: 'bt-set-card' },
        h('p', { className: 'bt-ppl-empty', role: 'status' }, t('Loading…'))))
      : members,
    h(PermissionGuide, { key: 'guide' }),
  ].filter(Boolean)
}

export const PEOPLE_CSS = `
.bt-ppl-notice{margin:0;padding:8px 12px;border-radius:10px;background:var(--bt-hover);font-size:13px;line-height:18px}
.bt-ppl-notice-bad{background:color-mix(in srgb,var(--bt-danger) 8%,transparent);color:var(--bt-danger)}
.bt-ppl-invite{display:flex;align-items:center;gap:12px;padding:10px 12px}
.bt-ppl-invite-copy{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0;cursor:text}
.bt-ppl-invite-control{flex:none}
.bt-ppl-invite-input{flex:none;width:200px}
.bt-ppl-label{font-size:13px;line-height:18px;font-weight:500}
.bt-ppl-empty{margin:0;padding:12px;display:flex;flex-direction:column;align-items:flex-start;gap:8px;font-size:13px;line-height:18px}
.bt-ppl-person{display:flex;flex-direction:column;gap:8px;padding:12px}
.bt-ppl-head{display:flex;align-items:center;gap:10px}
.bt-ppl-face{flex:none;width:28px;height:28px;border-radius:999px;display:grid;place-items:center;background:var(--bt-hover);color:var(--bt-ink-2);font-size:12px;font-weight:600}
.bt-ppl-who{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}
.bt-ppl-name{display:flex;align-items:center;gap:6px;font-size:13px;line-height:18px;font-weight:500;overflow-wrap:anywhere}
.bt-ppl-meta{font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-ppl-tag{flex:none}
.bt-ppl-acts{flex:none;display:flex;align-items:center;gap:6px}
.bt-ppl-danger{color:var(--bt-danger)}
.bt-soft.bt-ppl-danger.is-armed{background:color-mix(in srgb,var(--bt-danger) 12%,transparent)}
.bt-ppl-grants{display:flex;flex-direction:column;gap:6px;padding-left:38px}
.bt-ppl-grant{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:16px}
.bt-ppl-scope{flex:none;font-weight:500;color:var(--bt-ink)}
.bt-ppl-chips{display:flex;flex:1;flex-wrap:wrap;align-items:center;gap:4px;min-width:0}
.bt-ppl-chip{font-size:12px;line-height:16px;padding:1px 6px;border-radius:4px;background:var(--bt-tag-bg);color:var(--bt-tag-ink);white-space:nowrap}
.bt-ppl-revoke{flex:none;height:22px;padding:0 6px;border:0;border-radius:6px;background:none;color:var(--bt-ink-3);font:inherit;font-size:12px;cursor:pointer}
.bt-ppl-revoke:hover{background:color-mix(in srgb,var(--bt-danger) 10%,transparent);color:var(--bt-danger)}
.bt-ppl-revoke.is-armed{background:color-mix(in srgb,var(--bt-danger) 12%,transparent);color:var(--bt-danger);font-weight:600}
.bt-ppl-revoke:disabled{opacity:.4;cursor:default}
.bt-ppl-form{display:flex;flex-direction:column;gap:10px;margin-left:38px;padding:12px;border-radius:10px;background:var(--bt-hover)}
.bt-ppl-field{display:flex;flex-direction:column;gap:6px}
.bt-ppl-choices{display:flex;flex-wrap:wrap;gap:6px 16px}
.bt-ppl-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;line-height:18px;cursor:pointer}
.bt-ppl-check input{margin:0;accent-color:var(--bt-accent)}
.bt-ppl-form-error{margin:0}
.bt-ppl-form-foot{display:flex;justify-content:flex-end;gap:8px}
.bt-ppl-hint{margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-2)}
.bt-ppl-guide{display:flex;gap:12px;padding:10px 12px;font-size:13px;line-height:18px}
.bt-ppl-guide-name{flex:none;width:96px;font-weight:500}
.bt-ppl-guide-foot{padding:10px 12px;border-top:.5px solid var(--bt-line)}
@media (max-width:820px){
  .bt-ppl-invite{flex-direction:column;align-items:stretch;gap:8px}
  .bt-ppl-invite-input{flex:1 1 auto;width:auto;min-width:0}
  .bt-ppl-invite-control{display:flex;gap:8px}
  .bt-ppl-grants{padding-left:0}
  .bt-ppl-form{margin-left:0}
  .bt-ppl-guide{flex-direction:column;gap:2px}
  .bt-ppl-guide-name{width:auto}
}
@media (prefers-reduced-motion:reduce){.bt-ppl-chip{transition:none}}
`
