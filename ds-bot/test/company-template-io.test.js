import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCommands } from '../src/host/company/commands.js'
import { orgHandlers } from '../src/host/company/org.js'
import { createCompanyStore } from '../src/host/company/store.js'
import { templateHandlers } from '../src/host/company/templates.js'
import { templateIoHandlers } from '../src/host/company/template-io.js'

// M1b-3.5: templates leave a profile as one file and come back on another. The file says
// what it is and which version it speaks; one bad row refuses all of it; a name the target
// already has is skipped, never overwritten.

const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-template-io-'))

function open(home) {
  const store = createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} })
  const commands = createCommands({
    store,
    handlers: {
      ...orgHandlers({ botOf: () => undefined }),
      ...templateHandlers(),
      ...templateIoHandlers(),
    },
  })
  return { store, commands }
}

const run = (commands, command, payload) => commands.execute(command, payload)

async function company(commands) {
  return (await run(commands, 'company.init', { operation_key: 'k-company', name: 'DS Bot Company' })).body.company
}

async function errorOf(promise) {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('the command was expected to fail')
}

function seedBuiltin(store, companyId) {
  store.state.templates.tpl_builtin_frontend = {
    id: 'tpl_builtin_frontend',
    company_id: companyId,
    name: '前端工程师',
    role: '前端',
    instructions: '你负责界面与动效。',
    model: null,
    effort: null,
    skills: ['guide'],
    version: 1,
    source: 'builtin',
    origin_template_id: null,
    local_overrides: {},
    status: 'active',
    created_at: 1,
    updated_at: 1,
    revision: 1,
  }
}

async function createTemplate(commands, key, fields = {}) {
  return (await run(commands, 'template.create', { operation_key: key, ...fields })).body.template
}

test('a template file exports every active template, builtin first (M1b-3.5)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  try {
    const created = await company(commands)
    seedBuiltin(store, created.id)
    await createTemplate(commands, 'k-backend', {
      name: '后端工程师',
      role: '后端',
      instructions: '你负责服务端命令。',
      model: 'deepseek/deepseek-chat',
      effort: 'high',
      skills: ['guide', 'playwright-cli'],
    })
    await createTemplate(commands, 'k-data', { name: '数据工程师', role: '数据' })

    const result = await run(commands, 'template.export', { operation_key: 'k-export-all' })
    const file = result.body.file
    assert.equal(file.format, 'ds-company/templates')
    assert.equal(file.version, 1)
    assert.deepEqual(file.templates.map(entry => entry.name), ['前端工程师', '后端工程师', '数据工程师'])
    assert.deepEqual(file.templates[1].skills, ['guide', 'playwright-cli'])
    assert.equal(file.templates[1].model, 'deepseek/deepseek-chat')
    assert.match(file.exported_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(file.templates[0].source, 'builtin')
    assert.equal(Object.values(store.state.operation_log).filter(entry => entry.command === 'template.export').length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('an export can name the templates it wants (M1b-3.5)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  try {
    const created = await company(commands)
    seedBuiltin(store, created.id)
    const backend = await createTemplate(commands, 'k-backend', { name: '后端工程师', role: '后端' })
    await createTemplate(commands, 'k-data', { name: '数据工程师', role: '数据' })

    const file = (await run(commands, 'template.export', { operation_key: 'k-export-one', template_ids: [backend.id] })).body.file
    assert.deepEqual(file.templates.map(entry => entry.name), ['后端工程师'])

    const missing = await errorOf(run(commands, 'template.export', { operation_key: 'k-export-missing', template_ids: ['tpl_nope'] }))
    assert.equal(missing.code, 'template/not-found')

    await run(commands, 'template.archive', { operation_key: 'k-archive', template_id: backend.id })
    const archived = await errorOf(run(commands, 'template.export', { operation_key: 'k-export-archived', template_ids: [backend.id] }))
    assert.equal(archived.code, 'template/archived')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a file exported on one profile imports on another with every field (M1b-3.5)', async () => {
  const source = tempHome()
  const target = tempHome()
  try {
    const from = open(source)
    const to = open(target)
    const sourceCompany = await company(from.commands)
    seedBuiltin(from.store, sourceCompany.id)
    await createTemplate(from.commands, 'k-backend', {
      name: '后端工程师',
      role: '后端',
      instructions: '你负责服务端命令。',
      model: 'deepseek/deepseek-chat',
      effort: 'high',
      skills: ['guide', 'playwright-cli'],
    })
    const file = (await run(from.commands, 'template.export', { operation_key: 'k-export' })).body.file

    const targetCompany = await company(to.commands)
    const imported = await run(to.commands, 'template.import', { operation_key: 'k-import', text: JSON.stringify(file) })
    assert.equal(imported.body.imported.length, 2)
    assert.equal(imported.body.skipped.length, 0)

    const rows = Object.values(to.store.state.templates).filter(template => template.company_id === targetCompany.id)
    const backend = rows.find(template => template.name === '后端工程师')
    assert.equal(backend.role, '后端')
    assert.equal(backend.instructions, '你负责服务端命令。')
    assert.equal(backend.model, 'deepseek/deepseek-chat')
    assert.equal(backend.effort, 'high')
    assert.deepEqual(backend.skills, ['guide', 'playwright-cli'])
    assert.equal(backend.source, 'custom')
    assert.equal(backend.origin_template_id, null)
    assert.equal(rows.length, 2)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('a name the target already has is skipped, not overwritten (M1b-3.5)', async () => {
  const source = tempHome()
  const target = tempHome()
  try {
    const from = open(source)
    const to = open(target)
    const sourceCompany = await company(from.commands)
    seedBuiltin(from.store, sourceCompany.id)
    await createTemplate(from.commands, 'k-backend', { name: '后端工程师', role: '后端', instructions: '你负责服务端命令。' })
    const file = (await run(from.commands, 'template.export', { operation_key: 'k-export' })).body.file

    await company(to.commands)
    await run(to.commands, 'template.import', { operation_key: 'k-import-1', file })
    const existing = Object.values(to.store.state.templates).find(template => template.name === '后端工程师')
    await run(to.commands, 'template.update', { operation_key: 'k-edit', template_id: existing.id, instructions: '本地改过的说明。' })

    const again = await run(to.commands, 'template.import', { operation_key: 'k-import-2', file })
    assert.equal(again.body.imported.length, 0)
    assert.deepEqual(again.body.skipped.map(entry => [entry.name, entry.reason]), [
      ['前端工程师', 'name-taken'],
      ['后端工程师', 'name-taken'],
    ])
    assert.equal(to.store.state.templates[existing.id].instructions, '本地改过的说明。')
    assert.equal(Object.values(to.store.state.templates).filter(template => template.name === '后端工程师').length, 1)
  } finally {
    rmSync(source, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('one bad template refuses the whole file (M1b-3.5)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  try {
    await company(commands)
    const file = {
      format: 'ds-company/templates',
      version: 1,
      templates: [
        { name: '前端工程师', role: '前端' },
        { name: '后端工程师', role: '后端', skills: ['Bad Skill'] },
      ],
    }
    const refused = await errorOf(run(commands, 'template.import', { operation_key: 'k-import', file }))
    assert.equal(refused.code, 'template/import-invalid')
    assert.equal(refused.details.index, 1)
    assert.equal(refused.details.field, 'templates[1].skills[0]')
    assert.equal(Object.values(store.state.templates).length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a file of the wrong format or version is refused whole (M1b-3.5)', async () => {
  const home = tempHome()
  const { commands } = open(home)
  try {
    await company(commands)
    const wrongFormat = await errorOf(run(commands, 'template.import', {
      operation_key: 'k-format',
      file: { format: 'other/templates', version: 1, templates: [{ name: '前端工程师' }] },
    }))
    assert.equal(wrongFormat.code, 'template/import-invalid')
    assert.equal(wrongFormat.details.field, 'format')

    const wrongVersion = await errorOf(run(commands, 'template.import', {
      operation_key: 'k-version',
      file: { format: 'ds-company/templates', version: 2, templates: [{ name: '前端工程师' }] },
    }))
    assert.equal(wrongVersion.code, 'template/import-invalid')
    assert.equal(wrongVersion.details.field, 'version')

    const empty = await errorOf(run(commands, 'template.import', {
      operation_key: 'k-empty',
      file: { format: 'ds-company/templates', version: 1, templates: [] },
    }))
    assert.equal(empty.details.field, 'templates')

    const notJson = await errorOf(run(commands, 'template.import', { operation_key: 'k-json', text: '{oops' }))
    assert.equal(notJson.code, 'template/import-invalid')
    assert.equal(notJson.details.field, 'text')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('two templates of one name in a file: the first wins (M1b-3.5)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  try {
    await company(commands)
    const result = await run(commands, 'template.import', {
      operation_key: 'k-import',
      file: {
        format: 'ds-company/templates',
        version: 1,
        templates: [
          { name: '前端工程师', role: '前端' },
          { name: ' 前端工程师 ', role: '另一个' },
        ],
      },
    })
    assert.equal(result.body.imported.length, 1)
    assert.deepEqual(result.body.skipped, [{ index: 1, name: '前端工程师', reason: 'name-taken' }])
    const rows = Object.values(store.state.templates)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].role, '前端')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
