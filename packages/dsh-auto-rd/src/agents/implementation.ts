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
 * The persona is in personas/implementation.md.tmpl; per-task variables
 * {TASK_ID}, {TASK_TITLE}, {TASK_DESCRIPTION}, {DEPENDS_ON} are interpolated.
 */
import type { AgentSpec } from './base'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const TEMPLATE_PATH = resolve(__dirname, 'personas', 'implementation.md.tmpl')
const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf-8')

export class ImplementationAgent implements AgentSpec {
  readonly name = 'implementation'
  readonly outputFormat = 'free-form' as const

  constructor(
    public readonly taskId: string,
    public readonly taskTitle: string,
    public readonly taskDescription: string,
    public readonly dependsOn: string[],
  ) {}

  get persona(): string {
    const dependsLine = this.dependsOn.length > 0 ? this.dependsOn.join(', ') : 'none'
    return TEMPLATE
      .replaceAll('{TASK_ID}', this.taskId)
      .replaceAll('{TASK_TITLE}', this.taskTitle)
      .replaceAll('{TASK_DESCRIPTION}', this.taskDescription)
      .replaceAll('{DEPENDS_ON}', dependsLine)
  }

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