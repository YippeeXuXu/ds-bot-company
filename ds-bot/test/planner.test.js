import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/planner.js'

// The planner reads a Bot's stored pair, asks that model for a plan once per turn, and
// hands the plan to the turn through a system-prompt section. These tests drive the two
// hooks it installs and the section it registers, with no Session of their own.

function harness({ planner = { provider: 'strong', model: 'deep' }, executor = 'fast/quick', plan = 'First read the card, then answer in two lines.', fail = false } = {}) {
  const listeners = new Map()
  const sections = []
  const calls = []
  const warnings = []
  const on = (name, fn) => {
    const list = listeners.get(name) ?? []
    list.push(fn)
    listeners.set(name, list)
    return () => {}
  }
  const ctx = {
    on,
    effect: fn => fn(),
    systemPrompt: { section: section => { sections.push(section); return () => {} } },
    llm: {
      async* stream(options) {
        calls.push(options)
        if (fail) throw new Error('planner route is down')
        yield { type: 'text-delta', index: 0, text: plan }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const state = { employees: planner === null ? {} : { e1: { id: 'e1', bot_id: 'b1', status: 'active', planner } } }
  const rt = {
    ctx,
    company: { store: { state } },
    botOf: id => (id === 'b1' ? { id: 'b1', name: 'Bot' } : undefined),
    selfOf: id => (id === 's1' ? 'b1' : undefined),
    groupOwners: new Map(),
    eventsBackwards: async function* () {},
    historyEntry: () => undefined,
    resolveModel: async ref => ref,
    desiredModel: async () => executor,
    resolveEffort: async (_ref, effort) => effort,
    tagUsage: messages => messages,
    warn: (...args) => warnings.push(args.join(' ')),
  }
  install(rt)
  return { ctx, listeners, sections, calls, warnings, rt }
}

const emit = async (listeners, name, ...args) => {
  for (const fn of listeners.get(name) ?? []) await fn(...args)
}
const claimed = (h, { sessionId = 's1', turn = 3, text = 'Add the missing test for acceptances.', header = {} } = {}) => emit(h.listeners, 'agent/inbox/claimed', {
  message: { content: [{ type: 'text', text }] },
  turn,
  agent: { id: sessionId, session: { id: sessionId, header } },
})
const assemble = async (h, { sessionId = 's1', header = {} } = {}) => {
  let ran = 0
  await emit(h.listeners, 'system-prompt/assemble', {}, { agent: { id: sessionId, session: { id: sessionId, header } } }, async () => { ran += 1 })
  assert.equal(ran, 1, 'the section renderer still runs after planning')
}
const planText = (h) => h.sections.find(section => section.name === 'bot-plan')?.text({ agent: { id: 's1' } }) ?? ''

test('a stored planner asks its model once before the turn, and the plan becomes one section', async () => {
  const h = harness()
  await claimed(h)
  await assemble(h)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].provider, 'strong')
  assert.equal(h.calls[0].model, 'deep')
  assert.equal(h.calls[0].sessionId, 's1')
  assert.match(h.calls[0].system ?? '', /plan one turn/)
  assert.match(JSON.stringify(h.calls[0].messages), /Add the missing test for acceptances/)
  assert.match(planText(h), /First read the card/)
  // The section is injected, not the transcript: nothing else was written.
  assert.equal(h.sections.length, 1)
  assert.equal(h.sections[0].order, 646)
  assert.equal(h.sections[0].interpolate, false)
})

test('one turn is planned once, and a later turn plans again', async () => {
  const h = harness()
  await claimed(h, { turn: 3 })
  await assemble(h)
  await assemble(h)
  assert.equal(h.calls.length, 1, 'the same turn reuses its plan')
  await emit(h.listeners, 'session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 4 } })
  await claimed(h, { turn: 4, text: 'Now write the report.' })
  await assemble(h)
  assert.equal(h.calls.length, 2)
})

test('no planner, the same model, or a subagent leaves the turn as it was', async () => {
  const none = harness({ planner: null })
  await claimed(none)
  await assemble(none)
  assert.equal(none.calls.length, 0)
  assert.equal(planText(none), '')

  const same = harness({ planner: { provider: 'fast', model: 'quick' }, executor: 'fast/quick' })
  await claimed(same)
  await assemble(same)
  assert.equal(same.calls.length, 0, 'the planning model is the running model')

  const sub = harness()
  await claimed(sub, { header: { origin: 'subagent' } })
  await assemble(sub, { header: { origin: 'subagent' } })
  assert.equal(sub.calls.length, 0)
})

test('a planner route that fails warns once, does not block the turn, and is not retried this turn', async () => {
  const h = harness({ fail: true })
  await claimed(h, { turn: 5 })
  await assemble(h)
  await assemble(h)
  assert.equal(h.calls.length, 1)
  assert.equal(h.warnings.length, 1)
  assert.equal(planText(h), '')
})

test('only the claimed turn message is planned from, and a later turn drops the old plan', async () => {
  const h = harness()
  await claimed(h, { turn: 1, text: 'first ask' })
  await assemble(h)
  assert.match(planText(h), /First read the card/)
  await emit(h.listeners, 'session/event', { id: 's1' }, { type: 'turn/start', data: { turn: 2 } })
  assert.equal(planText(h), '', 'a new turn starts without yesterday\'s plan')
})
