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
 * titles, states, timestamps and MR URLs. No credentials, no tokens, no
 * file paths beyond what the sidebar already shows. It never reads from
 * the request beyond the method.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
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
 * Register the panel route. Returns true when the route was registered,
 * false when the web server is unavailable (headless) — in which case the
 * caller should not treat it as an error.
 */
export function registerPanelRoute(
  ctx: Context,
  deps: PanelRouteDeps,
  opts: { path?: string } = {},
): boolean {
  const path = opts.path ?? PANEL_ROUTE_PATH
  const webServer = ctx.get('webServer' as never) as unknown as WebServerService | undefined
  const log = channel(ctx, deps)

  if (!webServer || typeof webServer.register !== 'function') {
    log.info(
      `webServer unavailable; the panel route ${path} is not registered ` +
        `(expected in headless deployments). auto_rd_status still returns the same data.`,
    )
    return false
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
      const model = buildPanelModel(deps.storage)
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
    webServer.register({ kind: 'exact', path, handler })
  } catch (err) {
    // A duplicate (kind, path) throws by contract. Log and continue — the
    // pipeline does not depend on this route.
    log.error(`failed to register the panel route ${path}: ${(err as Error).message}`)
    return false
  }

  log.info(`Registered panel route: GET ${path}`)
  return true
}
