// Spec builder tests — acceptance criteria are GENERATED at the spec stage.
//
// Covers (AC 语义修正, design §7):
//   - a story with no acceptance criteria gets its criteria generated from
//     title + description (never an empty Behavior section)
//   - generateAcceptanceCriteria always returns a non-empty, verifiable set
//   - a story WITH acceptance criteria keeps the supplied criteria untouched
//   - the Behavior section renders the criteria as a numbered list
//   - the generated set anchors the title and always names testability
//   - classifyCriteria is reachable and returns all six category buckets
//
// Run with: node scripts/test-spec-builder.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { buildSpec, generateAcceptanceCriteria, classifyCriteria } = await import(
  pathToFileURL(resolve(libBase, 'services', 'spec-builder.js')).href
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

const STORY = {
  id: 'TAPD-1',
  title: 'Add refund endpoint',
  description:
    'Expose a POST endpoint that records a refund against an existing payment.',
}

// ---- generateAcceptanceCriteria -------------------------------------

{
  const ac = generateAcceptanceCriteria(STORY)
  check('generate: non-empty', ac.length > 0, JSON.stringify(ac))
  check('generate: anchors the title', ac[0].includes('"Add refund endpoint"'), ac[0])
  check(
    'generate: renders the description',
    ac.some((c) => c.includes('Expose a POST endpoint')),
    JSON.stringify(ac),
  )
  check(
    'generate: always names testability',
    ac.some((c) => /automated tests/i.test(c)),
    JSON.stringify(ac),
  )
}

{
  const ac = generateAcceptanceCriteria({ title: '', description: '' })
  check('generate: empty story still yields a non-empty set', ac.length > 0, JSON.stringify(ac))
  check(
    'generate: empty story falls back to a generic anchor',
    ac[0] === 'The change described by the story is implemented.',
    ac[0],
  )
}

// ---- buildSpec: no acceptance criteria ------------------------------

{
  const s = buildSpec(STORY, null)
  check('no AC: criteria are generated (non-empty)', s.criteria.length > 0, JSON.stringify(s.criteria))
  check('no AC: Behavior section is present', /## Behavior/.test(s.markdown))
  check(
    'no AC: Behavior lists a numbered criterion',
    /^1\. The change described by/m.test(s.markdown),
  )
  check(
    'no AC: no empty-verifiable placeholder remains',
    !/_No acceptance criteria could be derived from the story\._/.test(s.markdown),
  )
}

// ---- buildSpec: supplied acceptance criteria ------------------------

{
  const s = buildSpec({ ...STORY, acceptanceCriteria: '1. First thing\n2. Second thing' }, null)
  check('with AC: parses 2 criteria', s.criteria.length === 2, JSON.stringify(s.criteria))
  check('with AC: keeps supplied wording', s.criteria[0] === 'First thing', s.criteria[0])
  check('with AC: Behavior lists both', s.markdown.includes('1. First thing') && s.markdown.includes('2. Second thing'))
}

// ---- buildSpec: a well-formed, reviewable spec ----------------------

{
  const s = buildSpec(STORY, null)
  check('spec: header names the story', s.markdown.startsWith(`# Spec — ${STORY.title}`))
  check('spec: carries SPEC_COMPLETE sentinel', /\[SPEC_COMPLETE\]/.test(s.markdown))
  check('spec: marks covered categories', Array.isArray(s.coveredCategories), JSON.stringify(s.coveredCategories))
}

// ---- classifyCriteria ------------------------------------------------

{
  const c = classifyCriteria(['POST /refunds returns 201', 'Add a schema migration for refunds'])
  check('classify: api bucket populated', c.byCategory.api.length > 0, JSON.stringify(c.byCategory.api))
  check('classify: data bucket populated', c.byCategory.data.length > 0, JSON.stringify(c.byCategory.data))
  check(
    'classify: all six buckets present',
    ['api', 'data', 'error', 'compat', 'security', 'exclusion'].every((k) => Array.isArray(c.byCategory[k])),
  )
}

// ---- Summary ----------------------------------------------------------

process.stdout.write(`\nSpec builder tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
