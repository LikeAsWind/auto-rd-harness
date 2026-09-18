/**
 * StoryQueue — periodically scans for pending stories and dispatches them
 * to StoryRunner, subject to per-module and total concurrency limits.
 *
 * Borrowed patterns:
 * - SD-1: Rulings, not stalls (run without waiting on human)
 * - The orchestrator owns the queue, not the agents.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config.js'
import type { AutoRdStorage } from '../domain/storage.js'
import type { StoryRecord, StoryState } from '../domain/schema.js'
import type { Logger } from '../utils/logger.js'
import { StoryRunner } from './story-runner.js'

export interface StoryQueueDeps {
  storage: AutoRdStorage
  logger: Logger
  config: Config
  runner: StoryRunner
}

const POLL_INTERVAL_MS = 10_000

const ACTIVE_STATES: StoryState[] = [
  'context', 'clarification', 'brainstorm', 'critic', 'decision',
  'spec', 'planning', 'implementing', 'testing', 'fixing',
  'verifying', 'reviewing', 'final_verifying',
]

export class StoryQueue {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = new Set<string>()

  constructor(private readonly ctx: Context, private readonly deps: StoryQueueDeps) {}

  start(): void {
    if (this.timer) return
    this.deps.logger.info('StoryQueue starting')
    void this.tick()
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    const stories = [...this.deps.storage.stories().values()]
    const executing = stories.filter((s) => ACTIVE_STATES.includes(s.state))

    if (executing.length >= this.deps.config.maxTotalConcurrentStories) {
      this.deps.logger.debug(
        `StoryQueue at total cap (${executing.length}/${this.deps.config.maxTotalConcurrentStories})`,
      )
      return
    }

    // Per-module counts.
    const perModuleExecuting = new Map<string, number>()
    for (const s of executing) {
      perModuleExecuting.set(s.moduleId, (perModuleExecuting.get(s.moduleId) ?? 0) + 1)
    }

    // Pick candidates in tapd-id order (FIFO).
    const candidates = stories
      .filter((s) => s.state === 'pending' || (s.state === 'failed' && s.retryCount < 3))
      .sort((a, b) => a.id.localeCompare(b.id))

    for (const story of candidates) {
      if (this.inFlight.has(story.id)) continue
      const moduleCount = perModuleExecuting.get(story.moduleId) ?? 0
      if (moduleCount >= this.deps.config.maxConcurrentStoriesPerModule) continue
      if (executing.length + this.inFlight.size >= this.deps.config.maxTotalConcurrentStories) {
        break
      }

      this.dispatch(story)
      perModuleExecuting.set(story.moduleId, moduleCount + 1)
    }
  }

  private dispatch(story: StoryRecord): void {
    this.inFlight.add(story.id)
    this.deps.logger.info(`StoryQueue dispatching ${story.id}`)
    void this.deps.runner
      .runStory(story.id)
      .catch((err) => {
        this.deps.logger.error(`StoryRunner.runStory(${story.id}) failed: ${(err as Error).message}`)
      })
      .finally(() => {
        this.inFlight.delete(story.id)
      })
  }
}