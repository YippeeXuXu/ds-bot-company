// The channel the screens use must keep the API's status: a 404 for an unknown project
// is an error the client can see, not an empty page wrapped in ok:true (A14).
import assert from 'node:assert/strict'
import test from 'node:test'
import { install } from '../src/host/channel.js'

const runtime = ({ events }) => {
  const registered = []
  const rt = {
    ctx: {
      effect: (execute) => { execute(); return () => {} },
      connection: { fetch: { register: (spec) => { registered.push(spec); return () => {} } } },
    },
    state: { revision: 1, bots: {}, rooms: {}, privateArchives: [] },
    refresh: async () => {},
    readOnly: () => undefined,
    load: async () => {},
    companyApi: { events: (...args) => events(...args) },
  }
  install(rt)
  return registered.find(spec => spec.fetch !== undefined).fetch
}

const post = (fetch, endpoint, payload) => fetch(new Request('http://127.0.0.1/api/bot', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ endpoint, payload }),
}))

test('A14: an unknown project reaches the client as an error, not an empty list', async () => {
  const fetch = runtime({ events: async () => ({ status: 404, body: { code: 'project/not-found', message: 'no such project' } }) })
  const response = await post(fetch, 'company-events', { project_id: 'prj_missing' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body, { ok: false, error: { code: 'project/not-found', message: 'no such project' } })
})

test('A14: a known project still answers with the page itself', async () => {
  const page = { cursor: '12', events: [], has_more: false }
  const fetch = runtime({ events: async () => ({ status: 200, body: page }) })
  const response = await post(fetch, 'company-events', { project_id: 'prj_1', order: 'desc', limit: 5 })
  assert.deepEqual(await response.json(), { ok: true, value: page })
})
