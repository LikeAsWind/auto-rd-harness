/**
 * Persona loader — reads persona markdown from disk at construction time.
 *
 * Personas live as plain `.md` files in `src/agents/personas/<agent>.md`.
 * Putting the markdown on disk (instead of inlined in TS) means we never
 * have to escape backticks or worry about template literal boundaries.
 *
 * Resolution order (first hit wins):
 *   1. `<this-file-dir>/personas/<name>.md`
 *        — present when running from `lib/agents/persona-loader.js` after a
 *          build that copied `personas/*.md` next to the compiled JS
 *          (the `copy:personas` npm script does this).
 *   2. `<this-file-dir>/../../src/agents/personas/<name>.md`
 *        — present when running from source (e.g. via ts-node or during
 *          a development harness that mounts src directly).
 *   3. `<cwd>/src/agents/personas/<name>.md`
 *        — last-ditch fallback when the bundler/resolver has flattened the
 *          layout. Cheap to probe, harmless to leave in.
 *
 * The loader returns an empty string (not throws) when a persona is missing
 * so an AgentSpec can still construct and log a clear warning, instead of
 * crashing the whole plugin mount.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const THIS_DIR = __dirname

const CANDIDATE_DIRS = [
  join(THIS_DIR, 'personas'),
  resolve(THIS_DIR, '..', '..', 'src', 'agents', 'personas'),
  resolve(process.cwd(), 'src', 'agents', 'personas'),
]

export function loadPersona(name: string): string {
  for (const dir of CANDIDATE_DIRS) {
    const path = join(dir, `${name}.md`)
    if (existsSync(path)) {
      return readFileSync(path, 'utf-8')
    }
  }
  // Missing persona is non-fatal — the agent will still construct, the
  // orchestrator can still log, and the handler still writes a report.
  // We surface the miss in the return value so the caller can choose to log.
  return ''
}