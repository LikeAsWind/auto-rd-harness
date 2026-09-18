/**
 * auto_rd_retry — manual recovery for blocked / failed stories.
 *
 * Design doc §12.3: a single tool with three actions that map cleanly
 * onto the runner's state-transition surface.
 *
 *   - retry: from 'blocked' / 'failed' / 'completed' (the last is
 *     unusual but possible if a TAPD sync went sideways after the
 *     story was already marked completed) -> set state='pending',
 *     reset retryCount=0 AND clear the runner's ledger guards
 *     (loopCount=0, totalSteps=0) so a story parked by the loop /
 *     drift guard actually resumes instead of re-blocking on its next
 *     scan. The StoryQueue picks the story up on its next scan.
 *
 *   - skip: terminal 'failed' state, with the human's note recorded
 *     in blockedReason. There is no recovery from skip -- it's a
 *     decision that this story is no longer wanted.
 *
 *   - reset_to_pending: like retry, but does NOT touch retryCount.
 *     Useful when the breaker has tripped and the user wants to
 *     start a fresh count after applying a code fix.
 *
 * Note: this tool overlaps with auto_rd_trigger/mark_reviewed for the
 * 'skip' case. We keep both because their semantics are slightly
 * different -- 'mark_reviewed' is the human-in-the-loop checkpoint
 * after a review artifact is written; 'retry/skip' is the recovery
 * path for stage-level failures. Different intent, same surface.
 */
import { z } from 'zod'
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import { jsonOutput } from './tool-output.js'

const ParametersSchema = z.object({
  storyId: z.string().min(1),
  action: z.enum(['retry', 'skip', 'reset_to_pending']),
  note: z.string().optional(),
})

export type AutoRdRetryParams = z.infer<typeof ParametersSchema>

export interface AutoRdRetryToolDeps {
  storage: AutoRdStorage
  logger: Logger
}

export function autoRdRetryTool(deps: AutoRdRetryToolDeps) {
  return {
    name: 'auto_rd_retry',
    description:
      'Manually retry or skip a blocked/failed story. action="retry" sets state to pending, resets retryCount, and clears the runner loop/drift guards (loopCount/totalSteps); "skip" sets state to failed with the note; "reset_to_pending" sets state to pending without resetting retryCount.',
    parameters: {
      type: 'object',
      required: ['storyId', 'action'],
      properties: {
        storyId: { type: 'string' },
        action: {
          type: 'string',
          enum: ['retry', 'skip', 'reset_to_pending'],
        },
        note: { type: 'string' },
      },
    },
    output: jsonOutput({
      properties: {
        ok: { type: 'boolean' },
        storyId: { type: 'string' },
        action: { type: 'string' },
        previousState: { type: 'string' },
        newState: { type: 'string' },
        error: { type: 'string' },
      },
    }),
    async execute(rawArgs: unknown) {
      const parsed = ParametersSchema.safeParse(rawArgs ?? {})
      if (!parsed.success) {
        return { ok: false, error: 'invalid_parameters', issues: parsed.error.issues }
      }
      const args = parsed.data
      const story = deps.storage.stories().get(args.storyId)
      if (!story) {
        return { ok: false, error: 'story_not_found', storyId: args.storyId }
      }

      const now = new Date().toISOString()
      const previousState = story.state
      const noteSuffix = args.note ? `: ${args.note}` : ''

      if (args.action === 'retry') {
        story.state = 'pending'
        story.retryCount = 0
        story.blockedReason = undefined
        // The rollback-loop / drift guards (loopCount >= 5, totalSteps >= 40)
        // park a story as 'blocked' for manual review. 'retry' IS that manual
        // review: the human has looked at blockedReason and decided to run the
        // story again, so the guards must be released too. Without this, a
        // story parked at loopCount=5 would re-block on the very next
        // StoryQueue scan because the runner checks the guard before any
        // stage runs.
        story.loopCount = 0
        story.totalSteps = 0
      } else if (args.action === 'reset_to_pending') {
        story.state = 'pending'
        // retryCount untouched on purpose (breaker trip — keep the count).
        // loopCount / totalSteps also untouched: reset_to_pending is the
        // "preserve the ledger" variant, not the manual-review reset.
      } else {
        // skip — reason is code-prefixed per the runner's convention (§12.1).
        story.state = 'failed'
        story.blockedReason = `retry: skipped via auto_rd_retry${noteSuffix}`
      }

      story.updatedAt = now
      await deps.storage.stories().put(story.id, story)
      deps.logger.info(
        `auto_rd_retry: story ${story.id} ${previousState} -> ${story.state} (action=${args.action})`,
      )
      return {
        ok: true,
        storyId: story.id,
        previousState,
        resultingState: story.state,
        retryCount: story.retryCount,
      }
    },
  }
}