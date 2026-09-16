/**
 * BrainstormAgent — Propose 2-3 design approaches with trade-offs.
 *
 * Patterns borrowed (from src/agents/AGENT-SKILL-MAPPING.md):
 * - B-5: Propose 2-3 Approaches With Trade-offs (obra/brainstorming)
 * - B-6: Lead With Recommended (obra/brainstorming)
 * - B-7: YAGNI Ruthlessly (obra/brainstorming)
 *
 * Three Brainstorm agents run in parallel with different biases
 * (minimal-change / clean-rewrite / novel-approach). The persona template
 * is in personas/brainstorm.md.tmpl; per-instance variation is interpolated
 * into {VARIATION} and {INDEX} placeholders.
 */
import type { AgentSpec } from './base'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

export type BrainstormVariation = 'minimal-change' | 'clean-rewrite' | 'novel-approach'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const TEMPLATE_PATH = resolve(__dirname, 'personas', 'brainstorm.md.tmpl')

const TEMPLATE = readFileSync(TEMPLATE_PATH, 'utf-8')

export class BrainstormAgent implements AgentSpec {
  readonly name = 'brainstorm'
  readonly outputFormat = 'free-form' as const

  constructor(
    public readonly variation: BrainstormVariation,
    public readonly index: number,
  ) {}

  get persona(): string {
    return TEMPLATE
      .replaceAll('{VARIATION}', this.variation)
      .replaceAll('{INDEX}', String(this.index))
  }

  readonly toolFilter = {
    allow: [
      'fs_read',
      'fs_search',
      'fs_glob',
      'web_fetch',
    ],
  }
}