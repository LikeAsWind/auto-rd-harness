/**
 * BaseAgent — Common interface for all auto-rd agent personas.
 *
 * An AgentSpec defines what the orchestrator needs to dispatch a subagent:
 *   - name: identifier used by the orchestrator
 *   - persona: the markdown system prompt injected via ctx.systemPrompt.section()
 *   - toolFilter: optional ctx.tools.restrict() filter to limit subagent capabilities
 *   - outputFormat: how the subagent's final message is parsed (free-form text vs structured JSON)
 *
 * See src/agents/AGENT-SKILL-MAPPING.md for which patterns each subclass borrows.
 */
export interface AgentSpec {
  readonly name: string
  readonly persona: string
  readonly toolFilter?: {
    allow?: string[]
    deny?: string[]
  }
  readonly outputFormat: 'free-form' | 'structured'
}