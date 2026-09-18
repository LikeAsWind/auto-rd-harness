/**
 * ResolutionAgent — Requirement Arbiter.
 *
 * The Resolution role sits between `clarification` and `brainstorm`.
 * Clarification ASKS (emits open questions); Resolution ANSWERS so the
 * pipeline proceeds unattended (design decision: full-auto — resolve by
 * recorded assumption, not by parking the story).
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - SD-1: Rulings, Not Stalls (obra/subagent-driven-development)
 * - SD-7: Ledger Cross-Compaction (obra/subagent-driven-development)
 * - SD-8: Hand Artifacts As Files (obra/subagent-driven-development)
 *
 * The persona markdown lives in `personas/resolution.md` (loaded at
 * runtime) so we never have to escape backticks inside a TS template
 * literal.
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export class ResolutionAgent implements AgentSpec {
  readonly name = 'resolution'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('resolution')

  readonly toolFilter = {
    allow: ['fs_read', 'fs_write'],
  }
}
