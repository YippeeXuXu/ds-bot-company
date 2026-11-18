import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { createCompanyApi } from '../src/host/company/api.js'
import { createCommands } from '../src/host/company/commands.js'
import { orgHandlers } from '../src/host/company/org.js'
import { spawnHandlers } from '../src/host/company/spawn.js'
import { companyFail, createCompanyStore } from '../src/host/company/store.js'
import { fakeContext } from './fake-ctx.js'

// M1b-3.4: hiring from a template. The host makes a Bot in one call, attaches capabilities
// one at a time, and only then does the profile point at it, so a refused hire has to undo
// the calls that already landed. These tests hold the order, every refusal, and the one
// promise the feature makes to the user: a failed create leaves no half-made Bot.

const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-spawn-'))

// The host calls, simulated: the same three steps and the same answers, including a Bot that
// refuses to be deleted. `library` is what the capability library holds; a name outside it is
// what the pre-check is for.
function fakeHost({ library = ['guide', 'playwright-cli'], failCreate, failAttachAt, failUndoDelete } = {}) {
  const bots = new Map()
  const calls = []
  let seq = 0
  const roster = {
    create: async (options) => {
      calls.push({ call: 'create', options })
      if (failCreate !== undefined) throw new Error(failCreate)
      seq += 1
      const bot = { id: `bot_${seq}`, ...options, capabilities: [] }
      bots.set(bot.id, bot)
      return bot
    },
    byName: name => [...bots.values()].find(bot => bot.name === name),
    problem: () => undefined,
    has: name => library.includes(name),
    attach: async (botId, name) => {
      calls.push({ call: 'attach', botId, name })
      if (failAttachAt === name) throw new Error(`No capability named ${name}`)
      bots.get(botId).capabilities.push(name)
    },
    undo: async (botId, attached) => {
      calls.push({ call: 'undo', botId, attached: [...attached] })
      const bot = bots.get(botId)
      if (bot) bot.capabilities = bot.capabilities.filter(name => !attached.includes(name))
      if (failUndoDelete === true) return true
      bots.delete(botId)
      return false
    },
  }
  return { bots, calls, roster }
}

function open(options) {
  const home = tempHome()
  const store = createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} })
  const host = fakeHost(options)
  const org = orgHandlers({ botOf: id => host.bots.get(id), isPrivate: () => false })
  const commands = createCommands({
    store,
    handlers: { ...org, ...spawnHandlers({ roster: host.roster, createEmployee: org['employee.create'] }) },
  })
  return {
    home,
    store,
    host,
    org,
    commands,
    dispose: () => rmSync(home, { recursive: true, force: true, maxRetries: 5 }),
  }
}

// A template is seeded the way a saved or shipped one lands in the table: straight into the
// state, not through template.create, because this file tests what is made from it.
function seedTemplate(store, companyId, fields = {}) {
  const template = {
    id: 'tpl_frontend',
    company_id: companyId,
    name: '前端工程师',
    role: '前端',
    instructions: '你负责界面与动效。交付前跑三项检查。',
    model: 'deepseek/deepseek-chat',
    effort: 'high',
    skills: ['guide'],
    version: 1,
    source: 'custom',
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

async function ready(env, templateFields) {
  const company = (await env.commands.execute('company.init', { operation_key: 'k-company', name: 'DS Bot Company' })).body.company
  const department = (await env.commands.execute('department.create', { operation_key: 'k-department', name: '产品部' })).body.department
  const template = seedTemplate(env.store, company.id, templateFields)
  return { company, department, template }
}

const hire = (env, department, extra = {}) => env.commands.execute('employee.create-from-template', {
  operation_key: 'k-hire',
  template_id: 'tpl_frontend',
  department_id: department.id,
  name: '蓝莓',
  ...extra,
})

const codeOf = async (promise) => {
  try {
    await promise
  } catch (error) {
    return error.code
  }
  return undefined
}

test('a template makes one Bot with its text and skills, then the profile that points at it (M1b-3.4)', async (t) => {
  const env = open()
  t.after(() => env.dispose())
  const { company, department } = await ready(env)

  const result = await hire(env, department)
  assert.equal(result.status, 'committed')

  const employee = result.body.employee
  assert.equal(employee.name, '蓝莓')
  assert.equal(employee.role, '前端')
  assert.equal(employee.department_id, department.id)
  assert.equal(employee.company_id, company.id)
  assert.equal(employee.status, 'active')

  const bot = env.host.bots.get(employee.bot_id)
  assert.ok(bot !== undefined, 'the profile points at a Bot that exists')
  assert.equal(bot.name, '蓝莓')
  assert.equal(bot.role, '前端')
  assert.equal(bot.instructions, '你负责界面与动效。交付前跑三项检查。')
  assert.equal(bot.model, 'deepseek/deepseek-chat')
  assert.equal(bot.effort, 'high')
  assert.deepEqual(bot.capabilities, ['guide'])
  assert.deepEqual(result.body.bot.skills, ['guide'])

  // The audit line says what was made and which template it came from.
  const events = readFileSync(join(env.home, 'company', 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const created = events.find(event => event.type === 'employee.created')
  assert.equal(created.aggregate_id, employee.id)
  assert.equal(created.data.template_id, 'tpl_frontend')
  assert.equal(created.data.bot_id, employee.bot_id)
})

test('the Bot may be named apart from the employee, and its skills are attached in order (M1b-3.4)', async (t) => {
  const env = open()
  t.after(() => env.dispose())
  const { department } = await ready(env, { skills: ['guide', 'playwright-cli'] })

  const result = await hire(env, department, { name: '前端一号', bot_name: 'Blueberry' })
  const bot = env.host.bots.get(result.body.employee.bot_id)
  assert.equal(bot.name, 'Blueberry')
  assert.equal(result.body.employee.name, '前端一号')
  assert.deepEqual(bot.capabilities, ['guide', 'playwright-cli'])
  assert.deepEqual(
    env.host.calls.filter(call => call.call === 'attach').map(call => call.name),
    ['guide', 'playwright-cli'],
  )
})

test('a Bot name already in the team is refused before anything is made (M1b-3.4)', async (t) => {
  const env = open()
  t.after(() => env.dispose())
  const { department } = await ready(env)
  await hire(env, department)

  assert.equal(await codeOf(hire(env, department, { operation_key: 'k-hire-2' })), 'employee/bot-name-taken')
  assert.equal(env.host.bots.size, 1)
  assert.equal(Object.keys(env.store.state.employees).length, 1)
})

test('a name the host would cut short is refused, not silently shortened (M1b-3.4)', async (t) => {
  const env = open()
  t.after(() => env.dispose())
  const { department } = await ready(env)

  const long = '一'.repeat(41)
  const error = await hire(env, department, { name: long }).catch(caught => caught)
  assert.equal(error.code, 'company/invalid')
  assert.equal(error.details.field, 'bot_name')
  assert.equal(env.host.bots.size, 0)
})

test('a skill the library does not hold is refused before a Bot is made (M1b-3.4)', async (t) => {
  const env = open({ library: ['guide'] })
  t.after(() => env.dispose())
  const { department } = await ready(env, { skills: ['guide', 'playwright-cli'] })
  const revision = env.store.state.revision

  const error = await hire(env, department).catch(caught => caught)
  assert.equal(error.code, 'employee/capability-missing')
  assert.deepEqual(error.details.missing, ['playwright-cli'])
  assert.equal(env.host.bots.size, 0)
  assert.equal(env.host.calls.length, 0, 'no host call was made')
  assert.equal(env.store.state.revision, revision)
})

test('a skill that fails mid-list unloads the attached ones and deletes the Bot (M1b-3.4)', async (t) => {
  // The library lists all three, so the pre-check passes; the second attach is where the
  // host refuses, which is the case a pre-check cannot see.
  const env = open({ library: ['guide', 'flaky', 'third'], failAttachAt: 'flaky' })
  t.after(() => env.dispose())
  const { department } = await ready(env, { skills: ['guide', 'flaky', 'third'] })
  const revision = env.store.state.revision

  const error = await hire(env, department).catch(caught => caught)
  assert.equal(error.code, 'employee/capability-failed')
  assert.equal(error.details.skill, 'flaky')
  assert.deepEqual(error.details.attached, ['guide'])
  assert.equal(error.details.bot_left_behind, undefined)
  assert.equal(env.host.bots.size, 0, 'the Bot is gone')
  assert.equal(Object.keys(env.store.state.employees).length, 0)
  assert.equal(env.store.state.revision, revision)
  // Detached in reverse: the one that made it is undone first.
  const undo = env.host.calls.filter(call => call.call === 'undo')
  assert.deepEqual(undo.map(call => call.attached), [['guide']])
})

test('a Bot that cannot be deleted is named in the error, not hidden (M1b-3.4)', async (t) => {
  const env = open({ library: ['guide', 'flaky'], failAttachAt: 'flaky', failUndoDelete: true })
  t.after(() => env.dispose())
  const { department } = await ready(env, { skills: ['guide', 'flaky'] })

  const error = await hire(env, department).catch(caught => caught)
  assert.equal(error.code, 'employee/capability-failed')
  assert.equal(error.details.bot_left_behind, 'bot_1')
  assert.equal(env.host.bots.size, 1, 'the test host keeps it, and the error says so')
  assert.equal(Object.keys(env.store.state.employees).length, 0, 'no profile points at a Bot it could not keep')
})

test('a Bot the host refuses to make leaves nothing behind (M1b-3.4)', async (t) => {
  const env = open({ failCreate: 'deepseek/deepseek-chat is not available' })
  t.after(() => env.dispose())
  const { department } = await ready(env)

  const error = await hire(env, department).catch(caught => caught)
  assert.equal(error.code, 'employee/bot-create-failed')
  assert.match(error.message, /is not available/)
  assert.equal(env.host.bots.size, 0)
  assert.equal(Object.keys(env.store.state.employees).length, 0)
})

test('a profile the company layer refuses takes the Bot with it (M1b-3.4)', async (t) => {
  const env = open()
  t.after(() => env.dispose())
  const { department } = await ready(env)
  const handlers = spawnHandlers({
    roster: env.host.roster,
    createEmployee: () => { throw companyFail('employee/private-bot', 'Bot is private and cannot hold a profile.') },
  })
  await assert.rejects(
    handlers['employee.create-from-template']({
      state: env.store.state,
      payload: { operation_key: 'k-hire', template_id: 'tpl_frontend', department_id: department.id, name: '蓝莓' },
      now: () => 1,
    }),
    error => error.code === 'employee/private-bot',
  )
  assert.equal(env.host.bots.size, 0)
  assert.equal(Object.keys(env.store.state.employees).length, 0)
})

test('an archived template cannot be hired from (M1b-3.4)', async (t) => {
  const env = open()
  t.after(() => env.dispose())
  const { department } = await ready(env, { status: 'archived' })

  assert.equal(await codeOf(hire(env, department)), 'template/archived')
  assert.equal(env.host.bots.size, 0)
})

test('the same operation_key replays the result instead of hiring twice (M1b-3.4)', async (t) => {
  const env = open()
  t.after(() => env.dispose())
  const { department } = await ready(env)

  const first = await hire(env, department)
  const second = await hire(env, department)
  assert.equal(second.replayed, true)
  assert.equal(second.body.employee.id, first.body.employee.id)
  assert.equal(env.host.bots.size, 1)
  assert.equal(Object.keys(env.store.state.employees).length, 1)
})

// The unit tests above fix the order and every refusal against a simulated host. This one
// runs the same command through the real roster and the real capability library, because the
// two must agree on which calls make a whole employee.
const team = () => ({
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', sessionId: 'chief', name: 'Chief', capabilities: [], createdAt: 1 },
  },
  rooms: {},
  agents: {},
  capabilities: { items: { guide: { name: 'guide', kind: 'skill', description: 'How we work', content: 'Read the plan first.' } } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 3,
})

async function runtime() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-spawn-rt-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(team()))
  const ctx = fakeContext()
  let created = 0
  const agentOf = sessionId => ({ id: sessionId, session: { id: sessionId }, status: 'idle', followup() {}, steer() {}, inject() {}, cancel() {}, async whenIdle() {} })
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: {
      get: () => ({ id: 'w1', path: home, title: 'DS Bot' }),
      list: () => [{ id: 'w1', path: home, title: 'DS Bot' }],
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w-new', path, title: 'DS Bot' }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: `0000000${++created}-1111-4222-8333-444444444444` }),
      resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  return {
    rt,
    saved: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')),
    async dispose() {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('the real roster makes the Bot, attaches the skill and writes the profile (M1b-3.4)', async (t) => {
  const env = await runtime()
  t.after(() => env.dispose())
  const company = (await env.rt.companyExecute('company.init', { operation_key: 'k-company', name: 'DS Bot Company' })).body.company
  const department = (await env.rt.companyExecute('department.create', { operation_key: 'k-department', name: '产品部' })).body.department
  env.rt.companyStore.state.templates.tpl_real = {
    id: 'tpl_real',
    company_id: company.id,
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

  const result = await env.rt.companyExecute('employee.create-from-template', {
    operation_key: 'k-hire',
    template_id: 'tpl_real',
    department_id: department.id,
    name: 'Blueberry',
  })
  assert.equal(result.status, 'committed')
  const employee = result.body.employee
  const bot = env.rt.botOf(employee.bot_id)
  assert.ok(bot !== undefined, 'the team file holds the Bot')
  assert.equal(bot.name, 'Blueberry')
  assert.equal(bot.role, '前端')
  assert.equal(bot.instructions, '你负责界面与动效。')
  assert.deepEqual(bot.capabilities, ['guide'])
  assert.deepEqual(env.saved().bots[employee.bot_id].capabilities, ['guide'])
  assert.equal(env.rt.companyStore.state.employees[employee.id].bot_id, employee.bot_id)
})

test('the real library refuses an unknown skill and no Bot is written (M1b-3.4)', async (t) => {
  const env = await runtime()
  t.after(() => env.dispose())
  const company = (await env.rt.companyExecute('company.init', { operation_key: 'k-company', name: 'DS Bot Company' })).body.company
  const department = (await env.rt.companyExecute('department.create', { operation_key: 'k-department', name: '产品部' })).body.department
  env.rt.companyStore.state.templates.tpl_bad = {
    id: 'tpl_bad',
    company_id: company.id,
    name: '缺技能',
    role: '测试',
    instructions: '',
    model: null,
    effort: null,
    skills: ['guide', 'no-such-skill'],
    version: 1,
    source: 'custom',
    origin_template_id: null,
    local_overrides: {},
    status: 'active',
    created_at: 1,
    updated_at: 1,
    revision: 1,
  }
  const before = Object.keys(env.saved().bots).length
  const error = await env.rt.companyExecute('employee.create-from-template', {
    operation_key: 'k-hire',
    template_id: 'tpl_bad',
    department_id: department.id,
    name: 'Nobody',
  }).catch(caught => caught)
  assert.equal(error.code, 'employee/capability-missing')
  assert.deepEqual(error.details.missing, ['no-such-skill'])
  assert.equal(Object.keys(env.saved().bots).length, before)
})

// The screen posts one envelope and reads one status: 200 when the employee exists, 409 when
// the name is taken, 422 when the request itself cannot be carried out. This pins the three
// so a button can branch on the status without parsing messages.
let apiKey = 0

test('the HTTP entry answers a hire with 200, 409 or 422 (M1b-3.4)', async (t) => {
  const env = open()
  t.after(() => env.dispose())
  const { company, department } = await ready(env)
  seedTemplate(env.store, company.id, { id: 'tpl_no_skill', name: '缺技能', skills: ['no-such-skill'] })
  const api = createCompanyApi({
    store: env.store,
    execute: env.commands.execute,
    groups: { create: async () => 'room_x', members: () => undefined, setMembers: async () => {} },
    now: () => 1_700_000_000_000,
  })
  const post = payload => api.command({ operation_key: `k-spawn-${++apiKey}`, command: 'employee.create-from-template', payload })

  const ok = await post({ template_id: 'tpl_frontend', department_id: department.id, name: '蓝莓' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.body.employee.name, '蓝莓')

  const clash = await post({ template_id: 'tpl_frontend', department_id: department.id, name: '蓝莓' })
  assert.equal(clash.status, 409)
  assert.equal(clash.body.code, 'employee/bot-name-taken')

  const noSkill = await post({ template_id: 'tpl_no_skill', department_id: department.id, name: '橙子' })
  assert.equal(noSkill.status, 422)
  assert.equal(noSkill.body.code, 'employee/capability-missing')
})
