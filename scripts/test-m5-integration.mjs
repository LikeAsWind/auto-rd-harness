// M5 integration test suite.
//
// Covers the M5 features that are NOT in M4-A's fake-server tests:
//   - recoverStories: ACTIVE state -> pending reset, retryCount=0
//   - auto_rd_retry tool: retry/skip/reset_to_pending + edge cases
//   - auto_rd_trigger tool: poll_now / advance_story / mark_reviewed
//   - auto_rd_status tool: summary / stories / tasks scopes
//   - story-queue concurrency limits (per-module + global)
//   - logger warning rate limit (M5 §22 — caps hot messages)
//
// Does NOT cover:
//   - TapdPoller / GitLabMerger (covered by test-m4-fakes.mjs)
//   - StoryRunner stage transitions (covered by stub handler behaviour)
//   - DSH plugin mount (requires real DSH runtime; out of scope)
//
// Run with: node scripts/test-m5-integration.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

function mkTmpDir() {
  return mkdtempSync(join(tmpdir(), 'auto-rd-m5-'))
}

/** Run a git command in `cwd` and return its stdout. */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/**
 * Minimal Config object for AgentProvider tests. AgentProvider only
 * reads `config.gitlabPushUserName` / `gitlabPushUserEmail` from it.
 */
function defaultConfig() {
  return {
    tapdApiToken: '', tapdBaseUrl: 'http://x', tapdPollIntervalMs: 60000,
    tapdWorkspaceIds: [], useTapdMock: true,
    gitlabApiToken: '', gitlabBaseUrl: 'http://x',
    gitlabPushUserName: 'auto-rd', gitlabPushUserEmail: 'auto-rd@example.com',
    workspaceRoot: '/tmp', modules: [],
    maxConcurrentStoriesPerModule: 1, maxTotalConcurrentStories: 1,
    modelSelection: {
      brainstorm: 'x', critic: 'x', decision: 'x', spec: 'x', planner: 'x',
      implementation: 'x', test: 'x', fix: 'x', verification: 'x', review: 'x',
      finalVerify: 'x',
    },
    logLevel: 'info',
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

// ---- Fake storage / logger -------------------------------------------

/**
 * Tiny TableApi mock. Stores records in a Map.
 */
function makeFakeTable(initial = []) {
  const map = new Map()
  for (const r of initial) map.set(r.id, JSON.parse(JSON.stringify(r)))
  return {
    get(key) {
      const v = map.get(key)
      return v ? JSON.parse(JSON.stringify(v)) : undefined
    },
    async put(key, value) {
      map.set(key, JSON.parse(JSON.stringify(value)))
    },
    async delete(key) {
      map.delete(key)
    },
    *values() {
      for (const v of map.values()) yield JSON.parse(JSON.stringify(v))
    },
    /** Test helper: peek the raw stored value (bypass deep clone). */
    raw(key) {
      return map.get(key)
    },
  }
}

function makeFakeStorage(initial = {}) {
  const stories = makeFakeTable(initial.stories ?? [])
  const modules = makeFakeTable(initial.modules ?? [])
  const tasks = makeFakeTable(initial.tasks ?? [])
  const trajectories = makeFakeTable(initial.trajectories ?? [])
  return {
    stories: () => stories,
    modules: () => modules,
    tasks: () => tasks,
    trajectories: () => trajectories,
  }
}

function makeFakeLogger() {
  const lines = []
  return {
    lines,
    debug(msg) { lines.push({ level: 'debug', msg }) },
    info(msg) { lines.push({ level: 'info', msg }) },
    warn(msg) { lines.push({ level: 'warn', msg }) },
    error(msg) { lines.push({ level: 'error', msg }) },
  }
}

// ---- Imports ----------------------------------------------------------

const recoverMod = await import(
  pathToFileURL(resolve(libBase, 'services', 'recover.js')).href
)
const retryToolMod = await import(
  pathToFileURL(resolve(libBase, 'tools', 'auto-rd-retry.js')).href
)
const triggerToolMod = await import(
  pathToFileURL(resolve(libBase, 'tools', 'auto-rd-trigger.js')).href
)
const statusToolMod = await import(
  pathToFileURL(resolve(libBase, 'tools', 'auto-rd-status.js')).href
)
const storyQueueMod = await import(
  pathToFileURL(resolve(libBase, 'services', 'story-queue.js')).href
)
const loggerMod = await import(
  pathToFileURL(resolve(libBase, 'utils', 'logger.js')).href
)

const { recoverStories } = recoverMod
const { autoRdRetryTool } = retryToolMod
const { autoRdTriggerTool } = triggerToolMod
const { autoRdStatusTool } = statusToolMod
const { StoryQueue } = storyQueueMod
const {
  Logger,
  __resetLoggerRateLimit,
  __loggerRateLimitSnapshot,
} = loggerMod

// ---- Assertion helpers -------------------------------------------------

let pass = 0
let fail = 0
const check = (name, cond, extra) => {
  if (cond) {
    process.stdout.write(`\u2713 ${name}\n`)
    pass++
  } else {
    process.stdout.write(`\u2717 ${name} ${extra ?? ''}\n`)
    fail++
  }
}

const baseStory = (overrides = {}) => ({
  id: 'TAPD-1',
  moduleId: 'payment',
  tapdId: 'TAPD-1',
  title: 'Story title',
  description: 'desc',
  state: 'pending',
  branch: 'auto-rd/TAPD-1',
  worktreePath: undefined,
  mainSessionId: undefined,
  artifacts: {},
  retryCount: 0,
  blockedReason: undefined,
  mrUrl: undefined,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
  ...overrides,
})

// ---- Tests -------------------------------------------------------------

// 1. recoverStories — ACTIVE state -> pending, retryCount=0
{
  const storage = makeFakeStorage({
    stories: [
      baseStory({ id: 'S1', state: 'implementing', retryCount: 4 }),
      baseStory({ id: 'S2', state: 'fixing', retryCount: 5 }),
      baseStory({ id: 'S3', state: 'pending' }),         // skipped (terminal-ish)
      baseStory({ id: 'S4', state: 'completed' }),      // skipped
      baseStory({ id: 'S5', state: 'failed' }),         // skipped
      baseStory({ id: 'S6', state: 'blocked' }),        // skipped
    ],
  })
  const logger = makeFakeLogger()
  const result = await recoverStories(storage, logger)

  check(
    'recoverStories returns recovered list with 2 items',
    Array.isArray(result.recovered) && result.recovered.length === 2,
    JSON.stringify(result),
  )
  check('recoverStories S1 reset to pending', storage.stories().get('S1').state === 'pending')
  check('recoverStories S1 retryCount=0', storage.stories().get('S1').retryCount === 0)
  check('recoverStories S2 reset to pending', storage.stories().get('S2').state === 'pending')
  check('recoverStories S2 retryCount=0', storage.stories().get('S2').retryCount === 0)
  check('recoverStories leaves pending untouched', storage.stories().get('S3').state === 'pending')
  check('recoverStories leaves completed untouched', storage.stories().get('S4').state === 'completed')
  check('recoverStories leaves failed untouched', storage.stories().get('S5').state === 'failed')
  check('recoverStories leaves blocked untouched', storage.stories().get('S6').state === 'blocked')
  check(
    'recoverStories logs warn per recovered story',
    logger.lines.filter((l) => l.level === 'warn').length === 2,
  )
}

// 1b. TrajectoryRecorder — recovers emit `recovery` events; recovery
//     leaves terminal states untouched and emits zero events for them.
{
  const storage = makeFakeStorage({
    stories: [
      baseStory({ id: 'T1', state: 'brainstorm' }),
      baseStory({ id: 'T2', state: 'spec' }),
      baseStory({ id: 'T3', state: 'completed' }),
    ],
  })
  const logger = makeFakeLogger()
  const { TrajectoryRecorder } = await import(
    pathToFileURL(resolve(libBase, 'services', 'trajectory.js')).href
  )
  // TrajectoryRecorder doesn't read from ctx; pass null-equivalent.
  const trajectory = new TrajectoryRecorder(null, { storage, logger })

  const result = await recoverStories(storage, logger, trajectory)
  check(
    'recoverStories with trajectory returns 2 recovered',
    result.recovered.length === 2,
    JSON.stringify(result),
  )

  // Allow the void append() calls to settle.
  await new Promise((r) => setTimeout(r, 20))

  const events = trajectory.listForStory('T1')
  check('T1 has exactly 1 trajectory event', events.length === 1, JSON.stringify(events))
  check(
    'T1 event kind = recovery',
    events.length === 1 && events[0].kind === 'recovery',
  )
  check(
    'T1 event label = "brainstorm → pending"',
    events.length === 1 && events[0].label === 'brainstorm → pending',
  )

  const eventsT3 = trajectory.listForStory('T3')
  check(
    'completed story T3 emits zero trajectory events',
    eventsT3.length === 0,
    JSON.stringify(eventsT3),
  )
}

// 1c. TrajectoryRecorder.append — every kind accepts payload
{
  const storage = makeFakeStorage()
  const logger = makeFakeLogger()
  const { TrajectoryRecorder } = await import(
    pathToFileURL(resolve(libBase, 'services', 'trajectory.js')).href
  )
  const trajectory = new TrajectoryRecorder(null, { storage, logger })

  await trajectory.append({
    storyId: 'X',
    kind: 'state_transition',
    label: 'context → clarification',
    payload: { from: 'context', to: 'clarification' },
  })
  await trajectory.append({
    storyId: 'X',
    kind: 'agent_dispatch',
    label: 'context: run',
    payload: { agent: 'context', inputs: { story: { id: 'X' } } },
  })
  await trajectory.append({
    storyId: 'X',
    kind: 'checkpoint_write',
    label: 'push branch',
    payload: { sha: 'abc123' },
  })

  const events = trajectory.listForStory('X')
  check('append 3 events all stored', events.length === 3, JSON.stringify(events))
  check(
    'events sorted by `at` (chronological)',
    events.length === 3 &&
      events[0].at <= events[1].at &&
      events[1].at <= events[2].at,
  )
  check(
    'payload preserved verbatim',
    events.length === 3 && events[2].payload?.sha === 'abc123',
  )
}

// 1d. TrajectoryRecorder — best-effort: put failure logs warn, returns null
{
  const storage = makeFakeStorage()
  const logger = makeFakeLogger()
  const { TrajectoryRecorder } = await import(
    pathToFileURL(resolve(libBase, 'services', 'trajectory.js')).href
  )
  const trajectory = new TrajectoryRecorder(null, { storage, logger })

  // Override put to throw, mimicking a broken storageDomain.
  const origPut = storage.trajectories().put
  storage.trajectories().put = async () => {
    throw new Error('disk full')
  }

  const result = await trajectory.append({
    storyId: 'Y',
    kind: 'note',
    label: 'test',
  })
  check('append returns null on storage failure', result === null)

  storage.trajectories().put = origPut
  check(
    'logger captured the failure',
    logger.lines.some(
      (l) => l.level === 'warn' && l.msg.includes('disk full'),
    ),
  )
}

// 2. auto_rd_retry tool — retry action resets retryCount
{
  const storage = makeFakeStorage({
    stories: [
      baseStory({ id: 'R1', state: 'blocked', retryCount: 4, blockedReason: 'x' }),
    ],
  })
  const logger = makeFakeLogger()
  const tool = autoRdRetryTool({ storage, logger })

  const r1 = await tool.execute({ storyId: 'R1', action: 'retry' })
  check('auto_rd_retry.retry returns ok=true', r1.ok === true, JSON.stringify(r1))
  check('auto_rd_retry.retry state -> pending', storage.stories().get('R1').state === 'pending')
  check('auto_rd_retry.retry retryCount -> 0', storage.stories().get('R1').retryCount === 0)
  check(
    'auto_rd_retry.retry blockedReason cleared',
    storage.stories().get('R1').blockedReason === undefined,
  )
}

// 3. auto_rd_retry tool — reset_to_pending KEEPS retryCount
{
  const storage = makeFakeStorage({
    stories: [baseStory({ id: 'R2', state: 'blocked', retryCount: 4 })],
  })
  const logger = makeFakeLogger()
  const tool = autoRdRetryTool({ storage, logger })

  const r = await tool.execute({ storyId: 'R2', action: 'reset_to_pending' })
  check('reset_to_pending ok', r.ok === true)
  check('reset_to_pending state -> pending', storage.stories().get('R2').state === 'pending')
  check(
    'reset_to_pending KEEPS retryCount=4 (vs retry which resets)',
    storage.stories().get('R2').retryCount === 4,
  )
}

// 4. auto_rd_retry tool — skip -> terminal failed
{
  const storage = makeFakeStorage({
    stories: [baseStory({ id: 'R3', state: 'blocked', retryCount: 1 })],
  })
  const logger = makeFakeLogger()
  const tool = autoRdRetryTool({ storage, logger })

  const r = await tool.execute({ storyId: 'R3', action: 'skip', note: 'not relevant' })
  check('skip ok', r.ok === true)
  check('skip state -> failed', storage.stories().get('R3').state === 'failed')
  check(
    'skip records note in blockedReason',
    typeof storage.stories().get('R3').blockedReason === 'string' &&
      storage.stories().get('R3').blockedReason.includes('not relevant'),
  )
}

// 5. auto_rd_retry tool — story_not_found returns ok:false
{
  const storage = makeFakeStorage()
  const tool = autoRdRetryTool({ storage, logger: makeFakeLogger() })
  const r = await tool.execute({ storyId: 'NOPE', action: 'retry' })
  check('auto_rd_retry missing story returns ok=false', r.ok === false && r.error === 'story_not_found')
}

// 6. auto_rd_retry tool — invalid_parameters returns ok:false
{
  const tool = autoRdRetryTool({ storage: makeFakeStorage(), logger: makeFakeLogger() })
  const r = await tool.execute({ storyId: '' })
  check(
    'auto_rd_retry empty storyId returns ok=false invalid_parameters',
    r.ok === false && r.error === 'invalid_parameters',
  )
}

// 7. auto_rd_trigger tool — poll_now with no callback -> callback_not_wired
{
  const storage = makeFakeStorage()
  const tool = autoRdTriggerTool({ storage, logger: makeFakeLogger() })
  const r = await tool.execute({ action: 'poll_now' })
  check(
    'trigger.poll_now no callback returns ok=false callback_not_wired',
    r.ok === false && r.error === 'callback_not_wired',
  )
}

// 8. auto_rd_trigger tool — poll_now with wired callback
{
  const storage = makeFakeStorage()
  let called = 0
  const tool = autoRdTriggerTool({
    storage,
    logger: makeFakeLogger(),
    pollNow: async () => {
      called++
    },
  })
  const r = await tool.execute({ action: 'poll_now' })
  check('trigger.poll_now with callback ok', r.ok === true && called === 1)
}

// 9. auto_rd_trigger tool — advance_story with wired callback
{
  const storage = makeFakeStorage({
    stories: [baseStory({ id: 'A1', state: 'pending' })],
  })
  let advanceCalled = 0
  let advanceArgs = []
  const tool = autoRdTriggerTool({
    storage,
    logger: makeFakeLogger(),
    advanceStory: async (sid) => {
      advanceCalled++
      advanceArgs.push(sid)
    },
  })
  const r = await tool.execute({ action: 'advance_story', storyId: 'A1' })
  check('trigger.advance_story ok', r.ok === true && advanceCalled === 1 && advanceArgs[0] === 'A1')
}

// 10. auto_rd_trigger tool — mark_reviewed approve releases blocked
{
  const storage = makeFakeStorage({
    stories: [baseStory({ id: 'M1', state: 'blocked', retryCount: 2, blockedReason: 'x' })],
  })
  const tool = autoRdTriggerTool({ storage, logger: makeFakeLogger() })
  const r = await tool.execute({
    action: 'mark_reviewed',
    storyId: 'M1',
    decision: 'approve',
  })
  check('trigger.mark_reviewed.approve ok', r.ok === true)
  check(
    'approve -> pending + retryCount=0 + blockedReason cleared',
    storage.stories().get('M1').state === 'pending' &&
      storage.stories().get('M1').retryCount === 0 &&
      storage.stories().get('M1').blockedReason === undefined,
  )
}

// 11. auto_rd_trigger tool — mark_reviewed request_changes keeps state
{
  const storage = makeFakeStorage({
    stories: [baseStory({ id: 'M2', state: 'blocked', blockedReason: 'old' })],
  })
  const tool = autoRdTriggerTool({ storage, logger: makeFakeLogger() })
  const r = await tool.execute({
    action: 'mark_reviewed',
    storyId: 'M2',
    decision: 'request_changes',
    note: 'fix tests',
  })
  check('request_changes ok', r.ok === true)
  check('request_changes keeps state=blocked', storage.stories().get('M2').state === 'blocked')
  check(
    'request_changes appends note to blockedReason',
    storage.stories().get('M2').blockedReason.includes('fix tests'),
  )
}

// 12. auto_rd_trigger tool — mark_reviewed skip -> terminal failed
{
  const storage = makeFakeStorage({
    stories: [baseStory({ id: 'M3', state: 'blocked' })],
  })
  const tool = autoRdTriggerTool({ storage, logger: makeFakeLogger() })
  const r = await tool.execute({
    action: 'mark_reviewed',
    storyId: 'M3',
    decision: 'skip',
  })
  check('skip -> failed', storage.stories().get('M3').state === 'failed')
}

// 13. auto_rd_status tool — summary scope
{
  const storage = makeFakeStorage({
    modules: [{ id: 'm1', title: 'Payment', repoUrl: 'https://x.com/y.git', defaultBranch: 'main', workspacePath: '/tmp/m1', createdAt: '2025-01-01T00:00:00Z' }],
    stories: [
      baseStory({ id: 'S1', state: 'pending' }),
      baseStory({ id: 'S2', state: 'pending' }),
      baseStory({ id: 'S3', state: 'implementing' }),
      baseStory({ id: 'S4', state: 'completed' }),
    ],
    tasks: [
      { id: 'T1', storyId: 'S1', title: 't', description: '', status: 'pending', createdAt: '', updatedAt: '' },
      { id: 'T2', storyId: 'S2', title: 't', description: '', status: 'pending', createdAt: '', updatedAt: '' },
      { id: 'T3', storyId: 'S3', title: 't', description: '', status: 'in_progress', createdAt: '', updatedAt: '' },
    ],
  })
  const tool = autoRdStatusTool({ storage, logger: makeFakeLogger() })
  const r = await tool.execute({ scope: 'summary' })
  check(
    'status.summary totalStories=4',
    r.ok === true && r.totalStories === 4,
    JSON.stringify(r),
  )
  check('status.summary byState.pending=2', r.byState.pending === 2, JSON.stringify(r.byState))
  check('status.summary byState.implementing=1', r.byState.implementing === 1)
  check('status.summary byState.completed=1', r.byState.completed === 1)
  check('status.summary activeModules=1', r.activeModules === 1)
  check('status.summary pendingTasks=2', r.pendingTasks === 2)
}

// 14. auto_rd_status tool — stories scope filtered by state
{
  const storage = makeFakeStorage({
    stories: [
      baseStory({ id: 'S1', state: 'pending' }),
      baseStory({ id: 'S2', state: 'implementing' }),
    ],
  })
  const tool = autoRdStatusTool({ storage, logger: makeFakeLogger() })
  const r = await tool.execute({ scope: 'stories', state: 'pending' })
  check(
    'status.stories with state filter returns 1',
    r.ok === true && Array.isArray(r.stories) && r.stories.length === 1,
    JSON.stringify(r),
  )
  check(
    'status.stories filter respects state',
    r.stories.length === 1 && r.stories[0].id === 'S1',
  )
}

// 15. StoryQueue — global concurrency limit
{
  // 5 pending stories; maxTotalConcurrentStories=2 -> dispatch 2, leave 3
  const stories = []
  for (let i = 1; i <= 5; i++) {
    stories.push(baseStory({ id: `Q${i}`, tapdId: `Q${i}`, state: 'pending' }))
  }
  const storage = makeFakeStorage({ stories })
  const dispatched = []
  const fakeRunner = { runStory: async (id) => { dispatched.push(id) } }
  const config = {
    tapd: { apiToken: 'x', baseUrl: 'http://x', mock: false, pollIntervalMs: 60000 },
    maxConcurrentStoriesPerModule: 5,
    maxTotalConcurrentStories: 2,
    notification: { enabled: true, pollIntervalMs: 5000 },
    modules: [],
    gitlab: { token: 't', baseUrl: 'https://x', defaultSourceBranch: 'main' },
  }
  const queue = new StoryQueue({}, {
    storage,
    logger: makeFakeLogger(),
    config,
    runner: fakeRunner,
  })
  await queue.tick()
  // Wait for in-flight microtasks to settle.
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  check(
    'StoryQueue respects maxTotalConcurrentStories=2 (dispatched 2)',
    dispatched.length === 2,
    `dispatched=${JSON.stringify(dispatched)}`,
  )
  queue.stop()
}

// 16. StoryQueue — per-module limit
{
  const stories = [
    baseStory({ id: 'M1-A', moduleId: 'm1', state: 'pending' }),
    baseStory({ id: 'M1-B', moduleId: 'm1', state: 'pending' }),
    baseStory({ id: 'M1-C', moduleId: 'm1', state: 'pending' }),
    baseStory({ id: 'M2-A', moduleId: 'm2', state: 'pending' }),
  ]
  const storage = makeFakeStorage({ stories })
  const dispatched = []
  const fakeRunner = { runStory: async (id) => { dispatched.push(id) } }
  const config = {
    tapd: { apiToken: 'x', baseUrl: 'http://x', mock: false, pollIntervalMs: 60000 },
    maxConcurrentStoriesPerModule: 1,
    maxTotalConcurrentStories: 5,
    notification: { enabled: true, pollIntervalMs: 5000 },
    modules: [],
    gitlab: { token: 't', baseUrl: 'https://x', defaultSourceBranch: 'main' },
  }
  const queue = new StoryQueue({}, {
    storage,
    logger: makeFakeLogger(),
    config,
    runner: fakeRunner,
  })
  await queue.tick()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  check(
    'StoryQueue respects per-module limit=1 (dispatched M1-A + M2-A only)',
    dispatched.length === 2 &&
      dispatched.includes('M1-A') &&
      dispatched.includes('M2-A') &&
      !dispatched.includes('M1-B'),
    `dispatched=${JSON.stringify(dispatched)}`,
  )
  queue.stop()
}

// 17. StoryQueue — failed story eligible if retryCount < 3
{
  const storage = makeFakeStorage({
    stories: [
      baseStory({ id: 'F1', state: 'failed', retryCount: 2 }),
      baseStory({ id: 'F2', state: 'failed', retryCount: 3 }),
      baseStory({ id: 'F3', state: 'failed', retryCount: 4 }),
    ],
  })
  const dispatched = []
  const fakeRunner = { runStory: async (id) => { dispatched.push(id) } }
  const config = {
    tapd: { apiToken: 'x', baseUrl: 'http://x', mock: false, pollIntervalMs: 60000 },
    maxConcurrentStoriesPerModule: 5,
    maxTotalConcurrentStories: 5,
    notification: { enabled: true, pollIntervalMs: 5000 },
    modules: [],
    gitlab: { token: 't', baseUrl: 'https://x', defaultSourceBranch: 'main' },
  }
  const queue = new StoryQueue({}, {
    storage,
    logger: makeFakeLogger(),
    config,
    runner: fakeRunner,
  })
  await queue.tick()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))
  check(
    'StoryQueue redispatches failed stories with retryCount < 3',
    dispatched.includes('F1') && !dispatched.includes('F2') && !dispatched.includes('F3'),
    `dispatched=${JSON.stringify(dispatched)}`,
  )
  queue.stop()
}

// ---- Logger rate-limit tests (M5 §22) ---------------------------------

/**
 * Spy on console.log / console.warn / console.error so we can count
 * the lines the Logger class actually emits. The rate-limit registry
 * is module-level, so we reset it between tests via __resetLoggerRateLimit.
 */
function makeConsoleSpy() {
  const orig = { log: console.log, warn: console.warn, error: console.error }
  const lines = []
  console.log = (...args) => lines.push({ channel: 'log', msg: args.join(' ') })
  console.warn = (...args) => lines.push({ channel: 'warn', msg: args.join(' ') })
  console.error = (...args) => lines.push({ channel: 'error', msg: args.join(' ') })
  return {
    lines,
    restore() {
      console.log = orig.log
      console.warn = orig.warn
      console.error = orig.error
    },
  }
}

// 18. Logger — first N emits go through, then bucket trips.
{
  __resetLoggerRateLimit()
  const spy = makeConsoleSpy()
  const logger = new Logger({}, 'warn', 'auto-rd-test')
  for (let i = 0; i < 5; i++) logger.warn('TAPD 503 transient failure')
  // 5 emits should be visible.
  const warnLines = spy.lines.filter((l) => l.channel === 'warn' && l.msg.includes('TAPD 503 transient failure'))
  check('logger first 5 warns emitted', warnLines.length === 5, `got=${warnLines.length}`)
  spy.restore()
}

// 19. Logger — 6th emit trips the bucket + summary line.
{
  __resetLoggerRateLimit()
  const spy = makeConsoleSpy()
  const logger = new Logger({}, 'warn', 'auto-rd-test')
  for (let i = 0; i < 8; i++) logger.warn('TAPD 503 transient failure')
  // 5 originals + 1 summary line = 6 emits. The 6th, 7th, 8th were suppressed.
  const warnLines = spy.lines.filter((l) => l.channel === 'warn')
  const summaryLines = warnLines.filter((l) => l.msg.includes('further warn messages suppressed'))
  check(
    'logger 6th emit produces summary line',
    summaryLines.length === 1,
    `warnLines=${warnLines.length} summaryLines=${summaryLines.length}`,
  )
  check(
    'logger summary records 1 further suppressed at emit 6 (subsequent emits silently drop)',
    summaryLines.length === 1 && summaryLines[0].msg.includes('1 further'),
    summaryLines[0]?.msg,
  )
  spy.restore()
}

// 20. Logger — distinct messages are independent buckets.
{
  __resetLoggerRateLimit()
  const spy = makeConsoleSpy()
  const logger = new Logger({}, 'warn', 'auto-rd-test')
  for (let i = 0; i < 4; i++) logger.warn('TAPD 503 transient failure')
  for (let i = 0; i < 4; i++) logger.warn('GitLab MR create 401 unauthorized')
  // 4 + 4 = 8 distinct emits, no rate limit hit.
  const warnLines = spy.lines.filter((l) => l.channel === 'warn')
  check(
    'logger distinct messages get independent buckets',
    warnLines.length === 8,
    `got=${warnLines.length}`,
  )
  spy.restore()
}

// 21. Logger — same prefix within 60 chars shares a bucket.
{
  __resetLoggerRateLimit()
  const spy = makeConsoleSpy()
  const logger = new Logger({}, 'warn', 'auto-rd-test')
  for (let i = 0; i < 3; i++) logger.warn('TAPD 503 transient failure')
  for (let i = 0; i < 3; i++) logger.warn('TAPD 503 transient failure retry')
  // Both prefixes share the first 60 chars "TAPD 503 transient failure", so this is
  // a single bucket -- 5 allowed, 6th would trip. Here we emit 6 of the same key.
  const warnLines = spy.lines.filter((l) => l.channel === 'warn')
  // 5 emits + 1 summary = 6.
  check(
    'logger prefix-window bucketing merges similar messages',
    warnLines.length === 6,
    `got=${warnLines.length}`,
  )
  spy.restore()
}

// 22. Logger — error-level emits also rate-limited (summary line at warn level).
{
  __resetLoggerRateLimit()
  const spy = makeConsoleSpy()
  const logger = new Logger({}, 'error', 'auto-rd-test')
  for (let i = 0; i < 6; i++) logger.error('TAPD 503 transient failure')
  // 5 emits on error + 1 summary on warn = 6 total (5 error + 1 warn summary).
  const errorLines = spy.lines.filter((l) => l.channel === 'error')
  const warnSummary = spy.lines.filter((l) => l.channel === 'warn' && l.msg.includes('further error messages suppressed'))
  check(
    'logger error emits also rate-limited',
    errorLines.length === 5 && warnSummary.length === 1,
    `errors=${errorLines.length} summaries=${warnSummary.length}`,
  )
  spy.restore()
}

// 23. Logger — debug/info below threshold don't count against warn buckets.
{
  __resetLoggerRateLimit()
  const spy = makeConsoleSpy()
  const logger = new Logger({}, 'warn', 'auto-rd-test')
  // level=warn means debug/info filtered out entirely (no rate limit impact).
  logger.debug('TAPD 503 transient failure')
  logger.info('TAPD 503 transient failure')
  logger.warn('TAPD 503 transient failure')
  const warnLines = spy.lines.filter((l) => l.channel === 'warn')
  check(
    'logger debug/info below threshold do not emit',
    warnLines.length === 1 && warnLines[0].msg.includes('TAPD 503 transient failure'),
    `warnLines=${warnLines.length}`,
  )
  spy.restore()
}

// 24. Logger — __loggerRateLimitSnapshot reflects current state.
{
  __resetLoggerRateLimit()
  const logger = new Logger({}, 'warn', 'auto-rd-test')
  for (let i = 0; i < 7; i++) logger.warn('Hot error message that repeats')
  const snap = __loggerRateLimitSnapshot()
  const entry = snap.find((s) => s.key.includes('Hot error message'))
  check('snapshot has the bucket', entry !== undefined)
  check(
    'snapshot shows 5 emitted + 2 suppressed',
    entry && entry.count === 5 && entry.suppressed === 2,
    JSON.stringify(entry),
  )
}

// 26. ImplementationAgent handler — really commits to the worktree.
//     This is the end-to-end proof for the design requirement
//     "Implementation 应真实修改 Story worktree": a dirty worktree
//     must produce a real commit with a real sha, and a clean one
//     must report no-change rather than a fake hash.
{
  const storage = makeFakeStorage()
  const logger = makeFakeLogger()
  const { AgentProvider } = await import(
    pathToFileURL(resolve(libBase, 'services', 'agent-provider.js')).href
  )
  const config = defaultConfig()
  const provider = new AgentProvider({}, { logger, config })

  // Real git repo to act as the story worktree.
  const repo = mkTmpDir()
  git(repo, ['init', '--quiet', '--initial-branch', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'README.md'), '# base\n', 'utf-8')
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', 'base'])
  const shaBefore = git(repo, ['rev-parse', 'HEAD']).trim()

  // Simulate the model having written the implementation.
  writeFileSync(join(repo, 'feature.ts'), 'export const implemented = true\n', 'utf-8')

  const artifactsDir = mkTmpDir()
  const result = await provider.dispatch({
    agentName: 'implementation',
    label: 'Implementation T001',
    worktreePath: repo,
    artifactsDir,
    inputs: {
      story: { id: 'IMPL-1', title: 'Add feature', description: 'd' },
      task: {
        taskId: 'T001',
        title: 'Add feature',
        files: ['feature.ts'],
        commit: { type: 'feat', scope: 'core', subject: 'add implemented flag' },
      },
    },
    taskId: 'T001',
  })
  check('impl dispatch succeeds', result.status === 'success', JSON.stringify(result))

  const shaAfter = git(repo, ['rev-parse', 'HEAD']).trim()
  check('impl created a REAL commit (sha advanced)', shaAfter !== shaBefore, `${shaBefore} -> ${shaAfter}`)
  check(
    'impl commit message uses the planner commit payload',
    git(repo, ['log', '-1', '--pretty=%s']).trim() === 'feat(core): add implemented flag',
    git(repo, ['log', '-1', '--pretty=%s']).trim(),
  )
  check(
    'impl commit contains feature.ts',
    git(repo, ['show', '--name-only', '--pretty=format:', 'HEAD']).includes('feature.ts'),
  )
  check(
    'impl worktree is clean after the commit',
    git(repo, ['status', '--porcelain']).trim() === '',
    git(repo, ['status', '--porcelain']),
  )
  check(
    'impl report records the real sha',
    readFileSync(join(artifactsDir, '08-impl-T001.md'), 'utf-8').includes(shaAfter),
  )

  // Second dispatch on the now-clean worktree must NOT fabricate a commit.
  const result2 = await provider.dispatch({
    agentName: 'implementation',
    label: 'Implementation T001 (replay)',
    worktreePath: repo,
    artifactsDir,
    inputs: { story: { id: 'IMPL-1', title: 'Add feature', description: 'd' } },
    taskId: 'T001',
  })
  check('impl replay still succeeds', result2.status === 'success', JSON.stringify(result2))
  check(
    'impl replay kept the same sha (no empty commit)',
    git(repo, ['rev-parse', 'HEAD']).trim() === shaAfter,
  )
}

// 27. FixAgent handler — really commits its fix.
{
  const storage = makeFakeStorage()
  const logger = makeFakeLogger()
  const { AgentProvider } = await import(
    pathToFileURL(resolve(libBase, 'services', 'agent-provider.js')).href
  )
  const provider = new AgentProvider({}, { logger, config: defaultConfig() })

  const repo = mkTmpDir()
  git(repo, ['init', '--quiet', '--initial-branch', 'main'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'bug.ts'), 'export const broken = true\n', 'utf-8')
  git(repo, ['add', '.'])
  git(repo, ['commit', '--quiet', '-m', 'base'])
  const shaBefore = git(repo, ['rev-parse', 'HEAD']).trim()

  writeFileSync(join(repo, 'bug.ts'), 'export const broken = false\n', 'utf-8')

  const artifactsDir = mkTmpDir()
  const result = await provider.dispatch({
    agentName: 'fix',
    label: 'Fix attempt 1',
    worktreePath: repo,
    artifactsDir,
    inputs: {
      story: { id: 'FIX-1', title: 'Fix bug', description: 'd' },
      task: { taskId: 'T001' },
      fix: { attempt: 1 },
    },
    taskId: 'T001',
  })
  check('fix dispatch succeeds', result.status === 'success', JSON.stringify(result))
  check(
    'fix created a REAL commit',
    git(repo, ['rev-parse', 'HEAD']).trim() !== shaBefore,
  )
  check(
    'fix commit message is conventional fix',
    git(repo, ['log', '-1', '--pretty=%s']).trim() === 'fix(T001): address failure on attempt 1',
    git(repo, ['log', '-1', '--pretty=%s']).trim(),
  )
  check(
    'fix wrote an attempt-scoped artifact',
    existsSync(join(artifactsDir, '10-fix-report-attempt-1.md')),
  )
}
// 28. VerificationAgent — real verdicts.
//     PASS  -> success  (non-empty diff + green suite)
//     PARTIAL -> failed (suite red, recoverable via fixing)
//     REJECT -> blocked (nothing to verify, or suite not runnable)
{
  const storage = makeFakeStorage()
  const logger = makeFakeLogger()
  const { AgentProvider } = await import(
    pathToFileURL(resolve(libBase, 'services', 'agent-provider.js')).href
  )
  const provider = new AgentProvider({}, { logger, config: defaultConfig() })

  /** Repo on `feat` with one content commit beyond main. */
  function mkFeatRepo(testScript) {
    const dir = mkTmpDir()
    git(dir, ['init', '--quiet', '--initial-branch', 'main'])
    git(dir, ['config', 'user.email', 't@e.com'])
    git(dir, ['config', 'user.name', 'T'])
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: testScript ? { test: testScript } : {} }),
      'utf-8',
    )
    writeFileSync(join(dir, 'main.ts'), 'export const a = 1\n', 'utf-8')
    git(dir, ['add', '.'])
    git(dir, ['commit', '--quiet', '-m', 'base'])
    git(dir, ['checkout', '--quiet', '-b', 'feat'])
    writeFileSync(join(dir, 'feat.ts'), 'export const b = 2\n', 'utf-8')
    git(dir, ['add', '.'])
    git(dir, ['commit', '--quiet', '-m', 'add feat'])
    return dir
  }

  // --- PASS: non-empty diff + green suite ---
  {
    const repo = mkFeatRepo('node -e "process.exit(0)"')
    const artifactsDir = mkTmpDir()
    const r = await provider.dispatch({
      agentName: 'verification',
      label: 'Verification',
      worktreePath: repo,
      artifactsDir,
      inputs: { story: { id: 'V-PASS', title: 't', description: 'd' } },
    })
    check('verify PASS -> status success', r.status === 'success', JSON.stringify(r))
    const report = readFileSync(join(artifactsDir, '11-verify-report.md'), 'utf-8')
    check('verify report contains [VERIFY_PASS]', report.includes('[VERIFY_PASS]'))
    check('verify report has a real commit sha', /[0-9a-f]{40}/.test(report))
    check('verify report lists feat.ts', report.includes('feat.ts'))
    check('verify report does NOT say stub', !/\bstub\b/i.test(report), report.slice(0, 200))
  }

  // --- PARTIAL: suite red -> failed (runner maps this to `fixing`) ---
  {
    const repo = mkFeatRepo('node -e "process.exit(1)"')
    const artifactsDir = mkTmpDir()
    const r = await provider.dispatch({
      agentName: 'verification',
      label: 'Verification',
      worktreePath: repo,
      artifactsDir,
      inputs: { story: { id: 'V-PARTIAL', title: 't', description: 'd' } },
    })
    check('verify PARTIAL -> status failed', r.status === 'failed', JSON.stringify(r))
    check(
      'verify PARTIAL reason names the failing check',
      /PARTIAL/.test(r.reason ?? ''),
      String(r.reason),
    )
    const report = readFileSync(join(artifactsDir, '11-verify-report.md'), 'utf-8')
    check('verify report contains [VERIFY_PARTIAL]', report.includes('[VERIFY_PARTIAL]'))
  }

  // --- REJECT: no changes on the branch ---
  {
    const dir = mkTmpDir()
    git(dir, ['init', '--quiet', '--initial-branch', 'main'])
    git(dir, ['config', 'user.email', 't@e.com'])
    git(dir, ['config', 'user.name', 'T'])
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf-8',
    )
    git(dir, ['add', '.'])
    git(dir, ['commit', '--quiet', '-m', 'only commit'])

    const artifactsDir = mkTmpDir()
    const r = await provider.dispatch({
      agentName: 'verification',
      label: 'Verification',
      worktreePath: dir,
      artifactsDir,
      inputs: { story: { id: 'V-REJECT', title: 't', description: 'd' } },
    })
    check(
      'verify REJECT (no diff) -> status failed (design routes REJECT to fixing)',
      r.status === 'failed',
      JSON.stringify(r),
    )
    check(
      'verify REJECT (no diff) reason mentions no changes',
      /no changes/i.test(r.reason ?? ''),
      String(r.reason),
    )
    const rejectReport1 = readFileSync(join(artifactsDir, '11-verify-report.md'), 'utf-8')
    check('verify REJECT (no diff) report contains [VERIFY_REJECT]', rejectReport1.includes('[VERIFY_REJECT]'))
  }

  // --- REJECT: suite not runnable (no test manifest) ---
  {
    const dir = mkTmpDir()
    git(dir, ['init', '--quiet', '--initial-branch', 'main'])
    git(dir, ['config', 'user.email', 't@e.com'])
    git(dir, ['config', 'user.name', 'T'])
    writeFileSync(join(dir, 'a.txt'), 'x\n', 'utf-8')
    git(dir, ['add', '.'])
    git(dir, ['commit', '--quiet', '-m', 'base'])
    git(dir, ['checkout', '--quiet', '-b', 'feat'])
    writeFileSync(join(dir, 'b.txt'), 'y\n', 'utf-8')
    git(dir, ['add', '.'])
    git(dir, ['commit', '--quiet', '-m', 'add b'])

    const artifactsDir = mkTmpDir()
    const r = await provider.dispatch({
      agentName: 'verification',
      label: 'Verification',
      worktreePath: dir,
      artifactsDir,
      inputs: { story: { id: 'V-NOMANIFEST', title: 't', description: 'd' } },
    })
    check(
      'verify REJECT (no manifest) -> status failed (design routes REJECT to fixing)',
      r.status === 'failed',
      JSON.stringify(r),
    )
    const report = readFileSync(join(artifactsDir, '11-verify-report.md'), 'utf-8')
    check('verify REJECT report contains [VERIFY_REJECT]', report.includes('[VERIFY_REJECT]'))
  }
}

// 25. AgentProvider.dispatch — appends agent_dispatch + agent_result to
//     trajectory. This is the end-to-end proof that the StoryRunner's
//     "every agent call is logged" property holds for one specific call.
{
  const storage = makeFakeStorage()
  const logger = makeFakeLogger()
  const { TrajectoryRecorder } = await import(
    pathToFileURL(resolve(libBase, 'services', 'trajectory.js')).href
  )
  const { AgentProvider } = await import(
    pathToFileURL(resolve(libBase, 'services', 'agent-provider.js')).href
  )
  const { ContextAgent } = await import(
    pathToFileURL(resolve(libBase, 'agents', 'context.js')).href
  )
  const trajectory = new TrajectoryRecorder(null, { storage, logger })

  // AgentProvider only requires `logger` and `config`.
  const config = defaultConfig()

  // Build AgentProvider with a no-op ctx (subagents=null so stub path runs).
  const provider = new AgentProvider({}, { logger, config, trajectory })
  // Override the single ContextAgent registration to a deterministic handler.
  provider.register('context', new ContextAgent(), async () => ({
    status: 'success', summary: 'mock context',
  }))

  const artifactsDir = mkTmpDir()
  const result = await provider.dispatch({
    agentName: 'context',
    label: 'context: test',
    worktreePath: artifactsDir,
    artifactsDir,
    inputs: { story: { id: 'DISPATCH-1', title: 't', description: 'd' } },
  })
  check('dispatch returns success', result.status === 'success', JSON.stringify(result))
  await new Promise((r) => setTimeout(r, 30))

  const events = trajectory.listForStory('DISPATCH-1')
  check('exactly 2 trajectory events for one dispatch', events.length === 2, JSON.stringify(events))
  check('event[0] kind = agent_dispatch', events[0]?.kind === 'agent_dispatch')
  check(
    'event[0] payload.agent = context',
    events[0]?.payload?.agent === 'context',
  )
  check('event[1] kind = agent_result', events[1]?.kind === 'agent_result')
  check(
    'event[1] payload.result.status = success',
    events[1]?.payload?.result?.status === 'success',
  )
}

// 29. ClarificationAgent — the HARD-GATE (B-4) really closes.
//     A bounded story advances; an ambiguous one parks for a human.
{
  const storage = makeFakeStorage()
  const logger = makeFakeLogger()
  const { AgentProvider } = await import(
    pathToFileURL(resolve(libBase, 'services', 'agent-provider.js')).href
  )
  const provider = new AgentProvider({}, { logger, config: defaultConfig() })
  const artifactsDir = mkTmpDir()

  // --- bounded ---
  const good = await provider.dispatch({
    agentName: 'clarification',
    label: 'Clarification',
    worktreePath: artifactsDir,
    artifactsDir,
    inputs: {
      story: {
        id: 'CLR-OK',
        title: 'Add refund endpoint',
        description:
          'Expose a POST endpoint that records a refund against an existing payment.',
        acceptanceCriteria:
          '1. POST /refunds with a valid payment id returns 201 and persists the refund\n' +
          '2. POST /refunds with an unknown payment id returns 404',
      },
    },
  })
  check('clarify bounded -> status success', good.status === 'success', JSON.stringify(good))
  const okReport = readFileSync(join(artifactsDir, '02-clarification.md'), 'utf-8')
  check('clarify bounded report says CLASSIFICATION: bounded', okReport.includes('CLASSIFICATION: bounded'))
  check('clarify bounded report has [CLARIFICATION_COMPLETE]', okReport.includes('[CLARIFICATION_COMPLETE]'))
  check('clarify bounded report has no stub marker', !/\bstub\b/i.test(okReport))

  // --- unbounded (vague criterion) ---
  const bad = await provider.dispatch({
    agentName: 'clarification',
    label: 'Clarification',
    worktreePath: artifactsDir,
    artifactsDir,
    inputs: {
      story: {
        id: 'CLR-BAD',
        title: 'Improve things',
        description: 'Make the system better in various ways as needed.',
        acceptanceCriteria: '1. Handle the usual cases etc',
      },
    },
  })
  check('clarify unbounded -> status blocked', bad.status === 'blocked', JSON.stringify(bad))
  check(
    'clarify unbounded reason counts the questions',
    /blocking question/.test(bad.reason ?? ''),
    String(bad.reason),
  )
  const badReport = readFileSync(join(artifactsDir, '02-clarification.md'), 'utf-8')
  check('clarify unbounded report says CLASSIFICATION: unbounded', badReport.includes('CLASSIFICATION: unbounded'))
  check('clarify unbounded report has [CLARIFICATION_BLOCKED]', badReport.includes('[CLARIFICATION_BLOCKED]'))
  check(
    'clarify unbounded report lists the vague terms',
    badReport.includes('Vague Terms Detected'),
    badReport.slice(0, 400),
  )

  // --- unbounded (no acceptance criteria at all) ---
  const noAc = await provider.dispatch({
    agentName: 'clarification',
    label: 'Clarification',
    worktreePath: artifactsDir,
    artifactsDir,
    inputs: {
      story: {
        id: 'CLR-NOAC',
        title: 'Something',
        description: 'A description that is long enough to clear the length gate.',
      },
    },
  })
  check('clarify missing AC -> status blocked', noAc.status === 'blocked', JSON.stringify(noAc))
  check(
    'clarify missing AC reason asks for acceptance criteria',
    /acceptance criteria/i.test(noAc.reason ?? ''),
    String(noAc.reason),
  )
}

// ---- Summary -----------------------------------------------------------

process.stdout.write(`\nM5 integration tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1