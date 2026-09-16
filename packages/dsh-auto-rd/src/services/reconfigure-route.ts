/**
 * ReconfigureRoute — POST /auto-rd/reconfigure.
 *
 * Lets the user apply a new plugin config WITHOUT restarting DSH. The
 * flow:
 *
 *   1. DSH is running with empty config (or partial config). The UI
 *      shows a setup checklist.
 *   2. User edits the form in the panel and clicks "Apply".
 *   3. Client POSTs `{ config: {...} }` to /auto-rd/reconfigure.
 *   4. Host validates the config, swaps `liveConfig.current`, rebuilds
 *      the timer-driven services (TapdPoller, StoryQueue, StoryRunner,
 *      AgentProvider, WorkspaceManager, StoryNotifier), re-seeds the
 *      module records, and restarts the timers.
 *   5. Host returns the new health block (setup issues count, runtime
 *      stats) so the client can render the new state in one round-trip.
 *
 * Why a route at all (instead of having the user restart DSH)?
 * - DSH's live patch reload merges config tree edits but does NOT
 *   re-evaluate an already-mounted plugin instance. The plugin's
 *   `apply()` runs exactly once per process. Without a route, an edit
 *   to cordis.patch.yml takes effect on the next restart only.
 * - The user has already proven the wiring works (the UI is rendering),
 *   so the natural next action is "fill in the missing pieces and
 *   click apply", not "edit a YAML file then restart".
 *
 * What the route does NOT touch:
 * - storageDomain — the table handles stay open; we re-seed module
 *   records against the existing domain.
 * - Tools, prompt sections — they don't depend on the parts of config
 *   that change at runtime (tokens, modules, workspaceRoot).
 * - The panel route itself — it reads `liveConfig` lazily on every
 *   request via `getConfig()`, so it picks up the new config the next
 *   time it is hit.
 * - The sidebar slot registration — the cell is address-stable.
 *
 * Method contract:
 *   POST /auto-rd/reconfigure
 *   body: { config: Partial<Config> }
 *   - On success: 200, `{ ok: true, model: PanelModel, text: string }`.
 *   - On validation failure: 400, `{ ok: false, error: 'invalid_config', issues: [...] }`.
 *   - On webServer unavailable: 503, `{ ok: false, error: 'webserver_unavailable' }`.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ConfigSchema, normalizeConfig, type Config } from '../config.js'
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import { buildPanelModel, renderPanelText } from './ui-panel.js'

export const RECONFIGURE_ROUTE_PATH = '/auto-rd/reconfigure'

/**
 * The shape of the runtime services that get rebuilt on reconfigure.
 * Defined here as a contract; the concrete instances live in index.ts.
 * The reconfigure handler only needs start/stop + the runner reference.
 */
export interface AutoRdServices {
  queue: { start(): void; stop(): void }
  poller: { start(): void; stop(): void }
  notifier: { start(): void; stop(): void }
  trajectory: unknown
  workspaceManager: unknown
  agentProvider: unknown
  runner: unknown
}

export interface ReconfigureRouteDeps {
  storage: AutoRdStorage
  logger: Logger
  /**
   * Mutable reference to the live config. The reconfigure handler swaps
   * `.current` to the new config on success.
   */
  liveConfig: { current: Config }
  runtime: { mountedAt: Date; lastTapdPollAt: Date | null; lastTapdError: string | null }
  /**
   * Build a fresh batch of services against the new config. Caller is
   * responsible for not stopping the old services before calling this
   * (we stop them first to keep the swap atomic from the panel route's
   * perspective).
   */
  startServices: (cfg: Config) => AutoRdServices
  /** Stop the services that were started by `startServices`. */
  stopServices: (svcs: AutoRdServices) => void
  /**
   * The currently-running services, returned for inspection / for the
   * handler to call `stopServices` against.
   */
  currentServices: AutoRdServices
}

/** WebServer contract — same as panel-route. */
interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Read a JSON body from a Node request. Caps at a small size so a
 * hostile client cannot exhaust memory; 64 KiB is far more than any
 * legitimate config we accept.
 */
async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  return await new Promise<unknown>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        rejectBody(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        resolveBody({})
        return
      }
      try {
        resolveBody(JSON.parse(raw))
      } catch (err) {
        rejectBody(new Error('invalid JSON body: ' + (err as Error).message))
      }
    })
    req.on('error', rejectBody)
  })
}

/** Bind the reconfigure HTTP handler. Returns a disposer or null. */
export function registerReconfigureRoute(
  ctx: Context,
  deps: ReconfigureRouteDeps,
  opts: { path?: string } = {},
): (() => void) | null {
  const path = opts.path ?? RECONFIGURE_ROUTE_PATH
  const webServer = ctx.get('webServer' as never) as unknown as WebServerService | undefined
  const logger = deps.logger

  if (!webServer || typeof webServer.register !== 'function') {
    logger.info(
      `[auto-rd] webServer unavailable; the reconfigure route ${path} is not registered. ` +
        `Edit cordis.patch.yml and restart DSH to change config in headless deployments.`,
    )
    return null
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Only POST is meaningful; everything else is a client bug.
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
      return
    }

    let payload: { config?: unknown }
    try {
      payload = (await readJsonBody(req)) as { config?: unknown }
    } catch (err) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'bad_request', detail: (err as Error).message }))
      return
    }

    if (!payload || typeof payload !== 'object' || !('config' in payload)) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'missing_config_field' }))
      return
    }

    // Validate the new config; reject invalid configs loudly instead of
    // silently swapping to a half-broken state.
    let parsed: Config
    try {
      parsed = ConfigSchema.parse(payload.config)
    } catch (err) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      const zodIssues = (err as { issues?: unknown }).issues
      res.end(JSON.stringify({ ok: false, error: 'invalid_config', issues: zodIssues }))
      logger.warn(
        `[auto-rd] reconfigure rejected invalid config: ${(err as Error).message}`,
      )
      return
    }

    const next = normalizeConfig(parsed)
    const previous = deps.liveConfig.current

    // Stop the currently-running services BEFORE swapping the config so
    // they cannot observe a half-applied state.
    try {
      deps.stopServices(deps.currentServices)
    } catch (err) {
      logger.error(
        `[auto-rd] failed to stop old services during reconfigure: ${(err as Error).message}`,
      )
    }

    // Swap the live config first — the panel route's `getConfig()` reads
    // from here, so a fetch that races the reconfigure sees the new state
    // immediately even before the new services are fully started.
    deps.liveConfig.current = next

    // Re-seed module records from the new config. Idempotent: same
    // logic as the initial mount, but skipping any record that already
    // exists for the same id.
    const newModules: Array<{ id: string }> = []
    for (const m of next.modules) {
      const existing = deps.storage.modules().get(m.id)
      if (existing) continue
      try {
        const { resolve: pathResolve } = await import('node:path')
        await deps.storage.modules().put(m.id, {
          id: m.id,
          title: m.title,
          repoUrl: m.repoUrl,
          defaultBranch: m.defaultBranch,
          workspacePath: pathResolve(next.workspaceRoot || '.', m.id),
          createdAt: new Date().toISOString(),
        })
        newModules.push({ id: m.id })
      } catch (err) {
        logger.error(
          `[auto-rd] failed to seed module ${m.id} during reconfigure: ${(err as Error).message}`,
        )
      }
    }

    // Build + start the new services. Failure here would leave us in a
    // bad state — the live config is swapped but the timers are down.
    // We log loudly so an operator notices; the panel route still
    // answers (it only reads storage + liveConfig), but the poller will
    // be silent until the user fixes the config.
    try {
      const newServices = deps.startServices(next)
      // Swap the reference so the NEXT reconfigure stops the right ones.
      deps.currentServices = newServices
      newServices.queue.start()
      newServices.poller.start()
      newServices.notifier.start()
    } catch (err) {
      logger.error(
        `[auto-rd] failed to start new services during reconfigure: ${(err as Error).message}`,
      )
    }

    logger.info(
      `[auto-rd] reconfigured: modules: ${previous.modules.length} -> ${next.modules.length}, ` +
        `mock: ${previous.useTapdMock} -> ${next.useTapdMock}, ` +
        `tapd-token: ${previous.tapdApiToken ? 'set' : 'empty'} -> ${next.tapdApiToken ? 'set' : 'empty'}, ` +
        `gitlab-token: ${previous.gitlabApiToken ? 'set' : 'empty'} -> ${next.gitlabApiToken ? 'set' : 'empty'}, ` +
        `workspaceRoot: "${previous.workspaceRoot}" -> "${next.workspaceRoot}"`,
    )

    // Return the new health snapshot so the client can render without
    // a second round-trip.
    const model = buildPanelModel(deps.storage, next, deps.runtime)
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(
      JSON.stringify(
        {
          ok: true,
          generatedAt: new Date().toISOString(),
          newModules,
          model,
          text: renderPanelText(model),
        },
        null,
        2,
      ),
    )
  }

  try {
    const dispose = webServer.register({ kind: 'exact', path, handler })
    logger.info(`Registered reconfigure route: POST ${path}`)
    return dispose
  } catch (err) {
    logger.error(`failed to register the reconfigure route ${path}: ${(err as Error).message}`)
    return null
  }
}