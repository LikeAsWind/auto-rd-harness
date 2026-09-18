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
import type { SubagentsService, AgentsService, SessionsService } from '../types/dsh-services.js'

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
      this.deps.logger.warn(
        `StoryNotifier: story ${story.id} blocked but subagents service not available; user nudge skipped`,
      )
      return
    }

    // `subagents.sendMessage` requires a real Agent as its SENDER (the
    // first parameter is an Agent, not a provider name). The only
    // supported way to obtain one is `agents.currentInitiator()`, which
    // resolves the initiating Agent of the current process-local
    // asynchronous driver chain.
    //
    // This notifier runs from a bare interval callback, which has no
    // initiator. When that is the case we cannot legally send, so we log
    // exactly why and let `auto_rd_status` carry the information instead
    // of attempting a call that would throw.
    const agents = this.ctx.get('agents') as AgentsService | undefined
    const sender = agents?.currentInitiator?.()
    if (!sender) {
      this.deps.logger.info(
        `StoryNotifier: story ${story.id} blocked, but no initiating Agent is in scope from the ` +
          `polling context, so no message can be sent (subagents.sendMessage requires an Agent sender). ` +
          `Use auto_rd_status to inspect the block.`,
      )
      return
    }

    const userSessionId = this.findUserSessionId()
    if (!userSessionId) {
      this.deps.logger.info(
        `StoryNotifier: story ${story.id} blocked, but no active session; skipping nudge`,
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
      await subagents.sendMessage(sender, userSessionId, [{ type: 'text', text }], {
        signal: new AbortController().signal,
      })
      this.deps.logger.info(`StoryNotifier: pinged session ${userSessionId} for story ${story.id}`)
    } catch (err) {
      // Don't bubble. The story is still blocked; the user just doesn't
      // get the auto-prompt. auto_rd_status still surfaces it.
      this.deps.logger.warn(
        `StoryNotifier: failed to send nudge for story ${story.id}: ${(err as Error).message}`,
      )
    }
  }

  /**
   * Look up a live session id to notify.
   *
   * The real `sessions.list()` takes NO arguments (the previous revision
   * passed a `{ role: 'user' }` filter, which the API does not accept)
   * and returns every live session. We take the most recently created
   * one, which is the best available proxy for "the session the user is
   * looking at".
   */
  private findUserSessionId(): string | null {
    const sessions = this.ctx.get('sessions') as SessionsService | undefined
    if (!sessions || typeof sessions.list !== 'function') return null
    try {
      const list = sessions.list()
      if (!Array.isArray(list) || list.length === 0) return null
      const last = list[list.length - 1]
      return last && typeof last.id === 'string' ? last.id : null
    } catch {
      return null
    }
  }
}