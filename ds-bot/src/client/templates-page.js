import { createElement as h, useEffect, useRef, useState } from 'react'
import { companyErrorText } from './company-page.js'
import { t } from './i18n.js'
import { installLeaveGuard } from './leave-guard.js'

// 3.3 / 3.4 — the employee template library. A template is a reusable job
// description: a job title, the instructions the Bot starts with, the model and
// thinking level it runs on, and the skills it needs. The page reads like a
// catalogue of spec sheets rather than a card grid: a quiet index on the left,
// and on the right the chosen template as a datasheet — fields across the top,
// the instructions set as a document below. The one primary action is making a
// Bot from the template in the department where it should work.

const ROLE_LABELS = () => [
  ['executor', t('Executor')],
  ['coordinator', t('Coordinator')],
  ['acceptor', t('Independent acceptor')],
  ['memory_keeper', t('Memory keeper')],
]

const STATUS_ORDER = item => (item.source === 'builtin' ? 0 : 1)

// B1: an edit is dirty when anything the user can type differs from what the
// template held when the editor opened. Trailing spaces do not count.
const EDITED_FIELDS = ['name', 'role', 'instructions', 'model', 'effort']

const sameSkills = (left = [], right = []) => {
  const a = [...left].sort()
  const b = [...right].sort()
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export const formDirty = (base, form) => {
  if (!base || !form) return false
  if (EDITED_FIELDS.some(field => String(form[field] ?? '').trim() !== String(base[field] ?? '').trim())) return true
  return !sameSkills(base.skills, form.skills)
}
export const sortedTemplates = templates => [...(templates ?? [])]
  .filter(item => item.status !== 'archived')
  .sort((left, right) => STATUS_ORDER(left) - STATUS_ORDER(right) || (left.created_at ?? 0) - (right.created_at ?? 0))

// Two kinds of template: an agent template says what the work is, a soul
// template says how the Bot talks and behaves. Rows written before kinds
// existed read as agent templates.
export const templateKind = template => (template?.kind === 'soul' ? 'soul' : 'agent')

// The left column shows a template's first sentence, so it can be recognised
// without opening it.
export const firstSentence = (text, limit = 42) => {
  const body = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!body) return ''
  const end = body.search(/[。！？.!?]/)
  const sentence = end >= 0 ? body.slice(0, end + 1) : body
  return sentence.length > limit ? `${sentence.slice(0, limit - 1)}…` : sentence
}

// The preview is asked for, not composed here: the host returns the exact text a
// Bot would be created with, soul paragraph first.
export const previewPayload = ({ templateId, soulTemplateId, name }) => {
  const payload = { template_id: templateId }
  if (soulTemplateId) payload.soul_template_id = soulTemplateId
  const wanted = String(name ?? '').trim()
  if (wanted) payload.name = wanted
  return payload
}

const fieldLabels = () => ({
  role: t('Job title'),
  instructions: t('Instructions'),
  model: t('Model'),
  effort: t('Thinking level'),
  skills: t('Skills'),
})

// The five fields a copy may carry a local change to. The host records the names
// it was given, so a short readable phrase is enough in the sheet's subline.
export const overrideText = template => {
  const names = Object.keys(template?.local_overrides ?? {})
  if (names.length === 0) return ''
  const labels = fieldLabels()
  return names.map(name => labels[name] ?? name).join(', ')
}

// The edit form's payload. Clearing a field is meaningful to the host: `null`
// drops a job title, model or thinking level, and an empty instruction text is
// kept as empty. Skills travel as a fresh list.
export const templateUpdatePayload = ({ templateId, name, role, instructions, model, effort, skills }) => ({
  template_id: templateId,
  name,
  role: role || null,
  instructions,
  model: model || null,
  effort: effort || null,
  skills: [...(skills ?? [])],
})

// Save a copy: the host names it "<the original> 副本" when no name is given,
// refuses a duplicate name and keeps the builtin untouched.
export const templateCopyPayload = (template, name) => {
  const payload = { from_template_id: template.id }
  const wanted = String(name ?? '').trim()
  if (wanted) payload.name = wanted
  return payload
}

// 3.4: one command makes the Bot, attaches the skills and writes the employee
// record. The department is the only field the host cannot infer; the employee
// name defaults to the template's own name, and the Bot name to the employee name.
export const createBotPayload = ({ templateId, soulTemplateId, departmentId, name, botName, acceptanceRole }) => {
  const payload = { template_id: templateId, department_id: departmentId }
  if (soulTemplateId) payload.soul_template_id = soulTemplateId
  const employee = String(name ?? '').trim()
  if (employee) payload.name = employee
  const bot = String(botName ?? '').trim()
  if (bot && bot !== employee) payload.bot_name = bot
  if (acceptanceRole) payload.acceptance_role = acceptanceRole
  return payload
}

// A refusal from the server carries a stable code. The ones a person can act on
// get a sentence in their own language; anything unknown keeps the server's words.
export const templateErrorText = failure => {
  const details = failure?.details ?? {}
  switch (failure?.code) {
    case 'template/name-taken':
      return t('A template with this name already exists. Pick another name.')
    case 'template/builtin-readonly':
      return t('A builtin template is read-only. Save a copy and change that.')
    case 'template/archived':
      return t('This template was archived. Pick another one.')
    case 'template/not-found':
      return t('This template is gone. Choose another one in the list.')
    case 'employee/bot-name-taken':
      return t('A Bot with this name already exists. Give this one another name.')
    case 'employee/capability-missing':
      return t('This DSH does not have these skills: {names}. Add them, or take them out of the template.', { names: (details.missing ?? []).join(', ') })
    case 'employee/capability-failed':
      return details.bot_left_behind
        ? t('The Bot was made but “{skill}” could not be attached, and it could not be removed again. Delete Bot {id} from the team yourself.', { skill: details.skill, id: details.bot_left_behind })
        : t('The Bot was made but “{skill}” could not be attached. It was removed again, so nothing is left behind.', { skill: details.skill })
    case 'employee/bot-create-failed':
      return t('The Bot could not be made: {message}', { message: failure.message })
    case 'template/kind-mismatch':
      return details.field === 'soul_template_id'
        ? t('An agent template was given where a soul template was expected. Pick a soul template for the voice.')
        : t('That is a soul template, not an agent template. Pick an agent template for the work.')
    case 'company/invalid':
      return failure.message
        ? t('The Bot could not be made: {message}', { message: failure.message })
        : t('The Bot could not be made with these values.')
    case 'employee/inactive':
      return t('This employee is dismissed. Reactivate them in the company chart first.')
    case 'employee/bot_already_employed':
      return t('This Bot already has an employee profile.')
  }
  const text = companyErrorText(failure)
  return text || t('The change could not be saved.')
}

// The thinking levels of the model a template names. The catalog carries them for
// the models Bots use; any other ref asks the host once and is remembered.
const effortCache = new Map()
function useEffortOptions(roster, ref, actions) {
  const served = (roster?.models ?? []).find(model => model.ref === ref)
  const embedded = served?.reasoning
  const [fetched, setFetched] = useState(undefined)
  useEffect(() => {
    setFetched(undefined)
    if (!ref || embedded?.efforts !== undefined || actions?.efforts === undefined) return undefined
    let live = true
    if (effortCache.has(ref)) setFetched(effortCache.get(ref))
    else {
      Promise.resolve(actions.efforts(ref)).then(value => {
        const reasoning = value?.efforts ? value : null
        effortCache.set(ref, reasoning)
        if (live) setFetched(reasoning)
      }).catch(() => {})
    }
    return () => { live = false }
  }, [ref, embedded?.efforts !== undefined, actions])
  return embedded ?? fetched
}

// Keep Tab inside a dialog card: a keyboard user should not tab into the page
// behind a modal, and Escape is handled by the page's escape guard.
const focusablesIn = box => [...(box?.querySelectorAll('button, input, select, textarea, a[href]') ?? [])]
  .filter(element => !element.disabled && element.getClientRects().length > 0)
function useModalFocus(open) {
  const card = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const box = card.current
    const first = focusablesIn(box)[0]
    first?.focus()
    const onKey = event => {
      if (event.key !== 'Tab' || !box) return
      const list = focusablesIn(box)
      if (list.length === 0) return
      const index = list.indexOf(document.activeElement)
      const next = event.shiftKey ? (index <= 0 ? list.length - 1 : index - 1) : (index === list.length - 1 || index < 0 ? 0 : index + 1)
      event.preventDefault()
      list[next].focus()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])
  return card
}

const skillNames = roster => new Set((roster?.capabilities ?? []).map(item => item.name))

export function TemplatesPageView(props) {
  const {
    templates = [], template = null, departments = [], roster = {}, loading = false,
    error = '', failure = '', preview = false, flash = '', form = null,
    copyOpen = false, copyName = '', botDialog = null, botPreview = null, archiveArmed = false, busy = false,
    effortOptions = [], leavePrompt = false, handlers = {},
  } = props
  const title = template ? template.source === 'builtin' ? t('Builtin template') : t('Saved copy') : ''
  const modalCard = useModalFocus(Boolean(botDialog))

  const skillsBlock = () => {
    const names = skillNames(roster)
    const skills = template?.skills ?? []
    if (skills.length === 0) return h('span', { className: 'bc-muted' }, t('No skills'))
    return h('span', { className: 'bc-tpl-skills' }, skills.map(name => h('span', {
      key: name,
      className: 'bc-tpl-skill' + (names.has(name) ? '' : ' is-missing'),
      title: names.has(name) ? undefined : t('This DSH does not have this skill yet. A Bot made from this template needs it.'),
    }, name, names.has(name) ? null : h('i', { 'aria-hidden': true }, '!'))))
  }

  const effortLabel = value => {
    if (!value) return t('Model default')
    return effortOptions.find(option => option.value === value)?.label ?? value
  }
  const modelName = ref => {
    if (!ref) return t('Model default')
    const served = (roster.models ?? []).find(model => model.ref === ref)
    return served ? served.name : t('{ref} (not served now)', { ref })
  }

  const sheet = () => {
    if (!template) return null
    const isSoul = templateKind(template) === 'soul'
    const actions = preview
      ? null
      : h('div', { className: 'bc-tpl-actions' },
        isSoul
          ? null
          : h('button', { type: 'button', className: 'bc-button bc-primary', onClick: () => handlers.onStartBot?.() }, t('Make a Bot')),
        template.source === 'builtin'
          ? h('button', { type: 'button', className: 'bc-button', onClick: () => handlers.onStartCopy?.() }, t('Save a copy'))
          : [
            h('button', { key: 'edit', type: 'button', className: 'bc-button', onClick: () => handlers.onStartEdit?.() }, t('Edit')),
            h('button', { key: 'copy', type: 'button', className: 'bc-button', onClick: () => handlers.onStartCopy?.() }, t('Save a copy')),
          ])
    const overrides = overrideText(template)
    const origin = templates.find(item => item.id === template.origin_template_id)
    const needsModel = Boolean(template.effort) && !template.model
    const editForm = () => h('form', {
      className: 'bc-tpl-form', onSubmit: event => { event.preventDefault(); handlers.onSave?.() },
    },
      h('div', { className: 'bc-grid' },
        h('label', { className: 'bc-field' }, t('Template name'),
          h('input', { value: form.name, maxLength: 40, required: true, onChange: event => handlers.onForm?.('name', event.target.value) })),
        h('label', { className: 'bc-field' }, t('Job title'),
          h('input', { value: form.role ?? '', maxLength: 24, onChange: event => handlers.onForm?.('role', event.target.value), placeholder: t('Optional, shown on the team list') }))),
      h('label', { className: 'bc-field' }, t('Instructions'),
        h('textarea', { value: form.instructions ?? '', maxLength: 8000, rows: 12, onChange: event => handlers.onForm?.('instructions', event.target.value), placeholder: t('What this job is responsible for, and how it works') })),
      h('div', { className: 'bc-grid' },
        h('label', { className: 'bc-field' }, t('Model'),
          h('select', { value: form.model ?? '', onChange: event => handlers.onForm?.('model', event.target.value) },
            h('option', { value: '' }, t('Model default')),
            (roster.models ?? []).map(model => h('option', { key: model.ref, value: model.ref }, model.name ?? model.ref)),
            form.model && !(roster.models ?? []).some(model => model.ref === form.model)
              ? h('option', { key: form.model, value: form.model }, t('{ref} (not served now)', { ref: form.model }))
              : null)),
        h('label', { className: 'bc-field' }, t('Thinking level'),
          h('select', { value: form.effort ?? '', onChange: event => handlers.onForm?.('effort', event.target.value) },
            effortOptions.map(option => h('option', { key: option.value || 'default', value: option.value }, option.label))))),
      h('div', { className: 'bc-field' }, h('span', null, t('Skills')),
        h('div', { className: 'bc-tpl-skills-edit' },
          [...new Set([...(roster.capabilities ?? []).map(item => item.name), ...(form.skills ?? [])])].map(name => h('button', {
            key: name, type: 'button', className: 'bc-chip', 'aria-pressed': (form.skills ?? []).includes(name),
            onClick: () => handlers.onToggleSkill?.(name),
          }, name))),
        h('small', null, t('The host refuses a Bot whose skills this DSH does not have. Marked skills are missing here.'))),
      failure ? h('p', { className: 'bc-exception', role: 'alert' }, failure) : null,
      h('div', { className: 'bc-actions' },
        h('button', { type: 'button', className: 'bc-button', onClick: () => handlers.onCancelEdit?.() }, t('Cancel')),
        h('button', { type: 'submit', className: 'bc-button bc-primary', disabled: busy || !String(form.name ?? '').trim() }, busy ? t('Saving…') : t('Save changes'))))

    return h('div', { className: 'bc-tpl-sheet' },
      h('div', { className: 'bc-tpl-sheet-head' },
        h('div', { className: 'bc-tpl-sheet-title' },
          h('span', { className: 'bc-kicker' }, title),
          h('h2', null, template.name),
          h('p', { className: 'bc-tpl-kind' }, isSoul ? t('Soul template') : t('Agent template')),
          template.source === 'builtin'
            ? h('p', { className: 'bc-tpl-note' }, t('This builtin template is read-only. Save a copy to change it.'))
            : h('p', { className: 'bc-tpl-note' }, origin
              ? t('Copied from {name}. {changes}', { name: origin.name, changes: overrides ? t('Local changes: {fields}.', { fields: overrides }) : t('No local changes yet.') })
              : t('This copy stands on its own.'))),
        actions),
      needsModel && !form
        ? h('p', { className: 'bc-exception', role: 'alert' }, t('This template sets a thinking level but no model, so making a Bot from it would be refused. Edit it and choose a model.'))
        : null,
      form ? editForm() : h('div', null,
        h('dl', { className: 'bc-tpl-spec' },
          h('div', null, h('dt', null, t('Job title')), h('dd', null, template.role || t('Not set'))),
          isSoul ? null : h('div', null, h('dt', null, t('Model')), h('dd', null, modelName(template.model))),
          isSoul ? null : h('div', null, h('dt', null, t('Thinking level')), h('dd', null, effortLabel(template.effort))),
          h('div', null, h('dt', null, t('Version')), h('dd', null, `v${template.version ?? 1}`)),
          isSoul ? null : h('div', { className: 'is-wide' }, h('dt', null, t('Skills')), h('dd', null, skillsBlock()))),
        isSoul
          ? h('p', { className: 'bc-tpl-note' }, t('A soul template carries the voice only: no model, no skills. The Bot is hired from an agent template, and this text comes before that one.'))
          : null,
        h('section', { className: 'bc-tpl-doc' },
          h('h3', { className: 'bc-detail-label' }, t('Instructions')),
          template.instructions
            ? h('div', { className: 'bc-tpl-doc-body' }, template.instructions)
            : h('div', { className: 'bc-tpl-doc-body is-empty' }, t('No instructions written yet.')))),
      copyOpen
        ? h('div', { className: 'bc-tpl-copyrow' },
          failure ? h('p', { className: 'bc-exception', role: 'alert' }, failure) : null,
          h('label', { className: 'bc-field' }, t('New template name'),
            h('input', {
              value: copyName, maxLength: 40, autoFocus: true,
              placeholder: t('{name} copy', { name: template.name }),
              onChange: event => handlers.onCopyName?.(event.target.value),
            })),
          h('div', { className: 'bc-actions' },
            h('button', { type: 'button', className: 'bc-button', onClick: () => handlers.onCancelCopy?.() }, t('Cancel')),
            h('button', { type: 'button', className: 'bc-button bc-primary', disabled: busy, onClick: () => handlers.onCopy?.() }, busy ? t('Saving…') : t('Save the copy'))))
        : null,
      !form && !copyOpen && failure ? h('p', { className: 'bc-exception', role: 'alert' }, failure) : null,
      form ? null : h('div', { className: 'bc-tpl-foot' },
        template.source === 'builtin'
          ? h('span', { className: 'bc-tpl-quiet' }, t('Builtin templates are read-only.'))
          : archiveArmed
            ? h('span', { className: 'bc-tpl-archive' },
              h('span', { className: 'bc-tpl-quiet' }, t('Archive “{name}”? Employees made from it keep their instructions.', { name: template.name })),
              h('button', { type: 'button', className: 'bc-button bc-danger', disabled: busy, onClick: () => handlers.onArchive?.() }, busy ? t('Archiving…') : t('Confirm archive')),
              h('button', { type: 'button', className: 'bc-button', onClick: () => handlers.onArchiveArm?.(false) }, t('Cancel')))
            : h('button', { type: 'button', className: 'bc-tpl-quiet bc-tpl-dangerbtn', onClick: () => handlers.onArchiveArm?.(true) }, t('Archive this template'))))
  }

  const body = () => {
    if (loading) return h('div', { className: 'bc-tpl-sheet bc-tpl-sheet-loading', role: 'status', 'aria-label': t('Loading templates…') },
      h('span', { className: 'bc-skel bc-skel-title' }), h('span', { className: 'bc-skel bc-skel-line' }), h('span', { className: 'bc-skel bc-skel-line' }), h('span', { className: 'bc-skel bc-skel-line short' }))
    if (error) {
      return h('div', { className: 'bc-state bc-error', role: 'alert' },
        h('strong', null, t('The templates could not be loaded.')),
        h('p', null, error),
        h('button', { type: 'button', className: 'bc-button', onClick: () => handlers.onRetry?.() }, t('Try again')))
    }
    if (templates.length === 0) {
      return h('div', { className: 'bc-state' },
        h('strong', null, t('No templates here yet')),
        h('p', null, t('Builtin templates come with the company; save a copy to keep one of your own.')))
    }
    return h('div', { className: 'bc-tpl-body' }, sheet())
  }

  return h('section', { className: 'bc-page bc-tpl-page', 'aria-label': t('Employee templates') },
    h('div', { className: 'bc-tpl-head' },
      h('div', { className: 'bc-grow' },
        h('div', { className: 'bc-crumb' }, t('Company'), ' · ', t('Templates')),
        h('h1', null, t('Employee templates')),
        h('p', { className: 'bc-sub' }, t('A template is a reusable job description: its instructions, model and skills. Pick one and make its Bot in a single step.'))),
      h('span', { className: 'bc-tpl-count' }, t('{count} templates', { count: templates.length }))),
    flash ? h('div', { className: 'bc-notice bc-tpl-flash', role: 'status' }, flash) : null,
    body(),
    leavePrompt ? leaveModal() : null,
    botDialog ? botModal() : null)

  function leaveModal() {
    const canSave = !busy && Boolean(String(form?.name ?? '').trim())
    return h('div', { className: 'bc-tpl-modal', role: 'presentation' },
      h('div', { className: 'bc-tpl-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Unsaved template changes'), ref: modalCard },
        h('div', { className: 'bc-co-pop-head' },
          h('strong', null, t('Save the changes to this template?')),
          h('span', { className: 'bc-co-pop-name' }, form?.name ?? '')),
        h('p', { className: 'bc-co-note' }, t('Leaving the editor now throws away what you typed. Save it, discard it, or keep editing.')),
        h('div', { className: 'bc-co-create-actions' },
          h('button', { type: 'button', className: 'bc-button', onClick: () => handlers.onLeaveCancel?.() }, t('Keep editing')),
          h('button', { type: 'button', className: 'bc-button', onClick: () => handlers.onLeaveDiscard?.() }, t('Discard changes')),
          h('button', { type: 'button', className: 'bc-button bc-primary', disabled: !canSave, onClick: () => handlers.onLeaveSave?.() },
            busy ? t('Saving…') : t('Save and leave')))))
  }

  function botModal() {
    const dialog = botDialog
    const agents = templates.filter(item => templateKind(item) === 'agent')
    const souls = templates.filter(item => templateKind(item) === 'soul')
    const chosenAgent = agents.find(item => item.id === dialog.templateId) ?? null
    const canMake = !busy && Boolean(dialog.templateId) && Boolean(dialog.departmentId) && Boolean(String(dialog.name ?? '').trim())
    const previewBody = botPreview?.loading
      ? h('p', { className: 'bc-tpl-quiet' }, t('Reading the preview…'))
      : botPreview?.error
        ? h('p', { className: 'bc-exception', role: 'alert' }, botPreview.error)
        : botPreview?.data
          ? (String(botPreview.data.instructions ?? '').trim()
            ? h('pre', { className: 'bc-tpl-preview-body' }, botPreview.data.instructions)
            : h('p', { className: 'bc-tpl-quiet' }, t('This pair gives the Bot no instructions yet.')))
          : h('p', { className: 'bc-tpl-quiet' }, t('Pick both templates to see the text the Bot will be given.'))
    const previewNames = [botPreview?.data?.soul?.name, botPreview?.data?.agent?.name].filter(Boolean).join(' + ')
    return h('div', { className: 'bc-tpl-modal' },
      h('div', { className: 'bc-tpl-modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('Make a Bot from templates'), ref: modalCard },
        h('div', { className: 'bc-co-pop-head' },
          h('strong', null, t('Make a Bot from templates')),
          chosenAgent ? h('span', { className: 'bc-co-pop-name' }, chosenAgent.name) : null,
          h('button', { type: 'button', className: 'bc-co-pop-close', 'aria-label': t('Close'), onClick: () => handlers.onBotCancel?.() }, '×')),
        h('p', { className: 'bc-tpl-note' }, t('The work first, the voice second: the Bot gets the agent template’s instructions, then the soul template’s text, and the two are joined word for word.')),
        h('div', { className: 'bc-co-create-fields' },
          h('label', { className: 'bc-field' }, t('Agent template'),
            h('select', {
              value: dialog.templateId ?? '', 'aria-label': t('Agent template'),
              onChange: event => handlers.onBotField?.('templateId', event.target.value),
            },
              h('option', { value: '' }, t('Choose an agent template')),
              agents.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
          h('label', { className: 'bc-field' }, t('Soul template'),
            souls.length === 0
              ? h('span', { className: 'bc-tpl-quiet' }, t('This company has no soul template yet, so the Bot is hired with the work text alone.'))
              : h('select', {
                value: dialog.soulTemplateId ?? '', 'aria-label': t('Soul template'),
                onChange: event => handlers.onBotField?.('soulTemplateId', event.target.value),
              },
                h('option', { value: '' }, t('Company default')),
                souls.map(item => h('option', { key: item.id, value: item.id }, item.name))))),
        h('section', { className: 'bc-tpl-preview', 'aria-label': t('Preview') },
          h('div', { className: 'bc-tpl-preview-head' },
            h('span', null, t('What the Bot will be told')),
            previewNames ? h('span', { className: 'bc-tpl-preview-sub' }, previewNames) : null),
          previewBody),
        h('div', { className: 'bc-co-create-fields' },
          h('label', { className: 'bc-field' }, t('Department'), h('select', {
            value: dialog.departmentId, onChange: event => handlers.onBotField?.('departmentId', event.target.value),
          },
            h('option', { value: '' }, t('Choose a department')),
            departments.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
          h('label', { className: 'bc-field' }, t('Employee display name'),
            h('input', { value: dialog.name, maxLength: 80, onChange: event => handlers.onBotField?.('name', event.target.value) })),
          h('label', { className: 'bc-field' }, t('Bot name'),
            h('input', { value: dialog.botName ?? '', maxLength: 40, onChange: event => handlers.onBotField?.('botName', event.target.value), placeholder: String(dialog.name ?? '').trim() || undefined, 'aria-invalid': dialog.errorField === 'bot_name' ? 'true' : undefined }),
            h('small', null, t('Leave empty to use the employee name.')),
            dialog.errorField === 'bot_name' && dialog.error
              ? h('small', { className: 'bc-tpl-inline-error', role: 'alert' }, dialog.error)
              : null),
          h('label', { className: 'bc-field' }, t('Employee role'), h('select', {
            value: dialog.acceptanceRole, onChange: event => handlers.onBotField?.('acceptanceRole', event.target.value),
          }, ROLE_LABELS().map(([value, label]) => h('option', { key: value, value }, label))))),
        dialog.error && dialog.errorField !== 'bot_name' ? h('p', { className: 'bc-exception', role: 'alert' }, dialog.error) : null,
        h('p', { className: 'bc-co-note' }, t('If a step fails, the Bot and the skills already attached are removed again, so nothing is left on the team.')),
        h('div', { className: 'bc-co-create-actions' },
          h('button', { type: 'button', className: 'bc-button', onClick: () => handlers.onBotCancel?.() }, t('Cancel')),
          h('button', { type: 'button', className: 'bc-button bc-primary', disabled: !canMake, onClick: () => handlers.onCreateBot?.() },
            busy ? t('Making the Bot…') : t('Make the Bot')))))
  }
}

export function TemplatesPage(props) {
  const { data, roster, preview, escapeGuard, onCommand } = props
  const templates = sortedTemplates(data?.templates)
  const departments = data?.departments ?? []
  const [selectedId, setSelectedId] = useState(null)
  const [form, setForm] = useState(null)
  const [copyOpen, setCopyOpen] = useState(false)
  const [copyName, setCopyName] = useState('')
  const [botDialog, setBotDialog] = useState(null)
  const [botPreview, setBotPreview] = useState(null)
  const previewSeq = useRef(0)
  const [archiveArmed, setArchiveArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [flash, setFlash] = useState('')
  const [leavePrompt, setLeavePrompt] = useState(null)
  const [formBase, setFormBase] = useState(null)
  const dirtyRef = useRef(false)

  const template = templates.find(item => item.id === (props.selectedId ?? selectedId)) ?? templates[0] ?? null
  const effortRef = form ? form.model : template?.model
  const reasoning = useEffortOptions(roster, effortRef ?? '', props.actions)
  const effortOptions = [
    { value: '', label: t('Model default') },
    ...(reasoning?.efforts ?? []).map(effort => ({ value: effort.id, label: effort.name ?? effort.id })),
  ]
  const shownEffort = form ? form.effort : template?.effort
  if (shownEffort && !effortOptions.some(option => option.value === shownEffort)) {
    effortOptions.push({ value: shownEffort, label: t('{id} (not in this model)', { id: shownEffort }) })
  }

  const dirty = formDirty(formBase, form)
  dirtyRef.current = dirty

  // Every way out of a dirty editor asks first: switching template, Cancel,
  // Escape, the page close button and leaving for another screen all land here.
  const requestLeave = proceed => {
    if (!dirtyRef.current) { proceed(); return }
    setLeavePrompt({ proceed })
  }

  const leaveNow = proceed => {
    dirtyRef.current = false
    setLeavePrompt(null)
    proceed()
  }

  const closeForm = () => { setForm(null); setFormBase(null); setFailure('') }
  const cancelEdit = () => requestLeave(closeForm)
  const applySelect = id => {
    setSelectedId(id)
    setForm(null)
    setFormBase(null)
    setCopyOpen(false)
    setArchiveArmed(false)
    setFailure('')
    setFlash('')
  }
  const select = id => requestLeave(() => {
    applySelect(id)
    props.onSelectTemplate?.(id)
  })

  const run = async (work, done) => {
    if (!onCommand) return
    setBusy(true)
    setFailure('')
    try { await work(); done?.() }
    catch (error) { setFailure(templateErrorText(error)) }
    finally { setBusy(false) }
  }

  const startEdit = () => {
    if (!template) return
    setFailure('')
    setCopyOpen(false)
    setArchiveArmed(false)
    const base = {
      name: template.name ?? '',
      role: template.role ?? '',
      instructions: template.instructions ?? '',
      model: template.model ?? '',
      effort: template.effort ?? '',
      skills: [...(template.skills ?? [])],
    }
    setForm(base)
    setFormBase({ ...base, skills: [...base.skills] })
  }

  const saveEdit = () => run(async () => {
    if (!form) return
    await onCommand('template.update', templateUpdatePayload({
      templateId: template.id,
      name: form.name.trim(),
      role: form.role,
      instructions: form.instructions,
      model: form.model,
      effort: form.effort,
      skills: form.skills,
    }))
    setForm(null)
    setFlash(t('The template was saved.'))
  })

  const startCopy = () => {
    setCopyName('')
    setCopyOpen(true)
    setArchiveArmed(false)
    setFailure('')
  }
  const saveCopy = () => run(async () => {
    const result = await onCommand('template.create', templateCopyPayload(template, copyName))
    const created = result?.body?.template
    setCopyOpen(false)
    if (created?.id) setSelectedId(created.id)
    setFlash(t('Saved as “{name}”.', { name: created?.name ?? copyName.trim() }))
  })

  // The dialog picks the two templates itself, so it also opens from a soul
  // template: the work comes from the first agent template in that case.
  const startBot = () => {
    setFailure('')
    const agents = templates.filter(item => templateKind(item) === 'agent')
    const souls = templates.filter(item => templateKind(item) === 'soul')
    const chosen = templateKind(template) === 'agent' ? template : agents[0] ?? null
    const dialog = {
      templateId: chosen?.id ?? '',
      soulTemplateId: souls[0]?.id ?? '',
      departmentId: departments[0]?.id ?? '',
      name: chosen?.name ?? '',
      botName: '',
      acceptanceRole: 'executor',
      error: '',
      errorField: '',
    }
    setBotDialog(dialog)
    loadPreview(dialog)
  }

  // The preview is asked for, not composed here: the host returns the exact text
  // the Bot would be created with. Only the answer to the last request is kept.
  const loadPreview = async dialog => {
    if (!onCommand || !dialog?.templateId) { setBotPreview(null); return }
    const seq = previewSeq.current + 1
    previewSeq.current = seq
    setBotPreview({ loading: true, error: '', data: null })
    try {
      const result = await onCommand('employee.preview-from-template', previewPayload(dialog))
      if (previewSeq.current !== seq) return
      setBotPreview({ loading: false, error: '', data: result?.body ?? null })
    } catch (error) {
      if (previewSeq.current !== seq) return
      setBotPreview({ loading: false, error: templateErrorText(error), data: null })
    }
  }

  const botField = (field, value) => {
    const current = botDialog
    if (!current) return
    const next = { ...current, [field]: value, error: '', errorField: '' }
    setBotDialog(next)
    if (field === 'templateId' || field === 'soulTemplateId') loadPreview(next)
  }

  const botCancel = () => {
    previewSeq.current += 1
    setBotPreview(null)
    setBotDialog(null)
  }
  // 3.4: the dialog stays open when the host refuses, so the reason is read next to
  // the values it is about; a success closes it and says what the team now has.
  const createBot = async () => {
    if (!onCommand || busy || !botDialog) return
    setBusy(true)
    setBotDialog(current => current ? { ...current, error: '' } : current)
    try {
      const result = await onCommand('employee.create-from-template', createBotPayload({
        templateId: botDialog.templateId,
        soulTemplateId: botDialog.soulTemplateId,
        departmentId: botDialog.departmentId,
        name: botDialog.name,
        botName: botDialog.botName,
        acceptanceRole: botDialog.acceptanceRole,
      }))
      const bot = result?.body?.bot
      previewSeq.current += 1
      setBotPreview(null)
      setBotDialog(null)
      setFlash(t('“{name}” is on the team with {count} skills.', { name: bot?.name ?? botDialog.name.trim(), count: (bot?.skills ?? []).length }))
    } catch (error) {
      const errorField = error?.code === 'employee/bot-name-taken' ? 'bot_name' : ''
      setBotDialog(current => current ? { ...current, error: templateErrorText(error), errorField } : current)
    } finally { setBusy(false) }
  }

  const leaveSaving = async () => {
    const prompt = leavePrompt
    if (!prompt || !form || !onCommand) return
    setBusy(true)
    setFailure('')
    try {
      await onCommand('template.update', templateUpdatePayload({
        templateId: template.id,
        name: form.name.trim(),
        role: form.role,
        instructions: form.instructions,
        model: form.model,
        effort: form.effort,
        skills: form.skills,
      }))
      setFlash(t('The template was saved.'))
      dirtyRef.current = false
      setForm(null)
      setFormBase(null)
      setLeavePrompt(null)
      prompt.proceed()
    } catch (error) {
      setLeavePrompt(null)
      setFailure(templateErrorText(error))
    } finally { setBusy(false) }
  }

  const archive = () => run(async () => {
    await onCommand('template.archive', { template_id: template.id })
    setArchiveArmed(false)
    setSelectedId(null)
    setFlash(t('The template was archived.'))
  })

  // The surface gives Escape to the page first: the question closes, then the
  // dialogs, then the editor (asking when it is dirty). The page leaves last.
  if (escapeGuard) {
    escapeGuard.current = () => {
      if (leavePrompt) { setLeavePrompt(null); return true }
      if (botDialog) { setBotDialog(null); return true }
      if (form) { cancelEdit(); return true }
      if (copyOpen) { setCopyOpen(false); return true }
      if (archiveArmed) { setArchiveArmed(false); return true }
      return false
    }
  }

  // The page close button, the sidebar and the other surfaces all go through the
  // shared guard, so a dirty editor stops them before it is unmounted.
  useEffect(() => {
    if (!form) return
    return installLeaveGuard(proceed => {
      if (!dirtyRef.current) return false
      setLeavePrompt({ proceed })
      return true
    })
  }, [form])

  // A browser reload or tab close cannot show a custom question; the native one
  // is the only ask the platform gives us there.
  useEffect(() => {
    if (!dirty) return
    const warn = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  return h(TemplatesPageView, {
    templates,
    template,
    departments,
    roster,
    loading: props.loading,
    error: props.error,
    failure,
    preview,
    flash,
    form,
    copyOpen,
    copyName,
    botDialog,
    botPreview,
    archiveArmed,
    busy,
    effortOptions,
    leavePrompt: Boolean(leavePrompt),
    handlers: {
      onSelect: select,
      onRetry: props.onRetry,
      onStartEdit: startEdit,
      onCancelEdit: cancelEdit,
      onForm: (field, value) => setForm(current => current ? { ...current, [field]: value } : current),
      onToggleSkill: name => setForm(current => {
        if (!current) return current
        const skills = current.skills ?? []
        return { ...current, skills: skills.includes(name) ? skills.filter(item => item !== name) : [...skills, name] }
      }),
      onSave: saveEdit,
      onStartCopy: startCopy,
      onCancelCopy: () => setCopyOpen(false),
      onCopyName: setCopyName,
      onCopy: saveCopy,
      onStartBot: startBot,
      onBotCancel: botCancel,
      onBotField: botField,
      onCreateBot: createBot,
      onArchiveArm: setArchiveArmed,
      onArchive: archive,
      onLeaveSave: leaveSaving,
      onLeaveDiscard: () => { const prompt = leavePrompt; if (!prompt) return; closeForm(); leaveNow(prompt.proceed) },
      onLeaveCancel: () => setLeavePrompt(null),
    },
  })
}

export const TEMPLATES_CSS = `
.bc-tpl-page{display:flex;flex-direction:column;min-height:0;container:bc-tpl/inline-size}
.bc-tpl-head{display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;margin:0 0 6px}
.bc-tpl-head .bc-grow{flex:1;min-width:220px}
.bc-tpl-head h1{font-size:17px;line-height:24px;font-weight:600;margin:4px 0 0}
.bc-tpl-count{font-size:12px;line-height:18px;color:var(--bt-ink-3);white-space:nowrap;padding-bottom:2px}
.bc-tpl-flash{margin:10px 0 4px;border:1px solid var(--bt-line);border-radius:8px;justify-content:flex-start;padding:9px 12px}
.bc-tpl-body{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:start;margin-top:12px}
.bc-tpl-index{border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);overflow:hidden;min-height:120px}
.bc-tpl-group-block+.bc-tpl-group-block{border-top:1px solid var(--bt-line)}
.bc-tpl-group{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:13px 14px 5px;font-size:11px;line-height:16px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--bt-ink-3)}
.bc-tpl-group .bc-tpl-count{padding:0}
.bc-tpl-item{display:flex;width:100%;gap:10px;align-items:center;padding:9px 14px;border:0;border-left:2px solid transparent;background:none;color:var(--bt-ink);text-align:left;font:inherit;cursor:pointer}
.bc-tpl-item:hover{background:var(--bt-hover)}
.bc-tpl-item[aria-current="true"]{background:var(--bt-active);border-left-color:var(--bt-accent)}
.bc-tpl-item-main{flex:1;min-width:0;display:grid;gap:2px}
.bc-tpl-item-main strong{font-size:13px;line-height:18px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-tpl-item-main small{font-size:11px;line-height:15px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-tpl-item-mark{flex:none;font-size:10px;line-height:15px;color:var(--bt-ink-3);border:1px solid var(--bt-line-2);border-radius:4px;padding:0 4px}
.bc-tpl-row{display:grid;gap:6px;padding:14px}
.bc-tpl-sheet{position:relative;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);padding:20px 22px 18px;box-shadow:var(--bc-shadow-raised)}
.bc-tpl-sheet-loading{display:grid;gap:10px;min-height:220px}
.bc-tpl-sheet-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.bc-tpl-sheet-title{flex:1;min-width:240px}
.bc-tpl-sheet-title h2{font-size:20px;line-height:27px;font-weight:600;margin:3px 0 0;letter-spacing:-.012em;overflow-wrap:anywhere}
.bc-tpl-note{margin:5px 0 0;font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bc-tpl-inline-error{margin-top:5px;font-size:12px;line-height:17px;color:var(--bt-danger)}
.bc-tpl-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;padding-top:2px}
.bc-tpl-spec{margin:0 0 18px;border-top:1px solid var(--bt-line);border-bottom:1px solid var(--bt-line);display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.bc-tpl-spec>div{min-width:0;padding:9px 14px 11px 0}
.bc-tpl-spec>div+div{padding-left:14px;border-left:1px solid var(--bt-line)}
.bc-tpl-spec>div.is-wide{grid-column:1/-1;padding:9px 0 11px;border-left:0;border-top:1px solid var(--bt-line)}
.bc-tpl-spec dt{font-size:10px;line-height:15px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--bt-ink-3)}
.bc-tpl-spec dd{margin:3px 0 0;font-size:13px;line-height:19px;color:var(--bt-ink);overflow-wrap:anywhere}
.bc-tpl-doc h3{margin:0 0 8px}
.bc-tpl-doc-body{max-width:70ch;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.72;color:var(--bt-ink);padding-left:14px;border-left:2px solid var(--bt-line-2);max-height:46vh;overflow:auto}
.bc-tpl-doc-body.is-empty{color:var(--bt-ink-3);font-style:italic}
.bc-tpl-skills{display:flex;flex-wrap:wrap;gap:5px}
.bc-tpl-skill{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border:1px solid var(--bt-line-2);border-radius:999px;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bc-tpl-skill.is-missing{border-style:dashed;border-color:var(--bt-danger);color:var(--bt-ink)}
.bc-tpl-skill i{font-style:normal;color:var(--bt-danger);font-weight:700}
.bc-tpl-form{display:grid;gap:12px;margin-top:2px;padding-top:14px;border-top:1px solid var(--bt-line)}
.bc-tpl-form textarea{font-family:var(--bt-font);line-height:1.62;resize:vertical}
.bc-tpl-skills-edit{display:flex;flex-wrap:wrap;gap:6px;max-height:132px;overflow:auto;padding:2px}
.bc-tpl-copyrow{display:grid;gap:10px;margin-top:14px;padding:12px 14px;border:1px dashed var(--bt-line-2);border-radius:10px;background:var(--bt-main)}
.bc-tpl-copyrow .bc-actions{margin-top:0}
.bc-tpl-foot{display:flex;align-items:center;gap:10px;margin-top:16px;padding-top:12px;border-top:1px solid var(--bt-line);min-height:32px}
.bc-tpl-quiet{font-size:12px;line-height:17px;color:var(--bt-ink-3);border:0;background:none;padding:0}
.bc-tpl-kind{display:inline-block;margin:6px 0 0;padding:1px 7px;border:1px solid var(--bt-line-2);border-radius:999px;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bc-tpl-preview{margin:12px 0 0;padding:10px 12px;border:1px solid var(--bt-line);border-radius:10px;background:var(--bt-hover)}
.bc-tpl-preview-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 6px;font-size:12px;line-height:17px;font-weight:600;color:var(--bt-ink-2)}
.bc-tpl-preview-sub{font-weight:400;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bc-tpl-preview-body{margin:0;max-height:20vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:12px;line-height:1.65;color:var(--bt-ink)}
.bc-tpl-dangerbtn{color:var(--bt-danger);font-weight:600;cursor:pointer;border-radius:6px;padding:6px 2px}
.bc-tpl-dangerbtn:hover{background:var(--bt-hover)}
.bc-tpl-archive{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bc-tpl-modal{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb,var(--bt-ink) 34%,transparent);animation:bc-tpl-fade .12s ease-out}
.bc-tpl-modal-card{width:min(440px,100%);max-height:calc(100vh - 48px);overflow:auto;padding:18px 18px 16px;border:1px solid var(--bt-line-2);border-radius:12px;background:var(--bt-card);box-shadow:0 24px 64px -16px color-mix(in srgb,var(--bt-ink) 38%,transparent);animation:bc-tpl-rise .14s ease-out}
@keyframes bc-tpl-fade{from{opacity:0}to{opacity:1}}
@keyframes bc-tpl-rise{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.bc-tpl-modal,.bc-tpl-modal-card{animation:none}}
/* The host sidebar takes width the window query cannot see: measure this page itself. */
@container bc-tpl (max-width:780px){.bc-tpl-body{grid-template-columns:1fr}.bc-tpl-spec{grid-template-columns:repeat(2,minmax(0,1fr))}.bc-tpl-spec>div:nth-child(3){border-left:0;padding-left:0}.bc-tpl-spec>div:nth-child(n+3){border-top:1px solid var(--bt-line)}.bc-tpl-actions{justify-content:flex-start}.bc-tpl-doc-body{max-height:none}}
@container bc-tpl (max-width:520px){.bc-tpl-spec{grid-template-columns:1fr}.bc-tpl-spec>div+div{padding-left:0;border-left:0;border-top:1px solid var(--bt-line)}.bc-tpl-item small{white-space:normal}}
`
