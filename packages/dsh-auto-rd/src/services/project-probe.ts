/**
 * ProjectProbe —real inspection of a Story worktree.
 *
 * The ContextAgent is the first stage of the pipeline and its job is
 * "know what you are about to change": which package manager, which
 * install / test / build commands, what the codebase looks like, and
 * whether the baseline is green. Before this module the ContextAgent
 * emitted a fixed template whose baseline section read
 * "Result: N/N passing (stub)".
 *
 * This probe performs all of that deterministically. The model layer
 * (when attached) contributes judgement —reading the codebase map and
 * deciding where the change belongs —but the facts come from here.
 *
 * Public surface:
 *   - probeProject(worktreePath) -> ProjectProbeResult
 *
 * Everything is bounded:
 *   - The directory walk has a depth limit and a file-count cap.
 *   - `node_modules`, `.git`, `dist`, `build`, `target`, `.venv` and
 *     friends are skipped so a fresh clone does not blow the budget.
 *   - Nothing throws; a failure surfaces through `error`.
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, extname } from 'node:path'

/** Max directory depth for the source walk. */
const MAX_WALK_DEPTH = 4
/** Max files counted before the walk short-circuits. */
const MAX_WALK_FILES = 5_000
/** Max relative paths retained in `sourceFiles`. */
const MAX_LISTED_FILES = 300

/** Directories that are never part of "the codebase" for our purposes. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  '.auto-rd',
])

/** Manifest filenames we surface verbatim. */
const MANIFEST_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'tsconfig.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
  'pytest.ini',
  'setup.py',
  'Makefile',
  'Dockerfile',
  'README.md',
]

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface ProjectProbeResult {
  worktreePath: string
  isGitRepo: boolean
  headSha: string | null
  branch: string | null
  packageManager: PackageManager | null
  /** e.g. "pnpm install --frozen-lockfile" */
  installCommand: string | null
  /** e.g. "pnpm test" —null when the project defines no test script. */
  testCommand: string | null
  /** e.g. "pnpm run build" —null when there is no build script. */
  buildCommand: string | null
  /** Manifests found at the worktree root. */
  manifests: string[]
  /** Top-level directories (ignored dirs removed), sorted. */
  topLevelDirs: string[]
  /** Top-level files (ignored dirs removed), sorted. */
  topLevelFiles: string[]
  /** Files counted by extension, e.g. { '.ts': 42, '.tsx': 7, '.json': 3 } */
  languageBreakdown: Record<string, number>
  /**
   * Total files walked, across every extension (manifests and
   * lockfiles included). Deliberately named `fileCount` rather than
   * `sourceFileCount`: the walk does not attempt to decide what counts
   * as "source", and the language breakdown is the signal for that.
   */
  fileCount: number
  /**
   * Relative paths of up to MAX_LISTED_FILES walked files, sorted.
   * Capped so the probe stays cheap on a large repo; consumers that
   * need "does a similarly named file already exist?" use this.
   */
  sourceFiles: string[]
  /** True when the walk hit MAX_WALK_FILES and stopped early. */
  walkTruncated: boolean
  error?: string
}

/**
 * Probe the worktree. Never throws; failures come back through `error`.
 */
export function probeProject(worktreePath: string): ProjectProbeResult {
  const base: ProjectProbeResult = {
    worktreePath,
    isGitRepo: false,
    headSha: null,
    branch: null,
    packageManager: null,
    installCommand: null,
    testCommand: null,
    buildCommand: null,
    manifests: [],
    topLevelDirs: [],
    topLevelFiles: [],
    languageBreakdown: {},
    fileCount: 0,
    sourceFiles: [],
    walkTruncated: false,
  }

  if (!existsSync(worktreePath)) {
    return { ...base, error: `worktree path does not exist: ${worktreePath}` }
  }

  try {
    const stat = statSync(worktreePath)
    if (!stat.isDirectory()) {
      return { ...base, error: `worktree path is not a directory: ${worktreePath}` }
    }
  } catch (err) {
    return { ...base, error: `cannot stat worktree: ${(err as Error).message}` }
  }

  base.isGitRepo = existsSync(join(worktreePath, '.git'))
  base.headSha = readGitHead(worktreePath)
  base.branch = readGitBranch(worktreePath)

  // ---- Manifests + top-level layout ----
  let entries: string[] = []
  try {
    entries = readdirSync(worktreePath)
  } catch (err) {
    return { ...base, error: `cannot read worktree root: ${(err as Error).message}` }
  }

  base.manifests = MANIFEST_FILES.filter((m) => entries.includes(m))

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue
    if (entry.startsWith('.') && entry !== '.github') continue
    try {
      const full = join(worktreePath, entry)
      if (statSync(full).isDirectory()) base.topLevelDirs.push(entry)
      else base.topLevelFiles.push(entry)
    } catch {
      // Unreadable entry —skip it rather than fail the whole probe.
    }
  }
  base.topLevelDirs.sort()
  base.topLevelFiles.sort()

  // ---- Package manager + command detection ----
  const pkg = readJsonSafe(join(worktreePath, 'package.json'))
  const pm = detectPackageManager(entries, pkg)
  base.packageManager = pm
  base.installCommand = buildInstallCommand(pm)
  base.testCommand = buildScriptCommand(pm, pkg, 'test')
  base.buildCommand = buildScriptCommand(pm, pkg, 'build')

  // ---- Source walk ----
  const walk = countFiles(worktreePath)
  base.languageBreakdown = walk.breakdown
  base.fileCount = walk.total
  base.sourceFiles = walk.paths
  base.walkTruncated = walk.truncated

  return base
}

// ---- internal helpers ----

function readGitHead(worktreePath: string): string | null {
  if (!existsSync(join(worktreePath, '.git'))) return null
  try {
    // A worktree's `.git` is a FILE containing "gitdir: <path>"; a
    // normal clone's `.git` is a directory. Asking git itself is the
    // only fully reliable route across both layouts.
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim()
  } catch {
    return null
  }
}

function readGitBranch(worktreePath: string): string | null {
  if (!existsSync(join(worktreePath, '.git'))) return null
  try {
    const out = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim()
    return out === 'HEAD' ? null : out
  } catch {
    return null
  }
}

function readJsonSafe(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Determine the package manager from lockfiles, then `packageManager`
 * field, then the default (npm).
 */
export function detectPackageManager(
  entries: string[],
  pkg?: Record<string, unknown> | null,
): PackageManager | null {
  if (!entries.includes('package.json') && !entries.includes('pnpm-lock.yaml')) {
    // Not a Node project at all unless a lockfile is present.
    if (!entries.includes('yarn.lock') && !entries.includes('bun.lockb')) return null
  }
  if (entries.includes('pnpm-lock.yaml')) return 'pnpm'
  if (entries.includes('yarn.lock')) return 'yarn'
  if (entries.includes('bun.lockb')) return 'bun'

  // The `packageManager` field outranks a bare package-lock.json
  // (corepack uses it as the source of truth).
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager : ''
  if (declared.startsWith('pnpm@')) return 'pnpm'
  if (declared.startsWith('yarn@')) return 'yarn'
  if (declared.startsWith('bun@')) return 'bun'
  if (declared.startsWith('npm@')) return 'npm'

  if (entries.includes('package.json')) return 'npm'
  return null
}

function buildInstallCommand(pm: PackageManager | null): string | null {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile'
    case 'yarn':
      return 'yarn install --frozen-lockfile'
    case 'bun':
      return 'bun install'
    case 'npm':
      return 'npm ci'
    default:
      return null
  }
}

/**
 * Build `<pm> test` / `<pm> run build`, but only when the script
 * actually exists —otherwise we would advertise a command that fails.
 */
function buildScriptCommand(
  pm: PackageManager | null,
  pkg: Record<string, unknown> | null,
  script: 'test' | 'build',
): string | null {
  if (!pm || !pkg) return null
  const scripts = pkg.scripts as Record<string, unknown> | undefined
  const value = scripts?.[script]
  if (typeof value !== 'string' || value.trim().length === 0) return null
  if (pm === 'npm') return script === 'test' ? 'npm test' : 'npm run build'
  return `${pm} ${script}`
}

interface FileWalk {
  breakdown: Record<string, number>
  total: number
  /** Relative paths, capped at MAX_LISTED_FILES, sorted. */
  paths: string[]
  truncated: boolean
}

/**
 * Bounded recursive walk counting source files by extension.
 * Directories in IGNORED_DIRS are skipped; depth and file count are
 * capped so a huge repo cannot stall the Context stage.
 */
function countFiles(root: string): FileWalk {
  const breakdown: Record<string, number> = {}
  const paths: string[] = []
  let total = 0
  let truncated = false

  const walk = (dir: string, depth: number, prefix: string): void => {
    if (truncated || depth > MAX_WALK_DEPTH) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.startsWith('.') || IGNORED_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let isDir: boolean
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      const relative = prefix ? `${prefix}/${entry}` : entry
      if (isDir) {
        walk(full, depth + 1, relative)
        continue
      }
      if (total >= MAX_WALK_FILES) {
        truncated = true
        return
      }
      total += 1
      const ext = extname(entry).toLowerCase() || '(none)'
      breakdown[ext] = (breakdown[ext] ?? 0) + 1
      if (paths.length < MAX_LISTED_FILES) paths.push(relative)
    }
  }

  walk(root, 1, '')
  paths.sort()
  return { breakdown, total, paths, truncated }
}
