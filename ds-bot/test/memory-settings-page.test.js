import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The page renders through the browser's React; bundle it with the same stand-in the
// other client tests use, then read the tree as plain objects.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { MemoryPage, MemoryPageView, formOf, patchOf, statusOf, summaryFormOf, summaryPatchOf, summaryStatusOf } from './src/client/memory-settings.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect() {},
  useRef: current => ({ current }),
}
const module = { exports: {} }
const sandbox = { module, exports: module.exports, require: name => (name === 'react' ? react : {}), window: {} }
runInNewContext(outputFiles[0].text, sandbox)
const { MemoryPage, MemoryPageView, formOf, patchOf, statusOf, summaryFormOf, summaryPatchOf, summaryStatusOf } = module.exports

// Function components are plain functions here, so rendering is just calling them.
const render = node => {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(render)
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { ...node, props: { ...node.props, children: render(node.props?.children) } }
}

const text = node => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map(text).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return text(node.props?.children)
}
const collect = (node, predicate, found = []) => {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) { node.forEach(child => collect(child, predicate, found)); return found }
  if (predicate(node)) found.push(node)
  collect(node.props?.children, predicate, found)
  return found
}
const buttons = tree => collect(tree, node => node.type === 'button')
const button = (tree, label) => buttons(tree).find(item => text(item).includes(label))
const byClass = (tree, name) => collect(tree, node => String(node.props?.className ?? '').split(' ').includes(name))
const click = node => node.props.onClick?.({ preventDefault() {}, stopPropagation() {} })
// Values built inside the sandbox carry another realm's prototypes; compare their data.
const plain = value => JSON.parse(JSON.stringify(value))

const Section = props => ({ type: 'section', props: { ...props } })
const Row = props => ({ type: 'row', props: { ...props } })

const off = {
  enabled: false, wanted: false, problem: null, endpoint: 'ollama', base_url: '', model: '',
  timeout_ms: 15000, batch: 16, pending: 0, embedded: 0, failed: 0, rounds: 0,
  last_error: null, last_ok_at: null, last_test: null, retry_at: null, saved: null,
  settings_path: '/tmp/home/memory-embedding.json',
}
const ready = { ...off, enabled: true, wanted: true, base_url: 'http://127.0.0.1:11434', model: 'bge-m3', embedded: 4, pending: 2 }
const missing = { ...off, wanted: true, problem: 'base_url is not set' }
const slice = { id: 'sl_1', bot_id: 'bot_1', text: 'User: 帮我看下这周的派单', created_at: '2026-11-19T10:00:00.000Z', has_embedding: true }
// The summary model (4.5.1): its own file, its own section, off until an address and a
// model are both given.
const summaryOff = { configured: false, problem: 'base_url is not set', endpoint: 'ollama', base_url: '', model: '', timeout_ms: 15000, saved: {}, settings_path: '/tmp/home/memory-summary.json' }
const summaryReady = { ...summaryOff, configured: true, problem: null, base_url: 'http://127.0.0.1:11434', model: 'qwen3:4b', timeout_ms: 20000 }
const saveButtons = tree => buttons(tree).filter(item => text(item).includes('Save'))

const view = (patch = {}) => render(MemoryPageView({
  state: off, summary: { count: 0, bots: [] }, rows: { rows: [], total: 0 }, form: formOf(off), bot: '',
  nameOf: id => String(id), notice: '', saved: false, saving: false, testing: false, test: null, clearing: false,
  summaryState: summaryReady, summaryForm: summaryFormOf(summaryReady), summarySaving: false, summarySaved: false, summaryNotice: '',
  Section, Row,
  onToggle() {}, onEdit() {}, onSave() {}, onTest() {}, onFilter() {}, onRemove() {},
  onAskClear() {}, onKeep() {}, onClear() {}, onSummaryEdit() {}, onSaveSummary() {},
  ...patch,
}))

test('formOf follows what was asked, not whether the service could start', () => {
  assert.deepEqual(plain(formOf(off)), { enabled: false, endpoint: 'ollama', base_url: '', model: '' })
  assert.deepEqual(plain(formOf(missing)), { enabled: true, endpoint: 'ollama', base_url: '', model: '' })
  assert.deepEqual(plain(formOf(ready)), { enabled: true, endpoint: 'ollama', base_url: 'http://127.0.0.1:11434', model: 'bge-m3' })
  assert.deepEqual(plain(formOf(null)), { enabled: false, endpoint: 'ollama', base_url: '', model: '' })
})

test('patchOf carries only the fields that changed, all in one save', () => {
  assert.equal(patchOf(off, formOf(off)), null)
  assert.equal(patchOf(null, formOf(null)), null)
  assert.deepEqual(plain(patchOf(off, { ...formOf(off), enabled: true, base_url: 'http://127.0.0.1:11434', model: 'bge-m3' })), {
    enabled: true, base_url: 'http://127.0.0.1:11434', model: 'bge-m3',
  })
  // A trailing slash is the same address, so it is not a change.
  assert.equal(patchOf(ready, { ...formOf(ready), base_url: 'http://127.0.0.1:11434/' }), null)
  assert.deepEqual(plain(patchOf(ready, { ...formOf(ready), model: 'qwen3-embedding' })), { model: 'qwen3-embedding' })
  assert.deepEqual(plain(patchOf(ready, { ...formOf(ready), endpoint: 'openai' })), { endpoint: 'openai' })
})

test('statusOf says off, on, or what the on switch is still missing', () => {
  assert.equal(statusOf(off).tone, 'off')
  assert.match(text(statusOf(off).title), /Local memory is off\./)
  const warn = statusOf(missing)
  assert.equal(warn.tone, 'warn')
  assert.match(text(warn.title), /Local memory is off: The service address is not set\./)
  assert.equal(statusOf({ ...missing, problem: 'model is not set' }).title, 'Local memory is off: The model name is not set.')
  const on = statusOf(ready)
  assert.equal(on.tone, 'on')
  assert.equal(on.title, 'Local memory is on.')
  assert.equal(on.hint, 'bge-m3 at http://127.0.0.1:11434')
  assert.match(on.counts, /2 waiting · 4 embedded · 0 failed/)
})

test('the off page says it is off and keeps the test button disabled', () => {
  const tree = view()
  assert.match(text(tree), /Local memory is off\./)
  assert.match(text(tree), /No slices yet\. They are written when a turn ends\./)
  assert.equal(button(tree, 'Test connection').props.disabled, true)
  // Nothing changed, so there is nothing to save.
  assert.equal(button(tree, 'Save').props.disabled, true)
  assert.match(text(tree), /Settings are kept in \/tmp\/home\/memory-embedding\.json/)
})

test('a switch turned on without an address says which value is missing', () => {
  const tree = view({ state: missing, form: formOf(missing), summary: { count: 0, bots: [] } })
  assert.match(text(tree), /Local memory is off: The service address is not set\./)
  assert.equal(byClass(tree, 'bt-mempage-state')[0].props['data-tone'], 'warn')
  // The switch reflects the request, so it stays on while the address is missing.
  assert.equal(byClass(tree, 'bt-switch')[0].props['aria-checked'], true)
})

test('dirty fields enable Save, and a click sends the whole patch', () => {
  let sent = null
  const dirty = { ...formOf(off), enabled: true, base_url: 'http://127.0.0.1:11434' }
  const tree = view({ form: dirty, onSave: () => { sent = patchOf(off, dirty) } })
  assert.equal(button(tree, 'Save').props.disabled, false)
  click(button(tree, 'Save'))
  assert.deepEqual(plain(sent), { enabled: true, base_url: 'http://127.0.0.1:11434' })
})

test('a test result is either reachable or a reason, never a stuck button', () => {
  const ok = view({ state: ready, form: formOf(ready), test: { ok: true, latency_ms: 12, dimensions: 1024 } })
  assert.match(text(ok), /Reachable · 12 ms · 1024 dimensions/)
  assert.equal(byClass(ok, 'bt-mempage-test')[0].props['data-ok'], '')
  const failed = view({ state: ready, form: formOf(ready), test: { ok: false, error: 'connect ECONNREFUSED 127.0.0.1:11434' } })
  assert.match(text(failed), /The test failed: connect ECONNREFUSED 127\.0\.0\.1:11434/)
  // The button is usable again once the answer arrives.
  assert.equal(button(failed, 'Test connection').props.disabled, false)
})

test('kept slices show what was said, and clearing asks once first', () => {
  const rows = { rows: [slice], total: 1 }
  const tree = view({
    state: ready, form: formOf(ready), rows, summary: { count: 1, bots: [{ bot_id: 'bot_1', count: 1 }] },
    nameOf: id => (id === 'bot_1' ? '键盘' : id),
  })
  assert.match(text(tree), /User: 帮我看下这周的派单/)
  assert.match(text(tree), /键盘/)
  assert.match(text(tree), /Vector/)
  assert.equal(button(tree, 'Clear all slices').props.disabled, false)

  let cleared = 0
  const asking = view({ state: ready, form: formOf(ready), rows, summary: { count: 1, bots: [{ bot_id: 'bot_1', count: 1 }] }, clearing: true, onClear: () => { cleared += 1 } })
  assert.match(text(asking), /Delete every memory slice\? This cannot be undone\./)
  click(button(asking, 'Delete'))
  assert.equal(cleared, 1)
  // Keeping the slices leaves them alone.
  let kept = 0
  const keptTree = view({ state: ready, form: formOf(ready), rows, clearing: true, onKeep: () => { kept += 1 } })
  click(button(keptTree, 'Keep'))
  assert.equal(kept, 1)
  assert.equal(cleared, 1)
})

test('a failed save shows the host message in the page, not a silent no-op', () => {
  const tree = view({ notice: 'the address must start with http:// or https://' })
  assert.equal(byClass(tree, 'bt-mempage-notice')[0].props.role, 'alert')
  assert.match(text(tree), /the address must start with http:\/\/ or https:\/\//)
})

test('a saved page confirms it took effect', () => {
  const tree = view({ state: ready, form: formOf(ready), saved: true })
  assert.match(text(tree), /Saved\./)
  assert.match(text(tree), /Local memory is on\./)
})

test('MemoryPage is the stateful wrapper the settings dialog mounts', () => {
  assert.equal(typeof MemoryPage, 'function')
})
test('summaryFormOf reads the summary file shape, timeout included', () => {
  assert.deepEqual(plain(summaryFormOf(summaryReady)), { endpoint: 'ollama', base_url: 'http://127.0.0.1:11434', model: 'qwen3:4b', timeout_ms: '20000' })
  assert.deepEqual(plain(summaryFormOf(null)), { endpoint: 'ollama', base_url: '', model: '', timeout_ms: '15000' })
})

test('summaryPatchOf carries one changed field, and a trailing slash is no change', () => {
  assert.equal(summaryPatchOf(summaryReady, summaryFormOf(summaryReady)), null)
  assert.equal(summaryPatchOf(null, summaryFormOf(null)), null)
  assert.equal(summaryPatchOf(summaryReady, { ...summaryFormOf(summaryReady), base_url: 'http://127.0.0.1:11434/' }), null)
  assert.deepEqual(plain(summaryPatchOf(summaryReady, { ...summaryFormOf(summaryReady), model: 'qwen3:8b' })), { model: 'qwen3:8b' })
  assert.deepEqual(plain(summaryPatchOf(summaryReady, { ...summaryFormOf(summaryReady), timeout_ms: '30000' })), { timeout_ms: 30000 })
  assert.deepEqual(plain(summaryPatchOf(summaryReady, { ...summaryFormOf(summaryReady), endpoint: 'openai', base_url: '' })), { endpoint: 'openai', base_url: '' })
})

test('summaryStatusOf says what the summary model is missing, or which one writes', () => {
  const warn = summaryStatusOf(summaryOff)
  assert.equal(warn.tone, 'warn')
  assert.match(text(warn.title), /Summary model is off: The service address is not set\./)
  assert.equal(summaryStatusOf({ ...summaryOff, problem: 'model is not set' }).title, 'Summary model is off: The model name is not set.')
  const on = summaryStatusOf(summaryReady)
  assert.equal(on.tone, 'on')
  assert.equal(on.title, 'Summary model is on.')
  assert.equal(on.hint, 'qwen3:4b at http://127.0.0.1:11434')
  assert.equal(summaryStatusOf(null), null)
})

test('the summary section shows its fields, and a save sends only what changed', () => {
  let sent = null
  const dirty = { ...summaryFormOf(summaryReady), model: 'qwen3:8b' }
  const tree = view({ summaryForm: dirty, onSaveSummary: () => { sent = summaryPatchOf(summaryReady, dirty) } })
  assert.match(text(tree), /Summary model/)
  assert.match(text(tree), /Summary model is on\./)
  assert.match(text(tree), /qwen3:4b at http:\/\/127\.0\.0\.1:11434/)
  assert.match(text(tree), /Settings are kept in \/tmp\/home\/memory-summary\.json/)
  assert.equal(saveButtons(tree).length, 2, 'one save for the memory service, one for the summary model')
  const summarySave = saveButtons(tree)[1]
  assert.equal(summarySave.props.disabled, false)
  click(summarySave)
  assert.deepEqual(plain(sent), { model: 'qwen3:8b' })
  // With nothing changed the summary save is disabled too.
  assert.equal(saveButtons(view())[1].props.disabled, true)
})

test('the summary section is absent on a host that does not answer for it', () => {
  const tree = view({ summaryState: null })
  assert.equal(text(tree).includes('Summary model'), false)
  assert.equal(saveButtons(tree).length, 1)
})

test('a summary save that fails shows the host reason, and a taken one confirms', () => {
  const failed = view({ summaryState: summaryOff, summaryForm: summaryFormOf(summaryOff), summaryNotice: 'the timeout must be 1000–120000 ms' })
  assert.match(text(failed), /the timeout must be 1000–120000 ms/)
  const saved = view({ summaryState: summaryReady, summaryForm: summaryFormOf(summaryReady), summarySaved: true })
  assert.match(text(saved), /Saved\./)
})
