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
import type { StoryRecord, StoryState, TaskRecord } from '../domain/schema'
import type { Logger } from '../utils/logger'
import { WorkspaceManager } from './workspace-manager'
import { AgentProvider } from './agent-provider'
import { parsePlannerMarkdown, type ParsedPlannerTask } from './planner-parser'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  pushBranch,
  createOrReuseMR,
  buildMRDescription,
  projectIdFromRepoUrl,
} from './gitlab-merger'
import { syncTapd } from './tapd-poller'
import { HttpClient } from '../utils/http-client'

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

  planning: runPlanningStage,
  implementing: runImplementingStage,
  testing: runTestingStage,
  fixing: runFixingStage,
  verifying: runVerifyingStage,
  reviewing: runReviewingStage,
  final_verifying: runFinalVerifyingStage,
  mr_creating: runMrCreatingStage,
  tapd_syncing: runTapdSyncingStage,

  completed: async (s) => s.state,
  failed: async (s) => s.state,
  blocked: async (s) => s.state,
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
  return 'planning'
}

// ---- Post-Spec Stages (M3) ----

/**
 * planning — parse the Planner's 07-tasks.md into structured TaskRecords
 * persisted in the `tasks` table, then advance to `implementing`.
 *
 * If parsing fails entirely (no tasks found, malformed markdown), the story
 * goes to `blocked` so the user can intervene — we don't guess.
 */
async function runPlanningStage(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)

  const result = await deps.agentProvider.dispatch({
    agentName: 'planner',
    label: `Planner: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: storyInput(story),
  })

  if (result.status !== 'success') {
    deps.logger.warn(`Planner returned status=${result.status} for story ${story.id}`)
    return 'failed'
  }
  recordArtifact(story, 'plan', '07-tasks.md', result.summary ?? '')

  // Parse the freshly written 07-tasks.md into structured task records.
  const tasksPath = join(artifactsDir, '07-tasks.md')
  let parsed: ParsedPlannerTask[]
  try {
    const markdown = readFileSync(tasksPath, 'utf-8')
    parsed = parsePlannerMarkdown(markdown)
  } catch (err) {
    story.blockedReason = `Planning: failed to read 07-tasks.md: ${(err as Error).message}`
    deps.logger.error(`Planning: cannot read 07-tasks.md for story ${story.id}: ${story.blockedReason}`)
    return 'blocked'
  }

  if (parsed.length === 0) {
    story.blockedReason = `Planning: planner produced zero tasks in 07-tasks.md`
    deps.logger.error(`Planning: zero tasks for story ${story.id}`)
    return 'blocked'
  }

  // Pre-create per-task ImplementationAgent specs so SD-2 dispatch works.
  for (const t of parsed) {
    deps.agentProvider.ensureImplementationSpec(t.taskId)
  }

  // Persist TaskRecords. Each task starts at status='pending'. The
  // orchestrator's `implementing` stage filters by deps before dispatching.
  const tasks = deps.storage.tasks()
  const now = new Date().toISOString()
  for (const t of parsed) {
    const record: TaskRecord = {
      id: t.taskId,
      storyId: story.id,
      title: t.title,
      description: t.title, // payload carries the structured shape
      payload: {
        taskId: t.taskId,
        title: t.title,
        files: t.files,
        dependsOn: t.dependsOn,
        estimatedMinutes: t.estimatedMinutes,
        red: t.red,
        green: t.green,
        verify: t.verify,
        commit: t.commit,
      },
      status: 'pending',
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    }
    await tasks.put(t.taskId, record)
  }

  deps.logger.info(`Planning: created ${parsed.length} tasks for story ${story.id}`)
  return 'implementing'
}

/**
 * implementing — for each pending task whose deps are satisfied, dispatch
 * a fresh ImplementationAgent. Iterate until either every task is
 * `completed` / `blocked` or none of the remaining `pending` tasks have
 * their deps satisfied (which shouldn't happen in a valid plan but we
 * guard against cycles).
 *
 * SD-2 + SD-3:
 *   - SD-2: each task gets a fresh AgentSpec via ensureImplementationSpec
 *   - SD-3: the ImplementationAgent spec itself declares no subagent tool
 *     permission, and the AgentProvider does not expose a "spawn another
 *     subagent" method to its handlers — Implementers can't go sideways.
 */
async function runImplementingStage(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)
  const tasks = deps.storage.tasks()
  const allTasks = [...tasks.values()].filter((t) => t.storyId === story.id)
  if (allTasks.length === 0) {
    deps.logger.warn(`Implementing: no tasks found for story ${story.id}`)
    return 'failed'
  }

  // Filter to tasks that are ready: pending AND every dependsOn task is
  // completed. Tasks already done / blocked are skipped.
  const byId = new Map(allTasks.map((t) => [t.id, t]))
  const ready = allTasks.filter((t) => {
    if (t.status !== 'pending') return false
    return t.payload?.dependsOn.every((dep) => byId.get(dep)?.status === 'completed') ?? true
  })

  if (ready.length === 0) {
    // Either all done, or none are ready (cycle or all-blocked).
    const anyBlocked = allTasks.some((t) => t.status === 'blocked')
    const anyFailed = allTasks.some((t) => t.status === 'failed')
    if (anyBlocked || anyFailed) {
      // Surface upstream blocker.
      const blockedTask = allTasks.find((t) => t.status === 'blocked' || t.status === 'failed')
      story.blockedReason = `Implementing: task ${blockedTask?.id} ${blockedTask?.status}: ${blockedTask?.blockedReason ?? 'unknown'}`
      return 'blocked'
    }
    // All completed.
    deps.logger.info(`Implementing: all ${allTasks.length} tasks completed for story ${story.id}`)
    return 'testing'
  }

  // Dispatch each ready task (sequential — the Plan's "Execution Order"
  // section is the source of truth; we preserve the order tasks appear in
  // the table). Parallel dispatch would require per-task worktrees, which
  // is a later milestone.
  let didAdvance = false
  for (const task of ready) {
    deps.agentProvider.ensureImplementationSpec(task.id)
    const result = await deps.agentProvider.dispatch({
      agentName: 'implementation',
      label: `Implementation ${task.id}: ${story.id}`,
      worktreePath: story.worktreePath!,
      artifactsDir,
      inputs: { story: storyInput(story).story, task: task.payload },
      taskId: task.id,
    })

    task.attemptCount += 1
    task.updatedAt = new Date().toISOString()
    if (result.status === 'success') {
      task.status = 'completed'
      task.implementationResult = result.summary
      didAdvance = true
    } else if (result.status === 'blocked') {
      task.status = 'blocked'
      task.blockedReason = result.reason
      story.blockedReason = `Implementing: task ${task.id} blocked — ${result.reason}`
      await tasks.put(task.id, task)
      return 'blocked'
    } else {
      task.status = 'failed'
      task.blockedReason = result.reason
    }
    await tasks.put(task.id, task)
  }

  // Re-enter the loop on the next runner tick to pick up newly unblocked
  // tasks. We return 'implementing' here — StoryRunner's outer while-loop
  // will re-dispatch this stage until no progress is possible.
  return didAdvance || ready.length > 0 ? 'implementing' : 'testing'
}

/**
 * testing — dispatch TestAgent. The stub emits [TEST_PASS] unconditionally;
 * a real model would inspect the test suite. The orchestrator transitions
 * to `verifying` on PASS or to `fixing` on FAIL.
 */
async function runTestingStage(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)
  const result = await deps.agentProvider.dispatch({
    agentName: 'test',
    label: `Test: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: storyInput(story),
  })

  if (result.status === 'blocked' || result.status === 'failed') {
    deps.logger.warn(`TestAgent returned ${result.status} for story ${story.id}: ${result.reason}`)
    return 'fixing'
  }
  recordArtifact(story, 'test', '09-test-report.md', result.summary ?? '')
  return 'verifying'
}

/**
 * fixing — dispatch FixAgent against the most-recent test failure, then
 * loop back to `testing`. The 5-round breaker (SD-4) is enforced via the
 * SUM of attemptCount across all the story's tasks: if any task has
 * attemptCount > 5, the story is parked in `blocked`.
 *
 * Stub behaviour: every dispatch returns success, attemptCount climbs on
 * each invocation, and after 5 invocations of this stage the breaker
 * trips. This is the path that lets M3 demonstrate the breaker without
 * needing a real model.
 */
async function runFixingStage(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)
  const tasks = deps.storage.tasks()
  const storyTasks = [...tasks.values()].filter((t) => t.storyId === story.id)
  // Find the most-recently-failed task to address.
  const target = storyTasks
    .filter((t) => t.status === 'failed' || t.status === 'in_progress')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]

  if (!target) {
    deps.logger.warn(`Fixing: no failed task to address for story ${story.id}`)
    return 'testing'
  }

  // SD-4 5-round breaker: if any task has tried >= 5 times, park the story.
  const totalAttempts = storyTasks.reduce((acc, t) => acc + t.attemptCount, 0)
  if (totalAttempts >= 5) {
    story.blockedReason = `Fixing: 5-round breaker tripped after ${totalAttempts} attempts on task ${target.id}`
    deps.logger.warn(`Fixing: breaker tripped for story ${story.id}`)
    return 'blocked'
  }

  const attempt = target.attemptCount + 1
  const result = await deps.agentProvider.dispatch({
    agentName: 'fix',
    label: `Fix attempt ${attempt} on ${target.id}: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: {
      story: storyInput(story).story,
      task: target.payload,
      fix: { attempt, failureId: `F-${target.id}-${attempt}` },
    },
    taskId: target.id,
  })

  target.attemptCount = attempt
  target.updatedAt = new Date().toISOString()
  if (result.status === 'blocked') {
    target.status = 'blocked'
    target.blockedReason = result.reason
    await tasks.put(target.id, target)
    story.blockedReason = `Fixing: task ${target.id} blocked — ${result.reason}`
    return 'blocked'
  }
  if (result.status !== 'success') {
    target.status = 'failed'
    target.blockedReason = result.reason
  } else {
    // Stub success — flip status back to in_progress so testing can re-run.
    target.status = 'in_progress'
  }
  await tasks.put(target.id, target)
  recordArtifact(
    story,
    'fix',
    '10-fix-report.md',
    result.status === 'success' ? result.summary ?? '' : `attempt ${attempt} failed: ${result.reason}`,
  )
  return 'testing'
}

/**
 * verifying — dispatch VerificationAgent on the integration tree. PASS →
 * `reviewing`; PARTIAL → `fixing`; REJECT → blocked (architectural issue).
 */
async function runVerifyingStage(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)
  const result = await deps.agentProvider.dispatch({
    agentName: 'verification',
    label: `Verification: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: storyInput(story),
  })

  if (result.status === 'blocked' || result.status === 'failed') {
    story.blockedReason = `Verifying: ${result.reason}`
    return 'blocked'
  }
  recordArtifact(story, 'verification', '11-verify-report.md', result.summary ?? '')
  return 'reviewing'
}

/**
 * reviewing — two-axis parallel review (CR-1). The orchestrator dispatches
 * ReviewAgent twice (standards + spec) and only advances to
 * `final_verifying` if BOTH axes return APPROVE. Either axis returning
 * CHANGES rolls the story back to `fixing` with the failing axis in the
 * blockedReason.
 */
async function runReviewingStage(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)
  const axes = ['standards', 'spec'] as const

  // One task per axis. In a real pipeline, each axis is one subagent per
  // task — here we route to the same TaskRecord's latest task id.
  const tasks = [...deps.storage.tasks().values()].filter((t) => t.storyId === story.id)
  const targetTaskId = tasks[tasks.length - 1]?.id ?? 'T001'

  const results = await Promise.allSettled(
    axes.map((axis) =>
      deps.agentProvider.dispatch({
        agentName: 'review',
        label: `Review ${axis}: ${story.id}`,
        worktreePath: story.worktreePath!,
        artifactsDir,
        inputs: { story: storyInput(story).story, axis },
        axis,
        taskId: targetTaskId,
      }),
    ),
  )

  const verdicts: Array<{ axis: string; status: string; summary?: string }> = []
  let rejected = false
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const axis = axes[i]
    if (r.status === 'fulfilled') {
      const v = r.value
      verdicts.push({
        axis,
        status: v.status,
        summary: v.status === 'success' ? v.summary : v.reason,
      })
      if (v.status !== 'success') rejected = true
    } else {
      verdicts.push({ axis, status: 'failed', summary: r.reason?.message })
      rejected = true
    }
  }

  const summary = verdicts.map((v) => `${v.axis}:${v.status}`).join(' | ')
  recordArtifact(story, 'review', `12-review-${targetTaskId}-{standards,spec}.md`, summary)

  if (rejected) {
    deps.logger.warn(`Review: rejected by ${verdicts.find((v) => v.status !== 'success')?.axis}`)
    return 'fixing'
  }
  return 'final_verifying'
}

/**
 * final_verifying — same two-axis pattern but whole-branch (SD-6).
 * DP-1 + DP-2: two parallel dispatch calls, one per axis.
 */
async function runFinalVerifyingStage(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)
  const axes = ['standards', 'spec'] as const

  const results = await Promise.allSettled(
    axes.map((axis) =>
      deps.agentProvider.dispatch({
        agentName: 'final-verify',
        label: `Final verify ${axis}: ${story.id}`,
        worktreePath: story.worktreePath!,
        artifactsDir,
        inputs: { story: storyInput(story).story, axis },
        axis,
      }),
    ),
  )

  let rejected = false
  const verdicts: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const axis = axes[i]
    const status = r.status === 'fulfilled' ? r.value.status : 'failed'
    verdicts.push(`${axis}:${status}`)
    if (status !== 'success') rejected = true
  }

  recordArtifact(
    story,
    'final_verify',
    '13-final-verify-{standards,spec}.md',
    verdicts.join(' | '),
  )

  if (rejected) {
    deps.logger.warn(`FinalVerify: rejected (${verdicts.filter((v) => !v.endsWith(':success')).join(', ')})`)
    return 'fixing'
  }
  return 'mr_creating'
}

/**
 * mr_creating — push the story branch and create (or reuse) the MR.
 *
 * M4-A: real HTTP via gitlab-merger. Two checkpoints are persisted in
 * the StoryRecord so a partial failure can be replayed:
 *
 *   1. pushBranch -> story.pushedSha + story.pushedAt
 *   2. createOrReuseMR -> story.mrIid + story.mrCreatedAt + story.mrUrl + story.mrReused
 *
 * Failure handling — checkpoint pattern (NOT blocked):
 *   - push throws      -> story stays in mr_creating; runner re-tries
 *                         next tick. The next push will be a no-op if
 *                         origin/<branch> is already at pushedSha.
 *   - MR create throws -> same: replay will list existing MRs and reuse
 *                         it (alreadyUpToDate + reused=true).
 *   - We do NOT park the story in 'blocked' for transient HTTP / shell
 *     failures. Network blips are not story-level failures.
 *
 * True configuration errors (missing moduleId / repoUrl / token) DO
 * park the story in 'blocked' — they will never resolve on retry.
 */
async function runMrCreatingStage(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)
  const stories = deps.storage.stories()
  const modules = deps.storage.modules()
  const module = modules.get(story.moduleId)
  if (!module) {
    story.blockedReason = `mr_creating: module ${story.moduleId} not found in storage`
    return 'blocked'
  }
  if (!story.worktreePath) {
    story.blockedReason = `mr_creating: story has no worktree path (cannot push)`
    return 'blocked'
  }

  const httpClient =
    (deps as unknown as { httpClient?: import('../utils/http-client').HttpClient }).httpClient ??
    new HttpClient({ tag: 'gitlab-merger' })
  const mergerDeps = { httpClient, logger: deps.logger }

  // ---- Checkpoint 1: push branch ----
  if (!story.pushedSha) {
    try {
      const pushResult = await pushBranch(mergerDeps, {
        worktreePath: story.worktreePath,
        branch: story.branch,
        remote: 'origin',
        userName: deps.config.gitlabPushUserName,
        userEmail: deps.config.gitlabPushUserEmail,
      })
      story.pushedSha = pushResult.pushedSha ?? undefined
      story.pushedAt = new Date().toISOString()
      deps.logger.info(
        `mr_creating: pushed ${story.branch} (sha=${story.pushedSha ?? '<none>'}, up-to-date=${pushResult.alreadyUpToDate})`,
      )
      await stories.put(story.id, story)
    } catch (err) {
      // Transient — stay in mr_creating, let the next tick retry.
      const msg = (err as Error).message
      deps.logger.warn(`mr_creating: push failed (will retry next tick): ${msg}`)
      story.blockedReason = `mr_creating: push failed: ${msg}`
      // We keep story.state unchanged by returning the same state; the
      // outer while-loop will see no state advancement and re-dispatch.
      await stories.put(story.id, story)
      return 'mr_creating'
    }
  } else {
    deps.logger.info(
      `mr_creating: branch ${story.branch} already pushed at sha=${story.pushedSha}; skipping`,
    )
  }

  // ---- Checkpoint 2: create / reuse MR ----
  if (!story.mrUrl) {
    const projectId = projectIdFromRepoUrl(module.repoUrl)
    const description = buildMRDescription(
      story,
      [
        `### Auto-RD spec`,
        'See the artifact directory for the full `06-spec.md`.',
        ``,
        `### Verification`,
        'See `11-verify-report.md`.',
        ``,
        `### Final review`,
        'See `13-final-verify-standards.md` and `13-final-verify-spec.md`.',
      ].join('\n'),
    )
    try {
      const mr = await createOrReuseMR(mergerDeps, {
        gitlabBaseUrl: deps.config.gitlabBaseUrl,
        gitlabApiToken: deps.config.gitlabApiToken,
        projectId,
        sourceBranch: story.branch,
        targetBranch: module.defaultBranch,
        title: `[Auto-RD] ${story.title} (TAPD-${story.tapdId})`,
        description,
      })
      story.mrIid = mr.mrIid
      story.mrUrl = mr.webUrl
      story.mrCreatedAt = new Date().toISOString()
      story.mrReused = mr.reused
      deps.logger.info(
        `mr_creating: ${mr.reused ? 'reused' : 'created'} MR !${mr.mrIid} for ${story.branch}`,
      )
      await stories.put(story.id, story)
    } catch (err) {
      const msg = (err as Error).message
      // 401 / 403 / 404 on project are config errors — block the story.
      const transient = !(err as { transient?: boolean }).transient === false
      if (!transient) {
        story.blockedReason = `mr_creating: GitLab rejected the request (config error): ${msg}`
        return 'blocked'
      }
      deps.logger.warn(`mr_creating: MR create failed (will retry next tick): ${msg}`)
      story.blockedReason = `mr_creating: ${msg}`
      await stories.put(story.id, story)
      return 'mr_creating'
    }
  } else {
    deps.logger.info(
      `mr_creating: MR already exists at ${story.mrUrl}; skipping create`,
    )
  }

  // Write a checkpoint file summarizing the actual side effects. Useful
  // for auditing without trawling through logs.
  const mrDoc = renderMrCheckpoint(story)
  writeFileSyncOrLog(artifactsDir, '99-mr.md', mrDoc, deps.logger)
  return 'tapd_syncing'
}

function renderMrCheckpoint(story: StoryRecord): string {
  return [
    `# MR — ${story.id}`,
    ``,
    `**Branch**: \`${story.branch}\``,
    `**Pushed sha**: \`${story.pushedSha ?? '<not pushed>'}\``,
    `**Pushed at**: ${story.pushedAt ?? '<n/a>'}`,
    `**MR iid**: !${story.mrIid ?? '<n/a>'}`,
    `**MR url**: ${story.mrUrl ?? '<not created>'}`,
    `**MR created at**: ${story.mrCreatedAt ?? '<n/a>'}`,
    `**Reused**: ${story.mrReused ?? false}`,
    ``,
    `Re-running this stage is safe: the runner checks \`story.pushedSha\``,
    `and \`story.mrUrl\` and skips work already done.`,
  ].join('\n')
}

/**
 * tapd_syncing — POST the MR link + status back to TAPD.
 *
 * M4-A: real HTTP via syncTapd. Checkpointed via story.tapdSyncedAt.
 *
 * Failure handling:
 *   - Transient HTTP / timeout / 5xx: increment tapdSyncAttempts; stay
 *     in tapd_syncing; runner re-tries next tick. The sync is
 *     idempotent so replays are safe.
 *   - 4xx other than 404: config error -> blocked.
 *   - Hard cap at 20 attempts: log error, park the story in 'failed'
 *     so the user can intervene. (Distinct from the SD-4 5-round
 *     breaker because a network outage lasting hours should not look
 *     the same as a code-level architecture issue.)
 */
async function runTapdSyncingStage(
  story: StoryRecord,
  deps: StoryRunnerDeps,
): Promise<StoryState> {
  const artifactsDir = await ensureArtifacts(story, deps)

  if (!story.mrUrl) {
    story.blockedReason = `tapd_syncing: cannot sync without story.mrUrl (mr_creating must succeed first)`
    return 'blocked'
  }

  if (!story.tapdSyncedAt) {
    if ((story.tapdSyncAttempts ?? 0) >= 20) {
      deps.logger.error(
        `tapd_syncing: gave up after ${story.tapdSyncAttempts} attempts for story ${story.id}`,
      )
      story.blockedReason = `tapd_syncing: gave up after ${story.tapdSyncAttempts} transient attempts; manual intervention needed`
      return 'failed'
    }

    try {
      await syncTapd({
        tapdBaseUrl: deps.config.tapdBaseUrl,
        tapdApiToken: deps.config.tapdApiToken,
        tapdId: story.tapdId,
        mrUrl: story.mrUrl,
        gitBranch: story.branch,
      })
      story.tapdSyncedAt = new Date().toISOString()
      story.tapdSyncAttempts = (story.tapdSyncAttempts ?? 0) + 1
      deps.logger.info(`tapd_syncing: synced TAPD story ${story.tapdId}`)
      await deps.storage.stories().put(story.id, story)
    } catch (err) {
      story.tapdSyncAttempts = (story.tapdSyncAttempts ?? 0) + 1
      const msg = (err as Error).message
      const transient = (err as { transient?: boolean }).transient !== false
      if (!transient) {
        story.blockedReason = `tapd_syncing: TAPD rejected the sync (config error): ${msg}`
        return 'blocked'
      }
      deps.logger.warn(
        `tapd_syncing: sync failed (attempt ${story.tapdSyncAttempts}/20, will retry): ${msg}`,
      )
      story.blockedReason = `tapd_syncing: ${msg}`
      await deps.storage.stories().put(story.id, story)
      return 'tapd_syncing'
    }
  } else {
    deps.logger.info(
      `tapd_syncing: TAPD already synced at ${story.tapdSyncedAt}; skipping`,
    )
  }

  // Write the audit file (replacing the old M3 stub).
  const tapdDoc = [
    `# TAPD Sync — ${story.id}`,
    ``,
    `**Story**: ${story.title}`,
    `**TAPD id**: ${story.tapdId}`,
    `**MR url**: ${story.mrUrl}`,
    `**Synced at**: ${story.tapdSyncedAt}`,
    `**Attempts**: ${story.tapdSyncAttempts ?? 0}`,
    ``,
    `Re-running this stage is safe: the runner checks \`story.tapdSyncedAt\``,
    `and skips the network call.`,
  ].join('\n')

  writeFileSyncOrLog(artifactsDir, '98-tapd-sync.md', tapdDoc, deps.logger)
  return 'completed'
}

function writeFileSyncOrLog(dir: string, name: string, body: string, logger: Logger): void {
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    fs.writeFileSync(join(dir, name), body, 'utf-8')
  } catch (err) {
    logger.error(`Failed to write ${name}: ${(err as Error).message}`)
  }
}