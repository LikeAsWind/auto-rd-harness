/**
 * Recovery — runs once on plugin mount.
 *
 * Per auto-rd-native-plugin-design.md §10.2: when DSH restarts and the plugin
 * re-mounts, any stories that were mid-flight (`state ∈ ACTIVE_STATES`) need
 * to be re-dispatched from their current state. Otherwise they sit forever
 * with no runner.
 *
 * Strategy:
 *   - Read every story from storage.
 *   - For each story in an ACTIVE state (context, clarification, ..., etc.):
 *       set state back to 'pending' and bump updatedAt. StoryQueue's next
 *       tick will pick it up and dispatch from the new "current" stage via
 *       StoryRunner.runStory(id).
 *   - Stories in terminal states (completed, failed, blocked) are left alone.
 *   - The transition is logged so operators can audit what was recovered.
 *
 * Notes:
 *   - We do NOT attempt to cold-resume an existing mainSessionId in M1,
 *     because (a) DSH's session APIs vary by version, and (b) storage.jsonl
 *     is observable through Sessions but not yet wired through this plugin.
 *     Replaying from the current stage is the safe, version-portable move.
 */
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import type { StoryState } from '../domain/schema.js'
import type { TrajectoryRecorder } from './trajectory.js'

const TERMINAL_STATES: ReadonlySet<StoryState> = new Set<StoryState>([
  'completed',
  'failed',
  'blocked',
  'pending',
])

export async function recoverStories(
  storage: AutoRdStorage,
  logger: Logger,
  trajectory?: TrajectoryRecorder,
): Promise<{ recovered: string[] }> {
  const recovered: string[] = []
  const stories = [...storage.stories().values()]

  for (const story of stories) {
    if (TERMINAL_STATES.has(story.state)) continue

    const previous = story.state
    story.state = 'pending'
    story.updatedAt = new Date().toISOString()
    story.retryCount = 0
    await storage.stories().put(story.id, story)
    recovered.push(story.id)
    logger.warn(
      `[recover] story ${story.id} was ${previous} — reset to pending for re-dispatch`,
    )
    // Trajectory: capture the recovery so the post-mortem has a single
    // place to look for why a story was reset.
    if (trajectory) {
      void trajectory.append({
        storyId: story.id,
        kind: 'recovery',
        label: `${previous} → pending`,
        payload: { previousState: previous, reason: 'plugin restart' },
      })
    }
  }

  if (recovered.length === 0) {
    logger.info('[recover] no in-flight stories to recover')
  } else {
    logger.info(`[recover] ${recovered.length} stories reset to pending`)
  }

  return { recovered }
}