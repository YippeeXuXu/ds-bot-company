import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createCompanyApi } from '../src/host/company/api.js'
import { createCommands } from '../src/host/company/commands.js'
import { orgHandlers } from '../src/host/company/org.js'
import { createCompanyStore } from '../src/host/company/store.js'

// The department group commands live between the company file and the roster: the file
// owns the binding, the roster owns the room. The fake roster below is the whole surface
// they are allowed to touch, so a test sees exactly what the commands asked of it.
const bots = {
  bot_a: { id: 'bot_a', name: 'Alpha' },
  bot_b: { id: 'bot_b', name: 'Beta' },
  bot_c: { id: 'bot_c', name: 'Gamma' },
}
const botOf = id => bots[id]
const tempHome = () => mkdtempSync(join(tmpdir(), 'ds-bot-company-department-group-'))

function fakeGroups({ failCreate = false } = {}) {
  const rooms = new Map()
  let seq = 0
  return {
    rooms,
    groups: {
      create: async ({ name, members, admin }) => {
        if (failCreate) throw new Error('the roster is busy')
        const id = `room_${++seq}`
        rooms.set(id, { id, name, members: [...members], admin })
        return { id }
      },
      roomOf: roomId => rooms.get(roomId),
      members: roomId => {
        const room = rooms.get(roomId)
        return room === undefined ? undefined : [...room.members]
      },
    },
  }
}

function open(home, { failCreate = false } = {}) {
  const { groups, rooms } = fakeGroups({ failCreate })
  const store = createCompanyStore({ dir: join(home, 'company'), useLock: false, warn: () => {} })
  const commands = createCommands({ store, handlers: orgHandlers({ botOf, isPrivate: () => false, groups }) })
  const api = createCompanyApi({ store, execute: commands.execute, groups, now: () => 1_700_000_000_000 })
  return { store, commands, api, rooms }
}

let counter = 0
const key = name => `k-${name}-${++counter}`
const run = (commands, command, payload = {}) => commands.execute(command, { operation_key: key(command), ...payload })

async function seed(commands) {
  await run(commands, 'company.init', { name: 'DS Bot Company' })
  const department = await run(commands, 'department.create', { name: '产品部' })
  const first = await run(commands, 'employee.create', { bot_id: 'bot_a', department_id: department.aggregate_id, name: '小蓝' })
  const second = await run(commands, 'employee.create', { bot_id: 'bot_b', department_id: department.aggregate_id, name: '橙子' })
  return { department: department.aggregate_id, first: first.aggregate_id, second: second.aggregate_id }
}

test('a department group is made from the department Bots and bound to it', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const { department } = await seed(commands)

  const created = await run(commands, 'department.group.create', { department_id: department })
  assert.equal(created.status, 'committed')
  assert.equal(created.body.existing, undefined)
  assert.match(created.body.room.id, /^room_/)
  // Real Bot ids, in join order: the roster filters to live Bots itself, so a profile
  // whose Bot is gone would have vanished from the group without a word.
  assert.deepEqual(rooms.get(created.body.room.id).members, ['bot_a', 'bot_b'])
  assert.equal(created.body.department.chat_ref, created.body.room.id)
  assert.equal(created.body.department.room_id, created.body.room.id)
  assert.equal(store.state.departments[department].chat_ref, created.body.room.id)
  rmSync(home, { recursive: true, force: true })
})

test('a second create answers the bound group instead of making another', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const { department } = await seed(commands)
  const first = await run(commands, 'department.group.create', { department_id: department })
  const second = await run(commands, 'department.group.create', { department_id: department })
  assert.equal(second.body.existing, true)
  assert.equal(second.body.room.id, first.body.room.id)
  assert.equal(rooms.size, 1)
  rmSync(home, { recursive: true, force: true })
})

test('an employee whose Bot is gone is named instead of left out', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const { department } = await seed(commands)
  // A profile whose Bot left the team: the roster would drop it from the group without a
  // word, so the command has to speak before the group is made.
  store.state.employees.emp_ghost = {
    id: 'emp_ghost',
    company_id: Object.keys(store.state.companies)[0],
    bot_id: 'bot_gone',
    department_id: department,
    name: '幽灵',
    acceptance_role: 'executor',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
    revision: 1,
  }
  await store.commit(store.state)
  await assert.rejects(
    run(commands, 'department.group.create', { department_id: department }),
    error => {
      assert.equal(error.code, 'department/group-missing-bots')
      assert.equal(error.details.missing.length, 1)
      assert.equal(error.details.missing[0].name, '幽灵')
      assert.equal(error.details.missing[0].bot_id, 'bot_gone')
      return true
    },
  )
  assert.equal(rooms.size, 0)
  rmSync(home, { recursive: true, force: true })
})

test('one real Bot is not enough for a group chat', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  await run(commands, 'company.init', { name: 'DS Bot Company' })
  const department = await run(commands, 'department.create', { name: '产品部' })
  await run(commands, 'employee.create', { bot_id: 'bot_a', department_id: department.aggregate_id, name: '小蓝' })
  await assert.rejects(
    run(commands, 'department.group.create', { department_id: department.aggregate_id }),
    error => error.code === 'department/group-too-small' && error.details.count === 1,
  )
  assert.equal(rooms.size, 0)
  rmSync(home, { recursive: true, force: true })
})

test('a roster refusal keeps the department unbound', async () => {
  const home = tempHome()
  const { store, commands } = open(home, { failCreate: true })
  const { department } = await seed(commands)
  await assert.rejects(
    run(commands, 'department.group.create', { department_id: department }),
    error => error.code === 'department/group-failed' && /roster is busy/.test(error.message),
  )
  assert.equal(store.state.departments[department].chat_ref, null)
  rmSync(home, { recursive: true, force: true })
})

test('binding an existing group reports members it does not match', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const { department } = await seed(commands)
  rooms.set('room_made_elsewhere', { id: 'room_made_elsewhere', name: '产品部', members: ['bot_a'] })

  const bound = await run(commands, 'department.group.bind', { department_id: department, room_id: 'room_made_elsewhere' })
  assert.equal(bound.status, 'committed')
  assert.equal(bound.body.department.room_id, 'room_made_elsewhere')
  assert.deepEqual(bound.body.expected, ['bot_a', 'bot_b'])
  assert.deepEqual(bound.body.actual, ['bot_a'])
  assert.equal(bound.body.drifted, true)
  assert.equal(store.state.departments[department].chat_ref, 'room_made_elsewhere')
  rmSync(home, { recursive: true, force: true })
})

test('binding refuses a missing room and a room another department owns', async () => {
  const home = tempHome()
  const { commands, rooms } = open(home)
  const { department } = await seed(commands)
  await assert.rejects(
    run(commands, 'department.group.bind', { department_id: department, room_id: 'room_nowhere' }),
    error => error.code === 'department/group-not-found',
  )

  const other = await run(commands, 'department.create', { name: '工程部' })
  rooms.set('room_engineering', { id: 'room_engineering', name: '工程部', members: ['bot_c'] })
  await run(commands, 'department.group.bind', { department_id: other.aggregate_id, room_id: 'room_engineering' })
  await assert.rejects(
    run(commands, 'department.group.bind', { department_id: department, room_id: 'room_engineering' }),
    error => error.code === 'department/group-bound' && error.details.department_id === other.aggregate_id,
  )
  rmSync(home, { recursive: true, force: true })
})

test('department.update takes room_id as the same binding and answers both names', async () => {
  const home = tempHome()
  const { store, commands, rooms } = open(home)
  const { department } = await seed(commands)
  rooms.set('room_dep_product', { id: 'room_dep_product', name: '产品部', members: ['bot_a', 'bot_b'] })
  const updated = await run(commands, 'department.update', { department_id: department, room_id: 'room_dep_product' })
  assert.equal(updated.body.department.chat_ref, 'room_dep_product')
  assert.equal(updated.body.department.room_id, 'room_dep_product')
  assert.equal(store.state.departments[department].chat_ref, 'room_dep_product')
  // Clearing works through either spelling, and the model keeps both in step.
  const cleared = await run(commands, 'department.update', { department_id: department, room_id: '' })
  assert.equal(cleared.body.department.chat_ref, null)
  assert.equal(cleared.body.department.room_id, null)
  rmSync(home, { recursive: true, force: true })
})
