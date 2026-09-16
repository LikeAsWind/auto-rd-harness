/**
 * StorageDomain wrapper for the auto-rd plugin.
 *
 * This wraps storageDomain.open() with auto-rd-specific tables.
 * The orchestrator owns one AutoRdStorage instance and threads it
 * to every service that needs durable storage.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { z } from 'zod'
import {
  AUTORD_DOMAIN_NAME,
  AUTORD_DOMAIN_VERSION,
  buildAutoRdDomainTables,
  type ModuleRecord,
  type StoryRecord,
  type TaskRecord,
  type TrajectoryEvent,
} from './schema'

/**
 * Domain API shape. We don't import the storage-domain package directly
 * because the plugin must compile standalone; the runtime service is
 * provided by DSH at mount time.
 */
interface StorageDomainService {
  open(spec: {
    name: string
    version: number
    layout: 'per-record' | 'single-file'
    tables: Record<string, { valueSchema: z.ZodType<any> }>
  }): DomainApi
}

interface TableApi<T> {
  get(key: string): T | undefined
  put(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  values(): IterableIterator<T>
}

interface DomainApi {
  table<T = unknown>(name: string): TableApi<T>
  close(): Promise<void>
}

export class AutoRdStorage {
  readonly domain: DomainApi

  constructor(private readonly ctx: Context, storageDomain: StorageDomainService) {
    this.domain = storageDomain.open({
      name: AUTORD_DOMAIN_NAME,
      version: AUTORD_DOMAIN_VERSION,
      layout: 'per-record',
      tables: buildAutoRdDomainTables(),
    })
  }

  modules(): TableApi<ModuleRecord> {
    return this.domain.table<ModuleRecord>('modules')
  }

  stories(): TableApi<StoryRecord> {
    return this.domain.table<StoryRecord>('stories')
  }

  tasks(): TableApi<TaskRecord> {
    return this.domain.table<TaskRecord>('tasks')
  }

  /**
   * Trajectory events for a given story. The full table is keyed by
   * a ULID/UUID, so consumers filter by `storyId` after listing.
   */
  trajectories(): TableApi<TrajectoryEvent> {
    return this.domain.table<TrajectoryEvent>('trajectories')
  }
}