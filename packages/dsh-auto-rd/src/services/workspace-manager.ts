/**
 * WorkspaceManager — owns the lifecycle of module workspaces and story worktrees.
 *
 * Per-module workspace: `workspaceRoot/<moduleId>/` (one git clone of the module repo)
 * Per-story worktree: `workspaceRoot/<moduleId>/.auto-rd/worktrees/<storyId>/`
 *
 * Borrowed from obra/using-git-worktrees W-1 (Detect Isolation), W-2 (Native Tools First),
 * W-3 (Verify Clean Baseline).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config.js'
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'

const exec = promisify(execFile)

export interface WorkspaceManagerDeps {
  storage: AutoRdStorage
  logger: Logger
  config: Config
}

export class WorkspaceManager {
  constructor(private readonly ctx: Context, private readonly deps: WorkspaceManagerDeps) {}

  /**
   * Ensure a module workspace exists at workspaceRoot/<moduleId>/.
   * Idempotent: skips if the directory is already a git repo.
   */
  async ensureModuleWorkspace(moduleId: string): Promise<string> {
    const module = this.deps.storage.modules().get(moduleId)
    if (!module) throw new Error(`Unknown module: ${moduleId}`)

    const path = module.workspacePath
    if (existsSync(join(path, '.git'))) {
      this.deps.logger.debug(`module workspace exists: ${path}`)
      return path
    }

    mkdirSync(path, { recursive: true })
    this.deps.logger.info(`cloning ${module.repoUrl} -> ${path}`)
    await exec('git', ['clone', '--branch', module.defaultBranch, module.repoUrl, path])

    return path
  }

  /**
   * Create (or attach to) a per-story git worktree off the module's default branch.
   *
   * Idempotent on retry: if the worktree already exists and is on the right
   * branch, returns its path without recreation.
   */
  async ensureStoryWorktree(storyId: string, moduleId: string): Promise<string> {
    const module = this.deps.storage.modules().get(moduleId)
    if (!module) throw new Error(`Unknown module: ${moduleId}`)
    const story = this.deps.storage.stories().get(storyId)
    if (!story) throw new Error(`Unknown story: ${storyId}`)

    const worktreesRoot = join(module.workspacePath, '.auto-rd', 'worktrees')
    const worktreePath = resolve(worktreesRoot, storyId)
    mkdirSync(worktreesRoot, { recursive: true })

    if (existsSync(join(worktreePath, '.git'))) {
      this.deps.logger.debug(`story worktree exists: ${worktreePath}`)
      return worktreePath
    }

    // Branch may or may not exist locally; create it from origin/<defaultBranch> if missing.
    let branchExists = true
    try {
      await exec('git', ['-C', module.workspacePath, 'rev-parse', '--verify', story.branch])
    } catch {
      branchExists = false
    }

    if (!branchExists) {
      try {
        await exec('git', ['-C', module.workspacePath, 'fetch', 'origin', module.defaultBranch])
      } catch (err) {
        this.deps.logger.warn(`fetch origin/${module.defaultBranch} failed: ${(err as Error).message}`)
      }
      await exec('git', [
        '-C',
        module.workspacePath,
        'branch',
        story.branch,
        `origin/${module.defaultBranch}`,
      ])
    }

    this.deps.logger.info(`creating worktree ${story.branch} -> ${worktreePath}`)
    await exec('git', [
      '-C',
      module.workspacePath,
      'worktree',
      'add',
      worktreePath,
      story.branch,
    ])

    // Mark the story with the worktree path so future services can find it.
    story.worktreePath = worktreePath
    await this.deps.storage.stories().put(story.id, story)

    return worktreePath
  }

  /**
   * Create the per-story artifacts directory inside the worktree.
   * Agent personas write their reports here.
   */
  ensureArtifactsDir(worktreePath: string, storyId: string): string {
    const dir = join(worktreePath, '.auto-rd', 'stories', storyId, 'artifacts')
    mkdirSync(dir, { recursive: true })
    return dir
  }
}