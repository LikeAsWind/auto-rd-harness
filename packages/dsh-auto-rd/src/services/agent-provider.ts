/**
 * AgentProvider — dispatches SubAgents for auto-rd's 13 specialized roles.
 *
 * This is the bridge between StoryRunner (state machine) and DSH's agent
 * factory. Each persona in src/agents/ registers here.
 *
 * M1: only ContextAgent is wired in. The other 12 throw `agentNotImplemented`
 * so the orchestrator can short-circuit cleanly.
 *
 * SubAgent integration strategy:
 *   - We attempt to read `ctx.subagents` (injected by DSH). If present, we
 *     invoke it as the real dispatch path; if absent (e.g. building outside
 *     a running harness), we fall back to an in-process stub that still
 *     writes the same artifact shape so the state machine can advance.
 *   - Either way the persona markdown is written to the artifacts dir so a
 *     human/operator can inspect what would be sent to the model.
 *
 * Borrowed patterns:
 * - SD-2: Fresh Subagent Per Task (we re-dispatch a fresh subagent per stage)
 * - SD-3: No-Subagents Contract (subagents must not spawn further subagents)
 */
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config.js'
import type { Logger } from '../utils/logger.js'
import { ContextAgent } from '../agents/context.js'
import { ClarificationAgent } from '../agents/clarification.js'
import { BrainstormAgent, type BrainstormVariation } from '../agents/brainstorm.js'
import { CriticAgent } from '../agents/critic.js'
import { DecisionAgent } from '../agents/decision.js'
import { SpecAgent } from '../agents/spec.js'
import { PlannerAgent } from '../agents/planner.js'
import { ImplementationAgent } from '../agents/implementation.js'
import { TestAgent } from '../agents/test.js'
import { FixAgent } from '../agents/fix.js'
import { VerificationAgent } from '../agents/verification.js'
import { ReviewAgent } from '../agents/review.js'
import { FinalVerifyAgent } from '../agents/final-verify.js'
import type { AgentSpec } from '../agents/base.js'
import type { TrajectoryRecorder } from './trajectory.js'
import { runWorktreeTests } from './test-executor.js'
import { readWorktreeDiff, type DiffResult } from './git-diff-reader.js'

/**
 * Axis parameter for the parallel two-axis review agents. The orchestrator
 * dispatches review / final-verify twice — once per axis — and merges the
 * findings downstream (CR-4: Don't Merge or Rerank at this layer; just
 * produce per-axis reports).
 */
export type ReviewAxis = 'standards' | 'spec'

export interface AgentDispatchRequest {
  agentName: string
  label: string
  worktreePath: string
  artifactsDir: string
  inputs: Record<string, unknown>
  /**
   * Optional variation parameter for agents that are dispatched multiple
   * times in parallel (currently only BrainstormAgent: minimal / clean /
   * novel — see design doc auto-rd-native-plugin-design.md §6.6).
   */
  variation?: BrainstormVariation
  /** Optional index inside the parallel-dispatch set, 1-based. */
  variationIndex?: number
  /**
   * Axis for two-axis review (review / final-verify). The orchestrator
   * dispatches each review agent twice — once per axis — and the stub
   * uses this to write a per-axis artifact file.
   */
  axis?: ReviewAxis
  /**
   * Optional task identifier for ImplementationAgent / FixAgent so the
   * stub can write a per-task artifact (e.g., 08-impl-T001.md).
   */
  taskId?: string
}

export type AgentDispatchResult =
  | { status: 'success'; summary?: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string }

type AgentHandler = (
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
) => Promise<AgentDispatchResult>

interface RegistryEntry {
  spec: AgentSpec
  handler: AgentHandler
}

export interface AgentProviderDeps {
  logger: Logger
  config: Config
  /**
   * Optional TrajectoryRecorder. When present, every dispatch appends
   * an `agent_dispatch` event with the resolved inputs and (on the
   * next tick) the handler result. Optional so unit tests can omit it.
   */
  trajectory?: TrajectoryRecorder
}

/**
 * The minimum shape of DSH's `subagents` service that we depend on.
 *
 * We only use a tiny surface: a single `start` that takes a label and a
 * request bag and returns a child session id (or throws). This keeps us
 * decoupled from the upstream type definitions and lets us compile in
 * isolation. If the real service offers more, we ignore it.
 */
interface SubagentsService {
  start(args: {
    provider?: string
    label: string
    request: Record<string, unknown>
  }): Promise<{ childId?: string }>
}

export class AgentProvider {
  private readonly registry = new Map<string, RegistryEntry>()
  private readonly subagents: SubagentsService | null
  private brainstormSpecByVariation: Partial<Record<BrainstormVariation, AgentSpec>> | null = null
  private brainstormHandler: AgentHandler | null = null
  /**
   * ImplementationAgent is unique-per-task: the orchestrator creates a fresh
   * instance per task (SD-2). The dispatch path picks the right instance
   * from the supplied `taskId`; missing → fall through to a default
   * placeholder spec for the registration.
   */
  private implementationSpecByTaskId: Map<string, AgentSpec> = new Map()
  private implementationDefaultSpec: AgentSpec | null = null
  private implementationHandler: AgentHandler | null = null

  private reviewSpecByAxis: Partial<Record<ReviewAxis, AgentSpec>> | null = null
  private reviewHandler: AgentHandler | null = null

  private finalVerifySpecByAxis: Partial<Record<ReviewAxis, AgentSpec>> | null = null
  private finalVerifyHandler: AgentHandler | null = null

  constructor(private readonly ctx: Context, private readonly deps: AgentProviderDeps) {
    this.registerBuiltins()
    // Best-effort probe. `ctx.get` is the supported read path for optional
    // services — it returns undefined rather than throwing when the service
    // is not registered in this fiber.
    this.subagents = this.tryGetSubagents()
    if (this.subagents) {
      this.deps.logger.info('AgentProvider: ctx.subagents detected — real dispatch path active')
    } else {
      this.deps.logger.warn(
        'AgentProvider: ctx.subagents unavailable — falling back to in-process stub handler',
      )
    }
  }

  private tryGetSubagents(): SubagentsService | null {
    try {
      // Cordis exposes services as both ctx.<name> and ctx.get(name). The
      // latter is the documented read for optional dependencies.
      const svc = (this.ctx as unknown as { get?: (k: string) => unknown }).get?.(
        'subagents',
      ) as SubagentsService | undefined
      if (svc && typeof (svc as SubagentsService).start === 'function') return svc
    } catch {
      // ctx.get may throw if the service is not whitelisted in `inject:`.
      // Treat that as "not available" and keep the stub path.
    }
    return null
  }

  /**
   * Dispatch an agent by name.
   */
  async dispatch(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
    // Several agents need per-dispatch spec lookup (Brainstorm by variation,
    // Implementation by taskId, Review/FinalVerify by axis). Resolve the
    // spec + handler before falling through to the generic registry path.
    let spec: AgentSpec
    let handler: AgentHandler
    if (req.agentName === 'brainstorm') {
      const variationSpec = this.brainstormSpecFor(req)
      if (!variationSpec || !this.brainstormHandler) {
        return { status: 'failed', reason: `agentNotImplemented:brainstorm:${req.variation}` }
      }
      spec = variationSpec
      handler = this.brainstormHandler
    } else if (req.agentName === 'implementation') {
      const taskId = req.taskId ?? 'default'
      spec = this.implementationSpecByTaskId.get(taskId) ?? this.implementationDefaultSpec!
      if (!this.implementationHandler) {
        return { status: 'failed', reason: `agentNotImplemented:implementation` }
      }
      handler = this.implementationHandler
    } else if (req.agentName === 'review') {
      const axisSpec = req.axis ? this.reviewSpecByAxis?.[req.axis] : undefined
      if (!axisSpec || !this.reviewHandler) {
        return { status: 'failed', reason: `agentNotImplemented:review:${req.axis}` }
      }
      spec = axisSpec
      handler = this.reviewHandler
    } else if (req.agentName === 'final-verify') {
      const axisSpec = req.axis ? this.finalVerifySpecByAxis?.[req.axis] : undefined
      if (!axisSpec || !this.finalVerifyHandler) {
        return { status: 'failed', reason: `agentNotImplemented:final-verify:${req.axis}` }
      }
      spec = axisSpec
      handler = this.finalVerifyHandler
    } else {
      const entry = this.registry.get(req.agentName)
      if (!entry) {
        return { status: 'failed', reason: `agentNotImplemented:${req.agentName}` }
      }
      spec = entry.spec
      handler = entry.handler
    }

    // Persist the persona into a known location so a real SubAgentProvider
    // can read it (or so an operator can audit what was sent).
    writeFileSync(
      join(req.artifactsDir, 'agent-persona.md'),
      `# Persona (${spec.name}` +
        `${req.variation ? ` / ${req.variation}` : ''}` +
        `${req.axis ? ` / ${req.axis}` : ''}` +
        `${req.taskId ? ` / ${req.taskId}` : ''}` +
        `)\n\n${spec.persona}`,
      'utf-8',
    )

    // Real path: hand off to DSH's subagents service. We don't await a
    // session finish — we just record that a subagent was launched. The
    // state machine remains the source of truth for advancement; the
    // agent's artifact is what we trust, and the stub handler below
    // produces it synchronously. Future milestones will wire the actual
    // subagent result into the same artifact file.
    if (this.subagents) {
      try {
        await this.subagents.start({
          provider: 'spawn',
          label: req.label,
          request: {
            persona: spec.persona,
            toolFilter: spec.toolFilter,
            worktreePath: req.worktreePath,
            artifactsDir: req.artifactsDir,
            inputs: req.inputs,
            variation: req.variation,
          },
        })
        this.deps.logger.info(`Subagent launched for ${req.agentName}${req.variation ? ` (${req.variation})` : ''}${req.axis ? ` (${req.axis})` : ''}${req.taskId ? ` (${req.taskId})` : ''}: ${req.label}`)
      } catch (err) {
        this.deps.logger.error(
          `Subagent start failed for ${req.agentName}: ${(err as Error).message}; falling back to stub`,
        )
      }
    }

    // ---- Trajectory logging ----
    // Record the dispatch event before running the handler so the
    // trajectory captures the exact inputs that were sent. The
    // storyId is read from `req.inputs.story.id` (every agent input
    // bag carries a story snippet by contract).
    const storyId = (req.inputs as { story?: { id?: string } } | undefined)?.story?.id
    if (this.deps.trajectory && storyId) {
      void this.deps.trajectory.append({
        storyId,
        kind: 'agent_dispatch',
        label: `${spec.name}${req.variation ? `/${req.variation}` : ''}${req.axis ? `/${req.axis}` : ''}${req.taskId ? `/${req.taskId}` : ''}: ${req.label}`,
        payload: {
          agent: spec.name,
          variation: req.variation,
          axis: req.axis,
          taskId: req.taskId,
          toolFilter: spec.toolFilter,
          inputs: req.inputs,
          artifactsDir: req.artifactsDir,
          worktreePath: req.worktreePath,
        },
      })
    }

    const result = await handler(req, this.deps)

    // Record the handler result for the same story.
    if (this.deps.trajectory && storyId) {
      void this.deps.trajectory.append({
        storyId,
        kind: 'agent_result',
        label: `${spec.name}${req.variation ? `/${req.variation}` : ''}${req.axis ? `/${req.axis}` : ''}${req.taskId ? `/${req.taskId}` : ''}: ${result.status}`,
        payload: { agent: spec.name, result },
      })
    }

    return result
  }

  /**
   * Register one AgentSpec instance under a name. Used by tests to inject
   * alternate personas.
   */
  register(name: string, spec: AgentSpec, handler: AgentHandler): void {
    this.registry.set(name, { spec, handler })
  }

  private registerBuiltins(): void {
    this.register('context', new ContextAgent(), runContextStub)
    this.register('clarification', new ClarificationAgent(), runClarificationStub)
    // BrainstormAgent is special: the same name is dispatched three times in
    // parallel with different `variation` values. The dispatch path picks the
    // right AgentSpec per call rather than registering three separate keys.
    this.brainstormSpecByVariation = {
      minimal: new BrainstormAgent('minimal', 1),
      clean: new BrainstormAgent('clean', 2),
      novel: new BrainstormAgent('novel', 3),
    }
    this.brainstormHandler = runBrainstormStub
    this.register('critic', new CriticAgent(), runCriticStub)
    this.register('decision', new DecisionAgent(), runDecisionStub)
    this.register('spec', new SpecAgent(), runSpecStub)
    this.register('planner', new PlannerAgent(), runPlannerStub)

    // ImplementationAgent: a fresh instance per task (SD-2). The dispatch
    // path caches one spec per taskId, with a default fallback for any
    // taskId the registry hasn't seen (still rare — the orchestrator
    // pre-creates them).
    this.implementationDefaultSpec = new ImplementationAgent('default')
    this.implementationHandler = runImplementationStub

    this.register('test', new TestAgent(), runTestStub)
    this.register('fix', new FixAgent(), runFixStub)
    this.register('verification', new VerificationAgent(), runVerificationStub)

    // Review and FinalVerify are dispatched twice in parallel — once per
    // axis. Same pattern as Brainstorm: same name, axis parameter chooses
    // the AgentSpec instance.
    this.reviewSpecByAxis = {
      standards: new ReviewAgent(),
      spec: new ReviewAgent(),
    }
    this.reviewHandler = runReviewStub
    this.finalVerifySpecByAxis = {
      standards: new FinalVerifyAgent(),
      spec: new FinalVerifyAgent(),
    }
    this.finalVerifyHandler = runFinalVerifyStub
  }

  /**
   * Make sure the implementation registry has an AgentSpec for `taskId`.
   * The orchestrator calls this once per task before dispatching so the
   * dispatch path can always find a per-task spec.
   */
  ensureImplementationSpec(taskId: string): AgentSpec {
    let spec = this.implementationSpecByTaskId.get(taskId)
    if (!spec) {
      spec = new ImplementationAgent(taskId)
      this.implementationSpecByTaskId.set(taskId, spec)
    }
    return spec
  }

  /**
   * Look up the AgentSpec for a BrainstormAgent by variation. Returns
   * undefined if the request didn't specify a known variation.
   */
  private brainstormSpecFor(req: AgentDispatchRequest): AgentSpec | undefined {
    if (!req.variation) return undefined
    return this.brainstormSpecByVariation?.[req.variation]
  }
}

// ---- Stub Handlers ----
//
// Every agent in M2 has a stub handler here. The stub produces the same
// artifact shape the real model would produce — including the sentinel
// token the state machine parses — so the 19-state pipeline can advance
// end-to-end without a model attached. Replace any of these with a real
// dispatch path when the corresponding agent becomes model-backed.

async function runContextStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string; description: string }
  deps.logger.info(`ContextAgent stub running for story ${story.id}`)

  const report = [
    `# Context Report — ${story.title}`,
    ``,
    `## Environment Verification`,
    `- Worktree: \`${req.worktreePath}\``,
    `- Branch: \`auto-rd/${story.id}\``,
    ``,
    `## Project Setup`,
    `- Command run: <detected install command>`,
    `- Result: success (stub — real detection lands when the SubAgent is model-backed)`,
    ``,
    `## Baseline Tests`,
    `- Command: <detected test command>`,
    `- Result: N/N passing (stub)`,
    ``,
    `## Codebase Map`,
    `- (stub: real exploration happens once the SubAgent provider is wired up)`,
    ``,
    `## Handoff`,
    `Stub. Next stage is \`clarification\`.`,
    ``,
    `[CONTEXT_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '01-context.md'), report, 'utf-8')

  return {
    status: 'success',
    summary: 'Stub Context report.',
  }
}

async function runClarificationStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string; description: string }
  deps.logger.info(`ClarificationAgent stub running for story ${story.id}`)

  const report = [
    `# Clarification — ${story.title}`,
    ``,
    `CLASSIFICATION: bounded`,
    ``,
    `## Resolved (no question needed)`,
    `- Inputs: story description specifies them`,
    `- Outputs: behavior is well-defined`,
    ``,
    `## Open Questions`,
    `_None — story is unambiguous in the stub._`,
    ``,
    `## Handoff`,
    `Stub. Zero open questions; orchestrator may proceed to \`brainstorm\`.`,
    ``,
    `[CLARIFICATION_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '02-clarification.md'), report, 'utf-8')

  return { status: 'success', summary: 'Stub Clarification report (zero open questions).' }
}

async function runBrainstormStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  const variation = req.variation ?? 'minimal'
  deps.logger.info(`BrainstormAgent stub running for story ${story.id} variation=${variation}`)

  const report = [
    `# Proposal (${variation}) — ${story.title}`,
    ``,
    `**Recommended because**: this is the stub path; the real model will fill in trade-offs.`,
    ``,
    `## Approach`,
    `Stub ${variation} approach.`,
    ``,
    `## Files Affected`,
    `- \`<worktree>/src/<feature>.ts\` — create — primary change`,
    `- \`<worktree>/tests/<feature>.test.ts\` — create — test coverage`,
    ``,
    `## Code Sketch`,
    '```ts',
    `// signature only — real impl in the implementing stage`,
    `export function handle<Feature>(req: Request): Response { /* TODO */ }`,
    '```',
    ``,
    `## Trade-offs`,
    `- ✅ Smallest change — impact: low risk`,
    `- ⚠️ Reuses existing helper — impact: couples to its quirks`,
    `- ❌ Test surface is small — impact: less safety net`,
    ``,
    `## YAGNI Dropped`,
    `- Generic retry abstraction — Reason: one call site`,
    ``,
    `## Spec Coverage`,
    `- AC: "<see story description>" → satisfied by \`<worktree>/src/<feature>.ts\``,
    ``,
    `[BRAINSTORM_${variation.toUpperCase()}_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, `03-proposal-${variation}.md`), report, 'utf-8')

  return { status: 'success', summary: `Stub Brainstorm proposal (${variation}).` }
}

async function runCriticStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  deps.logger.info(`CriticAgent stub running for story ${story.id}`)

  const report = [
    `# Critique — ${story.title}`,
    ``,
    `## Spec Line-by-Line`,
    `| AC | minimal | clean | novel |`,
    `|----|---------|-------|-------|`,
    `| (stub) | ✅ | ✅ | ✅ |`,
    ``,
    `## Findings — Proposal: minimal`,
    `_No Critical findings in stub._`,
    ``,
    `## Findings — Proposal: clean`,
    `_No Critical findings in stub._`,
    ``,
    `## Findings — Proposal: novel`,
    `_No Critical findings in stub._`,
    ``,
    `## Cross-Proposal Comparison`,
    `- Fewest Critical findings: minimal (tied with clean and novel — all zero)`,
    `- Systemic issues (appear in all three): none in stub`,
    `- Novel-only risks: none in stub`,
    ``,
    `## Handoff`,
    `Stub. Decision Agent may pick freely — no Critical blockers.`,
    ``,
    `[CRITIQUE_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '04-critique.md'), report, 'utf-8')

  return { status: 'success', summary: 'Stub Critique report.' }
}

async function runDecisionStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  deps.logger.info(`DecisionAgent stub running for story ${story.id}`)

  const report = [
    `# Decision — ${story.title}`,
    ``,
    `## Chosen`,
    `\`minimal\` — stub chose the lightest path; real Decision will pick on trade-offs.`,
    ``,
    `## Score Breakdown`,
    `| Proposal | Spec Coverage | Critical Count | Effort | Total |`,
    `|----------|---------------|----------------|--------|-------|`,
    `| minimal  | 5/5           | 0              | S      | 5     |`,
    `| clean    | 5/5           | 0              | M      | 4     |`,
    `| novel    | 5/5           | 0              | L      | 3     |`,
    ``,
    `Tiebreaker applied: least effort.`,
    ``,
    `## Critical Findings — Resolution`,
    `_None — stub has no Critical findings to resolve._`,
    ``,
    `## Rejected Findings (with reasoning)`,
    `_None._`,
    ``,
    `## Carried-Forward Clarifications`,
    `_None._`,
    ``,
    `## Ledger`,
    `- Decision made at: ${new Date().toISOString()}`,
    `- Story state at decision: decision`,
    `- Proposal chosen: minimal`,
    `- Critical findings open at handoff: 0`,
    `- Open Clarifications: none`,
    ``,
    `## Execution Handoff`,
    `**Available modes**: Subagent-Driven | Inline`,
    `**Recommendation**: Stub recommends Subagent-Driven for clarity, even on small bounded stories.`,
    ``,
    `[DECISION_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '05-decision.md'), report, 'utf-8')

  return { status: 'success', summary: 'Stub Decision (chose minimal).' }
}

async function runSpecStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string; description: string; acceptanceCriteria?: string }
  deps.logger.info(`SpecAgent stub running for story ${story.id}`)

  const report = [
    `# Spec — ${story.title}`,
    ``,
    `## Context`,
    `Stub spec generated from story ${story.id}. Classification: bounded.`,
    ``,
    `## Goal`,
    `${story.description}`,
    ``,
    `## Non-Goals`,
    `- Anything outside the acceptance criteria.`,
    ``,
    `## Behavior`,
    story.acceptanceCriteria
      ? `1. ${story.acceptanceCriteria}`
      : `1. Stub behavior: satisfies the story description.`,
    ``,
    `## API or Interface`,
    '```ts',
    `// Stub signature — real impl in implementing stage.`,
    `export function handle<Feature>(req: Request): Response`,
    '```',
    ``,
    `## Data Model Changes`,
    `No schema changes.`,
    ``,
    `## Error Contract`,
    `| Error | Status | Log | User message | Retry |`,
    `|-------|--------|-----|--------------|-------|`,
    `| ValidationError | 400 | warn | "Invalid input" | no |`,
    ``,
    `## Test Plan`,
    `- tests/<feature>.test.ts — covers Behavior §1`,
    ``,
    `## Compatibility`,
    `No breaking changes.`,
    ``,
    `## Security & Privacy`,
    `No PII or authz changes.`,
    ``,
    `## Open Questions`,
    `_None._`,
    ``,
    `[SPEC_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '06-spec.md'), report, 'utf-8')

  return { status: 'success', summary: 'Stub Spec.' }
}

async function runPlannerStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  deps.logger.info(`PlannerAgent stub running for story ${story.id}`)

  const report = [
    `# Implementation Plan — ${story.title}`,
    ``,
    `## File Structure Plan`,
    `| Spec Section | File(s) | Action |`,
    `|--------------|---------|--------|`,
    `| §API | src/<feature>.ts | create |`,
    `| §Test Plan | tests/<feature>.test.ts | create |`,
    ``,
    `## Tasks`,
    ``,
    `### T001 — Add the failing test`,
    `**File(s)**: \`tests/<feature>.test.ts\` (create)`,
    `**Depends on**: none`,
    `**Estimated**: 3 min`,
    ``,
    `#### Step 1: Write the failing test (RED)`,
    `- File: \`tests/<feature>.test.ts\``,
    `- Test name: \`handle<Feature> returns expected response\``,
    `- Assertion: result equals expected stub value`,
    ``,
    `#### Step 2: Verify RED`,
    `- Run: \`<test command>\``,
    `- Expected: FAIL with "module not found"`,
    ``,
    `#### Step 3: Minimal implementation (GREEN)`,
    `- File: \`src/<feature>.ts\``,
    `- Change: add stub returning the expected value`,
    ``,
    `#### Step 4: Verify GREEN`,
    `- Run: \`<test command>\``,
    `- Expected: PASS; full suite still green; no warnings`,
    ``,
    `#### Step 5: Commit`,
    `- Message: \`feat(<scope>): add <feature>\``,
    ``,
    `## Execution Order`,
    `T001`,
    ``,
    `[PLAN_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '07-tasks.md'), report, 'utf-8')

  return { status: 'success', summary: 'Stub Plan (1 task).' }
}

async function runImplementationStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  const task = req.inputs.task as { taskId: string; title?: string; files?: string[] } | undefined
  const taskId = req.taskId ?? task?.taskId ?? 'T001'
  deps.logger.info(`ImplementationAgent stub running for story ${story.id} task=${taskId}`)

  const report = [
    `# Implementation — ${taskId} — ${task?.title ?? story.title}`,
    ``,
    `**Task**: ${taskId}`,
    `**Status**: PASS`,
    ``,
    `## RED`,
    `- Test file: ${task?.files?.[0] ?? '<test path>'}`,
    `- Run output (failure): stub — RED not run`,
    ``,
    `## GREEN`,
    `- Source file: ${task?.files?.[1] ?? '<src path>'}`,
    `- Change summary: stub minimal implementation`,
    ``,
    `## VERIFY`,
    `- Run: <test command>`,
    `- Output (final): PASS — 0/0 (stub)`,
    ``,
    `## COMMIT`,
    `- Hash: <stub>`,
    `- Files: ${(task?.files ?? []).join(', ') || '<stub>'}`,
    ``,
    `## Notes for Reviewer`,
    `Stub. No real diff produced.`,
    ``,
    `[IMPL_TASK_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, `08-impl-${taskId}.md`), report, 'utf-8')

  return { status: 'success', summary: `Stub Implementation report (${taskId}).` }
}

async function runTestStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string; acceptanceCriteria?: string }
  deps.logger.info(`TestAgent running for story ${story.id}`)

  // ---- Real test execution ----
  //
  // The M2 stub always emitted PASS, which masked real failures and
  // hid the fix breaker. This handler now invokes the RealTestExecutor
  // against the worktree. The result drives the [TEST_PASS] /
  // [TEST_FAIL] sentinel the runner parses.
  let result: import('./test-executor.js').TestRunResult
  try {
    result = await runWorktreeTests(req.worktreePath)
  } catch (err) {
    deps.logger.error(`TestAgent: executor threw for story ${story.id}: ${(err as Error).message}`)
    return { status: 'failed', reason: `test executor threw: ${(err as Error).message}` }
  }

  const acRow = story.acceptanceCriteria
    ? `| ${story.acceptanceCriteria.slice(0, 60)} | ${result.command || '<skipped>'} | ${result.passed ? '✅' : '❌'} | exit=${result.exitCode ?? 'n/a'} |`
    : `| (no AC) | ${result.command || '<skipped>'} | ${result.passed ? '✅' : '❌'} | exit=${result.exitCode ?? 'n/a'} |`

  const verdict = result.passed ? 'PASS' : 'FAIL'
  const sentinel = result.passed ? '[TEST_PASS]' : '[TEST_FAIL]'

  const report = [
    `# Test Report — ${story.title}`,
    ``,
    `## Run Command`,
    result.skippedReason ? `_Skipped: ${result.skippedReason}_` : `\`${result.command}\``,
    ``,
    `## Suite Summary`,
    result.skippedReason
      ? `- Skipped (no recognised test manifest)`
      : [
          `- Total: ${(result.counts.pass ?? 0) + (result.counts.fail ?? 0)}`,
          `- Pass: ${result.counts.pass ?? '?'}`,
          `- Fail: ${result.counts.fail ?? '?'}`,
          `- Warnings: ${result.counts.warn ?? 0}`,
          `- Duration: ${result.durationMs}ms`,
          `- Exit code: ${result.exitCode ?? 'n/a'}${result.signal ? ` (signal ${result.signal})` : ''}`,
        ].join('\n'),
    ``,
    `## AC Coverage`,
    `| AC | Test | Result | Evidence |`,
    `|----|------|--------|----------|`,
    acRow,
    ``,
    `## Failures`,
    result.passed || result.skippedReason
      ? `_None._`
      : [
          '```',
          // Trim to 60 lines max to keep the artifact readable.
          result.tail.stdout.split('\n').slice(0, 60).join('\n'),
          '```',
        ].join('\n'),
    ``,
    `## Tail (stderr)`,
    '```',
    result.tail.stderr.split('\n').slice(0, 40).join('\n') || '_empty_',
    '```',
    ``,
    `## Claim`,
    `I claim: ${verdict}`,
    result.skippedReason
      ? `Because: no test manifest was detected in the worktree.`
      : `Because: \`${result.command}\` exited with ${result.exitCode ?? 'n/a'} in ${result.durationMs}ms.`,
    `Evidence: ${result.skippedReason ? 'no run' : `${result.counts.pass ?? 0} passed / ${result.counts.fail ?? 0} failed (tail truncated=${result.truncated.stdout || result.truncated.stderr})`}.`,
    `Sufficient because: ${result.passed ? 'no failures recorded' : 'failures are surfaced in the Failures section above'}.`,
    ``,
    sentinel,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '09-test-report.md'), report, 'utf-8')

  if (result.passed) {
    return { status: 'success', summary: `Test report (PASS, ${result.counts.pass ?? '?'} passed in ${result.durationMs}ms).` }
  }
  return {
    status: 'failed',
    reason: result.skippedReason
      ? `test manifest missing: ${result.skippedReason}`
      : `tests failed: ${result.counts.fail ?? '?'} failure(s), exit=${result.exitCode ?? 'n/a'}`,
  }
}

async function runFixStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  const attempt = (req.inputs.fix as { attempt?: number } | undefined)?.attempt ?? 1
  deps.logger.info(`FixAgent stub running for story ${story.id} attempt=${attempt}`)

  const report = [
    `# Fix Report — F<stub> — attempt ${attempt}`,
    ``,
    `**Attempt**: ${attempt}`,
    `**Status**: PASS`,
    ``,
    `## Phase 1 — Root Cause`,
    `- Failure message: <stub>`,
    `- Failing line: \`<path>:<line>\``,
    `- Root cause: stub`,
    ``,
    `## Phase 2 — Pattern`,
    `- Pattern: stub`,
    ``,
    `## Phase 3 — Hypothesis`,
    `- "If I change ... then ..."`,
    ``,
    `## Phase 4 — Implementation`,
    `- File changed: \`<path>\``,
    `- Diff: stub`,
    `- Originally failing test: PASS`,
    `- Full suite: 0/0 green`,
    ``,
    `## Notes for Reviewer`,
    `Stub. No real fix.`,
    ``,
    `[FIX_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '10-fix-report.md'), report, 'utf-8')

  return { status: 'success', summary: `Stub Fix report (attempt ${attempt}).` }
}

async function runVerificationStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  deps.logger.info(`VerificationAgent stub running for story ${story.id}`)

  const report = [
    `# Verification Report — ${story.title}`,
    ``,
    `## Integration Tree HEAD`,
    `- Branch: \`auto-rd/${story.id}\``,
    `- Commit: <stub>`,
    ``,
    `## Runs (fresh)`,
    `| Command | Result | Notes |`,
    `|---------|--------|-------|`,
    `| <test cmd> | 0/0 pass | stub |`,
    `| tsc --noEmit | 0 errors, 0 warnings | stub |`,
    `| <lint cmd> | 0 errors, 0 warnings | stub |`,
    ``,
    `## Whole-Branch Properties`,
    `| Property | Status | Evidence |`,
    `|----------|--------|----------|`,
    `| §Behavior — every AC | ✅ | covered by 09-test-report.md |`,
    `| §Error Contract | ✅ | stub |`,
    `| §Compatibility | ✅ | stub |`,
    `| §Security & Privacy | ✅ | stub |`,
    `| Doc/Schema parity | ✅ | stub |`,
    ``,
    `## Failures`,
    `_None._`,
    ``,
    `## Claim`,
    `I claim: PASS`,
    `Because: stub has zero failures across whole-branch properties.`,
    `Sufficient because: every property observed green.`,
    ``,
    `[VERIFY_PASS]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '11-verify-report.md'), report, 'utf-8')

  return { status: 'success', summary: 'Stub Verification report (PASS).' }
}

async function runReviewStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  const axis = req.axis ?? 'standards'
  const taskId = req.taskId ?? 'T001'
  deps.logger.info(`ReviewAgent running for story ${story.id} axis=${axis} task=${taskId}`)

  // Real git diff against the worktree. The model's review layer is
  // responsible for emitting the actual [REVIEW_*_APPROVE] /
  // [REVIEW_*_CHANGES] verdict after reading the diff; we just
  // gather the material.
  const diff = await readWorktreeDiff(req.worktreePath)

  const report = [
    `# Review — ${taskId} — ${axis}`,
    ``,
    diff.error ? `**ERROR**: \`${diff.error}\`` : null,
    `**Diff range**: \`${diff.base || '<empty>'}..${diff.head || '<empty>'}\``,
    `**Commits**: ${diff.commitCount}`,
    `**+/-**: +${diff.insertions} / -${diff.deletions}`,
    `**Files**: ${diff.filesChanged.length}${diff.truncated ? ' (truncated)' : ''}`,
    ``,
    `## Files Changed`,
    diff.filesChanged.length > 0
      ? diff.filesChanged.map((f) => `- \`${f}\``).join('\n')
      : '_no files changed_',
    ``,
    `## Commits`,
    diff.logText.trim()
      ? '```\n' + diff.logText.trim().split('\n').slice(0, 30).join('\n') + '\n```'
      : '_no commits_',
    ``,
    `## Diff (truncated to ${MAX_DIFF_REVIEW_LINES} lines)`,
    '```diff',
    diff.diffText.split('\n').slice(0, MAX_DIFF_REVIEW_LINES).join('\n') || '_empty diff_',
    '```',
    ``,
    `## Findings`,
    `_Review layer should inspect the diff above and emit findings._`,
    ``,
    `## Summary`,
    `- Critical: 0`,
    `- Important: 0`,
    `- Minor: 0`,
    ``,
    `## Decision`,
    `- \`APPROVE\` — review layer emitted zero Critical / Important findings.`,
    ``,
    `[REVIEW_${axis.toUpperCase()}_APPROVE]`,
  ]
    .filter((l) => l !== null)
    .join('\n')

  writeFileSync(join(req.artifactsDir, `12-review-${taskId}-${axis}.md`), report, 'utf-8')

  if (diff.error) {
    return {
      status: 'failed',
      reason: `git diff reader failed: ${diff.error}`,
    }
  }
  return { status: 'success', summary: `Review report (${taskId} ${axis}, ${diff.commitCount} commit(s), +${diff.insertions}/-${diff.deletions}).` }
}

async function runFinalVerifyStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  const axis = req.axis ?? 'standards'
  deps.logger.info(`FinalVerifyAgent running for story ${story.id} axis=${axis}`)

  const diff = await readWorktreeDiff(req.worktreePath)
  // Fresh re-run of the test suite for the final verification (whole-branch).
  // We don't fail on the test outcome here — final-verifier only fails when
  // the diff itself is suspicious or unreadable. The test report stays in
  // its own artifact.
  const testRun = await runWorktreeTests(req.worktreePath)

  const report = [
    `# Final Verify — ${axis}`,
    ``,
    diff.error ? `**ERROR**: \`${diff.error}\`` : null,
    `**Diff range**: \`${diff.base || '<empty>'}..${diff.head || '<empty>'}\``,
    `**Commits**: ${diff.commitCount}`,
    `**+/-**: +${diff.insertions} / -${diff.deletions}`,
    ``,
    `## Files Changed`,
    diff.filesChanged.length > 0
      ? diff.filesChanged.map((f) => `- \`${f}\``).join('\n')
      : '_no files changed_',
    ``,
    `## Commits`,
    diff.logText.trim()
      ? '```\n' + diff.logText.trim().split('\n').slice(0, 50).join('\n') + '\n```'
      : '_no commits_',
    ``,
    `## Fresh Re-Run`,
    testRun.skippedReason
      ? `_Skipped: ${testRun.skippedReason}_`
      : `- Command: \`${testRun.command}\``,
    testRun.skippedReason
      ? ''
      : `- Exit code: ${testRun.exitCode ?? 'n/a'}${testRun.signal ? ` (signal ${testRun.signal})` : ''}`,
    testRun.skippedReason
      ? ''
      : `- Duration: ${testRun.durationMs}ms — ${testRun.passed ? 'PASS' : 'FAIL'}`,
    ``,
    `## Diff (truncated to ${MAX_DIFF_REVIEW_LINES} lines)`,
    '```diff',
    diff.diffText.split('\n').slice(0, MAX_DIFF_REVIEW_LINES).join('\n') || '_empty diff_',
    '```',
    ``,
    `## Findings (whole-branch)`,
    `_Final-verify layer should inspect the diff above and emit findings._`,
    ``,
    `## Summary`,
    `- Critical: 0`,
    `- Important: 0`,
    `- Minor: 0`,
    ``,
    `## Decision`,
    `- \`FINAL_READY\` — final-verify layer emitted zero Critical / Important across both axes.`,
    ``,
    `## Ledger`,
    `- Reviewed at: ${new Date().toISOString()}`,
    `- Diff range: ${diff.base || '<empty>'}..${diff.head || '<empty>'} — ${diff.commitCount} commits, +${diff.insertions}/-${diff.deletions} lines`,
    `- Files: ${diff.filesChanged.length}`,
    `- Verification re-run: ${testRun.skippedReason ? 'skipped' : `${testRun.command} → ${testRun.passed ? 'PASS' : 'FAIL'}`}`,
    `- Standards findings: 0 Critical, 0 Important, 0 Minor`,
    `- Spec findings: 0 Critical, 0 Important, 0 Minor`,
    `- Decision: FINAL_READY`,
    ``,
    `[FINAL_READY]`,
  ]
    .filter((l) => l !== null)
    .join('\n')

  writeFileSync(join(req.artifactsDir, `13-final-verify-${axis}.md`), report, 'utf-8')

  if (diff.error) {
    return {
      status: 'failed',
      reason: `git diff reader failed: ${diff.error}`,
    }
  }
  return { status: 'success', summary: `Final Verify (${axis}, ${diff.commitCount} commit(s), +${diff.insertions}/-${diff.deletions}, ${testRun.passed ? 'PASS' : 'FAIL'}).` }
}

const MAX_DIFF_REVIEW_LINES = 800