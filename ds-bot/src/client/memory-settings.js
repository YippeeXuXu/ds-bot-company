// Settings → Memory (M2 G4 4.6, 4.5.1): the local embedding service behind the memory
// slices and the chat model that writes the merged summaries —
// where it listens, which model it runs, whether it is on, a test that always answers
// with a reason, and the slices themselves with a delete and a clear. A save reaches the
// running host at once: the host writes the settings file and re-reads it, so the page
// never asks for a restart.
import { createElement as h, useEffect, useState } from 'react'
import { CheckIcon, TrashIcon } from './icons.js'
import { Switch } from './bot-settings.js'
import { dateLocale, hostText, t } from './i18n.js'

const ENDPOINTS = [['ollama', 'Ollama'], ['openai', 'OpenAI-compatible'], ['local', 'This computer']]
const SLICES_SHOWN = 20
// The host names the value it lacks; the page says what that value is.
const PROBLEMS = {
  'base_url is not set': 'The service address is not set.',
  'model is not set': 'The model name is not set.',
  'model_dir is not set': 'The model directory is not set.',
}

// A failure in the interface language; the dialog's error line shows it.
const translated = promise => Promise.resolve(promise).catch((failure) => { throw new Error(hostText(failure?.message ?? String(failure))) })

// The fields as the form holds them. The switch follows what the user asked for
// (`wanted`), not whether the service can start: a switch turned on without an address
// stays on, so the page can say what is missing instead of silently flipping it back.
export const formOf = state => ({
  enabled: state?.wanted === true,
  endpoint: state?.endpoint ?? 'ollama',
  base_url: state?.base_url ?? '',
  model: state?.model ?? '',
  // Only the local endpoint uses these two: a service has an address, a model in this
  // process has a directory.
  model_dir: state?.model_dir ?? '',
  runtime_dir: state?.runtime_dir ?? '',
})

// The fields that differ from what the host has. One save carries every one of them, so
// turning the switch on and filling in the address travel together.
export const patchOf = (state, form) => {
  if (!state) return null
  const patch = {}
  if (form.enabled !== Boolean(state.wanted)) patch.enabled = form.enabled
  if (form.endpoint !== (state.endpoint ?? 'ollama')) patch.endpoint = form.endpoint
  if (bareUrl(form.base_url) !== bareUrl(state.base_url)) patch.base_url = form.base_url
  if (String(form.model ?? '').trim() !== (state.model ?? '')) patch.model = form.model
  if (String(form.model_dir ?? '').trim() !== (state.model_dir ?? '')) patch.model_dir = form.model_dir
  if (String(form.runtime_dir ?? '').trim() !== (state.runtime_dir ?? '')) patch.runtime_dir = form.runtime_dir
  return Object.keys(patch).length === 0 ? null : patch
}

const bareUrl = url => String(url ?? '').trim().replace(/\/+$/, '')

// The summary model (4.5.1) is a second, optional service: it only writes a summary when
// it is configured, and the page shows it in its own section. The timeout is a text field
// because the user may still be typing it; the host rejects what is not a number.
export const summaryFormOf = state => ({
  endpoint: state?.endpoint ?? 'ollama',
  base_url: state?.base_url ?? '',
  model: state?.model ?? '',
  timeout_ms: String(state?.timeout_ms ?? 15000),
})

export const summaryPatchOf = (state, form) => {
  if (!state) return null
  const patch = {}
  if (form.endpoint !== (state.endpoint ?? 'ollama')) patch.endpoint = form.endpoint
  if (bareUrl(form.base_url) !== bareUrl(state.base_url)) patch.base_url = form.base_url
  if (String(form.model ?? '').trim() !== (state.model ?? '')) patch.model = form.model
  const timeout = Number.parseInt(String(form.timeout_ms ?? '').trim(), 10)
  if (timeout !== (state.timeout_ms ?? 15000)) patch.timeout_ms = timeout
  return Object.keys(patch).length === 0 ? null : patch
}

// The line above the summary fields: what is missing, or which model writes the summaries.
export function summaryStatusOf(state) {
  if (!state) return null
  if (!state.configured) {
    return { tone: 'warn', title: t('Summary model is off: {problem}', { problem: t(PROBLEMS[state.problem] ?? state.problem ?? '') }), hint: t('Without it, merged summaries join the original lines instead of rewriting them.') }
  }
  return { tone: 'on', title: t('Summary model is on.'), hint: t('{model} at {url}', { model: state.model, url: state.base_url }) }
}

function stampOf(at) {
  if (!at) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// What the top of the page says: off, on, or wanted but missing a value. A count line
// rides along once the service has seen slices.
export function statusOf(state) {
  if (!state) return null
  const counts = t('{pending} waiting · {embedded} embedded · {failed} failed', { pending: state.pending, embedded: state.embedded, failed: state.failed })
  if (!state.wanted) {
    return { tone: 'off', title: t('Local memory is off.'), hint: t('Slices are still kept on this machine; turning it on gives them vectors.'), counts }
  }
  if (state.problem) {
    return { tone: 'warn', title: t('Local memory is off: {problem}', { problem: t(PROBLEMS[state.problem] ?? state.problem) }), hint: t('Fill it in below and save.'), counts }
  }
  const where = state.endpoint === 'local' ? state.model_dir : state.base_url
  return { tone: 'on', title: t('Local memory is on.'), hint: t('{model} at {url}', { model: state.model, url: where }), counts, error: state.last_error ?? '' }
}

function StatusBanner({ status }) {
  return h('div', { className: 'bt-mempage-state', 'data-tone': status.tone, role: 'status' },
    h('span', { className: 'bt-mempage-state-title' }, status.title),
    h('span', { className: 'bt-mempage-state-hint' }, status.hint),
    status.counts ? h('span', { className: 'bt-mempage-state-hint' }, status.counts) : null,
    status.error ? h('span', { className: 'bt-mempage-state-error' }, t('Last round failed: {error}', { error: status.error })) : null)
}

// One kept slice: what was said, which Bot and when, whether it carries a vector, and
// a two-step delete (the second click within a few seconds deletes it).
function SliceRow({ row, name, remove }) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  return h('div', { className: 'bt-mempage-slice' },
    h('div', { className: 'bt-mempage-slice-copy' },
      h('span', { className: 'bt-mempage-slice-text' }, row.text),
      h('span', { className: 'bt-mempage-slice-meta' },
        h('span', null, name),
        h('span', null, stampOf(row.created_at)),
        row.has_embedding ? h('span', { className: 'bt-tag' }, t('Vector')) : null)),
    h('button', {
      type: 'button', className: 'bt-mempage-slice-remove', 'data-confirm': confirming || undefined,
      'aria-label': t('Delete this slice'), title: t('Delete this slice'),
      onClick: () => { if (confirming) remove(row.id); else setConfirming(true) },
    }, confirming ? t('Delete') : h(TrashIcon)))
}

// The page as rendered; `MemoryPage` below owns the state and the calls to the host, so
// the tests can render this with plain props.
export function MemoryPageView(props) {
  const { state, summary, rows, form, bot, nameOf, notice, saved, saving, testing, test, clearing, Section, Row } = props
  const { summaryState, summaryForm, summarySaving, summarySaved, summaryNotice } = props
  const summaryStatus = summaryStatusOf(summaryState)
  const shown = rows?.rows ?? []
  const status = statusOf(state)
  return [
    h(Section, { key: 'service', title: t('Local memory'), className: 'bt-mempage' },
      status ? h(StatusBanner, { key: 'state', status }) : null,
      h(Row, {
        key: 'switch',
        label: t('Local memory'),
        hint: form.endpoint === 'local'
          ? t('Slices are turned into vectors by a model inside this app. Turning this off never deletes them.')
          : t('Slices are sent to a service you run on this computer. Turning this off never deletes them.'),
      }, h(Switch, { label: t('Local memory'), on: form.enabled, disabled: state === null || saving, onChange: props.onToggle })),
      h(Row, { key: 'endpoint', label: t('Service'), hint: t('The shape of the API the service answers.') },
        h('select', {
          className: 'bt-select', 'aria-label': t('Service'), value: form.endpoint, disabled: saving,
          onChange: event => props.onEdit({ endpoint: event.target.value }),
        }, ENDPOINTS.map(([id, label]) => h('option', { key: id, value: id }, label)))),
      form.endpoint === 'local' ? null : h(Row, { key: 'base', label: t('Service address'), hint: t('Where the service listens, such as http://127.0.0.1:11434') },
        h('input', {
          className: 'bt-input', type: 'text', value: form.base_url, disabled: saving, spellCheck: false,
          placeholder: form.endpoint === 'openai' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:11434',
          'aria-label': t('Service address'),
          onChange: event => props.onEdit({ base_url: event.target.value }),
        })),
      form.endpoint === 'local' ? h(Row, { key: 'model_dir', label: t('Model directory'), hint: t('The folder holding the model files, such as ~/models') },
        h('input', {
          className: 'bt-input', type: 'text', value: form.model_dir, disabled: saving, spellCheck: false,
          placeholder: '~/models', 'aria-label': t('Model directory'),
          onChange: event => props.onEdit({ model_dir: event.target.value }),
        })) : null,
      form.endpoint === 'local' ? h(Row, { key: 'runtime_dir', label: t('Runtime directory'), hint: t('Optional: the folder with the ONNX runtime. Empty uses the ones this app ships with.') },
        h('input', {
          className: 'bt-input', type: 'text', value: form.runtime_dir, disabled: saving, spellCheck: false,
          placeholder: '', 'aria-label': t('Runtime directory'),
          onChange: event => props.onEdit({ runtime_dir: event.target.value }),
        })) : null,
      h(Row, { key: 'model', label: t('Model name'), hint: form.endpoint === 'local'
        ? t('The model that runs inside this app, such as Xenova/paraphrase-multilingual-MiniLM-L12-v2')
        : t('The embedding model the service runs, such as bge-m3') },
        h('input', {
          className: 'bt-input', type: 'text', value: form.model, disabled: saving, spellCheck: false,
          placeholder: form.endpoint === 'local' ? 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' : 'bge-m3',
          'aria-label': t('Model name'),
          onChange: event => props.onEdit({ model: event.target.value }),
        })),
      h('div', { key: 'actions', className: 'bt-mempage-actions' },
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm',
          disabled: state === null || saving || patchOf(state, form) === null,
          onClick: () => props.onSave(),
        }, saving ? t('Saving…') : t('Save')),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm',
          disabled: state === null || saving || testing || !form.enabled,
          onClick: () => props.onTest(),
        }, testing ? t('Testing…') : t('Test connection')),
        saved ? h('span', { key: 'saved', className: 'bt-mempage-saved' }, h(CheckIcon), t('Saved.')) : null,
        notice ? h('span', { key: 'notice', className: 'bt-mempage-notice', role: 'alert' }, notice) : null,
        test ? h('span', {
          key: 'test', className: 'bt-mempage-test', 'data-ok': test.ok ? '' : undefined, role: 'status',
        }, test.ok
          ? [h(CheckIcon, { key: 'ok' }), t('Reachable · {ms} ms · {dims} dimensions', { ms: test.latency_ms, dims: test.dimensions })]
          : t('The test failed: {error}', { error: hostText(test.error ?? '') })) : null),
      state?.settings_path ? h('div', { key: 'path', className: 'bt-mempage-path' }, t('Settings are kept in {path}', { path: state.settings_path })) : null),

    summaryState
      ? h(Section, { key: 'summary', title: t('Summary model'), className: 'bt-mempage' },
        summaryStatus ? h('div', { key: 'state', className: 'bt-mempage-state', 'data-tone': summaryStatus.tone, role: 'status' },
          h('span', { className: 'bt-mempage-state-title' }, summaryStatus.title),
          h('span', { className: 'bt-mempage-state-hint' }, summaryStatus.hint)) : null,
        h(Row, { key: 'endpoint', label: t('Service'), hint: t('The shape of the chat API the service answers.') },
          h('select', {
            className: 'bt-select', 'aria-label': t('Summary service'), value: summaryForm.endpoint, disabled: summarySaving,
            onChange: event => props.onSummaryEdit({ endpoint: event.target.value }),
          }, ENDPOINTS.map(([id, label]) => h('option', { key: id, value: id }, label)))),
        h(Row, { key: 'base', label: t('Service address'), hint: t('Where the chat model listens, such as http://127.0.0.1:11434') },
          h('input', {
            className: 'bt-input', type: 'text', value: summaryForm.base_url, disabled: summarySaving, spellCheck: false,
            placeholder: summaryForm.endpoint === 'openai' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:11434',
            'aria-label': t('Summary service address'),
            onChange: event => props.onSummaryEdit({ base_url: event.target.value }),
          })),
        h(Row, { key: 'model', label: t('Model name'), hint: t('The chat model that writes summaries, such as qwen3:4b') },
          h('input', {
            className: 'bt-input', type: 'text', value: summaryForm.model, disabled: summarySaving, spellCheck: false,
            placeholder: 'qwen3:4b', 'aria-label': t('Summary model name'),
            onChange: event => props.onSummaryEdit({ model: event.target.value }),
          })),
        h(Row, { key: 'timeout', label: t('Timeout (ms)'), hint: t('How long one summary may take. Between 1000 and 120000.') },
          h('input', {
            className: 'bt-input', type: 'number', min: 1000, max: 120000, step: 1000,
            value: summaryForm.timeout_ms, disabled: summarySaving,
            'aria-label': t('Summary timeout'),
            onChange: event => props.onSummaryEdit({ timeout_ms: event.target.value }),
          })),
        h('div', { key: 'actions', className: 'bt-mempage-actions' },
          h('button', {
            type: 'button', className: 'bt-soft bt-soft-sm',
            disabled: summaryState === null || summarySaving || summaryPatchOf(summaryState, summaryForm) === null,
            onClick: () => props.onSaveSummary(),
          }, summarySaving ? t('Saving…') : t('Save')),
          summarySaved ? h('span', { key: 'saved', className: 'bt-mempage-saved' }, h(CheckIcon), t('Saved.')) : null,
          summaryNotice ? h('span', { key: 'notice', className: 'bt-mempage-notice', role: 'alert' }, summaryNotice) : null),
        h(Row, { key: 'threshold', label: t('Merge threshold'), hint: t('Calibrated on real vectors of {model}; two slices closer than this become one summary.', { model: summaryState.last_result?.model ?? summaryState.model ?? t('the embedding model') }) },
          h('span', { className: 'bt-mempage-threshold', 'data-model': summaryState.last_result?.model ?? '' }, String(summaryState.merge_threshold ?? 0.86))),
        summaryState.settings_path ? h('div', { key: 'path', className: 'bt-mempage-path' }, t('Settings are kept in {path}', { path: summaryState.settings_path })) : null)
      : null,

    h(Section, { key: 'slices', title: t('Memory slices · {count}', { count: summary.count ?? 0 }), className: 'bt-mempage' },
      h(Row, {
        key: 'filter',
        label: t('Slices kept'),
        hint: t('The newest {shown} are shown. Slices are written when a turn ends and never leave this computer.', { shown: SLICES_SHOWN }),
      }, h('select', {
        className: 'bt-select', 'aria-label': t('Slices kept'), value: bot,
        onChange: event => props.onFilter(event.target.value),
      }, [
        h('option', { key: '', value: '' }, t('All Bots')),
        ...(summary.bots ?? []).map(entry => h('option', { key: entry.bot_id, value: entry.bot_id }, t('{name} · {count}', { name: nameOf(entry.bot_id), count: entry.count }))),
      ])),
      shown.length === 0
        ? h('div', { key: 'none', className: 'bt-empty' }, t('No slices yet. They are written when a turn ends.'))
        : shown.map(row => h(SliceRow, { key: row.id, row, name: nameOf(row.bot_id), remove: props.onRemove })),
      h('div', { key: 'clear', className: 'bt-mempage-actions' },
        clearing
          ? [
            h('span', { key: 'ask', className: 'bt-set-hint' }, bot === '' ? t('Delete every memory slice? This cannot be undone.') : t('Delete every slice of {name}? This cannot be undone.', { name: nameOf(bot) })),
            h('button', { key: 'keep', type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => props.onKeep() }, t('Keep')),
            h('button', { key: 'yes', type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger', onClick: () => props.onClear() }, t('Delete')),
          ]
          : h('button', {
            type: 'button', className: 'bt-soft bt-soft-sm bt-secret-danger',
            disabled: (summary.count ?? 0) === 0,
            onClick: () => props.onAskClear(),
          }, h(TrashIcon), bot === '' ? t('Clear all slices') : t('Clear the slices of {name}', { name: nameOf(bot) }))),
    ),
  ]
}

export function MemoryPage({ roster, actions, run, Section, Row }) {
  const [view, setView] = useState(null)
  const [rows, setRows] = useState(null)
  const [form, setForm] = useState(() => formOf(null))
  const [bot, setBot] = useState('')
  const [notice, setNotice] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [summaryForm, setSummaryForm] = useState(() => summaryFormOf(null))
  const [summarySaving, setSummarySaving] = useState(false)
  const [summarySaved, setSummarySaved] = useState(false)
  const [summaryNotice, setSummaryNotice] = useState('')

  const state = view?.state ?? null
  const summaryState = view?.summary ?? null
  const summary = view?.slices ?? { count: 0, bots: [] }

  const sliceQuery = (botId = bot) => actions.memorySlices({ limit: SLICES_SHOWN, ...(botId === '' ? {} : { bot_id: botId }) })
  // The first load fills the form; a filter change only swaps the rows, so a value
  // typed but not yet saved stays in its field.
  const load = () => translated(Promise.all([actions.memorySettings(), sliceQuery('')])).then(([next, page]) => {
    setView(next)
    setForm(formOf(next?.state))
    setSummaryForm(summaryFormOf(next?.summary))
    setRows(page)
  })
  useEffect(() => { void run(load()) }, [])
  // After a delete or a clear: the count, the filter list, and the rows.
  const refresh = () => translated(Promise.all([actions.memorySettings(), sliceQuery()])).then(([next, page]) => {
    setView(current => (current === null ? next : { ...current, state: next?.state ?? current.state, slices: next?.slices ?? current.slices }))
    setRows(page)
  })

  useEffect(() => {
    if (!saved) return undefined
    const timer = setTimeout(() => setSaved(false), 2500)
    return () => clearTimeout(timer)
  }, [saved])

  useEffect(() => {
    if (!summarySaved) return undefined
    const timer = setTimeout(() => setSummarySaved(false), 2500)
    return () => clearTimeout(timer)
  }, [summarySaved])

  // A save answers with the state it left the host in, so the page shows the new service
  // without asking again.
  const save = (patch, then) => {
    if (patch === null) return Promise.resolve(true)
    setSaving(true)
    setNotice('')
    let took = false
    return run(translated(Promise.resolve(actions.memorySettingsSave(patch))).then((answer) => {
      if (answer?.ok !== true) {
        setNotice(answer?.message ? hostText(answer.message) : t('The settings could not be saved.'))
        return
      }
      took = true
      setSaved(true)
      setTest(null)
      setView(current => (current === null ? current : { ...current, state: answer.state }))
      setForm(formOf(answer.state))
    })).finally(() => setSaving(false)).then((passed) => {
      if (passed && then) void then()
      return passed && took
    })
  }

  const edit = (part) => {
    setForm(current => ({ ...current, ...part }))
    setSaved(false)
    setNotice('')
  }

  // The summary model has its own save: the embedding switch does not touch it, and a
  // refusal names the field the host rejected.
  const saveSummary = () => {
    const patch = summaryPatchOf(summaryState, summaryForm)
    if (patch === null) return Promise.resolve(true)
    setSummarySaving(true)
    setSummaryNotice('')
    setSummarySaved(false)
    return run(translated(Promise.resolve(actions.memorySummarySave(patch))).then((answer) => {
      if (answer?.ok !== true) {
        setSummaryNotice(answer?.message ? hostText(answer.message) : t('The summary model could not be saved.'))
        return
      }
      setSummarySaved(true)
      setView(current => (current === null ? current : { ...current, summary: answer.state }))
      setSummaryForm(summaryFormOf(answer.state))
    })).finally(() => setSummarySaving(false))
  }

  const testNow = () => {
    const measure = () => {
      setTesting(true)
      setTest(null)
      void run(translated(Promise.resolve(actions.memoryTest())).then((result) => { setTest(result ?? null) }))
        .finally(() => setTesting(false))
    }
    // Unsaved fields are saved first: the test then measures what the page shows.
    const patch = patchOf(state, form)
    if (patch === null) void measure()
    else void save(patch, measure)
  }

  const names = new Map((roster?.bots ?? []).map(entry => [entry.id, entry.name]))
  const nameOf = id => names.get(id) ?? String(id ?? '')

  return h(MemoryPageView, {
    state, summary, rows, form, bot, nameOf, notice, saved, saving, testing, test, clearing, Section, Row,
    summaryState, summaryForm, summarySaving, summarySaved, summaryNotice,
    onSummaryEdit: (part) => {
      setSummaryForm(current => ({ ...current, ...part }))
      setSummarySaved(false)
      setSummaryNotice('')
    },
    onSaveSummary: () => void saveSummary(),
    onToggle: on => void save(patchOf(state, { ...form, enabled: on })),
    onEdit: edit,
    onSave: () => void save(patchOf(state, form)),
    onTest: testNow,
    onFilter: (next) => {
      setBot(next)
      setClearing(false)
      void run(translated(sliceQuery(next)).then(page => setRows(page)))
    },
    onRemove: id => void run(translated(Promise.resolve(actions.memorySliceDelete(id)).then(refresh))),
    onAskClear: () => setClearing(true),
    onKeep: () => setClearing(false),
    onClear: () => {
      setClearing(false)
      void run(translated(Promise.resolve(actions.memorySlicesClear(bot === '' ? undefined : bot)).then(refresh)))
    },
  })
}
