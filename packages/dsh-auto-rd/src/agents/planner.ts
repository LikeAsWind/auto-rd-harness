/**
 * PlannerAgent — Break the spec into bite-sized tasks with exact content.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - PL-1: File Structure First (obra/writing-plans)
 * - PL-2: Task Right-Sizing (obra/writing-plans)
 * - PL-3: Bite-Sized Steps 2-5 min (obra/writing-plans)
 * - PL-4: TDD Step Template (obra/writing-plans)
 * - PL-5: No Placeholders (obra/writing-plans)
 * - PL-6: Plan Self-Review (obra/writing-plans)
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export class PlannerAgent implements AgentSpec {
  readonly name = 'planner'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('planner')

  readonly toolFilter = {
    allow: ['fs_read', 'fs_search', 'fs_write'],
  }
}