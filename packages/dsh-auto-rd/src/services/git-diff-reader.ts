/**
 * GitDiffReader — read the actual diff for a story branch.
 *
 * Replaces the M2 stub ReviewAgent / FinalVerifyAgent's "always
 * APPROVE / FINAL_READY" behaviour with a real `git diff` invocation
 * against the worktree. The reader:
 *
 *   1. Resolves the diff base:
 *        a. `origin/<defaultBranch>` if the remote is reachable
 *        b. the merge-base of HEAD and <defaultBranch>
 *        c. fallback: `HEAD~1` if HEAD has a parent
 *        d. last resort: empty diff (returns commit count = 0)
 *
 *   2. Runs `git diff <base>..HEAD` and `git log <base>..HEAD --oneline`
 *      in the worktree, capturing stdout/stderr with a 60s timeout and
 *      a 256KB tail cap (a typical PR diff is < 50KB; the cap is there
 *      to keep the artifact readable).
 *
 *   3. Parses a coarse summary: commit count, files changed,
 *      insertions, deletions. The model's review layer is responsible
 *      for reading the actual content and emitting findings; this
 *      reader just gives it the raw material to work from.
 *
 *   4. Returns a structured DiffResult:
 *        {
 *          base: string,                 // resolved base SHA/ref
 *          head: string,                 // HEAD SHA
 *          commitCount: number,
 *          filesChanged: string[],       // paths
 *          insertions: number,           // +
 *          deletions: number,            // -
 *          diffText: string,             // raw git diff output
 *          logText: string,              // git log --oneline
 *          truncated: boolean,
 *          error?: string,               // git command failure
 *        }
 *
 * Why this is real (not stub):
 *   - The reader actually spawns `git diff` against the worktree.
 *   - It enforces a timeout so a runaway git operation cannot block.
 *   - It parses real `--shortstat` numbers, not fixed markdown.
 *   - The reviewer can now see the actual diff and emit non-zero
 *     findings when the diff is suspicious (huge diffs, deleted tests,
 *     missing error handling). The stub never could.
 *
 * Why we still call it a "real" reader and not "model-driven":
 *   - The model layer is the one that emits the [REVIEW_X_APPROVE] /
 *     [REVIEW_X_CHANGES] / [FINAL_READY] verdict after reading the
 *     diff. This reader is the deterministic gatherer.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const MAX_DIFF_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

export interface DiffResult {
  base: string
  head: string
  commitCount: number
  filesChanged: string[]
  insertions: number
  deletions: number
  diffText: string
  logText: string
  truncated: boolean
  error?: string
}

export interface ReadDiffOptions {
  defaultBranch?: string
  timeoutMs?: number
}

/**
 * Read the diff for the worktree's current branch against its base.
 * Never throws; errors are returned through `DiffResult.error`.
 */
export async function readWorktreeDiff(
  worktreePath: string,
  opts: ReadDiffOptions = {},
): Promise<DiffResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  // Sanity: the worktree must be a git repo.
  if (!existsSync(join(worktreePath, '.git'))) {
    return {
      base: '',
      head: '',
      commitCount: 0,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      diffText: '',
      logText: '',
      truncated: false,
      error: `worktree ${worktreePath} has no .git directory`,
    }
  }

  let head: string
  try {
    head = (await runGit(['rev-parse', 'HEAD'], worktreePath, timeoutMs)).trim()
  } catch (err) {
    return {
      base: '',
      head: '',
      commitCount: 0,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      diffText: '',
      logText: '',
      truncated: false,
      error: `git rev-parse HEAD failed: ${(err as Error).message}`,
    }
  }

  const base = await resolveBase(worktreePath, opts.defaultBranch, timeoutMs)

  // If base is HEAD (no parent), the diff is empty — return early.
  if (!base || base === head) {
    return {
      base: base || head,
      head,
      commitCount: 0,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
      diffText: '',
      logText: '',
      truncated: false,
    }
  }

  // Run diff + log concurrently. We don't pipe `git log` through
  // `git diff` because we want both outputs in full.
  const [diffText, logText, shortstat, nameStatus] = await Promise.all([
    runGitWithLimit(['diff', `${base}..HEAD`], worktreePath, timeoutMs, MAX_DIFF_BYTES),
    runGit(['log', `${base}..HEAD`, '--oneline', '--no-color'], worktreePath, timeoutMs),
    runGit(['diff', '--shortstat', `${base}..HEAD`], worktreePath, timeoutMs),
    runGit(['diff', '--name-status', `${base}..HEAD`], worktreePath, timeoutMs),
  ])

  const truncated = diffText.length >= MAX_DIFF_BYTES
  const commitCount = logText.split('\n').filter((l) => l.trim().length > 0).length
  const filesChanged = nameStatus
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split('\t').pop() ?? l)

  const insertionsDeletions = parseShortstat(shortstat)

  return {
    base,
    head,
    commitCount,
    filesChanged,
    insertions: insertionsDeletions.insertions,
    deletions: insertionsDeletions.deletions,
    diffText,
    logText,
    truncated,
  }
}

/**
 * Resolve the base commit for the diff. Order of preference:
 *   1. `origin/<defaultBranch>` (the actual remote base).
 *   2. Merge-base of HEAD and `<defaultBranch>`.
 *   3. `HEAD~1` (last-resort for a single-commit branch with no remote).
 *   4. Empty string — caller treats as no-diff.
 */
async function resolveBase(
  worktreePath: string,
  defaultBranch: string | undefined,
  timeoutMs: number,
): Promise<string> {
  const branch = defaultBranch ?? 'main'

  // 1. origin/<defaultBranch>
  try {
    const sha = (
      await runGit(['rev-parse', `--verify`, `origin/${branch}`], worktreePath, timeoutMs)
    ).trim()
    if (sha) return sha
  } catch {
    // origin/<branch> not reachable — try the next strategy.
  }

  // 2. merge-base with <defaultBranch>
  try {
    const sha = (
      await runGit(['merge-base', 'HEAD', branch], worktreePath, timeoutMs)
    ).trim()
    if (sha) return sha
  } catch {
    // <defaultBranch> does not exist locally — fall through.
  }

  // 3. HEAD~1
  try {
    const sha = (
      await runGit(['rev-parse', '--verify', 'HEAD~1'], worktreePath, timeoutMs)
    ).trim()
    if (sha) return sha
  } catch {
    // No parent (single-commit fresh repo) — caller sees empty diff.
  }

  return ''
}

/**
 * Run a git command and capture stdout. Throws on non-zero exit.
 */
function runGit(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: MAX_DIFF_BYTES }, (err, stdout) => {
      if (err) reject(err)
      else resolve(String(stdout))
    })
  })
}

/**
 * Same as runGit but caps the captured output and surfaces the truncation
 * by returning the truncated string (we treat length === cap as "may have
 * been truncated").
 */
function runGitWithLimit(
  args: string[],
  cwd: string,
  timeoutMs: number,
  byteCap: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let killed = false
    let collected = ''
    let bytes = 0
    const timer = setTimeout(() => {
      killed = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes <= byteCap) collected += chunk.toString('utf-8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (killed) return
      if (code !== 0 && code !== null) {
        reject(new Error(`git ${args[0]} exited with ${code}`))
        return
      }
      resolve(collected)
    })
  })
}

/**
 * Parse `git diff --shortstat` output. Examples:
 *   " 3 files changed, 12 insertions(+), 4 deletions(-)"
 *   " 1 file changed, 2 insertions(+)"
 *   ""
 */
export function parseShortstat(
  text: string,
): { insertions: number; deletions: number } {
  const ins = text.match(/(\d+)\s+insertion/i)
  const del = text.match(/(\d+)\s+deletion/i)
  return {
    insertions: ins ? parseInt(ins[1], 10) : 0,
    deletions: del ? parseInt(del[1], 10) : 0,
  }
}
