/**
 * Clarify — deterministic ambiguity detection for a Story.
 *
 * The ClarificationAgent is the pipeline's HARD-GATE (pattern B-4): it
 * is the one stage allowed to stop the automation and demand a human
 * answer. Before this module the handler unconditionally reported
 * "CLASSIFICATION: bounded, zero open questions", so the gate could
 * never close and a genuinely underspecified story would flow straight
 * through to Brainstorm and Implementation carrying the ambiguity.
 *
 * This module decides the classification from what the story actually
 * says. It looks for the failure modes that make an automated pipeline
 * produce the wrong thing:
 *
 *   1. No acceptance criteria at all — nothing to verify against.
 *   2. A description too short to act on.
 *   3. A criterion containing a vague term ("etc", "as needed",
 *      "handle errors properly", "improve performance"). These are the
 *      classic unverifiable requirements: the agent will pick an
 *      interpretation and nobody can say it was wrong.
 *   4. A criterion too short to be testable.
 *
 * The output drives the sentinel contract:
 *   - zero blocking findings -> [CLARIFICATION_COMPLETE] -> brainstorm
 *   - any blocking finding   -> [CLARIFICATION_BLOCKED]  -> blocked
 *
 * The vague-term list is deliberately conservative. A false positive
 * costs one human question; a false negative costs a wrong
 * implementation discovered at review time.
 */
import { splitAcceptanceCriteria } from './plan-builder.js'

export type ClarificationFindingKind =
  | 'missing_acceptance_criteria'
  | 'short_description'
  | 'vague_acceptance_criterion'
  | 'untestable_criterion'

export interface ClarificationFinding {
  kind: ClarificationFindingKind
  /** The question to put to the user. */
  question: string
  /** Why the detector flagged this. */
  detail: string
  /** The criterion this concerns, when applicable. */
  criterion?: string
}

export interface ClarificationResult {
  classification: 'bounded' | 'unbounded'
  /** Findings that MUST be answered before the pipeline continues. */
  blocking: ClarificationFinding[]
  /** Findings worth surfacing but not gating. */
  advisory: ClarificationFinding[]
  /** The parsed acceptance criteria. */
  criteria: string[]
  /** The vague terms actually matched, for the report. */
  vagueTerms: string[]
}

export interface ClarifyOptions {
  /** Descriptions shorter than this are considered unactionable. */
  minDescriptionLength?: number
  /** Criteria shorter than this are considered untestable. */
  minCriterionLength?: number
  /** More criteria than this is advisory (the plan will be large). */
  maxAdvisoryCriteria?: number
}

const DEFAULT_MIN_DESCRIPTION = 20
const DEFAULT_MIN_CRITERION = 12
const DEFAULT_MAX_CRITERIA = 10

/**
 * Terms that signal an unverifiable requirement. Matched
 * case-insensitively on word boundaries where practical.
 *
 * Grouped by the kind of vagueness so the report can explain itself.
 */
const VAGUE_TERMS: string[] = [
  // Explicit deferral
  'tbd',
  'to be determined',
  'to be decided',
  'as needed',
  'as appropriate',
  'if possible',
  'if necessary',
  'nice to have',
  'maybe',
  'somehow',
  'eventually',
  // Open-ended enumeration
  'etc',
  'etc.',
  'and so on',
  'and so forth',
  'and more',
  'misc',
  'various',
  'several',
  'other things',
  // Unmeasurable quality words
  'properly',
  'appropriately',
  'correctly',
  'reasonable',
  'robust',
  'flexible',
  'efficient',
  'efficiently',
  'fast',
  'faster',
  'better',
  'improve',
  'improved',
  'optimize',
  'optimized',
  'clean up',
  'cleanup',
  'refactor',
  'user-friendly',
  'intuitive',
  'seamless',
  'modern',
  'good',
  'nice',
]

/**
 * Decide whether a story is bounded (automation can proceed) or
 * unbounded (a human must answer first).
 */
export function clarifyStory(
  story: { title?: string; description?: string; acceptanceCriteria?: string },
  opts: ClarifyOptions = {},
): ClarificationResult {
  const minDescription = opts.minDescriptionLength ?? DEFAULT_MIN_DESCRIPTION
  const minCriterion = opts.minCriterionLength ?? DEFAULT_MIN_CRITERION
  const maxCriteria = opts.maxAdvisoryCriteria ?? DEFAULT_MAX_CRITERIA

  const blocking: ClarificationFinding[] = []
  const advisory: ClarificationFinding[] = []
  const vagueTerms: string[] = []

  const description = (story.description ?? '').trim()
  const criteria = splitAcceptanceCriteria(story.acceptanceCriteria)

  // 1. Acceptable criteria present at all?
  //
  // NO LONGER a hard gate (AC 语义修正, design §7). A story with zero
  // supplied acceptance criteria is NOT parked here — the Spec stage
  // generates the criteria from `title + description + selected
  // proposal` into `06-spec.md`, and the verify/review/final-verify
  // stages read those GENERATED criteria instead of the raw
  // `story.acceptanceCriteria`. Missing raw AC is recorded as advisory
  // so the ledger still shows it, but it no longer blocks progression.
  if (criteria.length === 0) {
    advisory.push({
      kind: 'missing_acceptance_criteria',
      question: 'No acceptance criteria were supplied — they will be generated at the spec stage.',
      detail:
        'The spec stage derives acceptance criteria from the title, description, and the selected design proposal. Verification then runs against those generated criteria.',
    })
  }

  // 2. Description actionable?
  if (description.length === 0) {
    blocking.push({
      kind: 'short_description',
      question: 'What should this change actually do?',
      detail: 'The story has no description.',
    })
  } else if (description.length < minDescription) {
    blocking.push({
      kind: 'short_description',
      question: `Can you expand the description? It is only ${description.length} characters.`,
      detail: `Descriptions shorter than ${minDescription} characters rarely carry enough intent to implement safely.`,
    })
  }

  // 3 + 4. Per-criterion checks.
  for (const criterion of criteria) {
    const lower = criterion.toLowerCase()

    // Vague term scan — whole-word-ish matching avoids flagging
    // "goodness" for "good" while still catching "good enough".
    const matches = VAGUE_TERMS.filter((term) => containsTerm(lower, term))
    if (matches.length > 0) {
      for (const m of matches) if (!vagueTerms.includes(m)) vagueTerms.push(m)
      blocking.push({
        kind: 'vague_acceptance_criterion',
        criterion,
        question: `How should "${criterion}" be verified? It contains the vague term "${matches.join('", "')}".`,
        detail:
          'An automated pipeline will pick one interpretation of a vague requirement, and no reviewer can then call it wrong. Replace it with an observable, checkable condition.',
      })
      continue
    }

    if (criterion.length < minCriterion) {
      blocking.push({
        kind: 'untestable_criterion',
        criterion,
        question: `What does "${criterion}" mean concretely?`,
        detail: `Criteria shorter than ${minCriterion} characters are usually not testable.`,
      })
    }
  }

  // Advisory: a very large story plans poorly as one unit.
  if (criteria.length > maxCriteria) {
    advisory.push({
      kind: 'untestable_criterion',
      question: `This story has ${criteria.length} acceptance criteria — should it be split?`,
      detail: `More than ${maxCriteria} criteria produces a long plan and a large diff to review in one pass.`,
    })
  }

  return {
    classification: blocking.length === 0 ? 'bounded' : 'unbounded',
    blocking,
    advisory,
    criteria,
    vagueTerms,
  }
}

/**
 * True when `term` appears in `text` bounded by non-word characters
 * (or string edges). Multi-word terms are matched literally.
 */
function containsTerm(text: string, term: string): boolean {
  if (term.includes(' ') || term.endsWith('.')) {
    return text.includes(term)
  }
  // Escape regex metacharacters in the term (e.g. "user-friendly").
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)
}
