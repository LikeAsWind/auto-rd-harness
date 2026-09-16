/**
 * CriticAgent — Attack each proposal before code is written.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - CR-3: Spec Line-by-Line Check (mattpocock/code-review)
 * - RC-2: Severity Scale Critical/Important/Minor (mattpocock/code-review)
 * - RC-4: Reviewer Can Be Wrong (mattpocock/code-review)
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export class CriticAgent implements AgentSpec {
  readonly name = 'critic'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('critic')

  readonly toolFilter = {
    allow: ['fs_read', 'fs_search', 'fs_glob'],
  }
}