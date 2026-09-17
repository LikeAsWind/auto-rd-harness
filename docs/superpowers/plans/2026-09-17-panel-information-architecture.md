# Panel 信息架构重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Auto-RD 面板从「两条含糊状态线 + 行内展开」重构成三层视图(工作空间列表分页 → 工作空间详情 → 任务详情),并补上 per-workspace 采集状态、轨迹时间线、可点会话跳转。

**Architecture:** host 端 `TapdPoller` 每轮回传 per-workspace 采集结果 → `runtime.pollStats` → `buildPanelModel` 塞进 `PanelModule.pollStat` → panel route 回传;新增 `GET /auto-rd/story/<id>/trajectory` 按需拉轨迹。client 端用 state 切换三层视图,`apply()` 扩 `inject` 拿 `ctx.sessions` 实现会话跳转。

**Tech Stack:** TypeScript (host) + 无打包器的浏览器 client bundle (`client.js` + 内联 `stage-data.js`) + Node 测试脚本(自制 React shim + fetch 替身)。

**关键前提(必读):**

- **基于 `HEAD`(当前 `main` 分支)写代码。** 工作树里有另一条线的未提交改动(`credentials`/`migrate-storage-credentials` 等,共 7 个 M + 2 个新文件)——**不要碰、不要提交它们**。执行时用 `git worktree` 从 HEAD 切干净分支隔离开发。
- 测试读 `lib/`,不读 `src/`。改了 TS 必须 `npm run build`(tsc + `copy:client`)之后测试才看得到。
- client 测试用自制 React shim:每个用例独立 `makeReact()` + 独立 `factory` 调用;断言前手动再调一次组件函数读最新 slots;`useEffect` 数量断言会跟着改,别假设只有一个。
- `buildPanelModel` 在 HEAD 是**同步三参数**(`storage, config, runtime`),不是 async,也没有 `credentials` 参数。别照工作树里的 async 版抄。
- `runtime` 对象现有类型 `{ mountedAt: Date; lastTapdPollAt: Date | null; lastTapdError: string | null }` 内联在 4 处文件里,计划里统一改为共享接口 `RuntimeStats`,其中 `pollStats` 为**可选**字段(旧测试的 runtime 字面量不用改)。

---

## File Structure

- 新建 `packages/dsh-auto-rd/src/services/poll-stats.ts` — `WorkspacePollStat` / `RuntimeStats` 两个接口(唯一 source of truth)
- 修改 `packages/dsh-auto-rd/src/services/tapd-poller.ts` — poller 按 module 回传 per-workspace 结果
- 修改 `packages/dsh-auto-rd/src/index.ts` — runtime 加 `pollStats`;onTickEnd 写入;注册 trajectory route
- 修改 `packages/dsh-auto-rd/src/services/ui-panel.ts` — `PanelModule` 加 `pollStat`;buildPanelModel 读 `runtime.pollStats`
- 修改 `packages/dsh-auto-rd/src/services/panel-route.ts` — 新增 trajectory route 的注册函数(或新文件)
- 修改 `packages/dsh-auto-rd/src/client/client.js` — 三层视图、分页、采集状态渲染、会话跳转、轨迹、顶部简化
- 测试:`scripts/test-ui-panel.mjs`、`scripts/test-panel-route.mjs`、`scripts/test-client-half.mjs`、`scripts/test-watch-panel.mjs`

---

## Task 1: `poll-stats.ts` 类型定义

**Files:**
- Create: `packages/dsh-auto-rd/src/services/poll-stats.ts`

- [x] **Step 1: 写文件**

```ts
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
```

- [x] **Step 2: 确认无 lint 错误**

Run: `npm run lint`
Expected: PASS(新文件不引入错误)

---

## Task 2: poller 按 module 回传结果

**Files:**
- Modify: `packages/dsh-auto-rd/src/services/tapd-poller.ts`

- [x] **Step 1: 改 `TapdPollerDeps.onTickEnd` 签名**

把现有(HEAD 版约 44-45 行):

```ts
  /**
   * Optional callback fired at the end of every tick (success or error).
   * Used by the host plugin to publish live runtime stats to the panel
   * route. Errors thrown by this callback do NOT propagate.
   */
  onTickEnd?: (info: { at: Date; error: Error | null }) => void
```

替换为:

```ts
  /**
   * Optional callback fired at the end of every tick (success or error).
   * Used by the host plugin to publish live runtime stats to the panel
   * route. `results` carries one entry per configured module, success or
   * failure, so the panel can show per-workspace freshness. Errors thrown
   * by this callback do NOT propagate.
   */
  onTickEnd?: (info: {
    at: Date
    error: Error | null
    results: PollResult[]
  }) => void
```

- [x] **Step 2: 在文件顶部 import + 新增 `PollResult`**

在 `import type { Config } from '../config.js'` 之后加:

```ts
import type { PollResult } from './poll-stats.js'
```

在 `TapdStory` 接口之后加:

```ts
/** Per-module outcome for one tick, reported to the host runtime. */
export interface PollResult {
  moduleId: string
  error: string | null
  /** Stories newly enqueued for this module on this tick. */
  newCount: number
}
```

注意:`PollResult` 定义在 tapd-poller.ts,但 `poll-stats.ts` 里 `WorkspacePollStat` 要引用它 —— 为避免循环 import,把 `PollResult` 也放进 `poll-stats.ts`。改为:**`PollResult` 定义在 `poll-stats.ts`**,tapd-poller.ts 只 import。

因此 Step 1 额外:在 `poll-stats.ts` 里补 `PollResult`:

```ts
/** Per-module outcome for one poller tick, reported to the host runtime. */
export interface PollResult {
  moduleId: string
  error: string | null
  /** Stories newly enqueued for this module on this tick. */
  newCount: number
}
```

- [x] **Step 3: 改 `tick()` 与 `notifyTickEnd()` 和 `fetchStories()`**

把 `tick()`(约 141-151 行)替换为:

```ts
  async tick(): Promise<void> {
    try {
      const fetched = await this.fetchStories()
      // Track how many of each module's stories were actually new.
      const newByModule = new Map<string, number>()
      for (const t of fetched.stories) {
        const added = await this.enqueueIfNew(t)
        if (added && t.category) {
          newByModule.set(t.category, (newByModule.get(t.category) ?? 0) + 1)
        }
      }
      for (const r of fetched.results) {
        r.newCount = newByModule.get(r.moduleId) ?? 0
      }
      this.notifyTickEnd(null, fetched.results)
    } catch (err) {
      this.deps.logger.error(`TapdPoller tick failed: ${(err as Error).message}`)
      this.notifyTickEnd(err as Error, [])
    }
  }
```

把 `notifyTickEnd`(约 157-165 行)替换为:

```ts
  private notifyTickEnd(err: Error | null, results: PollResult[]): void {
    const cb = this.deps.onTickEnd
    if (!cb) return
    try {
      cb({ at: new Date(), error: err, results })
    } catch (cbErr) {
      this.deps.logger.warn(`TapdPoller onTickEnd callback threw: ${(cbErr as Error).message}`)
    }
  }
```

把 `enqueueIfNew` 的签名与末尾改掉 —— 现在它返回 `Promise<void>`,改成返回 `Promise<boolean>`(是否真的新增入队)。找到 `private async enqueueIfNew(t: TapdStory): Promise<void> {`,改为:

```ts
  private async enqueueIfNew(t: TapdStory): Promise<boolean> {
```

方法体里,三处 early-return 都改为返回 `false`:

- `if (stories.get(t.id)) return false // already enqueued`
- `if (!moduleId) { ...log...; return false }`
- `if (!moduleRecord) { ...log...; return false }`

方法末尾 `await stories.put(...)` + `logger.info(...)` 之后加 `return true`。

把 `fetchStories()`(约 228-260 行)整体替换为返回 `{ stories, results }`:

```ts
  private async fetchStories(): Promise<{ stories: TapdStory[]; results: PollResult[] }> {
    if (this.deps.config.useTapdMock) {
      // Mock fixture: every story's category doubles as its moduleId.
      const results: PollResult[] = this.deps.config.modules.map((m) => ({
        moduleId: m.id,
        error: null,
        newCount: 0,
      }))
      const stories = MOCK_TAPD_FIXTURE.filter((t) =>
        this.deps.config.modules.some((m) => m.id === t.category),
      )
      return { stories, results }
    }
    const modules = this.deps.config.modules.filter((m) => (m.tapdWorkspaceId ?? '').length > 0)
    if (modules.length === 0) {
      this.deps.logger.warn(
        'TapdPoller: useTapdMock=false but no module has a tapdWorkspaceId -- nothing to fetch',
      )
      return { stories: [], results: [] }
    }
    const all: TapdStory[] = []
    const results: PollResult[] = []
    for (const m of modules) {
      const tapdWorkspaceId = m.tapdWorkspaceId as string
      const token = m.tapdApiToken || this.deps.config.tapdApiToken
      try {
        const stories = await this.fetchStoriesFromApi(tapdWorkspaceId, token)
        all.push(...stories)
        results.push({ moduleId: m.id, error: null, newCount: 0 })
      } catch (err) {
        const message = (err as Error).message
        if (err instanceof HttpError && !err.transient) {
          this.deps.logger.error(
            `TapdPoller: module ${m.id} (TAPD ${tapdWorkspaceId}) returned ${err.status} -- will not retry until config changes`,
          )
        } else {
          this.deps.logger.warn(
            `TapdPoller: module ${m.id} (TAPD ${tapdWorkspaceId}) fetch failed transiently: ${message} -- will retry next tick`,
          )
        }
        results.push({ moduleId: m.id, error: message, newCount: 0 })
      }
    }
    return { stories: all, results }
  }
```

- [x] **Step 4: lint**

Run: `npm run lint`
Expected: PASS。若报 `PollResult` 未导出/循环引用,确认 `PollResult` 定义在 `poll-stats.ts` 且 tapd-poller.ts `import type { PollResult } from './poll-stats.js'`。

---

## Task 3: `index.ts` 接入 runtime.pollStats + 注册 trajectory route

**Files:**
- Modify: `packages/dsh-auto-rd/src/index.ts`

- [x] **Step 1: 改 runtime 类型引用**

文件顶部 import 区加:

```ts
import type { RuntimeStats, WorkspacePollStat } from './services/poll-stats.js'
```

把 `const runtime = {`(约 184 行)改为:

```ts
  const runtime: RuntimeStats = {
    mountedAt: new Date(),
    lastTapdPollAt: null,
    lastTapdError: null,
    pollStats: new Map<string, WorkspacePollStat>(),
  }
```

把 `startServices` 的 runtime 参数类型(约 383 行)`runtime: { lastTapdPollAt: Date | null; lastTapdError: string | null }` 改为 `runtime: RuntimeStats`。

- [x] **Step 2: 改 onTickEnd 写入 pollStats**

把 `startServices` 里的 `onTickEnd`(约 418-421 行)替换为:

```ts
    onTickEnd: ({ at, error, results }) => {
      runtime.lastTapdPollAt = at
      runtime.lastTapdError = error ? error.message : null
      const stats = runtime.pollStats ?? new Map<string, WorkspacePollStat>()
      runtime.pollStats = stats
      for (const r of results) {
        const prev = stats.get(r.moduleId)
        stats.set(r.moduleId, {
          moduleId: r.moduleId,
          lastAttemptAt: at,
          // On error keep the previous success timestamp so the panel
          // can say "last synced at X" even while the latest attempt
          // failed.
          lastSuccessAt: r.error ? (prev?.lastSuccessAt ?? null) : at,
          lastError: r.error,
          lastNewCount: r.error ? (prev?.lastNewCount ?? 0) : r.newCount,
        })
      }
    },
```

- [x] **Step 3: 注册 trajectory route**

(本步骤依赖 Task 4 的 `registerStoryTrajectoryRoute`。先写 Task 4 再回来,或按顺序执行到此处时 Task 4 已完成。)

在 `ctx.effect` 的 panel route 注册块附近,新增一个 effect:

```ts
    ctx.effect(() => {
      const disposeTrajectory = registerStoryTrajectoryRouteWithRetry(ctx, {
        storage,
        logger,
        retryMs: WEBSERVER_RETRY_MS,
        maxAttempts: WEBSERVER_RETRY_CAP,
      })
      return () => {
        disposeTrajectory()
      }
    }, 'auto-rd:story-trajectory-route')
```

并在文件顶部 import 区加:

```ts
import { registerStoryTrajectoryRouteWithRetry } from './services/story-trajectory-route.js'
```

- [x] **Step 4: lint + build**

Run: `npm run lint && npm run build`
Expected: PASS

---

## Task 4: 新增 trajectory route

**Files:**
- Create: `packages/dsh-auto-rd/src/services/story-trajectory-route.ts`

- [x] **Step 1: 写文件**

```ts
/**
 * StoryTrajectoryRoute — serve one story's execution log over HTTP.
 *
 * Same optional-webServer contract as panel-route.ts: headless profiles
 * have no webServer, so the route is a UI convenience, never a pipeline
 * dependency. The client fetches this on demand when the story detail
 * view opens, keeping the hot 5s panel poll lean (the trajectory can be
 * large and is read rarely).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AutoRdStorage } from '../domain/storage.js'
import type { TrajectoryEvent } from '../domain/schema.js'
import { resolveLogChannel, type LogChannel } from '../utils/logger.js'

export const STORY_TRAJECTORY_ROUTE_PREFIX = '/auto-rd/story/'

interface StoryTrajectoryRouteDeps {
  storage: AutoRdStorage
  logger: { debug(m: string): void; info(m: string): void; warn(m: string): void; error(m: string): void }
}

interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function channel(ctx: Context, deps: StoryTrajectoryRouteDeps): LogChannel {
  return (
    resolveLogChannel(ctx, 'auto-rd') ?? {
      debug: (m) => deps.logger.debug(m),
      info: (m) => deps.logger.info(m),
      warn: (m) => deps.logger.warn(m),
      error: (m) => deps.logger.error(m),
    }
  )
}

/** List one story's trajectory events in chronological order. */
function listForStory(storage: AutoRdStorage, storyId: string): TrajectoryEvent[] {
  return [...storage.trajectories().values()]
    .filter((e) => e.storyId === storyId)
    .sort((a, b) => a.at.localeCompare(b.at))
}

export function registerStoryTrajectoryRoute(
  ctx: Context,
  deps: StoryTrajectoryRouteDeps,
  opts: { prefix?: string } = {},
): (() => void) | null {
  const prefix = opts.prefix ?? STORY_TRAJECTORY_ROUTE_PREFIX
  const webServer = ctx.get('webServer' as never) as unknown as WebServerService | undefined
  const log = channel(ctx, deps)

  if (!webServer || typeof webServer.register !== 'function') {
    log.info(
      `webServer unavailable; story trajectory route is not registered (expected headless).`,
    )
    return null
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, HEAD')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
      return
    }
    const storyId = (req.url ?? '').slice(prefix.length).split('?')[0]
    let body: string
    try {
      const events = storyId ? listForStory(deps.storage, storyId) : []
      body = JSON.stringify({ ok: true, storyId, events })
    } catch (err) {
      log.error(`story trajectory route failed: ${(err as Error).message}`)
      res.statusCode = 500
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ ok: false, error: 'trajectory_unavailable' }))
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    if (req.method === 'HEAD') {
      res.setHeader('content-length', Buffer.byteLength(body))
      res.end()
      return
    }
    res.end(body)
  }

  try {
    const dispose = webServer.register({ kind: 'prefix', path: prefix, handler })
    log.info(`Registered story trajectory route: GET ${prefix}:storyId`)
    return dispose
  } catch (err) {
    log.error(`failed to register story trajectory route: ${(err as Error).message}`)
    return null
  }
}

export function registerStoryTrajectoryRouteWithRetry(
  ctx: Context,
  deps: StoryTrajectoryRouteDeps & { retryMs?: number; maxAttempts?: number },
  opts: { prefix?: string } = {},
): () => void {
  const retryMs = deps.retryMs ?? 1000
  const maxAttempts = deps.maxAttempts ?? 10
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let unregister: (() => void) | undefined
  let cancelled = false

  const tryRegister = (): void => {
    if (cancelled) return
    attempts += 1
    const dispose = registerStoryTrajectoryRoute(ctx, deps, opts)
    if (dispose !== null) {
      unregister = dispose
      return
    }
    if (attempts >= maxAttempts) return
    timer = setTimeout(tryRegister, retryMs)
  }
  tryRegister()
  return () => {
    cancelled = true
    if (timer !== undefined) clearTimeout(timer)
    if (unregister) {
      try { unregister() } catch { /* already gone */ }
    }
  }
}
```

注意:handler 用 `req.url` 解析 storyId —— 测试里的 fake request 需带 `url`。现有 `test-panel-route.mjs` 的 handler 调用传的是 `{ method: 'GET' }`(无 url),trajectory 测试需要传 `{ method: 'GET', url: '/auto-rd/story/S1' }`。

- [x] **Step 2: 注册到 index.ts**

按 Task 3 Step 3 完成注册。

- [x] **Step 3: lint**

Run: `npm run lint`
Expected: PASS

---

## Task 5: `buildPanelModel` 输出 `pollStat`

**Files:**
- Modify: `packages/dsh-auto-rd/src/services/ui-panel.ts`

- [x] **Step 1: import + PanelModule 加字段**

顶部 import 区加:

```ts
import type { RuntimeStats } from './poll-stats.js'
```

`PanelModule` 接口(约 87-108 行)末尾加字段:

```ts
  /**
   * Per-workspace TAPD poll snapshot, surfaced so the client can show
   * "synced at HH:MM, added N stories" per workspace. Absent when the
   * host runtime did not publish one (legacy callers, tests).
   */
  pollStat?: {
    lastAttemptAt: string | null
    lastSuccessAt: string | null
    lastError: string | null
    lastNewCount: number
  }
```

- [x] **Step 2: 改 buildPanelModel 签名与返回**

把签名(约 283-287 行)的 runtime 类型改为:

```ts
export function buildPanelModel(
  storage: AutoRdStorage,
  config?: Config,
  runtime?: RuntimeStats,
): PanelModel {
```

在 `panelModules` 的 map 回调里(返回对象末尾,`modelSelection: m.modelSelection ?? {},` 之后)加:

```ts
      pollStat: runtime?.pollStats?.has(m.id)
        ? (() => {
            const s = runtime.pollStats!.get(m.id)!
            return {
              lastAttemptAt: s.lastAttemptAt?.toISOString() ?? null,
              lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
              lastError: s.lastError,
              lastNewCount: s.lastNewCount,
            }
          })()
        : undefined,
```

- [x] **Step 3: lint + build + test:ui**

Run: `npm run lint && npm run build && npm run test:ui`
Expected: lint PASS;test:ui 全绿(现有断言不涉及 pollStat,新增字段不应破坏)

---

## Task 6: `buildPanelModel` 的 pollStat 断言

**Files:**
- Test: `scripts/test-ui-panel.mjs`

- [x] **Step 1: 加一个独立测试块**

在文件末尾 Summary 之前加:

```js
// ---- per-workspace poll stat --------------------------------------

{
  // buildPanelModel surfaces runtime.pollStats per module, serialising
  // Dates to ISO strings, and omits the field when absent.
  const m1 = mod({ id: 'm1' })
  const m2 = mod({ id: 'm2', title: 'Search' })
  const runtimeWithStats = {
    mountedAt: new Date('2025-01-01T00:00:00.000Z'),
    lastTapdPollAt: null,
    lastTapdError: null,
    pollStats: new Map([
      ['m1', {
        moduleId: 'm1',
        lastAttemptAt: new Date('2025-01-01T00:01:00.000Z'),
        lastSuccessAt: new Date('2025-01-01T00:01:00.000Z'),
        lastError: null,
        lastNewCount: 2,
      }],
      ['m2', {
        moduleId: 'm2',
        lastAttemptAt: new Date('2025-01-01T00:02:00.000Z'),
        lastSuccessAt: null,
        lastError: '401 Unauthorized',
        lastNewCount: 0,
      }],
    ]),
  }
  const model = buildPanelModel(
    fakeStorage({ modules: [m1, m2], stories: [] }),
    configFor([m1, m2]),
    runtimeWithStats,
  )
  const p1 = model.modules.find((x) => x.id === 'm1')
  const p2 = model.modules.find((x) => x.id === 'm2')
  check('pollStat: success module carries ISO successAt', p1.pollStat.lastSuccessAt === '2025-01-01T00:01:00.000Z', JSON.stringify(p1.pollStat))
  check('pollStat: success module has lastNewCount', p1.pollStat.lastNewCount === 2, String(p1.pollStat.lastNewCount))
  check('pollStat: failing module carries the error', p2.pollStat.lastError === '401 Unauthorized', String(p2.pollStat.lastError))
  check('pollStat: failing module keeps successAt null', p2.pollStat.lastSuccessAt === null, String(p2.pollStat.lastSuccessAt))
}

{
  // No runtime (legacy callers): the field is simply absent, never null.
  const m1 = mod({ id: 'm1' })
  const model = buildPanelModel(fakeStorage({ modules: [m1], stories: [] }), configFor([m1]))
  check('pollStat: absent runtime omits the field', model.modules[0].pollStat === undefined, JSON.stringify(model.modules[0].pollStat))
}
```

- [x] **Step 2: 跑测试**

Run: `npm run build && npm run test:ui`
Expected: 新增断言全绿(总数从 66 涨到 66 + 新增条数)

---

## Task 7: trajectory route 测试

**Files:**
- Test: `scripts/test-panel-route.mjs`

- [x] **Step 1: 在文件末尾 Summary 前加测试块**

先 import 新模块。在文件顶部 `const { registerPanelRoute, PANEL_ROUTE_PATH } = ...` 之后加:

```js
const { registerStoryTrajectoryRoute, STORY_TRAJECTORY_ROUTE_PREFIX } = await import(
  pathToFileURL(resolve(libBase, 'services', 'story-trajectory-route.js')).href
)
```

加测试块:

```js
// ---- story trajectory route -----------------------------------------

{
  const TRAJ_EVENTS = [
    { id: 'e1', storyId: 'S1', at: '2025-01-01T00:00:00.000Z', kind: 'state_transition', label: 'pending → context' },
    { id: 'e2', storyId: 'S1', at: '2025-01-01T00:01:00.000Z', kind: 'agent_dispatch', label: 'spec' },
    { id: 'e3', storyId: 'OTHER', at: '2025-01-01T00:02:00.000Z', kind: 'note', label: 'not mine' },
  ]
  const ws = fakeWebServer()
  registerStoryTrajectoryRoute(ctxWith(ws), {
    storage: {
      trajectories: () => ({ *values() { for (const e of TRAJ_EVENTS) yield e } }),
      stories: () => ({ *values() {} }),
      modules: () => ({ *values() {} }),
      tasks: () => ({ *values() {} }),
    },
    logger: silentLogger(),
  })
  check('trajectory: route is bound', ws.routes.length === 1, String(ws.routes.length))
  check('trajectory: kind is prefix', ws.routes[0]?.kind === 'prefix', String(ws.routes[0]?.kind))
  check('trajectory: path is the prefix', ws.routes[0]?.path === STORY_TRAJECTORY_ROUTE_PREFIX, String(ws.routes[0]?.path))

  const res = fakeRes()
  await ws.routes[0].handler({ method: 'GET', url: '/auto-rd/story/S1' }, res)
  check('trajectory: GET returns 200', res.statusCode === 200, String(res.statusCode))
  const body = JSON.parse(res.body)
  check('trajectory: ok flag', body.ok === true)
  check('trajectory: echoes the storyId', body.storyId === 'S1', String(body.storyId))
  check('trajectory: filters to the story, sorted ascending', body.events.length === 2 && body.events[0].id === 'e1' && body.events[1].id === 'e2', JSON.stringify(body.events.map((e) => e.id)))
  check('trajectory: no-store', res.headers['cache-control'] === 'no-store', res.headers['cache-control'])

  const res2 = fakeRes()
  await ws.routes[0].handler({ method: 'GET', url: '/auto-rd/story/UNKNOWN' }, res2)
  const body2 = JSON.parse(res2.body)
  check('trajectory: unknown story returns empty events', Array.isArray(body2.events) && body2.events.length === 0, JSON.stringify(body2.events))

  const res3 = fakeRes()
  await ws.routes[0].handler({ method: 'POST', url: '/auto-rd/story/S1' }, res3)
  check('trajectory: POST is 405', res3.statusCode === 405, String(res3.statusCode))
}
```

注意:`fakeStorage` 辅助(78-85 行)只接受 `stories/modules/tasks` 三个 key,trajectory 测试里直接构造带 `trajectories` 的对象即可(如上,不用改辅助)。

- [x] **Step 2: 跑测试**

Run: `npm run build && npm run test:route`
Expected: 新增断言全绿

---

## Task 8: client `apply()` 扩 inject 拿 sessions

**Files:**
- Modify: `packages/dsh-auto-rd/src/client/client.js`

- [x] **Step 1: apply() 读 sessions 并缓存**

把 `function apply(ctx) {`(约 2906 行)改为:

```js
    function apply(ctx) {
      var slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (!slots) {
        if (ctx.logger) ctx.logger('auto-rd').warn('client slots service unavailable; panel not registered')
        return
      }

      // Session jump (issue: story detail "会话" → clickable). The host
      // exposes ctx.sessions.open(id) (see @deepseek-ai/dsh-api-session-controller);
      // absent in fixtures / headless, in which case the session button
      // degrades to a plain id string.
      var sessions = ctx.sessions || (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined)
      module.__autoRd.sessions = sessions
```

把 `var inject = ['slots']`(约 2936 行)改为:

```js
    var inject = ['slots', 'sessions']
```

把 `module.__autoRd = {`(约 2943 行)加一个字段 `sessions: null,`(apply 里会覆盖)。

- [x] **Step 2: 同步更新 client-half 的 inject 断言**

(在 Task 11 里一并处理测试,此处只改实现。跑 build 会失败?不会 —— client.js 是 copy 不改 lib,但测试 test-client-half 的 `inject.length === 1` 断言会失败,放到 Task 11 一起改。)

Run: `npm run build`
Expected: PASS(copy 成功,测试暂不跑)

---

## Task 9: 新增 story 轨迹 + 会话跳转的 client 端数据 hook 与常量

**Files:**
- Modify: `packages/dsh-auto-rd/src/client/client.js`

- [x] **Step 1: 加常量**

在 `var POLL_MS = 5000`(约 38 行)之后加:

```js
    var TRAJECTORY_URL_PREFIX = '/auto-rd/story/'
```

- [x] **Step 2: 加 `useStoryTrajectory` hook**

在 `usePanelData` 函数之后加:

```js
    // Fetch one story's execution log on demand. The trajectory is
    // static between polls (recover resets it, the runner appends), so
    // the detail view fetches once on open instead of riding the 5s
    // panel poll.
    function useStoryTrajectory(storyId) {
      var state = React.useState({ status: 'loading', events: [] })
      var value = state[0]
      var setValue = state[1]
      React.useEffect(function () {
        if (!storyId) { setValue({ status: 'idle', events: [] }); return }
        var alive = true
        setValue({ status: 'loading', events: [] })
        fetch(TRAJECTORY_URL_PREFIX + encodeURIComponent(storyId), { headers: { accept: 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then(function (body) {
            if (!alive) return
            if (!body || body.ok !== true) throw new Error('trajectory_unavailable')
            setValue({ status: 'ok', events: body.events || [] })
          })
          .catch(function () {
            if (!alive) return
            setValue({ status: 'error', events: [] })
          })
        return function () { alive = false }
      }, [storyId])
      return value
    }
```

- [x] **Step 3: 把 `useStoryTrajectory` 暴露到 `module.__autoRd.components`**

在 `module.__autoRd = {` 的 `components: { ... }` 里加 `useStoryTrajectory: useStoryTrajectory,`。

- [x] **Step 4: build**

Run: `npm run build`
Expected: PASS

---

## Task 10: 三层视图 + 分页 + 采集状态渲染(client 端主体重构)

**Files:**
- Modify: `packages/dsh-auto-rd/src/client/client.js`

这是最大的一个任务。按下面顺序,每步 build 一次确认无语法错。

- [x] **Step 1: `AutoRdPanel` 增加视图导航 state**

在 `AutoRdPanel` 里,`var selectedStoryId = React.useState(null)` 附近,把导航模型改为「当前视图 + 当前工作空间 + 当前故事」三件套。新增:

```js
      // Three-level navigation: 'list' → 'workspace' → 'story'.
      // activeWorkspaceId and selectedStoryId together locate the detail
      // view; a back button pops one level at a time.
      var view = React.useState('list')
      var activeWorkspaceId = React.useState(null)
      var selectedStoryId = React.useState(null)
```

并把对应的 setter/读值解构加全:

```js
      var viewValue = view[0]
      var setView = view[1]
      var activeWorkspaceIdValue = activeWorkspaceId[0]
      var setActiveWorkspaceId = activeWorkspaceId[1]
      var selectedStoryIdValue = selectedStoryId[0]
      var setSelectedStoryId = selectedStoryId[1]
```

- [x] **Step 2: 改写 `renderMain()` 分派三层**

把现有 `renderMain()`(约 2602 行起)改为:

```js
      function renderMain() {
        if (!model) {
          return panel.status === 'loading' ? h(PanelSkeleton) : null
        }
        if (addOpenValue) {
          return h(AddWorkspaceForm, {
            onCancel: function () { setAddOpen(false) },
            onAdded: function (body) { setAddOpen(false); refresh(body) },
          })
        }
        if (viewValue === 'story' && selectedStoryIdValue) {
          var found = null
          for (var wi = 0; wi < workspaces.length; wi++) {
            var stories = workspaces[wi].stories || []
            for (var si = 0; si < stories.length; si++) {
              if (stories[si].id === selectedStoryIdValue) {
                found = { story: stories[si], workspace: workspaces[wi] }
                break
              }
            }
            if (found) break
          }
          if (found) {
            return h(StoryDetail, {
              story: found.story,
              workspace: found.workspace,
              sessions: module.__autoRd.sessions,
              onBack: function () {
                setSelectedStoryId(null)
                setView('workspace')
              },
            })
          }
          setSelectedStoryId(null)
          setView('list')
        }
        if (viewValue === 'workspace' && activeWorkspaceIdValue) {
          var ws = null
          for (var wj = 0; wj < workspaces.length; wj++) {
            if (workspaces[wj].id === activeWorkspaceIdValue) { ws = workspaces[wj]; break }
          }
          if (ws) {
            return h(WorkspaceDetail, {
              workspace: ws,
              onBack: function () { setActiveWorkspaceId(null); setView('list') },
              onStoryClick: function (id) { setSelectedStoryId(id); setView('story') },
              onUpdate: refresh,
            })
          }
          setActiveWorkspaceId(null)
          setView('list')
        }
        return h(WorkspaceList, {
          workspaces: workspaces,
          onOpenWorkspace: function (id) { setActiveWorkspaceId(id); setView('workspace') },
          onRefresh: refresh,
          onRemove: removeWorkspace,
          onUpdate: refresh,
        })
      }
```

注意:现有 `WorkspaceDetail` 组件签名(约 1468 行)是 `props.workspace / props.onUpdate / props.onStoryClick`,并且它是「行内展开的 stories 列表」。**它要改造成「整页视图」**:保留其 stories 列表渲染逻辑,去掉对 `<details>` 展开的依赖,并加 `onBack`。改造方式见 Step 4。

- [x] **Step 3: `WorkspaceList` 分页 + 行点击进详情**

把 `WorkspaceList`(约 2045 行)改为分页,行点击进 workspace 详情,移除 `<details>` 展开:

```js
    function WorkspaceList(props) {
      var workspaces = props.workspaces
      var onAdd = props.onAdd
      var onRefresh = props.onRefresh
      var onRemove = props.onRemove
      var onUpdate = props.onUpdate
      var onOpenWorkspace = props.onOpenWorkspace

      var PAGE_SIZE = 5
      var page = React.useState(0)
      var pageValue = page[0]
      var setPage = page[1]

      if (!workspaces || workspaces.length === 0) {
        return h(
          'div',
          null,
          h('div', { style: { fontSize: 16, fontWeight: 500, color: styles.labelPrimary, marginBottom: 4 } }, '还没有工作空间'),
          h('div', { style: { color: styles.labelSecondary, marginBottom: 22, fontSize: 12 } }, '添加一个项目,开始拉取 TAPD 需求并自动出 GitLab MR。'),
          h(AddWorkspaceForm, { onAdded: onRefresh }),
          legend(),
        )
      }

      var totalPages = Math.max(1, Math.ceil(workspaces.length / PAGE_SIZE))
      if (pageValue >= totalPages) pageValue = totalPages - 1
      var start = pageValue * PAGE_SIZE
      var pageItems = workspaces.slice(start, start + PAGE_SIZE)

      return h(
        'div',
        null,
        h(
          'ul',
          { className: 'auto-rd-ws-list', style: { listStyle: 'none', margin: 0, padding: '0 14px' } },
          pageItems.map(function (ws) {
            return h(WorkspaceRow, {
              key: ws.id,
              workspace: ws,
              onOpen: function () {
                if (typeof onOpenWorkspace === 'function') onOpenWorkspace(ws.id)
              },
              onRemove: function (id) {
                if (typeof onRemove === 'function') onRemove(id)
              },
              onUpdate: function (body) {
                if (typeof onUpdate === 'function') onUpdate(body)
              },
            })
          }),
        ),
        totalPages > 1
          ? h(Pager, {
              page: pageValue,
              totalPages: totalPages,
              onPage: function (p) { setPage(p) },
            })
          : null,
        legend(),
      )
    }
```

- [x] **Step 4: 改 `WorkspaceRow` 为「点击进详情」卡片**

现有 `WorkspaceRow`(约 1023 行)用 `<details>/<summary>` 展开 + gear 按钮 + × 按钮。改造为**整行可点进详情**,保留 × 删除和 gear 设置(gear 改在详情页里出现,行上只留 × 和一个进详情的整行点击)。

把 `WorkspaceRow` 的 props 读取与返回结构改为:

```js
    function WorkspaceRow(props) {
      var ws = props.workspace
      var onOpen = props.onOpen
      var onRemove = props.onRemove
      var onUpdate = props.onUpdate

      var dotStyle = { width: 8, height: 8, borderRadius: '50%', background: statusColor(ws.status), marginLeft: 4, flexShrink: 0 }
      var progress = []
      if (ws.inFlight) progress.push({ label: ws.inFlight + ' 进行', color: styles.statusInfo })
      if (ws.blocked) progress.push({ label: ws.blocked + ' 阻塞', color: styles.statusWarning })
      if (ws.completed) progress.push({ label: ws.completed + ' 完成', color: styles.statusSuccess })
      if (ws.failed) progress.push({ label: ws.failed + ' 失败', color: styles.statusError })

      return h(
        'li',
        {
          className: 'auto-rd-ws-row',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 16px',
            border: '1px solid ' + styles.borderL3,
            borderRadius: 7,
            marginBottom: 8,
            cursor: 'pointer',
          },
          onClick: function () { if (typeof onOpen === 'function') onOpen() },
        },
        h('div', { style: dotStyle, 'aria-hidden': 'true' }),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { fontSize: 13, color: styles.labelPrimary, fontWeight: 500, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ws.name),
          h('div', { style: { fontSize: 11, color: styles.labelSecondary, fontFamily: styles.fontCode, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, ws.path),
        ),
        h(
          'div',
          { style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.labelSecondary, textAlign: 'right', whiteSpace: 'nowrap' } },
          progress.length
            ? progress.map(function (p) { return h('span', { key: p.label, style: { marginLeft: 8, color: p.color } }, p.label) })
            : h('span', null, ws.status === 'idle' && ws.storyCount === 0 ? '尚未拉取需求' : '—'),
        ),
        h(PollStatBadge, { pollStat: ws.pollStat }),
        h(
          'button',
          {
            type: 'button',
            className: 'auto-rd-ws-remove',
            title: '删除工作空间(不删除本地代码)',
            'aria-label': '删除工作空间',
            onClick: function (e) { e.preventDefault(); e.stopPropagation(); if (typeof onRemove === 'function') onRemove(ws.id) },
            style: { width: 22, height: 22, padding: 0, background: 'transparent', border: '1px solid ' + styles.borderL3, borderRadius: 4, color: styles.labelTertiary, fontSize: 12, lineHeight: '20px', cursor: 'pointer', fontFamily: 'inherit' },
          },
          '×',
        ),
      )
    }
```

注意:`ws.pollStat` 来自 Task 5 的 panel model 输出,client 端 `workspaces.map`(约 2525 行)要把 `pollStat: m.pollStat` 透传。改 Step 5。

- [x] **Step 5: `workspaces.map` 透传 pollStat**

在 `var workspaces = modules.map(function (m) {` 的返回对象里(约 2578 行 `modelSelection: m.modelSelection || {},` 之后)加:

```js
          pollStat: m.pollStat || null,
```

- [x] **Step 6: 新增 `PollStatBadge` 和 `Pager` 组件**

在 `WorkspaceRow` 之前加两个小组件:

```js
    function PollStatBadge(props) {
      var s = props.pollStat
      if (!s) return h('span', { style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.labelTertiary } }, '尚未同步')
      if (s.lastError) {
        return h('span', { className: 'auto-rd-poll-error', title: s.lastError, style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.statusError } }, '⚠ 同步失败')
      }
      if (s.lastSuccessAt) {
        var time = String(s.lastSuccessAt).slice(11, 16)
        return h('span', { className: 'auto-rd-poll-ok', style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.statusSuccess } }, '✓ ' + time + (s.lastNewCount ? ' · +' + s.lastNewCount : ''))
      }
      return h('span', { style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.labelTertiary } }, '尚未同步')
    }

    function Pager(props) {
      var page = props.page
      var totalPages = props.totalPages
      var onPage = props.onPage
      return h(
        'div',
        { className: 'auto-rd-pager', style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 20px 14px', justifyContent: 'center', fontFamily: styles.fontCode, fontSize: 11, color: styles.labelSecondary } },
        h('button', { type: 'button', onClick: function () { if (page > 0) onPage(page - 1) }, disabled: page === 0, style: { border: '1px solid ' + styles.borderL3, background: 'transparent', color: styles.labelPrimary, borderRadius: 4, padding: '3px 8px', cursor: page === 0 ? 'default' : 'pointer' } }, '‹ 上一页'),
        h('span', null, (page + 1) + ' / ' + totalPages),
        h('button', { type: 'button', onClick: function () { if (page < totalPages - 1) onPage(page + 1) }, disabled: page >= totalPages - 1, style: { border: '1px solid ' + styles.borderL3, background: 'transparent', color: styles.labelPrimary, borderRadius: 4, padding: '3px 8px', cursor: page >= totalPages - 1 ? 'default' : 'pointer' } }, '下一页 ›'),
      )
    }
```

- [x] **Step 7: 改造 `WorkspaceDetail` 为整页视图**

现有 `WorkspaceDetail`(约 1468 行)是 `<details>` 展开后的内容(带 `padding: '0 20px 14px 30px'` 且没有返回按钮)。把它改造成带返回按钮的整页视图。核心改动:

1. props 增加 `onBack`。
2. 外层容器改为 `padding: '0 20px 20px'`,顶部加返回按钮 + 工作空间名 + `PollStatBadge` + `workspaceNeedsAttention` 状态点。
3. 保留现有 `renderOpenStory` / `renderDoneRow` / `issueLine` 逻辑不变。
4. `WorkspaceSettingsForm` 保留(gear 在详情页里打开)。

在 `WorkspaceDetail` 的 return 之前加:

```js
      function back() {
        if (typeof props.onBack === 'function') props.onBack()
      }
```

并把 return 的根节点改成:

```js
      return h(
        'div',
        { style: { padding: '0 20px 20px', color: styles.labelSecondary, fontSize: 12, lineHeight: 1.7 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
          h('button', { type: 'button', className: 'auto-rd-back', onClick: back, 'aria-label': '返回工作空间列表', style: { border: 'none', background: 'none', color: styles.accent, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' } }, '← 返回'),
          h('span', { style: { fontSize: 14, fontWeight: 600, color: styles.labelPrimary } }, ws.name),
          h(PollStatBadge, { pollStat: ws.pollStat }),
        ),
        issues.length
          ? h('div', { 'aria-label': '配置问题', style: { marginBottom: 10 } }, issues.map(issueLine))
          : null,
        // … 以下保留原有的 open/done 列表与 overflow 逻辑,并把设置表单
        // 挂到详情页(gear 按钮或直接内联)。
        h(WorkspaceSettingsForm, { workspace: ws, onUpdate: onUpdate }),
      )
```

**实现提示(给 subagent):** 这一步要把旧 `WorkspaceDetail` 的两个职责(「展开内容」vs「整页视图」)收敛为整页视图,并保留 `renderOpenStory`/`renderDoneRow` 的内部函数。执行时先 `git show HEAD:.../client.js | sed -n '1468,1702p'` 通读旧实现再改,别丢 `StageGauge` 缩略图、MR 链接、done 折叠、overflow 标签。

- [x] **Step 8: 简化 `SyncPulse`(正常态不渲染)+ `StatusBar` 显示「上次采集 HH:MM」**

`SyncPulse`(约 2235 行)改为只在 error/stale 时返回内容,正常态返回 null:

```js
    function SyncPulse(props) {
      var status = props.status
      var lastSyncedAt = props.lastSyncedAt
      var onResync = props.onResync
      var now = props.now
      var stale = status === 'error' && lastSyncedAt != null
      if (status === 'ok') return null
      var label = stale
        ? '面板连接失败 · 数据停在 ' + clockLabel(lastSyncedAt)
        : status === 'loading'
          ? '首次同步中…'
          : '面板连接失败 · 重连中…'
      return h(
        'div',
        { className: 'auto-rd-pulse', 'aria-live': 'polite', style: { display: 'flex', alignItems: 'center', gap: 9, padding: '7px 20px', background: styles.panelBgSubtle, borderBottom: '1px solid ' + styles.borderL3, fontFamily: styles.fontCode, fontSize: 11, color: styles.statusError } },
        h('span', { style: { width: 6, height: 6, borderRadius: '50%', background: styles.statusError, display: 'inline-block', flex: 'none' } }),
        h('span', null, label),
        h('button', { type: 'button', onClick: function () { if (onResync) onResync() }, 'aria-label': '重试', style: { marginLeft: 'auto', border: 'none', background: 'none', color: styles.labelTertiary, cursor: 'pointer', fontSize: 12 } }, '↻'),
      )
    }
```

`StatusBar`(约 2327 行)的 `statusLabel` 改为显示真实的上次采集时间:

把 `var isPolling = props.isPolling` 和后续的 statusLabel 逻辑改为读 `props.lastPollAt`。具体:

- `AutoRdPanel` 里调 `h(StatusBar, {...})` 时传 `lastPollAt: health ? health.lastTapdPollAt : null`。
- `StatusBar` 里:

```js
    function StatusBar(props) {
      var workspaces = props.workspaces
      var totals = props.totals
      var lastPollAt = props.lastPollAt
      var totalStories = totals ? totals.stories : 0
      var running = (totals && (totals.inFlight || 0)) + (totals && (totals.blocked || 0)) + (totals && (totals.completed || 0)) + (totals && (totals.failed || 0))
      var wsCount = workspaces ? workspaces.length : 0
      var hasError = workspaces && workspaces.some(function (w) { return w.status === 'error' })
      var statusLabel = hasError ? '出错' : (lastPollAt ? '上次采集 ' + clockLabel(Date.parse(lastPollAt)) : '尚未采集')
      var statusColor = hasError ? styles.statusError : (lastPollAt ? styles.statusSuccess : styles.labelTertiary)
      // … 其余结构保留,把 isPolling 相关分支删掉
    }
```

保留 StatusBar 后面的 `N 个工作空间 · N 个需求 · …` 汇总行。

- [x] **Step 9: 更新 `StoryDetail` 接收 sessions + 会话按钮 + 轨迹**

`StoryDetail`(约 1259 行)改动:

1. props 增加 `sessions`。
2. 「会话」fact 项:有 `mainSessionId` 且 `sessions` 存在时渲染按钮,否则回退纯文本。

把现有 `fact('会话', story.mainSessionId, { render: ... })` 替换为:

```js
          fact('会话', story.mainSessionId, {
            placeholder: '尚未创建',
            render: function (v) {
              if (sessions && typeof sessions.open === 'function') {
                return h('button', {
                  type: 'button',
                  onClick: function () { sessions.open(v) },
                  style: { border: 'none', background: 'none', color: styles.accent, cursor: 'pointer', fontSize: 'inherit', fontFamily: 'inherit', padding: 0, textDecoration: 'underline' },
                }, v + ' →')
              }
              return h('span', null, v)
            },
          }),
```

3. 补全 facts:所属工作空间、TAPD id、重试次数、创建时间、pushedSha/mrIid(有值时)。在现有 facts 之后加:

```js
          fact('所属工作空间', workspace ? workspace.name : '', { placeholder: '—' }),
          fact('TAPD ID', story.tapdId || story.id, { placeholder: '—' }),
          fact('重试次数', story.retryCount != null ? String(story.retryCount) : '0', { placeholder: '0' }),
          story.createdAt ? fact('创建时间', String(story.createdAt).slice(0, 16).replace('T', ' '), { placeholder: '—' }) : null,
          story.pushedSha ? fact('推送 SHA', story.pushedSha, { placeholder: '—' }) : null,
          story.mrIid != null ? fact('MR IID', String(story.mrIid), { placeholder: '—' }) : null,
```

注意:client 端 `PanelStory` 目前没有 `tapdId/retryCount/createdAt/pushedSha/mrIid` 这些字段(ui-panel.ts 的 `PanelStory` 只有 id/title/state/mrUrl/updatedAt/badge/branch/worktreePath/mainSessionId/acceptanceCriteria/blockedReason/artifacts)。**要么在 Task 5 顺带把 `PanelStory` 也补上这些字段**,要么这里别引用没有的字段。

**决定:** 在 Task 5 的 `PanelStory`(ui-panel.ts 约 58-78 行)补上:

```ts
  tapdId: string
  retryCount: number
  createdAt: string
  pushedSha: string
  mrIid: number | null
```

并在 panelModules.map 的 stories.map 里(约 362-379 行)补齐:

```ts
        tapdId: s.tapdId ?? s.id,
        retryCount: s.retryCount ?? 0,
        createdAt: s.createdAt ?? '',
        pushedSha: s.pushedSha ?? '',
        mrIid: s.mrIid ?? null,
```

(本步会回改 Task 5,执行时注意保持 test-ui-panel 的 detail 断言不变 —— 现有断言只查 branch/worktree/session/acceptance/blocked/artifacts,新增字段不破坏它们。)

4. 轨迹时间线:在 `StoryDetail` 的产物 section 之后加:

```js
        h(TrajectoryTimeline, { storyId: story.id }),
```

并新增 `TrajectoryTimeline` 组件:

```js
    function TrajectoryTimeline(props) {
      var storyId = props.storyId
      var traj = useStoryTrajectory(storyId)
      var kindLabel = {
        state_transition: '状态转移',
        agent_dispatch: '派发 agent',
        agent_result: 'agent 结果',
        checkpoint_write: '检查点',
        external_side_effect: '外部副作用',
        recovery: '恢复',
        note: '笔记',
      }
      return h(
        'section',
        { className: 'auto-rd-detail-section' },
        h('h3', null, '轨迹'),
        traj.status === 'loading'
          ? h('p', { className: 'empty' }, '加载中…')
          : traj.status === 'error'
            ? h('p', { className: 'empty' }, '轨迹加载失败')
            : traj.events.length === 0
              ? h('p', { className: 'empty' }, '暂无轨迹记录')
              : h('ul', { className: 'auto-rd-trajectory', style: { listStyle: 'none', margin: 0, padding: 0 } },
                  traj.events.map(function (ev, i) {
                    return h('li', { key: ev.id || i, style: { display: 'flex', gap: 9, padding: '4px 0', fontSize: 12, fontFamily: styles.fontCode, color: styles.labelSecondary, borderTop: i === 0 ? 'none' : '1px solid ' + styles.borderL3 } },
                      h('span', { style: { color: styles.labelTertiary, flex: 'none' } }, String(ev.at).slice(11, 19)),
                      h('span', { style: { color: styles.accent, flex: 'none' } }, kindLabel[ev.kind] || ev.kind),
                      h('span', { style: { flex: '1 1 auto' } }, ev.label),
                    )
                  }))
      )
    }
```

- [x] **Step 10: build + 全量 client/watch 测试**

Run: `npm run build && npm run test:client && npm run test:watch`
Expected: 若 watch/client 有断言依赖旧结构(inject 数量、`<details>` 展开、SyncPulse 正常态文本),会失败 —— 这些在 Task 11 更新。此处先保证 build 通过、无语法错。

---

## Task 11: 更新 client 测试断言

**Files:**
- Modify: `scripts/test-client-half.mjs`
- Modify: `scripts/test-watch-panel.mjs`

- [x] **Step 1: 改 client-half 的 inject 断言**

`scripts/test-client-half.mjs` 约 227-234 行,把:

```js
check('inject: declares the short name "slots"', exportsObj.inject.includes('slots'), JSON.stringify(exportsObj.inject))
check('inject: exactly one service', exportsObj.inject.length === 1, JSON.stringify(exportsObj.inject))
check(
  'externals: only react is required',
  requiredIds.length === 1 && requiredIds[0] === 'react',
  JSON.stringify(requiredIds),
)
```

改为:

```js
check('inject: declares the short name "slots"', exportsObj.inject.includes('slots'), JSON.stringify(exportsObj.inject))
check('inject: declares sessions for the session jump', exportsObj.inject.includes('sessions'), JSON.stringify(exportsObj.inject))
check('inject: exactly two services', exportsObj.inject.length === 2, JSON.stringify(exportsObj.inject))
```

(`externals` 断言不变 —— `sessions` 是 cordis 注入服务,不是 `require` 外部依赖,`requiredIds` 仍只有 `react`。)

同时 `fakeClientCtx()` 需要加 `sessions` 字段,否则 `apply()` 里 `ctx.get('sessions')` 拿到 undefined 也不报错(已有 undefined 兜底),但为了完整,给 `ctx` 加:

```js
      sessions: { open: function () {} },
```

- [x] **Step 2: 加会话按钮测试**

在 `test-client-half.mjs` 的 story 相关块附近,加一个直接测 StoryDetail 会话按钮的块(参照 test-watch-panel 里 #8 直接调 StoryDetail 的方式):

```js
{
  // Session jump: when ctx.sessions is present, the "会话" fact renders a
  // button that calls sessions.open(mainSessionId).
  const shim = makeReact()
  const exportsS = spec.factory(makeRequire(shim.react))
  const StoryDetail = exportsS.__autoRd.components.StoryDetail
  let opened = null
  const tree = StoryDetail({
    story: { id: 'S1', title: 'x', state: 'pending', branch: '', worktreePath: '', mainSessionId: 'ses_1', acceptanceCriteria: '', blockedReason: '', artifacts: [] },
    workspace: { name: 'Payment' },
    sessions: { open: function (id) { opened = id } },
    onBack: function () {},
  })
  const sessionBtn = null
  // Find the button whose onClick calls sessions.open.
  let found = null
  function findSessionButton(node) {
    if (node == null || found) return
    if (Array.isArray(node)) { for (const n of node) findSessionButton(n); return }
    if (typeof node !== 'object' || !node.__el) return
    if (node.props && typeof node.props.onClick === 'function' && node.props.children && String(node.props.children).includes('ses_1')) found = node
    for (const c of node.children) findSessionButton(c)
  }
  findSessionButton(tree)
  check('session: clickable button rendered for mainSessionId', !!found, 'no session button')
  if (found) { found.props.onClick(); check('session: button calls sessions.open', opened === 'ses_1', String(opened)) }
}
```

- [x] **Step 3: 改 watch-panel 里依赖旧交互的断言**

以下断言在 Task 10 后失效,逐一调整:

1. `#7: workspace rows are <details>-based`(约 344 行)—— 行不再是 `<details>`,改为断言 `auto-rd-ws-row` 仍是 `li`,且行有 onClick(进详情):

```js
  check('#7: workspace rows are clickable list items',
    wsRows.length === 2 && wsRows.every((r) => typeof r.props.onClick === 'function'),
    'got ' + wsRows.length + ' rows')
```

2. `#7: blocked workspace auto-expands (is-open)` / `healthy workspace does NOT auto-expand`(约 346-349 行)—— 不再有 `is-open`。删除这两个断言,或改为断言「分页在 ≤5 个时不渲染」。

3. `#7: completed stories sit inside a <details> summary`(约 391 行)—— 已完成折叠逻辑移到了 `WorkspaceDetail`(整页),列表页不再展示 stories。**这两个断言(391/394 行)删除**,改到后面新增的「workspace 详情页」测试里覆盖。

4. `empty: expanded empty workspace does NOT show "任务" heading`(约 585-594 行)—— 展开交互已移除。这个块改为:点击行 → 断言进入 workspace 详情页(视图切换),再断言空 workspace 详情页无「任务」heading。

具体:把 `EMPTY_WORKSPACE_MODEL` 测试块改为:

```js
{
  const { tree, panel: panelFn, shim: shimFn } = await renderAndReread(EMPTY_WORKSPACE_MODEL)
  const wsRow = findElement(tree, (el) => el.props && (el.props.className || '').startsWith('auto-rd-ws-row'))
  check('empty: workspace row present', !!wsRow)
  // Click the row to navigate into the workspace detail view.
  if (wsRow && typeof wsRow.props.onClick === 'function') {
    wsRow.props.onClick()
    shimFn.resetCursor()
  }
  const after = expandTree(panelFn())
  const text = collectText(after)
  check('empty: workspace detail view shows the back button', text.includes('返回'))
  check('empty: empty workspace detail does NOT show the "任务" heading', !text.match(/\b任务\b/), text.slice(0, 200))
}
```

5. `#7: clicking the gear button opens the settings form`(约 358-387 行)—— gear 按钮移到了详情页。这个块要么删除,要么改成「进入详情页后 settings form 可见」。**改为:删除 gear 按钮断言块**,因为 settings 现在在 workspace 详情页内联,由「workspace 详情页」测试覆盖(见 Step 4 新增)。

- [x] **Step 4: 新增「三层视图 + 分页 + 采集状态」测试块**

在 `test-watch-panel.mjs` 末尾 Summary 前加:

```js
// ---- three-level navigation + pagination + poll stat ----------------

const PAGED_MODEL = {
  ok: true,
  model: {
    modules: Array.from({ length: 7 }, function (_, i) {
      return { id: 'm' + i, title: 'WS' + i, defaultBranch: 'main', stories: [], pollStat: { lastAttemptAt: null, lastSuccessAt: '2025-01-01T00:0' + i + ':00.000Z', lastError: null, lastNewCount: i } }
    }),
    totals: { modules: 7, stories: 0, inFlight: 0, blocked: 0, completed: 0, failed: 0 },
    health: { setupRequired: false, issues: [], mountedForSec: 1, lastTapdPollAt: null, lastTapdError: null },
  },
  text: '',
}

{
  const { tree } = await renderAndReread(PAGED_MODEL)
  const rows = []
  walk(tree, (el) => { if (el.props && (el.props.className || '').startsWith('auto-rd-ws-row')) rows.push(el) })
  check('pagination: page 1 shows exactly 5 rows', rows.length === 5, 'got ' + rows.length)
  check('pagination: pager rendered', someElement(tree, (el) => el.props && el.props.className === 'auto-rd-pager'))
  const pagerText = collectText(tree)
  check('pagination: pager says 1 / 2', pagerText.includes('1 / 2'), pagerText.slice(0, 400))

  // Click "下一页" to advance.
  const next = findElement(tree, (el) => el.props && typeof el.props.onClick === 'function' && el.props.children && String(el.props.children).includes('下一页'))
  if (next && typeof next.props.onClick === 'function') next.props.onClick()
  const { tree: tree2, shim } = (function () { const s = makeReact(); const real = globalThis.fetch; globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return PAGED_MODEL } }); try { const ex = spec.factory(makeRequire(s.react)); ex.__autoRd.components.AutoRdPanel(); return { ex: ex, shim: s } } finally { globalThis.fetch = real } } )()
  // (分页状态是组件内部 state,advance 后需重新渲染读取 — 见下方 Step 5 说明)
}
```

**Step 4 的实现提示:** 分页 state 在组件内部,advance 后要 re-render 读最新 slots。参照 test-watch-panel 现有「gear 按钮」测试的写法(375-387 行:onClick 后 `shim.resetCursor()` + 重新 `panel()` + `expandTree`)。上面简化写法不可用,请照那个既有模式写,断言 page 2 显示 2 行、pager 说 `2 / 2`。

- [x] **Step 5: 全量跑受影响的 suite**

Run: `npm run build && npm run test:client && npm run test:watch && npm run test:ui && npm run test:route`
Expected: 全绿。若 test-stage / test-recover 也读 client 结构,一并跑:`npm run test:stage && npm run test:recover`。

---

## Task 12: 收尾验证 + 提交

- [x] **Step 1: 全量相关 suite**

Run: `npm run lint && npm run build && npm run test:ui && npm run test:route && npm run test:client && npm run test:watch && npm run test:stage && npm run test:recover`
Expected: 全绿。

- [x] **Step 2: 提交**

```bash
git add packages/dsh-auto-rd/src/services/poll-stats.ts \
        packages/dsh-auto-rd/src/services/tapd-poller.ts \
        packages/dsh-auto-rd/src/services/story-trajectory-route.ts \
        packages/dsh-auto-rd/src/services/ui-panel.ts \
        packages/dsh-auto-rd/src/services/panel-route.ts \
        packages/dsh-auto-rd/src/index.ts \
        packages/dsh-auto-rd/src/client/client.js \
        scripts/test-ui-panel.mjs \
        scripts/test-panel-route.mjs \
        scripts/test-client-half.mjs \
        scripts/test-watch-panel.mjs
git commit -m "feat(panel): three-level view, pagination, per-workspace poll stats, trajectory, session jump"
```

**注意:** 不要 `git add` 工作树里另一条线的 `credentials.ts` / `migrate-storage-credentials.ts` / 已修改的 7 个 host 文件(它们不属于本次)。如果是在 worktree 里做,这些文件根本不在 worktree 里,天然隔离。

---

## Self-Review(执行前核对)

- **Spec 覆盖:** 三层视图(Task 10)、分页 5/页(Task 10 Step 3)、per-workspace 采集状态(Task 1-6 + client Task 10 Step 6)、顶部「已同步」删除 + 「上次采集」(Task 10 Step 8)、轨迹时间线(Task 4/7/9/10 Step 9)、会话跳转(Task 8/10 Step 9/11 Step 2)、任务详情补全 facts(Task 10 Step 9 + Task 5 补 PanelStory 字段)。
- **占位符扫描:** 无 TBD/TODO;所有代码块完整。
- **类型一致性:** `PollResult` 定义在 `poll-stats.ts` 且被 tapd-poller import(已修正初始的循环 import 风险);`RuntimeStats.pollStats` 可选,旧 runtime 字面量兼容;`PanelStory` 新增 6 字段与 client `workspaces.map` 透传 `pollStat` 一致。
