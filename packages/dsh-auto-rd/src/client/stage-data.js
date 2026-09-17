/**
 * Stage mapping — collapse the 19-state story machine into 4 user-visible
 * phases: 规格(spec)、计划(plan)、实现(implement)、验证(verify).
 *
 * The browser client cannot `import` the host-side TypeScript module
 * (different realms, no bundler). Instead this file ships the SAME
 * mapping as a plain JS object literal, and the build step concatenates
 * it into client.js so the bundle has only one source of truth.
 *
 * Pipeline reference: docs/architecture/auto-rd-native-plugin-design.md §5.
 *
 *   - spec:    context, clarification, brainstorm, critic, decision, spec
 *   - plan:    planning
 *   - implement: implementing, testing, fixing
 *   - verify:  verifying, reviewing, final_verifying, mr_creating, tapd_syncing
 *   - (terminal: completed, failed — handled separately)
 *   - (human pause: blocked — does not advance the bar)
 *   - (queue: pending — the bar is still on phase 0 / "未开始")
 *
 * The package.json `copy:client` step copies this file into
 * `lib/client/stage-data.js`, and the bundle script inlines it. The host
 * uses `src/domain/stage.ts` as the typed source of truth; both are
 * pinned to the SAME StoryState list by the test suite.
 */

var STAGE_KEYS = ['spec', 'plan', 'implement', 'verify']

var STAGE_LABELS = {
  spec: '规格',
  plan: '计划',
  implement: '实现',
  verify: '验证',
}

/**
 * State → bucket. Mirrors the exhaustive switch in domain/stage.ts so
 * the client and the host agree on what each StoryState means.
 */
var STATE_TO_BUCKET = {
  pending: 'pending',
  blocked: 'blocked',
  completed: 'completed',
  failed: 'failed',
  context: 'spec',
  clarification: 'spec',
  brainstorm: 'spec',
  critic: 'spec',
  decision: 'spec',
  spec: 'spec',
  planning: 'plan',
  implementing: 'implement',
  testing: 'implement',
  fixing: 'implement',
  verifying: 'verify',
  reviewing: 'verify',
  final_verifying: 'verify',
  mr_creating: 'verify',
  tapd_syncing: 'verify',
}

/**
 * Bucket → base view. The bar's first block is highlighted with these
 * ticks; phases before it are fully lit (rendered as "done" grey).
 */
var BUCKET_VIEW = {
  pending:    { current: null,   ticks: 0, status: 'idle' },
  blocked:    { current: 'spec', ticks: 1, status: 'halt' },
  completed:  { current: 'verify', ticks: 4, status: 'done' },
  failed:     { current: 'verify', ticks: 2, status: 'halt' },
  spec:       { current: 'spec', ticks: 1, status: 'live' },
  plan:       { current: 'plan', ticks: 1, status: 'live' },
  implement:  { current: 'implement', ticks: 3, status: 'live' },
  verify:     { current: 'verify', ticks: 2, status: 'live' },
}

/**
 * Sub-phase ticks: refine the bucket default for the implementation /
 * verify phases so the user sees depth inside a long phase.
 */
var SUB_PHASE_TICKS = {
  implementing: 2,
  testing: 3,
  fixing: 3,
  verifying: 1,
  reviewing: 2,
  final_verifying: 3,
  mr_creating: 3,
  tapd_syncing: 4,
}

/**
 * Human-readable label for the current bucket — never the internal
 * state name (issue #5 acceptance: "阶段名对用户可读,界面不出现内部状态标识").
 */
var BUCKET_LABEL = {
  pending: '尚未开始',
  blocked: '已暂停',
  completed: '已完成',
  failed: '失败',
}

/**
 * Build the four-block gauge data the UI consumes.
 *
 * Returns `{ blocks, status }` where `blocks[i] = { ticks, status }`.
 * Phase i < current: ticks=4, status='done'. Phase i == current: status
 * from the view, ticks from the sub-phase map (or the bucket default).
 * Phase i > current: ticks=0, status='idle'.
 */
function buildGauge(state) {
  var bucket = STATE_TO_BUCKET[state] || 'pending'
  var view = BUCKET_VIEW[bucket]
  var blocks = STAGE_KEYS.map(function () {
    return { ticks: 0, status: 'idle' }
  })
  if (view.current === null) {
    return { blocks: blocks, status: view.status }
  }
  var idx = STAGE_KEYS.indexOf(view.current)
  for (var i = 0; i < idx; i++) {
    blocks[i] = { ticks: 4, status: 'done' }
  }
  var ticks = (SUB_PHASE_TICKS[state] != null) ? SUB_PHASE_TICKS[state] : view.ticks
  blocks[idx] = { ticks: ticks, status: view.status }
  return { blocks: blocks, status: view.status }
}

function currentPhaseLabel(state) {
  var bucket = STATE_TO_BUCKET[state] || 'pending'
  if (BUCKET_LABEL[bucket]) return BUCKET_LABEL[bucket]
  return STAGE_LABELS[bucket]
}
