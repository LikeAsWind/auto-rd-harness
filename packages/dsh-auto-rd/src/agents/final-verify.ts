/**
 * FinalVerifyAgent — Whole-branch gate before merge request.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - CR-1..CR-5: Two-Axis Review (mattpocock/code-review)
 * - DP-1..DP-2: Parallel Sub-Agents (obra/dispatching-parallel-agents)
 * - F-1: Re-Run on Integration Tree (obra/finishing-a-development-branch)
 * - V-1: Iron Law Fresh Evidence (obra/verification-before-completion)
 * - SD-6..SD-7: Final Review + Ledger (obra/subagent-driven-development)
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export class FinalVerifyAgent implements AgentSpec {
  readonly name = 'final-verify'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('final-verify')

  readonly toolFilter = {
    allow: ['fs_read', 'fs_search', 'git_diff', 'git_log', 'git_show', 'git_status', 'bash'],
  }
}