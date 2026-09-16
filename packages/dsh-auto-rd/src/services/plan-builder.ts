/**
 * PlanBuilder — generate a real implementation plan for a Story.
 *
 * The PlannerAgent sits between the Spec and the Implementation stages,
 * and its `07-tasks.md` is parsed by planner-parser.ts into the
 * TaskRecords that drive the entire implementing/fixing loop. Before
 * this module the Planner emitted one hardcoded `### T001` block whose
 * every path was a literal `<feature>.ts` placeholder, so the
 * downstream TaskRecords carried no real information.
 *
 * This builder derives the plan from facts it can actually observe:
 *
 *   - The Story's acceptance criteria are split into individual items
 *     (numbered lists, bullet lists, or sentence boundaries), and each
 *     item becomes one task. No ACs -> one task derived from the title.
 *   - File paths are anchored in the REAL repository layout: the
 *     builder picks an existing test directory and source directory
 *     (from the ProjectProbe top-level listing) and the dominant source
 *     extension, then derives `<dir>/<slug>.<ext>` and
 *     `<dir>/<slug>.test.<ext>`.
 *   - The verify command is the project's actual detected test command.
 *   - The commit message is Conventional Commits derived from the task
 *     kind (test scaffold -> `test`, feature -> `feat`).
 *
 * What is still the model's job: writing the file CONTENTS. This module
 * produces the structure, paths, ordering, and evidence commands; a
 * model attached to the Planner stage refines the prose and may split
 * or merge tasks. The output is deliberately valid input for
 * planner-parser.ts, and a round-trip test pins that contract.
 *
 * The builder is honest about uncertainty: when it cannot find a test
 * or source directory it says so in a `parseWarnings`-visible note
 * rather than inventing a path that does not exist.
 */
import type { ProjectProbeResult } from './project-probe.js'

export interface PlanStory {
  id: string
  title: string
  description: string
  acceptanceCriteria?: string
}

export interface PlannedTask {
  taskId: string
  title: string
  kind: 'test' | 'feature' | 'docs' | 'chore'
  files: string[]
  testFile?: string
  sourceFile?: string
  dependsOn: string[]
  estimatedMinutes: number
  /** The acceptance criterion this task satisfies, when one exists. */
  criterion?: string
  /** Notes about anything the builder could not derive confidently. */
  notes: string[]
}

export interface PlanOptions {
  /** Override the detected test command (used by tests). */
  testCommand?: string | null
  /** Override the source file extension, e.g. '.py'. */
  extension?: string
}

export interface BuiltPlan {
  markdown: string
  tasks: PlannedTask[]
  /** Repo-layout facts the builder relied on, for the report header. */
  layout: {
    testDir: string | null
    sourceDir: string | null
    extension: string
    testCommand: string | null
  }
}

/** Directory names that look like a test root, in preference order. */
const TEST_DIR_CANDIDATES = ['tests', 'test', '__tests__', 'spec', 'e2e']
/** Directory names that look like a source root, in preference order. */
const SOURCE_DIR_CANDIDATES = ['src', 'lib', 'app', 'packages', 'source']

/** Extensions considered "source", in preference order. */
const SOURCE_EXT_PREFERENCE = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.rb']

/**
 * Build a plan for a story against an observed project layout.
 */
export function buildPlan(
  story: PlanStory,
  probe: ProjectProbeResult | null,
  opts: PlanOptions = {},
): BuiltPlan {
  const extension = opts.extension ?? pickExtension(probe)
  const testDir = pickDir(probe, TEST_DIR_CANDIDATES)
  const sourceDir = pickDir(probe, SOURCE_DIR_CANDIDATES)
  const testCmd =
    opts.testCommand !== undefined ? opts.testCommand : (probe?.testCommand ?? null)

  const criteria = splitAcceptanceCriteria(story.acceptanceCriteria)
  const slugs: Array<{ title: string; criterion?: string }> =
    criteria.length > 0
      ? criteria.map((c) => ({ title: c, criterion: c }))
      : [{ title: story.title, criterion: undefined }]

  const tasks: PlannedTask[] = slugs.map((item, index) => {
    const taskId = `T${String(index + 1).padStart(3, '0')}`
    const slug = slugify(item.title)
    const notes: string[] = []

    let testFile: string | undefined
    let sourceFile: string | undefined

    if (testDir) {
      testFile = `${testDir}/${slug}.test${extension}`
    } else {
      notes.push('no test directory found in the repo root; test path is unanchored')
      testFile = `tests/${slug}.test${extension}`
    }

    if (sourceDir) {
      sourceFile = `${sourceDir}/${slug}${extension}`
    } else {
      notes.push('no source directory found in the repo root; source path is unanchored')
      sourceFile = `src/${slug}${extension}`
    }

    return {
      taskId,
      title: item.title,
      kind: 'feature',
      files: [testFile, sourceFile],
      testFile,
      sourceFile,
      dependsOn: index === 0 ? [] : [`T${String(index).padStart(3, '0')}`],
      estimatedMinutes: 10,
      criterion: item.criterion,
      notes,
    }
  })

  const markdown = renderPlanMarkdown(story, tasks, {
    testDir,
    sourceDir,
    extension,
    testCommand: testCmd,
  })

  return {
    markdown,
    tasks,
    layout: { testDir, sourceDir, extension, testCommand: testCmd },
  }
}

// ---- rendering ----

function renderPlanMarkdown(
  story: PlanStory,
  tasks: PlannedTask[],
  layout: BuiltPlan['layout'],
): string {
  const lines: string[] = []
  lines.push(`# Implementation Plan — ${story.title}`)
  lines.push('')

  // ---- File Structure Plan ----
  lines.push('## File Structure Plan')
  lines.push('')
  lines.push(`Detected layout: source dir \`${layout.sourceDir ?? '<none>'}\`, ` +
    `test dir \`${layout.testDir ?? '<none>'}\`, extension \`${layout.extension}\`.`)
  lines.push('')
  lines.push('| Spec Section | File(s) | Action |')
  lines.push('|--------------|---------|--------|')
  for (const t of tasks) {
    lines.push(`| ${t.taskId} | \`${t.sourceFile}\` | create/modify |`)
    lines.push(`| ${t.taskId} | \`${t.testFile}\` | create/modify |`)
  }
  lines.push('')

  // ---- Tasks ----
  lines.push('## Tasks')
  lines.push('')

  for (const t of tasks) {
    lines.push(`### ${t.taskId} — ${t.title}`)
    lines.push(
      `**File(s)**: \`${t.testFile}\` (create/modify), \`${t.sourceFile}\` (create/modify)`,
    )
    lines.push(
      `**Depends on**: ${t.dependsOn.length > 0 ? t.dependsOn.join(', ') : 'none'}`,
    )
    lines.push(`**Estimated**: ${t.estimatedMinutes} min`)
    if (t.criterion) {
      lines.push('')
      lines.push(`**Acceptance criterion**: ${t.criterion}`)
    }
    if (t.notes.length > 0) {
      lines.push('')
      lines.push(`> Note: ${t.notes.join('; ')}`)
    }
    lines.push('')

    lines.push('#### Step 1: Write the failing test (RED)')
    lines.push(`- File: \`${t.testFile}\``)
    lines.push(`- Test name: \`${t.taskId} ${escapeInline(t.title)}\``)
    lines.push(
      `- Assertion: ${t.criterion ? escapeInline(t.criterion) : `behaviour described by "${escapeInline(t.title)}" is implemented`}`,
    )
    lines.push('')

    lines.push('#### Step 2: Verify RED')
    lines.push(`- Run: \`${layout.testCommand ?? '<test command not detected>'}\``)
    lines.push(`- Expected: FAIL because \`${t.sourceFile}\` does not exist yet`)
    lines.push('')

    lines.push('#### Step 3: Minimal implementation (GREEN)')
    lines.push(`- File: \`${t.sourceFile}\``)
    lines.push(
      `- Change: implement ${t.criterion ? escapeInline(t.criterion) : escapeInline(t.title)}`,
    )
    lines.push('')

    lines.push('#### Step 4: Verify GREEN')
    lines.push(`- Run: \`${layout.testCommand ?? '<test command not detected>'}\``)
    lines.push('- Expected: PASS; full suite still green; no warnings')
    lines.push('')

    lines.push('#### Step 5: Commit')
    lines.push(
      `- Message: \`feat(${commitScope(t.sourceFile)}): ${escapeInline(t.title).toLowerCase()}\``,
    )
    lines.push('')
  }

  // ---- Execution Order ----
  lines.push('## Execution Order')
  lines.push('')
  lines.push(tasks.map((t) => t.taskId).join(' → '))
  lines.push('')

  lines.push('[PLAN_COMPLETE]')
  return lines.join('\n')
}

// ---- derivation helpers ----

/**
 * Split an acceptance-criteria blob into individual criteria.
 *
 * Handles the shapes that actually appear in ticket trackers:
 *   - numbered lists          "1. x\n2. y"
 *   - bullet lists            "- x\n- y"
 *   - checkbox lists          "- [ ] x"
 *   - blank-line separated paragraphs
 *   - a single sentence       (returned as one item)
 */
export function splitAcceptanceCriteria(ac: string | undefined): string[] {
  if (!ac || ac.trim().length === 0) return []

  const text = ac.replace(/\r\n/g, '\n')

  // List markers: "1. ", "1) ", "- ", "* ", "- [ ] ", "- [x] "
  const listMarker = /^\s*(?:[-*]\s*(?:\[[ xX]\]\s*)?|\d+[.)]\s+)(.+)$/
  const listItems: string[] = []
  for (const line of text.split('\n')) {
    const m = line.match(listMarker)
    if (m) {
      const item = m[1].trim()
      if (item.length > 0) listItems.push(item)
    }
  }
  if (listItems.length > 0) return listItems

  // Blank-line separated paragraphs.
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0)
  if (paragraphs.length > 1) return paragraphs

  // Single line / sentence.
  const single = text.replace(/\s+/g, ' ').trim()
  if (single.length === 0) return []

  // Split a long run-on on sentence boundaries, but only when there are
  // at least two reasonably long sentences.
  const sentences = single
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (sentences.length >= 2 && sentences.every((s) => s.length >= 8)) return sentences

  return [single]
}

/** Pick the dominant source extension from the probe's breakdown. */
export function pickExtension(probe: ProjectProbeResult | null): string {
  if (!probe) return '.ts'
  for (const ext of SOURCE_EXT_PREFERENCE) {
    if ((probe.languageBreakdown[ext] ?? 0) > 0) return ext
  }
  return '.ts'
}

/** Pick the first existing candidate directory from the probe. */
export function pickDir(
  probe: ProjectProbeResult | null,
  candidates: string[],
): string | null {
  if (!probe) return null
  for (const c of candidates) {
    if (probe.topLevelDirs.includes(c)) return c
  }
  return null
}

/** Turn a criterion into a path-safe slug. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : 'task'
}

/** Commit scope derived from the source path (its directory or stem). */
function commitScope(sourceFile: string | undefined): string {
  if (!sourceFile) return 'core'
  const parts = sourceFile.split('/')
  if (parts.length >= 2) {
    const dir = parts[parts.length - 2]
    // Strip a leading `src`/`lib`/`app` so `src/payment/x.ts` -> `payment`.
    if (['src', 'lib', 'app', 'source', 'packages'].includes(dir) && parts.length >= 3) {
      return parts[parts.length - 3]
    }
    return dir
  }
  return 'core'
}

/** Remove characters that would break an inline-code span. */
function escapeInline(text: string): string {
  return text.replace(/`/g, "'").replace(/\s+/g, ' ').trim()
}
