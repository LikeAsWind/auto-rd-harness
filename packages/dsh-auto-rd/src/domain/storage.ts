/**
 * AutoRdStorage — the plugin's handle on its storageDomain tables.
 *
 * Two facts about the real DSH API drive this design:
 *
 *   1. `storageDomain.open(spec)` is ASYNC and rejects a name that is
 *      already open. Construction therefore goes through the async
 *      `AutoRdStorage.open()` factory; there is no synchronous
 *      constructor, because there is no synchronous way to obtain the
 *      domain.
 *
 *   2. The table handle DSH returns (`KvTable`) exposes
 *      `get`/`entries`/`keys`/`size`/`put`/`delete`/`update` — it has NO
 *      `values()`. Earlier revisions of this plugin called
 *      `.values()` everywhere, which would have thrown at runtime. The
 *      adapter below adds `values()` on top of the real `entries()` so
 *      those call sites keep working while staying compatible with the
 *      real contract.
 *
 * The caller owns the handle: `close()` releases the domain. index.ts
 * registers that as a Cordis effect disposer so an unmount releases it.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  AUTORD_DOMAIN_NAME,
  AUTORD_DOMAIN_VERSION,
  buildAutoRdDomainTables,
  type ModuleRecord,
  type StoryRecord,
  type TaskRecord,
  type TrajectoryEvent,
} from './schema.js'
import type { Domain, KvTable, StorageDomainService } from '../types/dsh-services.js'

/**
 * The table surface the plugin codes against: the real KvTable members
 * plus a `values()` convenience.
 */
export interface TableApi<T> {
  get(key: string): T | undefined
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  update(key: string, fn: (current: T) => T): Promise<T>
  entries(): IterableIterator<[string, T]>
  keys(): IterableIterator<string>
  readonly size: number
  /** Convenience over the real `entries()`; not part of DSH's KvTable. */
  values(): IterableIterator<T>
}

/** Wrap a real KvTable so callers also get `values()`. */
function adaptTable<T>(table: KvTable<string, T>): TableApi<T> {
  return {
    get: (key) => table.get(key),
    put: (key, value) => table.put(key, value),
    delete: (key) => table.delete(key),
    update: (key, fn) => table.update(key, fn),
    entries: () => table.entries(),
    keys: () => table.keys(),
    get size() {
      return table.size
    },
    values(): IterableIterator<T> {
      const iterator = table.entries()
      return (function* () {
        for (const [, value] of iterator) yield value
      })()
    },
  }
}

export class AutoRdStorage {
  private constructor(
    private readonly ctx: Context,
    private readonly domain: Domain,
  ) {}

  /**
   * Open the auto-rd domain. Async because `storageDomain.open()` is.
   *
   * Throws if the domain is already open (`already-open`) — that means
   * another instance of this plugin is mounted in the same process, and
   * failing loudly is better than silently sharing a half-initialised
   * domain.
   */
  static async open(ctx: Context, storageDomain: StorageDomainService): Promise<AutoRdStorage> {
    const domain = await storageDomain.open({
      name: AUTORD_DOMAIN_NAME,
      version: AUTORD_DOMAIN_VERSION,
      layout: 'per-record',
      tables: buildAutoRdDomainTables() as unknown as Record<string, { valueSchema: unknown }>,
    })
    return new AutoRdStorage(ctx, domain)
  }

  modules(): TableApi<ModuleRecord> {
    return adaptTable<ModuleRecord>(this.domain.table('modules'))
  }

  stories(): TableApi<StoryRecord> {
    return adaptTable<StoryRecord>(this.domain.table('stories'))
  }

  tasks(): TableApi<TaskRecord> {
    return adaptTable<TaskRecord>(this.domain.table('tasks'))
  }

  /**
   * Trajectory events for a given story. The table is keyed by
   * ULID/UUID, so consumers filter by `storyId` after listing.
   */
  trajectories(): TableApi<TrajectoryEvent> {
    return adaptTable<TrajectoryEvent>(this.domain.table('trajectories'))
  }

  /** Release the domain. Safe to call more than once. */
  async close(): Promise<void> {
    await this.domain.close()
  }
}
