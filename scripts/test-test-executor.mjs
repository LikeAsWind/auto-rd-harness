// TestExecutor unit + integration tests.
//
// Covers:
//   - detectTestCommand on a real tmp worktree:
//       * package.json with scripts.test -> npm test
//       * package.json without scripts.test -> skipped
//       * Cargo.toml -> cargo test
//       * go.mod -> go test
//       * pyproject.toml -> pytest
//       * empty dir -> null
//   - runWorktreeTests actually spawns a subprocess:
//       * npm test in a tmp worktree with a passing script -> PASS
//       * npm test with a failing script -> FAIL + reason
//       * unknown manifest -> skippedReason set, exitCode null
//   - parseCounts on representative fixtures:
//       * jest / vitest summary line
//       * mocha "X passing / Y failing"
//       * cargo "test result: ok"
//       * go "PASS / FAIL"
//       * pytest "X passed / Y failed"
//
// Run with: node scripts/test-test-executor.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const {
  detectTestCommand,
  runWorktreeTests,
  parseCounts,
} = await import(
  pathToFileURL(resolve(libBase, 'services', 'test-executor.js')).href
)

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) {
    pass += 1
    process.stdout.write(`\u2713 ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`\u2717 ${name}${extra ? ` (${extra})` : ''}\n`)
  }
}

function mkTmpDir() {
  return mkdtempSync(join(tmpdir(), 'auto-rd-test-exec-'))
}

// ---- detectTestCommand -----------------------------------------------

// 1. package.json with scripts.test -> npm
{
  const dir = mkTmpDir()
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'echo pass' } }),
    'utf-8',
  )
  const r = detectTestCommand(dir)
  // We accept either 'npm' (POSIX) or an absolute path ending in
  // npm.cmd / npm.exe (Windows). args[0] must always be 'test'.
  const ok =
    r !== null &&
    r.args[0] === 'test' &&
    (r.cmd === 'npm' || /npm(\.cmd|\.exe)?$/i.test(r.cmd))
  check('detect: package.json scripts.test -> npm test', ok, JSON.stringify(r))
}

// 2. package.json without scripts.test -> null
{
  const dir = mkTmpDir()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }), 'utf-8')
  const r = detectTestCommand(dir)
  check('detect: package.json without scripts.test -> null', r === null, JSON.stringify(r))
}

// 3. Cargo.toml -> cargo
{
  const dir = mkTmpDir()
  writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "x"', 'utf-8')
  const r = detectTestCommand(dir)
  check('detect: Cargo.toml -> cargo test', r?.cmd === 'cargo' && r?.args[0] === 'test')
}

// 4. go.mod -> go
{
  const dir = mkTmpDir()
  writeFileSync(join(dir, 'go.mod'), 'module x', 'utf-8')
  const r = detectTestCommand(dir)
  check('detect: go.mod -> go test ./...', r?.cmd === 'go' && r?.args[1] === './...')
}

// 5. pyproject.toml -> python -m pytest
{
  const dir = mkTmpDir()
  writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname="x"', 'utf-8')
  const r = detectTestCommand(dir)
  check(
    'detect: pyproject.toml -> python -m pytest',
    r?.cmd === 'python' && r?.args[0] === '-m' && r?.args[1] === 'pytest',
  )
}

// 6. empty dir -> null
{
  const dir = mkTmpDir()
  check('detect: empty dir -> null', detectTestCommand(dir) === null)
}

// ---- parseCounts ------------------------------------------------------

{
  const c = parseCounts('npm', 'Tests: 3 passed, 2 failed, 1 skipped')
  check(
    'parseCounts: jest summary line',
    c.pass === 3 && c.fail === 2,
    JSON.stringify(c),
  )
}
{
  const c = parseCounts('npm', '3 passing (200ms)\n1 failing')
  check(
    'parseCounts: mocha summary',
    c.pass === 3 && c.fail === 1,
    JSON.stringify(c),
  )
}
{
  const c = parseCounts('cargo', 'test result: ok. 5 passed; 0 failed; 0 ignored')
  check('parseCounts: cargo ok', c.pass === 5, JSON.stringify(c))
}
{
  const c = parseCounts('go', '--- PASS: TestFoo\n--- PASS: TestBar\n--- FAIL: TestBaz')
  check(
    'parseCounts: go PASS/FAIL count',
    c.pass === 2 && c.fail === 1,
    JSON.stringify(c),
  )
}
{
  const c = parseCounts('python', '===== 7 passed in 0.5s =====')
  check('parseCounts: pytest passed-only', c.pass === 7, JSON.stringify(c))
}
{
  const c = parseCounts('unknown', 'whatever')
  check('parseCounts: unknown cmd -> empty counts', Object.keys(c).length === 0, JSON.stringify(c))
}

// ---- runWorktreeTests (real subprocess) ------------------------------

// 7. Real npm test in a tmp worktree with a passing script -> PASS
{
  const dir = mkTmpDir()
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "console.log(\'hi\'); process.exit(0)"' } }),
    'utf-8',
  )
  const r = await runWorktreeTests(dir, { timeoutMs: 30_000 })
  check('runWorktreeTests: passing npm test -> passed=true', r.passed === true, JSON.stringify(r))
  check(
    'runWorktreeTests: passing npm test -> exitCode=0',
    r.exitCode === 0,
    JSON.stringify(r),
  )
  check(
    'runWorktreeTests: command field populated',
    /npm\.cmd test/.test(r.command) || /npm test/.test(r.command),
  )
}

// 8. Real npm test with failing script -> FAIL + reason
{
  const dir = mkTmpDir()
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "console.log(\'oops\'); process.exit(1)"' } }),
    'utf-8',
  )
  const r = await runWorktreeTests(dir, { timeoutMs: 30_000 })
  check('runWorktreeTests: failing npm test -> passed=false', r.passed === false)
  check('runWorktreeTests: failing npm test -> exitCode=1', r.exitCode === 1)
  check(
    'runWorktreeTests: tail captures stdout',
    typeof r.tail.stdout === 'string' && r.tail.stdout.includes('oops'),
  )
}

// 9. Unknown manifest -> skippedReason set
{
  const dir = mkTmpDir()
  // empty — no manifest
  const r = await runWorktreeTests(dir)
  check(
    'runWorktreeTests: unknown manifest -> skippedReason',
    typeof r.skippedReason === 'string' && r.skippedReason.length > 0,
    JSON.stringify(r),
  )
  check('runWorktreeTests: skipped -> exitCode=null', r.exitCode === null)
  check('runWorktreeTests: skipped -> command=""', r.command === '')
}

// 10. Timeout enforcement
{
  const dir = mkTmpDir()
  // sleep for 10 seconds; we'll timeout at 1s.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "setTimeout(()=>{},10000)"' } }),
    'utf-8',
  )
  const t0 = Date.now()
  const r = await runWorktreeTests(dir, { timeoutMs: 1000 })
  const elapsed = Date.now() - t0
  check(
    'runWorktreeTests: 1s timeout kills within ~2s',
    elapsed < 3000,
    `elapsed=${elapsed}ms`,
  )
  check(
    'runWorktreeTests: timeout -> stderr tail notes kill',
    r.tail.stderr.includes('[timeout]'),
  )
}

// ---- Summary ---------------------------------------------------------

process.stdout.write(`\nTestExecutor tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
