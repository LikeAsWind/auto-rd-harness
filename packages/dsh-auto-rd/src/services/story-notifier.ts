/**
 * StoryNotifier — push a short prompt into the user's active DSH
 * session whenever a story is blocked.
 *
 * Design doc §7.2. The runner cannot unilaterally decide how to
 * recover from a blocker (e.g. "5-round fix breaker tripped", "MR
 * create returned 403", "Planner parsed 0 tasks"). It must hand the
 * question back to the human via the main chat session. This is what
 * makes the human-in-the-loop checkpoint meaningful -- otherwise a
 * 'blocked' story just sits there silently.
 *
 * Why a Cordis event?
 *   The runner already calls `await deps.storage.stories().put(...)`
 *   when a story transitions to 'blocked'. We listen for the storage
 *   write via a poll loop (Cordis doesn't have a 'storage-changed'
 *   event out of the box) and emit a `story-blocked` Cordis event.
 *   The notifier subscribes to that event. This separation keeps the
 *   runner free of any DSH session / subagent references.
 *
 * Failure handling:
 *   We never throw across the Cordis event boundary. If `subagents`
 *   is unavailable (test fixture, partial mount), the notifier logs
 *   a warning and exits. The story is still recorded as 'blocked' in
 *   storage -- no data is lost, only the user nudge is skipped.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import type { SubagentsService } from '../types/dsh-services.js'

export interface StoryNotifierDeps {
  storage: AutoRdStorage
  logger: Logger
}

const POLL_INTERVAL_MS = 5_000

export class StoryNotifierService {
  private timer: ReturnType<typeof setInterval> | null = null
  /** Story IDs we have already notified about in this session. */
  private notifiedStories = new Set<string>()

  constructor(private readonly ctx: Context, private readonly deps: StoryNotifierDeps) {}

  start(): void {
    if (this.timer) return
    this.deps.logger.info('StoryNotifier starting')
    void this.tick()
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.deps.logger.info('StoryNotifier stopped')
  }

  private async tick(): Promise<void> {
    let blockedCount = 0
    try {
      for (const story of this.deps.storage.stories().values()) {
        if (story.state !== 'blocked') continue
        blockedCount += 1
        if (this.notifiedStories.has(story.id)) continue

        await this.notify(story)
        this.notifiedStories.add(story.id)
      }
    } catch (err) {
      this.deps.logger.warn(`StoryNotifier tick failed: ${(err as Error).message}`)
    }
    if (blockedCount === 0 && this.notifiedStories.size > 0) {
      // Once all blocks clear, allow re-notification on the same IDs
      // (e.g. a story gets unblocked, then re-blocked under a new
      // reason). Cheap; stories are at most dozens.
      this.notifiedStories.clear()
    }
  }

  private async notify(story: { id: string; title: string; state: string; blockedReason?: string }): Promise<void> {
    const subagents = this.ctx.get('subagents') as SubagentsService | undefined
    if (!subagents) {
      // No DSH subagent service available -- log and bail. The user
      // can still see the block via auto_rd_status or the sidebar.
      this.deps.logger.warn(
        `StoryNotifier: story ${story.id} blocked but subagents service not available; user nudge skipped`,
      )
      return
    }

    // Find a 'user' session to ping. We use the Cordis convention:
    // any session with role 'user'. For now, the sender is the
    // auto-rd initiator; DSH routes the message into the user's
    // active conversation.
    const userSessionId = await this.findUserSessionId()
    if (!userSessionId) {
      this.deps.logger.info(
        `StoryNotifier: story ${story.id} blocked, but no active user session; skipping nudge`,
      )
      return
    }

    const text = [
      `\u{1F514} Auto-RD: Story ${story.id} ("${story.title}") is blocked in state=${story.state}.`,
      ``,
      `Reason: ${story.blockedReason ?? '<no reason recorded>'}`,
      ``,
      `Use the \`auto_rd_retry\` or \`auto_rd_trigger\` tool to recover. ` +
        `Common actions: \`action="mark_reviewed", decision="approve"\` to release the block; ` +
        `\`action="advance_story"\` to wake the queue.`,
    ].join('\n')

    try {
      await subagents.sendMessage('auto-rd', userSessionId, [{ type: 'text', text }], {
        // Pin as low-priority so we don't barge into whatever the user
        // is currently looking at.
        priority: 'background',
      })
      this.deps.logger.info(`StoryNotifier: pinged user session ${userSessionId} for story ${story.id}`)
    } catch (err) {
      // Don't bubble. The story is still blocked; the user just
      // doesn't get the auto-prompt. auto_rd_status still surfaces it.
      this.deps.logger.warn(
        `StoryNotifier: failed to send nudge for story ${story.id}: ${(err as Error).message}`,
      )
    }
  }

  /**
   * Look up an active user session id. DSH exposes a sessions API
   * that we don't import directly; we use ctx.get('sessions') with a
   * local-narrowed shape. If absent, return null.
   */
  private async findUserSessionId(): Promise<string | null> {
    const sessions = this.ctx.get('sessions') as
      | { list?(filter?: { role?: string }): Array<{ id: string; role?: string }> }
      | undefined
    if (!sessions?.list) return null
    try {
      const list = sessions.list({ role: 'user' })
      // Pick the most recent (DSH sorts by createdAt desc by convention).
      return list[0]?.id ?? null
    } catch {
      return null
    }
  }
}