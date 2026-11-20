// Employee templates travel between profiles as one file (M1b-3.5). The file names its
// format and version so a later plugin can read it, and it holds only the job text and the
// settings a template owns — never permissions, credentials or a Bot's memory.
//
// Import validates the whole file before writing anything: a file that is wrong in one
// template is refused entire, so a half-imported set of jobs cannot look like success on
// the second profile. A name that already exists is skipped, not overwritten: two profiles
// disagreeing about one job description is a silent loss of whichever edit came second.
import { randomUUID } from 'node:crypto'
import { companyFail } from './store.js'
import { TEMPLATE_KINDS } from './templates.js'

export const TEMPLATE_FILE_FORMAT = 'ds-company/templates'
// v2 adds `kind` to every entry (contract v1.18). A v1 file still imports: its rows were all
// job templates, so they are read as `agent`. Export always writes the current version.
export const TEMPLATE_FILE_VERSION = 2
export const TEMPLATE_FILE_VERSIONS = [1, 2]

const MAX_FILE_TEMPLATES = 200

const newId = prefix => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`

const nameKey = name => name.trim().toLowerCase()

const companyOf = (state) => {
  const company = Object.values(state.companies).find(entry => entry.status !== 'archived')
  if (company === undefined) throw companyFail('company/not-found', 'Create the company before its templates.', {})
  return company
}

const activeTemplates = (state, companyId) => Object.values(state.templates)
  .filter(template => template.company_id === companyId && template.status !== 'archived')

// What travels: the fields a template can own, copied as they stand. `source` is written
// for a reader, not for the importer — an imported row is always a custom template, because
// the plugin's builtin rows belong to the profile it ships in.
const entryOf = template => ({
  name: template.name,
  kind: TEMPLATE_KINDS.includes(template.kind) ? template.kind : 'agent',
  role: template.role,
  instructions: template.instructions,
  model: template.model,
  effort: template.effort,
  skills: [...(template.skills ?? [])],
  source: template.source,
  version: template.version,
})

const bad = (index, field, message) => {
  throw companyFail('template/import-invalid', message, { index, field })
}

const textOf = (value, index, field, { min = 1, max = 120 } = {}) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length < min) bad(index, field, `${field} is required.`)
  if (trimmed.length > max) bad(index, field, `${field} is longer than ${max} characters.`)
  return trimmed
}

const optionalTextOf = (value, index, field, max) => (value === undefined || value === null || value === '' ? null : textOf(value, index, field, { max }))

const skillsOf = (value, index) => {
  if (value === undefined) return []
  if (!Array.isArray(value)) bad(index, `templates[${index}].skills`, 'skills is a list of capability names.')
  if (value.length > 24) bad(index, `templates[${index}].skills`, 'skills holds at most 24 names.')
  const names = value.map((entry, at) => {
    const field = `templates[${index}].skills[${at}]`
    const name = textOf(entry, index, field, { max: 32 })
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) bad(index, field, `${field} must be lowercase letters, digits and hyphens.`)
    return name
  })
  if (new Set(names).size !== names.length) bad(index, `templates[${index}].skills`, 'skills lists a name twice.')
  return names
}

const kindOf = (raw, index) => {
  if (raw === undefined || raw === null || raw === '') return 'agent'
  const field = `templates[${index}].kind`
  const kind = textOf(raw, index, field, { max: 40 })
  if (!TEMPLATE_KINDS.includes(kind)) bad(index, field, `${field} must be one of ${TEMPLATE_KINDS.join(', ')}.`)
  return kind
}

const templateOf = (raw, index) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) bad(index, 'templates[]', 'Each template is an object.')
  const at = field => `templates[${index}].${field}`
  return {
    name: textOf(raw.name, index, at('name'), { max: 40 }),
    kind: kindOf(raw.kind, index),
    role: optionalTextOf(raw.role, index, at('role'), 24),
    instructions: raw.instructions === undefined || raw.instructions === null ? '' : textOf(raw.instructions, index, at('instructions'), { min: 0, max: 8000 }),
    model: optionalTextOf(raw.model, index, at('model'), 120),
    effort: optionalTextOf(raw.effort, index, at('effort'), 40),
    skills: skillsOf(raw.skills, index),
  }
}

// A whole file in, whole file judged. Both an object and its JSON text are accepted so a
// screen can pass the parsed file it read and a script can pass what the file held.
const fileOf = (payload) => {
  let file = payload.file
  if (file === undefined && typeof payload.text === 'string') {
    try {
      file = JSON.parse(payload.text)
    } catch {
      throw companyFail('template/import-invalid', 'The import file is not valid JSON.', { index: null, field: 'text' })
    }
  }
  if (file === null || typeof file !== 'object' || Array.isArray(file)) {
    throw companyFail('template/import-invalid', 'The import file is an object with format, version and templates.', { index: null, field: 'file' })
  }
  if (file.format !== TEMPLATE_FILE_FORMAT) {
    throw companyFail('template/import-invalid', `The file format must be ${TEMPLATE_FILE_FORMAT}.`, { index: null, field: 'format', expected: TEMPLATE_FILE_FORMAT })
  }
  if (!TEMPLATE_FILE_VERSIONS.includes(file.version)) {
    throw companyFail('template/import-invalid', `The file version must be ${TEMPLATE_FILE_VERSIONS.join(' or ')}.`, { index: null, field: 'version', expected: TEMPLATE_FILE_VERSION })
  }
  if (!Array.isArray(file.templates)) {
    throw companyFail('template/import-invalid', 'The file has no templates list.', { index: null, field: 'templates' })
  }
  if (file.templates.length === 0) {
    throw companyFail('template/import-invalid', 'The file holds no templates.', { index: null, field: 'templates' })
  }
  if (file.templates.length > MAX_FILE_TEMPLATES) {
    throw companyFail('template/import-invalid', `A file holds at most ${MAX_FILE_TEMPLATES} templates.`, { index: null, field: 'templates', max: MAX_FILE_TEMPLATES })
  }
  return file.templates
}

export function templateIoHandlers() {
  return {
    'template.export': ({ state, payload, now }) => {
      const company = companyOf(state)
      let templates
      if (payload.template_ids === undefined) {
        templates = activeTemplates(state, company.id)
          .sort((left, right) => (left.source === right.source ? left.created_at - right.created_at : left.source === 'builtin' ? -1 : 1))
      } else {
        if (!Array.isArray(payload.template_ids) || payload.template_ids.length === 0) {
          throw companyFail('company/invalid', 'template_ids is a non-empty list of template ids.', { field: 'template_ids' })
        }
        if (payload.template_ids.length > MAX_FILE_TEMPLATES) {
          throw companyFail('company/invalid', `template_ids holds at most ${MAX_FILE_TEMPLATES} ids.`, { field: 'template_ids', max: MAX_FILE_TEMPLATES })
        }
        // A repeated id means one template, not two rows: keep the first mention so the
        // requested order survives and the file never carries a template twice.
        const ids = payload.template_ids.map(id => (typeof id === 'string' ? id.trim() : id))
        templates = [...new Set(ids)].map((id) => {
          const template = state.templates[typeof id === 'string' ? id : '']
          if (template === undefined || template.company_id !== company.id) throw companyFail('template/not-found', `No template ${id}.`, { template_id: id })
          if (template.status === 'archived') throw companyFail('template/archived', `Template ${template.name} is archived.`, { template_id: id })
          return template
        })
      }
      const file = {
        format: TEMPLATE_FILE_FORMAT,
        version: TEMPLATE_FILE_VERSION,
        exported_at: new Date(now()).toISOString(),
        templates: templates.map(entryOf),
      }
      return { aggregate_id: company.id, body: { file }, mutates: false }
    },

    'template.import': ({ state, payload, now }) => {
      const company = companyOf(state)
      const entries = fileOf(payload).map(templateOf)
      const taken = new Set(activeTemplates(state, company.id).map(template => nameKey(template.name)))
      const imported = []
      const skipped = []
      entries.forEach((entry, index) => {
        const key = nameKey(entry.name)
        if (taken.has(key)) {
          // A duplicate inside the file lands here too: the first row wins and the second
          // says so, rather than two rows racing to own one name.
          skipped.push({ index, name: entry.name, reason: 'name-taken' })
          return
        }
        taken.add(key)
        const id = newId('tpl')
        state.templates[id] = {
          id,
          company_id: company.id,
          name: entry.name,
          kind: entry.kind,
          role: entry.role,
          instructions: entry.instructions,
          model: entry.model,
          effort: entry.effort,
          skills: entry.skills,
          version: 1,
          source: 'custom',
          origin_template_id: null,
          local_overrides: {},
          status: 'active',
          created_at: now(),
          updated_at: now(),
          revision: 1,
        }
        imported.push({ template_id: id, name: entry.name, kind: entry.kind })
      })
      const body = { imported, skipped }
      if (imported.length === 0) return { aggregate_id: company.id, body, mutates: false }
      return {
        aggregate_id: company.id,
        body,
        events: [{ type: 'template.imported', data: { names: imported.map(entry => entry.name), skipped: skipped.map(entry => entry.name) } }],
      }
    },
  }
}
