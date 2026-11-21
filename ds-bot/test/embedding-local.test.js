// The local model (M2 G4 A route): vectors come out of a quantized ONNX model running in
// this process. A real run loads 113 MB, so the unit tests exercise the parts that decide
// what the rest of the plugin sees: the directory handling and the flat answer split.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  LOCAL_DTYPE,
  LOCAL_MAX_TOKENS,
  LOCAL_MODEL,
  embedWith,
  loadExtractor,
  localModelName,
  transformersEntry,
} from '../src/host/embedding-local.js'

// transformers.js answers one flat Float32Array plus the shape; the module owes one array
// per text, in the order it was asked.
const fakeExtractor = (dims, data) => async (input, options) => {
  fakeExtractor.seen = { input, options }
  const count = Array.isArray(input) ? input.length : 1
  return { dims: [count, dims], data }
}

test('the runtime entry is the node build, from the directory when one is given', () => {
  assert.equal(transformersEntry(''), '@huggingface/transformers', 'a shipped build uses its own dependencies')
  assert.equal(transformersEntry(undefined), '@huggingface/transformers')
  assert.equal(transformersEntry('/runtime/node_modules'), join('/runtime/node_modules', '@huggingface', 'transformers', 'dist', 'transformers.node.mjs'))
  assert.equal(LOCAL_DTYPE, 'q8')
  assert.equal(LOCAL_MAX_TOKENS, 512)
  assert.match(LOCAL_MODEL, /paraphrase-multilingual-MiniLM-L12-v2$/)
})

test('a model name falls back to the one this build ships against', () => {
  assert.equal(localModelName({}), LOCAL_MODEL)
  assert.equal(localModelName({ model: '  Xenova/other  ' }), 'Xenova/other')
})

test('one flat answer becomes one vector per text, in the order asked', async () => {
  const extractor = fakeExtractor(3, [0.5, 1, 2, 1.5, 1, 2])
  const vectors = await embedWith(extractor, ['第一个', '第二个'])
  assert.deepEqual(vectors, [[0.5, 1, 2], [1.5, 1, 2]])
  assert.deepEqual(fakeExtractor.seen.input, ['第一个', '第二个'], 'a batch goes in as a batch')
  assert.equal(fakeExtractor.seen.options.pooling, 'mean')
  assert.equal(fakeExtractor.seen.options.normalize, true, 'the model in Alma normalizes, so this one must too')
})

test('a single text is not wrapped in an array the tokenizer did not ask for', async () => {
  const extractor = fakeExtractor(2, [1, 0])
  assert.deepEqual(await embedWith(extractor, ['只有一个']), [[1, 0]])
  assert.equal(fakeExtractor.seen.input, '只有一个')
})

test('nothing in, nothing out: the extractor is not touched for an empty round', async () => {
  let touched = false
  const vectors = await embedWith(async () => { touched = true; return { dims: [0, 2], data: [] } }, [])
  assert.deepEqual(vectors, [])
  assert.equal(touched, false, 'an empty round must not load or call the model')
})

test('an answer with the wrong shape is a failure, not a quietly shifted vector', async () => {
  await assert.rejects(embedWith(fakeExtractor(3, [1, 2]), ['甲', '乙']), /asked for 2 vectors, got/)
  await assert.rejects(embedWith(fakeExtractor(0, []), ['甲']), /answered no vector/)
})

test('a directory that is not there is named before any import is attempted', async () => {
  await assert.rejects(loadExtractor({ modelDir: '', model: 'x', runtimeDir: '' }), /model_dir is not set/)
  // Windows joins the model name with backslashes, so the assertion keeps to the words.
  await assert.rejects(loadExtractor({ modelDir: '/tmp/ds-bot-no-model-dir', model: 'Xenova/none', runtimeDir: '' }), /model_dir has no [\s\S]*onnx/)
  await assert.rejects(loadExtractor({ modelDir: '/tmp', model: 'x', runtimeDir: '/tmp/ds-bot-no-runtime' }), /runtime_dir has no @huggingface\/transformers/)
})
