/**
 * Persona loader — reads persona markdown from disk at construction time.
 *
 * Personas live as plain `.md` files in `src/agents/personas/<agent>.md`.
 * Putting the markdown on disk (instead of inlined in TS) means we never
 * have to escape backticks or worry about template literal boundaries.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

// In ESM, import.meta.url gives us this file's URL. From here we can derive
// the personas/ directory at runtime without bundler magic.
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PERSONAS_DIR = resolve(__dirname, 'personas')

export function loadPersona(name: string): string {
  const path = join(PERSONAS_DIR, `${name}.md`)
  return readFileSync(path, 'utf-8')
}