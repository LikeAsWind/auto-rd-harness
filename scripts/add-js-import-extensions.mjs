#!/usr/bin/env node
// Append `.js` to every relative import/export specifier in src/.
// Only touches lines of the form `from './...'` or `from '../...'`
// (and the dynamic `import('./...')` variant) that do NOT already end
// in `.js`, `.ts`, `.json`, `.md`, or `/` (directory import).
//
// Run once after the schema/parser commit. Idempotent: re-running is a
// no-op because every import already ends in `.js`.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'src')

const SKIP_SUFFIXES = ['.js', '.ts', '.json', '.mjs', '.cjs', '.md', '.node']

// Match imports/exports of relative paths. Captures the path so we
// can rewrite it.
const importRe = /(\b(?:import|export)\s+(?:[^'"\n;]*?\sfrom\s+)?)(['"])(\.\.?\/[^'"]+)\2/g

let touched = 0
let skipped = 0
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full)
      continue
    }
    if (!/\.ts$/.test(entry.name)) continue
    const text = readFileSync(full, 'utf-8')
    const updated = text.replace(importRe, (whole, head, quote, spec) => {
      if (SKIP_SUFFIXES.some((s) => spec.endsWith(s))) {
        skipped++
        return whole
      }
      if (spec.endsWith('/')) {
        skipped++
        return whole
      }
      touched++
      return `${head}${quote}${spec}.js${quote}`
    })
    if (updated !== text) writeFileSync(full, updated, 'utf-8')
  }
}

walk(srcRoot)
console.log(`add-js-import-extensions: ${touched} imports extended, ${skipped} skipped`)