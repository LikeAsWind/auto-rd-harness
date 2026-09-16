/**
 * DesignLoop — the Brainstorm -> Critic -> Decision triad, grounded in
 * the repository.
 *
 * These three stages were the last templates in the pipeline. Brainstorm
 * emitted three near-identical blocks whose files were `<worktree>/src/
 * <feature>.ts`; Critic reported "no Critical findings" for all three
 * without reading them; Decision always chose `minimal` on a made-up
 * score table. The result was that the "three parallel proposals,
 * independently critiqued, then scored" design had no content flowing
 * through it.
 *
 * This module makes the triad coherent and factual:
 *
 *   buildProposals()  produces three genuinely different placements,
 *                     derived from the files that actually exist in the
 *                     worktree:
 *                       minimal — modify the nearest existing module
 *                       clean   — a new module beside its neighbours
 *                       novel   — a new module plus an explicit seam
 *                     Each proposal names REAL paths and states a
 *                     trade-off that follows from the placement (does a
 *                     similar file already exist? is the touched file
 *                     shared? how many files change?).
 *
 *   critiqueProposals() measures the proposals rather than describing
 *                     them: a spec-coverage matrix over every
 *                     acceptance criterion (CR-3 Spec Line-by-Line),
 *                     per-axis findings by severity (RC-2), and
 *                     cross-proposal comparison. Coverage is decided by
 *                     whether a proposal's declared scope covers the
 *                     criterion's category, so the matrix is
 *                     reproducible, not vibes.
 *
 *   decideFromCritique() scores each proposal on the three axes the
 *                     design names — Spec Coverage, Critical count,
 *                     Effort — from the critique's real numbers, and
 *                     applies an explicit documented tiebreaker.
 *
 * All three functions are pure and deterministic over their inputs, so
 * the three handlers can each re-derive the shared state without
 * passing objects between dispatches. That keeps the subagent
 * boundary intact (SD-2: fresh subagent per stage) while still
 * producing a coherent chain.
 *
 * What remains the model's job: judging whether a placement is
 * *architecturally* right. This module supplies the facts and the
 * scoring scaffolding; a model attached to these stages refines the
 * prose and may overrule the deterministic pick, and the ledger
 * records whichever it chose.
 */
import type { ProjectProbeResult } from './project-probe.js'
import { pickExtension, pickDir, slugify, splitAcceptanceCriteria } from './plan-builder.js'
import { classifyCriteria, type CriterionCategory } from './spec-builder.js'

export type Variation = 'minimal' | 'clean' | 'novel'

export interface Proposal {
  variation: Variation
  title: string
  /** One-paragraph approach. */
  approach: string
  /** Real relative paths this proposal would touch. */
  files: string[]
  /** Real existing files this proposal reuses, if any. */
  reuses: string[]
  /** Categories of criterion this proposal claims to cover. */
  covers: CriterionCategory[]
  tradeoffs: string[]
  yagniDropped: string[]
}

export interface CoverageRow {
  criterion: string
  category: CriterionCategory | null
  covered: Record<Variation, boolean>
}

export interface Finding {
  severity: 'Critical' | 'Important' | 'Minor'
  proposal: Variation
  detail: string
}

export interface Critique {
  coverage: CoverageRow[]
  findings: Finding[]
  /** Per-proposal counts, derived from `findings`. */
  counts: Record<Variation, { critical: number; important: number; minor: number }>
  /** Criteria no proposal covers. */
  uncovered: string[]
  systemic: string[]
}

export interface ScoreRow {
  variation: Variation
  /** criteria covered / total criteria */
  specCoverage: string
  coverageRatio: number
  critical: number
  effort: 'S' | 'M' | 'L'
  /** Higher is better. */
  total: number
}

export interface Decision {
  chosen: Variation
  scores: ScoreRow[]
  tiebreaker: string | null
  rationale: string
}

export interface DesignInput {
  storyTitle: string
  acceptanceCriteria?: string
  description?: string
}

// ---- proposals ----

/** Minimum weighted similarity to consider an existing file "the nearest". */
const NEAREST_MIN_SCORE = 0.2
/** Weight applied to tokens drawn from the story TITLE. */
const TITLE_TOKEN_WEIGHT = 3

/**
 * Build the three proposals.
 */
export function buildProposals(
  input: DesignInput,
  probe: ProjectProbeResult | null,
): Proposal[] {
  const criteria = splitAcceptanceCriteria(input.acceptanceCriteria)
  const classified = classifyCriteria(criteria)
  const allCategories: CriterionCategory[] = [
    'api', 'data', 'error', 'compat', 'security', 'exclusion',
  ]
  // A proposal claims the categories that are actually present in the
  // story; "exclusion" is never a thing to implement, so it is dropped.
  const presentCategories = allCategories.filter(
    (c) => c !== 'exclusion' && classified.byCategory[c].length > 0,
  )

  const extension = pickExtension(probe)
  const sourceDir = pickDir(probe, ['src', 'lib', 'app', 'packages', 'source'])
  const testDir = pickDir(probe, ['tests', 'test', '__tests__', 'spec', 'e2e'])
  const slug = slugify(input.storyTitle)

  const nearest = findNearestFile(input.storyTitle, input.description ?? '', probe)

  // ---- minimal ----
  const minimalFiles: string[] = []
  const minimalReuses: string[] = []
  let minimalApproach: string
  const minimalTradeoffs: string[] = []

  if (nearest) {
    minimalFiles.push(nearest.path)
    minimalReuses.push(nearest.path)
    minimalApproach =
      `Extend \`${nearest.path}\` in place. It is the closest existing module to this ` +
      `change (name similarity ${(nearest.score * 100).toFixed(0)}%), so the new behaviour ` +
      `belongs next to the code that already owns this area.`
    minimalTradeoffs.push(
      `Smallest possible diff — one file changes, so review is fast.`,
      `\`${nearest.path}\` is a ${nearest.depth}-level-deep shared module, so the change is visible to every current caller.`,
      `No new abstraction is introduced; a second similar requirement would need a follow-up refactor.`,
    )
  } else {
    const fallback = sourceDir ? `${sourceDir}/${slug}${extension}` : `${slug}${extension}`
    minimalFiles.push(fallback)
    minimalApproach =
      `No existing module is close enough to host this change, so create the smallest ` +
      `possible ${sourceDir ? `\`${sourceDir}\`` : 'root-level'} module: \`${fallback}\`.`
    minimalTradeoffs.push(
      `One new file, no existing code touched.`,
      `Nothing is reused, so the new module cannot drift from an existing convention.`,
      `No seam for future variations.`,
    )
  }
  if (testDir) minimalFiles.push(`${testDir}/${slug}.test${extension}`)

  // ---- clean ----
  const cleanDir = nearest ? dirOf(nearest.path) : (sourceDir ?? '')
  const cleanPath = cleanDir ? `${cleanDir}/${slug}${extension}` : `${slug}${extension}`
  const cleanFiles = [cleanPath]
  if (testDir) cleanFiles.push(`${testDir}/${slug}.test${extension}`)
  const cleanApproach =
    `Add a dedicated module \`${cleanPath}\`${cleanDir ? ` alongside the existing code in \`${cleanDir}/\`` : ''} ` +
    `with a single clear responsibility, leaving the current modules untouched.`
  const cleanTradeoffs = [
    `Clear ownership: the new behaviour lives in one named place.`,
    `Callers must be wired to the new module, so the diff reaches further than the minimal option.`,
    `Consistent with the surrounding directory layout${cleanDir ? ` (\`${cleanDir}/\`)` : ''}.`,
  ]

  // ---- novel ----
  const seamPath = cleanDir ? `${cleanDir}/${slug}-port${extension}` : `${slug}-port${extension}`
  const novelFiles = [cleanPath, seamPath]
  if (testDir) novelFiles.push(`${testDir}/${slug}.test${extension}`)
  const novelApproach =
    `Introduce a seam: define the behaviour behind a small interface in \`${seamPath}\` and ` +
    `implement it in \`${cleanPath}\`. Callers depend on the abstraction, so a second ` +
    `implementation (or a test double) can be added without touching call sites.`
  const novelTradeoffs = [
    `Most extensible: the seam allows alternate implementations and cheap test doubles.`,
    `Largest diff (${novelFiles.length} files) and the most new surface to review.`,
    `Introduces an abstraction before a second implementation exists — the classic speculative-generality risk.`,
  ]

  const mk = (
    variation: Variation,
    title: string,
    approach: string,
    files: string[],
    reuses: string[],
    tradeoffs: string[],
    yagniDropped: string[],
  ): Proposal => ({
    variation,
    title,
    approach,
    files,
    reuses,
    covers: presentCategories,
    tradeoffs,
    yagniDropped,
  })

  return [
    mk(
      'minimal',
      'Minimal in-place change',
      minimalApproach,
      minimalFiles,
      minimalReuses,
      minimalTradeoffs,
      nearest
        ? [`A new abstraction layer — Reason: the existing module already owns this behaviour`]
        : [`A new abstraction layer — Reason: one call site`],
    ),
    mk(
      'clean',
      'New dedicated module',
      cleanApproach,
      cleanFiles,
      [],
      cleanTradeoffs,
      [
        `An interface seam — Reason: no second implementation is planned`,
        `A configuration flag — Reason: no requirement calls for one`,
      ],
    ),
    mk(
      'novel',
      'Explicit seam + implementation',
      novelApproach,
      novelFiles,
      [],
      novelTradeoffs,
      [
        `A plugin registry — Reason: two variations do not justify a registry`,
        `A generic strategy base class — Reason: a plain function interface suffices`,
      ],
    ),
  ]
}

interface NearestFile {
  path: string
  score: number
  depth: number
}

/**
 * Find the existing source file whose name is most similar to the
 * story.
 *
 * Matching is weighted rather than a plain token overlap, because the
 * naive version fails on real tickets in two ways:
 *
 *   - The title is the most informative part of a story. A word from
 *     the title ("refund") counts TITLE_TOKEN_WEIGHT times, so
 *     `src/refunds/handler.ts` beats `src/payments/handler.ts` for a
 *     story titled "Add refund endpoint" even though the description
 *     mentions "payment" too.
 *   - "refunds" and "refund" must compare equal. Tokens are
 *     singularised (a trailing "s" is dropped for words of 4+ chars)
 *     before comparison.
 *
 * The score is the matched weight over the total available weight, so
 * a single title-word match lands around 0.2 and clears the bar, while
 * a lone description-word match does not.
 *
 * Returns null when nothing scores at or above NEAREST_MIN_SCORE.
 */
export function findNearestFile(
  storyTitle: string,
  description: string,
  probe: ProjectProbeResult | null,
): NearestFile | null {
  if (!probe || probe.sourceFiles.length === 0) return null

  const titleTokens = tokenize(storyTitle)
  const descTokens = tokenize(description)
  // Total weight available to match against.
  let totalWeight = 0
  for (const t of titleTokens) totalWeight += TITLE_TOKEN_WEIGHT
  for (const t of descTokens) if (!titleTokens.has(t)) totalWeight += 1
  if (totalWeight === 0) return null

  let best: NearestFile | null = null
  for (const path of probe.sourceFiles) {
    // Test and spec files are never a valid host for production code, so
    // they are not candidates at all. Without this, `tests/refunds.test.ts`
    // outranks `src/refunds/handler.ts` on the depth tiebreak (it is one
    // path segment shallower) and the "minimal" proposal would suggest
    // implementing the feature inside its own test file.
    if (isTestFile(path)) continue

    const base = path.split('/').pop() ?? path
    const stem = base.replace(/\.[^.]+$/, '')
    const pathTokens = tokenize(`${path.replace(/\.[^.]+$/, '')} ${stem}`)
    if (pathTokens.size === 0) continue

    let matched = 0
    for (const t of titleTokens) if (pathTokens.has(t)) matched += TITLE_TOKEN_WEIGHT
    for (const t of descTokens) {
      if (titleTokens.has(t)) continue
      if (pathTokens.has(t)) matched += 1
    }
    if (matched === 0) continue

    const score = matched / totalWeight
    if (score < NEAREST_MIN_SCORE) continue

    const depth = path.split('/').length
    // Deeper paths are more specific (src/refunds/handler.ts over
    // src/handler.ts), so they win a tie.
    if (!best || score > best.score || (score === best.score && depth > best.depth)) {
      best = { path, score, depth }
    }
  }
  return best
}

/** Test directories and `.test` / `.spec` stems. */
const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', '__mocks__'])

function isTestFile(path: string): boolean {
  const parts = path.split('/')
  const file = parts.pop() ?? ''
  if (parts.some((p) => TEST_DIR_NAMES.has(p))) return true
  return /\.(test|spec)\.[^.]+$/.test(file)
}

/**
 * Word tokens: >=3 chars, lowercased, common noise removed, and
 * singularised so "refunds" matches "refund".
 */
function tokenize(text: string): Set<string> {
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when',
    'then', 'than', 'must', 'should', 'will', 'can', 'are', 'was', 'were',
    'not', 'but', 'use', 'used', 'using', 'all', 'any', 'new', 'add',
    'adds', 'added', 'return', 'returns', 'invalid', 'valid',
  ])
  const out = new Set<string>()
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue
    if (stop.has(raw)) continue
    out.add(singularize(raw))
  }
  return out
}

/** Drop a trailing plural "s" so "refunds" and "refund" compare equal. */
function singularize(word: string): string {
  if (word.length >= 4 && word.endsWith('s') && !word.endsWith('ss')) {
    return word.slice(0, -1)
  }
  return word
}

function dirOf(path: string): string {
  const parts = path.split('/')
  parts.pop()
  return parts.join('/')
}

// ---- critique ----

/**
 * Critique the proposals: build the spec-coverage matrix and derive
 * findings from measurable properties of each proposal.
 */
export function critiqueProposals(
  proposals: Proposal[],
  input: DesignInput,
  probe: ProjectProbeResult | null,
): Critique {
  const criteria = splitAcceptanceCriteria(input.acceptanceCriteria)
  const classified = classifyCriteria(criteria)
  const existing = new Set(probe?.sourceFiles ?? [])

  // Coverage: a proposal covers a criterion when the criterion's
  // category is one the proposal claims. A criterion with no category
  // is covered by every proposal (it carries no specific obligation).
  const coverage: CoverageRow[] = criteria.map((criterion) => {
    const category = categoryOf(criterion, classified)
    const covered = {} as Record<Variation, boolean>
    for (const p of proposals) {
      covered[p.variation] = category === null ? true : p.covers.includes(category)
    }
    return { criterion, category, covered }
  })

  const findings: Finding[] = []

  for (const p of proposals) {
    // New files are expected; a proposal that names an existing file it
    // did not list as reused is an inconsistency worth flagging.
    const touchesExisting = p.files.some((f) => existing.has(f))
    if (touchesExisting && p.reuses.length === 0) {
      findings.push({
        severity: 'Important',
        proposal: p.variation,
        detail: `touches an existing file but does not declare it as reused`,
      })
    }

    // Effort shape: flag the widest proposal as Minor, the narrowest as
    // nothing (narrow is not a problem).
    if (p.files.length >= 3) {
      findings.push({
        severity: 'Minor',
        proposal: p.variation,
        detail: `touches ${p.files.length} files, the widest of the three — review cost is highest`,
      })
    }
  }

  // Coverage-based findings.
  const uncovered = coverage.filter((r) => !proposals.some((p) => r.covered[p.variation])).map((r) => r.criterion)
  for (const criterion of uncovered) {
    findings.push({
      severity: 'Critical',
      proposal: proposals[0]?.variation ?? 'minimal',
      detail: `no proposal declares scope covering this acceptance criterion: "${criterion}"`,
    })
  }

  if (proposals.length < 3) {
    findings.push({
      severity: 'Critical',
      proposal: proposals[0]?.variation ?? 'minimal',
      detail: `expected 3 proposals, received ${proposals.length}`,
    })
  }

  // Systemic: a gap shared by all three.
  const systemic: string[] = []
  for (const criterion of criteria) {
    const row = coverage.find((r) => r.criterion === criterion)
    if (row && proposals.every((p) => !row.covered[p.variation])) {
      systemic.push(criterion)
    }
  }
  if (criteria.length === 0) {
    systemic.push('the story has no acceptance criteria, so no proposal can be shown to satisfy it')
  }

  const counts = {} as Critique['counts']
  for (const p of proposals) {
    counts[p.variation] = { critical: 0, important: 0, minor: 0 }
  }
  for (const f of findings) {
    const bucket = counts[f.proposal]
    if (!bucket) continue
    if (f.severity === 'Critical') bucket.critical += 1
    else if (f.severity === 'Important') bucket.important += 1
    else bucket.minor += 1
  }

  return { coverage, findings, counts, uncovered, systemic }
}

/** The category a criterion belongs to (first match wins). */
function categoryOf(
  criterion: string,
  classified: ReturnType<typeof classifyCriteria>,
): CriterionCategory | null {
  for (const [cat, list] of Object.entries(classified.byCategory) as Array<
    [CriterionCategory, string[]]
  >) {
    if (list.includes(criterion)) return cat
  }
  return null
}

// ---- decision ----

/**
 * Score the proposals from the critique and pick one.
 *
 * Score (higher is better): coverageRatio*5 rounded, minus 2 per
 * Critical, minus 1 per Important. Effort is reported for the ledger
 * but only used as a tiebreaker, matching the design's ordering of the
 * axes (correctness before cost).
 */
export function decideFromCritique(
  proposals: Proposal[],
  critique: Critique,
  input: DesignInput,
): Decision {
  const totalCriteria = critique.coverage.length

  const scores: ScoreRow[] = proposals.map((p) => {
    const covered = critique.coverage.filter((r) => r.covered[p.variation]).length
    const ratio = totalCriteria === 0 ? 1 : covered / totalCriteria
    const c = critique.counts[p.variation] ?? { critical: 0, important: 0, minor: 0 }
    const raw = ratio * 5 - c.critical * 2 - c.important * 1
    return {
      variation: p.variation,
      specCoverage: `${covered}/${totalCriteria}`,
      coverageRatio: ratio,
      critical: c.critical,
      effort: effortOf(p),
      total: Math.round(raw * 100) / 100,
    }
  })

  // Rank: total desc, then fewer Critical, then coverage desc, then
  // effort asc, then more reuse of existing modules, then stable order.
  const effortRank: Record<ScoreRow['effort'], number> = { S: 0, M: 1, L: 2 }
  const reuseCount = (v: Variation): number =>
    proposals.find((p) => p.variation === v)?.reuses.length ?? 0
  const ranked = [...scores].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total
    if (a.critical !== b.critical) return a.critical - b.critical
    if (b.coverageRatio !== a.coverageRatio) return b.coverageRatio - a.coverageRatio
    if (effortRank[a.effort] !== effortRank[b.effort]) {
      return effortRank[a.effort] - effortRank[b.effort]
    }
    // Prefer reusing an existing module: same effort, less new surface.
    return reuseCount(b.variation) - reuseCount(a.variation)
  })

  const chosen = ranked[0]
  const runnerUp = ranked[1]

  let tiebreaker: string | null = null
  if (runnerUp && chosen.total === runnerUp.total && chosen.critical === runnerUp.critical) {
    if (chosen.coverageRatio !== runnerUp.coverageRatio) {
      tiebreaker = 'higher spec coverage'
    } else if (effortRank[chosen.effort] !== effortRank[runnerUp.effort]) {
      tiebreaker = 'least effort'
    } else if (reuseCount(chosen.variation) !== reuseCount(runnerUp.variation)) {
      tiebreaker = 'more reuse of existing modules (less new surface)'
    } else {
      tiebreaker = 'stable ordering (variations are equivalent on every axis)'
    }
  }

  const rationale =
    `\`${chosen.variation}\` scored ${chosen.total} ` +
    `(${chosen.specCoverage} criteria covered, ${chosen.critical} Critical, effort ${chosen.effort})` +
    (tiebreaker ? `, selected on ${tiebreaker}` : ', the highest score of the three') +
    `.`

  return { chosen: chosen.variation, scores, tiebreaker, rationale }
}

/** Effort from the number of files a proposal touches. */
export function effortOf(p: Proposal): 'S' | 'M' | 'L' {
  if (p.files.length <= 1) return 'S'
  if (p.files.length === 2) return 'M'
  return 'L'
}
