// Commands: one envelope for every company operation, and one queue, so that two
// commands never interleave while one of them is saving.
//
//   { operation_key, expected_revision?, ...fields }
//
// `operation_key` makes a retry safe: the same key with the same content returns the
// first result, the same key with other content is a conflict. `expected_revision`
// makes a stale screen safe: a rename decided on revision 7 cannot land on revision 9.
import { createHash } from 'node:crypto'
import { companyFail } from './store.js'

const KEY_MAX = 200
const LOG_KEPT = 500

const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export const digestOf = value => createHash('sha256').update(stable(value)).digest('hex')

const text = (value, field, max = KEY_MAX) => {
  if (typeof value !== 'string' || value.trim() === '') throw companyFail('company/invalid', `A company command needs ${field}.`, { field })
  if (value.length > max) throw companyFail('company/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return value
}

export function createCommands({ store, handlers = {}, now = Date.now, logKept = LOG_KEPT, rowRevisionCommands = new Set() }) {
  // Commands run one at a time: the state is read, changed and saved as a whole, so a
  // second command that started during the first would save over its result.
  let queue = Promise.resolve()
  const enqueue = task => {
    const run = queue.then(() => task())
    queue = run.then(() => {}, () => {})
    return run
  }

  // Keeps the replay record bounded: a long-running company would otherwise grow one
  // file line per operation forever. The guarantee covers this window only: an
  // operation_key trimmed out of it is a new operation again.
  const prune = log => {
    const keys = Object.keys(log)
    if (keys.length <= logKept) return
    const byAge = keys.sort((left, right) => (log[left].at ?? 0) - (log[right].at ?? 0))
    for (const key of byAge.slice(0, keys.length - logKept)) delete log[key]
  }

  const execute = async (command, payload = {}) => {
    const handler = handlers[command]
    if (typeof handler !== 'function') throw companyFail('company/unknown-command', `No company command named ${command}.`, { command })
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw companyFail('company/invalid', 'A company command takes an object payload.', { command })
    }
    const body = payload
    const key = text(body.operation_key, 'operation_key')
    store.assertWritable()
    const digest = digestOf({ command, payload: Object.fromEntries(Object.entries(body).filter(([name]) => name !== 'operation_key')) })

    // The replay and revision checks run inside the queue, not before it: two callers
    // arriving together would otherwise both read an unused key and the same current
    // revision, and both would then commit. Taking the queue first makes the second
    // caller see the first caller's result.
    return enqueue(async () => {
      store.assertWritable()
      const known = store.state.operation_log[key]
      if (known !== undefined) {
        if (known.digest !== digest) {
          throw companyFail('company/idempotency-conflict', `operation_key ${key} was already used for a different request.`, { operation_key: key })
        }
        return { ...known.result, replayed: true }
      }

      const expected = body.expected_revision
      // Usually `expected_revision` names the company revision. A few commands instead carry
      // the revision of the object they change — the to-do row of an acceptance carries that
      // acceptance's own revision (contract A12) — so their handler compares it and the
      // envelope must not compare it to the company's.
      if (!rowRevisionCommands.has(command) && expected !== undefined && (!Number.isInteger(expected) || expected !== store.state.revision)) {
        throw companyFail('company/revision-conflict', `The company is at revision ${store.state.revision}, not ${expected}.`, { expected_revision: expected, revision: store.state.revision })
      }

      // A draft, not the live state: a handler that throws midway leaves nothing behind.
      const draft = structuredClone(store.state)
      const outcome = (await handler({ state: draft, payload: body, now, store })) ?? {}
      const aggregateId = outcome.aggregate_id ?? null
      const envelope = {
        operation_key: key,
        command,
        aggregate_id: aggregateId,
        revision: store.state.revision,
        status: 'ok',
        evidence_ref: null,
        server_time: now(),
        activity_cursor: String(store.state.revision),
      }
      if (outcome.body !== undefined) envelope.body = outcome.body
      // A handler may keep a successful save and still report drift it could not fix (for
      // example a project group that needs reconciling). The warning travels on the success
      // envelope so the screen can show "saved, needs attention" rather than a bare failure.
      if (outcome.warning !== undefined) envelope.warning = outcome.warning
      // Reads (mutates: false) are not recorded in operation_log, so they carry no
      // replay guarantee: asking again with the same key simply reads again. Only a
      // write leaves a record, because only a write is unsafe to repeat.
      if (outcome.mutates === false) return envelope

      const revision = store.state.revision + 1
      const events = (outcome.events ?? []).map((event, index) => ({
        id: `evt_${revision}_${index}`,
        cursor: revision,
        at: now(),
        operation_key: key,
        command,
        aggregate_id: aggregateId,
        ...event,
      }))
      draft.revision = revision
      draft.operation_log[key] = { command, digest, at: now(), result: { ...envelope, revision, status: 'committed', activity_cursor: String(revision) } }
      prune(draft.operation_log)
      await store.commit(draft)
      await store.appendEvents(events)
      return { ...envelope, revision, status: 'committed', activity_cursor: String(revision) }
    })
  }

  // Some writes are not commands but still must not race one: the to-do answer notes what
  // the host already decided, and saving that note over a half-written command would lose
  // the command's write. `runExclusive` puts such a task behind the same queue.
  const runExclusive = task => enqueue(task)

  return { execute, runExclusive, commands: Object.keys(handlers) }
}
