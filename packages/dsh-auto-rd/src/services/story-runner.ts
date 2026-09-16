/**
 * StoryRunner — executes the 19-state pipeline for a single story.
 *
 * State machine (see auto-rd-native-plugin-design.md §5):
 *
 *   pending → context → clarification → brainstorm → critic → decision
 *          → spec → planning → implementing → testing → fixing → verifying
 *          → reviewing → final_verifying → mr_creating → tapd_syncing → completed
 *
 * Each transition is dispatched by calling AgentProvider.dispatch(...).
 * This is the SINGLE owner of the state machine; StoryQueue and TapdPoller
 * never advance story state directly.
 *
 * M2: states from `pending` through `spec` have stub handlers (see
 * agent-provider.ts). Later states (planning and beyond) still short-circuit
 * to `completed` so a single story can exercise the full M2 surface end to
 * end without a model attached.
 *
 * Borrowed patterns:
 * - SD-1: Rulings, not stalls (advance state without waiting on human)
 * - SD-7: Ledger Cross-Compaction (every transition is appended to a log)
 */
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
 * M2: states pending → spec are implemented (with stubs that produce real
 * artifact shape so the state machine can advance). States after spec
 * (`planning`, `implementing`, ...) short-circuit to `completed` because
 * they belong to later milestones. M3+ will replace those with real
 * handlers.
 */
const STAGE_HANDLERS: Record<StoryState, StageHandler | null> = {
  pending: async () => 'context',

  context: runContextAgent,
  clarification: runClarificationAgent,
  brainstorm: runBrainstormAgents,
  critic: runCriticAgent,
  decision: runDecisionAgent,
  spec: runSpecAgent,

  planning: notInM2Yet,
  implementing: notInM2Yet,
  testing: notInM2Yet,
  fixing: notInM2Yet,
  verifying: notInM2Yet,
  reviewing: notInM2Yet,
  final_verifying: notInM2Yet,
  mr_creating: notInM2Yet,
  tapd_syncing: notInM2Yet,

  completed: async (s) => s.state,
  failed: async (s) => s.state,
  blocked: async (s) => s.state,
}

/**
 * M2 short-circuit: stages beyond `spec` are not in scope yet. Rather than
 * failing the story, we end the pipeline at `completed` once `spec` is done
 * so a single story can validate the full M2 surface end to end.
 *
 * M3 will replace this with real handlers.
 */
async function notInM2Yet(_story: StoryRecord): Promise<StoryState> {
  return 'completed'
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

// ---- Stage Handlers (M2) ----

/**
 * Shared pre-flight: ensure the story has a worktree + artifacts dir.
 * Returns the artifacts directory path. Throws if neither can be obtained.
 */
async function ensureArtifacts(story: StoryRecord, deps: StoryRunnerDeps): Promise<string> {
  if (!story.worktreePath) {
    await deps.workspaceManager.ensureStoryWorktree(story.id, story.moduleId)
    const fresh = deps.storage.stories().get(story.id)
    if (!fresh || !fresh.worktreePath) {
      throw new Error(`Worktree still missing for story ${story.id} after ensureStoryWorktree`)
    }
    return deps.workspaceManager.ensureArtifactsDir(fresh.worktreePath, story.id)
  }
  return deps.workspaceManager.ensureArtifactsDir(story.worktreePath, story.id)
}

/**
 * Build the standard story input bag passed to every agent's `inputs.story`.
 */
function storyInput(story: StoryRecord) {
  return {
    story: {
      id: story.id,
      title: story.title,
      description: story.description,
      acceptanceCriteria: story.acceptanceCriteria,
    },
  }
}

/**
 * Persist an artifact reference into the story's `artifacts` map.
 */
function recordArtifact(
  story: StoryRecord,
  key: string,
  filename: string,
  summary: string,
): void {
  story.artifacts = {
    ...story.artifacts,
    [key]: {
      // The kind is informational; we map agent names to artifact kinds the
      // schema already supports (see ArtifactRefSchema in domain/schema.ts).
      kind: key as
        | 'context'
        | 'clarification'
        | 'proposal'
        | 'critique'
        | 'decision'
        | 'spec'
        | 'plan',
      filename,
      summary,
      createdAt: new Date().toISOString(),
    },
  }
}

async function runContextAgent(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)

  const result = await deps.agentProvider.dispatch({
    agentName: 'context',
    label: `Context investigation: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: storyInput(story),
  })

  if (result.status !== 'success') {
    deps.logger.warn(`ContextAgent returned status=${result.status} for story ${story.id}`)
    return 'failed'
  }

  recordArtifact(story, 'context', '01-context.md', result.summary ?? '')
  deps.logger.info(`ContextAgent wrote artifact for story ${story.id}`)
  return 'clarification'
}

async function runClarificationAgent(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)

  const result = await deps.agentProvider.dispatch({
    agentName: 'clarification',
    label: `Clarification: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: storyInput(story),
  })

  if (result.status === 'blocked') {
    // HARD-GATE (B-4): unresolved questions park the story in `blocked`.
    story.blockedReason = `Clarification blocked: ${result.reason}`
    deps.logger.warn(`ClarificationAgent blocked story ${story.id}: ${result.reason}`)
    return 'blocked'
  }
  if (result.status !== 'success') {
    deps.logger.warn(`ClarificationAgent returned status=${result.status} for story ${story.id}`)
    return 'failed'
  }

  recordArtifact(story, 'clarification', '02-clarification.md', result.summary ?? '')
  deps.logger.info(`ClarificationAgent wrote artifact for story ${story.id}`)
  return 'brainstorm'
}

/**
 * Brainstorm dispatches the agent THREE times in parallel, once per
 * variation (minimal / clean / novel) — see design doc §6.6.
 *
 * Each variation is independent, so we run them concurrently via
 * Promise.allSettled. We do NOT abort on a single failure — the orchestrator
 * still moves forward and the Critic handles the missing-variation case
 * downstream.
 */
async function runBrainstormAgents(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)
  const variations = ['minimal', 'clean', 'novel'] as const

  const results = await Promise.allSettled(
    variations.map((variation) =>
      deps.agentProvider.dispatch({
        agentName: 'brainstorm',
        label: `Brainstorm ${variation}: ${story.id}`,
        worktreePath: story.worktreePath!,
        artifactsDir,
        inputs: storyInput(story),
        variation,
        variationIndex: variations.indexOf(variation) + 1,
      }),
    ),
  )

  const summaries: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const variation = variations[i]
    if (r.status === 'fulfilled') {
      if (r.value.status === 'success') {
        summaries.push(`${variation}: ${r.value.summary ?? 'ok'}`)
      } else {
        deps.logger.warn(
          `BrainstormAgent (${variation}) returned ${r.value.status} for story ${story.id}: ${r.value.reason}`,
        )
      }
    } else {
      deps.logger.error(
        `BrainstormAgent (${variation}) threw for story ${story.id}: ${r.reason}`,
      )
    }
  }

  // Advance only if at least one variation succeeded. The Critic can handle
  // a missing proposal as a finding, but if all three failed we park the
  // story at failed to avoid the Critic reporting on empty input.
  if (summaries.length === 0) {
    return 'failed'
  }

  recordArtifact(
    story,
    'proposal',
    '03-proposal-{minimal,clean,novel}.md',
    summaries.join(' | '),
  )
  deps.logger.info(`Brainstorm wrote ${summaries.length}/3 proposals for story ${story.id}`)
  return 'critic'
}

async function runCriticAgent(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)

  const result = await deps.agentProvider.dispatch({
    agentName: 'critic',
    label: `Critic: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: storyInput(story),
  })

  if (result.status === 'blocked') {
    // CRITIQUE_BLOCKED: a systemic gap surfaced, roll back to clarification.
    story.blockedReason = `Critic blocked — rolling back: ${result.reason}`
    deps.logger.warn(`CriticAgent blocked story ${story.id}: ${result.reason}`)
    return 'clarification'
  }
  if (result.status !== 'success') {
    deps.logger.warn(`CriticAgent returned status=${result.status} for story ${story.id}`)
    return 'failed'
  }

  recordArtifact(story, 'critique', '04-critique.md', result.summary ?? '')
  deps.logger.info(`CriticAgent wrote artifact for story ${story.id}`)
  return 'decision'
}

async function runDecisionAgent(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)

  const result = await deps.agentProvider.dispatch({
    agentName: 'decision',
    label: `Decision: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: storyInput(story),
  })

  if (result.status !== 'success') {
    deps.logger.warn(`DecisionAgent returned status=${result.status} for story ${story.id}`)
    return 'failed'
  }

  recordArtifact(story, 'decision', '05-decision.md', result.summary ?? '')
  deps.logger.info(`DecisionAgent wrote artifact for story ${story.id}`)
  return 'spec'
}

async function runSpecAgent(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)

  const result = await deps.agentProvider.dispatch({
    agentName: 'spec',
    label: `Spec: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: storyInput(story),
  })

  if (result.status === 'blocked') {
    story.blockedReason = `Spec blocked: ${result.reason}`
    deps.logger.warn(`SpecAgent blocked story ${story.id}: ${result.reason}`)
    return 'blocked'
  }
  if (result.status !== 'success') {
    deps.logger.warn(`SpecAgent returned status=${result.status} for story ${story.id}`)
    return 'failed'
  }

  recordArtifact(story, 'spec', '06-spec.md', result.summary ?? '')
  deps.logger.info(`SpecAgent wrote artifact for story ${story.id}`)
  // M2 boundary: spec is the last stage wired up; later stages short-circuit
  // to `completed` via notInM2Yet. M3 will replace that stub.
  return 'planning'
}