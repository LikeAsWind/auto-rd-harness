# Auto-RD 面板信息架构重构 — 设计规格

- 日期:2026-09-17
- 状态:已确认,待拆实现计划
- 范围:`packages/dsh-auto-rd` 的 host 端(`src/services/*`、`src/index.ts`)+ client 端(`src/client/client.js`、`src/client/stage-data.js`)

## 背景与问题

当前 Auto-RD 面板有两条含糊的状态线和一堆被折叠的信息:

1. 顶部 `SyncPulse`「已同步 · N 秒前」—— 它实际含义是「本地 storage 快照 5 秒刷了一次」。快照每 5 秒必刷,于是这句话在正常态永远显示「刚刚」,等于一句永远正确的废话。
2. 顶部 `StatusBar`「采集中 / 已停止」—— 数据来源是全局 `health.lastTapdPollAt`(60 秒一刷)。但 TAPD 采集是 **1:1 绑 workspace** 的,全局一个时间戳表达不了「谁同步到哪、谁失败了」。
3. 工作空间列表与需求列表混在同一个面板里,`<details>` 行内展开 stories;工作空间一多,列表与计数器都挤在一起,信息没有层级。
4. 任务详情页(现有 `StoryDetail`)已经承载了大部分任务信息,但缺「轨迹时间线」,且「会话」只是文本,不是可点跳转。

用户诉求:把「工作空间列表 / 工作空间详情 / 任务详情」分成清晰的三层,采集状态下沉到 workspace 行,主列表分页,任务详情吸收现有设计并补全轨迹与会话跳转。

## 目标(成功标准)

- [x] 面板有清晰的三个层级:工作空间列表(分页)→ 工作空间详情(采集信息 + 需求列表)→ 任务详情(任务状态 + 轨迹 + 会话跳转)。
- [x] 主列表每页最多 5 个工作空间,超过分页。
- [x] 每个工作空间行 / 详情页显示**它自己的** TAPD 采集状态(上次同步时间、成功/失败、新增几条),不再只有全局一个时间戳。
- [x] 顶部不再有「已同步 · 刚刚」这条正常态废话;面板数据出错时才显示警示条。
- [x] 任务详情页完整呈现:阶段 gauge、中断原因、facts、验收标准、产物时间线、**轨迹时间线**、**可点会话跳转**。
- [x] `npm run test:ui` / `test:panel-route`(即 `test:route`)/ `test:client-half` / `test:watch` / `test:stage` / `test:recover` 通过;`npm run lint` 干净。

## 架构

### 数据流(host → client)

```
TapdPoller (60s, 遍历每个 module)
  └─ 每轮 tick 产出 per-workspace 采集结果
       └─ 写入 runtime.pollStats: Map<moduleId, WorkspacePollStat>   ← 新增
            └─ buildPanelModel 读 runtime.pollStats
                 └─ PanelModel.modules[].pollStat                      ← 新增字段
                      └─ GET /auto-rd/panel 回传
                           └─ client 渲染到 workspace 行 / 详情页头部

trajectories 表(host storageDomain)
  └─ 新增 GET /auto-rd/story/<id>/trajectory route                   ← 按需拉取
       └─ client 任务详情页打开时 fetch 一次,渲染时间线
```

### 新增 host 数据结构

`WorkspacePollStat`(per-workspace 采集快照,非持久化,只活在 runtime 内存里):

```ts
interface WorkspacePollStat {
  moduleId: string
  /** 上次成功拉取 TAPD 的时刻;从未成功则为 null */
  lastSuccessAt: Date | null
  /** 上次尝试的时刻 */
  lastAttemptAt: Date | null
  /** 上次尝试的错误消息;成功为 null */
  lastError: string | null
  /** 上次成功这一轮新入队的 story 数(不含已存在被跳过的) */
  lastNewCount: number
}
```

- 存放位置:`runtime` 对象(`index.ts` 里已经有一个 `runtime: { mountedAt, lastTapdPollAt, lastTapdError }`),扩展为携带 `pollStats: Map<string, WorkspacePollStat>`。
- `TapdPoller` 的 `onTickEnd` 回调升级:除了全局时间/错误,再回传本轮每个 module 的结果。由 `index.ts` 里的回调把结果写进 `runtime.pollStats`。
- mock 模式下也写 stats(mock fixture 按 `category` 路由,同样能算出每个 module 新增几条),这样离线开发也能看到采集状态。

### 面板模型扩展

`buildPanelModel` 里:

- `PanelModule` 增加可选 `pollStat?: WorkspacePollStat`(序列化为普通对象,Date → ISO 字符串)。
- 顶部 `PanelHealth` 保留 `lastTapdPollAt` / `lastTapdError`(向后兼容,避免 test-panel-route / test-ui-panel 大面积改动),但新增字段不再依赖它们 —— 客户端优先读 per-workspace `pollStat`。
- `totalStories` 等 totals 逻辑**不变**(已经对齐孤儿过滤,issue #9 已修)。

### 新增轨迹 route

`GET /auto-rd/story/<storyId>/trajectory`:

- 复刻 `panel-route.ts` 的注册模式(同一个 `webServer` 可选服务,同一个 retry 辅助)。
- 响应:`{ ok: true, storyId, events: TrajectoryEvent[] }`,events 按 `at` 升序。
- 用 `storage.trajectories().values()` 过滤 `storyId`(与 `TrajectoryRecorder.listForStory` 同逻辑;由于 recorder 需要 ctx,route 直接读 storage 更简单)。
- storyId 来自 path 段,做基本校验(非空);不存在则返回空数组,不 404。
- 缓存头 `cache-control: no-store`,与 panel route 一致。

## 客户端视图设计

### 三层视图(用 state 切换,复用现有 `selectedStoryId` 模式)

```
AutoRdPanel (根)
 ├─ view = 'list'      → WorkspaceList(分页 5/页)
 ├─ view = 'workspace' → WorkspaceDetail(头部采集信息 + 需求列表)
 └─ view = 'story'     → StoryDetail(任务详情,现有 + 扩展)
```

导航 state:`view: 'list' | 'workspace' | 'story'`,`activeWorkspaceId: string | null`,`activeStoryId: string | null`。返回键逐层回退。保留 Escape 关详情。

### 1. 工作空间列表(分页)

- 每页 5 个工作空间。前端分页(YAGNI,数量小)。
- 行内**不再** `<details>` 展开 stories(现有展开逻辑移除)。行点击 → 进 `workspace` 详情。
- 行内容:状态点 + 名称 + 路径 + 「N 个需求」计数 + 简短采集状态(见下)。
- 分页控件:`‹ 上一页` `1 / 2` `下一页 ›`,仅在总页数 > 1 时显示。
- 「添加工作空间」按钮保留在列表顶部。

### 2. 工作空间详情页

- 顶部:`← 返回` + 工作空间名称 + 路径 + 状态点。
- **采集信息区**(来自 `module.pollStat`):
  - 成功:`✓ 上次同步 HH:MM · 本轮新增 N 条`
  - 失败:`⚠ 同步失败 · <错误消息>`,并给 remedy(继承现有 workspace-level error 文案风格)。
  - 从未同步:`尚未拉取`(未配 `tapdWorkspaceId` 则显示「未设置 TAPD 工作空间 ID」,复用现有 setup issue 文案)。
- **需求列表**:该 workspace 的 stories,排序与现有一致(`updatedAt` 降序)。每条一行:阶段 gauge(缩略)+ 标题 + id + 状态 label;点击 → 进 `story` 详情。
- 设置入口:保留现有齿轮按钮打开的 `WorkspaceSettingsForm`(它已存在于工作树未提交改动中,归属本重构一并纳入)。

### 3. 任务详情页(现有 StoryDetail 扩展)

从上到下完整区块:

1. **头部**:`← 返回` + 标题 + id + 当前阶段 label + `更新于 HH:MM`。
2. **阶段 gauge**:4 段进度条(复用 `StageGauge` + `buildGauge`)。
3. **中断原因**:`blocked` / `failed` 时显示(保留现有 `showCause`)。
4. **facts 事实区**:分支、合并请求(可点外链,保留)、工作树、**会话(改为可点按钮,见下)**,并补全:所属工作空间、TAPD id、重试次数、创建时间、推送 SHA / MR iid(有值时显示)。
5. **验收标准**:列表,空则占位(保留)。
6. **产物时间线**:artifacts(保留)。
7. **轨迹时间线**(新增):打开详情页时 fetch 一次 `/auto-rd/story/<id>/trajectory`,按 `at` 升序渲染。每条:`时间 · kind 色点/图标 · label`。kind → 中文标签映射:状态转移 / 派发 agent / agent 结果 / 检查点写入 / 外部副作用 / 恢复 / 笔记。空则「暂无轨迹记录」。

### 4. 会话跳转

- `apply(ctx)` 里 `inject` 扩为 `['slots', 'sessions']`,拿到 `ctx.sessions`。
- 「会话」facts 项:有 `mainSessionId` 时渲染为按钮,`onClick` 调 `ctx.sessions.open(mainSessionId)`;无则占位「尚未创建」。
- 依赖来源已确认:`ISessions.open(id: SessionId): void`(`@deepseek-ai/dsh-api-session-controller` 的 client 契约),有 `dsh-client-ui-workspace` 的实际调用先例。

### 5. 顶部状态线(简化)

- 删掉 `SyncPulse` 正常态「已同步 · 刚刚」。
- `StatusBar` 的「采集中 / 已停止」改为「上次采集 HH:MM」(读全局 `lastTapdPollAt`,因为没有 per-workspace 时仍需一个兜底)。
- 面板数据出错(`panel.status === 'error'` 且无缓存)时才显示警示条:「面板连接失败,数据停在 HH:MM」+ 重试按钮。
- `SyncPulse` 组件改造为只在 error/stale 时可见;正常态不渲染。

## 兼容与范围

- **工作树未提交改动**(`client.js` 里 gear 按钮 / `settingsOpen`)是本会话进行中、未 commit 的改动,属于同一 UI 重做的一部分,纳入本次实现范围,不单独回滚。
- **不在范围**:不引入真实浏览器路由(继续用 state 切换)、不持久化分页页码、不做后端分页、不新增 per-workspace 采集持久化(重启即清,recover 已处理孤儿)。

## 测试

- `test:ui`(`scripts/test-ui-panel.mjs`):`buildPanelModel` 新增 `pollStat` 字段的序列化与缺省断言。
- `test:route`(`scripts/test-panel-route.mjs`):新增 trajectory route 的注册与响应断言(空 events、按 storyId 过滤、升序)。
- `test:client-half`(`scripts/test-client-half.mjs`):分页、三层视图切换、会话按钮调用 `sessions.open`、轨迹时间线渲染、SyncPulse 正常态不渲染。
- `test:watch` / `test:stage` / `test:recover`:回归确认不受影响。
- `npm run lint` 全程干净。

## 开放项

- 无。会话跳转已从 DSH 源码确认 `ctx.sessions.open(id)`;轨迹走按需 route;采集状态走 `runtime.pollStats`。
