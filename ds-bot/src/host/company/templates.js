// Employee templates (M1b-3.2): the job description, the instructions, the model and the
// skills a new Bot starts from. A template never holds permissions or a Bot's own memory —
// creating from it copies text and settings into the new Bot, then the employee profile
// points at that Bot.
//
// Two kinds live in one table. A builtin template comes with the plugin and is read-only;
// changing it means saving a copy, so an update never overwrites what the plugin ships.
//
// Since contract v1.18 a template also names its own kind (M2 batch 1): an `agent` template
// holds the job — duties, skills, model and thinking level — and a `soul` template holds the
// character, the voice and the values. A Bot is made from one of each (employee.create-from-
// template), and its instructions are the soul paragraph followed by the agent paragraph. Rows
// written before the split carry no `kind`; they are read as `agent`, which is what they were.
// The host capability names in `skills` are the ones `attach_capability` takes; whether a
// name exists is checked when a Bot is made from the template (3.4), not here, because the
// library can change after a template is saved.
import { randomUUID } from 'node:crypto'
import { companyFail } from './store.js'

export const TEMPLATE_SOURCES = ['builtin', 'custom']
// `agent` is the job; `soul` is the character. A kind is fixed when the row is made and is
// never edited afterwards — changing what a template is would silently change every Bot made
// from it, and the export format names the kind for the same reason.
export const TEMPLATE_KINDS = ['agent', 'soul']

const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`

const text = (value, field, { max = 120, min = 1 } = {}) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length < min) throw companyFail('company/invalid', `${field} is required.`, { field })
  if (trimmed.length > max) throw companyFail('company/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return trimmed
}

const optionalText = (value, field, max = 2000) => (value === undefined || value === null || value === '' ? undefined : text(value, field, { max }))

const nameKey = name => name.trim().toLowerCase()

const kindOf = (value, field = 'kind') => {
  if (value === undefined) return undefined
  const kind = text(value, field, { max: 40 })
  if (!TEMPLATE_KINDS.includes(kind)) throw companyFail('company/invalid', `${field} must be one of ${TEMPLATE_KINDS.join(', ')}.`, { field, value: kind })
  return kind
}

// A row from before the split has no kind. It was a job description, so it reads as `agent`
// everywhere — the view, the export and the hiring path all go through this one reading.
export const kindOfRow = template => (TEMPLATE_KINDS.includes(template.kind) ? template.kind : 'agent')

export const soulOf = (state, companyId, id) => {
  const template = templateOf(state, id)
  if (template.company_id !== companyId) throw companyFail('template/not-found', `No template ${id}.`, { template_id: id })
  if (template.status === 'archived') throw companyFail('template/archived', `Template ${template.name} is archived; pick another one.`, { template_id: template.id })
  if (kindOfRow(template) !== 'soul') throw companyFail('template/kind-mismatch', `Template ${template.name} is not a soul template.`, { template_id: template.id, field: 'soul_template_id', kind: kindOfRow(template) })
  return template
}

const companyOf = (state) => {
  const company = Object.values(state.companies).find(entry => entry.status !== 'archived')
  if (company === undefined) throw companyFail('company/not-found', 'Create the company before its templates.', {})
  return company
}

const templateOf = (state, id) => {
  const template = state.templates[text(id, 'template_id', { max: 120 })]
  if (template === undefined) throw companyFail('template/not-found', `No template ${id}.`, { template_id: id })
  return template
}

const activeTemplates = (state, companyId) => Object.values(state.templates)
  .filter(template => template.company_id === companyId && template.status !== 'archived')

const nameTaken = (state, companyId, name, exceptId) => activeTemplates(state, companyId)
  .some(template => template.id !== exceptId && nameKey(template.name) === nameKey(name))

// A capability name the team library can hold: lowercase letters, digits and hyphens, as
// the host validates them. Reserved words and unknown names are the host's call at create.
const capabilityName = (value, field) => {
  const name = text(value, field, { max: 32 })
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw companyFail('company/invalid', `${field} must be lowercase letters, digits and hyphens.`, { field, value: name })
  return name
}

const skillsOf = (value) => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw companyFail('company/invalid', 'skills is a list of capability names.', { field: 'skills' })
  if (value.length > 24) throw companyFail('company/invalid', 'skills holds at most 24 names.', { field: 'skills', max: 24 })
  const names = value.map((entry, index) => capabilityName(entry, `skills[${index}]`))
  if (new Set(names).size !== names.length) throw companyFail('company/invalid', 'skills lists a name twice.', { field: 'skills' })
  return names
}

// The content a copy takes from its origin, and the fields an edit can change. `role` and
// `name` are capped where `createBot` caps them, so a template can be written as it stands.
const contentOf = (payload, template = {}) => ({
  role: payload.role !== undefined ? optionalText(payload.role, 'role', 24) ?? null : template.role ?? null,
  instructions: payload.instructions !== undefined ? text(payload.instructions, 'instructions', { max: 8000, min: 0 }) : template.instructions ?? '',
  model: payload.model !== undefined ? optionalText(payload.model, 'model', 120) ?? null : template.model ?? null,
  effort: payload.effort !== undefined ? optionalText(payload.effort, 'effort', 40) ?? null : template.effort ?? null,
  skills: payload.skills !== undefined ? skillsOf(payload.skills) ?? [] : template.skills ?? [],
})

const EDITABLE = ['role', 'instructions', 'model', 'effort', 'skills']

export const templateView = template => ({ ...template, kind: kindOfRow(template), skills: [...(template.skills ?? [])], local_overrides: { ...template.local_overrides } })

export function templateHandlers() {
  return {
    'template.create': ({ state, payload, now }) => {
      const company = companyOf(state)
      const origin = payload.from_template_id === undefined ? undefined : templateOf(state, payload.from_template_id)
      const name = text(payload.name ?? (origin ? `${origin.name} 副本` : undefined), 'name', { max: 40 })
      if (nameTaken(state, company.id, name)) throw companyFail('template/name-taken', `A template named ${name} already exists.`, { field: 'name' })
      const content = contentOf(payload, origin)
      // A copy keeps its origin's kind: copying the company soul gives another soul, not a job.
      const kind = kindOf(payload.kind) ?? (origin === undefined ? 'agent' : kindOfRow(origin))
      const id = newId('tpl')
      state.templates[id] = {
        id,
        company_id: company.id,
        name,
        kind,
        ...content,
        version: 1,
        source: 'custom',
        origin_template_id: origin?.id ?? null,
        // A copy starts without local changes; edits made to it later are listed here.
        local_overrides: {},
        status: 'active',
        created_at: now(),
        updated_at: now(),
        revision: 1,
      }
      return { aggregate_id: id, body: { template: templateView(state.templates[id]) }, events: [{ type: 'template.created', data: { name, kind, source: 'custom', from: origin?.id ?? null } }] }
    },

    'template.update': ({ state, payload, now }) => {
      const template = templateOf(state, payload.template_id)
      if (template.source === 'builtin') throw companyFail('template/builtin-readonly', 'A builtin template is read-only; save a copy to change it.', { template_id: template.id })
      if (template.status === 'archived') throw companyFail('template/archived', `Template ${template.name} is archived.`, { template_id: template.id })
      let changed = false
      if (payload.name !== undefined) {
        const name = text(payload.name, 'name', { max: 40 })
        if (nameTaken(state, template.company_id, name, template.id)) throw companyFail('template/name-taken', `A template named ${name} already exists.`, { field: 'name' })
        if (name !== template.name) {
          template.name = name
          changed = true
        }
      }
      const content = contentOf(payload, template)
      for (const field of EDITABLE) {
        if (JSON.stringify(content[field]) === JSON.stringify(template[field])) continue
        template[field] = content[field]
        // A copy records what it no longer shares with its origin, so a later merge or a
        // screen can say which fields diverge.
        if (template.origin_template_id !== null) template.local_overrides[field] = true
        changed = true
      }
      if (!changed) return { aggregate_id: template.id, body: { template: templateView(template) }, mutates: false }
      template.version += 1
      template.revision += 1
      template.updated_at = now()
      return { aggregate_id: template.id, body: { template: templateView(template) }, events: [{ type: 'template.updated', data: { name: template.name, kind: kindOfRow(template), version: template.version } }] }
    },

    'template.archive': ({ state, payload, now }) => {
      const template = templateOf(state, payload.template_id)
      if (template.source === 'builtin') throw companyFail('template/builtin-readonly', 'A builtin template is read-only; it cannot be archived.', { template_id: template.id })
      if (template.status === 'archived') return { aggregate_id: template.id, body: { template: templateView(template) }, mutates: false }
      template.status = 'archived'
      template.revision += 1
      template.updated_at = now()
      return { aggregate_id: template.id, body: { template: templateView(template) }, events: [{ type: 'template.archived', data: { name: template.name } }] }
    },

    'template.list': ({ state }) => {
      const company = companyOf(state)
      const templates = activeTemplates(state, company.id)
        // Builtin templates lead: they are what a new company starts from, and a copy
        // keeps its place among the custom ones after that.
        .sort((left, right) => (left.source === right.source ? left.created_at - right.created_at : left.source === 'builtin' ? -1 : 1))
        .map(templateView)
      return { aggregate_id: company.id, body: { templates }, mutates: false }
    },
  }
}
