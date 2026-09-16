/**
 * VerificationAgent — Black-box verifier independent of tests.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - V-1: Iron Law Fresh Evidence (obra/verification-before-completion)
 * - V-2: Gate Function (obra/verification-before-completion)
 * - V-3: Common Failures Table (obra/verification-before-completion)
 * - F-1: Re-Run on Integration Tree (obra/finishing-a-development-branch)
 */
import type { AgentSpec } from './base.js'
import { loadPersona } from './persona-loader.js'

export class VerificationAgent implements AgentSpec {
  readonly name = 'verification'
  readonly outputFormat = 'free-form' as const
  readonly persona: string = loadPersona('verification')

  readonly toolFilter = {
    allow: [
      'fs_read',
      'fs_search',
      'fs_glob',
      'bash',
      'git_diff',
      'git_log',
      'web_fetch',
    ],
  }
}