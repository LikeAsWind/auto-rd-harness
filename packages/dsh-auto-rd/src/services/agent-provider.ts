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
import type { Config } from '../config'
import type { Logger } from '../utils/logger'
import { ContextAgent } from '../agents/context'
import { ClarificationAgent } from '../agents/clarification'
import { BrainstormAgent, type BrainstormVariation } from '../agents/brainstorm'
import { CriticAgent } from '../agents/critic'
import { DecisionAgent } from '../agents/decision'
import { SpecAgent } from '../agents/spec'
import { PlannerAgent } from '../agents/planner'
import type { AgentSpec } from '../agents/base'

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
    // Brainstorm is special: same agentName, three variations. Resolve to the
    // matching AgentSpec instance before falling through to the registry.
    let spec: AgentSpec
    let handler: AgentHandler
    if (req.agentName === 'brainstorm') {
      const variationSpec = this.brainstormSpecFor(req)
      if (!variationSpec || !this.brainstormHandler) {
        return { status: 'failed', reason: `agentNotImplemented:brainstorm:${req.variation}` }
      }
      spec = variationSpec
      handler = this.brainstormHandler
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
      `# Persona (${spec.name}${req.variation ? ` / ${req.variation}` : ''})\n\n${spec.persona}`,
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
        this.deps.logger.info(`Subagent launched for ${req.agentName}${req.variation ? ` (${req.variation})` : ''}: ${req.label}`)
      } catch (err) {
        this.deps.logger.error(
          `Subagent start failed for ${req.agentName}: ${(err as Error).message}; falling back to stub`,
        )
      }
    }

    return handler(req, this.deps)
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