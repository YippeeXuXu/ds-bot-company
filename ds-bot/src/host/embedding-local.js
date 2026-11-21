// Local (in-process) ONNX embeddings (M2 G4, A route): the same shape Alma uses — a small
// quantized BERT runs inside this process, no port, no service, no network.
//
// Two directories make it work, and both live in the settings because they differ by stage:
//   model_dir    the folder that holds `<model>/onnx/model_quantized.onnx` and its tokenizer
//   runtime_dir  a node_modules directory with @huggingface/transformers + onnxruntime-node.
//                Empty means "the plugin's own dependencies", which is what a shipped build
//                uses; the first stage on this machine points it at the copy Alma already
//                installed, so nothing has to be installed twice to see real vectors.
//
// The model is 384-dimensional, mean-pooled and L2-normalized — the post-processing Alma
// does. The tokenizer truncates at the model's 512 tokens, which in practice never bites:
// one Chinese character is about 0.56 token, so 512 tokens is roughly 900 characters.
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const LOCAL_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'
// The quantized file is 113 MB against 226 MB for the fp32 one, and the difference in
// similarity on Chinese slices is not visible at our sizes.
export const LOCAL_DTYPE = 'q8'
export const LOCAL_MAX_TOKENS = 512

const trimmed = value => (typeof value === 'string' ? value.trim() : '')

export const localModelDir = settings => trimmed(settings.modelDir)
export const localModelName = settings => trimmed(settings.model) || LOCAL_MODEL

// The node build of transformers.js: it imports onnxruntime-node, not the web/wasm one, and
// it is the only file the runtime directory has to provide.
export function transformersEntry(runtimeDir) {
  const dir = trimmed(runtimeDir)
  if (dir === '') return '@huggingface/transformers'
  return join(dir, '@huggingface', 'transformers', 'dist', 'transformers.node.mjs')
}

let cached = null

// Loading the model takes about a second (it mmaps 113 MB); a run of twenty rounds pays it
// once because the extractor is kept here, keyed by the directories it came from.
export async function loadExtractor(settings) {
  const entry = transformersEntry(settings.runtimeDir)
  const modelDir = localModelDir(settings)
  const model = localModelName(settings)
  if (modelDir === '') throw new Error('model_dir is not set')
  const key = `${entry}\u0000${modelDir}\u0000${model}`
  if (cached !== null && cached.key === key) return cached.extractor
  if (isAbsolute(entry) && !existsSync(entry)) {
    throw new Error(`runtime_dir has no @huggingface/transformers underneath it: ${entry}`)
  }
  if (!existsSync(join(modelDir, model, 'onnx'))) {
    throw new Error(`model_dir has no ${model}/onnx: ${modelDir}`)
  }
  let module
  try {
    module = await import(entry)
  } catch (error) {
    throw new Error(`the local runtime could not be loaded from ${entry}: ${error?.message ?? String(error)}`)
  }
  const { env, pipeline } = module
  // A local model must never fall back to a download: a silent fetch would turn a wrong
  // path into a network wait, and the first stage is offline by design.
  env.allowRemoteModels = false
  env.localModelPath = modelDir
  env.cacheDir = join(modelDir, '.cache')
  const extractor = await pipeline('feature-extraction', model, { dtype: LOCAL_DTYPE })
  cached = { key, extractor }
  return extractor
}

// Mean pooling + L2 normalization over the last hidden state. Kept separate from the
// loading so a test can hand in a small stand-in extractor instead of 113 MB.
export async function embedWith(extractor, texts) {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const answer = await extractor(texts.length === 1 ? texts[0] : texts, { pooling: 'mean', normalize: true })
  const flat = Array.from(answer?.data ?? [])
  const dims = Number(answer?.dims?.[1] ?? 0)
  if (!(dims > 0)) throw new Error('the local model answered no vector')
  if (flat.length !== dims * texts.length) {
    throw new Error(`asked for ${texts.length} vectors, got ${flat.length / dims}`)
  }
  const out = []
  for (let index = 0; index < texts.length; index += 1) out.push(flat.slice(index * dims, (index + 1) * dims))
  return out
}

export async function embedLocalTexts(settings, texts) {
  if (!Array.isArray(texts) || texts.length === 0) return []
  const extractor = await loadExtractor(settings)
  return embedWith(extractor, texts)
}

export function resetLocalCache() {
  cached = null
}
