// Stage mapping tests.
//
// Each StoryState must belong to exactly one of: spec / plan / implement /
// verify / pending / blocked / completed / failed. A new state added to
// the schema without a mapping entry fails the exhaustive test, which is
// the point: silently dropping a state means the gauge lies about which
// work is being done.
//
// Run with: node scripts/test-stage.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const {
  stateToBucket,
  bucketToStageView,
  buildGauge,
  currentPhaseLabel,
  STAGE_KEYS,
  STAGE_LABELS,
} = await import(pathToFileURL(resolve(libBase, 'domain', 'stage.js')).href)
const { StoryStateSchema } = await import(pathToFileURL(resolve(libBase, 'domain', 'schema.js')).href)

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) {
    pass += 1
    process.stdout.write(`\u2713 ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`\u2717 ${name}${extra ? ` (${extra})` : ''}\n`)
  }
}

// ---- exhaustive mapping --------------------------------------------

const allStates = StoryStateSchema.options
check('exhaustive: every StoryState has a bucket', allStates.every((s) => typeof stateToBucket(s) === 'string'))
check('exhaustive: bucket is one of the documented values', allStates.every((s) => {
  const b = stateToBucket(s)
  return STAGE_KEYS.includes(b) || ['pending', 'blocked', 'completed', 'failed'].includes(b)
}))

// Each phase is reachable.
check('reachability: spec bucket is hit', allStates.some((s) => stateToBucket(s) === 'spec'))
check('reachability: plan bucket is hit', allStates.some((s) => stateToBucket(s) === 'plan'))
check('reachability: implement bucket is hit', allStates.some((s) => stateToBucket(s) === 'implement'))
check('reachability: verify bucket is hit', allStates.some((s) => stateToBucket(s) === 'verify'))

// ---- bucket-to-view: status types ----------------------------------

{
  const v = bucketToStageView('pending')
  check('pending view: current is null', v.current === null)
  check('pending view: status is idle', v.status === 'idle')
}

{
  const v = bucketToStageView('blocked')
  check('blocked view: highlights spec phase', v.current === 'spec')
  check('blocked view: status is halt', v.status === 'halt')
}

{
  const v = bucketToStageView('completed')
  check('completed view: highlights verify phase', v.current === 'verify')
  check('completed view: status is done', v.status === 'done')
}

{
  const v = bucketToStageView('failed')
  check('failed view: highlights verify phase', v.current === 'verify')
  check('failed view: status is halt', v.status === 'halt')
}

// ---- gauge construction --------------------------------------------

{
  const g = buildGauge('pending')
  check('gauge pending: all blocks are inert', g.blocks.every((b) => b.ticks === 0 && b.status === 'idle'))
}

{
  // spec phase done → plan phase running
  const g = buildGauge('planning')
  check('gauge planning: spec block done', g.blocks[0].ticks === 4 && g.blocks[0].status === 'done')
  check('gauge planning: plan block live', g.blocks[1].ticks === 1 && g.blocks[1].status === 'live')
  check('gauge planning: implement block idle', g.blocks[2].ticks === 0)
  check('gauge planning: verify block idle', g.blocks[3].ticks === 0)
  check('gauge planning: overall status is live', g.status === 'live')
}

{
  const g = buildGauge('implementing')
  check('gauge implementing: spec+plan done', g.blocks[0].status === 'done' && g.blocks[1].status === 'done')
  check('gauge implementing: implement block 2 ticks live', g.blocks[2].ticks === 2 && g.blocks[2].status === 'live')
  check('gauge implementing: verify still idle', g.blocks[3].ticks === 0)
}

{
  const g = buildGauge('testing')
  check('gauge testing: implement ticks bumped', g.blocks[2].ticks === 3 && g.blocks[2].status === 'live')
}

{
  const g = buildGauge('fixing')
  // The implement phase's tick progression: implementing=2, testing=3, fixing=3
  // (we keep testing=fixing visually equivalent; both are "still in implement").
  check('gauge fixing: implement block live', g.blocks[2].status === 'live' && g.blocks[2].ticks >= 2)
}

{
  const g = buildGauge('blocked')
  check('gauge blocked: status is halt', g.status === 'halt')
  check('gauge blocked: spec block has at least 1 tick', g.blocks[0].ticks >= 1)
}

{
  const g = buildGauge('completed')
  check('gauge completed: all blocks fully lit', g.blocks.every((b) => b.ticks === 4))
  check('gauge completed: overall status is done', g.status === 'done')
}

{
  const g = buildGauge('failed')
  check('gauge failed: status is halt', g.status === 'halt')
}

// ---- phase labels --------------------------------------------------

{
  // The label is the user-facing text. It must NOT leak the internal
  // state name (issue #5 acceptance criterion: "阶段名对用户可读,界面不
  // 出现内部状态标识").
  check('label implementing: returns implement label', currentPhaseLabel('implementing') === STAGE_LABELS.implement)
  check('label pending: returns 尚未开始', currentPhaseLabel('pending') === '尚未开始')
  check('label blocked: returns 已暂停', currentPhaseLabel('blocked') === '已暂停')
  check('label completed: returns 已完成', currentPhaseLabel('completed') === '已完成')
  check('label failed: returns 失败', currentPhaseLabel('failed') === '失败')

  // No label should ever echo a state name back to the user.
  const userFacing = [
    currentPhaseLabel('context'),
    currentPhaseLabel('clarification'),
    currentPhaseLabel('brainstorm'),
    currentPhaseLabel('critic'),
    currentPhaseLabel('decision'),
    currentPhaseLabel('spec'),
    currentPhaseLabel('planning'),
    currentPhaseLabel('implementing'),
    currentPhaseLabel('testing'),
    currentPhaseLabel('fixing'),
    currentPhaseLabel('verifying'),
    currentPhaseLabel('reviewing'),
    currentPhaseLabel('final_verifying'),
    currentPhaseLabel('delivery_ready'),
    currentPhaseLabel('mr_opened'),
  ]
  for (const lbl of userFacing) {
    check(`label non-internal: "${lbl}"`, lbl !== null && STAGE_KEYS.every((k) => lbl !== k))
  }
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nStage tests: ${pass} pass, ${fail} fail\n`)
process.exit(fail > 0 ? 1 : 0)
