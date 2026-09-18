# Auto-RD 两档架构设计 — 通用流水线 + 交付闭环

> 状态:定稿(待实现)
> 关联:[会话原生化流水线设计](./auto-rd-session-native-pipeline.md)、[真 Plugin 架构设计](./auto-rd-native-plugin-design.md)、[PRD — 会话原生化重构](../prd-session-native-pipeline.md)
> 本文档在「会话原生化」基础上,进一步把 **TAPD 与 GitLab MR 从流水线剥离**,形成「通用执行引擎 + 适配器闭环」的两档结构。它是最终稿;`auto-rd-session-native-pipeline.md` 是其中的中间稿,两份并存,本文档引用后者。

---

## 0. 分层原则

| | 第一档 | 第二档 |
|---|---|---|
| 角色 | 研发流水线(内层引擎) | 定时任务处理流程(外层编排) |
| 形态 | agent preset 会话模式 | 定时任务 + 交付任务 + 日扫任务 |
| 拥有 | 需求 → 代码 的执行流程 | TAPD、GitLab MR、轮询、关闭 |
| **不拥有** | TAPD / MR / 轮询 / 关闭 | 角色执行流程(交给第一档) |
| 嵌套关系 | 被第二档嵌套调用 | **嵌套**第一档来执行 |

方向单向:**第二档调用第一档,第一档对第二档的存在完全无感知**。第一档不关心自己是被「TAPD 定时任务」还是「人对话」触发 —— 这正是「通用」的含义。

---

## 1. 第一档:研发流水线(通用执行引擎)

### 1.1 输入契约(唯一入口)

```typescript
interface PipelineInput {
  title: string
  description: string
  /** git 上下文:仅当「发起处的工作空间绑定了 git」才存在 */
  git?: {
    repoUrl: string
    defaultBranch: string   // master 或 main,取仓库真实默认分支
    worktreePath?: string   // 已 clone / adopt 则复用
  }
  /** 溯源:谁交进来的,仅记账用,不影响执行 */
  source?: { kind: 'tapd' | 'chat'; ref?: string }
}
```

两个入口喂同一种对象:

- **对话模式**:人在会话里选「研发流水线」预设,写需求 → 当前工作空间绑了 git 就带 `git`,没绑就不带。
- **定时任务模式**:第二档拉取 TAPD 需求,`title + description` 拼成同一个 `PipelineInput`,按 module 绑定补 `git`。

### 1.2 执行流程(固定角色序列)

```
context → clarification → brainstorm×3 → critic → decision → spec
→ planning → implementing(逐 task) → testing → fixing(需要时)
→ verifying → reviewing×2 → final-verifying×2
```

角色之间只靠 `artifacts/` 产物文件交接(见 `auto-rd-session-native-pipeline.md` §3 契约表)。spawn 时带 `persona` + `toolFilter` + `maxDepth: 1`(角色不能再 spawn 子 agent)。

### 1.3 终点与条件 push

- **终点 = `delivery_ready`**:代码 ok + 2 轴 review 全过 + 2 轴 final-verify 全过。
- **push 是尾部条件步骤**(归属第一档):
  - `git` 存在 → 从 `defaultBranch` 建 worktree/分支 → commit → push;
  - `git` 不存在 → 跳过分支/commit/push,代码留在工作空间;`review` / `final-verify` **仍跑**(审产物文件,不依赖 git)。

### 1.4 第一档拥有的状态

```
pending → context → clarification → brainstorm → critic → decision
       → spec → planning → implementing → testing → fixing
       → verifying → reviewing → final_verifying → delivery_ready
(另有 failed / blocked 两个护栏终态)
```

**边界红线**:第一档**不碰** TAPD、**不建** MR、**不轮询**任何外部状态、**不关闭**任何需求。

---

## 2. 第二档:定时任务处理流程(外层编排,嵌套第一档)

### 2.1 五个阶段

```
① 拉取 ──► ② 嵌套执行 ──► ③ 交付 ──► ④ 推进 ──► ⑤ 日扫关闭
```

### ① 拉取(TapdAdapter,定时)

- 轮询 `status=planning` 的 TAPD 需求;
- 每条:`title + description` 拼接 → `PipelineInput`(按 module 绑定补 `git`);
- **本地护栏**:该 story id 已是终态(`delivery_ready` / `mr_opened` / `completed`)→ **不覆盖、不回 pending**(防 `modified` 抖动 / cursor 回退导致已完成需求被重置)。

### ② 嵌套执行(调第一档)

- 以 `PipelineInput` 启动一个 `rd-pipeline` 会话;
- 第一档跑完回到 `delivery_ready`,返回给外层。

### ③ 交付(独立交付任务,按 workspace 配 reviewer / 目标分支)

- 仅当 `git` 存在:`delivery_ready` → 建 MR(`createOrReuseMR` 用第一档已 push 的分支);
- 无 git → 跳过交付(没 git 就没 MR),`delivery_ready` 就是最终态。

### ④ 推进(MR 创建后即时,防重拉)

- `syncTapd(status: '评审中', mr_url, git_branch)` —— **状态推进 + 写链接**;
- 本地 `story.state = mr_opened`(语义:MR 已开、等合并)。

### ⑤ 日扫关闭(每天 20:00,一次)

- 只扫 `state == mr_opened` 的 story,读 GitLab MR `state`,**三分支**:

| MR `state` | 动作 | story 状态变化 |
|---|---|---|
| `merged` | `syncTapd(status: 'completed')` 关闭 TAPD | `mr_opened` → `completed` |
| `closed`(没合就关) | 回退 TAPD 状态 + 通知人 | → 人工处置 |
| `opened`(还没合) | **什么都不做** | **保持 `mr_opened`** |

- **`opened` 分支零副作用**:不写账本、不调 TAPD、不改状态,明晚再扫。
- 调度:DSH 插件内无原生 cron,用 30~60 分钟粗定时器 + `lastSweepDate` 检查点实现「每天 20:00 跑一次」,幂等。

### 2.2 第二档拥有的状态

```
delivery_ready ──(③交付)──► mr_opened ──(⑤日扫 merged)──► completed
                               │
                               └──(⑤日扫 closed)──► 回退/通知(人工)
```

---

## 3. 嵌套关系图(总览)

```
┌──────────────────────────────────────────────────────────────┐
│ 第二档:定时任务处理流程(外层)                                  │
│                                                              │
│ ① 拉取    TapdPoller 轮询 planning                            │
│    └─► title+description → PipelineInput                     │
│ ② 嵌套执行 ─────────────────────────────┐                    │
│ ③ 交付    建 MR(按 workspace 配 reviewer/目标分支)            │
│ ④ 推进    syncTapd(评审中)+ 链接 → mr_opened                  │
│ ⑤ 日扫    每天 20:00 扫 mr_opened                             │
│                                                              │
│    ┌────────────────────────▼──────────────────────────┐     │
│    │ 第一档:研发流水线(内层,通用引擎)                     │     │
│    │   context → … → final-verifying×2                 │     │
│    │   [git] 建分支/commit/push                         │     │
│    │   终点 delivery_ready                              │     │
│    └────────────────────────┬──────────────────────────┘     │
│                             └─► 返回 delivery_ready           │
└──────────────────────────────────────────────────────────────┘
```

**对话模式(人直接选第一档)**走同一条尾部:`delivery_ready → ③交付 → ④推进 → ⑤日扫`,只是少了 ①②,`source.kind = 'chat'`。交付/推进/关闭这套尾部逻辑对两个入口**完全复用**。

---

## 4. 状态归属划分(账本)

| 状态 | 归属 | 含义 |
|---|---|---|
| `pending` … `final_verifying` | 第一档 | 角色执行流程 |
| `delivery_ready` | 第一档(终态) | 代码 ok,待交付 |
| `mr_opened` | 第二档 | MR 已开,等合并 |
| `completed` | 第二档(终态) | 已合并 + TAPD 已关 |
| `failed` / `blocked` | 两档共用护栏 | 护栏触发 / 人工 checkpoint |

---

## 5. 代码改动映射(现状 → 去向)

| 现状 | 去向 |
|---|---|
| `story-runner.ts` 的 `STAGE_HANDLERS[mr_creating/tapd_syncing]` | 移出流水线 → 第二档交付任务 + 日扫任务 |
| `gitlab-merger.ts` 的 `pushBranch` | 第一档尾部条件步骤(git 绑定时) |
| `gitlab-merger.ts` 的 `createOrReuseMR` | 第二档交付任务 |
| `tapd-poller.ts` 的 `syncTapd`(写死 `completed`) | 第二档,状态参数化(`评审中` / `completed`) |
| `StoryStateSchema` 19 态 | 拆两段:第一档到 `delivery_ready`,第二档加 `mr_opened` |
| `story-runner.ts` 的 `ensureSession` | 输入从 TAPD story 泛化为 `PipelineInput` |
| `config.ts` | 加 per-workspace 交付配置(reviewer / 目标分支) |
| 新增 `delivery-task` / `mr-sweep` | 第二档两个新 service |

---

## 6. 落地顺序

按依赖递进:

1. **A 拓扑修复** — `ensureSession` 传 `parentSession` + `agentPreset`;dispatch 补 `parentSession`/`maxDepth`/`toolFilter`;`implementationSessionId` 写入。
2. **C AC 语义** — 删 hard-gate + spec 生成 AC + 校验改读生成 AC(独立于两档)。
3. **B1 通用化** — `PipelineInput` 输入契约 + 流水线止于 `delivery_ready` + 条件 push。
4. **B2 交付闭环** — 交付任务 + `syncTapd` 状态参数化 + 20:00 日扫三分支 + `mr_opened` 状态。

---

## 7. 待定实现细节

1. **交付任务触发方式**:`delivery_ready` 状态翻转发事件(事件驱动)vs 交付任务自己轮询 `delivery_ready`。倾向事件驱动(符合 DSH Cordis Event 机制)。
2. **`PipelineInput.git.worktreePath` 的来源**:对话模式从「当前工作空间」取,定时模式从 module 绑定取;两者归一化成同一字段,具体取用时机待定。
3. **`syncTapd` 的中间状态名**:`评审中` 只是语义名,TAPD 实际状态码(如 `developing` / `reviewing`)按部署的工作流字典确定。
4. **closed(没合)分支的回退动作**:回退到 TAPD 的哪个状态 + 通知谁,尚未定,先按「通知人」最小实现。
