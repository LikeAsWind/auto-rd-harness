/**
 * ResolutionBuilder — deterministic arbiter for clarification questions.
 *
 * The Resolution role sits between `clarification` and `brainstorm`. The
 * Clarification role only ASKS (it emits open questions and a sentinel);
 * the Resolution role ANSWERS so the pipeline can proceed unattended
 * (design decision: full-auto "B" — resolve by recorded assumption, not
 * by parking the story).
 *
 * The model-backed path resolves each question with real judgement. This
 * module is the DETERMINISTIC fallback (the "advance without a model"
 * guarantee): it cannot judge intent, so it resolves every question with
 * the only defensible choice a non-model can make — "the story's own
 * wording is the full obligation, read literally". It records that
 * explicitly rather than pretending to have picked a smarter reading.
 *
 * The output is `02b-resolution.md`: a `## Decisions` table (one row per
 * resolved question, with Ambiguity / Chosen / Why / Downstream) plus a
 * `## Resolved Acceptance Criteria` list that flows into downstream
 * verification. Nothing is resolved silently.
 */
import type { ClarificationFinding } from './clarify.js'

export interface ResolutionDecision {
  /** 1-based index matching the question order in `02-clarification.md`. */
  index: number
  /** The ambiguity the finding flagged. */
  ambiguity: string
  /** The chosen reading. */
  chosen: string
  /** Why this reading is defensible. */
  why: string
  /** What changes downstream because of this choice. */
  downstream: string
}

export interface ResolutionResult {
  markdown: string
  decisions: ResolutionDecision[]
  /** Testable conditions derived from the resolutions. */
  resolvedCriteria: string[]
  /** Questions that could not be resolved (deterministic path: none). */
  unresolved: string[]
}

/**
 * Deterministic resolution for one finding kind. The policy is uniformly
 * "least invention": read the story's own wording literally, never add a
 * requirement, and say plainly that a deterministic resolver cannot judge
 * the intended SLO so it kept the literal words.
 */
function resolveFinding(f: ClarificationFinding, index: number): ResolutionDecision {
  switch (f.kind) {
    case 'vague_acceptance_criterion':
      return {
        index,
        ambiguity: f.question,
        chosen: `Interpret "${f.criterion ?? ''}" literally — drop the vague qualifier and treat the rest of the wording as the obligation.`,
        why: 'A deterministic resolver cannot judge the intended threshold; the least-invention reading keeps the requirement\u2019s literal words.',
        downstream: 'The spec stage renders this wording as a testable acceptance criterion; verification asserts it verbatim.',
      }
    case 'untestable_criterion':
      return {
        index,
        ambiguity: f.question,
        chosen: `Treat "${f.criterion ?? ''}" exactly as written as the full obligation.`,
        why: 'The criterion is too short to expand without inventing; the literal reading is the only defensible choice.',
        downstream: 'The spec stage renders it as an acceptance criterion; review may flag it as weak.',
      }
    case 'short_description':
      return {
        index,
        ambiguity: f.question,
        chosen: 'Treat the supplied description as the complete intent.',
        why: 'A deterministic resolver treats the story\u2019s own description as authoritative rather than inventing missing detail.',
        downstream: 'Brainstorm grounds all three proposals in this description as written.',
      }
    default:
      return {
        index,
        ambiguity: f.question,
        chosen: 'Treat the story\u2019s own wording literally.',
        why: 'Fallback for an unrecognised finding kind.',
        downstream: 'Downstream stages consume the wording as written.',
      }
  }
}

export interface ResolutionInput {
  title: string
  description: string
  acceptanceCriteria?: string
}

/**
 * Build the deterministic resolution artifact from the story and the
 * blocking findings the Clarification stage already produced.
 *
 * `findings` is the `blocking` list from `clarifyStory(...)`. The builder
 * resolves every finding (deterministic path never leaves a question open —
 * it records the literal-reading assumption instead).
 */
export function buildResolution(
  input: ResolutionInput,
  findings: ClarificationFinding[],
): ResolutionResult {
  const decisions = findings.map((f, i) => resolveFinding(f, i + 1))

  const resolvedCriteria = findings
    .filter((f) => typeof f.criterion === 'string' && f.criterion.length > 0)
    .map((f) => f.criterion as string)

  // A short-description finding has no criterion to carry forward; the
  // description itself is the resolved scope.
  if (
    findings.some((f) => f.kind === 'short_description') &&
    (input.description ?? '').trim().length > 0
  ) {
    resolvedCriteria.unshift(`Implement the change described by: ${input.description.trim()}`)
  }

  const decisionRows =
    decisions.length > 0
      ? decisions
          .map(
            (d) =>
              `| ${d.index} | ${escapeCell(d.ambiguity)} | ${escapeCell(d.chosen)} | ${escapeCell(d.why)} | ${escapeCell(d.downstream)} |`,
          )
          .join('\n')
      : '| _none_ | _no open questions_ | — | — | — |'

  const criteriaLines =
    resolvedCriteria.length > 0
      ? resolvedCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
      : '_none — no criteria to carry forward_'

  const markdown = [
    `# Resolution — ${input.title}`,
    ``,
    `## Decisions`,
    `| # | Ambiguity | Chosen | Why | Downstream |`,
    `|---|-----------|--------|-----|------------|`,
    decisionRows,
    ``,
    `## Resolved Acceptance Criteria`,
    criteriaLines,
    ``,
    `## Unresolved`,
    `_None._`,
    ``,
    `## Handoff`,
    `Brainstorm must ground all three proposals in the decisions above and the resolved acceptance criteria.`,
    ``,
    `[RESOLUTION_COMPLETE]`,
  ].join('\n')

  return { markdown, decisions, resolvedCriteria, unresolved: [] }
}

/** Escape a value so it cannot break a markdown table row. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
}
