/**
 * PickDirectoryRoute — POST /auto-rd/pick-directory.
 *
 * The browser half of our bundle cannot talk to the OS chooser
 * directly (Chromium does not let a webview request absolute disk
 * paths from a file picker). DSH's own native picker is a host-side
 * pure function — `pickNativeDirectory` from
 * `@deepseek-ai/dsh-host-directory-picker-native` — which we import
 * directly rather than going through a ctx service (DSH does not
 * expose `directoryPicker` to third-party host plugins). That function
 * opens the native OS folder chooser (Win32 COM via koffi on Windows,
 * osascript on macOS, zenity/kdialog on Linux) and resolves the
 * selected absolute path.
 *
 * Wire shape:
 *   POST /auto-rd/pick-directory  (empty body)
 *   200  { ok: true, path: "C:\\Users\\me\\proj" }
 *   204  (user cancelled — body is empty)
 *   500  { ok: false, error: "..." }
 *
 * The client polls no state through this route; it is fire-and-return
 * for one user gesture (a single button click).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from '../utils/logger.js'

export const PICK_DIRECTORY_ROUTE_PATH = '/auto-rd/pick-directory'

/**
 * The native picker is a host-side pure function from DSH's own
 * `@deepseek-ai/dsh-host-directory-picker-native`. It is NOT installed
 * in our dev `node_modules` (it lives inside DSH's runtime), so we
 * load it lazily and declare its shape here rather than importing it
 * statically — which keeps `tsc` happy without adding a dev dependency
 * that would shadow the runtime copy.
 */
interface NativeDirectoryPickerModule {
  pickNativeDirectory: (signal: AbortSignal) => Promise<string | null>
}

async function loadNativePicker(): Promise<NativeDirectoryPickerModule> {
  return await import('@deepseek-ai/dsh-host-directory-picker-native') as unknown as NativeDirectoryPickerModule
}

/** Same WebServer surface as panel-route / reconfigure-route. */
interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/**
 * Register the pick-directory HTTP handler. Returns a disposer or
 * `null` when the web server is unavailable (headless deployment).
 * The native picker is imported lazily inside the handler, so a
 * headless host without the picker dependency still mounts cleanly
 * and only fails when the route is actually hit.
 */
export function registerPickDirectoryRoute(
  ctx: Context,
  logger: Logger,
  opts: { path?: string } = {},
): (() => void) | null {
  const path = opts.path ?? PICK_DIRECTORY_ROUTE_PATH
  const webServer = ctx.get('webServer' as never) as unknown as WebServerService | undefined

  if (!webServer || typeof webServer.register !== 'function') {
    logger.info(
      `[auto-rd] webServer unavailable; the pick-directory route ${path} is not registered`,
    )
    return null
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
      return
    }

    const ac = new AbortController()
    // If the client closes the connection, abort the picker so the
    // worker process can unwind cleanly. (Most browsers will not let
    // JS observe the request abort before the response has been
    // written, so this is best-effort.)
    req.on('close', function () {
      if (!ac.signal.aborted) ac.abort()
    })

    try {
      const { pickNativeDirectory } = await loadNativePicker()
      const result = await pickNativeDirectory(ac.signal)
      if (result === null || result === undefined || result === '') {
        res.statusCode = 204
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify({ ok: true, path: result }))
    } catch (err) {
      logger.warn(
        `[auto-rd] pick-directory failed: ${(err as Error).message}`,
      )
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({ ok: false, error: (err as Error).message || 'pick failed' }),
      )
    }
  }

  try {
    const dispose = webServer.register({ kind: 'exact', path, handler })
    logger.info(`Registered pick-directory route: POST ${path}`)
    return dispose
  } catch (err) {
    logger.error(`failed to register the pick-directory route ${path}: ${(err as Error).message}`)
    return null
  }
}