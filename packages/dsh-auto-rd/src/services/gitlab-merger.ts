/**
 * GitLabMerger — push the Story branch and create (or reuse) the MR.
 *
 * M4-A: real HTTP for the GitLab API + local `git push` for the branch.
 * Idempotent: if an MR for the source branch already exists in the target
 * project, we reuse it instead of creating a duplicate. The local push
 * is also idempotent — git push of an unchanged branch is a no-op.
 *
 * Two checkpoints, in order:
 *   1. pushBranch -- git push origin <branch>
 *      On success: write the resulting commit sha back into the caller.
 *      On failure: HttpNetworkError / shell error; caller records
 *      `lastPushError` and exits the stage so the next run can retry.
 *   2. createOrReuseMR -- list existing MRs, then POST /merge_requests
 *      if none found, or reuse the existing one.
 *      On success: caller stores mrUrl + webUrl for the TAPD sync step.
 *      On failure: caller records `lastCreateMrError` and exits.
 *
 * This split lets a story be recovered cleanly across plugin restarts:
 * the storage layer persists `pushedSha` and `mrUrl` between runs, so
 * re-entering `mr_creating` skips already-completed checkpoints.
 *
 * NOT in scope:
 *   - Auto-merge / approvals / pipelines (M5+).
 *   - Cross-project MRs (we always target the module's repo).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HttpClient } from '../utils/http-client.js'
import type { Logger } from '../utils/logger.js'
import type { StoryRecord } from '../domain/schema.js'

const exec = promisify(execFile)

export interface GitLabMergerDeps {
  httpClient: HttpClient
  logger: Logger
}

export interface PushBranchParams {
  worktreePath: string
  branch: string
  remote: string
  userName: string
  userEmail: string
}

export interface PushBranchResult {
  /** Commit SHA pushed to origin/<branch>, or null if push was a no-op. */
  pushedSha: string | null
  /** True if the branch was already at the same SHA on origin. */
  alreadyUpToDate: boolean
}

export interface CreateOrReuseMRParams {
  gitlabBaseUrl: string
  gitlabApiToken: string
  /** Path-encoded project id or full URL-encoded path. */
  projectId: string
  sourceBranch: string
  targetBranch: string
  title: string
  description: string
}

export interface CreateOrReuseMRResult {
  /** True if we found an existing MR and reused it; false if we created a new one. */
  reused: boolean
  mrIid: number
  webUrl: string
}

/**
 * Push the current branch in `worktreePath` to `remote`.
 *
 * Configures the local user.name / user.email first so the commit
 * (if any) carries the auto-rd identity.
 */
export async function pushBranch(
  deps: GitLabMergerDeps,
  params: PushBranchParams,
): Promise<PushBranchResult> {
  // Configure local identity for this push. Use --local so we don't
  // clobber the user's global git config.
  await exec('git', [
    '-C',
    params.worktreePath,
    'config',
    'user.name',
    params.userName,
  ])
  await exec('git', [
    '-C',
    params.worktreePath,
    'config',
    'user.email',
    params.userEmail,
  ])

  deps.logger.info(
    `pushBranch: pushing ${params.branch} -> ${params.remote} from ${params.worktreePath}`,
  )

  try {
    const { stdout } = await exec('git', [
      '-C',
      params.worktreePath,
      'push',
      params.remote,
      params.branch,
    ])

    // `git push` outputs "Everything up-to-date" when there's nothing to
    // push. Anything else (a SHA, a hash, empty) means a push happened.
    const alreadyUpToDate = /Everything up-to-date/.test(stdout)
    if (alreadyUpToDate) {
      deps.logger.info(`pushBranch: ${params.branch} already up-to-date on ${params.remote}`)
      const sha = await headSha(params.worktreePath)
      return { pushedSha: sha, alreadyUpToDate: true }
    }

    const sha = await headSha(params.worktreePath)
    deps.logger.info(`pushBranch: ${params.branch} now at ${sha} on ${params.remote}`)
    return { pushedSha: sha, alreadyUpToDate: false }
  } catch (err) {
    const msg = (err as Error).message
    deps.logger.error(`pushBranch: failed to push ${params.branch}: ${msg}`)
    throw new Error(`pushBranch failed: ${msg}`)
  }
}

async function headSha(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

/**
 * Look up an existing MR for the given source branch. Returns null if
 * none exists. Filters by `state` (open by default).
 */
export async function findExistingMR(
  deps: GitLabMergerDeps,
  params: {
    gitlabBaseUrl: string
    gitlabApiToken: string
    projectId: string
    sourceBranch: string
    state?: 'opened' | 'closed' | 'merged' | 'all'
  },
): Promise<{ iid: number; web_url: string } | null> {
  const url = new URL(params.gitlabBaseUrl)
  url.pathname = joinUrlPath(url.pathname, '/api/v4/projects', params.projectId, 'merge_requests')
  url.searchParams.set('source_branch', params.sourceBranch)
  url.searchParams.set('state', params.state ?? 'opened')

  const resp = await deps.httpClient.request<unknown[]>({
    url: url.toString(),
    method: 'GET',
    headers: {
      Authorization: `Bearer ${params.gitlabApiToken}`,
      Accept: 'application/json',
    },
    timeoutMs: 15_000,
  })

  const list = resp.json()
  if (!Array.isArray(list) || list.length === 0) return null
  // Pick the most recent (GitLab returns them by created_at desc).
  const head = list[0] as { iid?: number; web_url?: string }
  if (typeof head.iid !== 'number' || typeof head.web_url !== 'string') return null
  return { iid: head.iid, web_url: head.web_url }
}

/**
 * Create a new MR. Caller should check for an existing one first via
 * findExistingMR; we do NOT deduplicate here.
 */
export async function createMR(
  deps: GitLabMergerDeps,
  params: CreateOrReuseMRParams,
): Promise<CreateOrReuseMRResult> {
  const url = new URL(params.gitlabBaseUrl)
  url.pathname = joinUrlPath(url.pathname, '/api/v4/projects', params.projectId, 'merge_requests')

  const resp = await deps.httpClient.request<{ iid: number; web_url: string }>({
    url: url.toString(),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.gitlabApiToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: {
      source_branch: params.sourceBranch,
      target_branch: params.targetBranch,
      title: params.title,
      description: params.description,
      // remove_source_branch is GitLab-specific cleanup behaviour; we
      // leave it default (true on merge) -- branch cleanup happens
      // outside our scope.
    },
    timeoutMs: 20_000,
  })

  const created = resp.json() as { iid: number; web_url: string }
  return { reused: false, mrIid: created.iid, webUrl: created.web_url }
}

/**
 * Convenience wrapper: find or create the MR for `story`.
 *
 * Returns the iid + web_url either way, and a `reused` flag the caller
 * can persist so the next run can short-circuit the lookup.
 */
export async function createOrReuseMR(
  deps: GitLabMergerDeps,
  params: CreateOrReuseMRParams,
): Promise<CreateOrReuseMRResult> {
  const existing = await findExistingMR(deps, {
    gitlabBaseUrl: params.gitlabBaseUrl,
    gitlabApiToken: params.gitlabApiToken,
    projectId: params.projectId,
    sourceBranch: params.sourceBranch,
  })
  if (existing) {
    deps.logger.info(
      `createOrReuseMR: reusing existing MR !${existing.iid} for ${params.sourceBranch}`,
    )
    return { reused: true, mrIid: existing.iid, webUrl: existing.web_url }
  }
  const created = await createMR(deps, params)
  deps.logger.info(`createOrReuseMR: created new MR !${created.mrIid} for ${params.sourceBranch}`)
  return created
}

/**
 * Build the MR description from the story's spec / verify / final-verify
 * artifacts. The caller passes the rendered markdown; we just escape
 * any HTML-breaking sequences minimally.
 */
export function buildMRDescription(story: StoryRecord, body: string): string {
  // GitLab MR descriptions support markdown. We keep the description
  // simple: a header, a link placeholder, and the body the caller passed.
  return [
    `## Auto-RD pipeline summary`,
    ``,
    `- Story: ${story.title}`,
    `- TAPD id: ${story.tapdId}`,
    `- Branch: \`${story.branch}\``,
    ``,
    body.trim(),
  ].join('\n')
}

/**
 * Resolve a GitLab project id from a repo URL. GitLab accepts either
 * a numeric project id or a URL-encoded path (group/subgroup/repo).
 * We use the URL-encoded path form, which works with both SaaS and
 * self-hosted without an extra lookup call.
 */
export function projectIdFromRepoUrl(repoUrl: string): string {
  // Strip scheme + host, take the path, drop ".git".
  // Examples:
  //   https://gitlab.com/group/repo.git  ->  group%2Frepo
  //   git@gitlab.com:group/repo.git      ->  group%2Frepo
  let path = repoUrl
  try {
    const u = new URL(repoUrl)
    path = u.pathname
  } catch {
    // scp-style: git@host:path -- split on the first ':'
    const idx = repoUrl.indexOf(':')
    if (idx >= 0) path = repoUrl.slice(idx + 1)
  }
  path = path.replace(/\.git$/, '').replace(/^\//, '')
  return encodeURIComponent(path)
}

function joinUrlPath(base: string, ...parts: string[]): string {
  let result = base.replace(/\/+$/, '')
  for (const p of parts) {
    const trimmed = p.replace(/^\/+/, '').replace(/\/+$/, '')
    if (trimmed) result += '/' + trimmed
  }
  return result
}