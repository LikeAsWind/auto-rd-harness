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
import type {
  WorkspaceControllerService,
  SessionTitleService,
  CredentialsService,
  CredentialRef,
} from '../types/dsh-services.js'
import {
  tapdRefFor,
  gitlabRefFor,
  TAPD_GLOBAL_REF,
  GITLAB_GLOBAL_REF,
} from '../domain/credentials.js'
import { buildPanelModel, renderPanelText, resolveTokenStates } from './ui-panel.js'

export const RECONFIGURE_ROUTE_PATH = '/auto-rd/reconfigure'

/**
 * Outcome of routing a literal token through `ctx.credentials`.
 *
 *   - `'persisted'` — `credentials.set` accepted the value, the ref
 *     name is in `refName`. This is the success path; the module
 *     record stores `refName`, never the literal.
 *   - `'cleared'`   — the caller passed an empty token and we issued
 *     `credentials.unset`. The module record stores `''`.
 *   - `'fallback'`  — credentials service is absent; the literal is
 *     returned for the caller to write into the module record the
 *     legacy way. Logged at WARN.
 *   - `'rejected'`  — `credentials.set` threw (env-var shadow,
 *     invalid ref name, etc.). The error message is in `error`.
 *     Module record keeps the previous value.
 */
type TokenRoute =
  | { kind: 'persisted'; refName: string }
  | { kind: 'cleared' }
  | { kind: 'fallback'; literal: string }
  | { kind: 'rejected'; error: string }

/**
 * Resolve the literal a workspace-submitted token payload into either:
 *   - a persisted ref name (preferred path, issue #10), or
 *   - the empty string (cleared), or
 *   - the literal itself (headless fallback, no credentials service).
 *
 * Never returns the literal in the `persisted` branch — only the ref
 * name. The literal crosses the function boundary ONLY in the
 * `fallback` branch, which is the pre-#10 behaviour for headless
 * profiles that lack `ctx.credentials`.
 */
async function routeTapdToken(
  literal: string,
  moduleId: string,
  credentials: CredentialsService | undefined,
  logger: Logger,
): Promise<TokenRoute> {
  return await routeToken(literal, tapdRefFor(moduleId), credentials, 'tapd', moduleId, logger)
}

async function routeGitlabToken(
  literal: string,
  moduleId: string,
  credentials: CredentialsService | undefined,
  logger: Logger,
): Promise<TokenRoute> {
  return await routeToken(literal, gitlabRefFor(moduleId), credentials, 'gitlab', moduleId, logger)
}

async function routeToken(
  literal: string,
  ref: CredentialRef,
  credentials: CredentialsService | undefined,
  role: 'tapd' | 'gitlab',
  moduleId: string,
  logger: Logger,
): Promise<TokenRoute> {
  // Empty token = user wants to clear the stored credential.
  if (literal === '') {
    if (credentials) {
      try {
        await credentials.unset(ref)
        logger.info(`[auto-rd] cleared ${role} credential for module ${moduleId} (${ref})`)
        return { kind: 'cleared' }
      } catch (err) {
        logger.error(
          `[auto-rd] failed to clear ${role} credential for module ${moduleId} (${ref}): ${(err as Error).message}`,
        )
        return { kind: 'rejected', error: (err as Error).message }
      }
    }
    return { kind: 'cleared' }
  }

  if (!credentials) {
    logger.warn(
      `[auto-rd] no credentials service mounted — writing ${role} token to module ${moduleId} storage in plaintext. ` +
        `This is a headless fallback; web profile should mount dsh-credentials-local.`,
    )
    return { kind: 'fallback', literal }
  }

  try {
    await credentials.set(ref, literal)
    logger.info(
      `[auto-rd] persisted ${role} credential for module ${moduleId} (${ref}, value length=${literal.length})`,
    )
    return { kind: 'persisted', refName: ref }
  } catch (err) {
    const msg = (err as Error).message
    logger.error(
      `[auto-rd] failed to persist ${role} credential for module ${moduleId} (${ref}): ${msg}`,
    )
    return { kind: 'rejected', error: msg }
  }
}

/**
 * Same helper for the GLOBAL fields on the live config. Same
 * branches, just without a moduleId.
 */
async function routeGlobalTapdToken(
  literal: string,
  credentials: CredentialsService | undefined,
  logger: Logger,
): Promise<TokenRoute> {
  return await routeToken(literal, TAPD_GLOBAL_REF, credentials, 'tapd', '<global>', logger)
}

async function routeGlobalGitlabToken(
  literal: string,
  credentials: CredentialsService | undefined,
  logger: Logger,
): Promise<TokenRoute> {
  return await routeToken(literal, GITLAB_GLOBAL_REF, credentials, 'gitlab', '<global>', logger)
}

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
  /**
   * Optional DSH workspace controller. When present, add_workspace also
   * adopts the module's directory as a DSH workspace so the auto-rd
   * module and the DSH workspace stay 1:1. Absent in headless profiles
   * (no DSH workspace service) — the module still registers, just
   * without the DSH binding.
   */
  workspaceController?: WorkspaceControllerService
  /**
   * Optional DSH session-title service, used to set the story session's
   * display title after it is created. Absent in headless profiles.
   */
  sessionTitle?: SessionTitleService
  /**
   * DSH credentials service. The handler routes every token payload
   * (`tapdToken` / `gitlabToken` on `add_workspace` / `update_workspace`)
   * through `ctx.credentials.set` so the literal value lands in
   * `~/.dsh/.credentials.yaml` and never in storage, patch.yml, or the
   * network response. Absent in headless profiles — the handler then
   * writes the literal straight into the module record, mirroring the
   * pre-#10 behaviour, and logs a warning.
   *
   * When `set` rejects (e.g. an env-var shadow wins precedence), the
   * handler propagates that failure to the client as
   * `credential_write_rejected` so the user understands why the UI
   * still reports "not configured" after a successful 200.
   */
  credentials?: CredentialsService
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

    let payload: { action?: string; config?: unknown }
    try {
      payload = (await readJsonBody(req)) as { action?: string; config?: unknown }
    } catch (err) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'bad_request', detail: (err as Error).message }))
      return
    }

    // Dispatch on `action` so the same route can serve both
    // "swap full config" and "add a single workspace". Today only
    // `add_workspace` and the implicit (no-action) full-config swap
    // are supported.
    const action = (payload && payload.action) || 'reconfigure'

    if (action === 'add_workspace') {
      await handleAddWorkspace(payload, res, deps, logger)
      return
    }

    if (action === 'remove_workspace') {
      await handleRemoveWorkspace(payload, res, deps, logger)
      return
    }

    if (action === 'update_workspace') {
      await handleUpdateWorkspace(payload, res, deps, logger)
      return
    }

    await handleReconfigure(payload, res, deps, logger)
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

/**
 * Original full-config-swap behaviour. Validates a new `Config`,
 * stops the old services, swaps `liveConfig.current`, re-seeds module
 * records against the existing domain, restarts the timers, and
 * returns the new health snapshot.
 */
async function handleReconfigure(
  payload: { config?: unknown },
  res: ServerResponse,
  deps: ReconfigureRouteDeps,
  logger: Logger,
): Promise<void> {
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

  // If the full-config-swap carries literal (non-reference-name) tokens
  // in either global field, route them through the credentials store
  // exactly like the per-workspace handlers do, then rewrite the field
  // to the ref name. A reference-name value (`DSH_TAPD_API_TOKEN` etc.)
  // passes through untouched — the user already told us where the
  // token lives.
  if (typeof next.tapdApiToken === 'string' && next.tapdApiToken !== '') {
    const tapdRoute = await routeGlobalTapdToken(next.tapdApiToken, deps.credentials, logger)
    if (tapdRoute.kind === 'persisted') {
      next.tapdApiToken = tapdRoute.refName
    } else if (tapdRoute.kind === 'cleared') {
      next.tapdApiToken = ''
    } else if (tapdRoute.kind === 'fallback') {
      next.tapdApiToken = tapdRoute.literal
    }
    if (tapdRoute.kind === 'rejected') {
      res.statusCode = 422
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          ok: false,
          error: 'credential_write_rejected',
          message: `tapd: ${tapdRoute.error}`,
        }),
      )
      return
    }
  }
  if (typeof next.gitlabApiToken === 'string' && next.gitlabApiToken !== '') {
    const gitlabRoute = await routeGlobalGitlabToken(
      next.gitlabApiToken,
      deps.credentials,
      logger,
    )
    if (gitlabRoute.kind === 'persisted') {
      next.gitlabApiToken = gitlabRoute.refName
    } else if (gitlabRoute.kind === 'cleared') {
      next.gitlabApiToken = ''
    } else if (gitlabRoute.kind === 'fallback') {
      next.gitlabApiToken = gitlabRoute.literal
    }
    if (gitlabRoute.kind === 'rejected') {
      res.statusCode = 422
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({
          ok: false,
          error: 'credential_write_rejected',
          message: `gitlab: ${gitlabRoute.error}`,
        }),
      )
      return
    }
  }

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
  const tokenState = await resolveTokenStates(deps.credentials, next.modules)
  const model = buildPanelModel(deps.storage, next, deps.runtime, tokenState)
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

/**
 * Add a single workspace to the live config and rebuild services.
 *
 * Body shape:
 *   {
 *     action: 'add_workspace',
 *     name: string,            // workspace id (= TAPD module id)
 *     source: 'local' | 'git',
 *     path: string,            // absolute local dir or git URL
 *     tapdToken?: string,      // empty = use shell env
 *     gitlabToken?: string,    // empty = use shell env
 *   }
 *
 * Behaviour:
 *   - Validates name uniqueness (no overwrite of an existing module).
 *   - Merges the new module into `liveConfig.current.modules`.
 *   - If `tapdToken` / `gitlabToken` are non-empty, overrides the
 *     corresponding top-level token on the live config (per-workspace
 *     credential override — the top-level value remains the "default
 *     for any workspace that does not supply its own").
 *   - Stops old services, seeds the new module record, restarts.
 *   - Returns the same `{ ok, model, text }` shape as the full-config
 *     swap.
 */
async function handleAddWorkspace(
  payload: Record<string, unknown>,
  res: ServerResponse,
  deps: ReconfigureRouteDeps,
  logger: Logger,
): Promise<void> {
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  const source = payload.source === 'git' ? 'git' : 'local'
  const path = typeof payload.path === 'string' ? payload.path.trim() : ''
  const tapdToken = typeof payload.tapdToken === 'string' ? payload.tapdToken : ''
  const gitlabToken = typeof payload.gitlabToken === 'string' ? payload.gitlabToken : ''
  const tapdWorkspaceId = typeof payload.tapdWorkspaceId === 'string' ? payload.tapdWorkspaceId.trim() : ''
  const modelSelection =
    typeof payload.modelSelection === 'object' && payload.modelSelection !== null
      ? (payload.modelSelection as Record<string, string>)
      : {}

  if (!name || !path) {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        ok: false,
        error: 'invalid_workspace',
        message: 'name and path are required',
      }),
    )
    return
  }

  const current = deps.liveConfig.current
  if (current.modules.some((m) => m.id === name)) {
    res.statusCode = 409
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        ok: false,
        error: 'duplicate_workspace',
        message: `workspace "${name}" already exists; pick a different name or remove the existing one first`,
      }),
    )
    return
  }

  // Route both tokens through the credentials service BEFORE we
  // snapshot the new config or write the module record. The token
  // literal must never reach either location; only the ref name
  // (or, in the headless fallback branch, the literal itself) does.
  const tapdRoute = await routeTapdToken(tapdToken, name, deps.credentials, logger)
  const gitlabRoute = await routeGitlabToken(gitlabToken, name, deps.credentials, logger)

  // Translate the route outcome into the value the module record and
  // the live config will carry.
  //
  //   - `persisted`  -> ref name (no plaintext in storage / config).
  //   - `cleared`    -> ''.
  //   - `fallback`   -> literal (only in profiles without credentials).
  //   - `rejected`   -> '' (the user's previous value, if any, is kept
  //                     by `existing` upstream; we never overwrite a
  //                     good value with '' after a write failure).
  const persistedTapdToken = tapdRoute.kind === 'persisted' ? tapdRoute.refName : tapdRoute.kind === 'cleared' ? '' : tapdRoute.kind === 'fallback' ? tapdRoute.literal : ''
  const persistedGitlabToken = gitlabRoute.kind === 'persisted' ? gitlabRoute.refName : gitlabRoute.kind === 'cleared' ? '' : gitlabRoute.kind === 'fallback' ? gitlabRoute.literal : ''

  if (tapdRoute.kind === 'rejected' || gitlabRoute.kind === 'rejected') {
    const rejectedFields: string[] = []
    if (tapdRoute.kind === 'rejected') rejectedFields.push(`tapd: ${tapdRoute.error}`)
    if (gitlabRoute.kind === 'rejected') rejectedFields.push(`gitlab: ${gitlabRoute.error}`)
    res.statusCode = 422
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        ok: false,
        error: 'credential_write_rejected',
        message: `credentials service refused to store: ${rejectedFields.join('; ')}. ` +
          `If the matching DSH_* environment variable is set in the launching shell, unset it first.`,
      }),
    )
    return
  }

  const next: Config = {
    ...current,
    modules: [
      ...current.modules,
      {
        id: name,
        title: name,
        // The config schema requires repoUrl to be a valid URL. Local
        // paths are not URLs, so we record them on the module record
        // instead and keep `repoUrl` pointing at a synthetic local://
        // placeholder that satisfies the schema validator.
        repoUrl: source === 'git' ? path : 'local://' + name,
        defaultBranch: 'main',
        // Per-workspace overrides. Empty values inherit the global
        // config at use time (see tapd-poller / story-runner).
        tapdWorkspaceId,
        tapdApiToken: persistedTapdToken,
        gitlabApiToken: persistedGitlabToken,
        modelSelection,
      },
    ],
  }

  // Stop existing services BEFORE swapping the config so the poller
  // cannot observe a half-applied state.
  try {
    deps.stopServices(deps.currentServices)
  } catch (err) {
    logger.error(
      `[auto-rd] failed to stop old services during add_workspace: ${(err as Error).message}`,
    )
  }

  deps.liveConfig.current = next

  // Seed the new module record against the existing storage domain.
  const { resolve: pathResolve } = await import('node:path')
  try {
    await deps.storage.modules().put(name, {
      id: name,
      title: name,
      repoUrl: next.modules[next.modules.length - 1].repoUrl,
      defaultBranch: 'main',
      workspacePath: pathResolve(next.workspaceRoot || '.', name),
      createdAt: new Date().toISOString(),
      tapdWorkspaceId,
      tapdApiToken: persistedTapdToken,
      gitlabApiToken: persistedGitlabToken,
      modelSelection,
    })
  } catch (err) {
    logger.error(
      `[auto-rd] failed to seed module ${name}: ${(err as Error).message}`,
    )
  }

  // Adopt the module's directory as a DSH workspace (1:1 binding).
  // Only for a local path we can resolve to an absolute directory now —
  // a git URL has not been cloned yet, so the DSH workspace is created
  // later, when the clone lands (see workspace-manager). When the
  // controller is absent (headless profile) we skip silently.
  let dsWorkspaceId = ''
  if (source === 'local' && deps.workspaceController) {
    try {
      const absPath = pathResolve(path)
      const result = await deps.workspaceController.create({ path: absPath })
      dsWorkspaceId = result.workspace.workspaceId
      logger.info(
        `[auto-rd] adopted DSH workspace ${dsWorkspaceId} for module ${name} (${result.created ? 'created' : 'existing'})`,
      )
    } catch (err) {
      // Non-fatal: the auto-rd module still registers; the DSH binding
      // is retried on a later update_workspace.
      logger.warn(
        `[auto-rd] failed to adopt DSH workspace for module ${name}: ${(err as Error).message}`,
      )
    }
  }

  // Persist the DSH workspace binding if we got one.
  if (dsWorkspaceId) {
    try {
      const stored = deps.storage.modules().get(name)
      if (stored) {
        await deps.storage.modules().put(name, { ...stored, dsWorkspaceId })
      }
    } catch (err) {
      logger.warn(`[auto-rd] failed to persist dsWorkspaceId for ${name}: ${(err as Error).message}`)
    }
  }

  try {
    const newServices = deps.startServices(next)
    deps.currentServices = newServices
    newServices.queue.start()
    newServices.poller.start()
    newServices.notifier.start()
  } catch (err) {
    logger.error(
      `[auto-rd] failed to start new services during add_workspace: ${(err as Error).message}`,
    )
  }

  logger.info(
    `[auto-rd] workspace added: id=${name}, source=${source}, path="${path}", ` +
      `tapd-token: ${tapdToken ? 'set' : 'fallback'}, ` +
      `gitlab-token: ${gitlabToken ? 'set' : 'fallback'}`,
  )

  const tokenState = await resolveTokenStates(deps.credentials, next.modules)
  const model = buildPanelModel(deps.storage, next, deps.runtime, tokenState)
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(
    JSON.stringify(
      {
        ok: true,
        generatedAt: new Date().toISOString(),
        newModules: [{ id: name }],
        model,
        text: renderPanelText(model),
      },
      null,
      2,
    ),
  )
}

/**
 * Remove a single workspace from the live config and storage. Mirror
 * of `handleAddWorkspace` but in reverse — same stop / swap / restart
 * shape, but the new module list is the old one filtered by id.
 *
 * Body shape: { action: 'remove_workspace', name: string }
 *
 * The local git checkout is NOT touched. Removing the workspace only
 * un-registers it from auto-rd; the user can re-add it later.
 */
async function handleRemoveWorkspace(
  payload: Record<string, unknown>,
  res: ServerResponse,
  deps: ReconfigureRouteDeps,
  logger: Logger,
): Promise<void> {
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!name) {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        ok: false,
        error: 'invalid_workspace',
        message: 'name is required',
      }),
    )
    return
  }

  const current = deps.liveConfig.current
  if (!current.modules.some((m) => m.id === name)) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        ok: false,
        error: 'workspace_not_found',
        message: `workspace "${name}" does not exist`,
      }),
    )
    return
  }

  const next: Config = {
    ...current,
    modules: current.modules.filter((m) => m.id !== name),
  }

  try {
    deps.stopServices(deps.currentServices)
  } catch (err) {
    logger.error(
      `[auto-rd] failed to stop old services during remove_workspace: ${(err as Error).message}`,
    )
  }

  deps.liveConfig.current = next

  // Best-effort: drop the credentials this workspace owned, so a
  // future `add_workspace` with the same id starts from a clean
  // slate. `unset` is a no-op if the ref was never set, and the env-
  // var shadow (if any) is left in place — that's the launching
  // shell's problem, not ours.
  if (deps.credentials) {
    for (const ref of [tapdRefFor(name), gitlabRefFor(name)]) {
      try {
        await deps.credentials.unset(ref)
        logger.info(`[auto-rd] cleared credential ${ref} for removed workspace ${name}`)
      } catch (err) {
        logger.warn(
          `[auto-rd] failed to clear credential ${ref} for removed workspace ${name}: ${(err as Error).message}`,
        )
      }
    }
  }

  // Drop the storage records so the panel route's workspace and story
  // counts reflect the new state on the very next fetch. Stories are
  // keyed by moduleId; leaving them behind turns them into orphans the
  // panel silently filters out while storage keeps growing.
  try {
    deps.storage.modules().delete(name)
  } catch (err) {
    logger.error(
      `[auto-rd] failed to delete module ${name} from storage: ${(err as Error).message}`,
    )
  }
  try {
    for (const story of deps.storage.stories().values()) {
      if (story.moduleId === name) {
        deps.storage.stories().delete(story.id)
      }
    }
  } catch (err) {
    logger.error(
      `[auto-rd] failed to delete stories of module ${name} from storage: ${(err as Error).message}`,
    )
  }

  try {
    const newServices = deps.startServices(next)
    deps.currentServices = newServices
    newServices.queue.start()
    newServices.poller.start()
    newServices.notifier.start()
  } catch (err) {
    logger.error(
      `[auto-rd] failed to start new services during remove_workspace: ${(err as Error).message}`,
    )
  }

  logger.info(`[auto-rd] workspace removed: id=${name}`)

  const tokenState = await resolveTokenStates(deps.credentials, next.modules)
  const model = buildPanelModel(deps.storage, next, deps.runtime, tokenState)
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(
    JSON.stringify(
      {
        ok: true,
        generatedAt: new Date().toISOString(),
        removed: name,
        model,
        text: renderPanelText(model),
      },
      null,
      2,
    ),
  )
}

/**
 * Update an existing workspace's per-workspace settings in-place:
 * TAPD workspace id, TAPD token, GitLab token, and per-role model
 * selection. Any field omitted (or empty) is left unchanged — the UI
 * sends only what the user edited.
 *
 * Body shape:
 *   { action: 'update_workspace', name: string, tapdWorkspaceId?,
 *     tapdToken?, gitlabToken?, modelSelection? }
 *
 * Same stop / swap / restart shape as add/remove, then re-seeds the
 * module record in storage so the new values persist across restarts.
 */
async function handleUpdateWorkspace(
  payload: Record<string, unknown>,
  res: ServerResponse,
  deps: ReconfigureRouteDeps,
  logger: Logger,
): Promise<void> {
  const name = typeof payload.name === 'string' ? payload.name.trim() : ''
  if (!name) {
    res.statusCode = 400
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({ ok: false, error: 'invalid_workspace', message: 'name is required' }),
    )
    return
  }

  const current = deps.liveConfig.current
  const idx = current.modules.findIndex((m) => m.id === name)
  if (idx < 0) {
    res.statusCode = 404
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({ ok: false, error: 'workspace_not_found', message: `workspace "${name}" does not exist` }),
    )
    return
  }

  const existing = current.modules[idx]
  const tapdWorkspaceId =
    typeof payload.tapdWorkspaceId === 'string' && payload.tapdWorkspaceId.trim() !== ''
      ? payload.tapdWorkspaceId.trim()
      : existing.tapdWorkspaceId

  // For tokens, the payload distinguishes:
  //   - key absent (not sent)      -> keep existing (user did not touch the field)
  //   - key present, value === ''  -> CLEAR (route through credentials.unset)
  //   - key present, value !== ''  -> REPLACE (route through credentials.set)
  // The previous implementation conflated "key absent" with "key empty"
  // and silently dropped the user's intent to clear a token. That
  // bug (also surfaced via issue #10) is fixed here so the routeToken
  // helper can return a `cleared` outcome.
  const tapdTokenInput =
    'tapdToken' in payload && typeof payload.tapdToken === 'string'
      ? payload.tapdToken
      : undefined
  const gitlabTokenInput =
    'gitlabToken' in payload && typeof payload.gitlabToken === 'string'
      ? payload.gitlabToken
      : undefined

  const tapdRoute = await routeTapdToken(tapdTokenInput ?? '', name, deps.credentials, logger)
  const gitlabRoute = await routeGitlabToken(
    gitlabTokenInput ?? '',
    name,
    deps.credentials,
    logger,
  )

  // Translate the route outcome into the field value. `undefined`
  // means "the user did not touch this field, keep existing".
  let persistedTapdToken: string | undefined
  if (tapdTokenInput === undefined) {
    persistedTapdToken = existing.tapdApiToken
  } else if (tapdRoute.kind === 'persisted') {
    persistedTapdToken = tapdRoute.refName
  } else if (tapdRoute.kind === 'cleared') {
    persistedTapdToken = ''
  } else if (tapdRoute.kind === 'fallback') {
    persistedTapdToken = tapdRoute.literal
  } else {
    // rejected: leave the existing value intact, surface the error
    persistedTapdToken = existing.tapdApiToken
  }

  let persistedGitlabToken: string | undefined
  if (gitlabTokenInput === undefined) {
    persistedGitlabToken = existing.gitlabApiToken
  } else if (gitlabRoute.kind === 'persisted') {
    persistedGitlabToken = gitlabRoute.refName
  } else if (gitlabRoute.kind === 'cleared') {
    persistedGitlabToken = ''
  } else if (gitlabRoute.kind === 'fallback') {
    persistedGitlabToken = gitlabRoute.literal
  } else {
    persistedGitlabToken = existing.gitlabApiToken
  }

  if (tapdRoute.kind === 'rejected' || gitlabRoute.kind === 'rejected') {
    const rejectedFields: string[] = []
    if (tapdRoute.kind === 'rejected') rejectedFields.push(`tapd: ${tapdRoute.error}`)
    if (gitlabRoute.kind === 'rejected') rejectedFields.push(`gitlab: ${gitlabRoute.error}`)
    res.statusCode = 422
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(
      JSON.stringify({
        ok: false,
        error: 'credential_write_rejected',
        message: `credentials service refused to store: ${rejectedFields.join('; ')}. ` +
          `If the matching DSH_* environment variable is set in the launching shell, unset it first.`,
      }),
    )
    return
  }

  const modelSelection =
    typeof payload.modelSelection === 'object' && payload.modelSelection !== null
      ? { ...(existing.modelSelection ?? {}), ...(payload.modelSelection as Record<string, string>) }
      : existing.modelSelection

  const updatedModule = {
    ...existing,
    tapdWorkspaceId,
    tapdApiToken: persistedTapdToken,
    gitlabApiToken: persistedGitlabToken,
    modelSelection,
  }

  const next: Config = {
    ...current,
    modules: current.modules.map((m, i) => (i === idx ? updatedModule : m)),
  }

  try {
    deps.stopServices(deps.currentServices)
  } catch (err) {
    logger.error(`[auto-rd] failed to stop old services during update_workspace: ${(err as Error).message}`)
  }

  deps.liveConfig.current = next

  // Persist the updated module record back to storage.
  const stored = deps.storage.modules().get(name)
  if (stored) {
    try {
      await deps.storage.modules().put(name, {
        ...stored,
        tapdWorkspaceId,
        tapdApiToken: persistedTapdToken,
        gitlabApiToken: persistedGitlabToken,
        modelSelection,
      })
    } catch (err) {
      logger.error(`[auto-rd] failed to update module ${name} in storage: ${(err as Error).message}`)
    }
  }

  try {
    const newServices = deps.startServices(next)
    deps.currentServices = newServices
    newServices.queue.start()
    newServices.poller.start()
    newServices.notifier.start()
  } catch (err) {
    logger.error(`[auto-rd] failed to start new services during update_workspace: ${(err as Error).message}`)
  }

  logger.info(`[auto-rd] workspace updated: id=${name}`)

  const tokenState = await resolveTokenStates(deps.credentials, next.modules)
  const model = buildPanelModel(deps.storage, next, deps.runtime, tokenState)
  res.statusCode = 200
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(
    JSON.stringify(
      {
        ok: true,
        generatedAt: new Date().toISOString(),
        updated: name,
        model,
        text: renderPanelText(model),
      },
      null,
      2,
    ),
  )
}