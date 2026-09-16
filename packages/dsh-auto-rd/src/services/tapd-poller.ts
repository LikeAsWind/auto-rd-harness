/**
 * TapdPoller — fetches new stories from TAPD on a timer and adds them to the
 * auto-rd story queue.
 *
 * M1: uses a MOCK_TAPD_FIXTURE list instead of a real HTTP fetch, so we can
 * validate the end-to-end pipeline without network access. The real fetch
 * implementation is stubbed as fetchTapdStories() below and is gated behind
 * `useMock` config (defaults to true in M1).
 *
 * Module routing: each TAPD story is mapped to a Module by a label / category
 * rule. The simplest rule (used here) is: if the story's category field
 * matches a configured module.id, route to that module.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config'
import type { AutoRdStorage } from '../domain/storage'
import type { Logger } from '../utils/logger'

export interface TapdPollerDeps {
  storage: AutoRdStorage
  logger: Logger
  config: Config
}

export interface TapdStory {
  id: string
  title: string
  description: string
  acceptanceCriteria?: string
  category?: string
}

// M1 mock fixtures — replaced by HTTP fetch in M2.
const MOCK_TAPD_FIXTURE: TapdStory[] = [
  {
    id: 'TAPD-MOCK-001',
    title: 'Add /refunds endpoint to payment service',
    description:
      'Users want to be able to issue a partial refund against a captured payment. ' +
      'The endpoint should accept an order id + amount and call the gateway.',
    acceptanceCriteria:
      'Given a captured payment, when POST /refunds with {orderId, amount}, ' +
      'then a refund record is created and the gateway is called with the right args.',
    category: 'payment',
  },
  {
    id: 'TAPD-MOCK-002',
    title: 'Add order cancellation reason field',
    description:
      'When an order is cancelled, capture the user-supplied reason for analytics.',
    acceptanceCriteria:
      'Given an open order, when POST /orders/:id/cancel with {reason}, ' +
      'then the order transitions to cancelled with the reason persisted.',
    category: 'order',
  },
]

export class TapdPoller {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly ctx: Context, private readonly deps: TapdPollerDeps) {}

  start(): void {
    if (this.timer) return
    this.deps.logger.info(
      `TapdPoller starting (interval ${this.deps.config.tapdPollIntervalMs}ms, ` +
        `${this.deps.config.modules.length} modules configured)`,
    )

    // Run once immediately, then on interval.
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.config.tapdPollIntervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    try {
      const stories = await this.fetchStories()
      for (const t of stories) {
        await this.enqueueIfNew(t)
      }
    } catch (err) {
      this.deps.logger.error(`TapdPoller tick failed: ${(err as Error).message}`)
    }
  }

  private async enqueueIfNew(t: TapdStory): Promise<void> {
    const stories = this.deps.storage.stories()
    if (stories.get(t.id)) return // already enqueued

    const moduleId = t.category
    if (!moduleId || !this.deps.storage.modules().get(moduleId)) {
      this.deps.logger.warn(
        `Story ${t.id} category="${t.category}" does not match any configured module; skipping`,
      )
      return
    }

    const now = new Date().toISOString()
    await stories.put(t.id, {
      id: t.id,
      moduleId,
      tapdId: t.id,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      state: 'pending',
      branch: `auto-rd/${t.id}`,
      artifacts: {},
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    this.deps.logger.info(`Enqueued story ${t.id} for module ${moduleId}`)
  }

  /**
   * Fetch from TAPD.
   *
   M1: returns the local fixture. M2 will replace this with a real HTTP call:
   *
   *   const res = await fetch(`${config.tapdBaseUrl}/v1/stories?status=open`, {
   *     headers: { Authorization: `Bearer ${config.tapdApiToken}` },
   *   })
   *   return (await res.json()).stories as TapdStory[]
   */
   private async fetchStories(): Promise<TapdStory[]> {
    return MOCK_TAPD_FIXTURE
  }
}