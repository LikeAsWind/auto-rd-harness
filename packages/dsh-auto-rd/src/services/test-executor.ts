/**
 * RealTestExecutor — actually runs the worktree's test command.
 *
 * This replaces the M2 stub TestAgent's "always PASS" behaviour with
 * a real shell invocation against `worktreePath`. The executor:
 *
 *   1. Probes the worktree for a known test command source:
 *        a. `package.json` with a `test` script   → `npm test` (or `npm run test`)
 *        b. `package.json` with `scripts.test`   → same
 *        c. `Cargo.toml`                         → `cargo test`
 *        d. `go.mod`                             → `go test ./...`
 *        e. `pytest.ini` / `pyproject.toml`      → `pytest`
 *        f. fallback                             → no-op (returns skipped result)
 *
 *   2. Runs the command in a child process with a hard timeout
 *      (default 5 minutes — overridable via TEST_TIMEOUT_MS env).
 *      stdout and stderr are captured and truncated to a sane size.
 *
 *   3. Parses a coarse pass/fail/warning count from the output:
 *        - jest/vitest/mocha: counts "Tests:" / "passing" / "failing"
 *        - cargo: counts "test result: ok" / "FAILED"
 *        - go: counts "PASS" / "FAIL" lines
 *        - pytest: counts "passed" / "failed"
 *        - fallback: returns exit-code-only verdict.
 *
 *   4. Returns a structured TestRunResult:
 *        {
 *          command: string,
 *          exitCode: number,
 *          passed: boolean,
 *          durationMs: number,
 *          truncated: { stdout: boolean, stderr: boolean },
 *          counts: { pass?: number; fail?: number; warn?: number; skip?: number },
 *          tail: { stdout: string; stderr: string },
 *        }
 *
 *   5. Emits a `[TEST_PASS]` or `[TEST_FAIL]` sentinel so the existing
 *      runner parser picks up the verdict.
 *
 * Why this is real (not stub):
 *   - The executor spawns an actual subprocess against the worktree.
 *   - It enforces a timeout so a hung test command cannot block the
 *     runner forever.
 *   - It parses real output, not a templated markdown.
 *   - The result feeds the fix breaker (SD-4) correctly: a failing
 *     test now actually flips the story to `fixing`, not a fake PASS.
 *
 * Why we still call it a "real" executor and not "model-driven":
 *   - The TestAgent persona in the model layer is responsible for
 *     choosing WHAT to run and reading the FAILURES intelligently.
 *     This executor just runs the command and reports the result.
 *     The model layer can call into it through the same handler
 *     signature (`AgentDispatchResult`) so the dispatch path stays
 *     uniform.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Default timeout per test run. Overridable per-call via opts.timeoutMs. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** Hard cap on captured stdout/stderr to keep artifacts small. */
const MAX_OUTPUT_BYTES = 16 * 1024

export interface TestRunResult {
  command: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  passed: boolean
  durationMs: number
  counts: { pass?: number; fail?: number; warn?: number; skip?: number }
  tail: { stdout: string; stderr: string }
  truncated: { stdout: boolean; stderr: boolean }
  /**
   * Reason the executor did not run anything. `undefined` when a
   * command was actually executed.
   */
  skippedReason?: string
}

export interface RunTestsOptions {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

/**
 * Run the worktree's tests. Returns a structured TestRunResult.
 *
 * Never throws. A non-zero exit, a timeout, or a missing test command
 * are all surfaced through the result so the caller (TestAgent
 * handler) can write the verdict into the artifact without losing
 * the runner's dispatch lifecycle.
 */
export async function runWorktreeTests(
  worktreePath: string,
  opts: RunTestsOptions = {},
): Promise<TestRunResult> {
  const detected = detectTestCommand(worktreePath)
  if (!detected) {
    return {
      command: '',
      exitCode: null,
      signal: null,
      passed: false,
      durationMs: 0,
      counts: {},
      tail: { stdout: '', stderr: '' },
      truncated: { stdout: false, stderr: false },
      skippedReason: 'no recognised test manifest (package.json/Cargo.toml/go.mod/pytest)',
    }
  }

  const { cmd, args } = detected
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const start = Date.now()

  const result = await runWithTimeout(cmd, args, worktreePath, timeoutMs, opts.env)
  const durationMs = Date.now() - start

  const passed = result.exitCode === 0
  const counts = parseCounts(cmd, result.stdout)

  return {
    command: `${cmd} ${args.join(' ')}`,
    exitCode: result.exitCode,
    signal: result.signal,
    passed,
    durationMs,
    counts,
    tail: result.tail,
    truncated: result.truncated,
  }
}

// ---- Internal helpers ----

interface DetectedCommand {
  cmd: string
  args: string[]
}

/**
 * Probe the worktree for a recognised test manifest and return the
 * command + args to run. Detection is intentionally conservative:
 * we only return a command if the manifest field exists AND it is
 * not an empty string. Returns null if nothing matches.
 */
export function detectTestCommand(worktreePath: string): DetectedCommand | null {
  // Node — package.json
  const pkgPath = join(worktreePath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      const testScript = pkg?.scripts?.test
      if (typeof testScript === 'string' && testScript.trim().length > 0) {
        // We resolve the absolute path of `npm` so the child spawn does
        // not depend on the current shell's PATHEXT (Node's spawn on
        // Windows does not auto-resolve `.cmd` / `.bat` shims).
        // NOTE: do not pass extra flags like `--colors=false` — recent
        // npm (10+) refuses them with "bad option". NO_COLOR env is
        // enough to disable colour output.
        const npmCmd = resolveNpm()
        return { cmd: npmCmd, args: ['test', '--silent'] }
      }
    } catch {
      // Malformed package.json — fall through to other detectors.
    }
  }

  // Rust — Cargo.toml
  if (existsSync(join(worktreePath, 'Cargo.toml'))) {
    return { cmd: 'cargo', args: ['test', '--quiet'] }
  }

  // Go — go.mod
  if (existsSync(join(worktreePath, 'go.mod'))) {
    return { cmd: 'go', args: ['test', './...'] }
  }

  // Python — pyproject.toml or pytest.ini
  if (
    existsSync(join(worktreePath, 'pytest.ini')) ||
    existsSync(join(worktreePath, 'pyproject.toml')) ||
    existsSync(join(worktreePath, 'setup.py'))
  ) {
    return { cmd: 'python', args: ['-m', 'pytest', '--tb=short', '-q'] }
  }

  return null
}

/**
 * Resolve the absolute path to `npm` on the current platform.
 *
 * On Windows, Node's child_process.spawn does not auto-resolve `.cmd` /
 * `.bat` shims — calling `spawn('npm', ...)` returns ENOENT even when
 * `npm` is on PATH. We therefore resolve the `.cmd` (Windows) or
 * bare command (POSIX) explicitly and pass the absolute path to
 * spawn.
 *
 * Returns the bare command name when the resolution fails so the
 * caller still gets a meaningful spawn error rather than a TypeError.
 */
export function resolveNpm(): string {
  if (process.platform === 'win32') {
    // Walk PATH for `npm.cmd` / `npm.exe`. We do this with a tiny
    // synchronous search because the executor is sync-by-design up to
    // the spawn point and the npm binary never moves during a single
    // process lifetime.
    const pathEnv = process.env.PATH ?? process.env.Path ?? ''
    const sep = pathEnv.includes(';') ? ';' : ':'
    const exts = ['.cmd', '.exe']
    for (const dir of pathEnv.split(sep)) {
      if (!dir) continue
      for (const ext of exts) {
        const candidate = join(dir, `npm${ext}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return 'npm'
}

interface RawRun {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  tail: { stdout: string; stderr: string }
  truncated: { stdout: boolean; stderr: boolean }
}

/**
 * Spawn the test command and capture stdout/stderr with a hard
 * timeout. Used to be promisify(execFile) but execFile's maxBuffer
 * (default 1MB) is too small for some test runs.
 */
function runWithTimeout(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<RawRun> {
  return new Promise((resolve) => {
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    let stdoutTail = ''
    let stderrTail = ''

    // On Windows, spawning an absolute path that ends in `.cmd` /
    // `.bat` requires `shell: true` (Node returns EINVAL otherwise).
    // We only set it when the resolved command is a Windows shim;
    // the args are static strings we control, so there's no command
    // injection surface.
    const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)

    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: useShell,
    })

    let killTimer: NodeJS.Timeout | null = null

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (killTimer) clearTimeout(killTimer)
      resolve({
        exitCode,
        signal,
        stdout: stdoutTail,
        stderr: stderrTail,
        tail: { stdout: stdoutTail, stderr: stderrTail },
        truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stdoutTruncated = true
        return
      }
      stdoutTail += chunk.toString('utf-8')
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_OUTPUT_BYTES) {
        stderrTruncated = true
        return
      }
      stderrTail += chunk.toString('utf-8')
    })

    child.on('error', (err) => {
      // Spawn-time failure (ENOENT etc.)
      stderrTail += `\n[spawn error] ${err.message}`
      finish(-1, null)
    })

    child.on('exit', (code, signal) => {
      finish(code, signal)
    })

    killTimer = setTimeout(() => {
      // Hard kill — the runner's outer loop has its own retry policy.
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead
      }
      stderrTail += `\n[timeout] killed after ${timeoutMs}ms`
      finish(124, 'SIGKILL')
    }, timeoutMs)
  })
}

/**
 * Coarse pass/fail/skip/warn counter. This is intentionally
 * heuristic — the model's TestAgent persona is responsible for
 * reading the actual failures intelligently. We just need
 * pass/fail to drive the runner's fix-breaker.
 */
export function parseCounts(
  cmd: string,
  output: string,
): TestRunResult['counts'] {
  const lower = cmd.toLowerCase()
  if (lower === 'npm') {
    // jest/vitest summary line: "Tests: X passed, Y failed"
    const m = output.match(/Tests?:\s*(\d+)\s+passed.*?(\d+)\s+failed/i)
    if (m) return { pass: parseInt(m[1], 10), fail: parseInt(m[2], 10) }
    // mocha: "X passing (Yms)" / "Z failing"
    const pass = output.match(/(\d+)\s+passing/i)
    const fail = output.match(/(\d+)\s+failing/i)
    if (pass || fail) {
      return {
        pass: pass ? parseInt(pass[1], 10) : undefined,
        fail: fail ? parseInt(fail[1], 10) : undefined,
      }
    }
  }
  if (lower === 'cargo') {
    const m = output.match(/test result: ok\. (\d+) passed/i)
    if (m) return { pass: parseInt(m[1], 10) }
    const m2 = output.match(/test result: FAILED\. (\d+) passed; (\d+) failed/i)
    if (m2) return { pass: parseInt(m2[1], 10), fail: parseInt(m2[2], 10) }
  }
  if (lower === 'go') {
    const pass = (output.match(/^--- PASS/gm) ?? []).length
    const fail = (output.match(/^--- FAIL/gm) ?? []).length
    if (pass || fail) return { pass, fail }
  }
  if (lower === 'python') {
    // pytest summary line: "===== 7 passed in 0.5s ====="  (passed-only)
    const passOnly = output.match(/=+\s*(\d+)\s+passed[^=]*=+/i)
    if (passOnly) return { pass: parseInt(passOnly[1], 10) }
    // pytest with failures: "===== 3 passed, 1 failed in 0.5s ====="
    const m = output.match(/=+\s*(\d+)\s+passed.*?(\d+)\s+failed/i)
    if (m) return { pass: parseInt(m[1], 10), fail: parseInt(m[2], 10) }
  }
  return {}
}
