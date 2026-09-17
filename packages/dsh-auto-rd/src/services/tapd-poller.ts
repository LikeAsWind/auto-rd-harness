/**
 * TapdPoller — fetches new stories from TAPD on a timer and adds them to the
 * auto-rd story queue.
 *
 * Module routing: each TAPD story is mapped to a Module by a label /
 * category rule. The simplest rule (used here) is: if the story's
 * `category` field matches a configured module.id, route to that module.
 *
 * Real endpoint (TAPD public API):
 *   GET {tapdBaseUrl}/stories?workspace_id=<id>&status=open
 *   Authorization: Bearer <tapdApiToken>
 *
 * The response body is `{ data: [ { id, name, description, ... } ] }` in
 * the TAPD OpenAPI convention. We accept a few alternative shapes
 * (`stories`, `items`, top-level array) so the poller survives minor
 * version drift.
 */
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config.js'
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import type { CredentialsService } from '../types/dsh-services.js'
import { resolveTapdToken, formatTokenResolution } from '../domain/credentials.js'
import { HttpClient, HttpError } from '../utils/http-client.js'
import type { PollResult } from './poll-stats.js'

export interface TapdPollerDeps {
  storage: AutoRdStorage
  logger: Logger
  config: Config
  /**
   * DSH credentials service. Used to resolve per-module and global
   * TAPD tokens at tick time. The poller NEVER reads the literal
   * off `module.tapdApiToken` directly — that's a credential
   * reference name as of issue #10.
   */
  credentials?: CredentialsService
  /**
   * Injected HttpClient. Defaults to a Node-fetch-backed client if not
   * supplied. Test harness can pass one with a fake fetcher.
   */
  httpClient?: HttpClient
  /**
   * Optional callback fired at the end of every tick (success or error).
   * Used by the host plugin to publish live runtime stats to the panel
   * route. `results` carries one entry per configured module, success or
   * failure, so the panel can show per-workspace freshness. Errors thrown
   * by this callback do NOT propagate.
   */
  onTickEnd?: (info: {
    at: Date
    error: Error | null
    results: PollResult[]
  }) => void
}

export interface TapdStory {
  id: string
  title: string
  description: string
  acceptanceCriteria?: string
  category?: string
}

/**
 * Raw shape returned by the real TAPD API. Field names follow the
 * public OpenAPI convention (`name` instead of `title`, etc.). We map
 * to our internal TapdStory inside fetchStoriesFromApi().
 */
interface RawTapdApiStory {
  id: string
  name?: string
  title?: string
  description?: string
  acceptance_criteria?: string
  acceptanceCriteria?: string
  /**
   * Module routing hint. TAPD supports either a free-form category
   * label or a structured `module` object; we accept either. In
   * practice the real TAPD API returns neither — the poller tags each
   * story with the module it was fetched under.
   */
  category?: string
  module?: string | { id?: string; name?: string }
  status?: string
}

/**
 * GET /stories response envelope. TAPD has historically returned
 * multiple shapes depending on the API version; we accept the most
 * common ones. The real API wraps each row in a `Story` key:
 * `{ data: [ { Story: { id, name, ... } } ] }`, while older/mocked
 * shapes are flat arrays or `{ data: [ { id, name } ] }`.
 */
interface RawTapdListResponse {
  data?: Array<{ Story?: RawTapdApiStory } | RawTapdApiStory>
  stories?: Array<{ Story?: RawTapdApiStory } | RawTapdApiStory>
  items?: Array<{ Story?: RawTapdApiStory } | RawTapdApiStory>
}

export class TapdPoller {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map()
  private readonly httpClient: HttpClient

  constructor(private readonly ctx: Context, private readonly deps: TapdPollerDeps) {
    this.httpClient = deps.httpClient ?? new HttpClient({ tag: 'tapd-poller' })
  }

  start(): void {
    if (this.timers.size > 0) return
    const pollable = this.deps.config.modules.filter((m) => (m.tapdWorkspaceId ?? '').length > 0)
    this.deps.logger.info(
      `TapdPoller starting (interval ${this.deps.config.tapdPollIntervalMs}ms, ` +
        `${pollable.length} module(s) with a TAPD workspace id)`,
    )

    // One independent timer per workspace, so each workspace polls on its
    // own cadence and the panel can show a per-workspace countdown.
    for (const m of pollable) {
      void this.tick(m.id)
      const timer = setInterval(() => void this.tick(m.id), this.deps.config.tapdPollIntervalMs)
      this.timers.set(m.id, timer)
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer)
    }
    this.timers.clear()
  }

  /**
   * Run one poll. When `moduleId` is given, only that module is fetched;
   * otherwise every pollable module is fetched (kept for `auto_rd_trigger`'s
   * `poll_now`, which predates per-workspace timers).
   */
  async tick(moduleId?: string): Promise<void> {
    try {
      const fetched = await this.fetchStories(moduleId)
      // Track how many of each module's stories were actually new.
      const newByModule = new Map<string, number>()
      for (const t of fetched.stories) {
        const added = await this.enqueueIfNew(t)
        if (added && t.category) {
          newByModule.set(t.category, (newByModule.get(t.category) ?? 0) + 1)
        }
      }
      for (const r of fetched.results) {
        r.newCount = newByModule.get(r.moduleId) ?? 0
      }
      this.notifyTickEnd(null, fetched.results)
    } catch (err) {
      this.deps.logger.error(`TapdPoller tick failed: ${(err as Error).message}`)
      this.notifyTickEnd(err as Error, [])
    }
  }

  /**
   * Fire the `onTickEnd` callback if provided. Swallow any callback error
   * so a broken stats sink can never take the poller down.
   */
  private notifyTickEnd(err: Error | null, results: PollResult[]): void {
    const cb = this.deps.onTickEnd
    if (!cb) return
    try {
      cb({ at: new Date(), error: err, results })
    } catch (cbErr) {
      this.deps.logger.warn(`TapdPoller onTickEnd callback threw: ${(cbErr as Error).message}`)
    }
  }

  private async enqueueIfNew(t: TapdStory): Promise<boolean> {
    const stories = this.deps.storage.stories()
    if (stories.get(t.id)) return false // already enqueued

    const moduleId = t.category
    if (!moduleId) {
      this.deps.logger.warn(`Story ${t.id} has no category; skipping`)
      return false
    }
    const moduleRecord = this.deps.storage.modules().get(moduleId)
    if (!moduleRecord) {
      this.deps.logger.warn(
        `Story ${t.id} category="${moduleId}" does not match any configured module; skipping`,
      )
      return false
    }

    const now = new Date().toISOString()
    const branch = `auto-rd/${t.id}`
    // Pre-compute the worktree path so the story record is complete at enqueue
    // time. WorkspaceManager.ensureStoryWorktree will create the directory on
    // first access; we just record the intended location here.
    const worktreePath = resolve(
      moduleRecord.workspacePath,
      '.auto-rd',
      'worktrees',
      t.id,
    )

    await stories.put(t.id, {
      id: t.id,
      moduleId,
      tapdId: t.id,
      title: t.title,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      state: 'pending',
      branch,
      worktreePath,
      artifacts: {},
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    this.deps.logger.info(`Enqueued story ${t.id} for module ${moduleId} (worktree=${worktreePath})`)
    return true
  }

  /**
   * Fetch from TAPD.
   *
   * Iterates every configured module and fetches the module's own TAPD
   * workspace (1:1 mapping). A module without a `tapdWorkspaceId` is
   * skipped. Each module resolves its own token through the credentials
   * seam (per-module override first, else the global token).
   *
   * Per-module errors are caught and logged; one workspace being 401/500
   * does not prevent the others from advancing. Persistent failures show
   * up as repeated error logs but never crash the plugin.
   */
  private async fetchStories(moduleId?: string): Promise<{ stories: TapdStory[]; results: PollResult[] }> {
    const pollable = this.deps.config.modules.filter((m) => (m.tapdWorkspaceId ?? '').length > 0)
    const modules = moduleId ? pollable.filter((m) => m.id === moduleId) : pollable
    if (modules.length === 0) {
      if (moduleId) {
        this.deps.logger.warn(`TapdPoller: module ${moduleId} has no tapdWorkspaceId -- nothing to fetch`)
      } else {
        this.deps.logger.warn('TapdPoller: no module has a tapdWorkspaceId -- nothing to fetch')
      }
      return { stories: [], results: [] }
    }
    const all: TapdStory[] = []
    const results: PollResult[] = []
    for (const m of modules) {
      const tapdWorkspaceId = m.tapdWorkspaceId as string
      // Resolve the token through the credentials seam. The value in
      // `m.tapdApiToken` is a CredentialRef name (`DSH_*` env var id);
      // resolver cascades per-module -> global -> undefined.
      const tapdResolution = await resolveTapdToken(
        this.deps.credentials,
        m.tapdApiToken || this.deps.config.tapdApiToken ? m.id : undefined,
      )
      if (!tapdResolution) {
        this.deps.logger.warn(
          `[TapdPoller] module ${m.id} (TAPD ${tapdWorkspaceId}): no TAPD token configured ` +
            `neither per-module (${m.tapdApiToken ?? 'unset'}) nor globally; skipping this module.`,
        )
        continue
      }
      this.deps.logger.info(
        formatTokenResolution({
          role: 'tapd',
          moduleId: m.id,
          ref: (m.tapdApiToken as never) ?? ('DSH_TAPD_API_TOKEN' as never),
          source: tapdResolution.source,
          at: new Date(),
        }),
      )
      try {
        const stories = await this.fetchStoriesFromApi(tapdWorkspaceId, tapdResolution.value)
        // Tag every story with the module we fetched it under. The real
        // TAPD API carries no `category`/`module` routing hint, so
        // enqueueIfNew needs this explicit tag to know where to route.
        for (const s of stories) {
          s.category = m.id
        }
        all.push(...stories)
        results.push({ moduleId: m.id, error: null, newCount: 0 })
      } catch (err) {
        const message = (err as Error).message
        if (err instanceof HttpError && !err.transient) {
          this.deps.logger.error(
            `TapdPoller: module ${m.id} (TAPD ${tapdWorkspaceId}) returned ${err.status} -- will not retry until config changes`,
          )
        } else {
          this.deps.logger.warn(
            `TapdPoller: module ${m.id} (TAPD ${tapdWorkspaceId}) fetch failed transiently: ${message} -- will retry next tick`,
          )
        }
        results.push({ moduleId: m.id, error: message, newCount: 0 })
      }
    }
    return { stories: all, results }
  }

  private async fetchStoriesFromApi(tapdWorkspaceId: string, token: string): Promise<TapdStory[]> {
    const url = new URL(this.deps.config.tapdBaseUrl)
    url.pathname = join(url.pathname, 'stories')
    url.searchParams.set('workspace_id', tapdWorkspaceId)
    // Do NOT filter by `status=open`: TAPD workspaces define their own
    // workflow states (e.g. "planning", "developing"), and `open` is
    // not one of them for many workspaces — it returned an empty list
    // even when stories existed. We fetch all stories and let
    // enqueueIfNew's `stories.get(id)` dedupe against storage.

    const resp = await this.httpClient.request<RawTapdListResponse>({
      url: url.toString(),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeoutMs: 20_000,
    })

    // TAPD returns { data: [ { Story: {...} } ] } (real), or flat
    // `{ data: [ { id, name } ] }`, or `{ stories }` / `{ items }` /
    // a top-level array (older versions). Unwrap each variant.
    const body = resp.json() as
      | RawTapdListResponse
      | Array<{ Story?: RawTapdApiStory } | RawTapdApiStory>
    const rows = Array.isArray(body)
      ? body
      : (body.data ?? body.stories ?? body.items ?? [])
    const raw: RawTapdApiStory[] = rows
      .map((row) => (row && (row as { Story?: RawTapdApiStory }).Story ? (row as { Story: RawTapdApiStory }).Story : (row as RawTapdApiStory)))
      .filter((s): s is RawTapdApiStory => s != null)
    return raw.map(normalizeRawStory).filter((s): s is TapdStory => s !== null)
  }
}

/**
 * Normalize a RawTapdApiStory into the internal TapdStory shape.
 *
 * Returns null if the raw story is missing an `id` -- those are dropped.
 */
function normalizeRawStory(raw: RawTapdApiStory): TapdStory | null {
  if (!raw.id) return null
  const title = raw.title ?? raw.name ?? raw.id
  const description = raw.description ?? ''
  const acceptanceCriteria = raw.acceptance_criteria ?? raw.acceptanceCriteria

  // Module routing: accept either a free-form `category` string or a
  // structured `module` object with id/name.
  let category: string | undefined = raw.category
  if (!category && raw.module) {
    category = typeof raw.module === 'string' ? raw.module : raw.module.id ?? raw.module.name
  }

  return {
    id: String(raw.id),
    title: String(title),
    description: String(description),
    acceptanceCriteria: acceptanceCriteria ? String(acceptanceCriteria) : undefined,
    category,
  }
}

/**
 * Sync a story back to TAPD after the story has been processed locally.
 *
 * M4-A: real HTTP. Idempotent -- calling twice with the same payload is
 * a no-op on the TAPD side (PATCH semantics). Errors are propagated
 * up via HttpError / HttpTimeoutError / HttpNetworkError; the stage
 * handler decides whether to record a checkpoint and exit or block.
 *
 * Endpoint:
 *   POST {tapdBaseUrl}/stories/{storyId}/changes
 *   Body: {
 *     status: 'completed',
 *     mr_url: string,
 *     git_branch: string,
 *     story_actor: 'auto-rd',
 *   }
 *
 * The endpoint and field names follow TAPD's public "story change"
 * convention; some TAPD deployments expose PATCH /stories/<id>
 * instead. We try POST first (more common in TAPD OpenAPI) and
 * fall back to PATCH on 404.
 */
export interface SyncTapdParams {
  tapdBaseUrl: string
  tapdApiToken: string
  tapdId: string
  mrUrl: string
  gitBranch: string
  httpClient?: HttpClient
}

export async function syncTapd(params: SyncTapdParams): Promise<void> {
  const http = params.httpClient ?? new HttpClient({ tag: 'tapd-sync' })

  const url = new URL(params.tapdBaseUrl)
  url.pathname = join(url.pathname, 'stories', params.tapdId, 'changes')

  const body = {
    status: 'completed',
    mr_url: params.mrUrl,
    git_branch: params.gitBranch,
    story_actor: 'auto-rd',
  }

  try {
    await http.request({
      url: url.toString(),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.tapdApiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      timeoutMs: 15_000,
    })
  } catch (err) {
    // Some TAPD deployments expose PATCH instead of POST /changes.
    // Try PATCH on the story itself as a fallback.
    if (err instanceof HttpError && err.status === 404) {
      const patchUrl = new URL(params.tapdBaseUrl)
      patchUrl.pathname = join(patchUrl.pathname, 'stories', params.tapdId)
      await http.request({
        url: patchUrl.toString(),
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${params.tapdApiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        timeoutMs: 15_000,
      })
      return
    }
    throw err
  }
}