// Resolution builder tests — the deterministic arbiter.
//
// Covers:
//   - every blocking finding is resolved (no question left open)
//   - each decision records Ambiguity / Chosen / Why / Downstream
//   - a vague criterion is resolved to a literal reading (least invention)
//   - a short-description story resolves to "description is complete intent"
//   - the artifact carries a Decisions table + Resolved Acceptance Criteria
//   - the sentinel is [RESOLUTION_COMPLETE]
//   - empty findings produce an empty-decision artifact (idempotent on
//     the "clarification found zero questions" path)
//
// Run with: node scripts/test-resolution.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { buildResolution } = await import(
  pathToFileURL(resolve(libBase, 'services', 'resolution-builder.js')).href
)

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) {
    pass += 1
    process.stdout.write(`\u2713 ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`\u2717 ${name}${extra ? ` (${extra})` : ''}\n`)
  }
}

const VAGUE = {
  kind: 'vague_acceptance_criterion',
  question: 'How should "fast" be verified?',
  detail: 'vague term',
  criterion: 'The query must be fast',
}

const SHORT = {
  kind: 'short_description',
  question: 'Can you expand the description?',
  detail: 'too short',
}

// ---- every finding is resolved -----------------------------------

{
  const r = buildResolution(
    { title: 'T', description: 'Add a fast query endpoint.' },
    [VAGUE, SHORT],
  )
  check('resolves: every finding becomes a decision', r.decisions.length === 2, JSON.stringify(r.decisions))
  check('resolves: nothing left unresolved', r.unresolved.length === 0, JSON.stringify(r.unresolved))
}

// ---- decision shape (Ambiguity / Chosen / Why / Downstream) --------

{
  const r = buildResolution({ title: 'T', description: 'Add a fast query endpoint.' }, [VAGUE])
  const d = r.decisions[0]
  check('shape: ambiguity carried', typeof d.ambiguity === 'string' && d.ambiguity.length > 0, JSON.stringify(d))
  check('shape: chosen recorded', typeof d.chosen === 'string' && d.chosen.length > 0, JSON.stringify(d))
  check('shape: why recorded', typeof d.why === 'string' && d.why.length > 0, JSON.stringify(d))
  check('shape: downstream recorded', typeof d.downstream === 'string' && d.downstream.length > 0, JSON.stringify(d))
}

// ---- vague criterion -> literal reading (least invention) ---------

{
  const r = buildResolution({ title: 'T', description: 'Add a fast query endpoint.' }, [VAGUE])
  check('vague: chosen is literal reading', /literally|literal|wording/i.test(r.decisions[0].chosen), r.decisions[0].chosen)
}

// ---- short description -> description is complete intent ---------

{
  const r = buildResolution({ title: 'T', description: 'Add a fast query endpoint.' }, [SHORT])
  check('short: resolved to complete intent', /complete intent|authoritative/i.test(r.decisions[0].chosen), r.decisions[0].chosen)
  check('short: description carried as a resolved criterion', r.resolvedCriteria.some((c) => /fast query endpoint/.test(c)), JSON.stringify(r.resolvedCriteria))
}

// ---- artifact content ----------------------------------------------

{
  const r = buildResolution({ title: 'T', description: 'Add a fast query endpoint.' }, [VAGUE])
  check('artifact: Decisions table header', /## Decisions/.test(r.markdown), r.markdown.slice(0, 80))
  check('artifact: Resolved Acceptance Criteria header', /## Resolved Acceptance Criteria/.test(r.markdown), r.markdown.slice(0, 80))
  check('artifact: sentinel present', /\[RESOLUTION_COMPLETE\]/.test(r.markdown), r.markdown.slice(-40))
  check('artifact: vague criterion carried into criteria', r.resolvedCriteria.includes('The query must be fast'), JSON.stringify(r.resolvedCriteria))
}

// ---- zero questions (idempotent) ----------------------------------

{
  const r = buildResolution({ title: 'T', description: 'Add an endpoint.' }, [])
  check('empty: zero decisions', r.decisions.length === 0, JSON.stringify(r.decisions))
  check('empty: still emits sentinel', /\[RESOLUTION_COMPLETE\]/.test(r.markdown), r.markdown.slice(-40))
  check('empty: empty decisions row rendered', /_none_|no open questions/.test(r.markdown), r.markdown.slice(0, 200))
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nResolution tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
