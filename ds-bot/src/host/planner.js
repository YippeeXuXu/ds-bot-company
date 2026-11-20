// Planner (batch 2): before a Bot's own model runs a turn, a stronger model writes the
// plan for that turn. The plan reaches the turn as one system-prompt section, so it
// guides the work without entering the transcript: the chat stays what the Bot itself
// said, and a plan that changes every turn only moves the prompt tail.
//
// The plan is asked for once per turn, from inside the `system-prompt/assemble`
// waterfall: that hook runs after the turn's messages are claimed and before sections
// are rendered, which is the only point where a section can still wait on a model call.
import { BlockAssembler } from '@deepseek-ai/dsh-llm'

const PLAN_ORDER = 646
const PLAN_TTL_MS = 120_000
const PLAN_TIMEOUT_MS = 20_000
const PLAN_MAX_CHARS = 1_200
const PLAN_MAX_TOKENS = 900
const HISTORY_MESSAGES = 8
const HISTORY_MAX_CHARS = 700
const TRIGGER_MAX_CHARS = 2_000

const PLAN_SYSTEM = [
  'You plan one turn of another assistant before it works.',
  'Read the recent conversation and the message it must answer, then write a short plan for that turn:',
  'what it has to accomplish, which tools it needs and in what order, and what would make it stop or ask the user.',
  'Do not answer the user yourself and do not call tools.',
  'Write plain text, no preamble and no headings, at most 900 characters.',
].join(' ')

const textOf = (message) => {
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('\n')
    .trim()
}

const splitRef = (ref) => {
  const at = ref.indexOf('/')
  return at < 0 ? { provider: ref, model: '' } : { provider: ref.slice(0, at), model: ref.slice(at + 1) }
}

const combine = (signal, timeout) => {
  if (timeout === undefined) return signal
  if (signal === undefined) return timeout
  try { return AbortSignal.any([signal, timeout]) } catch { return signal }
}

const promptFor = (history, trigger) => [
  'Recent conversation:',
  history === '' ? '(none)' : history,
  '',
  'The message to answer now:',
  trigger,
  '',
  'Write the plan.',
].join('\n')

export function install(rt) {
  const { ctx } = rt
  // Plans keyed by Session, each for one turn; a new turn drops the old one.
  const plans = new Map()
  // The message a turn answers, captured when the turn claims it: by assembly time it
  // is claimed but not yet in the log, so the log alone cannot name it.
  const triggers = new Map()
  const running = new Map()
  const failed = new Map()
  const warned = new Set()

  const stateOf = () => rt.company?.store?.state
  const employeeOf = (botId) => {
    const state = stateOf()
    if (state === undefined) return undefined
    return Object.values(state.employees ?? {})
      .find(profile => profile?.status === 'active' && profile?.bot_id === botId)
  }

  // The stored planner setting, when it can name a route. `enabled: false` turns the
  // planner off without losing the model it was set to.
  const plannerOf = (botId) => {
    const planner = employeeOf(botId)?.planner
    if (planner === null || typeof planner !== 'object') return undefined
    if (planner.enabled === false) return undefined
    if (typeof planner.provider !== 'string' || planner.provider.trim() === '') return undefined
    if (typeof planner.model !== 'string' || planner.model.trim() === '') return undefined
    return planner
  }

  // A group Session speaks for its member Bot; a Bot's own chat speaks for itself.
  const botIdOf = (sessionId) => {
    const self = rt.selfOf?.(sessionId)
    if (self !== undefined) return self
    return rt.groupOwners?.get(sessionId)?.botId
  }

  const isSubagent = (agent) => {
    const header = agent?.session?.header
    if (header === undefined) return false
    if (header.origin === 'subagent') return true
    return Number.isInteger(header.delegationDepth) && header.delegationDepth > 0
  }

  // What the turn answers, oldest first for a batch claimed at one step.
  ctx.on('agent/inbox/claimed', (payload) => {
    const message = payload?.message
    const agent = payload?.agent
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    const text = textOf(message)
    if (text === '') return
    const turn = payload.turn
    const previous = triggers.get(sessionId)
    const kept = previous !== undefined && previous.turn === turn ? previous.text : ''
    triggers.set(sessionId, {
      turn,
      text: (kept === '' ? text : `${kept}\n\n${text}`).slice(0, TRIGGER_MAX_CHARS),
    })
  })

  // A new turn makes the previous plan stale; the claim that follows sets the trigger.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/start') return
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const open = plans.get(sessionId)
    if (open !== undefined && open.turn !== event.data?.turn) plans.delete(sessionId)
  })

  const conversationOf = async (sessionId, signal) => {
    const lines = []
    try {
      for await (const event of rt.eventsBackwards(sessionId, signal, 2)) {
        const entry = rt.historyEntry(event, false)
        if (entry === undefined) continue
        const text = String(entry.text ?? '').trim()
        if (text === '') continue
        const who = event.type === 'user/message' ? 'user' : 'assistant'
        lines.push(`${who}: ${text.slice(0, HISTORY_MAX_CHARS)}`)
        if (lines.length >= HISTORY_MESSAGES) break
      }
    } catch { /* no history is a valid plan input */ }
    return lines.reverse().join('\n\n')
  }

  const planTurn = async ({ sessionId, botId, planner, trigger, signal }) => {
    const bot = rt.botOf(botId)
    if (bot === undefined) return undefined
    const ref = await rt.resolveModel(`${planner.provider}/${planner.model}`)
    const executor = await rt.desiredModel(bot).catch(() => undefined)
    // The same model planning its own turn only pays twice for one opinion.
    if (executor === ref) return undefined
    const { provider, model } = splitRef(ref)
    const reasoningEffort = typeof planner.reasoning_effort === 'string' && planner.reasoning_effort !== ''
      ? await rt.resolveEffort(ref, planner.reasoning_effort).catch(() => undefined)
      : undefined
    const history = await conversationOf(sessionId, signal)
    const messages = rt.tagUsage(
      [{ role: 'user', content: [{ type: 'text', text: promptFor(history, trigger.text) }] }],
      { sessionId, kind: 'planner' },
    )
    const timeout = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(PLAN_TIMEOUT_MS) : undefined
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream({
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      messages,
      system: PLAN_SYSTEM,
      maxTokens: PLAN_MAX_TOKENS,
      signal: combine(signal, timeout),
      sessionId,
    })) assembler.push(chunk)
    if (assembler.finish?.kind === 'error' || assembler.finish?.kind === 'aborted') return undefined
    const plan = assembler.blocks()
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (plan === '') return undefined
    return { turn: trigger.turn, text: plan.slice(0, PLAN_MAX_CHARS), by: ref, at: Date.now() }
  }

  const ensurePlan = async (context) => {
    const agent = context?.agent
    const sessionId = agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return
    if (isSubagent(agent)) return
    const botId = botIdOf(sessionId)
    if (botId === undefined) return
    const planner = plannerOf(botId)
    if (planner === undefined) return
    const trigger = triggers.get(sessionId)
    if (trigger === undefined) return
    const open = plans.get(sessionId)
    if (open !== undefined && open.turn === trigger.turn) return
    if (failed.get(sessionId) === trigger.turn) return
    const runningNow = running.get(sessionId)
    if (runningNow !== undefined) {
      await runningNow.catch(() => undefined)
      return
    }
    const work = planTurn({ sessionId, botId, planner, trigger, signal: context?.signal })
      .then((plan) => {
        if (plan !== undefined) plans.set(sessionId, plan)
      })
      .catch((error) => {
        failed.set(sessionId, trigger.turn)
        if (!warned.has(botId)) {
          warned.add(botId)
          rt.warn('ds-bot: the planner for %s failed: %s', rt.botOf(botId)?.name ?? botId, error?.message ?? error)
        }
      })
    running.set(sessionId, work)
    await work.finally(() => {
      if (running.get(sessionId) === work) running.delete(sessionId)
    })
  }

  // First in the waterfall: the plan must exist before sections are rendered.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    try { await ensurePlan(context) } catch { /* planning never blocks a turn */ }
    return next()
  })

  const planTextFor = (sessionId) => {
    const plan = plans.get(sessionId)
    if (plan === undefined) return ''
    if (Date.now() - plan.at > PLAN_TTL_MS) {
      plans.delete(sessionId)
      return ''
    }
    return [
      `[Turn plan from ${plan.by} — written before you act. Follow it where the work fits; you stay responsible for the result.]`,
      '',
      plan.text,
    ].join('\n')
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'bot-plan',
    order: PLAN_ORDER,
    interpolate: false,
    text: context => planTextFor(context?.agent?.id),
  }), 'ds-bot: turn plan section')
}
