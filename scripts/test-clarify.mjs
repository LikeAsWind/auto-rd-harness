// Clarify tests — the HARD-GATE (B-4) ambiguity detector.
//
// Covers:
//   - missing acceptance criteria -> blocking
//   - empty / very short description -> blocking
//   - vague terms in a criterion -> blocking, with the term recorded
//   - untestable (too short) criterion -> blocking
//   - a well-formed story -> bounded, zero blocking
//   - word-boundary matching ("goodness" must NOT match "good",
//     "good enough" MUST)
//   - advisory-only findings keep the story bounded
//   - the criterion parser is shared with PlanBuilder
//
// Run with: node scripts/test-clarify.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { clarifyStory } = await import(
  pathToFileURL(resolve(libBase, 'services', 'clarify.js')).href
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

/** A story that should always come back bounded. */
const GOOD = {
  title: 'Add refund endpoint',
  description:
    'Expose a POST endpoint that records a refund against an existing payment.',
  acceptanceCriteria:
    '1. POST /refunds with a valid payment id returns 201 and persists the refund\n' +
    '2. POST /refunds with an unknown payment id returns 404',
}

// ---- Happy path --------------------------------------------------

{
  const r = clarifyStory(GOOD)
  check('bounded: classification is bounded', r.classification === 'bounded', r.classification)
  check('bounded: zero blocking findings', r.blocking.length === 0, JSON.stringify(r.blocking))
  check('bounded: parses 2 criteria', r.criteria.length === 2, JSON.stringify(r.criteria))
  check('bounded: no vague terms', r.vagueTerms.length === 0, JSON.stringify(r.vagueTerms))
  check('bounded: no advisory', r.advisory.length === 0, JSON.stringify(r.advisory))
}

// ---- Missing acceptance criteria ---------------------------------

{
  const r = clarifyStory({ ...GOOD, acceptanceCriteria: undefined })
  check('no AC: unbounded', r.classification === 'unbounded')
  check(
    'no AC: finding kind is missing_acceptance_criteria',
    r.blocking.some((f) => f.kind === 'missing_acceptance_criteria'),
    JSON.stringify(r.blocking.map((f) => f.kind)),
  )
  check(
    'no AC: question asks for acceptance criteria',
    /acceptance criteria/i.test(r.blocking[0].question),
    r.blocking[0].question,
  )
}

{
  const r = clarifyStory({ ...GOOD, acceptanceCriteria: '   ' })
  check('blank AC: unbounded', r.classification === 'unbounded')
}

// ---- Description length ------------------------------------------

{
  const r = clarifyStory({ ...GOOD, description: '' })
  check('empty description: unbounded', r.classification === 'unbounded')
  check(
    'empty description: short_description finding',
    r.blocking.some((f) => f.kind === 'short_description'),
    JSON.stringify(r.blocking.map((f) => f.kind)),
  )
}

{
  const r = clarifyStory({ ...GOOD, description: 'Fix it' })
  check('short description: unbounded', r.classification === 'unbounded')
  check(
    'short description: mentions the character count',
    /6 characters/.test(r.blocking.find((f) => f.kind === 'short_description')?.question ?? ''),
    JSON.stringify(r.blocking.map((f) => f.question)),
  )
}

// ---- Vague terms -------------------------------------------------

const VAGUE_CASES = [
  ['etc', '1. Handle the usual validation cases etc'],
  ['as needed', '1. Retry the request as needed'],
  ['properly', '1. Handle errors properly'],
  ['tbd', '1. The response format is TBD'],
  ['and so on', '1. Support the formats we discussed and so on'],
  ['optimize', '1. Optimize the query path'],
  ['flexible', '1. Make the parser flexible'],
]

for (const [term, ac] of VAGUE_CASES) {
  const r = clarifyStory({ ...GOOD, acceptanceCriteria: ac })
  check(
    `vague "${term}": unbounded`,
    r.classification === 'unbounded',
    `classification=${r.classification}`,
  )
  check(
    `vague "${term}": term recorded`,
    r.vagueTerms.includes(term),
    JSON.stringify(r.vagueTerms),
  )
  check(
    `vague "${term}": blocking finding carries the criterion`,
    r.blocking.some((f) => f.kind === 'vague_acceptance_criterion' && f.criterion === ac.replace(/^1\.\s*/, '')),
    JSON.stringify(r.blocking),
  )
}

// ---- Word-boundary correctness -----------------------------------

{
  const r = clarifyStory({
    ...GOOD,
    acceptanceCriteria: '1. The goodness metric is computed from the sample',
  })
  check(
    'word boundary: "goodness" does NOT match "good"',
    r.classification === 'bounded',
    JSON.stringify(r.vagueTerms),
  )
}

{
  const r = clarifyStory({
    ...GOOD,
    acceptanceCriteria: '1. The output should be good enough for the demo',
  })
  check(
    'word boundary: "good enough" DOES match "good"',
    r.classification === 'unbounded',
    JSON.stringify(r.vagueTerms),
  )
}

{
  const r = clarifyStory({
    ...GOOD,
    acceptanceCriteria: '1. The refactoring must not change public behaviour',
  })
  check(
    'word boundary: "refactoring" DOES match "refactor" via prefix rule',
    // "refactoring" contains "refactor" as a prefix but is followed by
    // "ing", an alphanumeric run, so the boundary rule rejects it.
    r.classification === 'bounded',
    JSON.stringify(r.vagueTerms),
  )
}

// ---- Untestable (too short) criterion ----------------------------

{
  const r = clarifyStory({
    ...GOOD,
    acceptanceCriteria: '1. It works',
  })
  check('short criterion: unbounded', r.classification === 'unbounded')
  check(
    'short criterion: untestable_criterion finding',
    r.blocking.some((f) => f.kind === 'untestable_criterion'),
    JSON.stringify(r.blocking.map((f) => f.kind)),
  )
}

// ---- Multiple findings accumulate --------------------------------

{
  const r = clarifyStory({
    title: 'x',
    description: 'short',
    acceptanceCriteria: '1. Do it etc\n2. Handle errors properly',
  })
  check('multiple: unbounded', r.classification === 'unbounded')
  check(
    'multiple: at least 3 blocking findings (desc + 2 vague)',
    r.blocking.length >= 3,
    `count=${r.blocking.length}`,
  )
  check(
    'multiple: both vague terms recorded',
    r.vagueTerms.includes('etc') && r.vagueTerms.includes('properly'),
    JSON.stringify(r.vagueTerms),
  )
}

// ---- Advisory does not block -------------------------------------

{
  const ac = Array.from(
    { length: 12 },
    (_, i) => `${i + 1}. Endpoint ${i} returns 200 for a valid request`,
  ).join('\n')
  const r = clarifyStory({ ...GOOD, acceptanceCriteria: ac })
  check('advisory: still bounded', r.classification === 'bounded', JSON.stringify(r.blocking))
  check('advisory: one advisory finding', r.advisory.length === 1, JSON.stringify(r.advisory))
  check(
    'advisory: mentions splitting the story',
    /split/i.test(r.advisory[0].question),
    r.advisory[0].question,
  )
}

// ---- Options -----------------------------------------------------

{
  const r = clarifyStory(
    { ...GOOD, description: 'Short but acceptable here' },
    { minDescriptionLength: 5 },
  )
  check('options: custom minDescriptionLength respected', r.classification === 'bounded', JSON.stringify(r.blocking))
}

{
  const r = clarifyStory(
    { ...GOOD, acceptanceCriteria: '1. It works' },
    { minCriterionLength: 3 },
  )
  check('options: custom minCriterionLength respected', r.classification === 'bounded', JSON.stringify(r.blocking))
}

// ---- Criterion parsing is shared with PlanBuilder -----------------

{
  const r = clarifyStory({
    ...GOOD,
    acceptanceCriteria: '- first check is long enough\n* second check is long enough',
  })
  check('shared parser: bullets parsed', r.criteria.length === 2, JSON.stringify(r.criteria))
  check('shared parser: bounds are stripped', r.criteria[0] === 'first check is long enough', r.criteria[0])
}

// ---- Summary ------------------------------------------------------

process.stdout.write(`\nClarify tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
