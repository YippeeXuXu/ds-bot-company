import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// The department surface is mostly one selector and one event filter; both are pure, so
// this test loads the module with a React stand-in and checks the data the header and
// drawer are drawn from, including the room lookup they must agree on.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>')

const { outputFiles } = await build({
  stdin: {
    contents: "export { departmentOfRoom, departmentActivityLines } from './src/client/department-chat.js'\nexport { installLocale } from './src/client/i18n.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: current => ({ current }),
  useMemo: make => make(),
  useCallback: fn => fn,
  createContext: initial => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useId: () => 'id',
}
const module = { exports: {} }
const sandbox = {
  module, exports: module.exports,
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : new Proxy({}, { get: () => () => null })),
  window: dom.window,
  document: dom.window.document,
  Date,
}
runInNewContext(outputFiles[0].text, sandbox)
const { departmentOfRoom, departmentActivityLines, installLocale } = module.exports
const dictionaries = new Map()
installLocale({
  register: (namespace, locale, dictionary) => {
    dictionaries.set(`${namespace}:${locale}`, dictionary)
    return () => dictionaries.delete(`${namespace}:${locale}`)
  },
  bind: namespace => (key, params) => {
    const text = dictionaries.get(`${namespace}:zh`)?.[key] ?? key
    return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text
  },
  getLocale: () => ({ active: 'zh' }),
})

const model = {
  departments: [
    { id: 'dp-rd', name: '研发部', description: '把产品做成能上线的软件。', chat_ref: 'room-rd', room_id: 'room-rd', lead_employee_id: 'emp-kb', status: 'active' },
    { id: 'dp-old', name: '旧部门', chat_ref: 'room-old', room_id: 'room-old', status: 'archived' },
  ],
  employees: [
    { id: 'emp-kb', name: '键盘', department_id: 'dp-rd', role: '后端工程师', status: 'active' },
    { id: 'emp-cz', name: '橙子', department_id: 'dp-rd', role: '代码开发', status: 'active' },
    { id: 'emp-lm', name: '蓝莓', department_id: 'dp-rd', role: '前端工程师', status: 'active' },
    { id: 'emp-gone', name: '已归档', department_id: 'dp-rd', status: 'archived' },
    { id: 'emp-other', name: '小蓝', department_id: 'dp-product', status: 'active' },
  ],
  projects: [
    { id: 'prj-web', name: '官网改版', status: 'active', source_department_ids: ['dp-rd'] },
    { id: 'prj-design', name: '设计语言 2.0', status: 'setup', source_department_ids: ['dp-design'] },
  ],
}

test('a room is a department when chat_ref or room_id names it', () => {
  const byRoom = departmentOfRoom(model, 'room-rd')
  assert.equal(byRoom.department.id, 'dp-rd')
  assert.deepEqual(byRoom.employees.map(item => item.id), ['emp-kb', 'emp-cz', 'emp-lm'])
  assert.deepEqual(byRoom.projects.map(item => item.id), ['prj-web'])
  assert.equal(byRoom.lead.id, 'emp-kb')

  assert.equal(departmentOfRoom({ ...model, departments: [{ ...model.departments[0], room_id: undefined }] }, 'room-rd').department.id, 'dp-rd')
  assert.equal(departmentOfRoom({ ...model, departments: [{ ...model.departments[0], chat_ref: undefined }] }, 'room-rd').department.id, 'dp-rd')
})

test('an archived department, an unknown room and a project room are not departments', () => {
  assert.equal(departmentOfRoom(model, 'room-old'), null)
  assert.equal(departmentOfRoom(model, 'room-missing'), null)
  assert.equal(departmentOfRoom(model, 'room-web'), null)
  assert.equal(departmentOfRoom(null, 'room-rd'), null)
})

test('a department without a lead still lists its people', () => {
  const found = departmentOfRoom({ ...model, departments: [{ ...model.departments[0], lead_employee_id: 'emp-missing' }] }, 'room-rd')
  assert.equal(found.lead, null)
  assert.equal(found.employees.length, 3)
})

test('department activity keeps only this department and its people, newest first', () => {
  const body = {
    events: [
      { cursor: 6, type: 'employee.created', aggregate_id: 'emp-lm', data: { bot_id: 'session-lm', department_id: 'dp-rd' }, at: '2026-11-18T06:00:00.000Z' },
      { cursor: 5, type: 'department.group.created', aggregate_id: 'dp-rd', data: { room_id: 'room-rd', members: ['emp-kb'] }, at: '2026-11-18T05:00:00.000Z' },
      { cursor: 4, type: 'department.updated', aggregate_id: 'dp-rd', data: {}, at: '2026-11-18T04:00:00.000Z' },
      { cursor: 3, type: 'employee.created', aggregate_id: 'emp-other', data: { department_id: 'dp-product' }, at: '2026-11-18T03:00:00.000Z' },
      { cursor: 2, type: 'project.created', aggregate_id: 'prj-web', data: {}, at: '2026-11-18T02:00:00.000Z' },
      { cursor: 1, type: 'employee.updated', aggregate_id: 'emp-cz', data: {}, at: '2026-11-18T01:00:00.000Z' },
    ],
  }
  const names = new Map([['emp-lm', '蓝莓'], ['emp-cz', '橙子']])
  const lines = departmentActivityLines(body, {
    departmentId: 'dp-rd',
    memberIds: new Set(['emp-kb', 'emp-cz', 'emp-lm']),
    names,
    now: Date.parse('2026-11-18T07:00:00.000Z'),
  })
  assert.equal(lines.length, 4)
  assert.match(lines[0], /蓝莓/)
  assert.match(lines[1], /部门群已创建/)
  assert.match(lines[2], /部门资料更新/)
  assert.match(lines[3], /橙子/)
  assert.equal(lines.some(line => line.includes('小蓝')), false)
})

test('department activity caps at five and tolerates an empty page', () => {
  const events = Array.from({ length: 8 }, (_, index) => ({ cursor: index + 1, type: 'department.updated', aggregate_id: 'dp-rd', at: '2026-11-18T06:00:00.000Z' }))
  assert.equal(departmentActivityLines({ events }, { departmentId: 'dp-rd' }).length, 5)
  assert.equal(departmentActivityLines(null, { departmentId: 'dp-rd' }).length, 0)
  assert.equal(departmentActivityLines({ events: [{ cursor: 1, type: 'project.created', aggregate_id: 'prj-web' }] }, { departmentId: 'dp-rd' }).length, 0)
})
