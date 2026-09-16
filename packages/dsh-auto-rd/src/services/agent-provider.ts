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
import type { AgentSpec } from '../agents/base'

export interface AgentDispatchRequest {
  agentName: string
  label: string
  worktreePath: string
  artifactsDir: string
  inputs: Record<string, unknown>
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
    const entry = this.registry.get(req.agentName)
    if (!entry) {
      return { status: 'failed', reason: `agentNotImplemented:${req.agentName}` }
    }

    // Persist the persona into a known location so a real SubAgentProvider
    // can read it (or so an operator can audit what was sent).
    writeFileSync(
      join(req.artifactsDir, 'agent-persona.md'),
      `# Persona (${entry.spec.name})\n\n${entry.spec.persona}`,
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
            persona: entry.spec.persona,
            toolFilter: entry.spec.toolFilter,
            worktreePath: req.worktreePath,
            artifactsDir: req.artifactsDir,
            inputs: req.inputs,
          },
        })
        this.deps.logger.info(`Subagent launched for ${req.agentName}: ${req.label}`)
      } catch (err) {
        this.deps.logger.error(
          `Subagent start failed for ${req.agentName}: ${(err as Error).message}; falling back to stub`,
        )
      }
    }

    return entry.handler(req, this.deps)
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
  }
}

// ---- Stub Handlers (M1) ----

/**
 * M1 stub for the ContextAgent.
 *
 * Real subagent invocation will be wired up when the AgentProvider integrates
 * with DSH's agents service. For now, we write a minimal report that contains
 * the same shape the real agent would produce, so StoryRunner can move the
 * story from `context` -> `completed`.
 */
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
    `- Result: success (M1 stub — actual detection wired in M2)`,
    ``,
    `## Baseline Tests`,
    `- Command: <detected test command>`,
    `- Result: N/N passing (M1 stub)`,
    ``,
    `## Codebase Map`,
    `- (M1 stub: real exploration happens in M2 once the SubAgent provider is wired up)`,
    ``,
    `## Handoff`,
    `M1 stub. The next stage is \`clarification\` (Agent not implemented in M1).`,
    ``,
    `[CONTEXT_COMPLETE]`,
  ].join('\n')

  writeFileSync(join(req.artifactsDir, '01-context.md'), report, 'utf-8')

  return {
    status: 'success',
    summary: 'M1 stub Context report — real agent wiring lands in M2.',
  }
}