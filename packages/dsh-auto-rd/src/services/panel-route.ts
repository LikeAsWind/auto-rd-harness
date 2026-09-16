/**
 * PanelRoute — serve the panel model over HTTP for the client UI.
 *
 * The sidebar panel is a client-side contribution (see ui-panel.ts), and
 * the client runs in the browser with no access to the plugin's
 * storageDomain. The transport between them is therefore an ordinary HTTP
 * route on DSH's own web server, registered through the host `webServer`
 * service whose verified contract is:
 *
 *   register(route: WebRoute): () => void
 *   interface WebRoute {
 *     kind: 'exact' | 'prefix'
 *     path: string
 *     handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
 *   }
 *
 * `webServer` is deliberately NOT in the plugin's `inject` list: it is
 * absent in headless deployments, and this route is a UI convenience
 * rather than something the pipeline needs. Without it the plugin mounts
 * and runs normally; only the graphical panel is unavailable, and the
 * same data stays reachable through the auto_rd_status tool.
 *
 * What the route exposes is exactly `buildPanelModel()` — story ids,
 * titles, states, timestamps and MR URLs, plus a `health` block that
 * surfaces a setup checklist (config issues) and runtime stats (last
 * poll, uptime). No credentials, no tokens, no file paths beyond what
 * the sidebar already shows. It never reads from the request beyond
 * the method.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from '../config.js'
import type { AutoRdStorage } from '../domain/storage.js'
import { buildPanelModel, renderPanelText } from './ui-panel.js'
import { resolveLogChannel, type LogChannel } from '../utils/logger.js'

/** Default route path. Exported so the client half and tests agree. */
export const PANEL_ROUTE_PATH = '/auto-rd/panel'

/**
 * The host `webServer` surface this module uses (verified shape,
 * trimmed to `register`).
 */
export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface PanelRouteDeps {
  storage: AutoRdStorage
  logger: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void }
  /**
   * Current parsed + normalized config. The route passes this to
   * `buildPanelModel` so the panel JSON carries a `health` block with
   * a setup checklist + uptime + last TAPD poll.
   *
   * When `getConfig` is provided (preferred for live-reconfigure), the
   * route reads the LATEST config on every request. When only `config`
   * is provided, the route uses that one snapshot for its lifetime.
   */
  config?: Config
  getConfig?: () => Config
  /**
   * Runtime stats. `mountedAt` is when `apply()` started; the route
   * derives `mountedForSec` at request time so the client can show a
   * live "X seconds since mount" indicator.
   */
  runtime?: { mountedAt: Date; lastTapdPollAt: Date | null; lastTapdError: string | null }
}

function channel(ctx: Context, deps: PanelRouteDeps): LogChannel {
  return (
    resolveLogChannel(ctx, 'auto-rd') ?? {
      debug: (m) => deps.logger.debug(m),
      info: (m) => deps.logger.info(m),
      warn: (m) => deps.logger.warn(m),
      error: (m) => deps.logger.error(m),
    }
  )
}

/**
 * Register the panel route as a Cordis effect that resolves the optional
 * `webServer` host service. The helper returns synchronously when called
 * from inside a `ctx.effect`, so the caller can drop the returned disposer
 * into its parent fiber.
 *
 * The retry happens through Cordis' own service-resolution: the inner
 * `ctx.effect` reads `webServer`; when the service is absent, the effect
 * returns a no-op disposer; when `webServer` becomes available later,
 * the parent fiber re-runs the effect (the inner effect subscribes to the
 * ctx's dependency graph for `webServer`) and the route gets bound then.
 *
 * Returns `true` when the route is currently bound, `false` otherwise. The
 * helper itself does not retry by polling — it relies on Cordis to drive
 * the effect.
 */
/**
 * Register the panel route. Returns the disposer returned by
 * `webServer.register` on success, or `null` when the web server is
 * unavailable (headless) — in which case the caller should not treat it
 * as an error.
 *
 * The disposer is the function that `webServer.register` returns by
 * contract (see the panel-route plugin contract); the caller owns its
 * lifetime and is expected to call it on plugin unload.
 */
export function registerPanelRoute(
  ctx: Context,
  deps: PanelRouteDeps,
  opts: { path?: string } = {},
): (() => void) | null {
  const path = opts.path ?? PANEL_ROUTE_PATH
  const webServer = ctx.get('webServer' as never) as unknown as WebServerService | undefined
  const log = channel(ctx, deps)

  if (!webServer || typeof webServer.register !== 'function') {
    log.info(
      `webServer unavailable; the panel route ${path} is not registered ` +
        `(expected in headless deployments, or before @deepseek-ai/dsh-host-webserver mounts). ` +
        `auto_rd_status still returns the same data.`,
    )
    return null
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    // Only GET is meaningful; anything else is a client bug.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, HEAD')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
      return
    }

    let body: string
    try {
      const cfg = deps.getConfig ? deps.getConfig() : deps.config
      const model = buildPanelModel(deps.storage, cfg, deps.runtime)
      body = JSON.stringify(
        {
          ok: true,
          generatedAt: new Date().toISOString(),
          model,
          text: renderPanelText(model),
        },
        null,
        2,
      )
    } catch (err) {
      // A storage read failure must not take the web server down.
      log.error(`panel route failed to build the model: ${(err as Error).message}`)
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'panel_unavailable' }))
      return
    }

    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    // Live pipeline state: never let a proxy or the browser cache it.
    res.setHeader('cache-control', 'no-store')
    if (req.method === 'HEAD') {
      res.setHeader('content-length', Buffer.byteLength(body))
      res.end()
      return
    }
    res.end(body)
  }

  try {
    const dispose = webServer.register({ kind: 'exact', path, handler })
    log.info(`Registered panel route: GET ${path}`)
    return dispose
  } catch (err) {
    // A duplicate (kind, path) throws by contract. Log and continue — the
    // pipeline does not depend on this route.
    log.error(`failed to register the panel route ${path}: ${(err as Error).message}`)
    return null
  }
}

/**
 * Bind `webServer` lazily: try once now, then poll every `retryMs` until
 * either registration succeeds or `maxAttempts` polls have run out.
 *
 * Cordis does not (yet) expose a host service-resolution observable, so
 * the only way to wait for an OPTIONAL service that may mount later is a
 * polled retry. The cap keeps the polling from continuing forever in
 * truly headless profiles. `webServer` is the documented optional
 * service provided by `@deepseek-ai/dsh-host-webserver` in the web profile.
 *
 * Returns a disposer that aborts the retry loop and (when registration
 * succeeded) unregisters the route through `webServer.register`'s
 * returned cleanup function.
 */
export function registerPanelRouteWithRetry(
  ctx: Context,
  deps: PanelRouteDeps & { retryMs?: number; maxAttempts?: number },
  opts: { path?: string } = {},
): () => void {
  const retryMs = deps.retryMs ?? 1000
  const maxAttempts = deps.maxAttempts ?? 10
  const path = opts.path ?? PANEL_ROUTE_PATH
  const log = channel(ctx, deps)

  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let unregisterRoute: (() => void) | undefined
  let cancelled = false

  const tryRegister = (): void => {
    if (cancelled) return
    attempts += 1

    const dispose = registerPanelRoute(ctx, deps, { path })
    if (dispose !== null) {
      unregisterRoute = dispose
      log.info(`[auto-rd] panel route ${path} registered after ${attempts} attempt(s)`)
      return
    }

    if (attempts >= maxAttempts) {
      log.info(
        `webServer did not appear or refused registration within ${attempts} attempts; ` +
          `panel route ${path} will NOT be registered. ` +
          `auto_rd_status still returns the same data.`,
      )
      return
    }
    timer = setTimeout(tryRegister, retryMs)
  }

  // First attempt runs synchronously inside the effect to keep the call
  // ordering predictable; the next attempt, if needed, is scheduled.
  tryRegister()

  return () => {
    cancelled = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (unregisterRoute) {
      try {
        unregisterRoute()
      } catch (err) {
        log.warn(`failed to unregister panel route ${path}: ${(err as Error).message}`)
      }
      unregisterRoute = undefined
    }
  }
}
