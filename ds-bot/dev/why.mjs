// `why` — one call's story, from the facts on disk — M1b-1 item 2.
//
//   node ds-bot/dev/why.mjs <home> [call_id] [--json]
//
// `<home>` is either the DSH home (`~/.dsh`, where the bot keeps its own folder under `bot/`)
// or the bot's own folder; the one that holds `company/` is used.
//
// Without a call id it lists every call the fact log knows, with the product's decision, the
// host's outcome and the reason both agree or disagree. With one it prints that call's record,
// its projection and its facts in order, which is the answer to "why did this run" without
// opening a session transcript.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rebuildHostOutcomes, whyOf, readHostLog } from '../src/host/company/selfreview/host-log.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const [home, callId] = args.filter(argument => argument !== '--json')

if (home === undefined) {
  console.error('usage: node ds-bot/dev/why.mjs <home> [call_id] [--json]')
  process.exit(2)
}

const companyDir = (root) => {
  const nested = join(root, 'bot', 'company')
  return existsSync(nested) ? nested : join(root, 'company')
}

const recordsPath = join(companyDir(home), 'selfreview.jsonl')
const records = existsSync(recordsPath)
  ? readFileSync(recordsPath, 'utf8').split('\n').filter(line => line.trim() !== '').flatMap(line => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
  : []
const rows = readHostLog(join(companyDir(home), 'selfreview-host.jsonl'))

if (json) {
  process.stdout.write(`${JSON.stringify(callId === undefined ? { calls: rebuildHostOutcomes({ rows, records }) } : whyOf({ rows, records, callId }), null, 2)}\n`)
  process.exit(0)
}

if (callId === undefined) {
  const projections = rebuildHostOutcomes({ rows, records })
  if (projections.length === 0) {
    console.log(`no calls in ${home}/company/selfreview-host.jsonl`)
    process.exit(0)
  }
  console.log(`home ${home}`)
  console.log('call_id                  decision     host_outcome          execution')
  for (const entry of projections) {
    const decision = entry.product_decision ?? '-'
    console.log(`${String(entry.call_id).padEnd(24)} ${decision.padEnd(12)} ${String(entry.outcome).padEnd(20)} ${entry.execution_result}`)
  }
  process.exit(0)
}

const story = whyOf({ rows, records, callId })
if (story.record === null && story.timeline.length === 0) {
  console.log(`no record or fact for ${callId} under ${home}`)
  process.exit(1)
}
console.log(`call ${callId}`)
console.log(`record   decision=${story.record?.decision ?? '-'} rule=${story.record?.rule_id ?? '-'} status=${story.record?.status ?? '-'}`)
console.log(`projection outcome=${story.projection.outcome} execution=${story.projection.execution_result} authorizer=${story.projection.authorizer}${story.projection.reason === undefined ? '' : ` reason=${story.projection.reason}`}`)
console.log('timeline')
for (const row of story.timeline) {
  const extra = [row.tool, row.approval_id, row.outcome, row.is_error === undefined ? undefined : `is_error=${row.is_error}`, row.text].filter(value => value !== undefined && value !== '').join('  ')
  console.log(`  ${row.at}  ${row.type.padEnd(20)} ${extra}`)
}
