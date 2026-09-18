/**
 * Stage mapping — collapse the 19-state story machine into 4 user-visible
 * phases: 规格(spec)、计划(plan)、实现(implement)、验证(verify).
 *
 * Why a mapping at all: the storage layer distinguishes 19 states so the
 * pipeline can drive its own bookkeeping, but a user looking at the
 * sidebar wants to know "how far along is this story?", not which agent
 * is currently in its second checkpoint retry. Four buckets is the
 * smallest honest number — fewer collapses different work into one bar,
 * more just renames the agent names.
 *
 * Pipeline reference: docs/architecture/auto-rd-two-tier-pipeline.md §4.
 *
 *   - spec:    context, clarification, brainstorm, critic, decision, spec
 *   - plan:    planning
 *   - implement: implementing, testing, fixing
 *   - verify:  verifying, reviewing, final_verifying, delivery_ready
 *   - (terminal: completed, failed — handled separately)
 *   - (delivery tail: mr_opened — renders as a done verify phase)
 *   - (human pause: blocked — does not advance the bar)
 *   - (queue: pending — the bar is still on phase 0 / "未开始")
 *
 * Adding a new StoryState without extending this map is a test failure:
 * see the `STORY_STATES` exhaustive assertion in scripts/test-ui-panel.mjs.
 */
import type { StoryState } from './schema.js'

/** The four user-visible phases. Order matters: index = position on the gauge. */
export const STAGE_KEYS = ['spec', 'plan', 'implement', 'verify'] as const

export type StageKey = (typeof STAGE_KEYS)[number]

/** User-readable label for the gauge legend. Stable across light/dark themes. */
export const STAGE_LABELS: Record<StageKey, string> = {
  spec: '规格',
  plan: '计划',
  implement: '实现',
  verify: '验证',
}

/** Every StoryState belongs to exactly one phase — or is one of the three non-phase buckets. */
export type StageBucket = StageKey | 'pending' | 'blocked' | 'completed' | 'failed'

export interface StageView {
  /** Which phase the bar should highlight (null when there is nothing to advance to). */
  current: StageKey | null
  /** Number of ticks lit in `current`'s block (0..4). Sub-progress inside a phase. */
  filledInCurrent: number
  /**
   * Visual emphasis: distinct from current because `halt` paints the
   * remaining ticks in the active phase red — the user can see at a
   * glance "the work stopped here".
   */
  status: 'idle' | 'live' | 'halt' | 'done'
  /**
   * For `pending`: the bar's first block is partially filled so it
   * reads as "not started yet but queued", not as "nothing".
   * Always 0 once any state machine tick has happened.
   */
  pendingTicks: number
}

/**
 * Map a StoryState to its user-visible phase bucket.
 *
 * Returns one of:
 *   - a StageKey (the state is part of a running phase)
 *   - 'pending' / 'blocked' / 'completed' / 'failed' (the meta buckets)
 *
 * The pipeline can introduce new states; if a state is added without a
 * mapping entry the test suite fails — see scripts/test-ui-panel.mjs's
 * `STAGE_MAPPING_EXHAUSTIVE` assertion. That's intentional: silently
 * dropping a state means the bar lies about coverage.
 */
export function stateToBucket(state: StoryState): StageBucket {
  switch (state) {
    case 'pending':
      return 'pending'
    case 'blocked':
      return 'blocked'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'mr_opened':
      return 'completed'
    case 'context':
    case 'clarification':
    case 'brainstorm':
    case 'critic':
    case 'decision':
    case 'spec':
      return 'spec'
    case 'planning':
      return 'plan'
    case 'implementing':
    case 'testing':
    case 'fixing':
      return 'implement'
    case 'verifying':
    case 'reviewing':
    case 'final_verifying':
    case 'delivery_ready':
      return 'verify'
  }
}

/**
 * Translate a bucket into the bar data the UI renders.
 *
 * `filledInCurrent` is a sub-phase tick count. Short phases (spec, plan)
 * light one tick while their work is in flight. The implementation
 * phase is long, so its three sub-states tick up: implementing=2,
 * testing=3, fixing=3 (fixing loops back to testing visually because
 * the spec/plan tools define it as a self-test cycle). The verify
 * phase ticks up: verifying=1, reviewing=2, final_verifying=3,
 * delivery_ready=4 (the bar is full once the code is delivery-ready).
 */
export function bucketToStageView(bucket: StageBucket): StageView {
  switch (bucket) {
    case 'pending':
      return { current: null, filledInCurrent: 0, status: 'idle', pendingTicks: 0 }
    case 'blocked':
      // Highlight the spec phase so a blocked story reads as "stopped
      // before any work landed". A future improvement could remember
      // the last active phase from the trajectory, but the issue spec
      // calls for a simpler rule.
      return { current: 'spec', filledInCurrent: 1, status: 'halt', pendingTicks: 0 }
    case 'completed':
      return { current: 'verify', filledInCurrent: 4, status: 'done', pendingTicks: 0 }
    case 'failed':
      return { current: 'verify', filledInCurrent: 2, status: 'halt', pendingTicks: 0 }
    case 'spec':
      return { current: 'spec', filledInCurrent: 1, status: 'live', pendingTicks: 0 }
    case 'plan':
      return { current: 'plan', filledInCurrent: 1, status: 'live', pendingTicks: 0 }
    case 'implement':
      return { current: 'implement', filledInCurrent: 3, status: 'live', pendingTicks: 0 }
    case 'verify':
      return { current: 'verify', filledInCurrent: 2, status: 'live', pendingTicks: 0 }
  }
}

/**
 * Sub-phase tick values keyed by the underlying StoryState.
 *
 * The bucket-level default in `bucketToStageView` covers the COMMON
 * case for the implementation / verify phases; this map refines the
 * tick count for sub-states where the depth matters to the user
 * (mostly the implementation sub-states, where the count grows as
 * the implementation phase advances: implementing → testing → fixing).
 */
const SUB_PHASE_TICKS: Partial<Record<StageBucket, Partial<Record<string, number>>>> = {
  implement: {
    implementing: 2,
    testing: 3,
    fixing: 3,
  },
  verify: {
    verifying: 1,
    reviewing: 2,
    final_verifying: 3,
    delivery_ready: 4,
  },
}

/**
 * Build a per-story gauge from the raw StoryState (not the bucket).
 *
 * `buildGauge` falls back to the bucket default when the state has no
 * finer-grained tick entry; this variant picks up the per-state ticks
 * the way the UI consumes them.
 */
export function buildGaugeForState(state: StoryState): { blocks: GaugeBlock[]; status: StageView['status'] } {
  const bucket = stateToBucket(state)
  const view = bucketToStageView(bucket)
  const sub = SUB_PHASE_TICKS[bucket]
  const ticks = (sub && sub[state]) ?? view.filledInCurrent
  const blocks: GaugeBlock[] = STAGE_KEYS.map((key) => ({
    ticks: 0,
    status: 'idle' as const,
  }))
  if (view.current === null) {
    return { blocks, status: view.status }
  }
  const idx = STAGE_KEYS.indexOf(view.current)
  for (let i = 0; i < idx; i++) {
    blocks[i] = { ticks: 4, status: 'done' }
  }
  blocks[idx] = { ticks, status: view.status }
  return { blocks, status: view.status }
}

/**
 * One stop on a single 4-block gauge. `ticks` is the number of lit ticks
 * out of 4; the rest are inert. Status drives the colour (handled by
 * the injected stylesheet so it follows the shell theme).
 */
export interface GaugeBlock {
  ticks: number
  status: 'idle' | 'live' | 'halt' | 'done'
}

/**
 * Build the full four-block gauge data for a story.
 *
 * Phases BEFORE `current` are fully lit and rendered in the "done"
 * (muted grey) style. The `current` block uses `status` from the stage
 * view. Phases AFTER `current` are inert.
 */
export function buildGauge(state: StoryState): { blocks: GaugeBlock[]; status: StageView['status'] } {
  return buildGaugeForState(state)
}

/**
 * Human-readable phase label for the current bucket — used by the
 * detail view's "停在 <phase>" line. The four labels are stable Chinese
 * strings so the UI does not leak the internal state name.
 */
export function currentPhaseLabel(state: StoryState): string | null {
  const bucket = stateToBucket(state)
  if (bucket === 'pending') return '尚未开始'
  if (bucket === 'blocked') return '已暂停'
  if (bucket === 'completed') return '已完成'
  if (bucket === 'failed') return '失败'
  return STAGE_LABELS[bucket]
}
