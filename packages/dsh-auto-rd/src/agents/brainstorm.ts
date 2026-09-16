/**
 * BrainstormAgent — produces ONE concrete proposal per invocation.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - B-5: Propose 2–3 Approaches with Trade-offs (obra/brainstorming)
 * - B-6: Lead With Recommended (obra/brainstorming)
 * - B-7: YAGNI Ruthlessly (obra/brainstorming)
 *
 * The orchestrator dispatches this agent THREE times in parallel, once
 * per variation (minimal / clean / novel) — matches the design doc
 * auto-rd-native-plugin-design.md §6.6. Each invocation commits to its
 * variation; the agent does not produce all three internally.
 *
 * Tool surface: read-only. Implementation is the implementing agent's job.
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export type BrainstormVariation = 'minimal' | 'clean' | 'novel'

export class BrainstormAgent implements AgentSpec {
  readonly name = 'brainstorm'
  readonly outputFormat = 'free-form' as const

  constructor(
    public readonly variation: BrainstormVariation,
    public readonly index: number,
  ) {}

  get persona(): string {
    // Load the base persona once per instance. The persona body describes
    // the agent's role in general terms; the variation parameter is carried
    // in the dispatch request bag, not interpolated into the persona.
    return loadPersona('brainstorm')
  }

  readonly toolFilter = {
    allow: ['fs_read', 'fs_search', 'fs_glob', 'web_fetch'],
  }
}