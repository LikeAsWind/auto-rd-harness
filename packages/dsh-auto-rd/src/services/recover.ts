/**
 * Recovery — runs once on plugin mount.
 *
 * Per auto-rd-native-plugin-design.md §10.2: when DSH restarts and the plugin
 * re-mounts, any stories that were mid-flight (`state ∈ ACTIVE_STATES`) need
 * to be re-dispatched from their current state. Otherwise they sit forever
 * with no runner.
 *
 * Strategy:
 *   1. **Orphan cleanup** — drop every story whose `moduleId` is not in
 *      the live config. These come from `remove_workspace` paths before
 *      the deletion logic learned to clean up stories (issue #9), from
 *      modules removed by editing cordis.patch.yml directly, or from a
 *      module record that was wiped from storage without its stories.
 *      Without this step, `totals.stories` in the panel model lies —
 *      it counts storage-wide but the user only sees the live ones, so
 *      "1 个需求" appears against an empty module list.
 *   2. **State recovery** — for every story still in an ACTIVE state
 *      (context, clarification, ..., etc.): set state back to 'pending'
 *      and bump updatedAt. StoryQueue's next tick picks it up and
 *      dispatches from the new "current" stage via StoryRunner.runStory.
 *   3. Stories in terminal states (delivery_ready, mr_opened, completed,
 *      failed, blocked, pending) are left alone.
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
  'delivery_ready',
  'mr_opened',
  'completed',
  'failed',
  'blocked',
  'pending',
])

export async function recoverStories(
  storage: AutoRdStorage,
  logger: Logger,
  liveModuleIds: ReadonlySet<string>,
  trajectory?: TrajectoryRecorder,
): Promise<{ recovered: string[]; orphansDropped: string[] }> {
  // ---- 1. Orphan cleanup ------------------------------------------------
  //
  // Stories whose owning module is no longer in the live config are
  // unreachable from the poller / queue / runner — they would never be
  // picked up again. Keeping them around inflates totals, leaks
  // artifacts / trajectories, and confuses the user (they see "1 个
  // 需求" against an empty workspace list). Drop them here, while we
  // are already iterating storage as part of recovery.
  const orphansDropped: string[] = []
  const storiesTable = storage.stories()
  for (const story of [...storiesTable.values()]) {
    if (liveModuleIds.has(story.moduleId)) continue
    orphansDropped.push(story.id)
    storiesTable.delete(story.id)
    logger.warn(
      `[recover] dropping orphan story ${story.id} (moduleId="${story.moduleId}" not in live config)`,
    )
    if (trajectory) {
      void trajectory.append({
        storyId: story.id,
        kind: 'recovery',
        label: `orphan dropped (moduleId=${story.moduleId})`,
        payload: { reason: 'module not in live config' },
      })
    }
  }

  // ---- 2. State recovery ------------------------------------------------
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

  if (orphansDropped.length === 0 && recovered.length === 0) {
    logger.info('[recover] nothing to recover (no orphans, no in-flight stories)')
  } else {
    const parts: string[] = []
    if (orphansDropped.length > 0) parts.push(`dropped ${orphansDropped.length} orphan(s)`)
    if (recovered.length > 0) parts.push(`reset ${recovered.length} in-flight story/stories`)
    logger.info(`[recover] ${parts.join(', ')}`)
  }

  return { recovered, orphansDropped }
}
