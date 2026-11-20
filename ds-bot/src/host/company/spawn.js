// Making an employee from a template (M1b-3.4). A template holds the job description, the
// instructions, the model, the thinking level and the skills; this command is the one place
// that turns them into a Bot the team can use, in the order the host needs:
//
//   1. make the Bot (name, role, instructions, model, effort)
//   2. attach each shared capability, one call each
//   3. write the employee profile that points at it
//
// The order is not free. The host makes a Bot in a single call but attaches capabilities one
// at a time, and the profile's own check wants a Bot that already exists. That is also why
// this command has to undo by hand: `createBot` writes the team file before it returns, so
// the store's draft rollback cannot take that Bot back. A refusal at step 2 or 3 detaches
// what was attached and deletes the Bot; a Bot that cannot be deleted is reported in the
// error instead of being left behind quietly.
//
// Since contract v1.18 a Bot is made from two templates: one `soul` (character, voice, values)
// and one `agent` (the job). The Bot's instructions are the soul paragraph, a blank line, then
// the agent paragraph — the exact text `employee.preview-from-template` answers, so a preview
// and the Bot made from it cannot drift. A job that names no soul takes the company's default
// soul; a company that has none yet is hired from with the agent text alone.
//
// `employee.create` is reused rather than reimplemented: the one-active-profile rule, the
// acceptance roles and the conversation-mode rules stay in the module that owns them.
import { companyFail } from './store.js'
import { kindOfRow, soulOf, templateView } from './templates.js'

const str = (value, field, { max = 120, min = 1 } = {}) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (trimmed.length < min) throw companyFail('company/invalid', `${field} is required.`, { field })
  if (trimmed.length > max) throw companyFail('company/invalid', `${field} is longer than ${max} characters.`, { field, max })
  return trimmed
}

const optionalText = (value, field, max = 120) => (value === undefined || value === null || value === '' ? undefined : str(value, field, { max }))

const messageOf = error => (error instanceof Error ? error.message : String(error))

const companyOf = (state) => {
  const company = Object.values(state.companies).find(entry => entry.status !== 'archived')
  if (company === undefined) throw companyFail('company/not-found', 'Create the company before hiring from a template.', {})
  return company
}

const templateOf = (state, id) => {
  const template = state.templates[id]
  if (template === undefined) throw companyFail('template/not-found', `No template ${id}.`, { template_id: id })
  return template
}

const departmentOf = (state, id) => {
  const department = state.departments[id]
  if (department === undefined || department.status === 'archived') {
    throw companyFail('department/not-found', `No department ${id}.`, { field: 'department_id', department_id: id })
  }
  return department
}

// The company soul a hire takes when the caller names none. The builtin row is preferred by
// its stable id; a company that renamed its own soul still finds exactly one to use.
const defaultSoul = (state, companyId) => {
  const souls = Object.values(state.templates)
    .filter(template => template.company_id === companyId && template.status !== 'archived' && kindOfRow(template) === 'soul')
    .sort((left, right) => (left.source === 'builtin' && right.source !== 'builtin' ? -1 : left.created_at - right.created_at))
  return souls[0]
}

const soulFor = (state, companyId, payload) => {
  if (payload.soul_template_id === undefined || payload.soul_template_id === null || payload.soul_template_id === '') return defaultSoul(state, companyId)
  return soulOf(state, companyId, str(payload.soul_template_id, 'soul_template_id', { max: 120 }))
}

// The one place the two paragraphs become a Bot's instructions. Everything that answers a
// preview or writes a Bot goes through it: a trimmed soul, one blank line, a trimmed job.
export const instructionsWithSoul = (soul, agent) => {
  const job = (agent?.instructions ?? '').trim()
  const soulText = soul === undefined || soul === null ? '' : (soul.instructions ?? '').trim()
  if (soulText === '') return job
  if (job === '') return soulText
  return `${soulText}\n\n${job}`
}

// The host calls this command cannot make itself. `create` returns the new Bot; `undo`
// detaches the given capabilities in reverse and deletes the Bot, answering whether the Bot
// is still there — the one fact the error body must not guess.
export function spawnHandlers({ roster = {}, createEmployee, warn = () => {} } = {}) {
  return {
    // What the hire screen shows before anything is written. It answers the two paragraphs and
    // the exact instructions the Bot would get, through the same function the hire uses, so a
    // preview cannot promise wording the Bot does not receive. It writes nothing and needs no
    // Bot name: the name is decided on the same screen, and a preview must not fail because a
    // name is taken — that is the hire's refusal to make.
    'employee.preview-from-template': ({ state, payload }) => {
      const company = companyOf(state)
      const agent = templateOf(state, str(payload.template_id, 'template_id', { max: 120 }))
      if (agent.status === 'archived') {
        throw companyFail('template/archived', `Template ${agent.name} is archived; pick another one.`, { template_id: agent.id })
      }
      if (kindOfRow(agent) !== 'agent') {
        throw companyFail('template/kind-mismatch', `Template ${agent.name} is a ${kindOfRow(agent)} template; pick an agent template to hire from.`, { template_id: agent.id, field: 'template_id', kind: kindOfRow(agent) })
      }
      const soul = soulFor(state, company.id, payload)
      return {
        aggregate_id: agent.id,
        mutates: false,
        body: {
          soul: soul === undefined ? null : templateView(soul),
          agent: templateView(agent),
          // The screen shows `name` as the employee's name and may edit it; it is not checked
          // here because the hire checks it against the roster and the profile rules.
          name: optionalText(payload.name, 'name', 80) ?? agent.name,
          instructions: instructionsWithSoul(soul, agent),
        },
      }
    },

    'employee.create-from-template': async ({ state, payload, now }) => {
      if (typeof createEmployee !== 'function') {
        throw companyFail('company/unsupported', 'This dsh cannot write employee profiles.', {})
      }
      const company = companyOf(state)
      const template = templateOf(state, str(payload.template_id, 'template_id', { max: 120 }))
      if (template.status === 'archived') {
        throw companyFail('template/archived', `Template ${template.name} is archived; pick another one.`, { template_id: template.id })
      }
      // A job is made from an agent template; a soul is chosen beside it, never in its place.
      if (kindOfRow(template) !== 'agent') {
        throw companyFail('template/kind-mismatch', `Template ${template.name} is a ${kindOfRow(template)} template; pick an agent template to hire from.`, { template_id: template.id, field: 'template_id', kind: kindOfRow(template) })
      }
      const soul = soulFor(state, company.id, payload)
      const department = departmentOf(state, str(payload.department_id, 'department_id', { max: 120 }))

      // The employee is named for the screen; the Bot's own name is what the team shows and
      // what every mention matches, so it is checked against the roster's rules before a Bot
      // is made. A name left out follows the employee name, which is why an over-long one is
      // refused here instead of being silently cut by the host.
      const name = str(payload.name ?? template.name, 'name', { max: 80 })
      const botName = optionalText(payload.bot_name, 'bot_name', 40) ?? name
      if (botName.length > 40) {
        throw companyFail('company/invalid', 'A Bot name holds at most 40 characters; shorten it or give bot_name.', { field: 'bot_name', max: 40 })
      }
      const problem = roster.problem?.(botName)
      if (problem !== undefined) throw companyFail('company/invalid', problem, { field: 'bot_name', bot_name: botName })
      if (roster.byName?.(botName) !== undefined) {
        throw companyFail('employee/bot-name-taken', `A Bot named ${botName} already exists; give this employee another name.`, { field: 'bot_name', bot_name: botName })
      }

      // A skill the library does not hold is caught before the Bot exists: the same refusal
      // after a create would cost a Bot and a rollback for something the template already says.
      // `has` answers undefined when the caller cannot look, and then the attach call decides.
      const skills = [...(template.skills ?? [])]
      const missing = skills.filter(skill => roster.has?.(skill) === false)
      if (missing.length > 0) {
        throw companyFail('employee/capability-missing', `This dsh has no ${missing.join(', ')}; add it to the library or edit the template first.`, { template_id: template.id, missing })
      }

      // A thinking level belongs to a model, and the host refuses one without the other. A
      // template saved with an effort and no model would otherwise fail after the Bot exists,
      // for a reason that is one field in the template — so it is refused before any is made.
      if (template.effort && !template.model) {
        throw companyFail('company/invalid', `Template ${template.name} names a thinking level but no model; set its model or drop its effort.`, { template_id: template.id, field: 'effort' })
      }

      let bot
      try {
        bot = await roster.create({
          name: botName,
          role: template.role ?? '',
          instructions: instructionsWithSoul(soul, template),
          ...(template.model ? { model: template.model } : {}),
          // An empty thinking level is an explicit Default, not a missing pick: passing
          // undefined here would let each create inherit the profile default as it
          // happens to be at that moment.
          effort: template.effort ?? null,
        })
      } catch (error) {
        throw companyFail('employee/bot-create-failed', `${botName} was not created: ${messageOf(error)}`, { template_id: template.id, field: 'bot', bot_name: botName })
      }
      if (bot === undefined || typeof bot.id !== 'string') {
        throw companyFail('employee/bot-create-failed', `${botName} was not created: the roster answered with no Bot.`, { template_id: template.id, field: 'bot', bot_name: botName })
      }

      const attached = []
      try {
        for (const skill of skills) {
          await roster.attach(bot.id, skill)
          attached.push(skill)
        }
      } catch (error) {
        const refused = skills[attached.length]
        const left = await roster.undo(bot.id, attached)
        warn('ds-bot: rolling back %s after %s failed: %d attached, Bot left: %s', botName, refused, attached.length, left === true)
        throw companyFail('employee/capability-failed', `${botName} was made but ${refused} could not be attached: ${messageOf(error)}`, {
          template_id: template.id,
          field: 'skills',
          skill: refused,
          attached,
          ...(left === true ? { bot_left_behind: bot.id } : {}),
        })
      }

      let made
      try {
        made = await createEmployee({
          state,
          payload: {
            bot_id: bot.id,
            department_id: department.id,
            name,
            // The template's role is a short label (24 characters); the profile's own role
            // is the one shown on the employee card and allows more.
            role: optionalText(payload.role, 'role', 80) ?? template.role ?? undefined,
            acceptance_role: payload.acceptance_role,
            conversation_mode: payload.conversation_mode,
          },
          now,
        })
      } catch (error) {
        const left = await roster.undo(bot.id, attached)
        warn('ds-bot: rolling back %s after the profile was refused: %d attached, Bot left: %s', botName, attached.length, left === true)
        // The Bot outlived the rollback: name it in the refusal, so a stray Bot is something
        // the person is told about rather than something they find later.
        if (left === true && error !== null && typeof error === 'object') {
          error.details = { ...error.details, bot_left_behind: bot.id }
        }
        throw error
      }

      return {
        aggregate_id: made.aggregate_id,
        body: {
          employee: made.body.employee,
          bot: { id: bot.id, name: bot.name, skills: attached, instructions: instructionsWithSoul(soul, template) },
          soul_template_id: soul?.id ?? null,
        },
        // One `employee.created`, tagged with the template it came from: the audit line says
        // both what was made and why these settings.
        events: (made.events ?? [{ type: 'employee.created', data: { bot_id: bot.id, department_id: department.id } }])
          .map(event => ({ ...event, data: { ...event.data, template_id: template.id, soul_template_id: soul?.id ?? null, company_id: company.id } })),
      }
    },
  }
}
