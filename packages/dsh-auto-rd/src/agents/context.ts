/**
 * ContextAgent — Establishes the working environment and codebase facts
 * before any design work begins.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - W-1: Step 0 Detect Isolation (obra/using-git-worktrees)
 * - W-2: Native Tools First (obra/using-git-worktrees)
 * - W-3: Verify Clean Baseline (obra/using-git-worktrees)
 *
 * The persona markdown lives in `personas/context.md` (loaded at runtime)
 * so we never have to escape backticks inside a TS template literal.
 */
import type { AgentSpec } from './base'
import { loadPersona } from './persona-loader'

export class ContextAgent implements AgentSpec {
  readonly name = 'context'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('context')

  readonly toolFilter = {
    allow: [
      'fs_read',
      'fs_search',
      'fs_glob',
      'bash',
      'git_status',
      'git_log',
      'web_fetch',
    ],
  }
}