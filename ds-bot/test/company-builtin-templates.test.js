import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BUILTIN_TEMPLATES, builtinTemplateId, seedBuiltinTemplates } from '../src/host/company/builtin-templates.js'
import { install } from '../src/host/company/index.js'

// M1b-3.6b: the nine job templates that ship with the plugin. A company starts with them,
// they are read-only, and a company file written before they existed is topped up once —
// without a duplicate row on the next start and without moving the company revision.

const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-builtin-'))

const stateOf = (companyId = 'cmp_1') => ({
  companies: { [companyId]: { id: companyId, name: 'Acme', status: 'active', company_id: companyId, created_at: 1 } },
  templates: {},
})

// The host pieces `install` reads. Nothing here creates Bots or groups: these tests only
// exercise the template rows and the company wiring around them.
const runtimeOf = home => ({
  home,
  warn: () => {},
  ctx: { connection: { fetch: { register: () => () => {} } }, effect: () => {} },
  approvalsView: () => [],
  selfOf: () => undefined,
  roomOf: () => undefined,
  botOf: () => undefined,
  isPrivate: () => false,
  redactSecrets: text => text,
})

const waitFor = async (check, ms = 2000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return check()
}

const codeOf = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error.code
  }
  return undefined
}

test('a company gets the nine builtin templates, in the order of the job list (M1b-3.6b)', () => {
  const state = stateOf()
  const added = seedBuiltinTemplates(state, () => 1000)

  assert.equal(BUILTIN_TEMPLATES.length, 9)
  assert.equal(added.length, 9)
  assert.deepEqual(Object.values(state.templates).map(template => template.name), [
    '项目统筹', '产品设计师', '前端工程师', '代码开发工程师', '测试工程师',
    '独立审查员', '资料研究员', '工作助理', '记忆整理员',
  ])
  assert.deepEqual(Object.values(state.templates).map(template => template.role), [
    '统筹', '产品设计', '前端开发', '代码开发', '测试', '独立审查', '资料', '助理', '记忆整理',
  ])
  // The row is what `template.create` would have written, minus everything a Bot owns:
  // no model, no effort, no skills — the host decides those, and a new machine has no
  // capability library to point at.
  const one = state.templates[builtinTemplateId('cmp_1', 'project-lead')]
  assert.equal(one.company_id, 'cmp_1')
  assert.equal(one.source, 'builtin')
  assert.equal(one.status, 'active')
  assert.equal(one.version, 1)
  assert.equal(one.model, null)
  assert.equal(one.effort, null)
  assert.deepEqual(one.skills, [])
  assert.equal(one.origin_template_id, null)
  assert.deepEqual(one.local_overrides, {})
  assert.equal(one.instructions.length > 100, true)
  // `created_at` follows the list, which is the order `template.list` shows them in.
  const times = Object.values(state.templates).map(template => template.created_at)
  assert.deepEqual(times, [...times].sort((left, right) => left - right))
})

test('seeding twice adds nothing: a start cannot duplicate the rows (M1b-3.6b)', () => {
  const state = stateOf()
  assert.equal(seedBuiltinTemplates(state, () => 1000).length, 9)
  const before = JSON.stringify(state.templates)
  assert.deepEqual(seedBuiltinTemplates(state, () => 2000), [])
  assert.equal(JSON.stringify(state.templates), before)
})

test('an archived company is left alone, and a name already in use keeps its template (M1b-3.6b)', () => {
  const state = {
    companies: {
      cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', company_id: 'cmp_1', created_at: 1 },
      cmp_2: { id: 'cmp_2', name: 'Old', status: 'archived', company_id: 'cmp_2', created_at: 1 },
    },
    templates: {
      tpl_mine: {
        id: 'tpl_mine', company_id: 'cmp_1', name: '项目统筹', role: '统筹', instructions: '我自己的。',
        model: null, effort: null, skills: [], version: 1, source: 'custom', origin_template_id: null,
        local_overrides: {}, status: 'active', created_at: 1, updated_at: 1, revision: 1,
      },
    },
  }
  const added = seedBuiltinTemplates(state, () => 1000)

  assert.equal(added.length, 8)
  assert.equal(Object.values(state.templates).filter(template => template.company_id === 'cmp_2').length, 0)
  // The company's own row wins: one name appears once in the list.
  assert.equal(state.templates['tpl_mine'].instructions, '我自己的。')
  assert.equal(state.templates[builtinTemplateId('cmp_1', 'project-lead')], undefined)
  assert.equal(state.templates[builtinTemplateId('cmp_1', 'memory-keeper')].name, '记忆整理员')
})

test('a new company comes with the nine, and a builtin is read-only (M1b-3.6b)', async () => {
  const home = tempHome()
  const rt = runtimeOf(home)
  install(rt)

  const created = await rt.companyExecute('company.init', { operation_key: 'k-company', name: 'DS Bot Company' })
  assert.equal(created.status, 'committed')
  assert.equal(created.body.company.name, 'DS Bot Company')

  const listed = await rt.companyExecute('template.list', { operation_key: 'k-list' })
  assert.equal(listed.body.templates.length, 9)
  assert.equal(listed.body.templates.every(template => template.source === 'builtin'), true)
  assert.equal(listed.body.templates[0].name, '项目统筹')

  const id = listed.body.templates[0].id
  assert.equal(await codeOf(rt.companyExecute('template.update', { operation_key: 'k-edit', template_id: id, role: '换一个' })), 'template/builtin-readonly')
  assert.equal(await codeOf(rt.companyExecute('template.archive', { operation_key: 'k-archive', template_id: id })), 'template/builtin-readonly')

  // Saving a copy is the way to change one, and the copy leaves the builtin as it was.
  const copy = await rt.companyExecute('template.create', { operation_key: 'k-copy', from_template_id: id, name: '项目统筹 副本' })
  assert.equal(copy.body.template.source, 'custom')
  assert.equal(copy.body.template.origin_template_id, id)
  assert.equal(copy.body.template.role, '统筹')
  const edited = await rt.companyExecute('template.update', { operation_key: 'k-copy-edit', template_id: copy.body.template.id, role: '总控' })
  assert.equal(edited.body.template.version, 2)
  assert.equal(edited.body.template.local_overrides.role, true)
  const again = await rt.companyExecute('template.list', { operation_key: 'k-list-2' })
  assert.equal(again.body.templates.find(template => template.id === id).role, '统筹')
  assert.equal(again.body.templates.length, 10)

  rt.company.close()
  rmSync(home, { recursive: true, force: true })
})

test('a version 3 company file is migrated once and its templates topped up (M1b-3.6b)', async () => {
  const home = tempHome()
  mkdirSync(join(home, 'company'), { recursive: true })
  writeFileSync(join(home, 'company', 'state.json'), JSON.stringify({
    version: 3,
    revision: 5,
    companies: { cmp_1: { id: 'cmp_1', name: 'Acme', status: 'active', conversation_mode: 'standard', created_at: 1, updated_at: 1, revision: 1 } },
    departments: {},
    employees: {},
    projects: {},
    members: {},
    operation_log: {},
    acceptances: {},
    todo_log: {},
    templates: {},
  }))
  const stateFile = join(home, 'company', 'state.json')
  const eventsFile = join(home, 'company', 'events.jsonl')

  const rt = runtimeOf(home)
  install(rt)
  await waitFor(() => {
    try {
      const current = JSON.parse(readFileSync(stateFile, 'utf8'))
      const events = readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean)
      return current.version === 5 && Object.keys(current.templates).length === 9 && events.length === 2
    } catch {
      return false
    }
  })

  const saved = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.equal(Object.keys(saved.templates).length, 9)
  assert.equal(Object.values(saved.templates).every(template => template.source === 'builtin' && template.company_id === 'cmp_1'), true)
  // An upgrade is not a company change: a client's expected_revision still matches.
  assert.equal(saved.version, 5)
  assert.equal(saved.revision, 5)
  const events = readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.deepEqual(events.map(event => event.type), ['company/migrated', 'company/builtin-templates-seeded'])
  assert.deepEqual(events[0].data, { from: 3, to: 5 })
  assert.deepEqual(events[1].data, { count: 9 })
  rt.company.close()

  // A second start finds all nine and writes nothing.
  const again = runtimeOf(home)
  install(again)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).length, 2)
  again.company.close()
  rmSync(home, { recursive: true, force: true })
})
