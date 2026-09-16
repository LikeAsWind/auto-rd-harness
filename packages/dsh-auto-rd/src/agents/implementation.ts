/**
 * ImplementationAgent — Execute one plan task with TDD discipline.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - T-1: Iron Law No Code Without Failing Test (obra/test-driven-development)
 * - T-4: Code Before Test? Delete It (obra/test-driven-development)
 * - SD-2: Fresh Subagent Per Task (obra/subagent-driven-development)
 * - SD-3: No-Subagents Contract (obra/subagent-driven-development)
 * - SD-8: Hand Artifacts As Files (obra/subagent-driven-development)
 *
 * The orchestrator dispatches a FRESH instance of this agent per task
 * (SD-2). The persona markdown describes the role generically; per-task
 * context (task_id, files, red/green steps) is passed in the dispatch
 * request's `inputs.task` bag, not interpolated into the persona.
 */
import type { AgentSpec } from './base'
import { loadPersona } from './persona-loader'

export class ImplementationAgent implements AgentSpec {
  readonly name = 'implementation'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('implementation')

  constructor(public readonly taskId: string) {}

  readonly toolFilter = {
    allow: [
      'fs_read',
      'fs_search',
      'fs_glob',
      'fs_write',
      'fs_edit',
      'bash',
      'git_status',
      'git_diff',
      'git_log',
      'git_commit',
    ],
  }
}