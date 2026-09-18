# Auto-RD 会话原生化流水线 — 实现设计

> 状态:设计稿(待评审)
> 关联:[PRD — 会话原生化重构](../prd-session-native-pipeline.md)、[真 Plugin 架构设计](./auto-rd-native-plugin-design.md)
> 本文档把 PRD 的 §5「架构设想」落成可实施的设计,聚焦四件事:**状态模型、产物契约、回退规则、护栏参数**。

---

## 1. 核心设计决策

### 1.1 形态:一条 agent preset(会话模式)

流水线从「plugin 后台状态机」改为「DSH 的 agent preset」:

- **preset id**:`rd-pipeline`
- **preset 中文名**:研发流水线
- 一个 TAPD 需求 = 一个主会话,创建时传 `meta: { cwd: worktree, parentSession: <工作区会话>, agentPreset: 'rd-pipeline' }`。

「创作模式」(`cordis`)就是这套机制的先例:preset 只决定「会话挂哪些工具、哪些 prompt 段落、哪个人设」,驱动权在会话自己。

### 1.2 编排方式:剧本复用 + 编排手册

- **编排手册**(一份精简 system prompt section):只写「角色先后顺序 + 产物契约 + 交接规则」,由 auto-rd 插件通过 `systemPrompt.section()` 注册。它决定「下一步该谁、产物写哪个文件」。
- **角色剧本**(`src/agents/personas/*.md`,13 份已存在):每个角色「你是谁、只干什么、怎么写产物」,spawn 时作为 `SubagentStartRequest.persona` 下发。不重复写进编排手册。

这正好命中 DSH 原生 API:`SubagentStartRequest` 的 `persona` 字段会被注册成 child 的 `deployment:persona-prefix` section,**只对该 child 生效**;`toolFilter` 字段通过 `tools.restrict()` 让角色**物理上拿不到白名单外的工具**——「每个角色只干一件事」从 prompt 约束升级成工具层硬约束。

### 1.3 交接方式:产物文件,不是会话历史

角色之间的唯一接口是 artifacts 目录下的产物文件。上一个角色写、下一个角色读。**这绕开了「子会话继承父会话历史」这个 DSH 未完全确证的能力**——DSH 确证的是「子 agent 加入父方组装(工具 + prompt sections)」,而非「子会话直接读到父会话对话历史」。走文件交接,既不依赖后者,又把「每个角色只干一件事」变成硬约束(角色手里只有上一个产物,没法越界)。

### 1.4 状态机:从「驱动者」降级为「账本 + 护栏」

现状 `StoryRunner` 的 `STAGE_HANDLERS` 是**驱动者**——while 循环按 19 态硬推。会话原生化后:

- **主会话 agent 是驱动者**:读编排手册,决定下一步 spawn 谁、如何处置结果。
- **`StoryRecord.state` + 回退/护栏逻辑是账本**:记录「走到哪、每步产物状态、重试次数」,并守护「回退不失控、递归不失控」。
- **确定性 handler 保留为 fallback**:「无 model 也能推进」是现有特性(agent-provider.ts 注释明确「the machine advances with or without a model attached」)。编排不删除它,而是把主 agent 的增量判断作为**增强层**——顺序骨架和护栏永远确定,每步「怎么干、产出什么」由模型决定。

一句话:**顺序骨架固定(确定),每步执行交模型(增量),失败回退守护栏(有界)。**

---

## 2. 状态模型(账本)

### 2.1 现状已有,直接复用

`StoryRecord`(`domain/schema.ts:150`)与 `TaskRecord`(`:194`)已经是账本雏形,字段不动:

- `story.state`(19 态)、`story.retryCount`、`story.artifacts`(产物引用表)、`story.blockedReason`
- `task.status`(pending/in_progress/completed/failed/blocked)、`task.attemptCount`、`task.blockedReason`
- `TrajectoryEvent`(轨迹表)已是标准执行日志(SD-7)

### 2.2 新增字段(会话原生化的账本增量)

```typescript
// StoryRecord 增补
interface StoryRecord {
  // 已存在:mainSessionId
  mainSessionId?: string            // 主会话 id(现状已有,但要补 agentPreset)
  agentPreset?: string              // 新增:主会话绑定的 preset id,创建时落盘
  parentSessionId?: string          // 新增:工作区会话 id,会话树挂靠
  totalSteps: number                // 新增:累计 spawn 角色次数(总步数护栏)
  loopCount: number                 // 新增:当前「修复循环」已回退次数(回退护栏)
}

// TaskRecord 增补
interface TaskRecord {
  implementationSessionId?: string  // 已存在:implementation 子会话 id(现状字段,补齐写入)
}
```

### 2.3 账本写入时机(薄 runner 守护)

host 侧保留一个**薄 runner**(不再是 19 态 STAGE_HANDLERS,而是编排原语的守护者):

1. 主 agent 通过工具(如 `auto_rd_advance`)请求「spawn 角色 X」;
2. 薄 runner:spawn subagent(带 `persona` + `toolFilter` + `maxDepth`)→ 等结果 → 读产物 → **写账本**(state 前进 / 回退 / 计数)→ 执行护栏;
3. 主 agent 读账本 + 编排手册,决定下一步。

编排的**决策权**在主 agent,账本与护栏的**执行权**永远在 host 代码——模型再聪明也改不了「重试 ≥ N 就 failed」这条确定规则。

---

## 3. 产物契约清单

artifacts 根:`worktree/.auto-rd/stories/<story-id>/artifacts/`。列名与现状 handler 实际写的一致(`agent-provider.ts` 各 `writeFileSync` 行号)。

| # | 角色(persona) | 读(输入产物) | 写(输出产物) | 裁决 → 下一步 |
|---|---|---|---|---|
| 1 | context | story title+description | `01-context.md` | 无条件 → clarification |
| 2 | clarification | `01-context.md` | `02-clarification.md` | 无条件 → brainstorm(**删除 AC hard-gate**,见 §7) |
| 3 | brainstorm ×3 | `01,02` | `03-proposal-{minimal,clean,novel}.md` | ≥1 成功 → critic;全失败 → failed |
| 4 | critic | `03-*.md` | `04-critique.md` | 系统性缺口 → 回 clarification;否则 → decision |
| 5 | decision | `03-*.md,04` | `05-decision.md` | 无条件 → spec |
| 6 | spec | `05` | `06-spec.md`(**AC 在此生成**) | 无条件 → planning |
| 7 | planner | `06` | `07-tasks.md` | parse 成 TaskRecord;零任务 → blocked |
| 8 | implementation(×N task) | `07,06` | `08-impl-<taskId>.md` + 代码 | 全完成 → testing |
| 9 | test | `08-*.md` | `09-test-report.md` | PASS → verifying;FAIL → fixing |
| 10 | fix | `08-*,09` | `10-fix-report-attempt-<n>.md` | → testing(再验) |
| 11 | verification | `08-*,06,11` | `11-verify-report.md` | 非 PASS → fixing;PASS → reviewing |
| 12 | review ×2(standards/spec) | 全部 | `12-review-<taskId>-<axis>.md` | CHANGES → fixing;双 APPROVE → final_verifying |
| 13 | final-verify ×2 | 全部 | `13-final-verify-<axis>.md` | rejected → fixing;双通过 → mr_creating |
| 14 | mr_creating | — | `99-mr.md` + 真实 MR | checkpoint → tapd_syncing |
| 15 | tapd_syncing | `99-mr.md` | `98-tapd-sync.md` + 真实同步 | checkpoint → completed |

**交接铁律**(写进编排手册 + 每个 persona):

- 角色**只写自己的输出产物**,不碰别的文件(现状 `implementation.md` 已写「Do NOT touch spec/tasks/decisions artifacts」,推广到全部 persona)。
- 角色**只读契约表里列的输入产物**,其余文件不看。
- 产物文件名是交接的锚点:下一个角色按固定文件名读,不存在则报「上一步产物缺失」→ 薄 runner 回退,而不是继续往前冲。

---

## 4. 回退规则

现状回退散落在各 stage handler 的 `return 'fixing'` / `return 'clarification'` 里。会话原生化后显式化为一张表,每个回退**必须配对 breaker**(否则就是死循环)。

| 触发点 | 回退到 | 配对 breaker |
|---|---|---|
| critic 报系统性缺口(CRITIQUE_BLOCKED) | clarification | `retryCount ≥ 3 → failed` |
| test 报 FAIL | fixing | SD-4 5-round breaker(`SUM attemptCount ≥ 5 → blocked`) |
| verification 非 PASS | fixing | 同上 |
| review 任一轴 CHANGES | fixing | 同上 |
| final-verify 任一轴 rejected | fixing | 同上 |
| 产物文件缺失(交接断链) | 上一个角色 | `loopCount ≥ K → blocked`(新增,§5.3) |
| config/编程错误(handler 抛) | 本阶段重试 | `retryCount ≥ 3 → failed` |
| 网络/transient(mr/tapd) | 本阶段重试 | checkpoint 幂等 + `tapdSyncAttempts ≥ 20 → failed` |

**回退的语义**:「回退」不是让状态机跳回,而是主 agent 读账本后重新 spawn 对应角色,交接物带上**失败原因**(如 `fix` 的 `inputs.fix.failureId = F-<taskId>-<attempt>`)。产物里留痕,轨迹表记录 `state_transition` 的 from/to 对,可回溯。

---

## 5. 护栏参数(集中化)

### 5.1 DSH 原生护栏(直接传参,不自己写)

| 护栏 | 机制 | 用法 |
|---|---|---|
| 无限递归开子 agent | `delegationDepth` + `maxDepth` + `SubagentDepthError` | 每个角色 subagent spawn 时传 `maxDepth: 1`(角色自己不能再生子) |
| 角色越界 | `toolFilter`(tools.restrict) | 每个 persona 配白名单工具集 |
| 父子关系 | `childSessionMeta.parentSession` | 主会话 spawn 子会话自动挂靠 |

### 5.2 现状已有护栏(照搬)

| 参数 | 值 | 出处 |
|---|---|---|
| 每阶段重试上限 | `retryCount ≥ 3 → failed` | story-runner.ts:169 |
| fixing 5-round breaker | `SUM attemptCount ≥ 5 → blocked` | story-runner.ts:751 |
| tapd 同步放弃 | `tapdSyncAttempts ≥ 20 → failed` | story-runner.ts:1158 |
| 无进展检测 | `next === state → halt` | story-runner.ts:183 |
| 并发上限 | `maxTotalConcurrentStories` / `maxConcurrentStoriesPerModule` | story-queue.ts |

### 5.3 新增护栏(会话原生化的缺口)

| 护栏 | 值(建议) | 理由 |
|---|---|---|
| 总步数上限 | `story.totalSteps ≥ 40 → blocked` | 防编排漂移:一条需求最多 40 次角色 spawn,超了说明流程卡死 |
| 回退循环上限 | `story.loopCount ≥ 5 → blocked` | 防「修复↔校验」无限循环:fixing breaker 只挡住 fixing 内部,这个挡住跨阶段反复回退 |
| 交接断链检测 | 产物缺失即回退 + 计入 loopCount | 见 §4 |

所有护栏触发都落到 `state = blocked`(带 `blockedReason`),由现有 `auto_rd_status` / `auto_rd_retry` 工具暴露给人工,绝不默默飞。

---

## 6. 编排手册(草案)

`systemPrompt.section('auto-rd-pipeline')` 注册,内容骨架:

```markdown
你是「研发流水线」的编排者。一条 TAPD 需求交给你,你按固定顺序推进,
每步 spawn 一个角色 subagent,角色之间只靠 artifacts 目录下的产物文件交接。

角色顺序(不可跳、不可乱序,除非回退规则允许):
context → clarification → brainstorm×3 → critic → decision → spec
→ planning → implementing(逐 task) → testing → fixing(必要时)
→ verifying → reviewing×2 → final-verifying×2 → mr_creating → tapd_syncing

交接规则:
- spawn 角色前,先确认它的输入产物文件已存在(见产物契约表);
- 角色完成后,读它写的产物文件,判断裁决 → 前进 / 回退;
- 每次回退都要带上失败原因,且回退次数受护栏限制(由 host 侧强制执行)。

你只做编排与裁决,不亲自写代码、不亲自写 spec——那些是角色 subagent 的事。
```

「每个角色只干一件事」不在手册里展开(那是 persona 的事),手册只守住「顺序 + 交接 + 裁决」三个轴。

---

## 7. AC 语义修正(独立于 preset)

PRD §5.3,与 preset 无关、先行落地:

- 删除 `clarify.ts:150` 的 `missing_acceptance_criteria` hard-gate;
- AC 在 `spec` 阶段从 `title + description + 选定方案` 生成,写入 `06-spec.md`;
- `verifying` / `reviewing` / `final-verify` 对照**生成的 AC** 验证。

---

## 8. 分阶段落地

O-1~O-4 已从 DSH 源码确证(见 PRD 勘误),B 不再有上游阻塞,但仍按依赖拆分、分三块递进:

| 块 | 内容 | 依赖 | 风险 |
|---|---|---|---|
| **A 拓扑修复** | `ensureSession` 传 `parentSession` + `agentPreset`;dispatch 补 `parentSession`/`maxDepth`/`toolFilter`;`implementationSessionId` 写入 | 无 | 低 |
| **C AC 语义** | 删 hard-gate + spec 生成 AC + 校验改读生成 AC | 无 | 低(独立) |
| **B 编排迁移** | preset `rd-pipeline` 目录 + 编排手册 section + 薄 runner(账本/回退/护栏)+ 主 agent 驱动 | A | 高(大块) |

**建议顺序:A + C 先做**(两者互不依赖、都是 B 的前置),B 单独一个里程碑。

---

## 9. 与现状代码的映射

| 现状 | 去向 |
|---|---|
| `STAGE_HANDLERS`(story-runner.ts:104) | 收敛为薄 runner 的「编排原语」,业务 if/else 进编排手册 |
| `runStory` while 循环(:136) | 保留,但从「驱动」改为「守护账本 + 执行护栏」 |
| `ensureSession`(:217) | 补 `parentSession` + `agentPreset`(A 块) |
| `agentProvider.dispatch` fire-and-forget(:267) | 改为「spawn + 等结果 + 写账本」,`childId` 不再丢弃 |
| 13 份 `personas/*.md` | 原样复用为角色剧本(B 块按需下发) |
| `clarifyStory` hard-gate(clarify.ts:150) | 删除(C 块) |
| `recordArtifact` 产物表 | 升级为 §3 契约表,补交接断链检测 |
| `TrajectoryEvent` 轨迹 | 复用,增补 `loopCount`/`totalSteps` 到 state_transition payload |

---

## 10. 待定实现细节

1. **preset 交付方式**:shipped(包内自带目录)还是 user copy?DSH 支持 shipped root + user root + copy 机制,auto-rd 包内带一份 `rd-pipeline` preset,由安装流程复制到 `~/.dsh/.agent-presets/`。
2. **主 agent 驱动工具**:新增一个 `auto_rd_advance`(或复用 `auto_rd_trigger.advance_story`)让主 agent 显式推进,还是薄 runner 自动 tick?倾向后者(账本驱动,主 agent 只做裁决),但需确认主 agent 的裁决如何回传 host。
3. **`10-fix-report.md` vs `10-fix-report-attempt-<n>.md`** 命名不一致(recordArtifact 与 handler 各写一套),B 块统一。
