# docs/architecture 设计文档与代码同步差距盘点

> 生成时间：2026-01
> 触发：M1-M4 全 commit push 完成（13 个 commit）后，发现 `docs/architecture/` 三份文档严重过时
> 目的：列出"文档说"与"代码做"的差距，让用户决定修复范围

---

## 1. 盘点结论

`docs/architecture/` 下三份文档的"最后修订时间"全部是 first commit，**M1-M4 期间 13 个 commit 没碰过任何文档**。

| 文档 | 角色 | 当前状态 |
|---|---|---|
| `auto-rd-native-plugin-design.md` | 主设计文档 | 严重过时（缺 M2/M3/M4 全部内容） |
| `auto-rd-plugin-architecture.md` | 探索报告 | 标"探索"，已过时 |
| `auto-rd-sandbox-capability-matrix.md` | dynamic plugin 能力矩阵 | 已被 native plugin 取代 |

---

## 2. 主设计文档逐节差距

### §3.1 服务列表

文档列了 8 个服务名。实际代码文件 13 个 + tool 文件 4 个：

| 文档列 | 实际文件 | 差距 |
|---|---|---|
| `tapdPoller` | `services/tapd-poller.ts` | ✅ 一致（但缺 syncTapd exported function 说明） |
| `storyQueue` | `services/story-queue.ts` | ✅ 一致 |
| `agentRunner` | `services/agent-runner.ts` | ❌ **改名了**，实际叫 `story-runner.ts` |
| `workspaceManager` | `services/workspace-manager.ts` | ✅ 一致 |
| `gitlabMerger` | `services/gitlab-merger.ts` | ✅ 一致（M4 加） |
| `storyNotifier` | `services/story-notifier.ts` | ✅ 一致（M4-U5 加） |
| `autoRdSidebarPanel` | `services/ui-panel.ts` | ✅ 一致（M4-U7 加）但文件名变了 |
| `autoRdSubagentProvider` | `services/agent-provider.ts` | ⚠ 改名 `agent-provider.ts` |
| -- | `utils/http-client.ts` | ❌ **文档完全没提**（M4-A1 加，是 M4 基础设施） |
| -- | `services/recover.ts` | ❌ **§3.1 没列**，只在 §10.2 提了一句 |
| -- | `services/planner-parser.ts` | ❌ **完全没提**（M3 加，planner markdown 解析） |
| -- | `services/system-prompt-section.ts` | ❌ **完全没提**（M4-U6 加） |
| -- | `tools/auto-rd-status.ts` | ❌ **§3.1 没列**，§12.1 提了但签名过时 |
| -- | `tools/auto-rd-trigger.ts` | ❌ **§3.1 没列**，§12.2 提了但签名过时 |
| -- | `tools/auto-rd-retry.ts` | ❌ **§3.1 没列**，§12.3 提了但签名过时 |

### §4.1 storageDomain 表结构

| 项 | 文档说 | 代码实际 | 差距 |
|---|---|---|---|
| Domain version | `version: 1` | `AUTORD_DOMAIN_VERSION = 3` | ❌ 落后2 个版本 |
| TaskRecord.status enum | `pending / in_progress / completed / failed` | `+ 'blocked'` | ❌ 缺 blocked |
| TaskRecord.attemptCount | 无 | `number default 0` | ❌ 缺 |
| TaskRecord.payload | 无 | `{taskId, title, files, dependsOn, ...}` | ❌ 缺 |
| TaskRecord.blockedReason | 无 | `optional` | ❌ 缺 |
| StoryRecord.checkpoint 字段 | 无 | `pushedSha, pushedAt, mrIid, mrCreatedAt, mrReused, tapdSyncedAt, tapdSyncAttempts` | ❌ **M4 加 7 个 checkpoint 字段全没提** |
| 模块表同步 | modules + stories + tasks | 一致 | ✅ |

### §5 状态机

| 项 | 文档说 | 实际 | 差距 |
|---|---|---|---|
| 19 state 列表 | 19 个 | 19 个 | ✅ 一致 |
| 转移路径 | 描述 | 真实 | ⚠ 文档笼统，**缺**：<br>- `mr_creating` 的 checkpoint 模式（push / MR create / 部分失败后不重做已完成步骤）<br>- `tapd_syncing` 的 20 次 cap <br>- `fixing` 的 SD-4 5-round breaker 实现位置<br>- `reviewing` 的 CR-1 双轴并行<br>- `final_verifying` 的 SD-6/DP-1/DP-2 双轴并行 |
| 转移图 | 一段 ASCII | 实际 | ⚠ 准确但简陋 |

### §6 Agent

| 项 | 文档说 | 实际 | 差距 |
|---|---|---|---|
| 13 Agent 列表 | 13 个 | 13 个 | ✅ 一致 |
| ImplementationAgent tool filter | `bash, git_status, git_diff` | `bash, git_status, git_diff, git_log, git_commit`（M3 加） | ❌ 缺 git_log/git_commit |
| TestAgent tool filter | 列出 | `bash, git_diff, git_log, fs_write, fs_read, fs_search, fs_glob` | ⚠ 不全 |
| FixAgent tool filter | 列出 | 类似 | ⚠ 不全 |
| Brainstorm 3 variations | `minimal/clean/novel` | 一致 | ✅ |
| ReviewAgent 2 axes | 文档没提 | `standards/spec`（CR-1） | ❌ **完全没提双轴并行** |
| FinalVerifyAgent 2 axes | 文档没提 | `standards/spec`（SD-6） | ❌ **完全没提** |
| Stage-Agent 映射表 | 列出 | 一致 | ⚠ 部分 sentinel token 表述需更新 |

### §7 Event 桥接与 UI

| 项 | 文档说 | 实际 | 差距 |
|---|---|---|---|
| §7.1 Sidebar | 概念 + 代码片段 | 实际是 JSON tree 渲染，不依赖 React | ⚠ **文档用了 React.createElement，**实际不用**——能跑但误导** |
| §7.2 StoryNotifier | 概念 | 实际是 polling-based 不是 event-driven | ⚠ **重大偏差**——文档假设有 `story-blocked` Cordis event，**实际是 5s 轮询 storage** |
| 3 tools 完整签名 | 草稿 | 实际参数 schema 完整 | ⚠ 需更新 |
| System-prompt section | 没提 | M4-U6 加 | ❌ 缺 |
| 缺 best-effort fallback | 没提 | U8 实现容错（DSH service 不在时 warn + skip） | ❌ 缺 |

### §8 GitLab MR 集成

| 项 | 文档说 | 实际 | 差距 |
|---|---|---|---|
| §8.1 MR 创建流程 | 描述 | 一致 | ✅ |
| §8.2 回写 TAPD | 概念 | 实际有 syncTapd exported function + POST /changes + 404→PATCH fallback | ⚠ 文档只说"PATCH /v1/stories/<id>"，实际尝试 POST 优先 |
| Idempotent recovery | 没提 | **M4 核心设计**——checkpoint 模式 + restart-friendly | ❌ **完全没提**——这是 M4 最重要设计 |
| projectIdFromRepoUrl | 没提 | URL-encoded path 转换 | ❌ 缺 |

### §9 TAPD 集成

| 项 | 文档说 | 实际 | 差距 |
|---|---|---|---|
| §9.1 字段映射 | 列出 | 一致 | ✅ |
| §9.2 凭证存储 | 提到 | 实际有 `useTapdMock` 开关 + 真 HTTP 客户端 | ⚠ 文档没提 useTapdMock 双模式设计 |
| 多 workspace 支持 | 没提 | `tapdWorkspaceIds: string[]` | ❌ 缺 |

### §10 跨重启恢复

| 项 | 文档说 | 实际 | 差距 |
|---|---|---|---|
| §10.2 恢复实现 | "从当前 state 重新开始" | **M4-A 加了 checkpoint——mr_creating 已 push 但未建 MR 时，recover 不重做 push** | ⚠ 文档笼统，缺 checkpoint 说明 |
| §10.3 Artifact 保护 | 一段 | 一致 | ✅ |

### §12 人工介入

| 项 | 文档说 | 实际 | 差距 |
|---|---|---|---|
| §12.1 Blocked 触发场景 | 列出 | 一致 | ✅ |
| §12.2 通知机制 | 概念 | 实际是 5s 轮询 + subagents.sendMessage | ⚠ 跟 §7.2 同一偏差 |
| §12.3 auto_rd_retry | 代码片段 | 实际多了 `reset_to_pending` action | ⚠ 文档缺这个 action |

### §13.2 Plugin apply 顺序

文档说 5 步，实际 6 步：

```
实际：                            文档：
1. storage                       1. storage
2. seed modules                  2. seed modules
3. services                      3. services
4. recover                       4. recover
5. timers effect                 5. timers effect
6. UI effect (tools/slots/prompt)  -- 缺
```

### §14 M1 实施计划

文档**只有 M1 计划**。M2/M3/M4 全无记录——M2/M3/M4 已完成但文档没记：

- M2 = "wire the seven pre-spec stages end to end"（a3d17bb）
- M3 = 5 commit（10d9c6f, 9e8c3b9, f7a49d5, 2c90f2a, ad3318d）
- M4-A = 6 commit（GitLab + TAPD 真接）
- M4-UI = 8 commit（tools + sidebar + notifier + prompt section）

**§14 应该新增 M2/M3/M4 实施总结段 + 链接到 git log**。

### 附录 A

| 项 | 文档说 | 实际 | 差距 |
|---|---|---|---|
| A.1 为什么不直接用 dynamic plugin | 一致 | 一致 | ✅ |
| A.2 真 Plugin 安装路径 | 一致 | 一致 | ✅ |
| A.3 部署/测试流程 | 一致 | 一致 | ✅ |
| A.4 调试 | 一致 | 一致 | ✅ |
| **缺 M4 设计回顾** | 无 | 应有：M4 的核心设计是 checkpoint + idempotent recovery（不是"接真服务"那么简单） | ❌ 缺 |
| **缺 M4-UI 设计回顾** | 无 | 应有：M4-UI 的核心设计是 best-effort + 本地类型 + Cordis inject 容错 | ❌ 缺 |

---

## 3. 其它两份文档

### `auto-rd-plugin-architecture.md`（探索报告）

**状态**：标"探索报告"，标"基于 DSH 当前能力"。M1-M2 决策**走 native plugin 不走 dynamic plugin**，所以这份报告**结论被否**——但**作为可行性分析**仍然有价值（提供 M1 设计决策依据）。

**建议**：加 header 标"**状态：历史文档**，M1 决策走 native plugin 形态，本报告作为可行性参考保留"。

### `auto-rd-sandbox-capability-matrix.md`

**状态**：dynamic plugin 能力矩阵，**完全被 native plugin 取代**。

**建议**：加 header 标"**状态：已弃用**，auto-rd 已决定走 native plugin 形态（参考 `auto-rd-native-plugin-design.md`），不再使用 dynamic plugin。本文档保留作为 Cordis sandbox 内部行为的参考"。

---

## 4. 修复选项

| 选项 | 工作量 | 价值 |
|---|---|---|
| **A. 全修**：主设计文档逐节对齐 + 其它两份加状态标 | 大，~5-8 个 commit，~半天到1 天 | 高 |
| **B. 只修主文档**：补 §3.1/§4/§5/§6/§7/§8/§13/§14，其它两份加状态 | 中，~3-5 个 commit | 高 |
| **C. 最小修**：只补 §3.1 服务表 + §4 schema + §14 加 M2-M4 总结 | 小，~1-2 commit | 中 |
| **D. 只加状态标**：其它两份加 "历史/弃用" header | 极小，1 commit | 低 |
| **E. 不修**：文档本来就是设计意图（"我们想做成什么样"），不是当前实现状态 | 0 | 0 |

---

## 5. 建议路径

按用户"接着 M4 继续做"的延续原则，**B 是合理的**：
- 主文档需要从"drafted" 状态推进到"in sync with code"
- 其它两份加状态标作为历史归档
- 不重写全文（避免一次 commit 太大），用多个小 commit 分章节补

如果选 B，建议 commit 顺序：
```
gap-analysis.md                          # 本文件，先盘点（已完成）
doc-1 §14 + M2/M3/M4/M4-UI 总结          # 先补最落后的"实施计划"
doc-2 §4 schema version 3                # schema 改动大，先补
doc-3 §3.1 服务列表                      # 13 个文件全列
doc-4 §5/§6 状态机 + agent filter 更新    # 含 5-round breaker + 双轴
doc-5 §7/§8/§12 UI + checkpoint + recovery  # 完整 M4 设计回顾
doc-6 §13.2 apply 顺序 + 新增 §M4 设计回顾 # 整体架构闭环
doc-7 探索报告 + capability matrix 状态标  # 历史归档
```

---

## 6. 询问

请用户回字母告诉我：
- A / B / C / D / E 哪个走？
- 如果 B，C 路径上 7 个 commit 是否全做，还是只做其中几个？