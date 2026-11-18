// Run objects (M1b-4.3): one dispatch of a task card into the Bot that owns it.
//
// `task.dispatch` puts the brief into the Bot's own chat and, in the same commit, writes
// the Run and moves the card to Doing. What comes back stays in the Bot's chat: the card
// records what was asked, and a person fills the delivery with `task.submit`, so a Run
// never copies chat text into the company file.
//
// `run.fail` is the way back when a dispatch did not land: the card returns to Ready with
// its reason, and dispatching again makes a new Run. The old Run keeps its history.
//
// Not here: reading the Bot's reply (M2), dispatching into a group chat, judging failure by
// itself, retrying on its own.
import { newId } from './projects.js'
import { companyFail } from './store.js'
import { bump, employeeOf, memberOf, optionalText, projectOf, taskOf, taskView, text, unmetDependencies } from './tasks.js'

// `task.dispatch` and `run.fail` are answered with the task's own revision: the card is
// what changed under the caller, and both write it.
export const RUN_ROW_REVISION_COMMANDS = new Set(['task.dispatch', 'run.fail'])

const RUN_STATES = ['dispatched', 'failed']
const INSTRUCTION_MAX = 8000

const revisionOf = (payload) => {
  if (!Number.isInteger(payload.expected_revision)) {
    throw companyFail('company/invalid', 'expected_revision is required; it names the task revision you read.', { field: 'expected_revision' })
  }
  return payload.expected_revision
}

const runOf = (state, id) => {
  const key = typeof id === 'string' ? id.trim() : ''
  if (key === '') throw companyFail('company/invalid', 'run_id is required.', { field: 'run_id' })
  const run = state.runs?.[key]
  if (run === undefined) throw companyFail('run/not-found', `No run ${id}.`, { run_id: id })
  return run
}

// A Run is what the company asked a Bot to do, so the brief is the record. The card's
// four words do not appear here: the board maps them from `stage`.
export const runView = run => ({
  ...run,
  session_id: run.session_id ?? null,
  failure_reason: run.failure_reason ?? null,
  ended_at: run.ended_at ?? null,
})

const acceptorName = (state, task) => {
  if (task.acceptance_actor === 'user') return '老板本人'
  return state.employees[task.acceptance_actor]?.name ?? task.acceptance_actor ?? '未指定'
}

const instructionOf = (state, { project, task, employee, note, workspace = null }) => {
  const inputs = (task.input_refs ?? []).length === 0
    ? ['  无（按任务说明执行）']
    : (task.input_refs ?? []).map((ref, index) => `  ${index + 1}) ${ref}`)
  const checks = (task.acceptance_checks ?? []).map((check, index) => `  ${index + 1}) ${check}`)
  const lines = [
    '[任务派单]',
    `任务：${task.id} / r${task.task_revision}`,
    `项目：${project.name}（${project.id}）`,
    `标题：${task.title}`,
    `负责人：${employee.name}`,
    `本次交付和范围：${task.description ?? task.next_action ?? '按标题与通过条件交付'}`,
    '输入：',
    ...inputs,
    '通过条件：',
    ...checks,
    `验收人：${acceptorName(state, task)}`,
    `授权范围：${task.authorization_scope_ref ?? '未声明'}`,
    `工作文件夹：${workspace ?? project.workspace_ref ?? '未设置'}`,
    ...(note === null ? [] : ['补充：', note]),
    '',
    '完成后请在回复里给出：①交付摘要；②交付物路径或链接（逐条）；③通过条件逐条结果。',
    '不要改任务状态；提交验收由人在任务板上完成。',
  ]
  const body = lines.join('\n')
  if (body.length <= INSTRUCTION_MAX) return body
  return `${body.slice(0, INSTRUCTION_MAX - 30)}\n…（简报超长已截断，完整内容见任务详情）`
}

export function runHandlers({ rt } = {}) {
  return {
    'task.dispatch': async ({ state, payload, now }) => {
      const task = taskOf(state, payload.task_id)
      const project = projectOf(state, task.project_id)
      const expected = revisionOf(payload)
      if (expected !== task.task_revision) {
        throw companyFail('task/revision-conflict', `Task ${task.id} is at revision ${task.task_revision}, not ${expected}.`, { task_id: task.id, expected_revision: expected, revision: task.task_revision })
      }
      if (task.stage !== 'ready') {
        throw companyFail('task/state-conflict', `Only a Ready task is dispatched; ${task.id} is ${task.stage}.`, { task_id: task.id, stage: task.stage, expected: 'ready' })
      }
      const missing = (task.dependencies ?? []).find(id => state.tasks?.[id] === undefined)
      if (missing !== undefined) throw companyFail('task/dependency-missing', `No task ${missing} in this project.`, { task_id: task.id, dependency_id: missing })
      const blocking = unmetDependencies(state, task)
      if (blocking.length > 0) throw companyFail('task/dependency-unmet', 'A dependency is not done yet.', { task_id: task.id, blocking })
      const owner = memberOf(state, project.id, task.owner_assignment_id, 'owner_assignment_id')
      const employee = employeeOf(state, owner.employee_id, 'employee_id')
      const botId = employee.bot_id ?? null
      if (botId === null) {
        throw companyFail('company/unsupported', `${employee.name} has no Bot to dispatch to.`, { employee_id: employee.id, reason: 'no_bot' })
      }
      if (rt === undefined || typeof rt.deliver !== 'function' || rt.botOf(botId) === undefined) {
        throw companyFail('company/unsupported', 'This host cannot deliver a task brief to that Bot.', { employee_id: employee.id, bot_id: botId })
      }
      const note = optionalText(payload.note, 'note', 1000)
      const instruction = instructionOf(state, { project, task, employee, note })
      try {
        await rt.deliver({ toId: botId, role: 'task', text: instruction })
      } catch (error) {
        throw companyFail('run/deliver-failed', `The brief did not reach ${employee.name}: ${error?.message ?? error}`, { task_id: task.id, bot_id: botId })
      }
      const id = newId('run')
      const at = now()
      const run = {
        id,
        project_id: project.id,
        task_id: task.id,
        task_revision: task.task_revision,
        employee_id: employee.id,
        bot_id: botId,
        session_id: typeof rt.chatOf === 'function' ? rt.chatOf(botId) : null,
        state: 'dispatched',
        instruction,
        dispatched_at: at,
        ended_at: null,
        failure_reason: null,
        created_at: at,
      }
      if (state.runs === undefined || state.runs === null || typeof state.runs !== 'object') state.runs = {}
      state.runs[id] = run
      task.stage = 'doing'
      task.hold_reason = 'none'
      task.latest_run_id = id
      task.started_at = at
      bump(task, now)
      return {
        aggregate_id: id,
        body: { task: taskView(task), run: runView(run) },
        events: [
          { type: 'run.dispatched', data: { run_id: id, task_id: task.id, project_id: project.id, employee_id: employee.id } },
          { type: 'task.moved', data: { task_id: task.id, project_id: project.id, from: 'ready', to: 'doing', task_revision: task.task_revision } },
        ],
      }
    },

    'run.list': ({ state, payload }) => {
      const project = projectOf(state, payload.project_id, { writable: false })
      const stage = payload.state === undefined ? null : text(payload.state, 'state', 20)
      if (stage !== null && !RUN_STATES.includes(stage)) {
        throw companyFail('company/invalid', `state is one of ${RUN_STATES.join(', ')}.`, { field: 'state', allowed: RUN_STATES })
      }
      const limit = payload.limit === undefined ? 50 : payload.limit
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw companyFail('company/invalid', 'limit is a whole number from 1 to 200.', { field: 'limit' })
      }
      const taskFilter = payload.task_id === undefined ? null : text(payload.task_id, 'task_id', 120)
      const runs = Object.values(state.runs ?? {})
        .filter(run => run.project_id === project.id)
        .filter(run => taskFilter === null || run.task_id === taskFilter)
        .filter(run => stage === null || run.state === stage)
        .sort((left, right) => (right.dispatched_at - left.dispatched_at) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map(runView)
      return { aggregate_id: null, body: { runs }, mutates: false }
    },

    'run.fail': ({ state, payload, now }) => {
      const run = runOf(state, payload.run_id)
      const task = taskOf(state, payload.task_id ?? run.task_id)
      const project = projectOf(state, task.project_id)
      if (run.task_id !== task.id || run.project_id !== project.id) {
        throw companyFail('run/not-found', `Run ${run.id} does not belong to task ${task.id}.`, { run_id: run.id, task_id: task.id })
      }
      const expected = revisionOf(payload)
      if (expected !== task.task_revision) {
        throw companyFail('task/revision-conflict', `Task ${task.id} is at revision ${task.task_revision}, not ${expected}.`, { task_id: task.id, expected_revision: expected, revision: task.task_revision })
      }
      if (run.state !== 'dispatched') throw companyFail('run/state-conflict', `Run ${run.id} is ${run.state}, not dispatched.`, { run_id: run.id, state: run.state })
      if (task.latest_run_id !== run.id) throw companyFail('run/state-conflict', `Run ${run.id} is not the task's latest dispatch.`, { run_id: run.id, task_id: task.id, latest_run_id: task.latest_run_id })
      if (task.stage !== 'doing') {
        throw companyFail('task/state-conflict', `Only a Doing task is marked failed; ${task.id} is ${task.stage}.`, { task_id: task.id, stage: task.stage, expected: 'doing' })
      }
      const reason = text(payload.reason, 'reason', 500)
      run.state = 'failed'
      run.ended_at = now()
      run.failure_reason = reason
      task.stage = 'ready'
      task.hold_reason = 'none'
      bump(task, now)
      return {
        aggregate_id: run.id,
        body: { task: taskView(task), run: runView(run) },
        events: [
          { type: 'run.failed', data: { run_id: run.id, task_id: task.id, project_id: project.id } },
          { type: 'task.moved', data: { task_id: task.id, project_id: project.id, from: 'doing', to: 'ready', task_revision: task.task_revision } },
        ],
      }
    },
  }
}
