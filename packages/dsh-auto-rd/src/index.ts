/**
 * @yangzhitong/dsh-auto-rd — plugin entrypoint.
 *
 * This file is the single source of truth for what auto-rd registers on
 * mount. It is what DSH loads when it encounters the `- id: auto-rd` row
 * in the user's cordis.patch.yml.
 *
 * Plugin lifecycle (Cordis):
 *   1. DSH reads ~/.dsh/profiles/web/cordis.patch.yml
 *   2. For each row, DSH resolves `name:` to a package, requires it, and
 *      calls the exported `apply(ctx, config)` function.
 *   3. Inside apply() we register services, schedule timers, and return.
 *
 * M1 mount plan:
 *   - Build the storageDomain wrapper
 *   - Seed module records from config
 *   - Construct TapdPoller + StoryQueue + StoryRunner + AgentProvider +
 *     WorkspaceManager, threading dependencies
 *   - Start the timers
 *   - Log "[auto-rd] M1 plugin mounted" so we can verify in the DSH logs
 *
 * If anything in apply() throws, Cordis will mark the plugin as failed and
 * emit a `[cordis:auto-rd]` error to the host log. That's what we want —
 * fast, visible failure rather than silent partial mount.
 */
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ConfigSchema, type Config } from './config.js'
import { AutoRdStorage } from './domain/storage.js'
import { WorkspaceManager } from './services/workspace-manager.js'
import { TapdPoller } from './services/tapd-poller.js'
import { AgentProvider } from './services/agent-provider.js'
import { StoryRunner } from './services/story-runner.js'
import { StoryQueue } from './services/story-queue.js'
import { recoverStories } from './services/recover.js'
import { migrateStorageToCredentials } from './services/migrate-storage-credentials.js'
import { StoryNotifierService } from './services/story-notifier.js'
import { TrajectoryRecorder } from './services/trajectory.js'
import { registerAutoRdPanel } from './services/ui-panel.js'
import { registerPanelRoute, registerPanelRouteWithRetry } from './services/panel-route.js'
import { registerStoryTrajectoryRouteWithRetry } from './services/story-trajectory-route.js'
import type { RuntimeStats, WorkspacePollStat } from './services/poll-stats.js'
import { registerReconfigureRoute } from './services/reconfigure-route.js'
import { registerPickDirectoryRoute } from './services/pick-directory-route.js'
import { registerAutoRdPromptSection } from './services/system-prompt-section.js'
import { autoRdStatusTool } from './tools/auto-rd-status.js'
import { autoRdTriggerTool } from './tools/auto-rd-trigger.js'
import { autoRdRetryTool } from './tools/auto-rd-retry.js'
import type { ToolsService, StorageDomainService, ToolDefinition } from './types/dsh-services.js'
import { Logger } from './utils/logger.js'

/**
 * Cordis inject contract — the HARD dependencies this plugin needs
 * before it can mount.
 *
 * Every entry here was checked against the live host service catalog.
 * `inject` is a hard-dependency list: Cordis holds the plugin until each
 * named service appears, so naming a service the host never provides
 * means the plugin never mounts. Notes:
 *
 *   - `slots` was REMOVED. It is not a host service at all — slots are
 *     a client-realm concern (see src/client/client.js). Declaring it
 *     here would have blocked the plugin from ever mounting.
 *   - `workspaceRegistry`, `timer`, `fs`, `shell`, `subprocess`,
 *     and `sessionPersistence` were REMOVED because nothing in
 *     the plugin reads them; they were dead wait-conditions.
 *   - `agents` was re-added (Block A) so the runner can resolve the
 *     story's parent Agent when spawning role subagents.
 *   - `webServer` is OPTIONAL. The web profile ships
 *     `@deepseek-ai/dsh-host-webserver` and exposes the host HTTP server;
 *     the headless / sdk / acp profiles do not. Listing it here would
 *     block the plugin in headless deployments, so we wait for it via an
 *     effect instead (see `registerPanelRoute` + `subscribeWebServer`).
 *     The client-side panel `fetch('/auto-rd/panel')` only works when
 *     the web server actually mounts; `auto_rd_status` stays reachable
 *     either way.
 *
 * The remaining five are all used and all verified present.
 */
export const inject = [
  'storageDomain',
  'subagents',
  'agents',
  'tools',
  'systemPrompt',
  'sessions',
  'sessionTitle',
  'workspaceController',
] as const

/**
 * Runtime schema for the plugin's row config. Validated before apply() runs.
 *
 * NOTE: We re-export the schema as `ConfigSchema` (not `Config`) to avoid
 * clashing with the `Config` type re-exported from ./config. Mixed
 * type+const declarations of the same name are not allowed.
 */
export { ConfigSchema }

export type { Config as PluginConfig }

/**
 * Apply — called once per process by DSH at startup.
 *
 * Async because `storageDomain.open()` is async: there is no
 * synchronous way to obtain the domain handle, and every service below
 * depends on it. Cordis awaits the returned promise before considering
 * the plugin mounted, so a storage failure surfaces as a mount failure
 * rather than as a half-initialised plugin.
 */
export async function apply(ctx: Context, rawConfig: unknown): Promise<void> {
  // Validate config eagerly so failures show up at mount time, not at first poll.
  // The schema accepts every field as optional with friendly defaults
  // (see config.ts) so the plugin MOUNTS even on a bare config; the UI then
  // shows a setup checklist instead of going dark.
  const parsed = ConfigSchema.parse(rawConfig)
  const config = parsed
  const logger = new Logger(ctx, config.logLevel)

  logger.info('='.repeat(60))
  logger.info('auto-rd plugin starting up')
  logger.info(`  modules: ${config.modules.map((m) => m.id).join(', ') || '(none configured)'}`)
  logger.info(`  workspaceRoot: ${config.workspaceRoot || '(not configured)'}`)
  logger.info(`  pollIntervalMs: ${config.tapdPollIntervalMs}`)
  logger.info('='.repeat(60))

  // Log every missing piece at WARN level. None of these aborts the mount:
  // the UI will surface them again as a setup checklist via /auto-rd/panel.
  if (!config.tapdApiToken) {
    logger.warn('tapdApiToken is empty — set DSH_TAPD_API_TOKEN or a per-workspace token to poll real TAPD.')
  }
  if (!config.gitlabApiToken) {
    logger.warn('gitlabApiToken is empty — MR creation will fail per story. Set DSH_GITLAB_API_TOKEN to enable MRs.')
  }
  if (!config.workspaceRoot) {
    logger.warn('workspaceRoot is empty — no module repos will be cloned. Set workspaceRoot in cordis.patch.yml.')
  }
  if (config.modules.length === 0) {
    logger.warn('modules is empty — nothing to poll. Add at least one module under config.modules in cordis.patch.yml.')
  }

  // 1. Storage. `storageDomain` is declared in `inject`, so Cordis has
  // already guaranteed it exists by the time apply() runs; the explicit
  // check documents that invariant and gives a clear error if the
  // declaration and the runtime ever disagree.
  const storageDomain = ctx.get('storageDomain' as never) as unknown as
    | StorageDomainService
    | undefined
  if (!storageDomain) {
    throw new Error(
      'auto-rd: storageDomain is declared in `inject` but was not resolvable at mount time',
    )
  }
  const storage = await AutoRdStorage.open(ctx, storageDomain)

  // The caller owns the domain handle. Release it when this plugin's
  // fiber is disposed so a reload does not leave the domain open (which
  // would make the next mount fail with `already-open`).
  ctx.effect(() => {
    return () => {
      void storage.close().catch((err: unknown) => {
        logger.error(`[auto-rd] failed to close storage domain: ${(err as Error).message}`)
      })
    }
  }, 'auto-rd:storage')

  // 2. Seed module records from config (idempotent).
  for (const m of config.modules) {
    const existing = storage.modules().get(m.id)
    if (existing) continue
    await storage.modules().put(m.id, {
      id: m.id,
      title: m.title,
      repoUrl: m.repoUrl,
      defaultBranch: m.defaultBranch,
      workspacePath: resolve(config.workspaceRoot, m.id),
      createdAt: new Date().toISOString(),
    })
  }

  // 3. Services + runtime stats. We rebuild these on every reconfigure
  // so editing cordis.patch.yml (or posting a new config to the
  // `/auto-rd/reconfigure` route) takes effect without restarting DSH.
  //
  // `liveConfig` is the single source of truth that the panel route +
  // reconfigure route read from. It starts as the parsed-once config
  // and gets replaced whenever the user re-runs setup.
  const liveConfig: { current: Config } = { current: config }
  const runtime: RuntimeStats = {
    mountedAt: new Date(),
    lastTapdPollAt: null,
    lastTapdError: null,
    pollStats: new Map<string, WorkspacePollStat>(),
  }

  // Resolve the DSH credentials service ONCE at mount time. The
  // service may be absent in headless profiles (no
  // dsh-credentials-local mounted); the rest of the plugin tolerates
  // `undefined` and falls back to the pre-#10 plaintext path.
  const credentials = ctx.get('credentials' as never) as
    | import('./types/dsh-services.js').CredentialsService
    | undefined

  const services = startServices(ctx, storage, logger, liveConfig.current, runtime, credentials)

  // 3.5. Migrate legacy plaintext tokens from storage into the DSH
  // credentials store (issue #10). Pre-#10 builds wrote the user's
  // token directly into module.tapdApiToken / module.gitlabApiToken /
  // config.tapdApiToken / config.gitlabApiToken. After this migration
  // those fields hold reference names and the literal lives in
  // `~/.dsh/.credentials.yaml`. The migration is idempotent and
  // best-effort — a missing credentials service is a no-op.
  void migrateStorageToCredentials(
    storage,
    liveConfig.current,
    credentials,
    logger,
  )
    .then((report) => {
      const summary: string[] = []
      if (report.modulesTouched.length > 0) {
        summary.push(`${report.modulesTouched.length} module(s): ${report.modulesTouched.join(', ')}`)
      }
      if (report.globalTokensTouched.tapd) summary.push('global tapd token')
      if (report.globalTokensTouched.gitlab) summary.push('global gitlab token')
      if (report.skipped.length > 0) {
        summary.push(`skipped ${report.skipped.length}: ${report.skipped.map((s) => s.ref).join(', ')}`)
      }
      if (summary.length > 0) {
        logger.info(`[auto-rd] credentials migration: ${summary.join('; ')}`)
      } else {
        logger.info('[auto-rd] credentials migration: nothing to do')
      }
    })
    .catch((err) => {
      logger.error(`[auto-rd] credentials migration failed: ${(err as Error).message}`)
    })

  // 4. Recover any in-flight stories from a previous run. We do this BEFORE
  // starting timers so StoryQueue picks them up cleanly on its first tick.
  // Fire-and-log; failure here must not block plugin mount.
  //
  // The orphan-cleanup pass needs the live module id set so it knows
  // which stories are unreachable. We pass `liveConfig.current.modules`
  // (the authoritative set the poller / queue / runner use); any story
  // whose moduleId is not in this set is dropped.
  const liveModuleIds = new Set(liveConfig.current.modules.map((m) => m.id))
  void recoverStories(storage, logger, liveModuleIds, services.trajectory).catch((err) => {
    logger.error(`[auto-rd] recoverStories failed: ${(err as Error).message}`)
  })

  // 5. Start timers via Cordis effect for proper cleanup on plugin disable.
  ctx.effect(() => {
    services.queue.start()
    services.poller.start()
    services.notifier.start()
    logger.info('[auto-rd] plugin mounted — poller + queue + notifier running')

    return () => {
      logger.info('[auto-rd] plugin unmounting — stopping timers')
      services.queue.stop()
      services.poller.stop()
      services.notifier.stop()
    }
  }, 'auto-rd:timers')

  // 6. Register the prompt section and tools. Each is best-effort: if
  // the underlying DSH service is unavailable we log a warning and move
  // on, because the plugin still drives stories without them.
  //
  // Registration also happens per-tool so one rejected definition cannot
  // take the others down with it.
  ctx.effect(() => {
    registerAutoRdPromptSection(ctx)

    const tools = ctx.get('tools') as ToolsService | undefined
    if (!tools) {
      logger.warn('[auto-rd] tools service unavailable — model will not see auto-rd tools')
      return () => {}
    }

    const definitions: Array<[string, ToolDefinition]> = [
      ['auto_rd_status', autoRdStatusTool({ storage, logger }) as ToolDefinition],
      [
        'auto_rd_trigger',
        autoRdTriggerTool({
          storage,
          logger,
          pollNow: () => services.poller.tick(),
          advanceStory: (storyId) => services.runner.runStory(storyId),
        }) as ToolDefinition,
      ],
      ['auto_rd_retry', autoRdRetryTool({ storage, logger }) as ToolDefinition],
    ]

    const registered: string[] = []
    for (const [name, definition] of definitions) {
      try {
        tools.register(definition)
        registered.push(name)
      } catch (err) {
        // A rejected definition (bad schema, duplicate name, missing
        // output contract) must not stop the pipeline from running.
        logger.error(`[auto-rd] failed to register tool ${name}: ${(err as Error).message}`)
      }
    }
    logger.info(`[auto-rd] registered tools: ${registered.join(' / ') || '(none)'}`)

    // Report the UI situation (see ui-panel.ts: the sidebar panel is a
    // client-side contribution) and, when a web server exists, serve the
    // panel data so that client half has something to read. We split the
    // two so the panel route can wait for the optional `webServer` host
    // service without ever blocking plugin mount in headless deployments.
    // We pass the LIVE config (mutable reference) so when the user
    // re-runs setup via /auto-rd/reconfigure, the next panel fetch
    // reflects the new state without re-binding the route.
    registerAutoRdPanel(ctx, { storage, logger, config: liveConfig.current })

    // Panel route — `webServer` is OPTIONAL (only the web profile ships
    // it). The plugin does NOT block on it; instead we attempt the route
    // registration now, and if the service is missing we poll every
    // WEBSERVER_RETRY_MS until it appears (or we hit a cap). In headless
    // profiles the service never appears, the cap is reached, and we stop
    // logging. `auto_rd_status` keeps working either way.
    //
    // The retry helper's disposer aborts the polling loop and (on success)
    // unregisters the route, so we hand it to `ctx.effect` for fiber-lifetime
    // cleanup.
    const WEBSERVER_RETRY_MS = 1000
    const WEBSERVER_RETRY_CAP = 10
    ctx.effect(() => {
      const disposeRoute = registerPanelRouteWithRetry(ctx, {
        storage,
        logger,
        getConfig: () => liveConfig.current,
        runtime,
        credentials,
        retryMs: WEBSERVER_RETRY_MS,
        maxAttempts: WEBSERVER_RETRY_CAP,
      })
      return () => {
        disposeRoute()
      }
    }, 'auto-rd:web-server-route')

    // Story trajectory route — GET /auto-rd/story/<id>. Serves one
    // story's execution log on demand (the detail view fetches it when
    // opened, so the hot 5s panel poll stays lean). Same optional-webServer
    // pattern as the panel route.
    ctx.effect(() => {
      const disposeTrajectory = registerStoryTrajectoryRouteWithRetry(ctx, {
        storage,
        logger,
        retryMs: WEBSERVER_RETRY_MS,
        maxAttempts: WEBSERVER_RETRY_CAP,
      })
      return () => {
        disposeTrajectory()
      }
    }, 'auto-rd:story-trajectory-route')

    // Reconfigure route — POST /auto-rd/reconfigure with a JSON
    // { config: { ... } } body. The handler validates + swaps the live
    // config, rebuilds the timer-driven services, re-seeds modules, and
    // returns the new health snapshot so the client can update in one
    // round-trip. Also served under the optional webServer (same pattern
    // as the panel route).
    ctx.effect(() => {
      // DSH workspace + session-title services. Both are declared in
      // `inject`, so `ctx.get()` resolves them; absent in headless
      // profiles (inject would block mount there, so this web-only path
      // is guarded by the effect being inside the web UI branch).
      let workspaceController: import('./types/dsh-services.js').WorkspaceControllerService | undefined
      let sessionTitle: import('./types/dsh-services.js').SessionTitleService | undefined
      try {
        workspaceController = ctx.get('workspaceController' as never) as
          | import('./types/dsh-services.js').WorkspaceControllerService
          | undefined
      } catch {
        workspaceController = undefined
      }
      try {
        sessionTitle = ctx.get('sessionTitle' as never) as
          | import('./types/dsh-services.js').SessionTitleService
          | undefined
      } catch {
        sessionTitle = undefined
      }

      const dispose = registerReconfigureRoute(ctx, {
        storage,
        logger,
        liveConfig,
        runtime,
        startServices: (cfg) => startServices(ctx, storage, logger, cfg, runtime, credentials),
        stopServices: (svcs) => {
          svcs.queue.stop()
          svcs.poller.stop()
          svcs.notifier.stop()
        },
        currentServices: services,
        workspaceController,
        sessionTitle,
        credentials,
      })
      return () => {
        if (dispose) dispose()
      }
    }, 'auto-rd:reconfigure-route')

    // Pick-directory route — GET/POST /auto-rd/pick-directory.
    // Bridges the browser-side "Browse" button to DSH's host-side
    // directoryPicker service, which calls the OS native chooser
    // (koffi+COM on Windows, osascript on macOS, zenity on Linux).
    // Falls back gracefully when the service is unavailable (logged
    // on the host, surfaced in the UI as a tooltip).
    ctx.effect(() => {
      const dispose = registerPickDirectoryRoute(ctx, logger)
      return () => {
        if (dispose) dispose()
      }
    }, 'auto-rd:pick-directory-route')

    return () => {
      // Cordis tears down tool / prompt registrations when the parent
      // ctx disposes; explicit cleanup is unnecessary here.
    }
  }, 'auto-rd:ui')
}

/**
 * Build a fresh batch of runtime services against a given config.
 *
 * Used twice:
 *  1. Initial mount in `apply()` — wired up to the first `services`
 *     ref captured by the timers effect.
 *  2. Every reconfigure — the new batch replaces `currentServices` on
 *     `ReconfigureRouteDeps`, and the new timers (started by the route
 *     handler) use the new poller/queue/notifier references.
 *
 * The poller is bound to `runtime` via `onTickEnd`, so the panel route
 * keeps showing fresh stats across reconfigures.
 */
function startServices(
  ctx: Context,
  storage: AutoRdStorage,
  logger: Logger,
  config: Config,
  runtime: RuntimeStats,
  credentials: import('./types/dsh-services.js').CredentialsService | undefined,
): {
  trajectory: TrajectoryRecorder
  workspaceManager: WorkspaceManager
  agentProvider: AgentProvider
  runner: StoryRunner
  queue: StoryQueue
  poller: TapdPoller
  notifier: StoryNotifierService
} {
  const trajectory = new TrajectoryRecorder(ctx, { storage, logger })
  const workspaceManager = new WorkspaceManager(ctx, { storage, logger, config })
  const agentProvider = new AgentProvider(ctx, { logger, config, trajectory })
  // DSH session services — declared in `inject`, so `ctx.get()` works.
  const sessions = ctx.get('sessions' as never) as
    | import('./types/dsh-services.js').SessionsService
    | undefined
  const sessionTitle = ctx.get('sessionTitle' as never) as
    | import('./types/dsh-services.js').SessionTitleService
    | undefined
  // Live agent registry (`ctx.agents`) — the runner needs it to resolve
  // the story's parent Agent when spawning role subagents. Declared in
  // `inject`; may still be absent in headless profiles.
  const agents = ctx.get('agents' as never) as
    | import('./types/dsh-services.js').AgentsService
    | undefined
  const runner = new StoryRunner(ctx, {
    storage,
    logger,
    config,
    workspaceManager,
    agentProvider,
    trajectory,
    sessions,
    sessionTitle,
    agents,
    credentials,
  })
  const queue = new StoryQueue(ctx, { storage, logger, config, runner })
  const poller = new TapdPoller(ctx, {
    storage,
    logger,
    config,
    credentials,
    onTickEnd: ({ at, error, results }) => {
      runtime.lastTapdPollAt = at
      runtime.lastTapdError = error ? error.message : null
      const stats = runtime.pollStats ?? new Map<string, WorkspacePollStat>()
      runtime.pollStats = stats
      for (const r of results) {
        const prev = stats.get(r.moduleId)
        stats.set(r.moduleId, {
          moduleId: r.moduleId,
          lastAttemptAt: at,
          // On error keep the previous success timestamp so the panel
          // can say "last synced at X" even while the latest attempt
          // failed.
          lastSuccessAt: r.error ? (prev?.lastSuccessAt ?? null) : at,
          lastError: r.error,
          lastNewCount: r.error ? (prev?.lastNewCount ?? 0) : r.newCount,
          intervalMs: config.tapdPollIntervalMs,
        })
      }
    },
  })
  const notifier = new StoryNotifierService(ctx, { storage, logger })
  return { trajectory, workspaceManager, agentProvider, runner, queue, poller, notifier }
}