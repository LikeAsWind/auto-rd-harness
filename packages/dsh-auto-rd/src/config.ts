/**
 * Plugin configuration schema (zod).
 *
 * This is the runtime contract: every field here maps to one key in the
 * cordis.yml `config:` block, validated when the plugin mounts.
 */
import { z } from 'zod'

export const ModuleConfigSchema = z.object({
  id: z.string().min(1).describe('Stable identifier used as workspace directory name and story module key'),
  title: z.string().describe('Human-readable title shown in the sidebar'),
  repoUrl: z.string().url().describe('Git URL of the module repository'),
  defaultBranch: z.string().default('main').describe('Branch that PRs target'),
})

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

export const ConfigSchema = z.object({
  // TAPD integration
  tapdBaseUrl: z.string().url().default('https://api.tapd.cn'),
  tapdApiToken: z.string().describe('TAPD API token. Required to fetch stories.'),
  tapdPollIntervalMs: z.number().int().positive().default(60_000),
  /**
   * TAPD workspace_id. Required when useMock=false. Multiple workspaces can
   * be polled by providing a comma-separated list (the poller iterates).
   */
  tapdWorkspaceIds: z.array(z.string()).default([]),
  /**
   * When true, the poller returns the local MOCK_TAPD_FIXTURE instead of
   * calling TAPD. Useful for offline development and the test suite.
   * Default false: production deployments must hit real TAPD.
   */
  useTapdMock: z.boolean().default(false),

  // GitLab integration
  gitlabBaseUrl: z.string().url().default('https://gitlab.com'),
  gitlabApiToken: z.string().describe('GitLab API token with api scope.'),
  /**
   * Optional override for git's HTTP user-agent when pushing. Some GitLab
   * setups want a specific identity in the commit author line; default
   * 'auto-rd' is fine for most.
   */
  gitlabPushUserName: z.string().default('auto-rd'),
  gitlabPushUserEmail: z.string().default('auto-rd@example.com'),

  // Workspace
  workspaceRoot: z.string().describe('Absolute path where module repos are cloned.'),

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