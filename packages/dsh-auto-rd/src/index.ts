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
import { StoryNotifierService } from './services/story-notifier.js'
import { TrajectoryRecorder } from './services/trajectory.js'
import { registerAutoRdPanel } from './services/ui-panel.js'
import { registerPanelRoute } from './services/panel-route.js'
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
 * means the plugin never mounts. Two corrections were made after that
 * check:
 *
 *   - `slots` was REMOVED. It is not a host service at all — slots are
 *     a client-realm concern (see services/ui-panel.ts). Declaring it
 *     here would have blocked the plugin from ever mounting.
 *   - `workspaceRegistry`, `timer`, `fs`, `shell`, `subprocess`,
 *     `agents` and `sessionPersistence` were REMOVED because nothing in
 *     the plugin reads them; they were dead wait-conditions.
 *
 * The remaining five are all used and all verified present.
 */
export const inject = [
  'storageDomain',
  'subagents',
  'tools',
  'systemPrompt',
  'sessions',
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
  const config = ConfigSchema.parse(rawConfig)
  const logger = new Logger(ctx, config.logLevel)

  logger.info('='.repeat(60))
  logger.info('auto-rd plugin starting up')
  logger.info(`  modules: ${config.modules.map((m) => m.id).join(', ') || '(none configured)'}`)
  logger.info(`  workspaceRoot: ${config.workspaceRoot}`)
  logger.info(`  pollIntervalMs: ${config.tapdPollIntervalMs}`)
  logger.info(`  useTapdMock: ${config.useTapdMock}`)
  logger.info('='.repeat(60))

  if (!config.tapdApiToken) {
    logger.warn('tapdApiToken is empty — the poller will use the mock fixture, but production needs a real token')
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

  // 3. Services
  const trajectory = new TrajectoryRecorder(ctx, { storage, logger })
  const workspaceManager = new WorkspaceManager(ctx, { storage, logger, config })
  const agentProvider = new AgentProvider(ctx, { logger, config, trajectory })
  const runner = new StoryRunner(ctx, { storage, logger, config, workspaceManager, agentProvider, trajectory })
  const queue = new StoryQueue(ctx, { storage, logger, config, runner })
  const poller = new TapdPoller(ctx, { storage, logger, config })
  const notifier = new StoryNotifierService(ctx, { storage, logger })

  // 4. Recover any in-flight stories from a previous run. We do this BEFORE
  // starting timers so StoryQueue picks them up cleanly on its first tick.
  // Fire-and-log; failure here must not block plugin mount.
  void recoverStories(storage, logger, trajectory).catch((err) => {
    logger.error(`[auto-rd] recoverStories failed: ${(err as Error).message}`)
  })

  // 5. Start timers via Cordis effect for proper cleanup on plugin disable.
  ctx.effect(() => {
    queue.start()
    poller.start()
    notifier.start()
    logger.info('[auto-rd] plugin mounted — poller + queue + notifier running')

    return () => {
      logger.info('[auto-rd] plugin unmounting — stopping timers')
      queue.stop()
      poller.stop()
      notifier.stop()
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
          pollNow: () => poller.tick(),
          advanceStory: (storyId) => runner.runStory(storyId),
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
    // panel data so that client half has something to read.
    registerAutoRdPanel(ctx, { storage, logger })
    registerPanelRoute(ctx, { storage, logger })

    return () => {
      // Cordis tears down tool / prompt registrations when the parent
      // ctx disposes; explicit cleanup is unnecessary here.
    }
  }, 'auto-rd:ui')
}