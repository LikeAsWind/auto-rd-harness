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
import { ConfigSchema, type Config } from './config'
import { AutoRdStorage } from './domain/storage'
import { WorkspaceManager } from './services/workspace-manager'
import { TapdPoller } from './services/tapd-poller'
import { AgentProvider } from './services/agent-provider'
import { StoryRunner } from './services/story-runner'
import { StoryQueue } from './services/story-queue'
import { recoverStories } from './services/recover'
import { Logger } from './utils/logger'

/**
 * Cordis inject contract.
 *
 * DSH provides these services through the Cordis scope when the plugin
 * mounts. Anything not in this list is unavailable to the plugin body.
 */
export const inject = [
  'storageDomain',
  'workspaceRegistry',
  'timer',
  'web',
  'fs',
  'shell',
  'subprocess',
  'subagents',
  'agents',
  'sessionPersistence',
  'tools',
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
 */
export function apply(ctx: Context, rawConfig: unknown): void {
  // Validate config eagerly so failures show up at mount time, not at first poll.
  const config = ConfigSchema.parse(rawConfig)
  const logger = new Logger(ctx, config.logLevel)

  logger.info('='.repeat(60))
  logger.info('M1 plugin starting up')
  logger.info(`  modules: ${config.modules.map((m) => m.id).join(', ') || '(none configured)'}`)
  logger.info(`  workspaceRoot: ${config.workspaceRoot}`)
  logger.info(`  pollIntervalMs: ${config.tapdPollIntervalMs}`)
  logger.info('='.repeat(60))

  if (!config.tapdApiToken) {
    logger.warn('tapdApiToken is empty — M1 uses mock fixtures, but production needs a real token')
  }

  // 1. Storage
  const storageDomain = ctx.get('storageDomain' as never) as unknown as ConstructorParameters<typeof AutoRdStorage>[1]
  const storage = new AutoRdStorage(ctx, storageDomain)

  // 2. Seed module records from config (idempotent).
  for (const m of config.modules) {
    const existing = storage.modules().get(m.id)
    if (existing) continue
    void storage.modules().put(m.id, {
      id: m.id,
      title: m.title,
      repoUrl: m.repoUrl,
      defaultBranch: m.defaultBranch,
      workspacePath: resolve(config.workspaceRoot, m.id),
      createdAt: new Date().toISOString(),
    })
  }

  // 3. Services
  const workspaceManager = new WorkspaceManager(ctx, { storage, logger, config })
  const agentProvider = new AgentProvider(ctx, { logger, config })
  const runner = new StoryRunner(ctx, { storage, logger, config, workspaceManager, agentProvider })
  const queue = new StoryQueue(ctx, { storage, logger, config, runner })
  const poller = new TapdPoller(ctx, { storage, logger, config })

  // 4. Recover any in-flight stories from a previous run. We do this BEFORE
  // starting timers so StoryQueue picks them up cleanly on its first tick.
  // Fire-and-log; failure here must not block plugin mount.
  void recoverStories(storage, logger).catch((err) => {
    logger.error(`[auto-rd] recoverStories failed: ${(err as Error).message}`)
  })

  // 5. Start timers via Cordis effect for proper cleanup on plugin disable.
  ctx.effect(() => {
    queue.start()
    poller.start()
    logger.info('[auto-rd] M1 plugin mounted — poller + queue running')

    return () => {
      logger.info('[auto-rd] M1 plugin unmounting — stopping timers')
      queue.stop()
      poller.stop()
    }
  }, 'auto-rd:m1:timers')
}