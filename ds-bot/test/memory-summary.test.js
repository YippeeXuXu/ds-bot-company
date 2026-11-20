// Memory summaries (G4 4.5): near slices of one subject become one summary whose
// `summary_of` keeps every source, the originals move to the archive and can be put back,
// and a model that fails skips the group without writing half a row.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSliceStore } from '../src/host/memory-slices.js'
import { MERGE_MAX, MERGE_THRESHOLD, cosine, groupSlices, install, normalizeSettingsPatch, resolveSummarySettings, summaryText } from '../src/host/memory-summary.js'

const openDir = () => mkdtempSync(join(tmpdir(), 'ds-bot-summary-'))

const slice = (id, text, { bot = 'b1', kind = 'chat', session = 's0', at = '2026-11-10T09:00:00.000Z', embedding = null, used = null, uses = 0 } = {}) => ({
  id,
  bot_id: bot,
  project_id: null,
  session_id: session,
  kind,
  text,
  tokens: 10,
  embedding,
  embedding_model: embedding === null ? null : 'mock',
  created_at: at,
  last_used_at: used ?? at,
  uses,
})

const vec = (...values) => values

// A chat model on the Ollama shape, answering with whatever the caller set.
const mockChat = (answer = 'One short summary.') => {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const asked = JSON.parse(body)
      server.calls = (server.calls ?? 0) + 1
      server.lastPrompt = asked.messages?.[0]?.content ?? ''
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { role: 'assistant', content: answer } }))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

const runtimeFor = ({ dir, home = dir, config = {}, warn = () => {} }) => {
  const store = createSliceStore({ dir, warn })
  const rt = {
    ctx: { on: () => () => {}, effect: fn => { fn(); return () => {} } },
    config,
    home,
    selfOf: id => (id === 's1' ? 'b1' : undefined),
    memorySlices: {
      list: () => store.read(),
      merge: plan => store.merge(plan),
      restore: id => store.restore(id),
    },
    warn,
  }
  install(rt)
  return { rt, store }
}

test('cosine compares only vectors of the same length', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([1, 0], null), 0)
  assert.equal(cosine([1, 0], [1, 0, 0]), 0)
  assert.equal(cosine([0, 0], [1, 0]), 0)
})

test('three slices of one subject become one group, a different subject stays out', () => {
  const rows = [
    slice('a', '蓝色方案的季度预算表先压差旅。', { embedding: vec(1, 0, 0) }),
    slice('b', '蓝色方案的季度预算表差旅压到 8 万。', { embedding: vec(0.99, 0.05, 0) }),
    slice('c', '蓝色方案预算表差旅那栏定了。', { embedding: vec(0.98, 0.08, 0) }),
    slice('d', '服务器迁移到新机房。', { embedding: vec(0, 1, 0) }),
  ]
  const groups = groupSlices(rows)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].map(row => row.id), ['a', 'b', 'c'])
})

test('the same words group even when neither row has a vector', () => {
  const rows = [
    slice('a', '差旅预算改到 8 万。'),
    slice('b', '差旅预算改到 8 万。  '),
    slice('c', '别的事。'),
  ]
  const groups = groupSlices(rows)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].map(row => row.id), ['a', 'b'])
})

test('summaries are never merged again, and a group stops at the maximum', () => {
  const row = (id) => slice(id, `同一件事 ${id}`, { embedding: vec(1, 0) })
  const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(row)
  const groups = groupSlices(rows)
  assert.equal(groups[0].length, MERGE_MAX)
  const merged = slice('s', '同一件事的摘要', { embedding: vec(1, 0) })
  merged.summary_of = ['a', 'b']
  const again = groupSlices([merged, ...rows])
  assert.equal(again.length, 1, 'only the plain slices are grouped')
  assert.equal(again[0].some(row => row.id === 's'), false)
})

test('the fallback summary keeps the distinct lines and counts its sources', () => {
  const rows = [slice('a', 'User: 差旅预算改到 8 万。'), slice('b', 'User: 差旅预算改到 8 万。'), slice('c', 'Bot: 好，记下了。')]
  const text = summaryText(rows)
  assert.match(text, /^Merged from 3 earlier turns/)
  assert.match(text, /差旅预算改到 8 万/)
  assert.match(text, /好，记下了/)
  assert.equal((text.match(/差旅预算改到 8 万/g) ?? []).length, 1, 'a repeated line is written once')
  assert.ok(summaryText(rows).length <= 800)
})

test('run merges the near slices, keeps every source, and archives the originals', async () => {
  const dir = openDir()
  const { rt, store } = runtimeFor({ dir })
  const rows = [
    slice('sl_a', '蓝色方案的季度预算表先压差旅。', { session: 'old-1', embedding: vec(1, 0, 0) }),
    slice('sl_b', '蓝色方案的季度预算表差旅压到 8 万。', { session: 'old-2', embedding: vec(0.99, 0.05, 0) }),
    slice('sl_c', '蓝色方案预算表差旅那栏定了。', { session: 'old-3', embedding: vec(0.98, 0.08, 0) }),
    slice('sl_d', '服务器迁移到新机房。', { session: 'old-4', embedding: vec(0, 1, 0) }),
  ]
  await store.append(rows)
  const result = await rt.memorySummary.run('b1')
  assert.deepEqual({ groups: result.groups, merged: result.merged, skipped: result.skipped }, { groups: 1, merged: 3, skipped: 0 })
  const after = store.read()
  assert.equal(after.length, 2, 'three rows became one, the unrelated row stays')
  const summary = after.find(row => Array.isArray(row.summary_of))
  assert.deepEqual([...summary.summary_of].sort(), ['sl_a', 'sl_b', 'sl_c'])
  assert.equal(summary.kind, 'chat')
  assert.equal(summary.session_id, null)
  assert.match(summary.text, /差旅/)
  const archived = readFileSync(store.archivePath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(archived.map(row => row.id).sort(), ['sl_a', 'sl_b', 'sl_c'])
  assert.equal(archived.every(row => row.summary_id === summary.id), true)
  assert.equal(existsSync(store.archivePath), true)
})

test('a model that fails skips the group and leaves no half-written row', async () => {
  const dir = openDir()
  const warnings = []
  const { rt, store } = runtimeFor({
    dir,
    warn: (...args) => warnings.push(args.join(' ')),
    config: { memorySummary: { endpoint: 'ollama', base_url: 'http://127.0.0.1:9', model: 'mock' } },
  })
  const rows = [
    slice('sl_a', '蓝色方案的季度预算表先压差旅。', { embedding: vec(1, 0) }),
    slice('sl_b', '蓝色方案的季度预算表差旅压到 8 万。', { embedding: vec(0.99, 0.05) }),
  ]
  await store.append(rows)
  const result = await rt.memorySummary.run('b1')
  assert.equal(result.skipped, 1)
  assert.equal(store.read().length, 2, 'nothing was written')
  assert.equal(existsSync(store.archivePath), false)
  assert.match(warnings.join('\n'), /memory summary skipped a group/)
  assert.match(rt.memorySummary.state().problem, /could not be reached|ECONNREFUSED|fetch failed/)
  // Once the page clears the address, the state names the missing field again instead of
  // repeating the older run's failure.
  rt.memorySummary.save({ base_url: '' })
  assert.equal(rt.memorySummary.state().configured, false)
  assert.equal(rt.memorySummary.state().problem, 'base_url is not set')
})

test('a configured model writes the summary it answers, and the prompt carries the sources', async (t) => {
  const dir = openDir()
  const chat = await mockChat('蓝色方案的差旅预算定为 8 万。')
  t.after(() => chat.server.close())
  const { rt, store } = runtimeFor({ dir, config: { memorySummary: { endpoint: 'ollama', base_url: chat.base, model: 'mock' } } })
  await store.append([
    slice('sl_a', '蓝色方案的季度预算表先压差旅。', { embedding: vec(1, 0) }),
    slice('sl_b', '蓝色方案的季度预算表差旅压到 8 万。', { embedding: vec(0.99, 0.05) }),
  ])
  const result = await rt.memorySummary.run('b1')
  assert.equal(result.merged, 2)
  assert.match(chat.server.lastPrompt, /蓝色方案的季度预算表先压差旅/)
  const summary = store.read().find(row => Array.isArray(row.summary_of))
  assert.equal(summary.text, '蓝色方案的差旅预算定为 8 万。')
  assert.deepEqual([...summary.summary_of].sort(), ['sl_a', 'sl_b'])
})

test('a summary can be undone from the archive', async () => {
  const dir = openDir()
  const { rt, store } = runtimeFor({ dir })
  await store.append([
    slice('sl_a', '差旅预算改到 8 万。', { embedding: vec(1, 0) }),
    slice('sl_b', '差旅预算改到 8 万。', { embedding: vec(1, 0) }),
  ])
  await rt.memorySummary.run('b1')
  const summary = store.read().find(row => Array.isArray(row.summary_of))
  assert.equal(store.read().length, 1)
  const answer = await store.restore(summary.id)
  assert.equal(answer.restored, 2)
  const rows = store.read()
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map(row => row.id).sort(), ['sl_a', 'sl_b'])
  assert.equal(rows.some(row => row.summary_of !== null && row.summary_of !== undefined), false)
})

test('one turn of merging counts, and the state says what happened', async () => {
  const dir = openDir()
  const { rt, store } = runtimeFor({ dir })
  await store.append([
    slice('sl_a', 'A 计划在三月上线。', { embedding: vec(1, 0) }),
    slice('sl_b', 'A 计划三月上线。', { embedding: vec(1, 0) }),
  ])
  await rt.memorySummary.run('b1')
  const state = rt.memorySummary.state()
  assert.equal(state.last_result.merged, 2)
  assert.equal(typeof state.last_run_at, 'string')
  assert.equal(state.enabled, false, 'no model is configured in this test')
})

test('the merge threshold is the cosine the contract names', () => {
  assert.equal(MERGE_THRESHOLD, 0.86)
})

test('resolveSummarySettings reads the file shape and names what is missing', () => {
  const options = resolveSummarySettings({ endpoint: 'openai', base_url: ' http://127.0.0.1:8080/v1/ ', model: 'qwen3:4b', timeout_ms: 4000 })
  assert.deepEqual(options, { endpoint: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen3:4b', timeoutMs: 4000, configured: true, problem: null })
  assert.equal(resolveSummarySettings({ endpoint: 'nope', base_url: '', model: 'm' }).problem, 'base_url is not set')
  assert.equal(resolveSummarySettings({ base_url: 'http://x', model: '' }).problem, 'model is not set')
  assert.equal(resolveSummarySettings({ base_url: 'http://x', model: 'm', timeout_ms: 10 }).timeoutMs, 15000, 'an out-of-range timeout falls back')
  assert.equal(resolveSummarySettings({}).configured, false)
})

test('the settings patch refuses one bad field at a time', () => {
  assert.deepEqual(normalizeSettingsPatch({ endpoint: 'openai', model: ' m ', timeout_ms: 5000 }), { ok: true, next: { endpoint: 'openai', model: 'm', timeout_ms: 5000 } })
  assert.equal(normalizeSettingsPatch({ endpoint: 'lmstudio' }).field, 'endpoint')
  assert.equal(normalizeSettingsPatch({ base_url: 'ftp://x' }).field, 'base_url')
  assert.equal(normalizeSettingsPatch({ model: 'x'.repeat(81) }).field, 'model')
  assert.equal(normalizeSettingsPatch({ timeout_ms: 999 }).field, 'timeout_ms')
})

test('a saved settings file wins over the plugin config, and save reaches the next run', async (t) => {
  const dir = openDir()
  const chat = await mockChat('文件模型写的摘要。')
  t.after(() => chat.server.close())
  // The page saved a working model once; the plugin config still points at a dead port.
  writeFileSync(join(dir, 'memory-summary.json'), JSON.stringify({ endpoint: 'ollama', base_url: chat.base, model: 'file-model' }))
  const loaded = runtimeFor({ dir, config: { memorySummary: { endpoint: 'ollama', base_url: 'http://127.0.0.1:9', model: 'config-model' } } })
  assert.equal(loaded.rt.memorySummary.state().configured, true, 'the file wins over the config')
  assert.equal(loaded.rt.memorySummary.state().model, 'file-model')
  assert.equal(loaded.rt.memorySummary.state().settings_path, join(dir, 'memory-summary.json'))
  await loaded.store.append([
    slice('sl_a', '蓝色方案的季度预算表先压差旅。', { embedding: vec(1, 0) }),
    slice('sl_b', '蓝色方案的季度预算表差旅压到 8 万。', { embedding: vec(0.99, 0.05) }),
  ])
  const merged = await loaded.rt.memorySummary.run('b1')
  assert.equal(merged.merged, 2)
  assert.equal(loaded.store.read().find(row => Array.isArray(row.summary_of)).text, '文件模型写的摘要。')

  // A save lands in the file and in the running module: the next run asks the new model.
  mkdirSync(dir, { recursive: true })
  const answer = loaded.rt.memorySummary.save({ base_url: chat.base, model: 'saved-model', timeout_ms: 30000 })
  assert.equal(answer.ok, true)
  assert.equal(answer.state.model, 'saved-model')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'memory-summary.json'), 'utf8')), { endpoint: 'ollama', base_url: chat.base, model: 'saved-model', timeout_ms: 30000 })
  assert.equal(loaded.rt.memorySummary.state().timeout_ms, 30000)
  assert.equal(loaded.store.read().length, 1, 'the two sources are still one summary')

  // The save reaches the very next run: two new lines go to the model, not to the fallback
  // that would simply join the originals.
  await loaded.store.append([
    slice('sl_c', '红色方案的年度预算先压广告。', { embedding: vec(1, 0) }),
    slice('sl_d', '红色方案年度预算广告压到 6 万。', { embedding: vec(0.99, 0.05) }),
  ])
  const second = await loaded.rt.memorySummary.run('b1')
  assert.equal(second.merged, 2)
  assert.equal(chat.server.calls, 2, 'the saved model answered the next run')
  assert.match(chat.server.lastPrompt, /红色方案/, 'the prompt held the lines just added')
  assert.equal(loaded.store.read().find(row => Array.isArray(row.summary_of) && row.summary_of.includes('sl_c')).text, '文件模型写的摘要。')

  const refused = loaded.rt.memorySummary.save({ timeout_ms: 5 })
  assert.equal(refused.ok, false)
  assert.equal(refused.field, 'timeout_ms')
})
