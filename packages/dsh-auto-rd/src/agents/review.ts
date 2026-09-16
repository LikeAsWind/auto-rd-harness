/**
 * ReviewAgent — Per-task two-axis code review.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - CR-1..CR-5: Two-Axis Review + Fowler 12 smell baseline (mattpocock/code-review)
 * - RC-1..RC-3: Diff Range, Severity Scale, ⚠️ Cannot Verify (obra/requesting-code-review)
 * - SD-5: Two-Stage Review per Task (obra/subagent-driven-development)
 */
import type { AgentSpec } from './base'
import { loadPersona } from './persona-loader'

export class ReviewAgent implements AgentSpec {
  readonly name = 'review'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('review')

  readonly toolFilter = {
    allow: ['fs_read', 'fs_search', 'git_diff', 'git_log', 'git_show'],
  }
}