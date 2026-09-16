/**
 * TrajectoryRecorder — append-only log of execution events for a Story.
 *
 * This is the canonical "conversation/trajectory" record for the
 * plugin. Every state transition, agent dispatch (input + output),
 * checkpoint write, and external side effect is appended here so a
 * later inspection (UI, debugging, post-mortem) can reconstruct the
 * full execution path without trawling logs.
 *
 * The recorder is intentionally narrow: it owns the event shape, the
 * ULID generation, and the storage put. The runner and services that
 * drive execution call into this; they never write trajectory rows
 * directly.
 *
 * Why a separate service:
 *   - Decouples event shape from storage call sites (callers don't
 *     need to know the table name or the zod schema).
 *   - Centralises rate-limit + logger integration.
 *   - Tests can swap in a fake recorder to assert the exact sequence
 *     of events without reading from disk.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Logger } from '../utils/logger.js'
import type { AutoRdStorage } from '../domain/storage.js'
import type { TrajectoryEvent } from '../domain/schema.js'

export type TrajectoryEventKind = TrajectoryEvent['kind']

export interface TrajectoryInput {
  storyId: string
  kind: TrajectoryEventKind
  label: string
  payload?: unknown
  /** Override the timestamp; useful for tests / replay. */
  at?: string
}

export class TrajectoryRecorder {
  constructor(
    private readonly ctx: Context,
    private readonly deps: { storage: AutoRdStorage; logger: Logger },
  ) {}

  /**
   * Append a single trajectory event. Best-effort: a failed put is
   * logged at warn but never thrown — the trajectory must not be a
   * blocking side effect of the actual pipeline.
   */
  async append(input: TrajectoryInput): Promise<TrajectoryEvent | null> {
    const event: TrajectoryEvent = {
      id: randomUUID(),
      storyId: input.storyId,
      at: input.at ?? new Date().toISOString(),
      kind: input.kind,
      label: input.label,
      payload: input.payload,
    }
    try {
      await this.deps.storage.trajectories().put(event.id, event)
      return event
    } catch (err) {
      this.deps.logger.warn(
        `TrajectoryRecorder: failed to append ${input.kind} for story ${input.storyId}: ${(err as Error).message}`,
      )
      return null
    }
  }

  /**
   * List all events for a story in chronological order. Newest-last so
   * consumers can render the trajectory top-to-bottom and have it read
   * naturally.
   */
  listForStory(storyId: string): TrajectoryEvent[] {
    return [...this.deps.storage.trajectories().values()]
      .filter((e) => e.storyId === storyId)
      .sort((a, b) => a.at.localeCompare(b.at))
  }
}
