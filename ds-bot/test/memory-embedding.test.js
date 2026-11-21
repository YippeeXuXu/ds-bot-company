// The embedding client of G4 4.3: it must stay dark until someone configures a service,
// speak both shapes the two candidates use, and never lose a slice because a call failed.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_BATCH,
  DEFAULT_TIMEOUT_MS,
  EMBEDDING_ENDPOINTS,
  RETRY_MS,
  embedTexts,
  embeddingsUrl,
  install,
  normalizeSettingsPatch,
  resolveEmbeddingConfig,
} from '../src/host/memory-embedding.js'

const openHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-memory-embedding-'))

// A service that answers the way one of the two candidates does, and remembers what it was
// asked. `answer` gets the parsed body and the request count, so a test can fail on purpose.
async function mockService(answer) {
  const seen = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = body === '' ? null : JSON.parse(body)
      seen.push({ url: request.url, body: parsed })
      const reply = answer(parsed, seen.length)
      if (reply === undefined) {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('no')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(reply))
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, seen, close: () => new Promise(done => server.close(done)) }
}

// The smallest runtime `install` needs: a home to scan, the store's patch, a warning sink
// and an effect slot. Nothing else is touched by this module.
function runtimeFor({ home = openHome(), config = {} } = {}) {
  const warnings = []
  const patched = []
  const effects = []
  const rt = {
    home,
    config,
    warn: (...args) => warnings.push(args),
    ctx: { effect: (fn, name) => effects.push(name) },
    memorySlices: { patch: async updates => { patched.push(updates); return updates.length } },
  }
  install(rt)
  return { rt, patched, warnings, effects }
}

const settingsFor = base => ({ enabled: true, base_url: base, model: 'bge-m3' })
const sliceRows = () => [
  { id: 'sl_1', text: '我们把主色定成蓝色。' },
  { id: 'sl_2', text: '周五上线。' },
]

test('an unconfigured runtime never calls out, and knows it is off', async () => {
  const { rt } = runtimeFor()
  assert.deepEqual(rt.memoryEmbedding.state().enabled, false)
  assert.equal(rt.memoryEmbedding.state().wanted, false)
  assert.equal(rt.memoryEmbedding.state().problem, null)
  assert.equal(rt.memoryEmbedding.queue(sliceRows()), 0)
  assert.equal(rt.memoryEmbedding.pending(), 0)
  assert.deepEqual(await rt.memoryEmbedding.flush(), { embedded: 0, failed: 0, skipped: 'disabled' })
})

test('a switch with no address or no model stays off, and names the missing piece', async () => {
  const noBase = runtimeFor({ config: { memoryEmbedding: { enabled: true } } }).rt
  assert.equal(noBase.memoryEmbedding.state().enabled, false)
  assert.equal(noBase.memoryEmbedding.state().problem, 'base_url is not set')
  const noModel = runtimeFor({ config: { memoryEmbedding: { enabled: true, base_url: 'http://127.0.0.1:11434' } } }).rt
  assert.equal(noModel.memoryEmbedding.state().enabled, false)
  assert.equal(noModel.memoryEmbedding.state().problem, 'model is not set')
})

test('the ollama endpoint gets one prompt per call, and the vector lands on the slice', async () => {
  const service = await mockService(() => ({ embedding: [0.5, 0.25] }))
  try {
    const { rt, patched } = runtimeFor({ config: { memoryEmbedding: settingsFor(service.base) } })
    rt.memoryEmbedding.queue(sliceRows()[0])
    assert.equal(rt.memoryEmbedding.pending(), 1)
    const answer = await rt.memoryEmbedding.flush()
    assert.equal(answer.embedded, 1)
    assert.equal(answer.failed, 0)
    assert.equal(service.seen.length, 1)
    assert.equal(service.seen[0].url, '/api/embeddings')
    assert.deepEqual(service.seen[0].body, { model: 'bge-m3', prompt: '我们把主色定成蓝色。' })
    assert.deepEqual(patched, [[{ id: 'sl_1', embedding: [0.5, 0.25], embedding_model: 'bge-m3' }]])
    assert.equal(rt.memoryEmbedding.pending(), 0)
    assert.equal(rt.memoryEmbedding.state().embedded, 1)
  } finally {
    await service.close()
  }
})

test('the openai endpoint sends a batch and keeps vectors in the order it asked', async () => {
  const service = await mockService(() => ({
    data: [
      { index: 1, embedding: [0.4, 0.6] },
      { index: 0, embedding: [0.1, 0.2] },
    ],
  }))
  try {
    const { rt, patched } = runtimeFor({ config: { memoryEmbedding: { ...settingsFor(`${service.base}/v1`), endpoint: 'openai' } } })
    assert.equal(rt.memoryEmbedding.settings.endpoint, 'openai')
    rt.memoryEmbedding.queue(sliceRows())
    const answer = await rt.memoryEmbedding.flush()
    assert.equal(answer.embedded, 2)
    assert.equal(service.seen.length, 1)
    assert.equal(service.seen[0].url, '/v1/embeddings')
    assert.deepEqual(service.seen[0].body, { model: 'bge-m3', input: ['我们把主色定成蓝色。', '周五上线。'] })
    assert.deepEqual(patched[0], [
      { id: 'sl_1', embedding: [0.1, 0.2], embedding_model: 'bge-m3' },
      { id: 'sl_2', embedding: [0.4, 0.6], embedding_model: 'bge-m3' },
    ])
  } finally {
    await service.close()
  }
})

test('a failed round keeps the slice queued, says what happened, and waits before retrying', async () => {
  const service = await mockService(() => undefined)
  try {
    const { rt, patched, warnings } = runtimeFor({ config: { memoryEmbedding: settingsFor(service.base), warn: () => {} } })
    rt.memoryEmbedding.queue(sliceRows()[0])
    const answer = await rt.memoryEmbedding.flush()
    assert.equal(answer.failed, 1)
    assert.match(answer.error, /answered 500/)
    assert.equal(rt.memoryEmbedding.pending(), 1, 'a failure must not drop the slice')
    assert.equal(patched.length, 0)
    const state = rt.memoryEmbedding.state()
    assert.match(state.last_error, /answered 500/)
    assert.ok(state.retry_at > Date.now())
    assert.ok(warnings.length >= 1)
    const again = await rt.memoryEmbedding.flush()
    assert.equal(again.waiting, true)
    assert.equal(service.seen.length, 1, 'the retry must not hammer the service')
  } finally {
    await service.close()
  }
})

test('a service that is not listening answers the test with its address and the reason', async () => {
  // An address that was listening a moment ago, so the port is free and not a blocked one.
  const probe = createServer(() => {})
  await new Promise(done => probe.listen(0, '127.0.0.1', done))
  const port = probe.address().port
  await new Promise(done => probe.close(done))
  const { rt } = runtimeFor({ config: { memoryEmbedding: { enabled: true, base_url: `http://127.0.0.1:${port}`, model: 'bge-m3' } } })
  const answer = await rt.memoryEmbedding.test()
  assert.equal(answer.ok, false)
  assert.match(answer.error, new RegExp(`http://127\\.0\\.0\\.1:${port}/api/embeddings could not be reached`))
  assert.match(answer.error, /ECONNREFUSED/)
  assert.equal(answer.model, 'bge-m3')
  assert.ok(Number.isFinite(answer.latency_ms))
})

test('a service that answers with the wrong number of vectors is a failure, not a silent gap', async () => {
  const service = await mockService(() => ({ data: [{ index: 0, embedding: [0.1] }] }))
  try {
    const { rt, patched } = runtimeFor({ config: { memoryEmbedding: { ...settingsFor(service.base), endpoint: 'openai' } } })
    rt.memoryEmbedding.queue(sliceRows())
    const answer = await rt.memoryEmbedding.flush()
    assert.equal(answer.failed, 1)
    assert.match(answer.error, /asked for 2 vectors, got 1/)
    assert.equal(patched.length, 0)
    assert.equal(rt.memoryEmbedding.pending(), 2)
  } finally {
    await service.close()
  }
})

test('scan picks up slices that never got a vector, and leaves the embedded ones alone', async () => {
  const home = openHome()
  mkdirSync(join(home, 'memory-slices'), { recursive: true })
  writeFileSync(join(home, 'memory-slices', 'slices.jsonl'), [
    JSON.stringify({ id: 'sl_done', text: '已经向量化了。', embedding: [0.9], embedding_model: 'bge-m3' }),
    JSON.stringify({ id: 'sl_new', text: '这条还没有向量。', embedding: null, embedding_model: null }),
    'this line is broken',
    '',
  ].join('\n'))
  const service = await mockService(() => ({ embedding: [0.3] }))
  try {
    const { rt, patched } = runtimeFor({ home, config: { memoryEmbedding: settingsFor(service.base) } })
    assert.deepEqual(rt.memoryEmbedding.settings.endpoint, 'ollama')
    assert.deepEqual(EMBEDDING_ENDPOINTS, ['ollama', 'openai', 'local'])
    assert.equal(await rt.memoryEmbedding.flush().then(answer => answer.embedded), 1)
    assert.deepEqual(patched[0].map(update => update.id), ['sl_new'])
    assert.equal(rt.memoryEmbedding.pending(), 0)
  } finally {
    await service.close()
  }
})

test('the local endpoint is configured by a model and a directory, not an address', () => {
  const home = openHome()
  const settings = resolveEmbeddingConfig({ home, memoryEmbedding: { enabled: true, endpoint: 'local' } })
  assert.equal(settings.endpoint, 'local')
  assert.equal(settings.enabled, true)
  assert.equal(settings.model, 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'the shipped model is the default')
  assert.equal(settings.modelDir, join(home, 'models'), 'the default directory is under the plugin home')
  assert.equal(settings.baseUrl, '')
  assert.equal(embeddingsUrl(settings), '', 'a model in this process has no address to call')
  const named = resolveEmbeddingConfig({
    home,
    memoryEmbedding: { enabled: true, endpoint: 'local', model: 'Xenova/other', model_dir: '/models/x', runtime_dir: '/runtime' },
  })
  assert.equal(named.modelDir, '/models/x')
  assert.equal(named.runtimeDir, '/runtime')
  const noDir = resolveEmbeddingConfig({ memoryEmbedding: { enabled: true, endpoint: 'local' } })
  assert.equal(noDir.enabled, false)
  assert.equal(noDir.problem, 'model_dir is not set', 'without a home there is no directory to fall back to')
})

test('the settings patch carries the two local directories and refuses an absurd one', () => {
  assert.deepEqual(normalizeSettingsPatch({ endpoint: 'local', model_dir: '/models', runtime_dir: '' }), { ok: true, next: { endpoint: 'local', model_dir: '/models', runtime_dir: '' } })
  const long = normalizeSettingsPatch({ model_dir: 'x'.repeat(401) })
  assert.equal(long.ok, false)
  assert.equal(long.field, 'model_dir')
  const bad = normalizeSettingsPatch({ endpoint: 'nope' })
  assert.equal(bad.ok, false)
  assert.equal(bad.field, 'endpoint')
})

test('a local round without model files fails loudly and keeps the slice queued', async () => {
  const home = openHome()
  const missing = join(home, 'nowhere')
  const { rt, patched, warnings } = runtimeFor({ home, config: { memoryEmbedding: { enabled: true, endpoint: 'local', model_dir: missing } } })
  assert.equal(rt.memoryEmbedding.state().model_dir, missing)
  rt.memoryEmbedding.queue(sliceRows()[0])
  const answer = await rt.memoryEmbedding.flush()
  assert.equal(answer.failed, 1)
  assert.match(answer.error, /model_dir has no/)
  assert.equal(rt.memoryEmbedding.pending(), 1, 'a failure must not drop the slice')
  assert.equal(patched.length, 0)
  assert.ok(warnings.length >= 1)
  const test = await rt.memoryEmbedding.test()
  assert.equal(test.ok, false)
  assert.equal(test.url, null, 'a local test has no address to show')
  assert.match(test.error, /model_dir has no/)
})

test('the url keeps a base that already ends in the part the service names', () => {
  const ollama = resolveEmbeddingConfig({ memoryEmbedding: { enabled: true, base_url: 'http://127.0.0.1:11434/api/', model: 'bge-m3' } })
  assert.equal(embeddingsUrl(ollama), 'http://127.0.0.1:11434/api/embeddings')
  const openai = resolveEmbeddingConfig({ memoryEmbedding: { enabled: true, endpoint: 'openai', base_url: 'http://127.0.0.1:8000/v1', model: 'bge-m3' } })
  assert.equal(embeddingsUrl(openai), 'http://127.0.0.1:8000/v1/embeddings')
  const plain = resolveEmbeddingConfig({ memoryEmbedding: { enabled: true, base_url: 'http://127.0.0.1:11434', model: 'bge-m3' } })
  assert.equal(embeddingsUrl(plain), 'http://127.0.0.1:11434/api/embeddings')
  assert.equal(plain.timeoutMs, DEFAULT_TIMEOUT_MS)
  assert.equal(plain.batch, DEFAULT_BATCH)
  assert.equal(RETRY_MS, 60_000)
})

test('embedTexts answers nothing for nothing, without touching the service', async () => {
  const service = await mockService(() => ({ embedding: [1] }))
  try {
    const settings = resolveEmbeddingConfig({ memoryEmbedding: settingsFor(service.base) })
    assert.deepEqual(await embedTexts(settings, []), [])
    assert.equal(service.seen.length, 0)
  } finally {
    await service.close()
  }
})

// The page saves to <home>/memory-embedding.json; a host that starts later must pick those
// values up and queue what has no vector yet, without anyone reopening the page.
const sliceFile = (home, rows) => {
  mkdirSync(join(home, 'memory-slices'), { recursive: true })
  writeFileSync(join(home, 'memory-slices', 'slices.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}
const savedFile = (home, settings) => writeFileSync(join(home, 'memory-embedding.json'), `${JSON.stringify(settings, null, 2)}\n`)

test('a saved settings file is re-read on start and the slices without a vector are queued', () => {
  const home = openHome()
  savedFile(home, { enabled: true, base_url: 'http://127.0.0.1:9', model: 'bge-m3' })
  sliceFile(home, [
    { id: 'sl_1', text: '我们把主色定成蓝色。', embedding: null },
    { id: 'sl_2', text: '周五上线。', embedding: [0.1, 0.2], embedding_model: 'bge-m3' },
    { id: 'sl_3', text: '第二个待办。', embedding: undefined },
  ])
  const { rt } = runtimeFor({ home })
  const state = rt.memoryEmbedding.state()
  assert.equal(state.saved, true)
  assert.equal(state.enabled, true, 'the file turns the switch on, the plugin config stays empty')
  assert.equal(state.base_url, 'http://127.0.0.1:9')
  assert.equal(state.model, 'bge-m3')
  assert.equal(state.settings_path, join(home, 'memory-embedding.json'))
  assert.equal(rt.memoryEmbedding.pending(), 2, 'only the rows without a vector wait')
  rt.memoryEmbedding.save({ enabled: false })
})

test('save writes the file, re-resolves on the spot, and queues what is still unembedded', async () => {
  const service = await mockService(() => ({ embedding: [0.5, 0.25] }))
  const home = openHome()
  sliceFile(home, [{ id: 'sl_1', text: '我们把主色定成蓝色。', embedding: null }])
  try {
    const { rt } = runtimeFor({ home })
    assert.equal(rt.memoryEmbedding.state().enabled, false)
    const answer = rt.memoryEmbedding.save({ enabled: true, base_url: service.base, model: 'bge-m3' })
    assert.equal(answer.ok, true)
    assert.equal(answer.state.enabled, true, 'no restart: the same runtime is on')
    assert.equal(rt.memoryEmbedding.pending(), 1, 'the slice written before the switch is picked up')
    const written = JSON.parse(readFileSync(join(home, 'memory-embedding.json'), 'utf8'))
    assert.deepEqual(written, { enabled: true, base_url: service.base, model: 'bge-m3' })
    const flushed = await rt.memoryEmbedding.flush()
    assert.equal(flushed.embedded, 1)
  } finally {
    await service.close()
  }
})
