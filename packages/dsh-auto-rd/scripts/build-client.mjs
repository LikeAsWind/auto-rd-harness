// Build the client bundle.
//
// Concatenates src/client/stage-data.js into src/client/client.js so the
// browser-only code carries the stage mapping without needing a separate
// module loader. Output goes to lib/client.js, where the shell's module
// loader picks it up.
//
// Run from the package root: `npm run copy:client`.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const src = join(root, 'src', 'client', 'client.js')
const stage = join(root, 'src', 'client', 'stage-data.js')
const dst = join(root, 'lib', 'client.js')

if (!existsSync(src)) throw new Error('missing ' + src)
if (!existsSync(stage)) throw new Error('missing ' + stage)

const client = readFileSync(src, 'utf-8')
const stageSrc = readFileSync(stage, 'utf-8')

// Concatenate: client header first, then stage-data, then the rest of
// the client. The split point is the marker comment that sits right
// before the `window.__ModuleLoader__.load({` call — everything before
// the marker is doc/imports, everything after is the factory.
const MARKER = '// __STAGE_DATA_INJECTION_POINT__'
const markerIdx = client.indexOf(MARKER)
if (markerIdx < 0) throw new Error('marker not found in client.js: ' + MARKER)

// The marker sits on its own line, immediately before the
// `window.__ModuleLoader__.load({` call. Insert stage data between
// them so its `var` declarations share the same module scope.
const insertAt = markerIdx + MARKER.length
const head = client.slice(0, insertAt)
const factory = client.slice(insertAt)

mkdirSync(dirname(dst), { recursive: true })
writeFileSync(
  dst,
  head + '\n/* === inlined stage-data.js (build step) === */\n' + stageSrc + '\n/* === end stage-data.js === */\n' + factory,
)
console.log('copied client bundle -> lib/client.js')
