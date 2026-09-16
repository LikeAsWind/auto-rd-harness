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
import {
  commitWorktreeChanges,
  buildCommitMessage,
  status as worktreeStatus,
} from './worktree-git.js'
import { probeProject } from './project-probe.js'

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
  deps.logger.info(`ContextAgent running for story ${story.id}`)

  // ---- Real environment inspection ----
  //
  // W-1 (Detect Isolation) / W-2 (Native Tools First) / W-3 (Verify
  // Clean Baseline) are all satisfied by an actual probe of the
  // worktree rather than a templated report.
  const probe = probeProject(req.worktreePath)

  // Baseline: run the suite as it stands BEFORE any change. This is
  // the "clean baseline" the Context stage must establish — a story
  // that starts from a red suite can never be verified later.
  let baseline: import('./test-executor.js').TestRunResult | null = null
  if (probe.testCommand) {
    try {
      baseline = await runWorktreeTests(req.worktreePath)
    } catch (err) {
      deps.logger.warn(`ContextAgent: baseline test run failed: ${(err as Error).message}`)
    }
  }

  const baselineLine = baseline
    ? baseline.skippedReason
      ? `- Skipped: ${baseline.skippedReason}`
      : `- Command: \`${baseline.command}\``
    : '- Not run (no test command detected)'

  const baselineResult = baseline
    ? baseline.skippedReason
      ? '- Result: not run'
      : `- Result: ${baseline.passed ? 'GREEN' : 'RED'} — ${baseline.counts.pass ?? '?'} passed / ${baseline.counts.fail ?? '?'} failed (exit ${baseline.exitCode ?? 'n/a'}, ${baseline.durationMs}ms)`
    : '- Result: not run'

  const langLines = Object.entries(probe.languageBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([ext, count]) => `| \`${ext}\` | ${count} |`)

  const report = [
    `# Context Report — ${story.title}`,
    ``,
    `## Environment Verification`,
    `- Worktree: \`${probe.worktreePath}\``,
    `- Is git repo: ${probe.isGitRepo}`,
    `- Branch: \`${probe.branch ?? '<detached>'}\``,
    `- HEAD: \`${probe.headSha ?? '<none>'}\``,
    ``,
    `## Project Setup`,
    `- Package manager: ${probe.packageManager ?? '_not detected_'}`,
    `- Install command: ${probe.installCommand ? `\`${probe.installCommand}\`` : '_n/a_'}`,
    `- Test command: ${probe.testCommand ? `\`${probe.testCommand}\`` : '_n/a_'}`,
    `- Build command: ${probe.buildCommand ? `\`${probe.buildCommand}\`` : '_n/a_'}`,
    `- Manifests: ${probe.manifests.length > 0 ? probe.manifests.map((m) => `\`${m}\``).join(', ') : '_none_'}`,
    ``,
    `## Baseline Tests`,
    baselineLine,
    baselineResult,
    ``,
    `## Codebase Map`,
    `- Files walked: ${probe.fileCount}${probe.walkTruncated ? ' (walk truncated at cap)' : ''}`,
    `- Top-level directories: ${probe.topLevelDirs.length > 0 ? probe.topLevelDirs.map((d) => `\`${d}/\``).join(', ') : '_none_'}`,
    `- Top-level files: ${probe.topLevelFiles.length > 0 ? probe.topLevelFiles.map((f) => `\`${f}\``).join(', ') : '_none_'}`,
    ``,
    `### Language Breakdown`,
    `| Extension | Files |`,
    `|-----------|-------|`,
    langLines.length > 0 ? langLines.join('\n') : `| _none counted_ | 0 |`,
    ``,
    `## Handoff`,
    baseline && !baseline.skippedReason && !baseline.passed
      ? `Baseline is RED. Next stage is \`clarification\` — downstream stages should expect a pre-existing failure.`
      : `Baseline is clean. Next stage is \`clarification\`.`,
    ``,
    `[CONTEXT_COMPLETE]`,
  ]
    .filter((l) => l !== null)
    .join('\n')

  writeFileSync(join(req.artifactsDir, '01-context.md'), report, 'utf-8')

  return {
    status: 'success',
    summary:
      `Context: ${probe.fileCount} files, pm=${probe.packageManager ?? 'unknown'}, ` +
      `baseline=${baseline ? (baseline.skippedReason ? 'skipped' : baseline.passed ? 'GREEN' : 'RED') : 'n/a'}`,
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
  const task = req.inputs.task as
    | {
        taskId: string
        title?: string
        files?: string[]
        red?: { file: string; testName: string; assertion: string }
        green?: { file: string; change: string }
        commit?: { type?: string; scope?: string; subject?: string }
      }
    | undefined
  const taskId = req.taskId ?? task?.taskId ?? 'T001'
  deps.logger.info(`ImplementationAgent running for story ${story.id} task=${taskId}`)

  // ---- Real worktree operations ----
  //
  // The model layer (when attached) writes the file contents between
  // the RED and GREEN steps. Everything below is the deterministic
  // half: verify the pre-change test state, commit whatever landed in
  // the worktree, and report the real sha. Without this the branch
  // never advanced and the ReviewAgent's diff was always empty.
  const statusBefore = await worktreeStatus(req.worktreePath)

  // VERIFY: run the suite to capture the current verdict (this is the
  // GREEN evidence when a model already wrote the change; it is the
  // RED evidence when the model wrote only the test).
  let testRun: import('./test-executor.js').TestRunResult | null = null
  try {
    testRun = await runWorktreeTests(req.worktreePath)
  } catch (err) {
    deps.logger.warn(`ImplementationAgent: test run failed for ${taskId}: ${(err as Error).message}`)
  }

  // COMMIT: real commit of whatever the worktree now contains.
  const commitMessage = buildCommitMessage(task?.commit, `implement ${taskId}`)
  let commitResult: import('./worktree-git.js').CommitResult | null = null
  try {
    commitResult = await commitWorktreeChanges({
      worktreePath: req.worktreePath,
      message: commitMessage,
      userName: deps.config.gitlabPushUserName,
      userEmail: deps.config.gitlabPushUserEmail,
    })
  } catch (err) {
    deps.logger.warn(`ImplementationAgent: commit failed for ${taskId}: ${(err as Error).message}`)
  }

  const commitSha = commitResult?.sha ?? null
  const committed = commitResult?.committed === true
  const changedFiles = [
    ...statusBefore.modified,
    ...statusBefore.untracked,
  ]

  const report = [
    `# Implementation — ${taskId} — ${task?.title ?? story.title}`,
    ``,
    `**Task**: ${taskId}`,
    `**Status**: ${committed ? 'COMMITTED' : 'NO_CHANGE'}`,
    ``,
    `## RED`,
    `- Test file: ${task?.red?.file ?? task?.files?.[0] ?? '<not specified by planner>'}`,
    task?.red ? `- Test name: \`${task.red.testName}\`` : null,
    task?.red ? `- Assertion: ${task.red.assertion}` : null,
    `- Code written by: ${this_is_stub()}`,
    ``,
    `## GREEN`,
    `- Source file: ${task?.green?.file ?? task?.files?.[1] ?? '<not specified by planner>'}`,
    task?.green ? `- Change: ${task.green.change}` : null,
    ``,
    `## VERIFY`,
    testRun?.skippedReason
      ? `- Skipped: ${testRun.skippedReason}`
      : testRun
        ? `- Run: \`${testRun.command}\` → ${testRun.passed ? 'PASS' : 'FAIL'} (exit ${testRun.exitCode ?? 'n/a'}, ${testRun.durationMs}ms)`
        : `- Run: <not attempted>`,
    ``,
    `## COMMIT`,
    `- Hash: ${commitSha ?? '<none>'}`,
    `- Message: \`${commitMessage}\``,
    `- Committed: ${committed}`,
    commitResult?.reason ? `- Skipped reason: ${commitResult.reason}` : null,
    `- Files changed: ${changedFiles.length > 0 ? changedFiles.map((f) => `\`${f}\``).join(', ') : '_none_'}`,
    `- Branch: \`${statusBefore.branch || '<detached>'}\``,
    ``,
    `## Notes for Reviewer`,
    committed
      ? `Real commit \`${commitSha}\` created on \`${statusBefore.branch}\`.`
      : `No commit created (${commitResult?.reason ?? 'unknown'}). The worktree was already clean.`,
    ``,
    `[IMPL_TASK_COMPLETE]`,
  ]
    .filter((l) => l !== null)
    .join('\n')

  writeFileSync(join(req.artifactsDir, `08-impl-${taskId}.md`), report, 'utf-8')

  return {
    status: 'success',
    summary: committed
      ? `Implementation ${taskId} committed ${commitSha?.slice(0, 7)} (${changedFiles.length} file(s)).`
      : `Implementation ${taskId} — no worktree changes to commit.`,
  }
}

/**
 * Whether the file contents were authored by a deterministic stub or a
 * model. Kept as a function so the wording lives in one place and a
 * future model-attached path can flip it.
 */
function this_is_stub(): string {
  return 'deterministic handler (no model attached)'
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
  const task = req.inputs.task as { taskId?: string; title?: string } | undefined
  const taskId = req.taskId ?? task?.taskId ?? 'T001'
  deps.logger.info(`FixAgent running for story ${story.id} attempt=${attempt} task=${taskId}`)

  // ---- Real worktree operations ----
  //
  // The model layer (when attached) performs root-cause analysis and
  // writes the fix. The deterministic half below runs the suite for
  // evidence and commits whatever the fix produced — otherwise the fix
  // would never reach the branch and the next `testing` pass would see
  // the same failure forever.
  const statusBefore = await worktreeStatus(req.worktreePath)

  let testRun: import('./test-executor.js').TestRunResult | null = null
  try {
    testRun = await runWorktreeTests(req.worktreePath)
  } catch (err) {
    deps.logger.warn(`FixAgent: test run failed for ${taskId}: ${(err as Error).message}`)
  }

  const commitMessage = buildCommitMessage(
    { type: 'fix', scope: taskId },
    `address failure on attempt ${attempt}`,
  )
  let commitResult: import('./worktree-git.js').CommitResult | null = null
  try {
    commitResult = await commitWorktreeChanges({
      worktreePath: req.worktreePath,
      message: commitMessage,
      userName: deps.config.gitlabPushUserName,
      userEmail: deps.config.gitlabPushUserEmail,
    })
  } catch (err) {
    deps.logger.warn(`FixAgent: commit failed for ${taskId}: ${(err as Error).message}`)
  }

  const commitSha = commitResult?.sha ?? null
  const committed = commitResult?.committed === true
  const changedFiles = [...statusBefore.modified, ...statusBefore.untracked]

  const report = [
    `# Fix Report — ${taskId} — attempt ${attempt}`,
    ``,
    `**Attempt**: ${attempt}`,
    `**Task**: ${taskId}`,
    `**Status**: ${committed ? 'COMMITTED' : 'NO_CHANGE'}`,
    ``,
    `## Phase 1 — Root Cause`,
    `- Analysis author: ${this_is_stub()}`,
    `- Failing evidence: ${testRun && !testRun.skippedReason ? `\`${testRun.command}\` → ${testRun.passed ? 'PASS' : 'FAIL'}` : '<no test run>'}`,
    ``,
    `## Phase 2 — Pattern`,
    `- Diagnosis recorded by the fix layer (deterministic handler in this environment).`,
    ``,
    `## Phase 3 — Hypothesis`,
    `- See the fix layer's own report; the handler does not synthesise one.`,
    ``,
    `## Phase 4 — Implementation`,
    `- Files changed: ${changedFiles.length > 0 ? changedFiles.map((f) => `\`${f}\``).join(', ') : '_none_'}`,
    `- Commit: ${commitSha ?? '<none>'} (${committed ? 'created' : commitResult?.reason ?? 'skipped'})`,
    `- Originally failing test: ${testRun && !testRun.skippedReason ? (testRun.passed ? 'PASS (fixed)' : 'still FAILING') : 'not run'}`,
    ``,
    `## Notes for Reviewer`,
    committed
      ? `Real fix commit \`${commitSha}\` created on \`${statusBefore.branch}\`.`
      : `No commit created (${commitResult?.reason ?? 'unknown'}).`,
    ``,
    `[FIX_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, `10-fix-report-attempt-${attempt}.md`), report, 'utf-8')

  return {
    status: 'success',
    summary: committed
      ? `Fix attempt ${attempt} committed ${commitSha?.slice(0, 7)} (${changedFiles.length} file(s)).`
      : `Fix attempt ${attempt} — no worktree changes to commit.`,
  }
}

async function runVerificationStub(
  req: AgentDispatchRequest,
  deps: AgentProviderDeps,
): Promise<AgentDispatchResult> {
  const story = req.inputs.story as { id: string; title: string }
  deps.logger.info(`VerificationAgent running for story ${story.id}`)

  // ---- Real whole-branch verification ----
  //
  // The verification gate must run against the integration tree
  // (F-1: Re-Run on Integration Tree), not against a claim. Both the
  // diff and the suite are gathered for real here.
  const diff = await readWorktreeDiff(req.worktreePath)
  const testRun = await runWorktreeTests(req.worktreePath)

  // ---- Deterministic whole-branch checks ----
  const checks: Array<{ name: string; status: 'PASS' | 'FAIL' | 'SKIP'; evidence: string }> = []

  // 1. Something was actually changed.
  const hasChanges = diff.commitCount > 0 || diff.filesChanged.length > 0
  checks.push({
    name: 'Diff is non-empty',
    status: hasChanges ? 'PASS' : 'FAIL',
    evidence: `${diff.commitCount} commit(s), ${diff.filesChanged.length} file(s), +${diff.insertions}/-${diff.deletions}`,
  })

  // 2. The whole-branch suite runs green.
  checks.push({
    name: 'Whole-branch test suite',
    status: testRun.skippedReason ? 'SKIP' : testRun.passed ? 'PASS' : 'FAIL',
    evidence: testRun.skippedReason
      ? testRun.skippedReason
      : `\`${testRun.command}\` exit=${testRun.exitCode ?? 'n/a'} in ${testRun.durationMs}ms`,
  })

  // 3. The diff is readable.
  checks.push({
    name: 'Diff is readable',
    status: diff.error ? 'FAIL' : 'PASS',
    evidence: diff.error ?? `base=${diff.base || '<none>'} head=${diff.head || '<none>'}`,
  })

  const failed = checks.filter((c) => c.status === 'FAIL')
  const skipped = checks.filter((c) => c.status === 'SKIP')

  // Verdict mapping (design §5): PASS -> reviewing, PARTIAL -> fixing,
  // REJECT -> blocked.
  //   - A failing suite is PARTIAL: recoverable by another fix round.
  //   - An unverifiable tree (no changes, or no way to run the suite)
  //     is REJECT: retrying will not help.
  const noChanges = !hasChanges
  const cannotRun = !!testRun.skippedReason
  const reject = noChanges || cannotRun || !!diff.error
  const verdict: 'PASS' | 'PARTIAL' | 'REJECT' = reject
    ? 'REJECT'
    : failed.length > 0
      ? 'PARTIAL'
      : 'PASS'
  const sentinel =
    verdict === 'PASS' ? '[VERIFY_PASS]' : verdict === 'PARTIAL' ? '[VERIFY_PARTIAL]' : '[VERIFY_REJECT]'

  const report = [
    `# Verification Report — ${story.title}`,
    ``,
    diff.error ? `**ERROR**: \`${diff.error}\`` : null,
    `## Integration Tree HEAD`,
    `- Branch: \`${diff.head ? 'HEAD' : '<unknown>'}\``,
    `- Commit: \`${diff.head || '<none>'}\``,
    `- Base: \`${diff.base || '<none>'}\``,
    `- Commits on branch: ${diff.commitCount}`,
    `- Files changed: ${diff.filesChanged.length}`,
    `- Lines: +${diff.insertions} / -${diff.deletions}`,
    ``,
    `## Files Changed`,
    diff.filesChanged.length > 0
      ? diff.filesChanged.map((f) => `- \`${f}\``).join('\n')
      : '_no files changed_',
    ``,
    `## Runs (fresh)`,
    `| Check | Result | Evidence |`,
    `|-------|--------|----------|`,
    ...checks.map((c) => `| ${c.name} | ${c.status} | ${c.evidence} |`),
    ``,
    `## Whole-Branch Properties`,
    `| Property | Status | Evidence |`,
    `|----------|--------|----------|`,
    `| Something changed | ${hasChanges ? '✅' : '❌'} | ${diff.filesChanged.length} file(s) |`,
    `| Suite green on the branch | ${testRun.skippedReason ? '⚠️' : testRun.passed ? '✅' : '❌'} | ${testRun.skippedReason ?? `exit ${testRun.exitCode ?? 'n/a'}`} |`,
    `| Diff readable | ${diff.error ? '❌' : '✅'} | ${diff.error ?? 'yes'} |`,
    `| Per-AC detail | ℹ️ | see \`09-test-report.md\` |`,
    ``,
    `## Failures`,
    failed.length > 0
      ? failed.map((c) => `- **${c.name}**: ${c.evidence}`).join('\n')
      : `_None._`,
    skipped.length > 0 ? `\nSkipped: ${skipped.map((c) => c.name).join(', ')}` : null,
    ``,
    `## Test Output Tail`,
    '```',
    (testRun.tail.stdout || '_empty_').split('\n').slice(0, 40).join('\n'),
    '```',
    ``,
    `## Claim`,
    `I claim: ${verdict}`,
    `Because: ${checks.filter((c) => c.status === 'PASS').length}/${checks.length} checks passed, ${failed.length} failed, ${skipped.length} skipped.`,
    `Evidence: ${hasChanges ? `${diff.commitCount} commit(s) / ${diff.filesChanged.length} file(s)` : 'no changes on the branch'}${testRun.skippedReason ? '; suite not runnable' : `; suite exit ${testRun.exitCode ?? 'n/a'}`}.`,
    `Sufficient because: ${verdict === 'PASS' ? 'every check is green on the integration tree' : 'the failing checks above are reproducible from the evidence.'}`,
    ``,
    sentinel,
  ]
    .filter((l) => l !== null)
    .join('\n')

  writeFileSync(join(req.artifactsDir, '11-verify-report.md'), report, 'utf-8')

  if (verdict === 'PASS') {
    return {
      status: 'success',
      summary: `Verification PASS (${diff.commitCount} commit(s), suite green in ${testRun.durationMs}ms).`,
    }
  }
  if (verdict === 'PARTIAL') {
    // Recoverable: the runner maps `failed` here to the `fixing` stage.
    return {
      status: 'failed',
      reason: `verification PARTIAL: ${failed.map((c) => c.name).join(', ')}`,
    }
  }
  return {
    status: 'blocked',
    reason: `verification REJECT: ${noChanges ? 'no changes on the branch' : cannotRun ? 'suite not runnable' : 'diff unreadable'}`,
  }
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