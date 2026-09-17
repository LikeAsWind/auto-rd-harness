/**
 * Plugin configuration schema (zod).
 *
 * This is the runtime contract: every field here maps to one key in the
 * cordis.yml `config:` block, validated when the plugin mounts.
 *
 * DESIGN NOTE — "missing config must not block the UI":
 *
 * Every previously-required field is now OPTIONAL with a sensible empty
 * default so the plugin MOUNTS even when the user has not filled in
 * tokens, modules, or a workspace path. A mount failure would prevent
 * the sidebar panel from ever appearing in the DSH web UI; instead we
 * mount, log a warning, and surface a setup checklist in the panel so
 * the user sees exactly what is missing.
 *
 * Concrete behaviour with empty config:
 *
 *   - `tapdApiToken` empty + `useTapdMock=false` → poller skips real HTTP
 *     and falls back to the mock fixture (also useful for offline dev).
 *     If `useTapdMock` is left at default `false`, we force it to
 *     `true` when there is no token, because production hits with an
 *     empty bearer token would just 401.
 *   - `gitlabApiToken` empty → StoryRunner's `mr_creating` stage will
 *     fail loudly per-story; `auto_rd_status` reports it. The plugin
 *     itself still mounts.
 *   - `workspaceRoot` empty → no module clones, no per-module worktrees;
 *     the UI shows the setup checklist.
 *   - `modules` empty → no polling happens (no TAPD workspace to map to);
 *     the UI shows the setup checklist.
 *
 * All of these surface in the panel route's response as a
 * `health` block; the client renders it as a "what's missing" section.
 */
import { z } from 'zod'

export const ModelSelectionSchema = z.object({
  brainstorm: z.string().default('sonnet'),
  critic: z.string().default('sonnet'),
  decision: z.string().default('sonnet'),
  spec: z.string().default('sonnet'),
  planner: z.string().default('sonnet'),
  implementation: z.string().default('haiku'),
  test: z.string().default('sonnet'),
  fix: z.string().default('sonnet'),
  verification: z.string().default('sonnet'),
  review: z.string().default('sonnet'),
  finalVerify: z.string().default('opus'),
})

export const ModuleConfigSchema = z.object({
  id: z.string().min(1).describe('Stable identifier used as workspace directory name and story module key'),
  title: z.string().describe('Human-readable title shown in the sidebar'),
  repoUrl: z.string().url().describe('Git URL of the module repository'),
  defaultBranch: z.string().default('main').describe('Branch that PRs target'),
  /**
   * TAPD workspace id this module polls from (1:1). Optional — when
   * empty the module is skipped by the poller. The old global
   * `tapdWorkspaceIds` array is superseded by this per-module field.
   */
  tapdWorkspaceId: z.string().default('').optional(),
  /**
   * Per-workspace TAPD API token. Optional — when empty, the poller
   * falls back to the top-level `tapdApiToken`. A workspace with its
   * own token talks to TAPD with that identity; one without it inherits
   * the global value (or the mock fixture when neither is set).
   */
  tapdApiToken: z.string().default('').optional(),
  /**
   * Per-workspace GitLab API token. Optional — empty means "use the
   * top-level `gitlabApiToken`". Same inheritance rule as TAPD.
   */
  gitlabApiToken: z.string().default('').optional(),
  /**
   * Per-workspace model selection. Optional — a PARTIAL map of role →
   * model; each role falls back to the top-level `modelSelection` when
   * absent. Stored as a free-form record so a workspace can pin just
   * one role (e.g. implementation → haiku) without repeating the rest.
   */
  modelSelection: z.record(z.string(), z.string()).default({}).optional(),
})

export const ConfigSchema = z.object({
  // TAPD integration
  tapdBaseUrl: z.string().url().default('https://api.tapd.cn'),
  /**
   * TAPD API token. Optional — when empty, the poller falls back to the
   * local mock fixture regardless of `useTapdMock`. The env var
   * `DSH_TAPD_API_TOKEN` is the documented place to set this (the
   * example cordis.yml wires it via `!!js`).
   */
  tapdApiToken: z.string().default(''),
  tapdPollIntervalMs: z.number().int().positive().default(60_000),
  /**
   * TAPD workspace_id. Required when useMock=false AND a real token is
   * configured. Multiple workspaces can be polled by providing a
   * comma-separated list (the poller iterates). Empty by default — the
   * poller simply does nothing when there is nothing to route to.
   */
  tapdWorkspaceIds: z.array(z.string()).default([]),
  /**
   * When true, the poller returns the local MOCK_TAPD_FIXTURE instead of
   * calling TAPD. The plugin auto-elevates this to true when
   * `tapdApiToken` is empty, so production never hits TAPD with an
   * empty bearer header.
   */
  useTapdMock: z.boolean().default(false),

  // GitLab integration
  gitlabBaseUrl: z.string().url().default('https://gitlab.com'),
  /**
   * GitLab API token. Optional — when empty, MR creation in the runner
   * will fail loudly per story; the plugin still mounts.
   */
  gitlabApiToken: z.string().default(''),
  /**
   * Optional override for git's HTTP user-agent when pushing. Some GitLab
   * setups want a specific identity in the commit author line; default
   * 'auto-rd' is fine for most.
   */
  gitlabPushUserName: z.string().default('auto-rd'),
  gitlabPushUserEmail: z.string().default('auto-rd@example.com'),

  // Workspace
  /**
   * Absolute path where module repos are cloned. Optional — when empty
   * the UI shows the setup checklist. The runner will refuse to create
   * worktrees until this is set; auto_rd_status reports each blocked
   * story with the reason "workspace_root_not_configured".
   */
  workspaceRoot: z.string().default(''),

  // Module-to-repo mapping
  modules: z.array(ModuleConfigSchema).default([]),

  // Concurrency limits
  maxConcurrentStoriesPerModule: z.number().int().positive().default(1),
  maxTotalConcurrentStories: z.number().int().positive().default(4),

  // Model selection per role
  modelSelection: ModelSelectionSchema.default({}),

  // Logging
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type Config = z.infer<typeof ConfigSchema>
export type ModuleConfig = z.infer<typeof ModuleConfigSchema>
export type ModelSelection = z.infer<typeof ModelSelectionSchema>

/**
 * Normalise a parsed config: when `tapdApiToken` is empty, force
 * `useTapdMock` to true so the poller never makes a 401-bound HTTP
 * call. Pure function — same input always produces same output.
 *
 * The original `Config` is otherwise passed through unchanged.
 */
export function normalizeConfig(config: Config): Config {
  if (!config.tapdApiToken && !config.useTapdMock) {
    return { ...config, useTapdMock: true }
  }
  return config
}