/**
 * DeliveryTask — Tier-2 delivery loop (design §2.1 ③④).
 *
 * Owns the delivery tail for one story:
 *
 *   delivery_ready ──③ createOrReuseMR──► (persist mrIid/mrUrl)
 *                  ──④ syncTapd(评审中)──► mr_opened
 *
 * Trigger model (design §7.1): this service polls `delivery_ready`
 * stories on a timer. Each tick re-checks the idempotency checkpoints
 * (`pushedSha` / `mrIid` / `tapdSyncedAt`) so a story that already
 * created its MR or synced TAPD is skipped or re-used, never duplicated.
 *
 * The delivery gate is `pushedSha`: the Tier-1 runner only writes it when
 * git was present AND the push succeeded. A story without it has no git
 * binding, so `delivery_ready` is its final state and this task skips it
 * (design §1.3 / §2.1 ③ "无 git → 跳过交付").
 *
 * MR reviewer / target branch come from the per-workspace delivery
 * config (`ModuleConfigSchema.targetBranch` / `.reviewer`), falling back
 * to `defaultBranch` when unset (design §2.1 ③ "按 workspace 配 reviewer
 * / 目标分支").
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config, ModuleConfig } from '../config.js'
import type { AutoRdStorage } from '../domain/storage.js'
import type { StoryRecord } from '../domain/schema.js'
import type { Logger } from '../utils/logger.js'
import type { CredentialsService } from '../types/dsh-services.js'
import {
  resolveGitlabToken,
  resolveTapdToken,
} from '../domain/credentials.js'
import { HttpClient } from '../utils/http-client.js'
import {
  createOrReuseMR,
  buildMRDescription,
  projectIdFromRepoUrl,
} from './gitlab-merger.js'
import { syncTapd } from './tapd-poller.js'
import type { TrajectoryRecorder } from './trajectory.js'

export interface DeliveryTaskDeps {
  storage: AutoRdStorage
  logger: Logger
  config: Config
  credentials?: CredentialsService
  httpClient?: HttpClient
  trajectory?: TrajectoryRecorder
}

const POLL_INTERVAL_MS = 30_000

export class DeliveryTask {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly httpClient: HttpClient

  constructor(private readonly ctx: Context, private readonly deps: DeliveryTaskDeps) {
    this.httpClient = deps.httpClient ?? new HttpClient({ tag: 'auto-rd-delivery' })
  }

  start(): void {
    if (this.timer) return
    this.deps.logger.info('DeliveryTask starting')
    void this.tick()
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    try {
      for (const story of this.deps.storage.stories().values()) {
        if (story.state !== 'delivery_ready') continue
        const m = this.deps.config.modules.find((x) => x.id === story.moduleId)
        if (!m) {
          this.deps.logger.warn(
            `DeliveryTask: story ${story.id} references unknown module ${story.moduleId}; skipping`,
          )
          continue
        }
        await this.deliver(story, m)
      }
    } catch (err) {
      this.deps.logger.error(`DeliveryTask tick failed: ${(err as Error).message}`)
    }
  }

  private async deliver(story: StoryRecord, m: ModuleConfig): Promise<void> {
    // Delivery gate: only stories that were actually pushed (git present)
    // get an MR. `delivery_ready` without a push is already final.
    if (!story.pushedSha || !story.branch) {
      this.deps.logger.debug(
        `DeliveryTask: story ${story.id} has no pushedSha — no git, delivery_ready is final`,
      )
      return
    }

    const gitlabResolution = await resolveGitlabToken(
      this.deps.credentials,
      story.moduleId,
    )
    if (!gitlabResolution) {
      this.deps.logger.warn(
        `DeliveryTask: story ${story.id} has no GitLab token — will retry next tick`,
      )
      return
    }

    const targetBranch = (m.targetBranch || '').trim() || m.defaultBranch
    const reviewerIds = parseReviewerIds(m.reviewer)
    const description = buildMRDescription(story, story.description)

    // ③ deliver — create or reuse the MR (idempotent across restarts).
    let mr: { mrIid: number; webUrl: string; reused: boolean }
    if (story.mrIid !== undefined && story.mrUrl) {
      // Already delivered in a previous tick — reuse the persisted result.
      mr = { mrIid: story.mrIid, webUrl: story.mrUrl, reused: true }
    } else {
      mr = await createOrReuseMR(
        { httpClient: this.httpClient, logger: this.deps.logger },
        {
          gitlabBaseUrl: this.deps.config.gitlabBaseUrl,
          gitlabApiToken: gitlabResolution.value,
          projectId: projectIdFromRepoUrl(m.repoUrl),
          sourceBranch: story.branch,
          targetBranch,
          title: story.title,
          description,
          reviewerIds,
        },
      )
      story.mrIid = mr.mrIid
      story.mrUrl = mr.webUrl
      story.mrReused = mr.reused
      story.mrCreatedAt = new Date().toISOString()
      await this.deps.storage.stories().put(story.id, story)
      if (this.deps.trajectory) {
        void this.deps.trajectory.append({
          storyId: story.id,
          kind: 'external_side_effect',
          label: `MR ${mr.reused ? 'reused' : 'created'} !${mr.mrIid}`,
          payload: { mrIid: mr.mrIid, webUrl: mr.webUrl, reused: mr.reused },
        })
      }
    }

    // ④ advance — sync TAPD to 评审中 + link, then mr_opened.
    const tapdResolution = await resolveTapdToken(
      this.deps.credentials,
      story.moduleId,
    )
    if (tapdResolution) {
      try {
        await syncTapd({
          tapdBaseUrl: this.deps.config.tapdBaseUrl,
          tapdApiToken: tapdResolution.value,
          tapdId: story.tapdId,
          mrUrl: mr.webUrl,
          gitBranch: story.branch,
          status: '评审中',
          httpClient: this.httpClient,
        })
        story.tapdSyncedAt = new Date().toISOString()
      } catch (err) {
        // Transient TAPD failure — bounded retry, not a story failure.
        story.tapdSyncAttempts = (story.tapdSyncAttempts ?? 0) + 1
        await this.deps.storage.stories().put(story.id, story)
        this.deps.logger.warn(
          `DeliveryTask: story ${story.id} TAPD sync failed (attempt ${story.tapdSyncAttempts}): ${(err as Error).message} — will retry next tick`,
        )
        return
      }
    } else {
      // No TAPD identity (chat mode / no token): nothing to advance, the
      // MR is the deliverable. Fall through to mr_opened.
      this.deps.logger.info(
        `DeliveryTask: story ${story.id} has no TAPD token — skipping TAPD advance`,
      )
    }

    story.state = 'mr_opened'
    story.updatedAt = new Date().toISOString()
    await this.deps.storage.stories().put(story.id, story)
    if (this.deps.trajectory) {
      void this.deps.trajectory.append({
        storyId: story.id,
        kind: 'state_transition',
        label: 'delivery_ready → mr_opened',
        payload: { from: 'delivery_ready', to: 'mr_opened', mrIid: mr.mrIid },
      })
    }
    this.deps.logger.info(
      `DeliveryTask: story ${story.id} delivered — MR !${mr.mrIid}, state=mr_opened`,
    )
  }
}

/** Parse the comma-separated `reviewer` config into numeric ids, dropping junk. */
function parseReviewerIds(raw: string | undefined): number[] | undefined {
  if (!raw || raw.trim() === '') return undefined
  const ids = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  return ids.length > 0 ? ids : undefined
}
