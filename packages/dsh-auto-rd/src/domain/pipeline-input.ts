/**
 * PipelineInput — the single entry contract for the Tier-1 rd-pipeline
 * (design docs/architecture/auto-rd-two-tier-pipeline.md §1.1).
 *
 * Every producer of pipeline work funnels into this one shape, whether it
 * is a human chatting in the rd-pipeline preset (`source.kind = 'chat'`) or
 * the Tier-2 timed task pulling a TAPD story (`source.kind = 'tapd'`). The
 * Tier-1 engine reads ONLY this object — it never depends on a TAPD-shaped
 * StoryRecord or a GitLab-shaped anything, which is exactly what makes it a
 * reusable generic engine.
 *
 * The `git` binding is OPTIONAL: it is present only when the originating
 * workspace is bound to a git repo. Without it the Tier-1 tail skips
 * branch/commit/push (code stays in the workspace) while review and
 * final-verify still run on the artifact files (§1.3).
 *
 * The `source` field is bookkeeping only — it records provenance for the
 * ledger and does not change how the pipeline executes (§1.1 "仅记账用,
 * 不影响执行").
 */
import type { StoryRecord } from './schema.js'

export interface PipelineInput {
  title: string
  description: string
  /**
   * Git context — present only when the initiating workspace is bound to
   * a git repository. `defaultBranch` is the repo's real default branch
   * (master or main); `worktreePath` is reused when the repo has already
   * been cloned / adopted.
   */
  git?: {
    repoUrl: string
    defaultBranch: string
    worktreePath?: string
  }
  /** Provenance — who handed this work in. Bookkeeping only. */
  source?: { kind: 'tapd' | 'chat'; ref?: string }
}

/**
 * Adapter: a Tier-2 TAPD story → the Tier-1 entry contract.
 *
 * This is the "① 拉取" normalization the design (§2.1 ①) names: a
 * `StoryRecord` (plus its module's repo binding) is folded into one
 * `PipelineInput` so the Tier-1 engine sees the same shape whether the
 * work came from a timed TAPD pull or a human chat.
 *
 * `module` is the story's repo binding, taken structurally (a
 * `ModuleConfig` satisfies it) so this domain module does not import the
 * app config layer. The `git` binding is attached only when the module
 * carries a repo URL; `worktreePath` rides along only when the story has
 * already been cloned / adopted. `source.kind` is `'tapd'` because this
 * adapter feeds the timed-pull entry; the chat entry sets `'chat'`
 * directly.
 */
export function pipelineInputForStory(
  story: Pick<StoryRecord, 'title' | 'description' | 'tapdId' | 'worktreePath'>,
  module?: { repoUrl: string; defaultBranch: string },
): PipelineInput {
  const input: PipelineInput = {
    title: story.title,
    description: story.description,
  }
  if (module && module.repoUrl) {
    input.git = {
      repoUrl: module.repoUrl,
      defaultBranch: module.defaultBranch,
      ...(story.worktreePath ? { worktreePath: story.worktreePath } : {}),
    }
  }
  input.source = { kind: 'tapd', ref: story.tapdId }
  return input
}
