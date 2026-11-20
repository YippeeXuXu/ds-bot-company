// Memory slices (M2 G4 4.1 + 4.2): the file the slices live in, how a turn is cut, and
// what a turn ending writes. The cases follow the two items' done-when: every line parses
// and carries the contract's fields, `state.json` never holds a slice, three turns make
// three slices, and a key-shaped string never reaches the file.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SLICE_FIELDS, SLICES_PER_BOT, chunkTurn, createSliceStore, install } from '../src/host/memory-slices.js'

const openHome = () => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-memory-slices-'))
  mkdirSync(join(home, 'memory-slices'), { recursive: true })
  return home
}

const row = (extra = {}) => ({
  bot_id: 'bot_1', project_id: 'prj_1', session_id: 's_1', kind: 'chat', text: 'User: 甲方要蓝色。',
  tokens: 6, embedding: null, embedding_model: null, created_at: 10, last_used_at: 10, uses: 0,
  ...extra,
})

// A runtime just big enough for the capture path: no listeners, one conversation.
const runtimeFor = ({ home, lines = [], rooms = {}, owners = {}, secrets = [] }) => {
  const map = entries => new Map(Object.entries(entries))
  const rt = {
    home,
    warn: () => {},
    chatOwners: map(owners.chats ?? { s_1: 'bot_1' }),
    groupOwners: map(owners.groups ?? {}),
    pastOwners: map(owners.past ?? {}),
    roomOf: id => rooms[id],
    memoryProjectOf: () => 'prj_1',
    redactSecrets: text => {
      let out = text
      for (const secret of secrets) out = out.replaceAll(secret, '[secret:KEY]')
      return out
    },
    partLines: async function* partLines(sessionId) {
      if (sessionId !== 's_1') return
      for (const line of [...lines].reverse()) yield line
    },
  }
  return rt
}

test('4.1: a slice line parses, keeps the contract fields in order, and state.json stays without it', async () => {
  const home = openHome()
  const store = createSliceStore({ dir: join(home, 'memory-slices'), now: () => 1000 })
  const saved = await store.append([row({ text: 'User: 甲方要蓝色。' })])
  assert.equal(saved.length, 1)
  assert.match(saved[0].id, /^sl_[0-9a-f]{12}$/)

  const lines = readFileSync(join(home, 'memory-slices', 'slices.jsonl'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  const parsed = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(parsed), SLICE_FIELDS)
  assert.equal(parsed.block, undefined)
  for (const field of SLICE_FIELDS) assert.ok(Object.hasOwn(parsed, field), `${field} is in the line`)
  assert.equal(parsed.embedding, null)
  assert.equal(parsed.uses, 0)
  assert.equal(typeof parsed.created_at, 'number')

  // The company file and the team file are elsewhere; a slice never lands in either.
  assert.equal(existsSync(join(home, 'company', 'state.json')), false)
  assert.equal(existsSync(join(home, 'state.json')), false)
})

test('4.1: a line that cannot be parsed is skipped by name, and the rest still read', async () => {
  const home = openHome()
  const store = createSliceStore({ dir: join(home, 'memory-slices'), warn: () => {}, now: () => 1 })
  await store.append([row()])
  writeFileSync(join(home, 'memory-slices', 'slices.jsonl'), `${readFileSync(join(home, 'memory-slices', 'slices.jsonl'))}{"broken"\n`)
  const warned = []
  const strict = createSliceStore({ dir: join(home, 'memory-slices'), warn: (...args) => warned.push(args), now: () => 1 })
  const rows = strict.read()
  assert.equal(rows.length, 1)
  assert.equal(warned.length, 1)
  assert.match(String(warned[0][0]), /memory slice line %d cannot be parsed/)
})

test('4.1: the 5,001st slice for one Bot is refused and says so, nothing is deleted', async () => {
  const home = openHome()
  const store = createSliceStore({ dir: join(home, 'memory-slices'), warn: (...args) => warned.push(args), now: () => 1 })
  const warned = []
  const rows = Array.from({ length: SLICES_PER_BOT }, () => row({ text: 'User: 一条。' }))
  await store.append(rows)
  assert.equal(store.countOf('bot_1'), SLICES_PER_BOT)
  const refused = await store.append([row({ text: 'User: 再来一条。' })])
  assert.deepEqual(refused, [])
  assert.equal(store.countOf('bot_1'), SLICES_PER_BOT)
  assert.equal(warned.length, 1)
  assert.match(String(warned[0][0]), /at the %d-slice cap/)
})

test('4.2: a short turn is one piece; a long turn is cut under the maximum and keeps its lines', () => {
  const short = chunkTurn('User: 甲方要蓝色。\nBot: 收到。')
  assert.equal(short.length, 1)
  assert.equal(short[0], 'User: 甲方要蓝色。\nBot: 收到。')

  const line = `Bot: ${'我们按蓝色做主色，'.repeat(100)}`
  const long = chunkTurn(`User: 说详细一点。\n${line}`)
  assert.ok(long.length > 1)
  for (const piece of long) assert.ok(piece.length <= 800, `piece of ${piece.length} characters`)
  // The cut lands on a character boundary, so the join keeps every character and only
  // grows a newline where a piece ended.
  const flat = text => text.replace(/\s+/g, '')
  assert.equal(flat(long.join('')), flat(`User: 说详细一点。\n${line}`))

  // One line longer than the maximum is cut on its own, not dropped.
  const huge = chunkTurn('Bot: ' + 'x'.repeat(1900))
  assert.ok(huge.length >= 3)
  for (const piece of huge) assert.ok(piece.length <= 800)
  assert.equal(huge.join('').replace(/^Bot: /, ''), 'x'.repeat(1900))
})

test('4.2: three turns make three slices, with the Bot, the session and the project on each', async () => {
  const home = openHome()
  const lines = []
  const rt = runtimeFor({ home, lines })
  install(rt)

  for (const turn of ['第一轮：先把需求说清。', '第二轮：甲方要蓝色。', '第三轮：明天交付。']) {
    lines.push({ seq: lines.length + 1, who: 'user', text: `User: ${turn}`, time: 1000 + lines.length })
    lines.push({ seq: lines.length + 1, who: 'bot', text: 'You: 收到。', time: 1000 + lines.length })
    await rt.memorySlices.capture('s_1')
  }

  const rows = rt.memorySlices.list()
  assert.equal(rows.length, 3)
  assert.equal(rt.memorySlices.count('bot_1'), 3)
  assert.deepEqual(rows.map(slice => slice.kind), ['chat', 'chat', 'chat'])
  for (const slice of rows) {
    assert.equal(slice.bot_id, 'bot_1')
    assert.equal(slice.session_id, 's_1')
    assert.equal(slice.project_id, 'prj_1')
    assert.equal(slice.embedding, null)
    assert.equal(slice.embedding_model, null)
    assert.equal(slice.uses, 0)
  }
  assert.match(rows[0].text, /第一轮/)
  assert.match(rows[1].text, /甲方要蓝色/)
  assert.match(rows[2].text, /明天交付/)

  // The cursor keeps a second capture of the same conversation from writing them again.
  await rt.memorySlices.capture('s_1')
  assert.equal(rt.memorySlices.list().length, 3)
})

test('4.2: a saved secret and a key-shaped string never reach a slice', async () => {
  const home = openHome()
  // Built at runtime on purpose: a key-shaped run in this file would trip the leak scan,
  // which only looks at what a reader can copy verbatim.
  const fakeKey = ['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('-')
  const lines = [
    { seq: 1, who: 'user', text: `User: 数据库口令是 hunter2，另外 api key 是 ${fakeKey}`, time: 1000 },
    { seq: 2, who: 'bot', text: 'You: 记下了。', time: 1001 },
  ]
  const rt = runtimeFor({ home, lines, secrets: ['hunter2'] })
  install(rt)
  await rt.memorySlices.capture('s_1')
  const [slice] = rt.memorySlices.list()
  assert.equal(slice.text.includes('hunter2'), false)
  assert.equal(slice.text.includes(fakeKey), false)
  assert.match(slice.text, /\[secret:KEY\]/)
  assert.match(slice.text, /\[secret\]/)
})

test('4.2: a group round is sliced under the group, from its log', async () => {
  const home = openHome()
  const rt = runtimeFor({
    home,
    owners: { chats: {}, groups: { s_member: 'bot_1' }, past: { s_member: 'r_1' } },
    rooms: {
      r_1: {
        id: 'r_1', name: '项目群',
        log: [
          { seq: 1, who: 'User', text: '今天先对需求。', botId: undefined, time: 2000 },
          { seq: 2, who: '林一', text: '需求我整理好了。', botId: 'bot_1', time: 2001 },
        ],
      },
    },
  })
  // A member's group Session owns no chat; the group says which room it is.
  rt.groupOwners = new Map([['s_member', { botId: 'bot_1', roomId: 'r_1' }]])
  install(rt)
  await rt.memorySlices.capture('s_member')
  const [slice] = rt.memorySlices.list()
  assert.equal(slice.kind, 'group')
  assert.equal(slice.bot_id, 'bot_1')
  assert.equal(slice.session_id, 'r_1')
  assert.match(slice.text, /User: 今天先对需求。/)
  assert.match(slice.text, /林一: 需求我整理好了。/)
})

test('4.2: clear drops one Bot\'s slices and keeps the others', async () => {
  const home = openHome()
  const store = createSliceStore({ dir: join(home, 'memory-slices'), now: () => 1 })
  await store.append([row(), row({ bot_id: 'bot_2' })])
  assert.equal(store.read().length, 2)
  const kept = await store.clear('bot_1')
  assert.equal(kept, 1)
  assert.deepEqual(store.read().map(slice => slice.bot_id), ['bot_2'])
})
