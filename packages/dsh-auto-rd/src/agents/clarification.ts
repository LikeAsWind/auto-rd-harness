/**
 * ClarificationAgent — Socratic grilling to refine the story.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - B-1: Three Paths Classification (obra/brainstorming)
 * - B-2: One Question At A Time (obra/brainstorming)
 * - B-3: Multiple-Choice 优先 (obra/brainstorming)
 * - B-4: HARD-GATE (obra/brainstorming)
 * - G-1: Grill Relentlessly Until Every Branch Resolved (mattpocock/grilling)
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export class ClarificationAgent implements AgentSpec {
  readonly name = 'clarification'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('clarification')

  readonly toolFilter = {
    allow: ['fs_read', 'fs_search', 'fs_glob', 'web_fetch'],
  }
}