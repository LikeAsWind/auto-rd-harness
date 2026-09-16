/**
 * SpecAgent — Write the formal specification.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - B-8: Spec Self-Review (obra/brainstorming)
 * - PL-5: No Placeholders (obra/writing-plans)
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export class SpecAgent implements AgentSpec {
  readonly name = 'spec'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('spec')

  readonly toolFilter = {
    allow: ['fs_read', 'fs_search', 'fs_write'],
  }
}