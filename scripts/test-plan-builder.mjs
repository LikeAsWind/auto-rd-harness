// Plan builder tests — derive a real implementation plan from a story.
//
// Covers:
//   - one task per acceptance criterion, in order, with stable task ids
//   - each task carries the criterion it satisfies
//   - a story with no acceptance criteria falls back to one title-derived task
//   - splitAcceptanceCriteria handles numbered / bullet / blank / missing input
//   - slugify produces path-safe, lowercase, dash-joined slugs
//   - pickExtension defaults to `.ts` when there is no probe
//   - the plan markdown ends with the PLAN_COMPLETE sentinel
//
// Run with: node scripts/test-plan-builder.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { buildPlan, splitAcceptanceCriteria, slugify, pickExtension } = await import(
  pathToFileURL(resolve(libBase, 'services', 'plan-builder.js')).href
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

// ---- tasks from acceptance criteria ----------------------------------

{
  const p = buildPlan(
    { id: 'S1', title: 'Do the thing', description: 'x'.repeat(40), acceptanceCriteria: '1. First check\n2. Second check' },
    null,
  )
  check('two criteria -> two tasks', p.tasks.length === 2, JSON.stringify(p.tasks.length))
  check('stable task ids', p.tasks[0].taskId === 'T001' && p.tasks[1].taskId === 'T002', JSON.stringify(p.tasks.map((t) => t.taskId)))
  check('each task carries its criterion', p.tasks[0].criterion === 'First check' && p.tasks[1].criterion === 'Second check')
  check('second task depends on the first', p.tasks[1].dependsOn.includes('T001'), JSON.stringify(p.tasks[1].dependsOn))
  check('plan ends with sentinel', /\[PLAN_COMPLETE\]/.test(p.markdown))
}

// ---- no acceptance criteria -> title-derived task --------------------

{
  const p = buildPlan({ id: 'S1', title: 'Wire up the payment flow', description: '' }, null)
  check('no AC -> one task', p.tasks.length === 1, JSON.stringify(p.tasks.length))
  check('task title falls back to story title', p.tasks[0].title === 'Wire up the payment flow', p.tasks[0].title)
  check('no criterion on the fallback task', p.tasks[0].criterion === undefined, JSON.stringify(p.tasks[0].criterion))
}

// ---- splitAcceptanceCriteria (shared with Clarify + Spec) ------------

{
  check('split: numbered list', JSON.stringify(splitAcceptanceCriteria('1. A\n2. B')) === JSON.stringify(['A', 'B']))
  check('split: bullet list', JSON.stringify(splitAcceptanceCriteria('- A\n- B')) === JSON.stringify(['A', 'B']))
  check('split: blank string -> empty', splitAcceptanceCriteria('   ').length === 0)
  check('split: undefined -> empty', splitAcceptanceCriteria(undefined).length === 0)
}

// ---- slugify / pickExtension ------------------------------------------

{
  check('slug: lowercased + dash-joined', slugify('Hello World!') === 'hello-world')
  check('slug: strips leading/trailing dashes', slugify('!!!important!!!') === 'important', slugify('!!!important!!!'))
  check('slug: empty falls back to "task"', slugify('!!!') === 'task')
  check('pickExtension: no probe -> .ts', pickExtension(null) === '.ts')
}

// ---- Summary ----------------------------------------------------------

process.stdout.write(`\nPlan builder tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
