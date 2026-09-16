/**
 * Shared output definitions for the auto-rd tools.
 *
 * Every DSH `ToolDefinition` MUST carry an `output` contract:
 *
 *   output: {
 *     schema: <JSON Schema for the returned value>
 *     render(args, value): ContentBlock[]
 *   }
 *
 * A definition that omits it is rejected by `tools.register()`, so the
 * three auto-rd tools would never have appeared to the model. These
 * helpers keep the three definitions consistent and keep the rendering
 * logic in one place.
 */
import type { ContentBlock, ToolOutputDefinition } from '../types/dsh-services.js'

/** Characters of JSON shown to the model before truncation. */
export const MAX_RENDER_CHARS = 8_000

/**
 * A tool whose value is a JSON object, rendered as pretty-printed JSON.
 *
 * JSON is the right default here: these tools return structured pipeline
 * state (counts, story rows, task rows) that the model reads field by
 * field, and a stable machine-readable shape is more useful than prose
 * it would have to re-parse.
 */
export function jsonOutput(schema: Record<string, unknown> = {}): ToolOutputDefinition {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      ...schema,
    },
    render(_args: unknown, value: unknown): ContentBlock[] {
      return [{ type: 'text', text: renderJson(value) }]
    },
  }
}

/** Pretty-print a value, truncating so one call cannot flood the context. */
export function renderJson(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    // Circular or otherwise unserialisable — fall back to String().
    text = String(value)
  }
  if (text.length <= MAX_RENDER_CHARS) return text
  return `${text.slice(0, MAX_RENDER_CHARS)}\n... [truncated, ${text.length - MAX_RENDER_CHARS} more characters]`
}
