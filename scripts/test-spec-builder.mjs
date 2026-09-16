// SpecBuilder tests.
//
// Covers:
//   - criterion classification into api / data / error / compat /
//     security / exclusion categories
//   - word-boundary matching (no false positives on unrelated words)
//   - the rendered markdown carries the story's real content, not
//     placeholders
//   - empty categories say so explicitly instead of inventing content
//   - the Test Plan uses the REAL test command and the plan's real paths
//   - a story with zero criteria produces an explicitly unverifiable spec
//   - [SPEC_COMPLETE] is present
//
// Run with: node scripts/test-spec-builder.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { buildSpec, classifyCriteria } = await import(
  pathToFileURL(resolve(libBase, 'services', 'spec-builder.js')).href
)
const { buildPlan, splitAcceptanceCriteria } = await import(
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

function fakeProbe(over = {}) {
  return {
    worktreePath: '/x',
    isGitRepo: true,
    headSha: 'a'.repeat(40),
    branch: 'main',
    packageManager: 'npm',
    installCommand: 'npm ci',
    testCommand: 'npm test',
    buildCommand: null,
    manifests: ['package.json'],
    topLevelDirs: ['src', 'tests'],
    topLevelFiles: [],
    languageBreakdown: { '.ts': 5 },
    fileCount: 5,
    walkTruncated: false,
    ...over,
  }
}

const STORY = {
  id: 'S1',
  title: 'Add refund endpoint',
  description: 'Expose a POST endpoint that records a refund against an existing payment.',
  acceptanceCriteria:
    '1. POST /refunds with a valid payment id returns 201 and persists the refund\n' +
    '2. POST /refunds with an unknown payment id returns 404\n' +
    '3. The refund row is written to the refunds table',
}

// ---- classifyCriteria ---------------------------------------------

{
  const c = classifyCriteria(splitAcceptanceCriteria(STORY.acceptanceCriteria))
  check('classify: api catches the endpoint criteria', c.byCategory.api.length >= 2, JSON.stringify(c.byCategory.api))
  check('classify: error catches the 404 criterion', c.byCategory.error.length >= 1, JSON.stringify(c.byCategory.error))
  check('classify: data catches the table criterion', c.byCategory.data.length >= 1, JSON.stringify(c.byCategory.data))
  check('classify: compat empty for this story', c.byCategory.compat.length === 0)
  check('classify: security empty for this story', c.byCategory.security.length === 0)
}

{
  const c = classifyCriteria([
    'The new field must not break existing clients (backwards compatible)',
    'Only users with the admin role may delete a record',
    'Migrate the users table to add the email column',
    'Out of scope: multi-region replication',
  ])
  check('classify: compat keyword detected', c.byCategory.compat.length === 1, JSON.stringify(c.byCategory.compat))
  check('classify: security keyword detected', c.byCategory.security.length === 1, JSON.stringify(c.byCategory.security))
  check('classify: exclusion keyword detected', c.byCategory.exclusion.length === 1, JSON.stringify(c.byCategory.exclusion))
  // The first criterion genuinely describes BOTH a data-model change (a
  // new field) and a compatibility obligation. Multi-category matching
  // is intentional, so all three data-ish criteria land in `data`.
  check(
    'classify: data catches the field, table, and column criteria',
    c.byCategory.data.length === 3,
    JSON.stringify(c.byCategory.data),
  )
  // Regression: "out of scope" must NOT be read as a security concern.
  check(
    'classify: "out of scope" is exclusion, not security',
    !c.byCategory.security.some((s) => /out of scope/i.test(s)),
    JSON.stringify(c.byCategory.security),
  )
}

{
  // A criterion can match several categories at once.
  const c = classifyCriteria(['POST /refunds with a bad token returns 401'])
  check('classify: multi-category criterion matches api', c.byCategory.api.length === 1, JSON.stringify(c.byCategory.api))
  check('classify: multi-category criterion matches error', c.byCategory.error.length === 1)
  check('classify: multi-category criterion matches security', c.byCategory.security.length === 1)
}

// ---- Word boundaries ---------------------------------------------

{
  const c = classifyCriteria(['The serializer is fast'])
  check(
    'classify: "serializer" does not trigger a false positive',
    c.byCategory.data.length === 0 && c.byCategory.api.length === 0,
    JSON.stringify(c.byCategory),
  )
}

// ---- Rendered spec -----------------------------------------------

{
  const plan = buildPlan(STORY, fakeProbe())
  const spec = buildSpec(STORY, fakeProbe(), { plan })
  const md = spec.markdown

  check('spec: has a Goal from the description', md.includes(STORY.description))
  check('spec: [SPEC_COMPLETE] present', md.includes('[SPEC_COMPLETE]'))
  check('spec: no <Feature> placeholder', !/<Feature>/.test(md), md.slice(0, 300))
  check('spec: no bogus ValidationError row', !md.includes('ValidationError'))
  check(
    'spec: Behavior numbers every criterion',
    md.includes('1. POST /refunds with a valid payment id returns 201') &&
      md.includes('3. The refund row is written to the refunds table'),
  )
  check('spec: real HEAD sha in context', md.includes('a'.repeat(40)))
  check('spec: real package manager in context', md.includes('Package manager: npm'))
  check('spec: Test Plan uses the real test command', md.includes('`npm test`'))
  check(
    'spec: Test Plan lists the plan paths',
    md.includes(plan.tasks[0].testFile) && md.includes(plan.tasks[0].sourceFile),
    `${plan.tasks[0].testFile} / ${plan.tasks[0].sourceFile}`,
  )
  check(
    'spec: covered categories reported',
    spec.coveredCategories.includes('api') && spec.coveredCategories.includes('error'),
    JSON.stringify(spec.coveredCategories),
  )
}

// ---- Empty categories are explicit -------------------------------

{
  const spec = buildSpec(
    {
      id: 'S2',
      title: 'Simple change',
      description: 'A description long enough to be actionable in the spec.',
      acceptanceCriteria: '1. The widget renders in under 100ms on the reference device',
    },
    fakeProbe(),
  )
  const md = spec.markdown
  check(
    'spec: empty API section says so explicitly',
    md.includes('No endpoint, request/response, or signature obligations were specified.'),
  )
  check(
    'spec: empty data section says so explicitly',
    md.includes('No schema, migration, or persistence changes were specified.'),
  )
  check(
    'spec: empty compat section says so explicitly',
    md.includes('No breaking-change or backward-compatibility obligations were specified.'),
  )
  check(
    'spec: empty security section says so explicitly',
    md.includes('No authentication, authorization, or data-sensitivity obligations were specified.'),
  )
  check(
    'spec: empty error section says so explicitly',
    md.includes('No error, rejection, or status-code obligations were specified.'),
  )
  check('spec: fallback non-goal is stated', md.includes('Anything not covered by the acceptance criteria'))
}

// ---- Zero criteria is unverifiable, and says so ------------------

{
  const spec = buildSpec(
    { id: 'S3', title: 'Vague', description: 'Something vague but long enough to pass.' },
    fakeProbe(),
  )
  check('spec: zero criteria -> criteria array empty', spec.criteria.length === 0)
  check(
    'spec: zero criteria warns explicitly',
    spec.markdown.includes('No acceptance criteria were specified'),
    spec.markdown.slice(0, 400),
  )
  check('spec: still emits [SPEC_COMPLETE] so the stage can advance', spec.markdown.includes('[SPEC_COMPLETE]'))
}

// ---- Table escaping ----------------------------------------------

{
  const spec = buildSpec(
    {
      id: 'S4',
      title: 'Pipes',
      description: 'A description long enough to be actionable in the spec.',
      acceptanceCriteria: '1. Invalid input returns 400 | with a pipe in the text',
    },
    fakeProbe(),
  )
  check(
    'spec: pipes in criteria are escaped in the table',
    spec.markdown.includes('\\|'),
    spec.markdown.split('\n').filter((l) => l.includes('400')).join(' | '),
  )
}

// ---- Plan-less rendering -----------------------------------------

{
  const spec = buildSpec(STORY, fakeProbe())
  check(
    'spec: without a plan the Test Plan says so',
    spec.markdown.includes('No plan has been built yet'),
  )
}

// ---- Summary ------------------------------------------------------

process.stdout.write(`\nSpecBuilder tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
