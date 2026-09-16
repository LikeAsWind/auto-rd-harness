// DesignLoop tests — Brainstorm proposals, Critic coverage, Decision scoring.
//
// Covers:
//   - buildProposals produces three genuinely different placements
//   - the minimal proposal finds and reuses the nearest existing file
//   - file paths are real relative paths, never <feature> placeholders
//   - critiqueProposals builds a reproducible coverage matrix
//   - uncovered criteria become Critical findings
//   - decideFromCritique scores from the critique's real numbers
//   - the tiebreaker is reported when total+critical tie
//   - the three functions are deterministic (same input -> same output),
//     which is what lets three separate subagent dispatches agree
//
// Run with: node scripts/test-design-loop.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const {
  buildProposals,
  critiqueProposals,
  decideFromCritique,
  findNearestFile,
  effortOf,
} = await import(pathToFileURL(resolve(libBase, 'services', 'design-loop.js')).href)

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

function probeWith(files = [], over = {}) {
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
    languageBreakdown: { '.ts': files.filter((f) => f.endsWith('.ts')).length || 1 },
    fileCount: files.length,
    sourceFiles: files,
    walkTruncated: false,
    ...over,
  }
}

const REFUND_STORY = {
  storyTitle: 'Add refund endpoint',
  description: 'Expose a POST endpoint that records a refund against an existing payment.',
  acceptanceCriteria:
    '1. POST /refunds with a valid payment id returns 201 and persists the refund\n' +
    '2. POST /refunds with an unknown payment id returns 404',
}

const REFUND_PROBE = probeWith([
  'src/refunds/handler.ts',
  'src/refunds/store.ts',
  'src/payments/handler.ts',
  'tests/refunds.test.ts',
  'package.json',
])

// ---- findNearestFile ---------------------------------------------

{
  const n = findNearestFile(
    'Add refund endpoint',
    'Expose a POST endpoint that records a refund',
    REFUND_PROBE,
  )
  check('findNearestFile: finds a refunds module', n !== null && /refunds/.test(n.path), JSON.stringify(n))
  check(
    'findNearestFile: picks the source module, not the test file',
    n !== null && n.path === 'src/refunds/handler.ts',
    JSON.stringify(n),
  )
  check('findNearestFile: score clears the 0.2 threshold', n !== null && n.score >= 0.2, String(n?.score))
}

{
  const n = findNearestFile('Completely unrelated widget', 'Nothing matches here at all', REFUND_PROBE)
  check('findNearestFile: returns null when nothing matches', n === null, JSON.stringify(n))
}

{
  check('findNearestFile: null probe -> null', findNearestFile('x', 'y', null) === null)
  check('findNearestFile: empty file list -> null', findNearestFile('x', 'y', probeWith([])) === null)
}

// ---- buildProposals ----------------------------------------------

{
  const proposals = buildProposals(REFUND_STORY, REFUND_PROBE)
  check('buildProposals: exactly 3 variations', proposals.length === 3, String(proposals.length))
  check(
    'buildProposals: variations are minimal/clean/novel',
    proposals.map((p) => p.variation).join(',') === 'minimal,clean,novel',
    proposals.map((p) => p.variation).join(','),
  )
  check(
    'buildProposals: approaches differ from each other',
    new Set(proposals.map((p) => p.approach)).size === 3,
  )
  check(
    'buildProposals: file lists are not all identical',
    new Set(proposals.map((p) => p.files.join('|'))).size > 1,
    JSON.stringify(proposals.map((p) => p.files)),
  )
  check(
    'buildProposals: no <feature> placeholder anywhere',
    !proposals.some((p) => p.files.some((f) => /<|>/.test(f))),
    JSON.stringify(proposals.map((p) => p.files)),
  )
  check(
    'buildProposals: minimal reuses the nearest existing file',
    proposals[0].reuses.length === 1 && /src\/refunds\//.test(proposals[0].reuses[0]),
    JSON.stringify(proposals[0].reuses),
  )
  check(
    'buildProposals: clean and novel declare no reuse',
    proposals[1].reuses.length === 0 && proposals[2].reuses.length === 0,
  )
  check(
    'buildProposals: every proposal claims the story categories',
    proposals.every((p) => p.covers.includes('api') && p.covers.includes('error')),
    JSON.stringify(proposals.map((p) => p.covers)),
  )
  check(
    'buildProposals: exclusion is never claimed',
    proposals.every((p) => !p.covers.includes('exclusion')),
  )
  check(
    'buildProposals: every proposal states trade-offs',
    proposals.every((p) => p.tradeoffs.length >= 3),
  )
  check(
    'buildProposals: every proposal drops something on YAGNI grounds',
    proposals.every((p) => p.yagniDropped.length >= 1),
  )
  check(
    'buildProposals: novel touches more files than minimal',
    proposals[2].files.length > proposals[0].files.length,
    `${proposals[2].files.length} vs ${proposals[0].files.length}`,
  )
}

{
  // No probe at all — must still produce valid proposals.
  const proposals = buildProposals(REFUND_STORY, null)
  check('buildProposals: null probe still yields 3 proposals', proposals.length === 3)
  check(
    'buildProposals: null probe gives no reuse',
    proposals.every((p) => p.reuses.length === 0),
  )
  check(
    'buildProposals: null probe still has real paths',
    proposals.every((p) => p.files.length >= 1 && p.files.every((f) => f.length > 0)),
    JSON.stringify(proposals.map((p) => p.files)),
  )
}

// ---- effortOf -----------------------------------------------------

{
  check('effortOf: 1 file -> S', effortOf({ files: ['a'] }) === 'S')
  check('effortOf: 2 files -> M', effortOf({ files: ['a', 'b'] }) === 'M')
  check('effortOf: 3 files -> L', effortOf({ files: ['a', 'b', 'c'] }) === 'L')
}

// ---- critiqueProposals -------------------------------------------

{
  const proposals = buildProposals(REFUND_STORY, REFUND_PROBE)
  const critique = critiqueProposals(proposals, REFUND_STORY, REFUND_PROBE)

  check('critique: one coverage row per criterion', critique.coverage.length === 2, String(critique.coverage.length))
  check(
    'critique: coverage row records the category',
    critique.coverage[0].category === 'api' || critique.coverage[0].category === 'error',
    JSON.stringify(critique.coverage.map((r) => r.category)),
  )
  check(
    'critique: every criterion is covered by at least one proposal',
    critique.coverage.every((r) => Object.values(r.covered).some(Boolean)),
    JSON.stringify(critique.coverage),
  )
  check(
    'critique: per-proposal counts exist for all three',
    Object.keys(critique.counts).length === 3,
    JSON.stringify(Object.keys(critique.counts)),
  )
  check('critique: uncovered is empty for a reachable story', critique.uncovered.length === 0, JSON.stringify(critique.uncovered))
  check('critique: systemic is empty for a reachable story', critique.systemic.length === 0, JSON.stringify(critique.systemic))
}

{
  // A story with no criteria: the critique must call that out as systemic.
  const story = { storyTitle: 'Vague', description: 'A description long enough to matter.' }
  const proposals = buildProposals(story, REFUND_PROBE)
  const critique = critiqueProposals(proposals, story, REFUND_PROBE)
  check('critique: zero criteria -> systemic gap reported', critique.systemic.length === 1, JSON.stringify(critique.systemic))
  check('critique: zero criteria -> coverage empty', critique.coverage.length === 0)
  check(
    'critique: zero criteria -> no Critical coverage findings (nothing to miss)',
    critique.findings.filter((f) => f.severity === 'Critical').length === 0,
    JSON.stringify(critique.findings),
  )
}

{
  // A proposal that touches an existing file without declaring reuse
  // must be flagged Important.
  const proposals = [
    { variation: 'minimal', title: 't', approach: 'a', files: ['src/refunds/handler.ts'], reuses: [], covers: ['api'], tradeoffs: ['x'], yagniDropped: ['y'] },
    { variation: 'clean', title: 't', approach: 'a', files: ['src/x.ts'], reuses: [], covers: ['api'], tradeoffs: ['x'], yagniDropped: ['y'] },
    { variation: 'novel', title: 't', approach: 'a', files: ['src/x.ts', 'src/y.ts', 'src/z.ts'], reuses: [], covers: ['api'], tradeoffs: ['x'], yagniDropped: ['y'] },
  ]
  const critique = critiqueProposals(proposals, REFUND_STORY, REFUND_PROBE)
  check(
    'critique: undeclared reuse of an existing file -> Important finding',
    critique.findings.some((f) => f.severity === 'Important' && f.proposal === 'minimal'),
    JSON.stringify(critique.findings),
  )
  check(
    'critique: widest proposal gets a Minor effort finding',
    critique.findings.some((f) => f.severity === 'Minor' && f.proposal === 'novel'),
    JSON.stringify(critique.findings),
  )
}

{
  // Fewer than 3 proposals is a Critical.
  const proposals = buildProposals(REFUND_STORY, REFUND_PROBE).slice(0, 1)
  const critique = critiqueProposals(proposals, REFUND_STORY, REFUND_PROBE)
  check(
    'critique: fewer than 3 proposals -> Critical finding',
    critique.findings.some((f) => f.severity === 'Critical' && /expected 3 proposals/.test(f.detail)),
    JSON.stringify(critique.findings),
  )
}

// ---- decideFromCritique ------------------------------------------

{
  const proposals = buildProposals(REFUND_STORY, REFUND_PROBE)
  const critique = critiqueProposals(proposals, REFUND_STORY, REFUND_PROBE)
  const decision = decideFromCritique(proposals, critique, REFUND_STORY)

  check(
    'decide: chosen is one of the variations',
    ['minimal', 'clean', 'novel'].includes(decision.chosen),
    decision.chosen,
  )
  check('decide: three score rows', decision.scores.length === 3, String(decision.scores.length))
  check(
    'decide: spec coverage is expressed as n/n',
    decision.scores.every((s) => /^\d+\/\d+$/.test(s.specCoverage)),
    JSON.stringify(decision.scores.map((s) => s.specCoverage)),
  )
  check(
    'decide: effort labels are S/M/L',
    decision.scores.every((s) => ['S', 'M', 'L'].includes(s.effort)),
    JSON.stringify(decision.scores.map((s) => s.effort)),
  )
  check(
    'decide: the chosen row has the maximum total',
    decision.scores.find((s) => s.variation === decision.chosen).total ===
      Math.max(...decision.scores.map((s) => s.total)),
    JSON.stringify(decision.scores),
  )
  check('decide: rationale names the chosen variation', decision.rationale.includes(decision.chosen), decision.rationale)
  check(
    'decide: rationale quotes the score',
    /scored \d/.test(decision.rationale),
    decision.rationale,
  )
  check(
    'decide: all three proposals share the same coverage here',
    new Set(decision.scores.map((s) => s.specCoverage)).size === 1,
    JSON.stringify(decision.scores.map((s) => s.specCoverage)),
  )
  // minimal and clean tie on total, Critical, coverage, AND effort
  // (both touch 2 files). The next principled discriminator is reuse:
  // minimal modifies a module that already exists, so it carries less
  // new surface than clean's brand-new module.
  check(
    'decide: with everything tied the tiebreaker prefers reuse over new surface',
    decision.chosen === 'minimal' &&
      decision.tiebreaker === 'more reuse of existing modules (less new surface)',
    `chosen=${decision.chosen} tiebreaker=${decision.tiebreaker}`,
  )
}

{
  // A Critical on the otherwise-best proposal must demote it.
  const proposals = buildProposals(REFUND_STORY, REFUND_PROBE)
  const critique = critiqueProposals(proposals, REFUND_STORY, REFUND_PROBE)
  // Force a Critical onto the minimal proposal.
  critique.findings.push({ severity: 'Critical', proposal: 'minimal', detail: 'forced' })
  critique.counts.minimal.critical += 1

  const decision = decideFromCritique(proposals, critique, REFUND_STORY)
  check(
    'decide: a Critical demotes the leading proposal',
    decision.chosen !== 'minimal',
    `chosen=${decision.chosen}`,
  )
  check(
    'decide: the demoted proposal scores lower',
    decision.scores.find((s) => s.variation === 'minimal').total <
      decision.scores.find((s) => s.variation === decision.chosen).total,
    JSON.stringify(decision.scores),
  )
}

// ---- Determinism -------------------------------------------------

{
  const a1 = buildProposals(REFUND_STORY, REFUND_PROBE)
  const a2 = buildProposals(REFUND_STORY, REFUND_PROBE)
  check(
    'determinism: buildProposals is stable across calls',
    JSON.stringify(a1) === JSON.stringify(a2),
  )

  const c1 = critiqueProposals(a1, REFUND_STORY, REFUND_PROBE)
  const c2 = critiqueProposals(a2, REFUND_STORY, REFUND_PROBE)
  check('determinism: critiqueProposals is stable', JSON.stringify(c1) === JSON.stringify(c2))

  const d1 = decideFromCritique(a1, c1, REFUND_STORY)
  const d2 = decideFromCritique(a2, c2, REFUND_STORY)
  // rationale embeds no timestamp, so the whole object must match.
  check('determinism: decideFromCritique is stable', JSON.stringify(d1) === JSON.stringify(d2))
}

// ---- Summary ------------------------------------------------------

process.stdout.write(`\nDesignLoop tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
