// PlanBuilder tests.
//
// The load-bearing assertion in this file is the ROUND TRIP:
//   buildPlan(...) -> markdown -> parsePlannerMarkdown(markdown)
// must produce tasks whose ids, titles, file paths, and RED/GREEN/
// VERIFY/COMMIT steps all survive. The StoryRunner feeds exactly that
// parser output into the implementing stage, so a break here would
// silently degrade every downstream stage.
//
// Also covers:
//   - splitAcceptanceCriteria across the list shapes tickets use
//   - slugify edge cases
//   - pickExtension / pickDir against a real probed layout
//   - buildPlan with no ACs (single task from the title)
//   - buildPlan against a repo with no src/ or tests/ (unanchored notes)
//
// Run with: node scripts/test-plan-builder.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { buildPlan, splitAcceptanceCriteria, slugify, pickExtension, pickDir } = await import(
  pathToFileURL(resolve(libBase, 'services', 'plan-builder.js')).href
)
const { parsePlannerMarkdown } = await import(
  pathToFileURL(resolve(libBase, 'services', 'planner-parser.js')).href
)
const { probeProject } = await import(
  pathToFileURL(resolve(libBase, 'services', 'project-probe.js')).href
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

function mkTmpDir() {
  return mkdtempSync(join(tmpdir(), 'auto-rd-plan-'))
}

/** A minimal probe-shaped object (no filesystem needed). */
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
    topLevelDirs: [],
    topLevelFiles: [],
    languageBreakdown: { '.ts': 5 },
    fileCount: 5,
    walkTruncated: false,
    ...over,
  }
}

// ---- splitAcceptanceCriteria --------------------------------------

{
  check('splitAC: undefined -> []', splitAcceptanceCriteria(undefined).length === 0)
  check('splitAC: empty string -> []', splitAcceptanceCriteria('   ').length === 0)
}

{
  const ac = '1. Users can log in\n2. Sessions expire after 24h\n3. Bad passwords are rejected'
  const r = splitAcceptanceCriteria(ac)
  check('splitAC: numbered list -> 3 items', r.length === 3, JSON.stringify(r))
  check('splitAC: strips the "1. " marker', r[0] === 'Users can log in', r[0])
}

{
  const ac = '- Users can log in\n- Sessions expire after 24h'
  const r = splitAcceptanceCriteria(ac)
  check('splitAC: bullet list -> 2 items', r.length === 2, JSON.stringify(r))
}

{
  const ac = '- [ ] Users can log in\n- [x] Sessions expire after 24h'
  const r = splitAcceptanceCriteria(ac)
  check('splitAC: checkbox list -> 2 items', r.length === 2, JSON.stringify(r))
  check('splitAC: strips the checkbox marker', r[0] === 'Users can log in', r[0])
}

{
  const ac = '* first thing\n* second thing'
  const r = splitAcceptanceCriteria(ac)
  check('splitAC: asterisk bullets -> 2 items', r.length === 2, JSON.stringify(r))
}

{
  const ac = 'Users can log in.\n\nSessions expire after 24h.'
  const r = splitAcceptanceCriteria(ac)
  check('splitAC: blank-line paragraphs -> 2 items', r.length === 2, JSON.stringify(r))
}

{
  const r = splitAcceptanceCriteria('Users can log in successfully')
  check('splitAC: single sentence -> 1 item', r.length === 1, JSON.stringify(r))
}

{
  const r = splitAcceptanceCriteria('Users can log in. Sessions expire after 24 hours.')
  check('splitAC: two sentences -> 2 items', r.length === 2, JSON.stringify(r))
}

{
  const r = splitAcceptanceCriteria('Yes. No.')
  check(
    'splitAC: very short sentences stay as one item',
    r.length === 1,
    JSON.stringify(r),
  )
}

// ---- slugify ------------------------------------------------------

{
  check('slugify: basic', slugify('Users can log in') === 'users-can-log-in', slugify('Users can log in'))
  check('slugify: strips punctuation', slugify('Fix: a/b (urgent!)') === 'fix-a-b-urgent', slugify('Fix: a/b (urgent!)'))
  check('slugify: collapses repeats', slugify('a---b') === 'a-b', slugify('a---b'))
  check('slugify: trims leading/trailing dashes', slugify('  --hello--  ') === 'hello', slugify('  --hello--  '))
  check('slugify: empty -> "task"', slugify('!!!') === 'task', slugify('!!!'))
  check('slugify: truncates long input', slugify('x'.repeat(100)).length <= 48, String(slugify('x'.repeat(100)).length))
}

// ---- pickExtension / pickDir --------------------------------------

{
  check('pickExtension: null probe -> .ts', pickExtension(null) === '.ts')
  check(
    'pickExtension: prefers .ts over .js',
    pickExtension(fakeProbe({ languageBreakdown: { '.js': 10, '.ts': 1 } })) === '.ts',
  )
  check(
    'pickExtension: falls back to .js when no .ts',
    pickExtension(fakeProbe({ languageBreakdown: { '.js': 10 } })) === '.js',
  )
  check(
    'pickExtension: handles .py repos',
    pickExtension(fakeProbe({ languageBreakdown: { '.py': 10 } })) === '.py',
  )
  check(
    'pickExtension: no known ext -> .ts default',
    pickExtension(fakeProbe({ languageBreakdown: { '.txt': 10 } })) === '.ts',
  )
}

{
  check(
    'pickDir: finds tests/',
    pickDir(fakeProbe({ topLevelDirs: ['src', 'tests'] }), ['tests', 'test']) === 'tests',
  )
  check(
    'pickDir: respects candidate order',
    pickDir(fakeProbe({ topLevelDirs: ['test', 'tests'] }), ['tests', 'test']) === 'tests',
  )
  check('pickDir: null when absent', pickDir(fakeProbe({ topLevelDirs: ['src'] }), ['tests']) === null)
  check('pickDir: null probe -> null', pickDir(null, ['tests']) === null)
}

// ---- buildPlan ----------------------------------------------------

{
  const story = {
    id: 'S1',
    title: 'Add refund endpoint',
    description: 'd',
    acceptanceCriteria: '1. POST /refunds creates a refund\n2. Invalid amounts return 400',
  }
  const plan = buildPlan(story, fakeProbe({ topLevelDirs: ['src', 'tests'] }))

  check('buildPlan: one task per AC', plan.tasks.length === 2, String(plan.tasks.length))
  check('buildPlan: task ids are T001/T002', plan.tasks[0].taskId === 'T001' && plan.tasks[1].taskId === 'T002')
  check('buildPlan: T001 has no deps', plan.tasks[0].dependsOn.length === 0)
  check('buildPlan: T002 depends on T001', plan.tasks[1].dependsOn[0] === 'T001')
  check(
    'buildPlan: testFile anchored in tests/',
    plan.tasks[0].testFile === 'tests/post-refunds-creates-a-refund.test.ts',
    String(plan.tasks[0].testFile),
  )
  check(
    'buildPlan: sourceFile anchored in src/',
    plan.tasks[0].sourceFile === 'src/post-refunds-creates-a-refund.ts',
    String(plan.tasks[0].sourceFile),
  )
  check(
    'buildPlan: criterion recorded on the task',
    plan.tasks[0].criterion === 'POST /refunds creates a refund',
    String(plan.tasks[0].criterion),
  )
  check('buildPlan: no unanchored notes', plan.tasks.every((t) => t.notes.length === 0))
  check('buildPlan: layout records the dirs', plan.layout.sourceDir === 'src' && plan.layout.testDir === 'tests')
}

{
  const plan = buildPlan(
    { id: 'S2', title: 'Improve logging', description: 'd' },
    fakeProbe({ topLevelDirs: ['src', 'tests'] }),
  )
  check('buildPlan: no AC -> exactly 1 task', plan.tasks.length === 1, String(plan.tasks.length))
  check('buildPlan: single task uses the story title', plan.tasks[0].title === 'Improve logging')
  check('buildPlan: single task has no criterion', plan.tasks[0].criterion === undefined)
}

{
  const plan = buildPlan(
    { id: 'S3', title: 'Thing', description: 'd', acceptanceCriteria: '1. Do a thing' },
    fakeProbe({ topLevelDirs: [] }),
  )
  check(
    'buildPlan: no src/tests dirs -> unanchored note recorded',
    plan.tasks[0].notes.length > 0,
    JSON.stringify(plan.tasks[0].notes),
  )
  check('buildPlan: unanchored still yields a fallback path', /^tests\//.test(plan.tasks[0].testFile))
}

{
  const plan = buildPlan(
    { id: 'S4', title: 'Py thing', description: 'd', acceptanceCriteria: '1. Do a thing' },
    fakeProbe({ topLevelDirs: ['src', 'tests'], languageBreakdown: { '.py': 9 } }),
  )
  check('buildPlan: honours a .py repo', plan.tasks[0].sourceFile.endsWith('.py'), String(plan.tasks[0].sourceFile))
}

// ---- ROUND TRIP: buildPlan -> markdown -> parsePlannerMarkdown ----

{
  const story = {
    id: 'RT',
    title: 'Add refund endpoint',
    description: 'Refunds are needed.',
    acceptanceCriteria: '1. POST /refunds creates a refund\n2. Invalid amounts return 400',
  }
  const plan = buildPlan(story, fakeProbe({ topLevelDirs: ['src', 'tests'] }))
  const parsed = parsePlannerMarkdown(plan.markdown)

  check('round trip: parser finds the same number of tasks', parsed.length === plan.tasks.length, `${parsed.length} vs ${plan.tasks.length}`)
  check(
    'round trip: task ids survive',
    parsed.map((p) => p.taskId).join(',') === plan.tasks.map((t) => t.taskId).join(','),
    parsed.map((p) => p.taskId).join(','),
  )
  check(
    'round trip: titles survive',
    parsed[0].title === plan.tasks[0].title,
    `"${parsed[0].title}" vs "${plan.tasks[0].title}"`,
  )
  check(
    'round trip: file paths survive',
    parsed[0].files.includes(plan.tasks[0].testFile) &&
      parsed[0].files.includes(plan.tasks[0].sourceFile),
    JSON.stringify(parsed[0].files),
  )
  check(
    'round trip: dependsOn survives',
    parsed[1].dependsOn.includes('T001'),
    JSON.stringify(parsed[1].dependsOn),
  )
  check(
    'round trip: estimatedMinutes survives',
    parsed[0].estimatedMinutes === plan.tasks[0].estimatedMinutes,
    String(parsed[0].estimatedMinutes),
  )
  check(
    'round trip: RED step parsed',
    parsed[0].red !== undefined && parsed[0].red.file === plan.tasks[0].testFile,
    JSON.stringify(parsed[0].red),
  )
  check(
    'round trip: RED assertion carries the criterion',
    typeof parsed[0].red?.assertion === 'string' && parsed[0].red.assertion.length > 0,
    JSON.stringify(parsed[0].red),
  )
  check(
    'round trip: GREEN step parsed with the source file',
    parsed[0].green !== undefined && parsed[0].green.file === plan.tasks[0].sourceFile,
    JSON.stringify(parsed[0].green),
  )
  check(
    'round trip: VERIFY step parsed with the real test command',
    parsed[0].verify?.run === 'npm test',
    JSON.stringify(parsed[0].verify),
  )
  check('round trip: VERIFY expects PASS', parsed[0].verify?.expectedPass === true)
  check(
    'round trip: COMMIT parsed as conventional',
    parsed[0].commit?.type === 'feat' && parsed[0].commit.subject.length > 0,
    JSON.stringify(parsed[0].commit),
  )
  check(
    'round trip: NO parse warnings on any task',
    parsed.every((p) => p.parseWarnings.length === 0),
    JSON.stringify(parsed.map((p) => p.parseWarnings)),
  )
  check(
    'round trip: PLAN_COMPLETE sentinel present',
    plan.markdown.includes('[PLAN_COMPLETE]'),
  )
  check(
    'round trip: no placeholder paths remain',
    !/<feature>|<scope>|<test command>|TODO/i.test(plan.markdown),
  )
}

// ---- buildPlan against a REAL probed repo -------------------------

{
  const dir = mkTmpDir()
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'vitest' } }),
    'utf-8',
  )
  mkdirSync(join(dir, 'src', 'refunds'), { recursive: true })
  writeFileSync(join(dir, 'src', 'refunds', 'handler.ts'), 'export const h = 1\n', 'utf-8')
  mkdirSync(join(dir, 'tests'), { recursive: true })
  writeFileSync(join(dir, 'tests', 'existing.test.ts'), 'export {}\n', 'utf-8')

  const probe = probeProject(dir)
  const plan = buildPlan(
    {
      id: 'REAL',
      title: 'Add refund endpoint',
      description: 'd',
      acceptanceCriteria: '- POST /refunds creates a refund\n- Invalid amounts return 400',
    },
    probe,
  )

  check('real repo: pm detected as npm', probe.packageManager === 'npm')
  check('real repo: plan picks tests/ dir', plan.layout.testDir === 'tests', String(plan.layout.testDir))
  check('real repo: plan picks src/ dir', plan.layout.sourceDir === 'src', String(plan.layout.sourceDir))
  check('real repo: verify command is the real one', plan.layout.testCommand === 'npm test', String(plan.layout.testCommand))
  check('real repo: 2 tasks from 2 ACs', plan.tasks.length === 2)

  const parsed = parsePlannerMarkdown(plan.markdown)
  check(
    'real repo round trip: parses cleanly',
    parsed.length === 2 && parsed.every((p) => p.parseWarnings.length === 0),
    JSON.stringify(parsed.map((p) => p.parseWarnings)),
  )
  check(
    'real repo round trip: verify uses the detected command',
    parsed[0].verify?.run === 'npm test',
    String(parsed[0].verify?.run),
  )
}

// ---- Summary ------------------------------------------------------

process.stdout.write(`\nPlanBuilder tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
