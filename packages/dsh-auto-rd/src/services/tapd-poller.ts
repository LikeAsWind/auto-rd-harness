/**
 * TapdPoller — fetches new stories from TAPD on a timer and adds them to the
 * auto-rd story queue.
 *
 * M4-A: real HTTP fetch path is wired and selected when `useTapdMock=false`.
 * The mock fixture remains for offline development and tests; the same
 * internal `TapdStory` shape is produced either way, so the orchestrator
 * doesn't care which path returned the data.
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
import { HttpClient, HttpError } from '../utils/http-client.js'
import type { PollResult } from './poll-stats.js'

export interface TapdPollerDeps {
  storage: AutoRdStorage
  logger: Logger
  config: Config
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
   * label or a structured `module` object; we accept either.
   */
  category?: string
  module?: string | { id?: string; name?: string }
  status?: string
}

/**
 * GET /stories response envelope. TAPD has historically returned
 * multiple shapes depending on the API version; we accept the most
 * common ones.
 */
interface RawTapdListResponse {
  data?: RawTapdApiStory[]
  stories?: RawTapdApiStory[]
  items?: RawTapdApiStory[]
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
  private readonly httpClient: HttpClient

  constructor(private readonly ctx: Context, private readonly deps: TapdPollerDeps) {
    this.httpClient = deps.httpClient ?? new HttpClient({ tag: 'tapd-poller' })
  }

  start(): void {
    if (this.timer) return
    this.deps.logger.info(
      `TapdPoller starting (interval ${this.deps.config.tapdPollIntervalMs}ms, ` +
        `${this.deps.config.modules.length} modules configured, ` +
        `mock=${this.deps.config.useTapdMock})`,
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
      const fetched = await this.fetchStories()
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
   * Branches on `useTapdMock`:
   *   - true:  returns the local fixture (offline dev / unit tests).
   *   - false: iterates every configured module and fetches the module's
   *            own TAPD workspace (1:1 mapping). A module without a
   *            `tapdWorkspaceId` is skipped. Each module uses its own
   *            `tapdApiToken` when set, otherwise the global token.
   *
   * Per-module errors are caught and logged; one workspace being 401/500
   * does not prevent the others from advancing. Persistent failures show
   * up as repeated error logs but never crash the plugin.
   */
  private async fetchStories(): Promise<{ stories: TapdStory[]; results: PollResult[] }> {
    if (this.deps.config.useTapdMock) {
      // Mock fixture: every story's category doubles as its moduleId.
      const results: PollResult[] = this.deps.config.modules.map((m) => ({
        moduleId: m.id,
        error: null,
        newCount: 0,
      }))
      const stories = MOCK_TAPD_FIXTURE.filter((t) =>
        this.deps.config.modules.some((m) => m.id === t.category),
      )
      return { stories, results }
    }
    const modules = this.deps.config.modules.filter((m) => (m.tapdWorkspaceId ?? '').length > 0)
    if (modules.length === 0) {
      this.deps.logger.warn(
        'TapdPoller: useTapdMock=false but no module has a tapdWorkspaceId -- nothing to fetch',
      )
      return { stories: [], results: [] }
    }
    const all: TapdStory[] = []
    const results: PollResult[] = []
    for (const m of modules) {
      const tapdWorkspaceId = m.tapdWorkspaceId as string
      // Effective token: per-workspace override first, else global.
      const token = m.tapdApiToken || this.deps.config.tapdApiToken
      try {
        const stories = await this.fetchStoriesFromApi(tapdWorkspaceId, token)
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
    url.searchParams.set('status', 'open')

    const resp = await this.httpClient.request<RawTapdListResponse>({
      url: url.toString(),
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeoutMs: 20_000,
    })

    // TAPD returns one of { data, stories, items } or a top-level array.
    const body = resp.json() as RawTapdListResponse | RawTapdApiStory[]
    const raw: RawTapdApiStory[] = Array.isArray(body)
      ? body
      : (body.data ?? body.stories ?? body.items ?? [])
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