/**
 * StoryTrajectoryRoute — serve one story's execution log over HTTP.
 *
 * Same optional-webServer contract as panel-route.ts: headless profiles
 * have no webServer, so the route is a UI convenience, never a pipeline
 * dependency. The client fetches this on demand when the story detail
 * view opens, keeping the hot 5s panel poll lean (the trajectory can be
 * large and is read rarely).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AutoRdStorage } from '../domain/storage.js'
import type { TrajectoryEvent } from '../domain/schema.js'
import { resolveLogChannel, type LogChannel } from '../utils/logger.js'

export const STORY_TRAJECTORY_ROUTE_PREFIX = '/auto-rd/story/'

interface StoryTrajectoryRouteDeps {
  storage: AutoRdStorage
  logger: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void }
}

interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function channel(ctx: Context, deps: StoryTrajectoryRouteDeps): LogChannel {
  return (
    resolveLogChannel(ctx, 'auto-rd') ?? {
      debug: (m) => deps.logger.debug(m),
      info: (m) => deps.logger.info(m),
      warn: (m) => deps.logger.warn(m),
      error: (m) => deps.logger.error(m),
    }
  )
}

/** List one story's trajectory events in chronological order. */
function listForStory(storage: AutoRdStorage, storyId: string): TrajectoryEvent[] {
  return [...storage.trajectories().values()]
    .filter((e) => e.storyId === storyId)
    .sort((a, b) => a.at.localeCompare(b.at))
}

export function registerStoryTrajectoryRoute(
  ctx: Context,
  deps: StoryTrajectoryRouteDeps,
  opts: { prefix?: string } = {},
): (() => void) | null {
  const prefix = opts.prefix ?? STORY_TRAJECTORY_ROUTE_PREFIX
  const webServer = ctx.get('webServer' as never) as unknown as WebServerService | undefined
  const log = channel(ctx, deps)

  if (!webServer || typeof webServer.register !== 'function') {
    log.info(
      `webServer unavailable; story trajectory route is not registered (expected headless).`,
    )
    return null
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, HEAD')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
      return
    }
    const storyId = (req.url ?? '').slice(prefix.length).split('?')[0]
    let body: string
    try {
      const events = storyId ? listForStory(deps.storage, storyId) : []
      body = JSON.stringify({ ok: true, storyId, events })
    } catch (err) {
      log.error(`story trajectory route failed: ${(err as Error).message}`)
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'trajectory_unavailable' }))
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (req.method === 'HEAD') {
      res.setHeader('content-length', Buffer.byteLength(body))
      res.end()
      return
    }
    res.end(body)
  }

  try {
    const dispose = webServer.register({ kind: 'prefix', path: prefix, handler })
    log.info(`Registered story trajectory route: GET ${prefix}:storyId`)
    return dispose
  } catch (err) {
    log.error(`failed to register story trajectory route: ${(err as Error).message}`)
    return null
  }
}

export function registerStoryTrajectoryRouteWithRetry(
  ctx: Context,
  deps: StoryTrajectoryRouteDeps & { retryMs?: number; maxAttempts?: number },
  opts: { prefix?: string } = {},
): () => void {
  const retryMs = deps.retryMs ?? 1000
  const maxAttempts = deps.maxAttempts ?? 10
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let unregister: (() => void) | undefined
  let cancelled = false

  const tryRegister = (): void => {
    if (cancelled) return
    attempts += 1
    const dispose = registerStoryTrajectoryRoute(ctx, deps, opts)
    if (dispose !== null) {
      unregister = dispose
      return
    }
    if (attempts >= maxAttempts) return
    timer = setTimeout(tryRegister, retryMs)
  }
  tryRegister()
  return () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
    if (unregister) {
      try { unregister() } catch { /* already gone */ }
    }
  }
}
