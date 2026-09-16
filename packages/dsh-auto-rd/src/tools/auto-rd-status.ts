/**
 * auto_rd_status — query the auto-rd pipeline state.
 *
 * Design doc §12.1: "auto_rd_status 工具". The model (or a human via
 * the sidebar) calls this to see what stories / tasks are currently
 * in flight. Read-only.
 *
 * Parameters (zod-validated at runtime):
 *   - scope: 'stories' (default) | 'tasks' | 'summary'
 *   - moduleId?: filter to one module
 *   - state?: filter to one StoryState
 *   - limit: max records to return (default 50)
 *
 * The actual data is read from the auto-rd StorageDomain. The tool
 * works whether or not the DSH sidebar UI is mounted: it's a function
 * the model can call regardless.
 */
import { z } from 'zod'
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import { StoryStateSchema, type StoryRecord, type TaskRecord } from '../domain/schema.js'
import { jsonOutput } from './tool-output.js'

const ParametersSchema = z.object({
  scope: z.enum(['stories', 'tasks', 'summary']).default('summary'),
  moduleId: z.string().optional(),
  state: StoryStateSchema.optional(),
  limit: z.number().int().positive().max(500).default(50),
})

export type AutoRdStatusParams = z.infer<typeof ParametersSchema>

export interface AutoRdStatusToolDeps {
  storage: AutoRdStorage
  logger: Logger
}

/**
 * Build the tool definition. The shape follows the VERIFIED
 * `ToolDefinition` contract: name, description, parameters (JSON
 * Schema), a REQUIRED `output` definition, and execute.
 *
 * `output.render` is not optional — a definition without it is rejected
 * by `tools.register()`, so the tool would never reach the model.
 *
 * The execute body parses `args` through zod (so DSH can pass either
 * raw JSON or already-typed objects) and returns a plain JSON object,
 * which `output.render` pretty-prints.
 */
export function autoRdStatusTool(deps: AutoRdStatusToolDeps) {
  return {
    name: 'auto_rd_status',
    description:
      'Query the auto-rd pipeline. Pass scope="stories" to list stories (with optional moduleId/state filters), scope="tasks" to list tasks belonging to a story, or scope="summary" (default) for an aggregate count by state.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['stories', 'tasks', 'summary'],
          description: 'What to query. Default: summary.',
        },
        moduleId: {
          type: 'string',
          description: 'Filter to one configured module id.',
        },
        state: {
          type: 'string',
          enum: StoryStateSchema.options,
          description: 'Filter stories to a single state.',
        },
        limit: {
          type: 'number',
          description: 'Max records to return. Default 50, max 500.',
        },
      },
    },
    output: jsonOutput({
      properties: {
        ok: { type: 'boolean' },
        scope: { type: 'string' },
        totalStories: { type: 'number' },
        byState: { type: 'object', additionalProperties: { type: 'number' } },
        activeModules: { type: 'number' },
        pendingTasks: { type: 'number' },
        count: { type: 'number' },
        stories: { type: 'array', items: { type: 'object', additionalProperties: true } },
        tasks: { type: 'array', items: { type: 'object', additionalProperties: true } },
        error: { type: 'string' },
      },
    }),
    async execute(rawArgs: unknown) {
      const parsed = ParametersSchema.safeParse(rawArgs ?? {})
      if (!parsed.success) {
        return { ok: false, error: 'invalid_parameters', issues: parsed.error.issues }
      }
      const args = parsed.data
      deps.logger.debug(`auto_rd_status: scope=${args.scope} moduleId=${args.moduleId ?? '*'}`)

      if (args.scope === 'summary') {
        return summaryView(deps)
      }
      if (args.scope === 'stories') {
        return storiesView(deps, args)
      }
      return tasksView(deps, args)
    },
  }
}

// ---- view helpers -----------------------------------------------------

interface SummaryResponse {
  ok: true
  scope: 'summary'
  totalStories: number
  byState: Record<string, number>
  activeModules: number
  pendingTasks: number
}

function summaryView(deps: AutoRdStatusToolDeps): SummaryResponse {
  const stories = [...deps.storage.stories().values()]
  const byState: Record<string, number> = {}
  for (const s of stories) {
    byState[s.state] = (byState[s.state] ?? 0) + 1
  }

  const modules = [...deps.storage.modules().values()]

  let pendingTasks = 0
  for (const t of deps.storage.tasks().values()) {
    if (t.status === 'pending') pendingTasks += 1
  }

  return {
    ok: true,
    scope: 'summary',
    totalStories: stories.length,
    byState,
    activeModules: modules.length,
    pendingTasks,
  }
}

interface StoriesResponse {
  ok: true
  scope: 'stories'
  count: number
  stories: Array<Pick<StoryRecord, 'id' | 'title' | 'state' | 'moduleId' | 'branch' | 'updatedAt' | 'mrUrl'>>
}

function storiesView(deps: AutoRdStatusToolDeps, args: AutoRdStatusParams): StoriesResponse {
  let stories = [...deps.storage.stories().values()]
  if (args.moduleId) stories = stories.filter((s) => s.moduleId === args.moduleId)
  if (args.state) stories = stories.filter((s) => s.state === args.state)
  stories.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  stories = stories.slice(0, args.limit)

  return {
    ok: true,
    scope: 'stories',
    count: stories.length,
    stories: stories.map((s) => ({
      id: s.id,
      title: s.title,
      state: s.state,
      moduleId: s.moduleId,
      branch: s.branch,
      updatedAt: s.updatedAt,
      mrUrl: s.mrUrl,
    })),
  }
}

interface TasksResponse {
  ok: true
  scope: 'tasks'
  count: number
  tasks: Array<Pick<TaskRecord, 'id' | 'storyId' | 'status' | 'attemptCount' | 'blockedReason'>>
}

function tasksView(deps: AutoRdStatusToolDeps, args: AutoRdStatusParams): TasksResponse {
  let tasks = [...deps.storage.tasks().values()]
  if (args.moduleId) {
    // For tasks we accept either a moduleId filter (via story join) or
    // an implicit "story id" filter. We surface moduleId as a hint and
    // also accept it as a story id for callers that confuse the two.
    const moduleStories = new Set(
      [...deps.storage.stories().values()]
        .filter((s) => s.moduleId === args.moduleId)
        .map((s) => s.id),
    )
    tasks = tasks.filter((t) => moduleStories.has(t.storyId))
  }
  tasks = tasks.slice(0, args.limit)

  return {
    ok: true,
    scope: 'tasks',
    count: tasks.length,
    tasks: tasks.map((t) => ({
      id: t.id,
      storyId: t.storyId,
      status: t.status,
      attemptCount: t.attemptCount,
      blockedReason: t.blockedReason,
    })),
  }
}