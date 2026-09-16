/**
 * AgentProvider — dispatches SubAgents for auto-rd's 13 specialized roles.
 *
 * This is the bridge between StoryRunner (state machine) and DSH's agent
 * factory. Each persona in src/agents/ registers here.
 *
 * M1: only ContextAgent is wired in. The other 12 throw `agentNotImplemented`
 * so the orchestrator can short-circuit cleanly.
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

export class AgentProvider {
  private readonly registry = new Map<string, RegistryEntry>()

  constructor(private readonly ctx: Context, private readonly deps: AgentProviderDeps) {
    this.registerBuiltins()
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
    // could read it (the actual subagent invocation lives outside M1; we
    // simulate the round-trip here by writing a stub report).
    writeFileSync(
      join(req.artifactsDir, 'agent-persona.md'),
      `# Persona (${entry.spec.name})\n\n${entry.spec.persona}`,
      'utf-8',
    )

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