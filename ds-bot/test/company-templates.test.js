import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCommands } from '../src/host/company/commands.js'
import { orgHandlers } from '../src/host/company/org.js'
import { COMPANY_VERSION, createCompanyStore } from '../src/host/company/store.js'
import { templateHandlers } from '../src/host/company/templates.js'

// M1b-3.2: the employee templates table. A builtin template is what the plugin ships and
// stays read-only; changing it means saving a copy, so an update can never overwrite the
// template it came from. A copy carries `origin_template_id` and records which fields it
// no longer shares.

const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-templates-'))

function open(home) {
  const store = createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} })
  const commands = createCommands({ store, handlers: { ...orgHandlers({ botOf: () => undefined }), ...templateHandlers() } })
  return { store, commands }
}

const run = (commands, command, payload) => commands.execute(command, payload)
const codeOf = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error.code
  }
  return undefined
}

async function company(commands) {
  return (await run(commands, 'company.init', { operation_key: 'k-company', name: 'DS Bot Company' })).body.company
}

// A builtin row is seeded the way the plugin would ship it: written straight into the
// table, never through `template.create`, which always makes a custom one.
function seedBuiltin(store, companyId, fields = {}) {
  const template = {
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
    ...fields,
  }
  store.state.templates[template.id] = template
  return template
}

test('a template keeps the job description, the instructions and the skills (M1b-3.2)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  const created = await company(commands)

  const made = await run(commands, 'template.create', {
    operation_key: 'k-tpl-1',
    name: '  前端  ',
    role: '前端',
    instructions: '你负责四主屏。',
    model: 'deepseek/deepseek-chat',
    effort: 'high',
    skills: ['guide', 'playwright-cli'],
  })
  const template = made.body.template
  assert.equal(template.name, '前端')
  assert.equal(template.role, '前端')
  assert.equal(template.instructions, '你负责四主屏。')
  assert.equal(template.model, 'deepseek/deepseek-chat')
  assert.equal(template.effort, 'high')
  assert.deepEqual(template.skills, ['guide', 'playwright-cli'])
  assert.equal(template.version, 1)
  assert.equal(template.source, 'custom')
  assert.equal(template.status, 'active')
  assert.equal(template.company_id, created.id)
  assert.equal(store.state.revision, 2)

  const listed = await run(commands, 'template.list', { operation_key: 'k-tpl-list' })
  assert.deepEqual(listed.body.templates.map(entry => entry.name), ['前端'])
  // A read answers without a write, so the revision does not move and there is no record.
  assert.equal(listed.status, 'ok')
  assert.equal(listed.revision, 2)
  rmSync(home, { recursive: true, force: true })
})

test('a builtin template is read-only; a copy changes without touching its origin (M1b-3.2)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  const made = await company(commands)
  const builtin = seedBuiltin(store, made.id)

  assert.equal(await codeOf(run(commands, 'template.update', { operation_key: 'k-bad-1', template_id: builtin.id, instructions: 'changed' })), 'template/builtin-readonly')
  assert.equal(await codeOf(run(commands, 'template.archive', { operation_key: 'k-bad-2', template_id: builtin.id })), 'template/builtin-readonly')
  assert.equal(store.state.templates[builtin.id].instructions, '你负责界面与动效。')

  const copy = (await run(commands, 'template.create', { operation_key: 'k-copy', from_template_id: builtin.id })).body.template
  assert.equal(copy.name, '前端工程师 副本')
  assert.equal(copy.source, 'custom')
  assert.equal(copy.origin_template_id, builtin.id)
  assert.equal(copy.instructions, builtin.instructions)
  assert.deepEqual(copy.skills, ['guide'])
  assert.deepEqual(copy.local_overrides, {})

  const edited = (await run(commands, 'template.update', { operation_key: 'k-copy-edit', template_id: copy.id, instructions: '你负责四主屏与动效。' })).body.template
  assert.equal(edited.version, 2)
  assert.deepEqual(edited.local_overrides, { instructions: true })
  // The origin is untouched: a copy is where a change lives.
  assert.equal(store.state.templates[builtin.id].instructions, '你负责界面与动效。')
  assert.equal(store.state.templates[builtin.id].version, 1)
  rmSync(home, { recursive: true, force: true })
})

test('template.update writes only what changed and refuses an archived template (M1b-3.2)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await company(commands)
  const template = (await run(commands, 'template.create', { operation_key: 'k-tpl', name: '测试', role: '测试', skills: ['guide'] })).body.template

  const revision = store.state.revision
  const same = await run(commands, 'template.update', { operation_key: 'k-same', template_id: template.id, role: '测试', skills: ['guide'] })
  assert.equal(same.status, 'ok')
  assert.equal(store.state.revision, revision)
  assert.equal(same.body.template.version, 1)

  const renamed = (await run(commands, 'template.update', { operation_key: 'k-rename', template_id: template.id, name: '测试工程师' })).body.template
  assert.equal(renamed.version, 2)

  const archived = (await run(commands, 'template.archive', { operation_key: 'k-archive', template_id: template.id })).body.template
  assert.equal(archived.status, 'archived')
  assert.equal((await run(commands, 'template.list', { operation_key: 'k-list-2' })).body.templates.length, 0)
  assert.equal(await codeOf(run(commands, 'template.update', { operation_key: 'k-archived-edit', template_id: template.id, role: 'x' })), 'template/archived')
  const revisionAfterArchive = store.state.revision
  const again = await run(commands, 'template.archive', { operation_key: 'k-archive-2', template_id: template.id })
  assert.equal(again.status, 'ok')
  assert.equal(store.state.revision, revisionAfterArchive)
  assert.equal(store.state.templates[template.id].status, 'archived')
  rmSync(home, { recursive: true, force: true })
})

test('template names are unique and skills are checked before they are saved (M1b-3.2)', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)
  await run(commands, 'template.create', { operation_key: 'k-a', name: '前端', role: '前端' })

  assert.equal(await codeOf(run(commands, 'template.create', { operation_key: 'k-b', name: ' 前端 ', role: '前端' })), 'template/name-taken')
  assert.equal(await codeOf(run(commands, 'template.create', { operation_key: 'k-c', name: '写手', role: '写手', skills: ['Web Search'] })), 'company/invalid')
  assert.equal(await codeOf(run(commands, 'template.create', { operation_key: 'k-d', name: '写手', role: '写手', skills: ['guide', 'guide'] })), 'company/invalid')
  assert.equal(await codeOf(run(commands, 'template.create', { operation_key: 'k-e', name: '写手', role: '写手', instructions: 'x'.repeat(8001) })), 'company/invalid')
  assert.equal(await codeOf(run(commands, 'template.create', { operation_key: 'k-f', name: 'x'.repeat(41), role: '写手' })), 'company/invalid')
  assert.equal(await codeOf(run(commands, 'template.update', { operation_key: 'k-g', template_id: 'tpl_missing', role: 'x' })), 'template/not-found')
  // A company has to exist first: a template belongs to one.
  const empty = open(tempHome())
  assert.equal(await codeOf(run(empty.commands, 'template.create', { operation_key: 'k-empty', name: '前端', role: '前端' })), 'company/not-found')
  rmSync(home, { recursive: true, force: true })
})

test('the templates table is saved in the company file at the current version (M1b-3.2)', async () => {
  const home = tempHome()
  const { store, commands } = open(home)
  await company(commands)
  await run(commands, 'template.create', { operation_key: 'k-save', name: '产品', role: '产品' })

  const saved = JSON.parse(readFileSync(join(home, 'company', 'state.json'), 'utf8'))
  assert.equal(saved.version, COMPANY_VERSION)
  assert.equal(saved.version, 5)
  const rows = Object.values(saved.templates)
  assert.equal(rows.length, 1)
  const stored = rows[0]
  assert.equal(stored.name, '产品')
  assert.equal(stored.source, 'custom')
  assert.equal(store.state.version, 5)
  rmSync(home, { recursive: true, force: true })
})

test('an ability template needs a role and a soul carries instructions only (v1.18)', async () => {
  const home = tempHome()
  const { commands } = open(home)
  await company(commands)

  // An ability template has to say what the work is.
  const noRole = await run(commands, 'template.create', { operation_key: 's-1', name: '没职责' }).catch(error => error)
  assert.equal(noRole.code, 'company/invalid')
  assert.equal(noRole.details.field, 'role')

  // A soul carries the character alone: no role, no model, no effort, no skills.
  for (const [key, field, payload] of [
    ['s-2', 'role', { role: '写手' }],
    ['s-3', 'model', { model: 'deepseek/deepseek-chat' }],
    ['s-4', 'effort', { effort: 'high' }],
    ['s-5', 'skills', { skills: ['guide'] }],
  ]) {
    const failure = await run(commands, 'template.create', { operation_key: key, name: '语气', kind: 'soul', ...payload }).catch(error => error)
    assert.equal(failure.code, 'company/invalid')
    assert.equal(failure.details.field, field)
  }
  const soul = await run(commands, 'template.create', { operation_key: 's-6', name: '语气', kind: 'soul', instructions: '说话短，先说结论。' })
  assert.equal(soul.body.template.kind, 'soul')
  assert.equal(soul.body.template.role, null)

  // An edit keeps the shape too: a soul cannot grow a model afterwards.
  const grown = await run(commands, 'template.update', { operation_key: 's-7', template_id: soul.body.template.id, model: 'deepseek/deepseek-chat' }).catch(error => error)
  assert.equal(grown.code, 'company/invalid')
  assert.equal(grown.details.field, 'model')

  // An ability template cannot lose its role either.
  const ability = await run(commands, 'template.create', { operation_key: 's-8', name: '写手', role: '写手' })
  const lost = await run(commands, 'template.update', { operation_key: 's-9', template_id: ability.body.template.id, role: '' }).catch(error => error)
  assert.equal(lost.code, 'company/invalid')
  assert.equal(lost.details.field, 'role')
  rmSync(home, { recursive: true, force: true })
})
