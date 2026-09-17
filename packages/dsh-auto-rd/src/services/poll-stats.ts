/**
 * Per-workspace TAPD poll snapshot, kept in the runtime memory (never
 * persisted — a DSH restart clears it and recover re-runs anyway).
 *
 * The poller publishes one of these per configured module on every tick
 * (success or failure), so the panel can show "this workspace synced at
 * HH:MM, added N stories" instead of one global timestamp that hides
 * which of several workspaces actually advanced.
 */
export interface WorkspacePollStat {
  moduleId: string
  /** Last tick that attempted to fetch this module. */
  lastAttemptAt: Date | null
  /** Last tick that fetched this module without error. */
  lastSuccessAt: Date | null
  /** Error message from the last failed attempt; null when healthy. */
  lastError: string | null
  /** Stories newly enqueued on the last successful tick. */
  lastNewCount: number
}

/** Per-module outcome for one poller tick, reported to the host runtime. */
export interface PollResult {
  moduleId: string
  error: string | null
  /** Stories newly enqueued for this module on this tick. */
  newCount: number
}

/**
 * Live runtime stats shared by the poller (writer) and the panel route
 * (reader). `pollStats` is optional so legacy callers / tests that only
 * pass the three original fields keep compiling.
 */
export interface RuntimeStats {
  mountedAt: Date
  lastTapdPollAt: Date | null
  lastTapdError: string | null
  pollStats?: Map<string, WorkspacePollStat>
}
