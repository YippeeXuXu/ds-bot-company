import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// M1b-3.1: what a template can write in one call. `createBot` takes the text and look of
// a Bot; the shared capabilities it should have are a second call. These tests fix that
// split, the failure path, and that a Bot made from a template is whole or absent.

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

async function setup({ state = team() } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-template-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(state))
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
    home,
    ctx,
    rt,
    saved: () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')),
    async dispose() {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('createBot writes the template text in one call and leaves skills empty (3.1)', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const bot = await env.rt.createBot({
    name: 'Blueberry',
    role: '前端',
    color: 'cyan',
    instructions: '你负责四主屏。交付前跑三项检查。',
    brief: 'From the 前端 template.',
    avatar: { shape: 'fruit' },
  })
  assert.equal(bot.role, '前端')
  assert.equal(bot.instructions, '你负责四主屏。交付前跑三项检查。')
  assert.equal(bot.color, 'cyan')
  assert.deepEqual(bot.avatar, { shape: 'fruit' })
  assert.deepEqual(bot.capabilities, [])
  // The kickoff greets the user; nothing else is written.
  assert.equal(bot.kickoff.from, null)
  assert.deepEqual(env.saved().bots[bot.id].capabilities, [])
})

test('a template skill is attached in a second call, and an unknown one changes nothing (3.1)', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const bot = await env.rt.createBot({ name: 'Blueberry', role: '前端' })
  await env.rt.capabilityEndpoint('bot-capability', { botId: bot.id, name: 'guide', attached: true })
  assert.deepEqual(env.rt.state.bots[bot.id].capabilities, ['guide'])
  assert.deepEqual(env.saved().bots[bot.id].capabilities, ['guide'])

  await assert.rejects(
    env.rt.capabilityEndpoint('bot-capability', { botId: bot.id, name: 'missing', attached: true }),
    /No capability named missing/,
  )
  assert.deepEqual(env.rt.state.bots[bot.id].capabilities, ['guide'])
  // Detaching is the same call with attached: false, so a retry can undo a partial one.
  await env.rt.capabilityEndpoint('bot-capability', { botId: bot.id, name: 'guide', attached: false })
  assert.deepEqual(env.rt.state.bots[bot.id].capabilities, [])
})

test('a create that fails leaves no Bot behind (3.1)', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  await assert.rejects(env.rt.createBot({ name: 'Chief' }), /already exists/)
  await assert.rejects(env.rt.createBot({ name: 'Nobody', model: 'no/such-model' }), /is not available/)
  const names = Object.values(env.saved().bots).map(bot => bot.name)
  assert.deepEqual(names, ['Chief'])
  assert.equal(env.saved().mainBotIds.length, 1)
})
