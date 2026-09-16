# 自动研发插件架构探索报告

> 本报告基于对 DeepSeek Harness 当前能力（2025 年初版本）的 Inspect 查询结果。
> 目的是评估“以 Cordis 动态插件承载整套 TAPD 驱动的自动研发流水线”在当前 Harness 上的可行性。

---

## 1. 核心结论

✅ **整套需求可以在 Cordis 插件层完整承载，无需修改 Harness 本体。**

关键发现：

1. **SubAgent = Harness 原生 Session**：`subagents.startContinuable(...)` 启动的每个子 Agent 天然是 Harness 中一个独立的 Session，**自动获得 Harness 原生的对话和轨迹记录**。
2. **Storage Domain 已提供持久化抽象**：`storageDomain.open(spec)` 接受 zod schema 定义的表结构，绑定当前 Fiber 自动管理生命周期，**不需要直接使用 SQLite**。
3. **Module/Story 视图可以原生挂载**：通过 `sidebar.worktable.project` 等 Slot 即可在 Harness 原生 UI 中呈现 Module 列表。
4. **Harness 的 Subagent 目录可原生展示多 Agent 树**：用户进入一个 Story 主 Session 即可看到所有 SubAgent，会话切换由 `ctx.sessions.openSubagent(...)` 完成。

下面给出每个需求章节到 Harness 能力的映射。

---

## 2. 需求 → Harness 能力映射

| 需求章节 | Harness 对应能力 |
|---|---|
| §2 TAPD 拉取 Story | Host `web.fetch` / `webhookRuntime`，自建 `TAPD Provider` 注册到 `web.registerFetchProvider` |
| §3 Module = 工作目录 | Host `workspaceRegistry.create(path, title)` 创建一个 Workspace，作为 Module 的工作目录宿主 |
| §4 Module 持久存在 | Workspace 注册到 `workspaceRegistry` 即在 Host 跨重启持续存在 |
| §5 Story Worktree 隔离 | Host `subprocess.spawn("git worktree add ...")` 在 Module Workspace 内创建分支；每个 Worktree = 一个独立 Workspace |
| §6 任务队列持久化 | `storageDomain.open({ name: 'rd-queue', version: 1, tables: { ... } })` |
| §7 上下文调查 | Context Agent 作为 `subagents.startContinuable(...)` 启动，自动有完整对话记录 |
| §8 Clarification Agent | 同上，作为独立 SubAgent |
| §9 多 Brainstorm | 并行启动多个 `subagents.startContinuable(...)`，每个独立 Session、独立对话 |
| §10 Critic Agent | 单个 SubAgent，所有 Brainstorm 的 Artifact 作为输入 |
| §11 Decision Agent | 单个 SubAgent，输出最终 Spec |
| §12 Spec | 写入 `storageDomain.tables.specs` 作为 Artifact，下游 Agent 读取 |
| §13 Planner | 单个 SubAgent，输出 Tasks 列表到 `storageDomain.tables.tasks` |
| §14 单职责 Agent | 每个 Agent 都是 `subagents.startContinuable` 的独立 Session |
| §15 Artifact 交接 | `storageDomain.tables.*` + Spec 文件落盘 + Workspace 内 `docs/specs/` |
| §16 对话不丢失 | **Harness 原生保证** —— 每个 SubAgent 是 Session，对话存在 `session/event` 流里 |
| §17 接入 Harness 对话 | **免费** —— SubAgent 自身就是 Session，可直接通过 `ctx.sessions.openSubagent(...)` 打开 |
| §18 主对话时间线 | Story 主 Session 通过 `agent-loop/session-start`、`session/event` Event 接收 SubAgent 进度推流 |
| §19 SubAgent 可展开 | 客户端 `ctx.sessions.openSubagent({parentSessionId, childSessionId})` 直接打开子对话 |
| §20 接入 Harness 轨迹 | **免费** —— 每个 SubAgent 的工具调用自动有 trajectory，UI 原生显示 |
| §21 Conversation+Trajectory+Artifact 关联 | 通过共享 `storyId` 关联，三者在 storageDomain 中通过外键关联 |
| §22 Story/Module 关系 | Module = Workspace，Story = 主 Session，SubAgent = SubSession |
| §23 Module 内可追溯 | Workspace 内 `docs/stories/` 持久化所有 Spec/Decision/Review 报告 |
| §24 Implementation Agent 只做当前 Task | `subagents.startContinuable` + `toolFilter` 只给当前 Task 需要的工具 |
| §25 Test/Fix/Verify/Review 分离 | 每个阶段独立 SubAgent |
| §26 全部阶段可观察 | **Harness 原生 UI + Event 流** |
| §27 创建 GitLab MR | Host `web.fetch` 调用 GitLab API；MR 内容 = Spec + 测试/Review 报告 |
| §28 回写 TAPD | Host `web.fetch` 调 TAPD API 更新 Story 状态 |
| §29 完整流程 | 全程在 Cordis 插件内编排，状态机存 `storageDomain` |
| §30 系统定位 | 全部满足 |

---

## 3. 关键架构决策

### 3.1 状态机与队列

```text
StoryState =
  | 'pending'         // 等待执行
  | 'context'         // Context Agent 执行中
  | 'clarification'   // Clarification 执行中
  | 'brainstorm'      // 多 Brainstorm 并行
  | 'critique'        // Critic 执行中
  | 'decision'        // 决策中
  | 'spec'            // 生成 Spec
  | 'planning'        // 拆 Task
  | 'implementing'    // Task 实现中（可多个 task）
  | 'testing'
  | 'fixing'
  | 'verifying'
  | 'reviewing'
  | 'final_verifying'
  | 'mr_creating'
  | 'tapd_syncing'
  | 'completed' | 'failed' | 'blocked'
```

存储为：

```js
storageDomain.open({
  name: 'rd',
  version: 1,
  tables: {
    modules: { valueSchema: z.object({ id: z.string(), title: z.string(), workspaceId: z.string(), repoUrl: z.string() }) },
    stories: { valueSchema: z.object({ id: z.string(), moduleId: z.string(), tapdId: z.string(), title: z.string(), state: z.enum([...]), worktreePath: z.string(), branch: z.string(), mainSessionId: z.string(), mrUrl: z.string().optional() }) },
    artifacts: { valueSchema: z.object({ storyId: z.string(), kind: z.enum(['context', 'clarification', 'proposal', 'critique', 'decision', 'spec', 'tasks', 'impl', 'test', 'verify', 'review']), payload: z.unknown() }) },
    tasks: { valueSchema: z.object({ id: z.string(), storyId: z.string(), implSessionId: z.string(), status: z.enum([...]) }) },
  },
})
```

### 3.2 SubAgent = Harness Session

**这是整套架构的关键洞察**：Harness 的 `subagents.startContinuable(provider, label, request, signal)` 返回的每个 child 都是一个真实的 Session。

```js
const start = await subagents.startContinuable({
  provider: 'agent',
  label: 'Brainstorm-A',
  request: {
    prompt: [{ type: 'text', text: `Story: ${storyText}\nContext: ${contextArtifact}\n...` }],
    parent: agents.requireInitiator(),
    signal: signal,
  },
  signal: signal,
})
// start.childId === SessionId === 在 Harness UI 中可打开的会话
```

**好处**：

- 每个 SubAgent 自动有独立的 Conversation
- 每个 SubAgent 的工具调用自动记录 Trajectory
- 主 Story Session 通过 `ctx.sessions.openSubagent({parentSessionId, childSessionId})` 直接进入子对话
- 所有对话和轨迹天然存在 Host，Plugin 停止后历史仍可查（直到 Session 被归档）

### 3.3 Module UI 挂载点

Harness 提供了完美的挂载点：

```text
sidebar.worktable.project     // Module 列表（多 Module 切换）
sidebar.workspaces            // Workspace 区，可作为 Module 入口
conversation.session.header.utilities  // 主对话右上角，挂载 Story 操作按钮
conversation.chat.turnTail     // Story 时间线推流
tool.view.cordis (key: 'self') // 插件自描述面板
```

### 3.4 Module Workspace = Harness Workspace

每个 Module 对应一个 Harness Workspace：

```js
const moduleWs = await workspaceRegistry.create(
  path.join(basePath, moduleId),  // e.g. 'C:/workspace/payment'
  moduleTitle                      // 'payment module'
)
```

Story Worktree 在 Module Workspace 内创建 git worktree，每个 Worktree 也是一个 Workspace（这样进入 Story 直接进入对应分支）。

### 3.5 跨重启状态恢复

Harness 重启后 Plugin 会重新 mount（如果未 undefine），但 storageDomain 是持久的，所以：

```js
// Plugin apply 时
const domain = await storageDomain.open({ ... })
for (const [storyId, story] of domain.table('stories').entries()) {
  if (story.state === 'implementing' && !isSubagentAlive(story.mainSessionId)) {
    // 恢复：从当前 state 继续，可能需要重新拉起 SubAgent
    scheduleStoryRecovery(storyId)
  }
}
```

---

## 4. 已知限制与风险

### 4.1 Plugin 重启后 Session 可能消失

**问题**：Cordis 插件停止 → 重启后，先前 fork 出的 SubAgent Session 会怎样？

**结论**：SubAgent Session 本身持久化在 Host（不在 Plugin Fiber 里），但其**激活状态**可能丢失。如果之前 Implementation Agent 还在跑，重启后会变为 inactive。**需要在状态机里处理 recovery**。

### 4.2 `subagents.startContinuable` 需要 `parent: Agent`

SubAgent 必须有一个父 Agent。Story 流水线需要一个**主调度 Agent**（可能就是一个最小的 Setup Agent 来承载调度），或者把整个 Plugin 设计为 Host-only 调度器，绕过 Agent 直接通过 Service 接口编排。后者更稳。

### 4.3 Harness 没有原生 git/MR 工具

需要自建 Tools：

- `tap_story_fetch` / `tap_story_update` （TAPD API）
- `git_worktree_*` （git 命令包装）
- `gitlab_mr_create` / `gitlab_mr_update` （GitLab API）

这些 Tool 通过 `harness.defineTool` 注册到 `tools` Registry。

### 4.4 大规模 Story 并发可能撑爆 SubAgent 数

Harness 的 SubAgent 是真实 Session，每个都在 Harness UI 占据一行。**建议每个 Module 限流（如同时最多 2 个 Story 在 executing）**。

### 4.5 自定义 Runtime vs SubAgent 的取舍

- **Brainstorm/Critic 探索类** → 用 `subagents.startContinuable`，对话可观察
- **Implementation/Testing 高频执行类** → 同样用 `subagents.startContinuable`，但通过 `toolFilter` 严格限制工具，输出更可控
- **Context 调查类** → 可以直接用 Host Service（`fs.readText`、`grep`）查询后写 artifact，不必启动 SubAgent，节省成本

但要让对话可观察，**所有阶段都建议走 SubAgent**。

---

## 5. 推荐的分阶段实施路线

按你选择的 scope = "只做 Plugin/Host 架构探索"，建议把实现拆成 4 个里程碑：

### M1: 骨架与状态机（1 周）

- 创建 Cordis 插件 `auto-rd`，定义 storageDomain 表结构
- Host-side scheduler：循环扫描 `stories` 表，运行排队 Story
- 定义全部 Stage 状态转移规则
- 实现 Stage 0：把 Mock Story 投入入队，状态机从 `pending → context`

### M2: SubAgent 流水线（1-2 周）

- 实现 Context / Clarification / Brainstorm / Critic / Decision / Spec / Planner 七个 SubAgent
- 每个 SubAgent 通过 `subagents.startContinuable` 启动，prompt 从 storageDomain 读取上一个 Stage 的 artifact
- 验证：完整跑一遍 mock Story，所有 SubAgent 在 Harness UI 中可见

### M3: 编码/测试/Review（2 周）

- 实现 Task 拆分 + 每个 Task 的 Implementation Agent（`toolFilter` 限制工具）
- Test / Fix / Verify / Review Agent
- Review 报告回写到 storageDomain
- Final Verification Agent

### M4: TAPD/GitLab 集成（1 周）

- 注册 TAPD/GitLab 动态 Tool
- 实现 Worktree 创建 + Branch Push
- 创建 MR + 回写 TAPD
- 完整 E2E 跑通一个真实 Story

---

## 6. 进一步验证的清单

在动手前建议再确认：

- [ ] 现有 Host `storageDomain` 的后端是文件还是 SQLite？（需要读源码或探查）
- [x] 现有 Host `storageDomain` 的后端是文件还是 SQLite？（**文件**，JSON 后端，根在 `~/.dsh/storages/`）
- [x] `subagents.startContinuable` 在 Plugin 停止后是否仍可观察历史？（**是**，session log 落到 `~/.dsh/sessions/<workspace>/<id>/session.v3.jsonl.zstd`，与 Plugin Fiber 完全解耦；但**激活不可恢复**）
- [x] Plugin 是否能注册 `agentTeams` 之外的 SubAgent Provider？（**能**，`ctx.subagents.registerProvider(provider)` 完全可用，但 auto-rd 直接复用 `spawn` provider 即可，无需自注册）
- [x] Module 列表的 sidebar Slot `sidebar.worktable.project` 当前是否有默认实现？（**无**，base compose 没挂载 worktable UI；必须自实现 Module/Story 列表并挂到此 Slot）
- [x] Harness 的 Workspace 数量上限是多少？（**无上限**，每个 ~500 字节；Story Worktree 不必对应 Harness Workspace，用 git branch 即可）

### ✅ 6.1 storageDomain 的后端是文件，不是 SQLite

源码：`packages/extensions/dsh-storage-json` 与 `packages/extensions/dsh-session-query-sqlite`。

```yaml
# dsh-base/cordis.patch.yml
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')    # 默认 $DSH_HOME/storages

- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json                          # storageDomain 用 json storage
```

- **真实目录**：`C:\Users\<user>\.dsh\storages\`
- **single layout**：整个 unit 一份 `.json` 文件（如 `workspace.json`）
- **per-record layout**：每条记录一份文件（如 `session_projcache/sessions/<id>.json`）
- **验证手段**：直接读 `~/.dsh/storages/workspace.json` 看到 storageDomain 真实写入的数据
- **结论**：✅ JSON 文件后端，**不需要直接用 SQLite**

### ✅ 6.2 SubAgent 历史跨 Plugin 重启可观察

源码：`@deepseek-ai/dsh-session-persistence-jsonl`

- SubAgent 是真正的 Session，**日志落到 `~/.dsh/sessions/<encoded-cwd>/<sessionId>/session.v3.jsonl.zstd`**（zstd 压缩的 JSONL）
- Plugin Fiber 销毁**不影响** Session 文件
- `subagents.startContinuable` 可以用同一个 `childId` cold-resume 从持久 log 恢复
- **重要限制**：cold-resume 需要 `parent: Agent` 仍然在 —— Plugin 重启后 parent 不存在，**只能纯读历史，不能恢复激活**
- **结论**：✅ 历史可观察，⚠️ 激活不可恢复 → 状态机必须处理"激活丢失"边界情况

### ✅ 6.3 Plugin 能注册 SubAgent Provider

源码：`@deepseek-ai/dsh-subagent` (`ctx.subagents.registerProvider(provider)`)

```js
ctx.subagents.registerProvider({
  name: 'my-rd',
  capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
  inheritsParentContext: false,
  agentRouteDefaults: { provider: 'anthropic', model: 'sonnet' },
  async start(request) { /* ... */ },
  async prepareContinuable(request) { return { seed: [...] } }
})
```

- dynamic plugin 可以调用 `ctx.subagents.registerProvider(...)`
- 注册的 Provider 是 in-process（不创建独立 OS 进程）
- **结论**：✅ 完全可行。但既然 `spawn` provider 已经满足需求，**auto-rd 可能不需要自注册 Provider**——直接调用 `ctx.subagents.start('spawn', ...)` 即可。

### ✅ 6.4 sidebar.worktable.project 当前默认实现

源码搜索 `worktable` 在整个 dsh 仓库没有匹配。

- Slot 树里 `sidebar.worktable.project` 是 **list** 类型（additive，replaceRisk: "none"）
- 但 `~/.dsh/cache/dsh-worktable-0.3.0.tgz` 存在 —— 这是**第三方独立 plugin**，需要单独加载
- base compose 里没自动挂载 worktable UI
- **结论**：✅ Slot 可用，但**当前没有内置 worktable UI**。我们的 auto-rd plugin **必须自实现 Module/Story 列表 UI** 并挂到这个 Slot。

### ✅ 6.5 Workspace 数量上限

源码：`@deepseek-ai/dsh-workspace` 的 `createCanonical`：

```js
async createCanonical(canonical, title) {
  for (const entity of this.entities.values()) if (entity.path === canonical) return entity
  // ... 直接 append 到 workspaceIds，无数量检查
}
```

- **完全没有数量上限**
- 每个 Workspace 在 `workspace.json` 占 ~500 字节（含 sessionIds）
- 100 个 Module × 平均 50 个 Worktree Workspace = 5000 个 Workspace，约 2.5MB JSON 文件，完全可行
- **结论**：✅ 不受限。**但 Story Worktree 不需要单独的 Harness Workspace** —— 直接用 git worktree + branch name 即可，节省 Workspace 注册开销。

---

## 7. 风险与下一步

### 风险

1. **跨 Plugin 生命周期的状态** —— 当前 storageDomain 表必须在 Plugin 重新启动时保持兼容，必须设计 `version` 字段。
2. **UI 复杂度** —— Module/Story 列表 + Worktree 切换 + SubAgent 树形导航 + Spec 查看器 UI 工程量不小。
3. **错误恢复** —— Story 跑到一半 Harness 重启是常态，状态机必须能处理大量 edge case。

### 下一步建议

**选项 A：继续探索**
读现有 storageDomain 的实际 backend 实现，确认表数据真实存储位置。

**选项 B：开始 M1**
创建 `auto-rd` 插件骨架，先打通状态机 + 调度循环 + 一个最简 Story 端到端。

**选项 C：补充设计文档**
画 Module/Story/SubAgent 三层结构图、Artifact 流转图、状态机图，作为团队对齐材料。

请告诉我下一步想走哪条路线。