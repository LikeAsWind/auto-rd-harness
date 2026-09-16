/**
 * auto_rd_trigger — manually advance a story or trigger an immediate
 * TAPD poll.
 *
 * Design doc §12.2: "auto_rd_trigger 工具".
 *
 * Two distinct operations under one tool (sharing the same JSON
 * surface):
 *   - action='poll_now': run a single TapdPoller tick out of band,
 *     instead of waiting for the next interval.
 *   - action='advance_story': if a story is stuck in 'pending', call
 *     StoryQueue.runStory(storyId) to wake it up. Useful after
 *     unblocking a config error -- the poller has already enqueued
 *     the story, but the queue might not pick it up until the next
 *     polling cycle.
 *   - action='mark_reviewed': record a human review decision into
 *     the story's blockedReason. This is the human-in-the-loop
 *     checkpoint called out in design doc §12 (manual intervention).
 *
 * Failures return ok:false with a `reason` field; never throw across
 * the tool boundary (DSH handles thrown errors poorly when surfacing
 * back to the model).
 */
import { z } from 'zod'
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import { jsonOutput } from './tool-output.js'

const ParametersSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('poll_now'),
  }),
  z.object({
    action: z.literal('advance_story'),
    storyId: z.string().min(1),
  }),
  z.object({
    action: z.literal('mark_reviewed'),
    storyId: z.string().min(1),
    decision: z.enum(['approve', 'request_changes', 'skip']),
    note: z.string().optional(),
  }),
])

export type AutoRdTriggerParams = z.infer<typeof ParametersSchema>

export interface AutoRdTriggerToolDeps {
  storage: AutoRdStorage
  logger: Logger
  /** Reference to the TapdPoller's tick() so we can trigger a poll. */
  pollNow?: () => Promise<void>
  /** Reference to the StoryQueue's runStory() so we can wake a story. */
  advanceStory?: (storyId: string) => Promise<void>
}

/**
 * Build the tool definition.
 *
 * IMPORTANT: the optional callbacks (`pollNow`, `advanceStory`) are
 * injected at registration time. If the caller of this tool did not
 * wire them up (e.g. a test fixture), the corresponding action returns
 * ok:false with `reason: 'callback_not_wired'`. We never throw across
 * the tool boundary -- DSH's tool runtime would render the throw into
 * a generic 'tool execution failed' message, losing the detail.
 */
export function autoRdTriggerTool(deps: AutoRdTriggerToolDeps) {
  return {
    name: 'auto_rd_trigger',
    description:
      'Manually advance the auto-rd pipeline: action="poll_now" runs an out-of-band TAPD poll; action="advance_story" wakes a pending story from the queue; action="mark_reviewed" records a human review decision (approve / request_changes / skip) against a story, with an optional note.',
    parameters: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['poll_now', 'advance_story', 'mark_reviewed'],
        },
        storyId: {
          type: 'string',
          description: 'Required for advance_story / mark_reviewed.',
        },
        decision: {
          type: 'string',
          enum: ['approve', 'request_changes', 'skip'],
          description: 'Required for mark_reviewed.',
        },
        note: { type: 'string', description: 'Optional reviewer note.' },
      },
    },
    output: jsonOutput({
      properties: {
        ok: { type: 'boolean' },
        action: { type: 'string' },
        storyId: { type: 'string' },
        decision: { type: 'string' },
        polled: { type: 'number' },
        enqueued: { type: 'number' },
        error: { type: 'string' },
      },
    }),
    async execute(rawArgs: unknown) {
      const parsed = ParametersSchema.safeParse(rawArgs ?? {})
      if (!parsed.success) {
        return { ok: false, error: 'invalid_parameters', issues: parsed.error.issues }
      }
      const args = parsed.data
      deps.logger.info(`auto_rd_trigger: action=${args.action}`)

      if (args.action === 'poll_now') {
        if (!deps.pollNow) {
          return { ok: false, error: 'callback_not_wired', action: args.action }
        }
        try {
          await deps.pollNow()
          return { ok: true, action: 'poll_now' }
        } catch (err) {
          return {
            ok: false,
            error: 'poll_failed',
            message: (err as Error).message,
          }
        }
      }

      if (args.action === 'advance_story') {
        if (!deps.advanceStory) {
          return { ok: false, error: 'callback_not_wired', action: args.action }
        }
        const story = deps.storage.stories().get(args.storyId)
        if (!story) {
          return { ok: false, error: 'story_not_found', storyId: args.storyId }
        }
        try {
          await deps.advanceStory(args.storyId)
          return { ok: true, action: 'advance_story', storyId: args.storyId }
        } catch (err) {
          return {
            ok: false,
            error: 'advance_failed',
            storyId: args.storyId,
            message: (err as Error).message,
          }
        }
      }

      // mark_reviewed
      const story = deps.storage.stories().get(args.storyId)
      if (!story) {
        return { ok: false, error: 'story_not_found', storyId: args.storyId }
      }
      const now = new Date().toISOString()
      const noteSuffix = args.note ? `: ${args.note}` : ''
      if (args.decision === 'approve') {
        // Approve releases a blocked story back to 'pending' so the
        // queue picks it up again. retryCount is reset so the breaker
        // doesn't fire on the very first re-attempt.
        story.state = 'pending'
        story.blockedReason = undefined
        story.retryCount = 0
      } else if (args.decision === 'request_changes') {
        story.blockedReason = `Human review requested changes${noteSuffix}`
        // State stays as-is; runner will see blockedReason and route.
      } else {
        // skip -> terminal failed state. The user opted out; we record
        // the reason and stop processing.
        story.state = 'failed'
        story.blockedReason = `Skipped by human review${noteSuffix}`
      }
      story.updatedAt = now
      await deps.storage.stories().put(story.id, story)
      return {
        ok: true,
        action: 'mark_reviewed',
        storyId: args.storyId,
        decision: args.decision,
        resultingState: story.state,
      }
    },
  }
}