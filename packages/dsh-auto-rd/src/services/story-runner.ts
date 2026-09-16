/**
 * StoryRunner — executes the 19-state pipeline for a single story.
 *
 * State machine (see auto-rd-native-plugin-design.md §5):
 *
 *   pending → context → ... → completed
 *
 * Each transition is dispatched by calling an AgentProvider.start(...).
 * This is the SINGLE owner of the state machine; StoryQueue and TapdPoller
 * never advance story state directly.
 *
 * M1: only the `context` stage is implemented (ContextAgent only). All other
 * stages return a "not implemented in M1" marker so we can exercise the
 * skeleton end-to-end.
 *
 * Borrowed patterns:
 * - SD-1: Rulings, not stalls (advance state without waiting for human)
 * - SD-7: Ledger Cross-Compaction (every transition is appended to a log)
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config'
import type { AutoRdStorage } from '../domain/storage'
import type { StoryRecord, StoryState } from '../domain/schema'
import type { Logger } from '../utils/logger'
import { WorkspaceManager } from './workspace-manager'
import { AgentProvider } from './agent-provider'

export interface StoryRunnerDeps {
  storage: AutoRdStorage
  logger: Logger
  config: Config
  workspaceManager: WorkspaceManager
  agentProvider: AgentProvider
}

interface StageHandler {
  (story: StoryRecord, deps: StoryRunnerDeps): Promise<StoryState>
}

/**
 * Stage dispatch table.
 *
 * M1: only `context` is implemented. Other stages emit a marker that the
 * orchestrator will read as "not implemented yet" and park the story in `failed`
 * with a clear blocked reason. This lets us test the state machine plumbing
 * without needing all 13 agents wired up.
 */
const STAGE_HANDLERS: Record<StoryState, StageHandler | null> = {
  pending: async () => 'context',
  context: runContextAgent,

  clarification: notImplementedYet,
  brainstorm: notImplementedYet,
  critic: notImplementedYet,
  decision: notImplementedYet,
  spec: notImplementedYet,
  planning: notImplementedYet,
  implementing: notImplementedYet,
  testing: notImplementedYet,
  fixing: notImplementedYet,
  verifying: notImplementedYet,
  reviewing: notImplementedYet,
  final_verifying: notImplementedYet,
  mr_creating: notImplementedYet,
  tapd_syncing: notImplementedYet,

  completed: async (s) => s.state,
  failed: async (s) => s.state,
  blocked: async (s) => s.state,
}

async function notImplementedYet(story: StoryRecord): Promise<StoryState> {
  return 'failed'
}

export class StoryRunner {
  constructor(private readonly ctx: Context, private readonly deps: StoryRunnerDeps) {}

  /**
   * Run one story from its current state forward until it hits a non-advancing
   * state (blocked / failed / completed / or a stage that yields itself).
   */
  async runStory(storyId: string): Promise<void> {
    const stories = this.deps.storage.stories()
    let story = stories.get(storyId)
    if (!story) {
      this.deps.logger.warn(`StoryRunner.runStory: unknown story ${storyId}`)
      return
    }

    this.deps.logger.info(
      `StoryRunner starting ${storyId} from state=${story.state} retry=${story.retryCount}`,
    )

    while (!isTerminalState(story!.state)) {
      const handler = STAGE_HANDLERS[story!.state]
      if (!handler) {
        story!.state = 'failed'
        story!.blockedReason = `No handler for state ${story!.state}`
        story!.updatedAt = new Date().toISOString()
        await stories.put(story!.id, story!)
        break
      }

      const previousState = story!.state
      let next: StoryState
      try {
        next = await handler(story!, this.deps)
      } catch (err) {
        story!.retryCount += 1
        if (story!.retryCount >= 3) {
          story!.state = 'failed'
          story!.blockedReason = `Stage ${previousState} failed 3 times: ${(err as Error).message}`
        } else {
          // Stay in the same state and let StoryQueue retry.
          this.deps.logger.warn(
            `Story ${storyId} stage ${previousState} threw (attempt ${story!.retryCount}/3): ${(err as Error).message}`,
          )
        }
        story!.updatedAt = new Date().toISOString()
        await stories.put(story!.id, story!)
        break
      }

      if (next === story!.state) {
        // No advancement (e.g., a stage that yielded itself). Stop the loop.
        this.deps.logger.debug(`Story ${storyId} halted at state=${story!.state}`)
        break
      }

      story!.state = next
      story!.updatedAt = new Date().toISOString()
      await stories.put(story!.id, story!)
      this.deps.logger.info(`Story ${storyId}: ${previousState} → ${next}`)
    }

    this.deps.logger.info(`StoryRunner done ${storyId} final state=${story!.state}`)
  }
}

function isTerminalState(state: StoryState): boolean {
  return state === 'completed' || state === 'failed' || state === 'blocked'
}

// ---- Stage Handlers ----

async function runContextAgent(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const ws = deps.workspaceManager
  const artifactsDir = await ensureArtifacts(story, deps)

  // Dispatch the ContextAgent through the SubAgentProvider. The agent runs
  // against the worktree and writes its report to artifactsDir/<report-name>.
  const result = await deps.agentProvider.dispatch({
    agentName: 'context',
    label: `Context investigation: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: {
      story: {
        id: story.id,
        title: story.title,
        description: story.description,
        acceptanceCriteria: story.acceptanceCriteria,
      },
    },
  })

  if (result.status !== 'success') {
    deps.logger.warn(`ContextAgent returned status=${result.status} for story ${story.id}`)
    return 'failed'
  }

  // Persist artifact reference.
  story.artifacts = {
    ...story.artifacts,
    context: {
      kind: 'context',
      filename: '01-context.md',
      summary: result.summary ?? '',
      createdAt: new Date().toISOString(),
    },
  }
  deps.logger.info(`ContextAgent wrote artifact for story ${story.id}`)

  // M1: short-circuit the pipeline. Future milestones add the next stages.
  return 'completed'
}

async function ensureArtifacts(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<string> {
  if (!story.worktreePath) {
    const ws = deps.workspaceManager
    await ws.ensureStoryWorktree(story.id, story.moduleId)
    const fresh = deps.storage.stories().get(story.id)
    if (!fresh || !fresh.worktreePath) {
      throw new Error(`Worktree still missing for story ${story.id} after ensureStoryWorktree`)
    }
    return ws.ensureArtifactsDir(fresh.worktreePath, story.id)
  }
  return deps.workspaceManager.ensureArtifactsDir(story.worktreePath, story.id)
}