/**
 * TestAgent — Verify the implementation against the Spec's ACs.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - T-2: Verify RED Before GREEN (obra/test-driven-development)
 * - T-3: Verify GREEN Pristine (obra/test-driven-development)
 * - V-1: Iron Law Fresh Evidence (obra/verification-before-completion)
 * - V-2: Gate Function (obra/verification-before-completion)
 */
import type { AgentSpec } from './base'
import { loadPersona } from './persona-loader'

export class TestAgent implements AgentSpec {
  readonly name = 'test'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('test')

  readonly toolFilter = {
    allow: ['fs_read', 'fs_search', 'fs_glob', 'fs_write', 'bash', 'git_diff', 'git_log'],
  }
}