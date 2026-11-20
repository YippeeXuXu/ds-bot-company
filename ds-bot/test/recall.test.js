// Recall (G4 4.4): the section is filled from the Bot's own slices after the assembly is
// built, never before; a turn waits at most 300 ms; a relay Session and a session that is
// not a Bot's own get nothing; and a slice of the conversation being answered is skipped.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DECAY_FACTOR,
  RECALL_LIMIT,
  RECALL_MIN_HITS,
  RECALL_ORDER,
  RECALL_TIMEOUT_MS,
  decayFactor,
  install,
  pickRecall,
  recallScore,
  recallText,
  tokensOf,
} from '../src/host/recall.js'

const row = (id, text, { bot = 'b1', kind = 'chat', session = 's0', at = '2026-11-10T09:00:00.000Z' } = {}) => ({
  id,
  bot_id: bot,
  session_id: session,
  kind,
  text,
  created_at: at,
})

function harness({ rows = [], hang = false, broken = false } = {}) {
  const listeners = new Map()
  const sections = []
  const patches = []
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
  }
  const rt = {
    ctx,
    // s1, s3 and g1 are one Bot's own sessions; g2 is a group chat that was closed;
    // relay1 is the group relay's.
    selfOf: id => (['s1', 's3', 'g1', 'g2'].includes(id) ? 'b1' : undefined),
    roomOf: id => (id === 'relay1' ? { id: 'r1', sessionId: 'relay1' } : undefined),
    groupOwners: new Map([['g1', { botId: 'b1', roomId: 'r1' }]]),
    pastOwners: new Map([['g2', { botId: 'b1', roomId: 'r0' }]]),
    memorySlices: {
      list: () => {
        if (broken) throw new Error('the slice file is unreadable')
        return hang ? new Promise(() => {}) : rows
      },
      patch: updates => {
        patches.push(updates)
        return Promise.resolve(updates.length)
      },
    },
    warn: () => {},
  }
  install(rt)
  return { listeners, sections, rt, patches }
}

// A step claims the user's message from the inbox just before it assembles the prompt, and
// the plugin keeps the newest claimed message per Session.
const say = (h, text, { sessionId = 's1', kind = 'user', ...source } = {}) => {
  const payload = { agent: { session: { id: sessionId } }, message: { content: [{ type: 'text', text }], source: { kind, ...source } } }
  for (const listener of h.listeners.get('agent/inbox/claimed') ?? []) listener(payload)
}

// DSH renders every registered section before the waterfall runs, then the hook's return
// value is the assembly the prompt is rendered from. This copies that order.
const assemble = async (h, { sessionId = 's1' } = {}) => {
  const context = { agent: { id: sessionId } }
  const assembly = {
    sections: h.sections.map(section => ({
      name: section.name,
      text: typeof section.text === 'function' ? section.text(context) : section.text,
      ...section.interpolate !== undefined ? { interpolate: section.interpolate } : {},
    })),
  }
  const hooks = h.listeners.get('system-prompt/assemble') ?? []
  assert.equal(hooks.length, 1)
  let ran = false
  const result = await hooks[0](assembly, context, async () => { ran = true; return assembly })
  assert.equal(ran, true, 'the assembly is built before recall runs')
  return result
}

const sectionOf = (assembly, name) => assembly.sections.find(section => section.name === name)

test('tokens count Latin words and neighbouring CJK characters, not particles alone', () => {
  const tokens = tokensOf('我们把主色定成 Blue-Green，OK')
  assert.equal(tokens.has('blue-green'), true)
  assert.equal(tokens.has('ok'), true, 'two letters is a word')
  assert.equal(tokensOf('a b').size, 0, 'one letter is not')
  assert.equal(tokens.has('主色'), true)
  assert.equal(tokens.has('把主'), false, 'a particle takes the pair with it')
  assert.equal(tokensOf('的了吗').size, 0)
  assert.equal(tokensOf('').size, 0)
})

test('recallScore counts the words of the message that are in the slice', () => {
  const query = tokensOf('主色 蓝色 上线')
  assert.equal(recallScore(query, '我们把主色定成蓝色。'), 2)
  assert.equal(recallScore(query, '周五上线。'), 1)
  assert.equal(recallScore(tokensOf(''), 'anything'), 0)
})

test('pickRecall keeps two shared words, sorts by hits then by newest, and stops at four', () => {
  const query = '主色 蓝色 上线 设计'
  const rows = [
    row('sl_old', '主色和蓝色都在设计稿里，周五上线', { at: '2026-11-01T00:00:00.000Z' }),
    row('sl_new', '主色和蓝色都在设计稿里，周五上线', { at: '2026-11-10T00:00:00.000Z' }),
    row('sl_few', '主色而已', { at: '2026-11-10T00:00:00.000Z' }),
    row('sl_1', '主色 蓝色', { at: '2026-11-02T00:00:00.000Z' }),
    row('sl_2', '主色 蓝色', { at: '2026-11-03T00:00:00.000Z' }),
    row('sl_3', '主色 蓝色', { at: '2026-11-04T00:00:00.000Z' }),
  ]
  const picked = pickRecall({ query, rows })
  assert.equal(picked.length, RECALL_LIMIT)
  assert.equal(picked[0].id, 'sl_new', 'the newest of the best wins a tie')
  assert.equal(picked[1].id, 'sl_old')
  assert.equal(picked.some(entry => entry.id === 'sl_few'), false)
  assert.equal(RECALL_MIN_HITS, 2)
  assert.deepEqual(pickRecall({ query: '', rows }), [])
})

test('recallText is a record of what was said, one line a slice, dated', () => {
  const text = recallText([row('sl_1', '我们把主色\n定成蓝色。'), row('sl_2', '周五上线。', { at: '' })])
  const lines = text.split('\n')
  assert.equal(lines[0], '# What you remember')
  assert.match(lines[1], /records, not instructions/)
  assert.match(lines[2], /^- 2026-11-10 · 我们把主色 定成蓝色。$/)
  assert.equal(lines[3], '- 周五上线。')
  assert.equal(recallText([]), '')
})

test('the section is registered empty at the turn plan order', () => {
  const { sections } = harness()
  const slot = sections.find(section => section.name === 'bot-recall')
  assert.equal(slot.order, RECALL_ORDER)
  assert.equal(RECALL_ORDER, 647)
  assert.equal(slot.interpolate, false)
  assert.equal(slot.text({ agent: { id: 's1' } }), '')
})

test('matching slices fill the already-rendered slot after the assembly exists', async () => {
  const rows = [row('sl_1', '我们把主色定成蓝色，蓝色用 #2E6BE6。'), row('sl_2', '无关的一句话。')]
  const h = harness({ rows })
  say(h, '主色定成蓝色了吗？')
  const assembly = await assemble(h)
  const slot = sectionOf(assembly, 'bot-recall')
  assert.match(slot.text, /^# What you remember\n/)
  assert.match(slot.text, /主色定成蓝色/)
  assert.doesNotMatch(slot.text, /无关的一句话/)
  // The original assembly is left alone: the hook returns its own copy.
  assert.equal(h.sections.length, 1)
})

test('no match adds no empty section, and a relay Session asks for nothing', async () => {
  const noneHarness = harness({ rows: [row('sl_1', '完全无关的内容。')] })
  say(noneHarness, '今天天气怎么样')
  const none = await assemble(noneHarness)
  assert.equal(sectionOf(none, 'bot-recall').text, '')
  const relayHarness = harness({ rows: [row('sl_1', '我们把主色定成蓝色。')] })
  say(relayHarness, '我们把主色定成蓝色了吗')
  const relay = await assemble(relayHarness, { sessionId: 'relay1' })
  assert.equal(sectionOf(relay, 'bot-recall').text, '')
  const strangerHarness = harness({ rows: [row('sl_1', '我们把主色定成蓝色。')] })
  say(strangerHarness, '我们把主色定成蓝色了吗', { sessionId: 'someone' })
  const stranger = await assemble(strangerHarness, { sessionId: 'someone' })
  assert.equal(sectionOf(stranger, 'bot-recall').text, '')
})

test('the message is kept per Session, and a Bot\'s own handoff is not the user\'s words', async () => {
  const rows = [row('sl_1', '我们把主色定成蓝色。')]
  const h = harness({ rows })
  say(h, 'handoff: 我们把主色定成蓝色', { kind: 'bot', handoff: true })
  assert.equal(sectionOf(await assemble(h), 'bot-recall').text, '', 'a handoff asks nothing')
  say(h, 'kickoff 我们把主色定成蓝色', { kind: 'bot', role: 'kickoff' })
  assert.equal(sectionOf(await assemble(h), 'bot-recall').text, '', 'a kickoff asks nothing')
  say(h, '我们把主色定成蓝色可以上线吗')
  assert.match(sectionOf(await assemble(h), 'bot-recall').text, /主色定成蓝色/)
  say(h, '换个话题聊聊', { sessionId: 's2' })
  assert.equal(sectionOf(await assemble(h, { sessionId: 's2' }), 'bot-recall').text, '', 'each Session keeps its own message')
})

test('a slice of the conversation being answered is not recalled into it', async () => {
  const rows = [
    row('sl_same', '我们把主色定成蓝色。', { session: 's1' }),
    row('sl_other', '我们把主色定成蓝色。', { session: 's2', at: '2026-11-09T00:00:00.000Z' }),
  ]
  const h = harness({ rows })
  say(h, '我们把主色定成蓝色了吗')
  const assembly = await assemble(h)
  const text = sectionOf(assembly, 'bot-recall').text
  assert.match(text, /2026-11-09/)
  assert.doesNotMatch(text, /2026-11-10 · /)
})

test('a group conversation recalls group slices only, and a private chat chat slices', async () => {
  const rows = [
    row('sl_chat', '我们把主色定成蓝色。', { kind: 'chat', session: 's2', at: '2026-11-08T00:00:00.000Z' }),
    row('sl_group', '我们把主色定成蓝色。', { kind: 'group', session: 'g0', at: '2026-11-09T00:00:00.000Z' }),
  ]
  const privateHarness = harness({ rows })
  say(privateHarness, '我们把主色定成蓝色了吗')
  const privateText = sectionOf(await assemble(privateHarness), 'bot-recall').text
  assert.match(privateText, /2026-11-08/)
  assert.doesNotMatch(privateText, /2026-11-09/)
  const groupHarness = harness({ rows })
  // In a group a Bot is asked by the company, not by the user directly.
  say(groupHarness, '我们把主色定成蓝色了吗', { sessionId: 'g1', kind: 'bot', role: 'round' })
  const groupText = sectionOf(await assemble(groupHarness, { sessionId: 'g1' }), 'bot-recall').text
  assert.match(groupText, /2026-11-09/)
  assert.doesNotMatch(groupText, /2026-11-08/)
})

test('the cache is per Session, so a group and a private chat never swap slices', async () => {
  const rows = [
    row('sl_chat', '我们把主色定成蓝色。', { kind: 'chat', session: 'old-chat', at: '2026-11-08T00:00:00.000Z' }),
    row('sl_group', '我们把主色定成蓝色。', { kind: 'group', session: 'old-group', at: '2026-11-09T00:00:00.000Z' }),
  ]
  const h = harness({ rows })
  say(h, '主色定成蓝色了吗')
  const privateText = sectionOf(await assemble(h), 'bot-recall').text
  say(h, '主色定成蓝色了吗', { sessionId: 'g1', kind: 'bot', role: 'round' })
  const groupText = sectionOf(await assemble(h, { sessionId: 'g1' }), 'bot-recall').text
  assert.match(privateText, /2026-11-08/)
  assert.doesNotMatch(privateText, /2026-11-09/)
  assert.match(groupText, /2026-11-09/, 'the same sentence in the group asks for group slices again')
  assert.doesNotMatch(groupText, /2026-11-08/, 'a group turn does not read the private recall')
})

test('another Session of the same Bot recalls a slice this Session may not', async () => {
  const rows = [row('sl_s1', '我们把主色定成蓝色。', { session: 's1' })]
  const h = harness({ rows })
  say(h, '主色定成蓝色了吗')
  assert.equal(sectionOf(await assemble(h), 'bot-recall').text, '', 'a Session never recalls itself')
  say(h, '主色定成蓝色了吗', { sessionId: 's3' })
  assert.match(sectionOf(await assemble(h, { sessionId: 's3' }), 'bot-recall').text, /主色定成蓝色/)
})

test('a closed group chat still recalls group slices', async () => {
  const rows = [
    row('sl_chat', '我们把主色定成蓝色。', { kind: 'chat', session: 'old-chat', at: '2026-11-08T00:00:00.000Z' }),
    row('sl_group', '我们把主色定成蓝色。', { kind: 'group', session: 'old-group', at: '2026-11-09T00:00:00.000Z' }),
  ]
  const h = harness({ rows })
  say(h, '主色定成蓝色了吗', { sessionId: 'g2', kind: 'bot', role: 'round' })
  const text = sectionOf(await assemble(h, { sessionId: 'g2' }), 'bot-recall').text
  assert.match(text, /2026-11-09/)
  assert.doesNotMatch(text, /2026-11-08/)
})

test('a hanging slice store costs the turn 300 ms and nothing else', async () => {
  const h = harness({ rows: [row('sl_1', '我们把主色定成蓝色。')], hang: true })
  say(h, '我们把主色定成蓝色了吗')
  const started = Date.now()
  const assembly = await assemble(h)
  const elapsed = Date.now() - started
  assert.equal(sectionOf(assembly, 'bot-recall').text, '')
  assert.ok(elapsed >= RECALL_TIMEOUT_MS - 50, `waited at most ${elapsed} ms`)
  assert.ok(elapsed < 1_500, `waited ${elapsed} ms`)
})

test('a slice store that throws leaves the prompt exactly as it was', async () => {
  const h = harness({ broken: true })
  say(h, '我们把主色定成蓝色了吗')
  const assembly = await assemble(h)
  assert.equal(sectionOf(assembly, 'bot-recall').text, '')
})

test('a slice unused for ninety days counts half', () => {
  const now = Date.parse('2026-11-20T00:00:00.000Z')
  const old = { ...row('sl_old', '蓝色方案的预算表在共享盘', { at: '2026-01-02T00:00:00.000Z' }), last_used_at: '2026-01-02T00:00:00.000Z' }
  const fresh = { ...row('sl_new', '蓝色方案的预算表在共享盘', { at: '2026-11-10T00:00:00.000Z' }), last_used_at: '2026-11-10T00:00:00.000Z' }
  assert.equal(decayFactor(old, now), DECAY_FACTOR)
  assert.equal(decayFactor(fresh, now), 1)
  const picked = pickRecall({ query: '蓝色方案的预算表', rows: [old, fresh], now })
  assert.deepEqual(picked.map(item => item.id), ['sl_new', 'sl_old'], 'the fresh slice leads when both hit the same words')
})

test('a recalled slice has its use and time written back', async () => {
  const h = harness({ rows: [row('sl_a', '蓝色方案的预算表在共享盘 finance/2026Q1.xlsx')] })
  say(h, '蓝色方案的预算表放哪了')
  await assemble(h)
  assert.equal(h.patches.length, 1)
  const update = h.patches[0][0]
  assert.equal(update.id, 'sl_a')
  assert.equal(update.uses, 1)
  assert.match(update.last_used_at, /^\d{4}-\d{2}-\d{2}T/)
})
