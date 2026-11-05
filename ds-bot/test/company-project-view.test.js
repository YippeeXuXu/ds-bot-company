import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectViewOf, projectViewsOf } from '../src/host/company/project-view.js'

const employee = (id, name) => ({ id, name })
const stateOf = (projects, members = {}, acceptances = {}, employees = {}) => ({
  projects: Object.fromEntries(projects.map(project => [project.id, project])),
  members,
  acceptances,
  employees,
})

const project = (id, extra = {}) => ({ id, created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000, ...extra })
const waiting = (id, projectId, extra = {}) => ({ id, project_id: projectId, title: `task ${id}`, requester: '小蓝', card_kind: 'acceptance', ...extra })

test('a company without projects yields an empty view for any id', () => {
  const views = projectViewsOf({ state: stateOf([]), waiting: [] })
  assert.equal(views.size, 0)
  assert.deepEqual(projectViewOf(views, 'prj_missing'), { pending_count: 0, pending_decisions: [], pinned_decisions: [], activity: [] })
})

test('waiting rows are grouped per project and cards without a project are left out', () => {
  const views = projectViewsOf({
    state: stateOf([project('prj_a'), project('prj_b')]),
    // Longest wait first, as the to-do read sorts them.
    waiting: [
      waiting('ac_1', 'prj_a', { requester: '小蓝' }),
      waiting('ap_1', 'prj_a', { requester: '橙子', card_kind: 'approval' }),
      waiting('ac_2', 'prj_b'),
      // A card whose room named no project belongs to the private chat (contract §4.4 B-1).
      waiting('ap_priv', null),
    ],
  })
  const first = projectViewOf(views, 'prj_a')
  assert.equal(first.pending_count, 2)
  assert.deepEqual(first.pending_decisions.map(row => row.id), ['ac_1', 'ap_1'])
  assert.deepEqual(first.pending_decisions[0], { id: 'ac_1', title: 'task ac_1', who: '小蓝' })
  assert.equal(projectViewOf(views, 'prj_b').pending_count, 1)
})

test('the pinned card keeps the three longest waits and the list keeps a bounded window', () => {
  const rows = []
  for (let index = 0; index < 25; index += 1) rows.push(waiting(`ac_${index}`, 'prj_a'))
  const view = projectViewOf(projectViewsOf({ state: stateOf([project('prj_a')]), waiting: rows }), 'prj_a')
  assert.equal(view.pending_count, 25)
  assert.deepEqual(view.pinned_decisions.map(row => row.id), ['ac_0', 'ac_1', 'ac_2'])
  assert.equal(view.pending_decisions.length, 20)
})

test('activity lists creation, membership and acceptance facts newest first', () => {
  const state = stateOf(
    [project('prj_a', { created_at: 1_700_000_000_000, updated_at: 1_700_000_000_500 })],
    {
      pmm_1: { id: 'pmm_1', project_id: 'prj_a', employee_id: 'emp_a', joined_at: 1_700_000_001_000, left_at: null },
      pmm_2: { id: 'pmm_2', project_id: 'prj_b', employee_id: 'emp_b', joined_at: 1_700_000_002_000, left_at: null },
    },
    {
      acc_1: { id: 'acc_1', project_id: 'prj_a', requester_employee_id: 'emp_a', state: 'accepted', created_at: 1_700_000_003_000, decided_at: 1_700_000_004_000 },
      acc_2: { id: 'acc_2', project_id: 'prj_a', requester_employee_id: 'emp_a', state: 'pending', created_at: 1_700_000_005_000, decided_at: null },
      acc_3: { id: 'acc_3', project_id: 'prj_b', requester_employee_id: 'emp_b', state: 'pending', created_at: 1_700_000_006_000, decided_at: null },
    },
    { emp_a: employee('emp_a', '小蓝'), emp_b: employee('emp_b', '橙子') },
  )
  const rows = projectViewOf(projectViewsOf({ state, waiting: [] }), 'prj_a').activity
  assert.deepEqual(rows.map(row => row.kind), ['acceptance.submitted', 'acceptance.accepted', 'acceptance.submitted', 'member.joined', 'project.updated', 'project.created'])
  assert.equal(rows[0].at, new Date(1_700_000_005_000).toISOString())
  assert.equal(rows[0].name, '小蓝')
  // Another project's acceptance and membership stay out of this project's list.
  assert.equal(rows.every(row => row.name !== '橙子'), true)
})

test('activity has a fixed window and survives a state without employees', () => {
  const members = {}
  const acceptances = {}
  for (let index = 0; index < 9; index += 1) {
    acceptances[`acc_${index}`] = { id: `acc_${index}`, project_id: 'prj_a', requester_employee_id: 'emp_missing', state: 'pending', created_at: 1_700_000_000_000 + index * 1_000, decided_at: null }
  }
  const rows = projectViewOf(projectViewsOf({ state: stateOf([project('prj_a')], members, acceptances), waiting: [] }), 'prj_a').activity
  assert.equal(rows.length, 6)
  // The newest acceptance is first and an employee the state no longer knows is null
  // rather than the string "undefined".
  assert.equal(rows[0].at, new Date(1_700_000_008_000).toISOString())
  assert.equal(rows[0].name, null)
})
