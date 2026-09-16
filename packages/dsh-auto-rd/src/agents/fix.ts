/**
 * FixAgent — Root-cause debugger for failing tests.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - D-1: Iron Law No Fix Without Root Cause (obra/systematic-debugging)
 * - D-2: Four Phases (Root Cause → Pattern → Hypothesis → Implementation)
 * - D-3: 3-Fix Architectural Question
 * - D-4: Multi-Component Boundary Check
 * - T-5: Never Fix Bug Without Test (obra/test-driven-development)
 * - SD-4: 5-Round Fix Loop + Breaker (obra/subagent-driven-development)
 *
 * Tool surface: read + edit + bash. No fs_write (we mutate, not create
 * new files in fix mode). git_commit allowed because TDD commits each fix.
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export class FixAgent implements AgentSpec {
  readonly name = 'fix'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('fix')

  readonly toolFilter = {
    allow: [
      'fs_read',
      'fs_search',
      'fs_edit',
      'fs_write',
      'bash',
      'git_diff',
      'git_log',
      'git_commit',
    ],
  }
}