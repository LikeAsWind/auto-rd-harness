// Blocked-reason convention tests (design §12.1).
//
// Every blockedReason the runner writes must start with a lowercase stage
// code and a colon, because that prefix is what the human-recovery tools
// and the notifier key off. Prose prefixes ("Clarification blocked: ...")
// still read fine to a human but are useless to a machine, and the codebase
// had drifted into using both.
//
// The source is checked directly: this is a convention over string
// literals, and reading them back is the only way to catch a new
// assignment that does not follow it.
//
// Run with: node scripts/test-reason-codes.mjs

import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'src')

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

/** Stage codes the runner is allowed to prefix a reason with. */
const STAGE_CODES = [
  'runner',
  'context',
  'clarification',
  'brainstorm',
  'critic',
  'decision',
  'spec',
  'planning',
  'implementing',
  'testing',
  'fixing',
  'verifying',
  'reviewing',
  'final_verifying',
  'mr_creating',
  'tapd_syncing',
]

/**
 * Codes the human-recovery TOOLS use. A reason written by a person acting
 * through auto_rd_retry / auto_rd_trigger is not attributable to a stage,
 * so it gets its own prefix rather than being forced into a stage code.
 */
const RECOVERY_CODES = ['retry', 'review']

const ALL_CODES = [...STAGE_CODES, ...RECOVERY_CODES]

const runner = readFileSync(resolve(srcRoot, 'services', 'story-runner.ts'), 'utf-8')

// ---- every template-literal assignment carries a stage prefix --------

{
  // `story.blockedReason = \`...\`` and `story!.blockedReason = \`...\``
  const assignments = [
    ...runner.matchAll(/blockedReason\s*=\s*`([^`]*)`/g),
  ].map((m) => m[1])

  check('runner: found blockedReason assignments', assignments.length >= 10, String(assignments.length))

  const offenders = assignments.filter((template) => {
    const code = template.split(':')[0].trim()
    return !ALL_CODES.includes(code)
  })

  check(
    'runner: every blockedReason template starts with a known stage code',
    offenders.length === 0,
    JSON.stringify(offenders),
  )
}

// ---- the stage codes actually used are the documented ones -----------

{
  const used = new Set(
    [...runner.matchAll(/blockedReason\s*=\s*`([a-z_]+):/g)].map((m) => m[1]),
  )
  const unknown = [...used].filter((c) => !ALL_CODES.includes(c))
  check('runner: no unknown codes in use', unknown.length === 0, JSON.stringify(unknown))

  // The paths the design's §12.1 table lists must all be code-prefixed.
  for (const required of ['clarification', 'fixing', 'verifying', 'planning', 'mr_creating', 'tapd_syncing']) {
    check(`runner: uses the documented '${required}' code`, used.has(required), JSON.stringify([...used]))
  }
}

// ---- no prose-style prefixes remain in REASONS ----------------------
//
// Only blockedReason assignments are checked. Log messages legitimately
// read "Planning: zero tasks for story X" — that is prose for a human
// reading the log, not a machine-parsed reason code.

{
  const reasonTemplates = [...runner.matchAll(/blockedReason\s*=\s*`([^`]*)`/g)].map((m) => m[1])
  const banned = ['Clarification blocked:', 'Critic blocked', 'Spec blocked:', 'Planning:', 'Implementing:', 'Fixing:', 'Verifying:']
  const present = reasonTemplates.filter((t) => banned.some((b) => t.startsWith(b)))
  check('runner: no capitalised prose prefixes in blockedReason', present.length === 0, JSON.stringify(present))
}

// ---- the convention is documented where it is applied ---------------

{
  check(
    'runner: documents the reason convention',
    /Blocked \/ failed reason convention/.test(runner),
  )
  check('runner: names the stage codes in the doc', /mr_creating/.test(runner.split('*/')[0]))
}

// ---- other modules also set blockedReason ---------------------------

{
  // Tools set story.blockedReason too (e.g. auto_rd_retry's skip action).
  const toolsDir = resolve(srcRoot, 'tools')
  const offenders = []
  for (const file of readdirSync(toolsDir)) {
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(resolve(toolsDir, file), 'utf-8')
    for (const m of text.matchAll(/blockedReason\s*=\s*`([^`]*)`/g)) {
      const code = m[1].split(':')[0].trim()
      if (!ALL_CODES.includes(code)) offenders.push(`${file}: ${m[1].slice(0, 60)}`)
    }
  }
  check('tools: any blockedReason template uses a stage code', offenders.length === 0, JSON.stringify(offenders))
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nReasonCodes tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
