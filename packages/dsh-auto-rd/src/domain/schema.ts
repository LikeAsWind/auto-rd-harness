/**
 * Domain schemas — the storageDomain tables that auto-rd owns.
 *
 * Three tables: modules, stories, tasks.
 * Layout: per-record (one file per record in ~/.dsh/storages/auto-rd/).
 *
 * Each table's valueSchema is the authoritative zod schema. The plugin
 * defines these on plugin mount via storageDomain.open(...).
 */
import { z } from 'zod'

// ---- Module ----

export const ModuleRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  repoUrl: z.string().url(),
  defaultBranch: z.string(),
  workspacePath: z.string().describe('Absolute path to the cloned module workspace'),
  createdAt: z.string().describe('ISO 8601 timestamp'),
})

export type ModuleRecord = z.infer<typeof ModuleRecordSchema>

// ---- Story ----

/**
 * The 19-story state machine. See auto-rd-native-plugin-design.md §5.
 *
 * Terminal states: completed, failed
 * Branch states: pending (queue), blocked (human)
 * Active states: context, clarification, brainstorm, critic, decision, spec,
 *                planning, implementing, testing, fixing, verifying,
 *                reviewing, final_verifying, mr_creating, tapd_syncing
 */
export const StoryStateSchema = z.enum([
  'pending',
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
  'completed',
  'failed',
  'blocked',
])

export type StoryState = z.infer<typeof StoryStateSchema>

export const ArtifactRefSchema = z.object({
  kind: z.enum([
    'context',
    'clarification',
    'proposal',
    'critique',
    'decision',
    'spec',
    'plan',
    'implementation',
    'test',
    'fix',
    'verification',
    'review',
    'final_verify',
  ]),
  filename: z.string().describe('Filename under worktree/.auto-rd/stories/<story-id>/artifacts/'),
  summary: z.string(),
  createdAt: z.string(),
})

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>

export const StoryRecordSchema = z.object({
  id: z.string().describe('TAPD story id (primary key)'),
  moduleId: z.string(),
  tapdId: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string().optional(),
  state: StoryStateSchema,
  branch: z.string().describe('Git branch name, e.g. auto-rd/TAPD-12345'),
  worktreePath: z.string().optional().describe('Absolute path to git worktree; null until created'),
  mainSessionId: z.string().optional().describe('Top-level session id; null until created'),
  artifacts: z.record(z.string(),ArtifactRefSchema).default({}),
  retryCount: z.number().int().min(0).default(0),
  blockedReason: z.string().optional(),
  mrUrl: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type StoryRecord = z.infer<typeof StoryRecordSchema>

// ---- Task ----

export const TaskRecordSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  title: z.string(),
  description: z.string(),
  /**
   * Free-form task bag passed to the ImplementationAgent. Carries the
   * RED / GREEN / verify / commit instructions from the Planner, the
   * spec excerpt, file paths, and any per-task context.
   */
  payload: z
    .object({
      taskId: z.string(),
      title: z.string(),
      files: z.array(z.string()),
      dependsOn: z.array(z.string()),
      estimatedMinutes: z.number().int().min(0).optional(),
      red: z
        .object({
          file: z.string(),
          testName: z.string(),
          assertion: z.string(),
        })
        .optional(),
      green: z
        .object({
          file: z.string(),
          change: z.string(),
        })
        .optional(),
      verify: z
        .object({
          run: z.string(),
          expectedPass: z.boolean(),
        })
        .optional(),
      commit: z
        .object({
          type: z.string(),
          scope: z.string(),
          subject: z.string(),
        })
        .optional(),
      specExcerpt: z.string().optional(),
    })
    .optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'blocked']),
  /**
   * How many times the FixAgent has been dispatched against this task.
   * SD-4 (5-round breaker) trips when attemptCount reaches 5 and the task
   * is still failing.
   */
  attemptCount: z.number().int().min(0).default(0),
  implementationSessionId: z.string().optional(),
  implementationResult: z.string().optional(),
  blockedReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type TaskRecord = z.infer<typeof TaskRecordSchema>

// ---- Domain Definition ----

/**
 * The full storageDomain spec for auto-rd.
 *
 * Caller passes the storageDomain service obtained via inject: ['storageDomain'].
 *
 * NOTE: storageDomain requires a real ZodType<V> (not duck-typed). Since this
 * plugin runs in the Cordis Host context (not sandboxed dynamic plugin), we
 * can `import { z } from 'zod'` directly and pass schemas as-is.
 */
export const AUTORD_DOMAIN_NAME = 'auto-rd'
export const AUTORD_DOMAIN_VERSION = 2

export function buildAutoRdDomainTables() {
  return {
    modules: { valueSchema: ModuleRecordSchema },
    stories: { valueSchema: StoryRecordSchema },
    tasks: { valueSchema: TaskRecordSchema },
  } as const
}