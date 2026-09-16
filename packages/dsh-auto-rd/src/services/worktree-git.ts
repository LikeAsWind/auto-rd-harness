/**
 * WorktreeGit — real git operations inside a Story worktree.
 *
 * The design doc requires that the Implementation stage actually
 * modifies the Story worktree (goal §4: "Implementation 应真实修改
 * Story worktree"). Before this module existed, the ImplementationAgent
 * handler wrote a markdown report whose COMMIT section said
 * `Hash: <stub>` — no commit ever landed on the branch, which meant the
 * downstream ReviewAgent's `git diff` had nothing to read and the pushed
 * branch never carried the "implementation".
 *
 * This module owns the deterministic half of that: inspecting the
 * worktree, staging the right paths, and creating a real commit. The
 * model (or a future deterministic code generator) owns the other half —
 * writing the actual file contents.
 *
 * Public surface:
 *   - head(worktreePath)                 -> current commit sha
 *   - status(worktreePath)               -> { branch, modified, untracked, clean }
 *   - stageAll(worktreePath)             -> git add -A
 *   - stageFiles(worktreePath, paths[])  -> git add -- <paths>
 *   - commitWorktreeChanges(...)         -> status + stage + commit, returns sha
 *   - isGitRepo(worktreePath)            -> boolean
 *
 * Everything is idempotent and never throws for the "nothing to commit"
 * case — that returns { committed: false, reason } so the caller can
 * decide whether an empty implementation is an error.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const DEFAULT_TIMEOUT_MS = 60_000

export interface WorktreeStatus {
  /** Current branch name, or empty string when detached. */
  branch: string
  /** Tracked files with unstaged modifications or deletions. */
  modified: string[]
  /** Files staged for the next commit. */
  staged: string[]
  /** Untracked (not ignored) files. */
  untracked: string[]
  /** True when there is nothing to commit. */
  clean: boolean
}

export interface CommitParams {
  worktreePath: string
  message: string
  /**
   * Explicit paths to stage. When omitted, everything is staged
   * (`git add -A`) — this is what the orchestrator wants for an
   * ImplementationAgent that just edited the worktree.
   */
  files?: string[]
  userName?: string
  userEmail?: string
  timeoutMs?: number
}

export interface CommitResult {
  /** False when the worktree had nothing to commit. */
  committed: boolean
  /** Commit sha after the operation (new commit, or HEAD when no-op). */
  sha: string | null
  /** Why the commit was skipped, when committed === false. */
  reason?: string
  /** The status snapshot taken *before* staging. */
  status: WorktreeStatus
}

/** True when `worktreePath` contains a `.git` file or directory. */
export function isGitRepo(worktreePath: string): boolean {
  return existsSync(join(worktreePath, '.git'))
}

/**
 * Current HEAD sha. Returns null when the worktree is not a git repo
 * or has no commits yet.
 */
export async function head(
  worktreePath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  if (!isGitRepo(worktreePath)) return null
  try {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      timeout: timeoutMs,
    })
    return String(stdout).trim() || null
  } catch {
    return null
  }
}

/**
 * Snapshot the worktree state. Uses porcelain output so we get stable,
 * machine-readable lines:
 *
 *   XY <path>
 *
 * where X is the index status and Y the worktree status. `??` means
 * untracked, `!!` means ignored (which we drop — `--porcelain` only
 * emits ignored entries with an explicit flag, so in practice we never
 * see them here).
 */
export async function status(
  worktreePath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<WorktreeStatus> {
  const empty: WorktreeStatus = {
    branch: '',
    modified: [],
    staged: [],
    untracked: [],
    clean: true,
  }
  if (!isGitRepo(worktreePath)) return empty

  try {
    const [{ stdout: branchOut }, { stdout: porcelain }] = await Promise.all([
      exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: worktreePath,
        timeout: timeoutMs,
      }),
      // `-uall` expands untracked directories into individual file
      // paths. Without it git collapses `src/new.ts` into `src/`, which
      // is useless for the implementation report (we want the actual
      // file list that landed in the commit).
      exec('git', ['status', '--porcelain', '-uall'], { cwd: worktreePath, timeout: timeoutMs }),
    ])

    const branch = String(branchOut).trim()
    const modified: string[] = []
    const staged: string[] = []
    const untracked: string[] = []

    for (const rawLine of String(porcelain).split('\n')) {
      if (rawLine.length < 4) continue
      const x = rawLine[0]
      const y = rawLine[1]
      // `git status --porcelain` quotes paths with special characters;
      // strip the surrounding quotes when present.
      let path = rawLine.slice(3)
      if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)

      if (x === '?' && y === '?') {
        untracked.push(path)
        continue
      }
      if (x !== ' ' && x !== '?') staged.push(path)
      if (y !== ' ' && y !== '?') modified.push(path)
    }

    const clean = modified.length === 0 && staged.length === 0 && untracked.length === 0
    return {
      branch: branch === 'HEAD' ? '' : branch,
      modified,
      staged,
      untracked,
      clean,
    }
  } catch {
    return empty
  }
}

/** `git add -A` — stage every change (modifications, deletions, new files). */
export async function stageAll(
  worktreePath: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  await exec('git', ['add', '-A'], { cwd: worktreePath, timeout: timeoutMs })
}

/**
 * `git add -- <paths...>` — stage an explicit list.
 *
 * Resilient by design: a plan often lists a file the implementation
 * layer did not end up creating (renamed, folded into another file, or
 * a typo). `git add` aborts the *whole* invocation with exit 128 when
 * any pathspec does not match, which would silently discard every
 * other file's changes. We therefore try the batch first and, on
 * failure, fall back to adding each path individually so one stale
 * entry cannot lose the rest.
 *
 * Returns the paths that were successfully staged.
 */
export async function stageFiles(
  worktreePath: string,
  paths: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  if (paths.length === 0) return []

  try {
    await exec('git', ['add', '--', ...paths], { cwd: worktreePath, timeout: timeoutMs })
    return [...paths]
  } catch {
    // Batch failed — most commonly a pathspec mismatch. Fall back to
    // per-path adds and keep whichever succeeded.
    const staged: string[] = []
    for (const p of paths) {
      try {
        await exec('git', ['add', '--', p], { cwd: worktreePath, timeout: timeoutMs })
        staged.push(p)
      } catch {
        // Stale/unknown path — skip it, keep going.
      }
    }
    return staged
  }
}

/**
 * Stage whatever the worktree has and create a real commit.
 *
 * Returns `{ committed: false, reason: 'nothing to commit' }` when the
 * worktree is clean — this is the common case for a replayed run, and
 * it must NOT be treated as an error.
 *
 * The commit identity is set locally (`git config user.name/email`
 * without `--global`) so we never mutate the operator's global git
 * config, matching the pushBranch behaviour in gitlab-merger.ts.
 */
export async function commitWorktreeChanges(params: CommitParams): Promise<CommitResult> {
  const {
    worktreePath,
    message,
    files,
    userName,
    userEmail,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params

  const before = await status(worktreePath, timeoutMs)
  if (!isGitRepo(worktreePath)) {
    return { committed: false, sha: null, reason: 'not a git worktree', status: before }
  }
  if (before.clean) {
    return { committed: false, sha: await head(worktreePath, timeoutMs), reason: 'nothing to commit', status: before }
  }

  // Local-only identity so the commit has a valid author without
  // touching the operator's global config.
  if (userName) {
    await exec('git', ['config', 'user.name', userName], { cwd: worktreePath, timeout: timeoutMs })
  }
  if (userEmail) {
    await exec('git', ['config', 'user.email', userEmail], { cwd: worktreePath, timeout: timeoutMs })
  }

  if (files && files.length > 0) {
    await stageFiles(worktreePath, files, timeoutMs)
  } else {
    await stageAll(worktreePath, timeoutMs)
  }

  // Re-check: an explicit `files` list might have staged nothing (e.g.
  // the paths did not exist). Don't create an empty commit.
  const stagedNow = await status(worktreePath, timeoutMs)
  if (stagedNow.staged.length === 0) {
    return {
      committed: false,
      sha: await head(worktreePath, timeoutMs),
      reason: 'nothing staged',
      status: stagedNow,
    }
  }

  try {
    await exec('git', ['commit', '--no-verify', '-m', message], {
      cwd: worktreePath,
      timeout: timeoutMs,
    })
  } catch (err) {
    // A blocked hook or a concurrent git lock are both recoverable by
    // the runner's next tick; surface the reason without throwing.
    return {
      committed: false,
      sha: await head(worktreePath, timeoutMs),
      reason: `git commit failed: ${(err as Error).message}`,
      status: before,
    }
  }

  // `status` describes the change that was committed, so we return the
  // pre-staging snapshot (what the worktree looked like when the
  // handler decided there was something to commit).
  return {
    committed: true,
    sha: await head(worktreePath, timeoutMs),
    status: before,
  }
}

/**
 * Build a Conventional Commits message from a Planner task's `commit`
 * payload. Falls back to a generic message when the planner did not
 * specify one.
 */
export function buildCommitMessage(
  commit: { type?: string; scope?: string; subject?: string } | undefined,
  fallbackSubject: string,
): string {
  const type = commit?.type?.trim() || 'feat'
  const scope = commit?.scope?.trim()
  const subject = commit?.subject?.trim() || fallbackSubject
  return scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`
}
