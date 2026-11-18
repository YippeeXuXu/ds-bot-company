import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'

// Fei2411/DS-Bot#37: under DSH Desktop's default PTC preset a model may call only
// run_code, so the group_relay call made for a group chat's Session was turned down
// and no group message reached its Bots.

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  revision: 1,
  whaleStored: true,
  bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', role: 'Lead', instructions: '', createdAt: 1 } },
  rooms: { room: { id: 'room', name: 'Desk', members: ['chief'], admin: 'chief', mode: 'everyone', sessions: {}, seq: 0, log: [] } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

function start({ presets } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-agent-preset-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const services = presets === undefined ? {} : { agentPresets: { list: async () => presets } }
  const ctx = fakeContext({ services })
  const created = []
  Object.assign(ctx, {
    workspaceRegistry: {
      get: id => (id === 'w1' ? { id } : undefined),
      resolveByPath: async () => undefined,
      create: async path => ({ id: 'w1', path }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async (request) => {
        created.push(request)
        return { sessionId: `new${created.length}` }
      },
      resolveAgent: async id => ({ agent: { id, session: { id } } }),
    },
    sessionTitle: { rename: async () => {} },
  })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  const relay = ctx.listeners.get('llm/stream').find(listener => /relayOrPass/.test(String(listener)))
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, created, relay, stop }
}

async function drain(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const userText = text => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const declared = (...names) => names.map(name => ({ name, description: '', parameters: {} }))
const relayCall = async (relay, tools) => {
  const chunks = await drain(relay({ provider: 'deepseek', model: 'v4', sessionId: 'room', messages: [userText('Hello team')], tools }, () => {
    throw new Error('a group round never reaches the model')
  }))
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  return chunks.find(chunk => chunk.type === 'block-end').block
}

test('a new Bot Session is made with the standard preset when DSH serves it', async (t) => {
  const { rt, created, stop } = start({ presets: [{ id: 'ptc' }, { id: 'standard' }] })
  t.after(stop)
  await rt.load()
  await rt.createSession('Chief')
  assert.deepEqual(created, [{ workspaceId: 'w1', agentPreset: 'standard' }])
})

test('without a usable standard preset a Bot Session keeps DSH\'s default', async (t) => {
  for (const presets of [undefined, [{ id: 'ptc' }], [{ id: 'standard', broken: 'failed to start' }]]) {
    const { rt, created, stop } = start({ presets })
    t.after(stop)
    await rt.load()
    await rt.createSession('Chief')
    assert.deepEqual(created, [{ workspaceId: 'w1' }])
  }
})

test('a group round calls group_relay directly when the Session declares it', async (t) => {
  const { relay, stop } = start()
  t.after(stop)
  for (const tools of [declared('read', 'group_relay'), declared('run_code', 'group_relay')]) {
    const block = await relayCall(relay, tools)
    assert.deepEqual([block.name, block.arguments], ['group_relay', '{}'])
  }
})

test('a group made under the PTC preset relays through run_code', async (t) => {
  const { relay, stop } = start()
  t.after(stop)
  const block = await relayCall(relay, declared('run_code'))
  assert.equal(block.name, 'run_code')
  assert.deepEqual(JSON.parse(block.arguments), {
    description: 'Relay the group chat to its Bots',
    code: 'return await tools.group_relay({})',
    timeoutMs: 600_000,
  })
})

// M1b-2.5: the company picks the default mode, an employee may follow it or pin one. The
// roster reads the company layer at the moment a Session is made; without it, standard.
const companyState = ({ companyMode, employeeMode, botId = 'chief' } = {}) => ({
  companies: companyMode === undefined && employeeMode === undefined ? {} : {
    cmp: { id: 'cmp', status: 'active', ...(companyMode === undefined ? {} : { conversation_mode: companyMode }) },
  },
  employees: employeeMode === undefined ? {} : {
    emp: { id: 'emp', status: 'active', bot_id: botId, ...(employeeMode === null ? {} : { conversation_mode: employeeMode }) },
  },
})

async function sessionRequestFor(t, { presets, state, botId = 'chief' }) {
  const { rt, created, stop } = start({ presets })
  t.after(stop)
  await rt.load()
  rt.company = { store: { state } }
  // `null` asks for a Session with no Bot behind it, the group's own relay.
  await rt.createSession('Chief', botId === null ? {} : { botId })
  return created
}

test('an employee who follows gets the company mode (M1b-2.5)', async (t) => {
  const state = companyState({ companyMode: 'ptc', employeeMode: 'follow' })
  const created = await sessionRequestFor(t, { presets: [{ id: 'ptc' }, { id: 'standard' }], state })
  assert.deepEqual(created, [{ workspaceId: 'w1', agentPreset: 'ptc' }])
})

test('an employee can pin a mode over the company default (M1b-2.5)', async (t) => {
  const presets = [{ id: 'ptc' }, { id: 'standard' }]
  const pinned = await sessionRequestFor(t, { presets, state: companyState({ companyMode: 'ptc', employeeMode: 'standard' }) })
  assert.deepEqual(pinned, [{ workspaceId: 'w1', agentPreset: 'standard' }])
  const forward = await sessionRequestFor(t, { presets, state: companyState({ companyMode: 'standard', employeeMode: 'ptc' }) })
  assert.deepEqual(forward, [{ workspaceId: 'w1', agentPreset: 'ptc' }])
})

test('a missing mode, or one this build does not know, reads as standard (M1b-2.5)', async (t) => {
  const presets = [{ id: 'ptc' }, { id: 'standard' }]
  // No company layer at all, a company row from before the field, and an employee row
  // from before it: all three read as standard, as every Session did before M1b-2.5.
  assert.deepEqual(await sessionRequestFor(t, { presets }), [{ workspaceId: 'w1', agentPreset: 'standard' }])
  assert.deepEqual(await sessionRequestFor(t, { presets, state: companyState({}) }), [{ workspaceId: 'w1', agentPreset: 'standard' }])
  assert.deepEqual(await sessionRequestFor(t, { presets, state: { companies: { cmp: { id: 'cmp', status: 'active' } }, employees: {} } }), [{ workspaceId: 'w1', agentPreset: 'standard' }])
  // A value outside the vocabulary falls back to the company default, then to standard.
  assert.deepEqual(await sessionRequestFor(t, { presets, state: companyState({ companyMode: 'ptc', employeeMode: 'turbo' }) }), [{ workspaceId: 'w1', agentPreset: 'ptc' }])
  assert.deepEqual(await sessionRequestFor(t, { presets, state: companyState({ companyMode: 'turbo', employeeMode: 'follow' }) }), [{ workspaceId: 'w1', agentPreset: 'standard' }])
  assert.deepEqual(await sessionRequestFor(t, { presets, state: companyState({ employeeMode: 'ptc', botId: 'another' }) }), [{ workspaceId: 'w1', agentPreset: 'standard' }])
})

test('PTC falls back to standard when this DSH does not serve it (M1b-2.5)', async (t) => {
  const state = companyState({ companyMode: 'ptc', employeeMode: 'follow' })
  assert.deepEqual(await sessionRequestFor(t, { presets: [{ id: 'standard' }], state }), [{ workspaceId: 'w1', agentPreset: 'standard' }])
  assert.deepEqual(await sessionRequestFor(t, { presets: [{ id: 'ptc', broken: 'failed to start' }, { id: 'standard' }], state }), [{ workspaceId: 'w1', agentPreset: 'standard' }])
  // A healthy PTC is used even when standard is not served; with PTC broken and no
  // standard there is nothing to ask for, so DSH's own default stands.
  assert.deepEqual(await sessionRequestFor(t, { presets: [{ id: 'ptc' }], state }), [{ workspaceId: 'w1', agentPreset: 'ptc' }])
  assert.deepEqual(await sessionRequestFor(t, { presets: [{ id: 'ptc', broken: 'failed to start' }], state }), [{ workspaceId: 'w1' }])
})

test('a group chat\'s own relay Session stays standard under a PTC company (M1b-2.5)', async (t) => {
  const state = companyState({ companyMode: 'ptc', employeeMode: 'follow' })
  const created = await sessionRequestFor(t, { presets: [{ id: 'ptc' }, { id: 'standard' }], state, botId: null })
  assert.deepEqual(created, [{ workspaceId: 'w1', agentPreset: 'standard' }])
})
