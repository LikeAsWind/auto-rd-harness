// Run every test suite and report an aggregate result.
//
// A plain `suite && suite && ...` chain in package.json would stop at the
// first failure and would print no summary. This runs all of them, shows
// each suite's own output, parses its "N pass, M fail" line, and exits
// non-zero if anything failed anywhere.
//
// Run with: npm run test:all

import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

/** [label, script] in the order they are reported. */
const SUITES = [
  ['pattern audit', 'scripts/audit-patterns.mjs'],
  ['clarify', 'scripts/test-clarify.mjs'],
  ['resolution', 'scripts/test-resolution.mjs'],
  ['ui panel', 'scripts/test-ui-panel.mjs'],
  ['panel route', 'scripts/test-panel-route.mjs'],
  ['client half', 'scripts/test-client-half.mjs'],
  ['stage mapping', 'scripts/test-stage.mjs'],
  ['watch panel', 'scripts/test-watch-panel.mjs'],
  ['recover', 'scripts/test-recover.mjs'],
]

const results = []
let totalPass = 0
let totalFail = 0

for (const [label, script] of SUITES) {
  const started = Date.now()
  const proc = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  })
  const ms = Date.now() - started
  const stdout = proc.stdout ?? ''
  const stderr = proc.stderr ?? ''

  // Each suite ends with "<label>: <n> pass, <m> fail".
  const match = [...stdout.matchAll(/(\d+) pass, (\d+) fail/g)].pop()
  const pass = match ? Number(match[1]) : 0
  const fail = match ? Number(match[2]) : 0
  const ok = proc.status === 0 && fail === 0 && match !== undefined

  totalPass += pass
  totalFail += fail
  results.push({ label, script, pass, fail, ok, ms, status: proc.status })

  if (!ok) {
    // Show the failure detail immediately; successes stay quiet.
    process.stdout.write(`\n--- ${label} FAILED (exit ${proc.status}) ---\n`)
    process.stdout.write(stdout)
    if (stderr.trim()) process.stdout.write(stderr)
  }
}

// ---- summary ---------------------------------------------------------

process.stdout.write('\n' + '='.repeat(72) + '\n')
process.stdout.write('suite results\n')
process.stdout.write('='.repeat(72) + '\n')

for (const r of results) {
  const mark = r.ok ? 'ok  ' : 'FAIL'
  const counts = r.ok ? `${r.pass} pass` : `${r.pass} pass, ${r.fail} fail (exit ${r.status})`
  process.stdout.write(`${mark}  ${r.label.padEnd(34)} ${counts}\n`)
}

const failedSuites = results.filter((r) => !r.ok)
process.stdout.write('='.repeat(72) + '\n')
process.stdout.write(
  `${results.length} suites | ${totalPass} assertions passed | ${totalFail} failed | ` +
    `${failedSuites.length} suite(s) failing\n`,
)
process.stdout.write('='.repeat(72) + '\n')

if (failedSuites.length > 0) {
  process.stdout.write('\nfailing suites: ' + failedSuites.map((r) => r.label).join(', ') + '\n')
  process.exitCode = 1
}
