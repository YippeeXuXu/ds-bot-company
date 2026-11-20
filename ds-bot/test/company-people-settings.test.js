import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { DICTIONARY } from '../src/client/i18n.js'

// The page renders through the browser's React; bundle it with the same minimal
// stand-in the other client tests use, so the components run as plain functions.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { outputFiles } = await build({
  stdin: {
    contents: "export { PeoplePage, MembersSection, InviteSection, PermissionGuide, GrantForm, PEOPLE_CSS, PEOPLE_PERMISSIONS, PERMISSION_LABEL, invitePayload, statusPayload, grantPayload, revokePayload, permissionOrder, grantScopeText, peopleErrorText } from './src/client/people-settings.js'\nexport { installLocale } from './src/client/i18n.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react'],
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
const {
  PeoplePage, MembersSection, InviteSection, PermissionGuide, GrantForm, PEOPLE_CSS, PEOPLE_PERMISSIONS,
  PERMISSION_LABEL, invitePayload, statusPayload, grantPayload, revokePayload, permissionOrder, grantScopeText, peopleErrorText,
  installLocale,
} = module.exports

// The interface copy through the bundled installLocale, as the app binds it: the
// assertions then read what a Chinese-language user reads.
const dictionaries = new Map()
installLocale({
  register: (namespace, locale, dictionary) => {
    dictionaries.set(`${namespace}:${locale}`, dictionary)
    return () => dictionaries.delete(`${namespace}:${locale}`)
  },
  bind: namespace => (key, params) => {
    const copy = dictionaries.get(`${namespace}:zh`)?.[key] ?? key
    return params ? copy.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : copy
  },
  getLocale: () => ({ active: 'zh' }),
})

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
const byClass = (tree, name) => collect(tree, node => String(node.props?.className ?? '').split(' ').includes(name))
const buttons = tree => collect(tree, node => node.type === 'button')
const button = (tree, label) => buttons(tree).find(item => text(item) === label)
// Values built inside the vm carry that realm's prototypes, so compare plain copies.
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
const click = node => node.props.onClick?.({ preventDefault() {}, stopPropagation() {} })
const input = (tree, type) => collect(tree, node => node.type === 'input' && node.props.type === type)

// The stand-in above never updates state. A test that needs a component to
// start somewhere else queues the first values its useState calls return.
const withState = (values, run) => {
  const saved = react.useState
  const queue = [...values]
  react.useState = initial => [queue.length > 0 ? queue.shift() : (typeof initial === 'function' ? initial() : initial), () => {}]
  try { return run() } finally { react.useState = saved }
}

const owner = (patch = {}) => ({ id: 'act_owner', kind: 'owner', name: '老板', status: 'active', revision: null, grants: [], created_at: 1, updated_at: 1, ...patch })
const person = (patch = {}) => ({ id: 'act_1', kind: 'human', name: '小蓝', status: 'active', revision: 3, grants: [], created_at: 2, updated_at: 2, ...patch })
const grant = (patch = {}) => ({ id: 'gr_1', actor_id: 'act_1', scope_type: 'company', scope_id: null, permissions: ['dispatch', 'accept'], revision: 1, created_at: 2, updated_at: 2, ...patch })
const project = (patch = {}) => ({ id: 'prj_1', name: '官网改版', status: 'active', ...patch })

const members = (props = {}) => MembersSection({
  actors: [owner(), person()], projects: [project()], busy: '', confirm: null, openGrant: '',
  onArm() {}, onOpenGrant() {}, onGrant() {}, onRevoke() {}, onStatus() {},
  ...props,
})

test('the owner row lists every permission and offers no edit', () => {
  const tree = members({ actors: [owner()] })
  const [row] = byClass(tree, 'bt-ppl-person')
  assert.ok(text(row).includes('老板'))
  assert.ok(text(row).includes('所有者'))
  assert.ok(text(row).includes('本机所有者'))
  assert.equal(byClass(row, 'bt-ppl-chip').length, 5)
  assert.equal(buttons(row).length, 0)
  assert.ok(text(row).includes('不可编辑'))
})

test('a person row shows her grants with scope and permissions, and counts them', () => {
  const tree = members({ actors: [owner(), person({ grants: [grant()] })] })
  const rows = byClass(tree, 'bt-ppl-person')
  assert.equal(rows.length, 2)
  const row = rows[1]
  assert.ok(text(row).includes('小蓝'))
  assert.ok(text(row).includes('1 项授权在生效'))
  assert.ok(text(row).includes('整个公司'))
  assert.ok(text(row).includes('派任务'))
  assert.ok(text(row).includes('验收'))
  assert.equal(byClass(row, 'bt-ppl-chip').length, 2)
})

test('a person with no grant says what everyone can do', () => {
  const tree = members()
  assert.ok(text(tree).includes('每个人都能看数据，除此之外还没有授权。'))
})

test('revoking takes two clicks and names the scope in between', () => {
  const revoked = []
  const row = MembersSection({
    actors: [owner(), person({ grants: [grant()] })], projects: [], busy: '', confirm: null, openGrant: '',
    onArm() {}, onOpenGrant() {}, onGrant() {}, onRevoke: (actor, item) => revoked.push([actor.id, item.id]), onStatus() {},
  })
  const first = button(row, '撤销')
  assert.equal(first.props['aria-label'], '撤销整个公司的授权')
  click(first)
  assert.equal(revoked.length, 0)

  const armed = MembersSection({
    actors: [owner(), person({ grants: [grant()] })], projects: [], busy: '', confirm: { kind: 'grant', id: 'gr_1' }, openGrant: '',
    onArm() {}, onOpenGrant() {}, onGrant() {}, onRevoke: (actor, item) => revoked.push([actor.id, item.id]), onStatus() {},
  })
  const second = button(armed, '撤销？')
  assert.equal(second.props['data-confirm'], true)
  click(second)
  assert.deepEqual(plain(revoked), [['act_1', 'gr_1']])
})

test('suspending takes two clicks; restoring needs one', () => {
  const asked = []
  const statuses = []
  const base = {
    projects: [], busy: '', confirm: null, openGrant: '',
    onArm: cell => asked.push(cell), onOpenGrant() {}, onGrant() {}, onRevoke() {},
    onStatus: (actor, status) => statuses.push([actor.id, status]),
  }
  click(button(MembersSection({ ...base, actors: [owner(), person()] }), '停用'))
  assert.deepEqual(plain(asked), [{ kind: 'status', id: 'act_1' }])
  assert.equal(statuses.length, 0)

  const armed = MembersSection({ ...base, actors: [owner(), person()], confirm: { kind: 'status', id: 'act_1' } })
  click(button(armed, '确认停用'))
  assert.deepEqual(plain(statuses), [['act_1', 'disabled']])

  statuses.length = 0
  const disabled = MembersSection({ ...base, actors: [owner(), person({ status: 'disabled' })] })
  assert.ok(text(disabled).includes('已停用'))
  assert.equal(button(disabled, '授权'), undefined)
  click(button(disabled, '恢复'))
  assert.deepEqual(plain(statuses), [['act_1', 'active']])
})

test('the grant form guards the two things the server would refuse', async () => {
  const sent = []
  const form = GrantForm({ projects: [project()], busy: false, onSubmit: fields => { sent.push(fields); return null }, onCancel() {} })
  assert.equal(collect(form, node => node.type === 'input' && node.props.type === 'checkbox').length, 4)
  assert.equal(collect(form, node => node.type === 'select').length, 0)
  const [formNode] = collect(form, node => node.type === 'form')
  await formNode.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(sent, [])
  assert.equal(button(form, '授权').props.disabled, false)
})

test('the grant form offers a project once the scope is one project', () => {
  const form = withState(['project', 'prj_1', ['dispatch'], ''], () => GrantForm({
    projects: [project(), project({ id: 'prj_2', name: '归档项目' })], busy: false, onSubmit: () => null, onCancel() {},
  }))
  const [select] = collect(form, node => node.type === 'select')
  assert.ok(select !== undefined)
  assert.equal(select.props.value, 'prj_1')
  assert.deepEqual(plain(collect(select, node => node.type === 'option').map(option => option.props.value)), ['prj_1', 'prj_2'])
})

test('inviting needs a name before the button works', () => {
  const invited = []
  const empty = InviteSection({ name: '  ', busy: '', onChange() {}, onInvite: () => invited.push(true) })
  assert.equal(button(empty, '邀请').props.disabled, true)
  const [form] = collect(empty, node => node.type === 'form')
  form.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(invited, [])

  const named = InviteSection({ name: '小蓝', busy: '', onChange: () => {}, onInvite: () => invited.push(true) })
  const [namedForm] = collect(named, node => node.type === 'form')
  namedForm.props.onSubmit({ preventDefault() {} })
  assert.deepEqual(invited, [true])
})

test('the page lays out invite, members and the guide, and starts on a loading line', () => {
  const tree = PeoplePage()
  assert.equal(tree.length, 3)
  assert.equal(tree[0].type, InviteSection)
  assert.equal(tree[1].type, 'section')
  assert.equal(tree[2].type, PermissionGuide)
  assert.ok(text(tree).includes('加载中…'))
  assert.ok(text(tree).includes('成员'))
})

test('the permission guide names all five in PRD order', () => {
  const tree = PermissionGuide()
  assert.deepEqual(plain(PEOPLE_PERMISSIONS.map(([name]) => name)), ['view', 'dispatch', 'accept', 'configure', 'members'])
  const names = byClass(tree, 'bt-ppl-guide-name').map(node => text(node))
  assert.deepEqual(plain(names), ['看数据', '派任务', '验收', '改配置', '管成员'])
})

test('payloads carry only what each command names', () => {
  assert.deepEqual(plain(invitePayload('  小蓝 ')), { name: '小蓝' })
  assert.deepEqual(plain(statusPayload(person({ revision: 4 }), 'disabled')), { actor_id: 'act_1', expected_revision: 4, status: 'disabled' })
  assert.deepEqual(plain(grantPayload({ actorId: 'act_1', scopeType: 'company', permissions: ['dispatch'] })), {
    actor_id: 'act_1', scope_type: 'company', permissions: ['dispatch'],
  })
  assert.deepEqual(plain(grantPayload({ actorId: 'act_1', scopeType: 'project', projectId: 'prj_1', permissions: ['accept'] })), {
    actor_id: 'act_1', scope_type: 'project', permissions: ['accept'], scope_id: 'prj_1',
  })
  const fresh = person({ revision: 0 })
  assert.deepEqual(plain(revokePayload(grant({ revision: 0 }))), { grant_id: 'gr_1', expected_revision: 0 })
  assert.equal(statusPayload(fresh, 'active').expected_revision, 0)
})

test('permission order follows the PRD, whatever the server sent', () => {
  assert.deepEqual(plain(permissionOrder(['members', 'view', 'dispatch'])), ['view', 'dispatch', 'members'])
  assert.deepEqual(plain(permissionOrder([])), [])
  assert.deepEqual(plain(permissionOrder(undefined)), [])
})

test('a grant names its scope, and a deleted project is not left blank', () => {
  assert.equal(grantScopeText(grant(), []), '整个公司')
  assert.equal(grantScopeText(grant({ scope_type: 'project', scope_id: 'prj_1' }), [project()]), '项目：官网改版')
  assert.equal(grantScopeText(grant({ scope_type: 'project', scope_id: 'prj_gone' }), [project()]), '已归档或删除的项目')
})

test('failures read as the interface language, not as the server code', () => {
  const zh = code => peopleErrorText({ code, details: {}, message: 'English text' })
  assert.equal(zh('actor/name-taken'), '公司里已经有人叫这个名字，停用的也算。')
  assert.equal(zh('actor/inactive'), '这个人已停用，先恢复再授权。')
  assert.equal(zh('actor/immutable-field'), '所有者拥有全部权限，这一行不能改。')
  assert.equal(zh('grant/exists'), '这个人在该范围已有授权，先撤销再改。')
  assert.equal(zh('company/revision-conflict'), '这行已被别人改过，刷新页面再试。')
  assert.equal(zh('project/not-found'), '这个项目已经不存在了。')
  assert.equal(peopleErrorText({ code: 'company/forbidden', details: { missing: ['members', 'configure'] }, message: 'x' }), '这需要「管成员 · 改配置」权限，找所有者授予。')
  assert.equal(peopleErrorText({ code: 'company/forbidden', details: {}, message: 'x' }), '你没有这个权限。')
  assert.equal(peopleErrorText({ code: 'bot/refused', message: 'A refusal from the host' }), 'A refusal from the host')
  assert.equal(peopleErrorText(undefined), '这次修改没有保存成功。')
})

test('every string the page says has a Chinese copy', () => {
  const zh = DICTIONARY.zh
  const keys = [
    'Members & permissions', 'Invite a member', 'Name', 'Invite', 'Inviting…', 'Applies to', 'Whole company', 'One project',
    'Project', 'No active project', 'Permissions', 'Choose at least one permission.', 'Choose a project.', 'Cancel', 'Grant',
    'Granting…', 'Grant {name} more permissions', 'Close the grant form', 'Revoke', 'Revoke?', 'Revoke {scope}',
    'Click again to revoke {scope}.', 'No permission in this grant.', 'Suspended', 'Suspend', 'Confirm suspend', 'Restore',
    'Click again to suspend her. Her profile and history stay.', 'Back in the company, with the same grants.', 'No grants yet',
    '{n} in force', 'Everyone can view data. Nothing else is granted yet.', 'Owner', 'This device’s owner', 'Not editable',
    'Every permission, always. The owner row cannot be renamed, suspended or granted.', 'Members', 'Members · {n}',
    'Nobody else is here yet. Invite someone above.', 'The company record has no owner row. This is a data problem, not a permission one.',
    'What each permission allows', 'Everyone starts with view data; the other four are granted above. The owner holds all five.',
    'Try again', 'Loading…',
    '{name} is in the company now.', '{name} is suspended. Her profile and history stay.', '{name} is back, with the grants she had.',
    '{name} can do that now.', 'Revoked {name}’s grant for {scope}.',
    'You do not have permission to do this.', 'This needs the {permissions} permission. Ask the owner for it.',
    'Someone in the company already has this name, suspended people included.',
    'This person is suspended. Restore her before granting permissions.',
    'The owner holds every permission; this row cannot be changed.', 'That person is no longer here. The list has been refreshed.',
    'This person already has a grant in that scope. Revoke it first to change it.', 'That grant is gone. The list has been refreshed.',
    'Someone else changed this row. Load the page again and retry.', 'That project no longer exists.',
    'That change did not pass the check.', 'The change could not be saved.',
    ...Object.values(PERMISSION_LABEL),
    ...PEOPLE_PERMISSIONS.map(([, , hint]) => hint),
  ]
  const missing = keys.filter(key => typeof zh[key] !== 'string' || zh[key] === '')
  assert.deepEqual(plain(missing), [])
})

test('the page carries its own styles', () => {
  assert.match(PEOPLE_CSS, /\.bt-ppl-person\{/)
  assert.match(PEOPLE_CSS, /\.bt-ppl-grant\{/)
  assert.match(PEOPLE_CSS, /@media \(max-width:820px\)/)
})

test('settings lists the page and renders it', async () => {
  const source = await readFile(new URL('../src/client/settings.js', import.meta.url), 'utf8')
  assert.match(source, /^export const SETTINGS_PAGES = .*\['people', 'Members & permissions'\]/m)
  assert.match(source, /PAGE_ICONS = \{[^}]*people: PeopleIcon/)
  assert.match(source, /shown === 'people' \? h\(PeoplePage/)
  const index = await readFile(new URL('../src/client/index.js', import.meta.url), 'utf8')
  assert.match(index, /installCompiledStyles\(PEOPLE_CSS, 'people'\)/)
})
