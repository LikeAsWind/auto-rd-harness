/**
 * MrSweep — Tier-2 daily sweep (design §2.1 ⑤).
 *
 * Once per day (at/after 20:00 local time) scans every `mr_opened` story,
 * reads its GitLab MR `state`, and acts in three branches:
 *
 *   merged  → syncTapd('completed')     → story.state = completed
 *   closed  → revert TAPD + notify human → story.state = blocked (human)
 *   opened  → NOTHING (zero side effect) → keep mr_opened
 *
 * The `opened` branch is deliberately a no-op: no ledger write, no TAPD
 * call, no state change — the story is simply re-scanned tomorrow.
 *
 * Scheduling: DSH has no native cron, so we use a coarse timer plus a
 * `lastSweepDate` checkpoint: only when the local clock is at/after 20:00
 * AND the last sweep date differs from today do we run. Each branch is
 * idempotent on its own (merged→completed / closed→blocked are terminal,
 * opened is a no-op), so a restart that loses the in-memory checkpoint is
 * harmless — the next sweep re-checks and finds nothing new to do.
 *
 * "Revert" status on the closed branch: the target TAPD status is an open
 * design detail (§7.4 "回退到 TAPD 的哪个状态 + 通知谁,尚未定"). We
 * revert to `planning` as the minimal placeholder and mark the story
 * `blocked` for a human to decide; the existing StoryNotifierService
 * pings the user on `blocked`.
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
import { getMRState, projectIdFromRepoUrl } from './gitlab-merger.js'
import { syncTapd } from './tapd-poller.js'
import type { TrajectoryRecorder } from './trajectory.js'

export interface MrSweepDeps {
  storage: AutoRdStorage
  logger: Logger
  config: Config
  credentials?: CredentialsService
  httpClient?: HttpClient
  trajectory?: TrajectoryRecorder
}

const SWEEP_INTERVAL_MS = 30 * 60_000 // 30 min coarse timer
const SWEEP_HOUR = 20 // 20:00 local
const REVERT_TAPD_STATUS = 'planning' // §7.4 placeholder

export class MrSweep {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSweepDate: string | null = null
  private readonly httpClient: HttpClient

  constructor(private readonly ctx: Context, private readonly deps: MrSweepDeps) {
    this.httpClient = deps.httpClient ?? new HttpClient({ tag: 'auto-rd-mr-sweep' })
  }

  start(): void {
    if (this.timer) return
    this.deps.logger.info('MrSweep starting')
    void this.tick()
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async tick(): Promise<void> {
    const now = new Date()
    const today = todayKey(now)
    if (now.getHours() < SWEEP_HOUR || this.lastSweepDate === today) {
      return
    }
    // Claim today's sweep BEFORE the async work so a concurrent timer fire
    // cannot double-run it.
    this.lastSweepDate = today
    this.deps.logger.info(`MrSweep running daily sweep for ${today}`)

    try {
      for (const story of this.deps.storage.stories().values()) {
        if (story.state !== 'mr_opened') continue
        const m = this.deps.config.modules.find((x) => x.id === story.moduleId)
        if (!m) {
          this.deps.logger.warn(`MrSweep: story ${story.id} references unknown module ${story.moduleId}; skipping`)
          continue
        }
        await this.sweepStory(story, m)
      }
    } catch (err) {
      this.deps.logger.error(`MrSweep tick failed: ${(err as Error).message}`)
    }
  }

  private async sweepStory(story: StoryRecord, m: ModuleConfig): Promise<void> {
    if (story.mrIid === undefined || !story.mrUrl) {
      this.deps.logger.warn(`MrSweep: story ${story.id} is mr_opened but has no mrIid/mrUrl; leaving as-is`)
      return
    }

    const gitlabResolution = await resolveGitlabToken(
      this.deps.credentials,
      story.moduleId,
    )
    if (!gitlabResolution) {
      this.deps.logger.warn(`MrSweep: story ${story.id} has no GitLab token — will re-check tomorrow`)
      return
    }

    const state = await getMRState(
      { httpClient: this.httpClient, logger: this.deps.logger },
      {
        gitlabBaseUrl: this.deps.config.gitlabBaseUrl,
        gitlabApiToken: gitlabResolution.value,
        projectId: projectIdFromRepoUrl(m.repoUrl),
        mrIid: story.mrIid,
      },
    )

    if (state === 'merged') {
      await this.closeMerged(story)
    } else if (state === 'closed') {
      await this.handleClosed(story)
    } else {
      // opened, or MR gone upstream (null) — zero side effect, keep mr_opened.
      if (state === null) {
        this.deps.logger.warn(
          `MrSweep: story ${story.id} MR !${story.mrIid} no longer exists upstream; keeping mr_opened`,
        )
      }
      // opened: deliberately nothing.
    }
  }

  private async closeMerged(story: StoryRecord): Promise<void> {
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
          mrUrl: story.mrUrl ?? '',
          gitBranch: story.branch,
          status: 'completed',
          httpClient: this.httpClient,
        })
      } catch (err) {
        this.deps.logger.warn(
          `MrSweep: story ${story.id} TAPD close failed: ${(err as Error).message} — will re-sweep tomorrow`,
        )
        return
      }
    }

    story.state = 'completed'
    story.updatedAt = new Date().toISOString()
    await this.deps.storage.stories().put(story.id, story)
    if (this.deps.trajectory) {
      void this.deps.trajectory.append({
        storyId: story.id,
        kind: 'state_transition',
        label: 'mr_opened → completed (merged)',
        payload: { from: 'mr_opened', to: 'completed', mrIid: story.mrIid },
      })
    }
    this.deps.logger.info(`MrSweep: story ${story.id} MR merged — completed`)
  }

  private async handleClosed(story: StoryRecord): Promise<void> {
    // Revert TAPD back to the planning backlog (status placeholder per §7.4).
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
          mrUrl: story.mrUrl ?? '',
          gitBranch: story.branch,
          status: REVERT_TAPD_STATUS,
          httpClient: this.httpClient,
        })
      } catch (err) {
        // The revert failed; still mark for human handling so the block is
        // visible, and let the notifier carry the reason.
        this.deps.logger.warn(
          `MrSweep: story ${story.id} TAPD revert failed: ${(err as Error).message}`,
        )
      }
    }

    story.state = 'blocked'
    story.blockedReason =
      'sweep: MR closed without merge — human handling required (TAPD reverted)'
    story.updatedAt = new Date().toISOString()
    await this.deps.storage.stories().put(story.id, story)
    if (this.deps.trajectory) {
      void this.deps.trajectory.append({
        storyId: story.id,
        kind: 'state_transition',
        label: 'mr_opened → blocked (MR closed, unmerged)',
        payload: { from: 'mr_opened', to: 'blocked', mrIid: story.mrIid },
      })
    }
    this.deps.logger.info(`MrSweep: story ${story.id} MR closed unmerged — blocked for human`)
  }
}

/** Local-date key `YYYY-MM-DD` for the daily sweep checkpoint. */
function todayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
