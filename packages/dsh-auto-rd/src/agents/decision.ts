/**
 * DecisionAgent — Engineering manager who makes the final call.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - SD-1: Rulings, Not Stalls (obra/subagent-driven-development)
 * - SD-7: Ledger Cross-Compaction (obra/subagent-driven-development)
 * - PL-7: Execution Handoff (obra/writing-plans)
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export class DecisionAgent implements AgentSpec {
  readonly name = 'decision'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('decision')

  readonly toolFilter = {
    allow: ['fs_read', 'fs_search'],
  }
}