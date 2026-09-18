/**
 * SpecBuilder — derive a real specification from the story's own content.
 *
 * The SpecAgent sits between the Decision and Planning stages and its
 * `06-spec.md` is the contract every later stage is verified against.
 * Before this module it emitted a template whose API section was
 * `export function handle<Feature>(req: Request): Response` and whose
 * Error Contract was a made-up `ValidationError / 400` row — content
 * that had nothing to do with the story, so "does the code match the
 * spec?" was unanswerable.
 *
 * This builder extracts the structure from what the story actually
 * says. Each acceptance criterion is classified by the kind of
 * obligation it carries, and the spec's sections are populated from
 * that classification:
 *
 *   - Behavior            <- every criterion, numbered in order
 *   - API / Interface     <- criteria mentioning endpoints, methods,
 *                            requests, responses, or signatures
 *   - Data Model Changes  <- criteria mentioning schema, migrations,
 *                            columns, tables, indexes, persistence
 *   - Error Contract      <- criteria mentioning errors, rejection, or
 *                            specific HTTP status codes
 *   - Compatibility       <- criteria mentioning breaking/backward
 *                            compatibility or deprecation
 *   - Security & Privacy  <- criteria mentioning auth, tokens,
 *                            permissions, roles, PII, secrets
 *   - Non-Goals           <- criteria/description that explicitly
 *                            exclude something
 *   - Test Plan           <- the REAL planned test files and the
 *                            project's actual test command
 *
 * Where a category has no matching criterion the spec says so
 * explicitly rather than inventing content. That is deliberate: a
 * reviewer reading "no data model changes were specified" can check
 * that claim, whereas a fabricated row can only mislead.
 *
 * What remains the model's job is judgement — deciding whether the
 * story's own wording is the RIGHT design. This module produces the
 * faithful rendering of what was asked for.
 */
import type { ProjectProbeResult } from './project-probe.js'
import type { BuiltPlan } from './plan-builder.js'
import { splitAcceptanceCriteria } from './plan-builder.js'

export interface SpecStory {
  id: string
  title: string
  description: string
  acceptanceCriteria?: string
}

export type CriterionCategory =
  | 'api'
  | 'data'
  | 'error'
  | 'compat'
  | 'security'
  | 'exclusion'

export interface ClassifiedCriteria {
  /** criterion text -> the categories it matched */
  byCategory: Record<CriterionCategory, string[]>
}

export interface SpecOptions {
  /** The plan, when one was already built (drives the Test Plan). */
  plan?: BuiltPlan | null
  /** Overrides for the test command shown in the Test Plan. */
  testCommand?: string | null
}

export interface BuiltSpec {
  markdown: string
  criteria: string[]
  classified: ClassifiedCriteria
  /** Categories that had at least one matching criterion. */
  coveredCategories: CriterionCategory[]
}

/** Keyword sets per category. Matching is case-insensitive, word-bounded. */
const CATEGORY_KEYWORDS: Record<CriterionCategory, string[]> = {
  api: [
    'endpoint', 'route', 'post', 'get', 'put', 'patch', 'delete',
    'request', 'response', 'payload', 'header', 'query param',
    'function', 'method', 'interface', 'signature', 'api', 'http',
    'status code', 'returns', 'json',
  ],
  data: [
    'schema', 'migration', 'migrate', 'column', 'table', 'field',
    'index', 'database', 'db', 'persist', 'persisted', 'store', 'stored',
    'record', 'row', 'foreign key', 'constraint', 'model',
  ],
  error: [
    'error', 'invalid', 'reject', 'rejected', 'fail', 'fails', 'failure',
    'throw', 'throws', 'exception', '400', '401', '403', '404', '409',
    '422', '429', '500', '503', 'timeout', 'retry',
  ],
  compat: [
    'breaking', 'backward', 'backwards', 'compatib', 'deprecat',
    'existing client', 'existing caller', 'migration path', 'upgrade',
  ],
  security: [
    'auth', 'authoriz', 'authenticat', 'token', 'permission', 'role',
    'pii', 'encrypt', 'secret', 'sensitive', 'login', 'logout',
    'password', 'session', 'credential', 'audit',
    // NOTE: a bare "scope" is deliberately NOT a keyword. Phrases like
    // "out of scope" and "in scope" are ubiquitous in requirements and
    // have nothing to do with security, so the OAuth sense is matched
    // explicitly instead.
    'oauth scope', 'token scope',
  ],
  exclusion: [
    'out of scope', 'not required', 'no need', 'not needed', 'excluded',
    'will not', 'does not need', 'not in scope', 'unsupported',
  ],
}

/**
 * Build a spec for a story.
 */
export function buildSpec(
  story: SpecStory,
  probe: ProjectProbeResult | null,
  opts: SpecOptions = {},
): BuiltSpec {
  // AC 语义修正 (design §7): generate criteria when the story supplied
  // none. `splitCriteria` returns [] for missing raw AC, and
  // `generateAcceptanceCriteria` always produces a non-empty set, so the
  // Behavior section is never left with the "unverifiable" placeholder.
  const raw = splitCriteria(story.acceptanceCriteria)
  const criteria = raw.length > 0 ? raw : generateAcceptanceCriteria(story)
  const classified = classifyCriteria(criteria)
  const coveredCategories = (Object.keys(classified.byCategory) as CriterionCategory[]).filter(
    (c) => classified.byCategory[c].length > 0,
  )

  const markdown = renderSpec(story, probe, criteria, classified, opts)
  return { markdown, criteria, classified, coveredCategories }
}

/** Split criteria, tolerating a missing AC field. */
function splitCriteria(ac: string | undefined): string[] {
  if (!ac || ac.trim().length === 0) return []
  // Reuse the PlanBuilder splitter so the Spec and Planning stages agree
  // on criterion boundaries.
  return splitAcceptanceCriteria(ac)
}

/**
 * Derive acceptance criteria from the story's title + description when
 * none were supplied (AC 语义修正, design §7). The Spec stage is the
 * single place where criteria come into existence: a story that reaches
 * Spec with no raw AC is no longer parked at Clarification, and the
 * generated criteria become the contract the verify/review/final-verify
 * stages read from `06-spec.md`.
 *
 * The generation is deterministic and grounded in what the story
 * actually says, so a reviewer can trace every criterion back to the
 * title/description rather than a fabricated obligation:
 *
 *   1. `The change described by the story is implemented.`
 *   2. One criterion per sentence of the description (trimmed).
 *   3. A self-check that the implementation is testable.
 *
 * The description alone is authoritative; the title supplies the anchor
 * wording for the first criterion when the description is empty.
 */
export function generateAcceptanceCriteria(
  story: Pick<SpecStory, 'title' | 'description'>,
): string[] {
  const description = (story.description ?? '').trim()
  const title = (story.title ?? '').trim()

  const criteria: string[] = []
  if (title.length > 0) {
    criteria.push(`The change described by "${title}" is implemented.`)
  } else {
    criteria.push('The change described by the story is implemented.')
  }

  if (description.length > 0) {
    // One criterion per sentence; split on '.', ';', and newlines so a
    // multi-sentence description yields one checkable obligation each.
    const sentences = description
      .split(/(?<=[.;。；])\s+|\n+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    for (const sentence of sentences) {
      // Normalise trailing punctuation so a bare fragment reads as a criterion.
      const text = sentence.replace(/[.;。；]+$/u, '').trim()
      if (text.length === 0) continue
      // Avoid duplicating the anchor criterion when the description is
      // effectively just the title reworded.
      if (criteria.includes(`The change described by "${title}" is implemented.`)) {
        criteria.push(`${text}, and the result is verifiable.`)
      } else {
        criteria.push(text)
      }
    }
  }

  // Guarantee the generated set always names testability, which is what
  // the later verify stages key on.
  criteria.push('The implementation is covered by passing automated tests.')
  return criteria
}

/**
 * Classify each criterion into zero or more categories.
 */
export function classifyCriteria(criteria: string[]): ClassifiedCriteria {
  const byCategory: Record<CriterionCategory, string[]> = {
    api: [],
    data: [],
    error: [],
    compat: [],
    security: [],
    exclusion: [],
  }

  for (const criterion of criteria) {
    const lower = criterion.toLowerCase()
    for (const category of Object.keys(byCategory) as CriterionCategory[]) {
      if (CATEGORY_KEYWORDS[category].some((kw) => containsTerm(lower, kw))) {
        byCategory[category].push(criterion)
      }
    }
  }

  return { byCategory }
}

/** Word-bounded containment for single words; substring for phrases. */
function containsTerm(text: string, term: string): boolean {
  if (term.includes(' ') || term.includes('-')) return text.includes(term)
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z0-9])${escaped}`, 'i').test(text)
}

// ---- rendering ----

function renderSpec(
  story: SpecStory,
  probe: ProjectProbeResult | null,
  criteria: string[],
  classified: ClassifiedCriteria,
  opts: SpecOptions,
): string {
  const lines: string[] = []
  const testCmd =
    opts.testCommand !== undefined ? opts.testCommand : (probe?.testCommand ?? null)

  lines.push(`# Spec — ${story.title}`)
  lines.push('')

  // Context
  lines.push('## Context')
  lines.push(`- Story: \`${story.id}\``)
  if (probe) {
    lines.push(`- Branch: \`${probe.branch ?? '<detached>'}\``)
    lines.push(`- HEAD at spec time: \`${probe.headSha ?? '<none>'}\``)
    lines.push(`- Package manager: ${probe.packageManager ?? '_not detected_'}`)
    lines.push(`- Files walked: ${probe.fileCount}`)
  }
  lines.push('')

  // Goal
  lines.push('## Goal')
  lines.push(story.description.trim() || '_No description was provided._')
  lines.push('')

  // Non-Goals
  lines.push('## Non-Goals')
  const exclusions = classified.byCategory.exclusion
  if (exclusions.length > 0) {
    for (const e of exclusions) lines.push(`- ${e}`)
  } else {
    lines.push('- Anything not covered by the acceptance criteria below.')
  }
  lines.push('')

  // Behavior — criteria are ALWAYS non-empty here (raw AC split, or
  // generated from title + description when raw AC was missing).
  lines.push('## Behavior')
  if (criteria.length > 0) {
    criteria.forEach((c, i) => lines.push(`${i + 1}. ${c}`))
  } else {
    lines.push('_No acceptance criteria could be derived from the story._')
  }
  lines.push('')

  // API / Interface
  lines.push('## API or Interface')
  pushCriterionList(lines, classified.byCategory.api, 'No endpoint, request/response, or signature obligations were specified.')

  // Data Model Changes
  lines.push('## Data Model Changes')
  pushCriterionList(
    lines,
    classified.byCategory.data,
    'No schema, migration, or persistence changes were specified.',
  )

  // Error Contract
  lines.push('## Error Contract')
  if (classified.byCategory.error.length > 0) {
    lines.push('| Condition | Obligation |')
    lines.push('|-----------|------------|')
    for (const e of classified.byCategory.error) {
      lines.push(`| ${escapeCell(e)} | as specified in Behavior |`)
    }
  } else {
    lines.push('_No error, rejection, or status-code obligations were specified._')
  }
  lines.push('')

  // Test Plan
  lines.push('## Test Plan')
  lines.push(`- Run command: ${testCmd ? `\`${testCmd}\`` : '_none detected in the repository_'}`)
  if (opts.plan && opts.plan.tasks.length > 0) {
    lines.push('')
    lines.push('| Task | Test file | Source file | Criterion |')
    lines.push('|------|-----------|-------------|-----------|')
    for (const t of opts.plan.tasks) {
      lines.push(
        `| ${t.taskId} | \`${t.testFile ?? '<none>'}\` | \`${t.sourceFile ?? '<none>'}\` | ${escapeCell(t.criterion ?? t.title)} |`,
      )
    }
  } else {
    lines.push('- No plan has been built yet, so no test files are enumerated.')
  }
  lines.push('')

  // Compatibility
  lines.push('## Compatibility')
  pushCriterionList(
    lines,
    classified.byCategory.compat,
    'No breaking-change or backward-compatibility obligations were specified.',
  )

  // Security & Privacy
  lines.push('## Security & Privacy')
  pushCriterionList(
    lines,
    classified.byCategory.security,
    'No authentication, authorization, or data-sensitivity obligations were specified.',
  )

  // Open Questions
  lines.push('## Open Questions')
  lines.push('_None — see `02-clarification.md` for the gate that cleared them._')
  lines.push('')

  lines.push('[SPEC_COMPLETE]')
  return lines.join('\n')
}

function pushCriterionList(
  lines: string[],
  criteria: string[],
  emptyMessage: string,
): void {
  if (criteria.length > 0) {
    for (const c of criteria) lines.push(`- ${c}`)
  } else {
    lines.push(`_${emptyMessage}_`)
  }
  lines.push('')
}

/** Escape a value so it cannot break a markdown table row. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()
}
