/**
 * StoryRunner — executes the Tier-1 pipeline for a single story.
 *
 * State machine (see docs/architecture/auto-rd-two-tier-pipeline.md):
 *
 *   pending → context → clarification → brainstorm → critic → decision
 *          → spec → planning → implementing → testing → fixing → verifying
 *          → reviewing → final_verifying → delivery_ready
 *
 * Each transition is dispatched by calling AgentProvider.dispatch(...).
 * This is the SINGLE owner of the Tier-1 state machine; StoryQueue and
 * TapdPoller never advance story state directly.
 *
 * Every state dispatches to the matching handler in agent-provider.ts.
 * See that module for the two dispatch paths (model-backed vs
 * deterministic) and what each stage does without a model.
 *
 * The delivery tail (delivery_ready → mr_opened → completed) is owned by
 * Tier 2 (delivery-task / mr-sweep), NOT this runner.
 *
 * Borrowed patterns:
 * - SD-1: Rulings, not stalls (advance state without waiting on human)
 * - SD-7: Ledger Cross-Compaction (every transition is appended to a log)
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config.js'
import type { AutoRdStorage } from '../domain/storage.js'
import type { StoryRecord, StoryState, TaskRecord } from '../domain/schema.js'
import type { PipelineInput } from '../domain/pipeline-input.js'
import type { Logger } from '../utils/logger.js'
import { WorkspaceManager } from './workspace-manager.js'
import { AgentProvider } from './agent-provider.js'
import { pushBranch } from './gitlab-merger.js'
import { parsePlannerMarkdown, type ParsedPlannerTask } from './planner-parser.js'
import { pipelineInputForStory } from '../domain/pipeline-input.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TrajectoryRecorder } from './trajectory.js'

export interface StoryRunnerDeps {
  storage: AutoRdStorage
  logger: Logger
  config: Config
  workspaceManager: WorkspaceManager
  agentProvider: AgentProvider
  /**
   * Optional TrajectoryRecorder. When present, every state transition
   * is appended so the trajectory is the canonical execution log.
   * (External side effects — push / MR / TAPD — are owned by Tier 2 and
   * recorded there.)
   */
  trajectory?: TrajectoryRecorder
  /**
   * Optional DSH sessions service. When present, the runner creates one
   * DSH session per story (titled after the story) and persists its id
   * into `story.mainSessionId`. Absent in headless profiles — the
   * pipeline still runs, just without a live DSH session.
   */
  sessions?: import('../types/dsh-services.js').SessionsService
  /**
   * Optional DSH session-title service, used to set the session's
   * display title to the story title after creation.
   */
  sessionTitle?: import('../types/dsh-services.js').SessionTitleService
  /**
   * Optional DSH live agent registry (`ctx.agents`). Used to resolve
   * the story's parent Agent when spawning role subagents (Block A).
   * Absent in headless profiles — role dispatch falls back to the
   * deterministic handler path.
   */
  agents?: import('../types/dsh-services.js').AgentsService
  /**
   * DSH credentials service. Tier 2 (delivery-task / mr-sweep) resolves
   * TAPD and GitLab tokens at the moment of an HTTP call; the Tier-1
   * runner no longer makes those calls, so this field is retained only
   * for interface continuity.
   */
  credentials?: import('../types/dsh-services.js').CredentialsService
}

interface StageHandler {
  (story: StoryRecord, deps: StoryRunnerDeps): Promise<StoryState>
}

/**
 * Blocked / failed reason convention (design §12.1).
 *
 * Every `blockedReason` and `task.blockedReason` the runner writes starts
 * with a lowercase stage code and a colon, then human-readable detail:
 *
 *   clarification: empty description — nothing to resolve
 *   fixing: 5-round breaker tripped after 5 attempts on task T001
 *
 * The prefix is what the human-recovery tools and the notifier key off, so
 * it must stay a stable identifier rather than prose. Stage codes in use:
 * `runner`, `clarification`, `resolution`, `critic`, `spec`, `planning`,
 * `implementing`, `fixing`, `verifying`.
 */

/**
 * Stage dispatch table.
 *
 * Every state has a handler. The deterministic handlers produce real
 * artifacts and real side effects — worktree probes, subprocess test
 * runs, git commits — so the machine advances with or without a model
 * attached.
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
  delivery_ready: async (s) => s.state,
  mr_opened: async (s) => s.state,

  completed: async (s) => s.state,
  failed: async (s) => s.state,
  blocked: async (s) => s.state,
}

export class StoryRunner {
  constructor(private readonly ctx: Context, private readonly deps: StoryRunnerDeps) {}

  /**
   * Run one story from its current state forward until it hits a non-advancing
   * state (blocked / failed / delivery_ready / mr_opened / completed / or a
   * stage that yields itself).
   */
  async runStory(storyId: string): Promise<void> {
    const stories = this.deps.storage.stories()
    let story = stories.get(storyId)
    if (!story) {
      this.deps.logger.warn(`StoryRunner.runStory: unknown story ${storyId}`)
      return
    }

    // Ensure the story is bound to a DSH session before running. The
    // session is composed from the generic `PipelineInput` (title +
    // optional git worktree), NOT from the TAPD-shaped StoryRecord — this
    // is the seam F generalization: the Tier-1 engine can be driven by a
    // chat entry (`source.kind='chat'`) with no TAPD identity. Idempotent:
    // if `story.mainSessionId` is already set we skip; if the sessions
    // service is absent (headless) we skip silently.
    const input = this.buildPipelineInput(story)
    await this.ensureSession(story, input)

    this.deps.logger.info(
      `StoryRunner starting ${storyId} from state=${story.state} retry=${story.retryCount}`,
    )

    while (!isTerminalState(story!.state)) {
      // ---- Ledger guardrails (design §5) ----
      // These are checked BEFORE any stage runs so a story that has
      // drifted (too many role steps) or rolled back too many times parks
      // itself instead of looping forever. The main agent cannot override
      // them — they live in host code.
      if (story!.totalSteps >= 40) {
        const prev = story!.state
        story!.state = 'blocked'
        story!.blockedReason = `runner: totalSteps >= 40 (${story!.totalSteps}); orchestration drift — manual review required`
        story!.updatedAt = new Date().toISOString()
        await stories.put(story!.id, story!)
        if (this.deps.trajectory) {
          void this.deps.trajectory.append({
            storyId: story!.id,
            kind: 'state_transition',
            label: `${prev} → blocked (totalSteps guard)`,
            payload: {
              from: prev,
              to: 'blocked',
              totalSteps: story!.totalSteps,
              loopCount: story!.loopCount,
              failure: 'totalSteps >= 40',
              retry: story!.retryCount,
            },
          })
        }
        break
      }
      if (story!.loopCount >= 5) {
        const prev = story!.state
        story!.state = 'blocked'
        story!.blockedReason = `runner: loopCount >= 5 (${story!.loopCount}); rollback loop unbound — manual review required`
        story!.updatedAt = new Date().toISOString()
        await stories.put(story!.id, story!)
        if (this.deps.trajectory) {
          void this.deps.trajectory.append({
            storyId: story!.id,
            kind: 'state_transition',
            label: `${prev} → blocked (loopCount guard)`,
            payload: {
              from: prev,
              to: 'blocked',
              totalSteps: story!.totalSteps,
              loopCount: story!.loopCount,
              failure: 'loopCount >= 5',
              retry: story!.retryCount,
            },
          })
        }
        break
      }

      const handler = STAGE_HANDLERS[story!.state]
      if (!handler) {
        story!.state = 'failed'
        story!.blockedReason = `runner: no handler for state ${story!.state}`
        story!.updatedAt = new Date().toISOString()
        await stories.put(story!.id, story!)
        break
      }

      // ---- Handoff-break detection (design §3/§4) ----
      // Before the current role runs, confirm its input artifacts exist on
      // disk. A missing input means the previous role never wrote what this
      // role needs; roll back to the producer instead of charging forward.
      // This is counted as a rollback (loopCount) and NEVER silent.
      const role = STATE_TO_ROLE[story!.state]
      if (role) {
        try {
          const artifactsDir = await ensureArtifacts(story!, this.deps)
          const rollback = handoffBreakRollback(artifactsDir, role)
          if (rollback) {
            story!.loopCount += 1
            const missing = missingInputArtifacts(artifactsDir, contractFor(role)!)
            story!.blockedReason = `runner: handoff break before ${role} — missing input artifact(s): ${missing.join(', ')}`
            story!.updatedAt = new Date().toISOString()
            await stories.put(story!.id, story!)
            if (this.deps.trajectory) {
              void this.deps.trajectory.append({
                storyId: story!.id,
                kind: 'state_transition',
                label: `${story!.state} → ${rollback} (handoff break)`,
                payload: {
                  from: story!.state,
                  to: rollback,
                  totalSteps: story!.totalSteps,
                  loopCount: story!.loopCount,
                  failure: `missing input artifact(s): ${missing.join(', ')}`,
                  retry: story!.retryCount,
                },
              })
            }
            this.deps.logger.warn(
              `Story ${storyId} handoff break ${story!.state} → ${rollback}: missing ${missing.join(', ')}`,
            )
            story!.state = rollback
            story!.updatedAt = new Date().toISOString()
            await stories.put(story!.id, story!)
            continue
          }
        } catch (handoffErr) {
          // A failure to even inspect the artifacts dir is not a handoff
          // break — let the stage's own error path handle it.
          this.deps.logger.warn(
            `Story ${storyId} handoff check failed: ${(handoffErr as Error).message}`,
          )
        }
      }

      const previousState = story!.state
      let next: StoryState
      let stageFailure: string | undefined
      try {
        // Count this as one role step (design §2.2 `totalSteps`).
        story!.totalSteps += 1
        next = await handler(story!, this.deps)
      } catch (err) {
        stageFailure = (err as Error).message
        story!.retryCount += 1
        if (story!.retryCount >= 3) {
          story!.state = 'failed'
          story!.blockedReason = `runner: stage ${previousState} failed 3 times: ${stageFailure}`
        } else {
          // Stay in the same state and let StoryQueue retry.
          this.deps.logger.warn(
            `Story ${storyId} stage ${previousState} threw (attempt ${story!.retryCount}/3): ${stageFailure}`,
          )
        }
        story!.updatedAt = new Date().toISOString()
        await stories.put(story!.id, story!)
        if (this.deps.trajectory) {
          void this.deps.trajectory.append({
            storyId: story!.id,
            kind: 'state_transition',
            label: `${previousState} → ${story!.state} (error)`,
            payload: {
              from: previousState,
              to: story!.state,
              totalSteps: story!.totalSteps,
              loopCount: story!.loopCount,
              failure: stageFailure,
              retry: story!.retryCount,
            },
          })
        }
        break
      }

      if (next === story!.state) {
        // No advancement (e.g., a stage that yielded itself). Stop the loop.
        this.deps.logger.debug(`Story ${storyId} halted at state=${story!.state}`)
        break
      }

      // ---- Output-artifact validation (design §3/§4) ----
      // A role may report success without writing its output (a subagent
      // that stopped 'completed' but produced no artifact, or a deterministic
      // handler whose write failed). Never silent: roll back to the role's
      // producer and count the handoff break against loopCount. Only for
      // FORWARD progress — a rollback/failed verdict legitimately writes no
      // output, so it is exempt.
      if (!isRollbackTransition(previousState, next) && next !== 'failed' && next !== 'blocked') {
        const outRole = STATE_TO_ROLE[previousState]
        const outContract = outRole ? contractFor(outRole) : undefined
        if (outRole && outContract) {
          try {
            const outDir = await ensureArtifacts(story!, this.deps)
            if (!outputArtifactPresent(outDir, outContract)) {
              const producer = PREVIOUS_ROLE_STATE[outRole]
              story!.blockedReason = `runner: ${outRole} reported success but did not write ${outContract.writes}`
              story!.updatedAt = new Date().toISOString()
              await stories.put(story!.id, story!)
              if (this.deps.trajectory) {
                void this.deps.trajectory.append({
                  storyId: story!.id,
                  kind: 'state_transition',
                  label: `${previousState} → ${producer ?? 'failed'} (missing output artifact)`,
                  payload: {
                    from: previousState,
                    to: producer ?? 'failed',
                    totalSteps: story!.totalSteps,
                    loopCount: story!.loopCount,
                    failure: `missing output artifact: ${outContract.writes}`,
                    retry: story!.retryCount,
                  },
                })
              }
              this.deps.logger.warn(
                `Story ${storyId} missing output ${outContract.writes} after ${outRole}; rolling back`,
              )
              if (producer) {
                story!.loopCount += 1
                story!.state = producer
                story!.updatedAt = new Date().toISOString()
                await stories.put(story!.id, story!)
                continue
              }
              // No producer to roll back to (first role in the chain) —
              // the pipeline cannot proceed without its root artifact.
              story!.state = 'failed'
              story!.blockedReason = `runner: ${outRole} produced no ${outContract.writes} and has no producer to roll back to`
              story!.updatedAt = new Date().toISOString()
              await stories.put(story!.id, story!)
              break
            }
          } catch (outErr) {
            // Inspecting the artifacts dir failed; the stage error path and
            // guards remain the backstop, so log and continue rather than
            // fabricate a handoff break.
            this.deps.logger.warn(
              `Story ${storyId} output check failed: ${(outErr as Error).message}`,
            )
          }
        }
      }

      // ---- loopCount (design §2.2) ----
      // Every BACKWARD transition (a rollback: critic→clarification, or
      // testing/verifying/reviewing/final_verifying→fixing) advances the
      // rollback loop counter. Forward progress leaves it untouched.
      if (isRollbackTransition(previousState, next)) {
        story!.loopCount += 1
        this.deps.logger.warn(
          `Story ${storyId} rollback ${previousState} → ${next} (loopCount=${story!.loopCount}/5)`,
        )
      }

      // ---- Trajectory: record the state transition BEFORE persisting
      // so the trajectory carries the exact from/to pair the runner saw.
      if (this.deps.trajectory) {
        void this.deps.trajectory.append({
          storyId: story!.id,
          kind: 'state_transition',
          label: `${previousState} → ${next}`,
          payload: {
            from: previousState,
            to: next,
            totalSteps: story!.totalSteps,
            loopCount: story!.loopCount,
            retry: story!.retryCount,
          },
        })
      }

      story!.state = next
      story!.updatedAt = new Date().toISOString()
      await stories.put(story!.id, story!)
      this.deps.logger.info(`Story ${storyId}: ${previousState} → ${next}`)
    }

    this.deps.logger.info(`StoryRunner done ${storyId} final state=${story!.state}`)
  }

  /**
   * Fold this story into the generic `PipelineInput` entry contract
   * (design §1.1 / seam F). The Tier-1 engine only ever reads
   * `PipelineInput`, so the session (and everything downstream) is
   * composed from the same shape whether the story came from a timed
   * TAPD pull or a human chat. The module's repo binding becomes
   * `input.git`; a story with no repo is git-less and the tail skips
   * branch/commit/push.
   */
  private buildPipelineInput(story: StoryRecord): PipelineInput {
    const m = this.deps.config.modules.find((x) => x.id === story.moduleId)
    return pipelineInputForStory(story, m)
  }

  /**
   * Bind a story to a DSH session, idempotently. The session is composed
   * from `input` (the generic entry contract) rather than the story
   * record, so the title / worktree / provenance come from the one shape
   * both entry points produce. If the story already carries a
   * `mainSessionId`, or the sessions service is absent (headless
   * profile), this is a no-op. Otherwise it creates a new session whose
   * working directory is the story's worktree (from `input.git`), sets
   * the session title to `input.title`, and persists the id back onto
   * `story.mainSessionId`.
   */
  private async ensureSession(story: StoryRecord, input: PipelineInput): Promise<void> {
    if (story.mainSessionId) return
    const sessions = this.deps.sessions
    if (!sessions || typeof sessions.create !== 'function') return

    try {
      // Block A: if the story does not already hang under a workspace
      // session, resolve the CURRENT initiator as the workspace session
      // parent so the story session joins the live session tree. This is
      // what turns a bare `mainSessionId` into an actual parent/child edge
      // the subagent runtime can walk.
      if (!story.parentSessionId && this.deps.agents) {
        const parent = this.deps.agents.currentInitiator()
        if (parent) story.parentSessionId = String(parent.id)
      }

      const handle = sessions.create(undefined, {
        meta: {
          cwd: input.git?.worktreePath ?? story.worktreePath,
          origin: 'subagent',
          // Block A: bind the story session to the rd-pipeline preset and
          // hang it under the workspace session in the session tree.
          agentPreset: 'rd-pipeline',
          parentSession: story.parentSessionId,
        },
      })
      story.mainSessionId = handle.id
      // Persist the preset id the session was composed from so a resumed
      // session cannot replay under a different composition (design §2.2).
      story.agentPreset = 'rd-pipeline'
      story.updatedAt = new Date().toISOString()
      await this.deps.storage.stories().put(story.id, story)

      // Set the session's display title to the entry title so the DSH
      // session list reads naturally. Non-fatal if the title service is
      // absent.
      if (this.deps.sessionTitle && typeof this.deps.sessionTitle.rename === 'function') {
        try {
          this.deps.sessionTitle.rename(handle, input.title)
        } catch (titleErr) {
          this.deps.logger.warn(
            `StoryRunner: created session ${handle.id} but failed to title it: ${(titleErr as Error).message}`,
          )
        }
      }

      this.deps.logger.info(
        `StoryRunner: bound story ${story.id} to DSH session ${handle.id}`,
      )
    } catch (err) {
      // Non-fatal — the pipeline proceeds without a live session.
      this.deps.logger.warn(
        `StoryRunner: failed to create session for story ${story.id}: ${(err as Error).message}`,
      )
    }
  }
}

function isTerminalState(state: StoryState): boolean {
  return (
    state === 'delivery_ready' ||
    state === 'mr_opened' ||
    state === 'completed' ||
    state === 'failed' ||
    state === 'blocked'
  )
}

/**
 * True when a transition is a ROLLBACK (the story moves backwards in the
 * fixed orchestration order), which advances `loopCount`. The only legal
 * backward edges in the Tier-1 state machine are:
 *
 *   critic → clarification          (systemic design gap)
 *   testing/verifying/reviewing/final_verifying → fixing   (fix loop)
 */
function isRollbackTransition(from: StoryState, to: StoryState): boolean {
  if (from === 'critic' && to === 'clarification') return true
  const fixLoopStates: StoryState[] = ['testing', 'verifying', 'reviewing', 'final_verifying']
  return fixLoopStates.includes(from) && to === 'fixing'
}

// ---- Artifact contract (design §3) ------------------------------------
//
// The role handoff interface is the artifacts directory, not session
// history (O-3). Each row declares the fixed input files a role may read
// and the fixed output file it must write. The runner validates the INPUT
// set before a role is spawned; a missing input is a handoff break, which
// rolls back to the producing role instead of silently charging forward.

interface ArtifactContractRow {
  /** Role/persona name, matching `req.agentName` where unambiguous. */
  role: string
  /** Fixed input filenames the role may read. */
  reads: string[]
  /** Fixed output filename the role must write. */
  writes: string
}

const ARTIFACT_CONTRACT: ArtifactContractRow[] = [
  { role: 'context', reads: [], writes: '01-context.md' },
  { role: 'clarification', reads: ['01-context.md'], writes: '02-clarification.md' },
  { role: 'resolution', reads: ['02-clarification.md'], writes: '02b-resolution.md' },
  { role: 'brainstorm', reads: ['01-context.md', '02-clarification.md', '02b-resolution.md'], writes: '03-proposal-{minimal,clean,novel}.md' },
  { role: 'critic', reads: ['03-proposal-minimal.md', '03-proposal-clean.md', '03-proposal-novel.md'], writes: '04-critique.md' },
  { role: 'decision', reads: ['04-critique.md'], writes: '05-decision.md' },
  { role: 'spec', reads: ['05-decision.md'], writes: '06-spec.md' },
  { role: 'planner', reads: ['06-spec.md'], writes: '07-tasks.md' },
  { role: 'implementation', reads: ['07-tasks.md', '06-spec.md'], writes: '08-impl-<taskId>.md' },
  { role: 'test', reads: ['08-impl-<taskId>.md'], writes: '09-test-report.md' },
  { role: 'fix', reads: ['08-impl-<taskId>.md', '09-test-report.md'], writes: '10-fix-report-attempt-<n>.md' },
  { role: 'verification', reads: ['08-impl-<taskId>.md', '06-spec.md'], writes: '11-verify-report.md' },
  { role: 'review', reads: [], writes: '12-review-<taskId>-<axis>.md' },
  { role: 'final-verify', reads: [], writes: '13-final-verify-<axis>.md' },
]

/** Resolve a contract row by role. Output filenames may carry the `<>` /
 * `{}` placeholders the fixed file uses for per-task / per-axis variants. */
function contractFor(role: string): ArtifactContractRow | undefined {
  return ARTIFACT_CONTRACT.find((r) => r.role === role)
}

/** Escape regex metacharacters so a fixed artifact name is matched literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a contract filename (which may carry `<...>` / `{...}` placeholders
 * for per-task / per-axis / per-attempt variants) into an anchored regex whose
 * placeholders match any non-empty filename run. `08-impl-<taskId>.md` matches
 * `08-impl-T001.md`; `12-review-<taskId>-<axis>.md` matches
 * `12-review-T001-standards.md`.
 */
function artifactPatternToRegExp(pattern: string): RegExp {
  const source = pattern
    .split(/<[^>]+>|\{[^}]+\}/)
    .map(escapeRegExp)
    .join('[^/\\\\]+')
  return new RegExp(`^${source}$`)
}

/**
 * The exact filenames in `reads` that are MISSING from the artifacts dir.
 * A non-empty result is a handoff break (design §4): the previous role did
 * not leave the input this role needs. A placeholder name is satisfied by
 * "at least one file matching the family" (see `artifactPatternToRegExp`).
 */
function missingInputArtifacts(artifactsDir: string, contract: ArtifactContractRow): string[] {
  if (contract.reads.length === 0) return []
  const present = existsSync(artifactsDir) ? readdirSync(artifactsDir) : []
  return contract.reads.filter((f) => {
    if (present.includes(f)) return false
    const re = artifactPatternToRegExp(f)
    return !present.some((p) => re.test(p))
  })
}

/**
 * The "previous role" state for every contract role — the role that produced
 * this role's INPUT. This is the §4 rollback target ("产物文件缺失 → 上一个
 * 角色") for a handoff break, whether the break is a missing INPUT (detected
 * before the role runs) or a missing OUTPUT (detected after a role reports
 * success without writing its artifact). `null` marks the first role in the
 * chain, which has no producer to roll back to.
 */
const PREVIOUS_ROLE_STATE: Record<string, StoryState | null> = {
  context: null,
  clarification: 'context',
  // Resolution rides INSIDE the `clarification` state (no state of its
  // own), so its "producer" — and brainstorm's producer — is the
  // `clarification` state: a handoff break before brainstorm rolls back
  // to `clarification`, which re-runs clarification + resolution together.
  resolution: 'clarification',
  brainstorm: 'clarification',
  critic: 'brainstorm',
  decision: 'critic',
  spec: 'decision',
  planner: 'spec',
  implementation: 'planning',
  test: 'implementing',
  fix: 'testing',
  verification: 'testing',
  review: 'verifying',
  'final-verify': 'reviewing',
}

/**
 * Validate a role's INPUT artifacts before spawning it. Returns the state
 * to roll back to when a handoff break is found, or `null` when inputs are
 * intact.
 */
function handoffBreakRollback(
  artifactsDir: string,
  role: string,
): StoryState | null {
  const contract = contractFor(role)
  if (!contract) return null
  const missing = missingInputArtifacts(artifactsDir, contract)
  if (missing.length === 0) return null
  return PREVIOUS_ROLE_STATE[role] ?? null
}

/** Map the Tier-1 story states onto the artifact-contract role names. */
const STATE_TO_ROLE: Partial<Record<StoryState, string>> = {
  context: 'context',
  clarification: 'clarification',
  brainstorm: 'brainstorm',
  critic: 'critic',
  decision: 'decision',
  spec: 'spec',
  planning: 'planner',
  implementing: 'implementation',
  testing: 'test',
  fixing: 'fix',
  verifying: 'verification',
  reviewing: 'review',
  final_verifying: 'final-verify',
}

/**
 * True when the contract's OUTPUT artifact exists on disk (family match, so
 * per-task / per-axis / per-attempt placeholders are accepted). Used to detect
 * a role that reported success but never wrote its output — never silent
 * (design §3/§4).
 */
function outputArtifactPresent(artifactsDir: string, contract: ArtifactContractRow): boolean {
  if (contract.writes.length === 0) return true
  if (!existsSync(artifactsDir)) return false
  const present = readdirSync(artifactsDir)
  if (present.includes(contract.writes)) return true
  return present.some((p) => artifactPatternToRegExp(contract.writes).test(p))
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
      // Block A: the main session id is the parent Agent for role-spawn.
      mainSessionId: story.mainSessionId,
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
      // The kind is informational; every one of the 14 artifact kinds in
      // ArtifactRefSchema is reachable from a stage here.
      kind: key as
        | 'context'
        | 'clarification'
        | 'resolution'
        | 'proposal'
        | 'critique'
        | 'decision'
        | 'spec'
        | 'plan'
        | 'implementation'
        | 'test'
        | 'fix'
        | 'verification'
        | 'review'
        | 'final_verify',
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
    // Only an empty story description parks here — nothing for the
    // resolver to ground a decision in (design: full-auto resolution).
    story.blockedReason = `clarification: ${result.reason}`
    deps.logger.warn(`ClarificationAgent blocked story ${story.id}: ${result.reason}`)
    return 'blocked'
  }
  if (result.status !== 'success') {
    deps.logger.warn(`ClarificationAgent returned status=${result.status} for story ${story.id}`)
    return 'failed'
  }

  recordArtifact(story, 'clarification', '02-clarification.md', result.summary ?? '')
  deps.logger.info(`ClarificationAgent wrote artifact for story ${story.id}`)

  // The sentinel is the SINGLE SOURCE OF TRUTH. The deterministic handler
  // already returns `blocked` for an empty description, but the
  // model-backed path completes normally even when it writes
  // `[CLARIFICATION_BLOCKED: empty description]` — so re-check here.
  const sentinel = readClarificationSentinel(join(artifactsDir, '02-clarification.md'))
  deps.logger.info(`Clarification sentinel for story ${story.id}: ${sentinel}`)

  if (sentinel === 'blocked') {
    story.blockedReason = 'clarification: empty description — nothing to resolve'
    deps.logger.warn(`ClarificationAgent blocked story ${story.id}: empty description`)
    return 'blocked'
  }

  // Bounded or question-bearing, the resolver ALWAYS runs next so
  // brainstorm's input contract (`02b-resolution.md`) is satisfied
  // uniformly: a bounded story gets an empty decision ledger, a
  // question-bearing story gets one decision per question.
  const resolution = await deps.agentProvider.dispatch({
    agentName: 'resolution',
    label: `Resolution: ${story.id}`,
    worktreePath: story.worktreePath!,
    artifactsDir,
    inputs: storyInput(story),
  })

  if (resolution.status !== 'success') {
    deps.logger.warn(`ResolutionAgent returned status=${resolution.status} for story ${story.id}`)
    return 'failed'
  }

  recordArtifact(story, 'resolution', '02b-resolution.md', resolution.summary ?? '')
  deps.logger.info(`ResolutionAgent wrote artifact for story ${story.id}`)
  return 'brainstorm'
}

/**
 * Read the final sentinel line the Clarification stage wrote. Returns
 * `complete` for `[CLARIFICATION_COMPLETE]`, `questions` for
 * `[CLARIFICATION_QUESTIONS: N]`, `blocked` for
 * `[CLARIFICATION_BLOCKED: ...]`, or `unknown` when no sentinel is found.
 */
function readClarificationSentinel(path: string): 'complete' | 'questions' | 'blocked' | 'unknown' {
  let content: string
  try {
    content = readFileSync(path, 'utf-8')
  } catch {
    return 'unknown'
  }
  const lines = content.split(/\r?\n/).map((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === '[CLARIFICATION_COMPLETE]') return 'complete'
    if (/^\[CLARIFICATION_QUESTIONS:\s*\d+\]$/.test(line)) return 'questions'
    if (/^\[CLARIFICATION_BLOCKED/.test(line)) return 'blocked'
  }
  return 'unknown'
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
    story.blockedReason = `critic: rolling back — ${result.reason}`
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
    story.blockedReason = `spec: ${result.reason}`
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
    story.blockedReason = `planning: failed to read 07-tasks.md: ${(err as Error).message}`
    deps.logger.error(`Planning: cannot read 07-tasks.md for story ${story.id}: ${story.blockedReason}`)
    return 'blocked'
  }

  if (parsed.length === 0) {
    story.blockedReason = `planning: planner produced zero tasks in 07-tasks.md`
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
      story.blockedReason = `implementing: task ${blockedTask?.id} ${blockedTask?.status}: ${blockedTask?.blockedReason ?? 'unknown'}`
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
    // Block A: persist the child subagent session id onto the TaskRecord so
    // the implementation session lineage is recoverable (design §2.2).
    if (result.childId) task.implementationSessionId = result.childId
    if (result.status === 'success') {
      task.status = 'completed'
      task.implementationResult = result.summary
      didAdvance = true
    } else if (result.status === 'blocked') {
      task.status = 'blocked'
      task.blockedReason = result.reason
      story.blockedReason = `implementing: task ${task.id} blocked — ${result.reason}`
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
 * testing — dispatch TestAgent, which runs the worktree's real test
 * suite (see services/test-executor.ts). The orchestrator transitions
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
 * fixing — dispatch FixAgent against the most-recently-failed task, then
 * loop back to `testing`. The 5-round breaker (SD-4) is enforced via the
 * SUM of attemptCount across all the story's tasks: if the sum reaches
 * 5, the story is parked in `blocked`.
 *
 * The FixAgent handler commits its work for real (services/worktree-git.ts),
 * so a successful round genuinely advances the branch.
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
    story.blockedReason = `fixing: 5-round breaker tripped after ${totalAttempts} attempts on task ${target.id}`
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
    story.blockedReason = `fixing: task ${target.id} blocked — ${result.reason}`
    return 'blocked'
  }
  if (result.status !== 'success') {
    target.status = 'failed'
    target.blockedReason = result.reason
  } else {
    // The handler succeeded but the suite may still be red — `testing`
    // re-runs and decides. Flip back to in_progress so the next
    // `testing` pass accounts for this attempt.
    target.status = 'in_progress'
  }
  await tasks.put(target.id, target)
  recordArtifact(
    story,
    'fix',
    // Unify with the handler's on-disk name (design §10 item 3): the fix
    // report is per-attempt, never a bare `10-fix-report.md`.
    `10-fix-report-attempt-${attempt}.md`,
    result.status === 'success' ? result.summary ?? '' : `attempt ${attempt} failed: ${result.reason}`,
  )
  return 'testing'
}

/**
 * verifying — dispatch VerificationAgent on the integration tree.
 *
 * Verdict mapping, per the sentinel contract in design §6.7:
 *   - success (VERIFY_PASS)               -> `reviewing`
 *   - failed  (VERIFY_PARTIAL / REJECT)   -> `fixing`
 *   - blocked                             -> `blocked` (defensive; the
 *                                            current handler never
 *                                            returns it, but a future
 *                                            one may)
 *
 * Both non-PASS verdicts return to `fixing` by design. The SD-4 5-round
 * breaker is what stops a REJECT from cycling indefinitely.
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

  if (result.status === 'blocked') {
    story.blockedReason = `verifying: ${result.reason}`
    deps.logger.warn(`VerificationAgent blocked story ${story.id}: ${result.reason}`)
    return 'blocked'
  }
  if (result.status === 'failed') {
    // PARTIAL or REJECT — the branch is verifiable but not passing.
    recordArtifact(story, 'verification', '11-verify-report.md', result.reason)
    deps.logger.warn(`VerificationAgent ${result.reason} for story ${story.id} → fixing`)
    return 'fixing'
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
  // Family pattern (same convention as brainstorm's
  // `03-proposal-{minimal,clean,novel}.md`): `artifactPatternToRegExp`
  // matches it against BOTH on-disk per-axis files written by the
  // ReviewHandler (`12-review-<taskId>-<axis>.md`), so the ledger and the
  // disk stay consistent without needing a second artifact kind.
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

  // Family pattern (same convention as brainstorm): the FinalVerifyHandler
  // writes one file per axis (`13-final-verify-<axis>.md`); recording the
  // `{standards,spec}` family keeps the ledger consistent with the disk
  // files that `artifactPatternToRegExp` will match.
  recordArtifact(story, 'final_verify', '13-final-verify-{standards,spec}.md', verdicts.join(' | '))

  if (rejected) {
    deps.logger.warn(`FinalVerify: rejected (${verdicts.filter((v) => !v.endsWith(':success')).join(', ')})`)
    return 'fixing'
  }

  // ---- Conditional push (Tier-1 tail, design §1.3) ----
  // git present → push the story branch to origin and record the pushed
  // SHA; git absent → skip (code stays in the workspace, review/final-verify
  // already ran on the artifact files). A push failure throws and is caught
  // by the runner's standard retry path (transient push errors retry like
  // any other stage failure).
  await conditionallyPush(story, deps)

  return 'delivery_ready'
}

/**
 * Tier-1 tail conditional push (design §1.3): push only when the story is
 * bound to a git worktree. Writes `pushedSha` / `pushedAt` checkpoints and a
 * trajectory `external_side_effect` on success. Throws on failure so the
 * runner's retry path (retryCount / failed-after-3) handles it uniformly.
 */
async function conditionallyPush(story: StoryRecord, deps: StoryRunnerDeps): Promise<void> {
  if (!story.worktreePath || !story.branch) {
    deps.logger.info(
      `Story ${story.id}: no git worktree — skipping push (code stays in workspace)`,
    )
    return
  }

  const result = await pushBranch(
    { logger: deps.logger },
    {
      worktreePath: story.worktreePath,
      branch: story.branch,
      remote: 'origin',
      userName: deps.config.gitlabPushUserName,
      userEmail: deps.config.gitlabPushUserEmail,
    },
  )

  story.pushedSha = result.pushedSha ?? undefined
  story.pushedAt = new Date().toISOString()
  await deps.storage.stories().put(story.id, story)
  if (deps.trajectory) {
    void deps.trajectory.append({
      storyId: story.id,
      kind: 'external_side_effect',
      label: `push ${story.branch} → origin`,
      payload: {
        pushedSha: result.pushedSha,
        alreadyUpToDate: result.alreadyUpToDate,
        pushedAt: story.pushedAt,
      },
    })
  }
  deps.logger.info(
    `Story ${story.id}: pushed ${story.branch} (sha=${result.pushedSha ?? 'up-to-date'})`,
  )
}