# Auto-RD 真 Plugin 架构设计文档

> 本文档是 auto-rd 项目的**真 Plugin 形态**架构设计（替代之前 dynamic plugin 形态）。
> 
> 项目代号：**auto-rd**
> 目标：基于 DeepSeek Harness 的 TAPD 驱动自动研发流水线
> 形态：**部署级真 Plugin**（不是 dynamic plugin）
> 包名：`@your-org/dsh-auto-rd`

---

## 目录

1. [架构总览](#1-架构总览)
2. [Plugin 工程结构](#2-plugin-工程结构)
3. [核心服务设计](#3-核心服务设计)
4. [存储模型](#4-存储模型)
5. [Story 状态机](#5-story-状态机)
6. [Agent 注册与 SubAgent Provider](#6-agent-注册与-subagent-provider)
7. [Event 桥接与 UI](#7-event-桥接与-ui)
8. [GitLab MR 集成](#8-gitlab-mr-集成)
9. [TAPD 集成](#9-tapd-集成)
10. [跨重启恢复](#10-跨重启恢复)
11. [并发控制](#11-并发控制)
12. [人工介入](#12-人工介入)
13. [依赖关系图](#13-依赖关系图)
14. [M1 实施计划](#14-m1-实施计划)

---

## 1. 架构总览

### 1.1 系统定位

auto-rd 是一个**部署级真 Plugin**，作为 DeepSeek Harness 的扩展组件，随 DSH 启动而自动加载，提供：

- TAPD 需求自动拉取
- 自动化研发流水线（Context → Clarification → Brainstorm → Critic → Decision → Spec → Planner → Implementation → Test → Fix → Verify → Review → Final Verify → MR）
- 与 Harness 原生 Session/Trajectory 的深度集成
- 长期后台调度能力（DSH 运行期间 7x24 可用）

### 1.2 系统全景图

```
┌─────────────────────────────────────────────────────────────┐
│ DeepSeek Harness 进程                                       │
│                                                              │
│  ┌──────────────────────────────────────────────┐           │
│  │  dsh-base (基础 compose)                      │           │
│  │  - timer / storage / subagents / sessions...  │           │
│  └──────────────────────────────────────────────┘           │
│                          ▲                                   │
│                          │ inject                            │
│  ┌──────────────────────────────────────────────┐           │
│  │  @your-org/dsh-auto-rd  ◀── 本 Plugin       │           │
│  │                                               │           │
│  │  ┌────────────────────────────────────────┐   │           │
│  │  │  TapdPoller (轮询服务)                  │   │           │
│  │  │  每 60s 拉取一次 TAPD Story            │   │           │
│  │  └────────────────────────────────────────┘   │           │
│  │           ↓                                    │           │
│  │  ┌────────────────────────────────────────┐   │           │
│  │  │  StoryQueue (队列调度)                  │   │           │
│  │  │  扫描 pending Story → 调用 AgentRunner   │   │           │
│  │  └────────────────────────────────────────┘   │           │
│  │           ↓                                    │           │
│  │  ┌────────────────────────────────────────┐   │           │
│  │  │  AgentRunner (Agent 执行器)            │   │           │
│  │  │  根据 Story state 调用对应 Agent         │   │           │
│  │  └────────────────────────────────────────┘   │           │
│  │           ↓                                    │           │
│  │  ┌────────────────────────────────────────┐   │           │
│  │  │  WorkspaceManager (Workspace 管理)     │   │           │
│  │  │  Module Workspace + Story Worktree     │   │           │
│  │  └────────────────────────────────────────┘   │           │
│  │           ↓                                    │           │
│  │  ┌────────────────────────────────────────┐   │           │
│  │  │  GitLabMerger (MR 集成)                │   │           │
│  │  │  Push Branch + Create MR               │   │           │
│  │  └────────────────────────────────────────┘   │           │
│  │                                               │           │
│  │  ┌────────────────────────────────────────┐   │           │
│  │  │  SidebarPanel (UI 面板)                │   │           │
│  │  │  挂在 sidebar.worktable.project         │   │           │
│  │  └────────────────────────────────────────┘   │           │
│  │                                               │           │
│  │  ┌────────────────────────────────────────┐   │           │
│  │  │  StoryNotifier (通知)                   │   │           │
│  │  │  blocked 时向用户主 session 推送         │   │           │
│  │  └────────────────────────────────────────┘   │           │
│  │                                               │           │
│  │  ┌────────────────────────────────────────┐   │           │
│  │  │  Auto-RD Subagent Provider              │   │           │
│  │  │  注册 12 个 Agent 模板                   │   │           │
│  │  └────────────────────────────────────────┘   │           │
│  │           ↓                                    │           │
│  │  DSH StorageDomain (state) + Workspace Files (artifacts)│
│  └──────────────────────────────────────────────┘           │
│                          ▲                                   │
│                          │ mount                             │
│  ┌──────────────────────────────────────────────┐           │
│  │  dsh-storage / dsh-storage-json / dsh-storage-domain │
│  └──────────────────────────────────────────────┘           │
│                                                              │
│  持久存储:                                                    │
│  • ~/.dsh/storages/auto-rd.json                              │
│  • workspaceRoot/payment/ (Module Workspace)                  │
│  • workspaceRoot/payment/.auto-rd/stories/TAPD-001/          │
│      ├ artifacts/  (大 artifact)                             │
│      ├ worktree/   (Story git worktree)                      │
│      └ spec.md     (沉淀后的 Spec)                            │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 关键设计决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| Plugin 形态 | 真 Plugin | 与 auto-rd 长跑服务本质匹配 |
| Module ↔ Repo 映射 | 配置文件静态映射 | 简单、可控、易调试 |
| Story 隔离 | git worktree | 最干净的隔离，避免并发冲突 |
| Artifact 存储 | 全部进文件系统 | 大 Artifact 不污染 storageDomain |
| 人工介入 | 重要节点 ping 用户 | 平衡自动化与可控性 |
| Story 主对话 | 顶层 session (sidebar 可见) | 用户可点击查看完整对话 |
| 并发控制 | 每个 Module 独立限流 (1 Story) | 避免 Module 资源冲突 |
| UI Surface | Sidebar 面板 | 与其他扩展组件一致 |

---

## 2. Plugin 工程结构

### 2.1 文件组织

```
~/.dsh/profiles/web/node_modules/@yangzhitong/dsh-auto-rd/
├── package.json                    # Node.js 包定义
├── tsconfig.json                   # TypeScript 配置
├── cordis.yml                      # Plugin compose 配置（默认 config 块）
├── README.md                       # 包级说明
├── agents/
│   └── AGENT-SKILL-MAPPING.md      # Pattern ↔ Agent 映射
├── lib/                            # 编译产物 (gitignored，发布时构建)
├── src/                            # TypeScript 源码（ESM .js 后缀）
│   ├── index.ts                    # 主入口 apply(ctx, config)
│   ├── config.ts                   # Config schema (zod, 16 keys)
│   │
│   ├── services/                   # 核心服务（13 个）
│   │   ├── tapd-poller.ts          # TAPD 拉取 + syncTapd 导出函数
│   │   ├── story-queue.ts          # Story 队列 + 调度（10s tick）
│   │   ├── story-runner.ts         # 19-state 状态机 + 5-round breaker
│   │   ├── agent-provider.ts       # 13 agent dispatch + stub handler
│   │   ├── workspace-manager.ts    # Workspace + Worktree
│   │   ├── gitlab-merger.ts        # GitLab MR（M4-A 真接）
│   │   ├── recover.ts              # 跨重启 ACTIVE state → pending
│   │   ├── story-notifier.ts       # 5s 轮询 blocked → user session
│   │   ├── ui-panel.ts             # Sidebar UI（JSON tree renderer）
│   │   ├── system-prompt-section.ts # system prompt section 注册
│   │   └── planner-parser.ts       # Planner markdown → ParsedPlannerTask[]
│   │
│   ├── agents/                     # Agent 模板（13 + base + persona-loader）
│   │   ├── base.ts                 # Agent 基类
│   │   ├── context.ts              # Context Agent
│   │   ├── clarification.ts        # Clarification Agent
│   │   ├── brainstorm.ts           # Brainstorm Agent（3 variations）
│   │   ├── critic.ts               # Critic Agent
│   │   ├── decision.ts             # Decision Agent
│   │   ├── spec.ts                 # Spec Agent
│   │   ├── planner.ts              # Planner Agent
│   │   ├── implementation.ts       # Implementation Agent
│   │   ├── test.ts                 # Test Agent
│   │   ├── fix.ts                  # Fix Agent
│   │   ├── verification.ts         # Verification Agent
│   │   ├── review.ts               # Review Agent（2 axes parallel）
│   │   ├── final-verify.ts         # Final Verify Agent（2 axes parallel）
│   │   ├── persona-loader.ts       # tri 路径 persona 加载
│   │   └── personas/*.md           # 13 persona markdown
│   │
│   ├── domain/                     # 领域模型（zod schema v3）
│   │   ├── schema.ts               # ModuleRecord / StoryRecord / TaskRecord
│   │   └── storage.ts              # AutoRdStorage wrapper
│   │
│   ├── tools/                      # Model-facing tools（3）
│   │   ├── auto-rd-status.ts       # 查看 Story 状态
│   │   ├── auto-rd-trigger.ts      # 手动触发 Story / mark_reviewed
│   │   └── auto-rd-retry.ts        # 手动重试 blocked / failed Story
│   │
│   ├── types/
│   │   └── dsh-services.ts         # DSH service 本地 narrow 类型
│   │
│   └── utils/
│       ├── http-client.ts          # HTTP 客户端（timeout / retry / 错误分类）
│       └── logger.ts               # auto-rd 自己的 logger（5/60s rate limit）
│
├── scripts/                        # 项目级脚本（test / codemod）
│   ├── test-planner-parser.mjs     # Planner markdown parser 单元测试
│   ├── test-m4-fakes.mjs           # M4-A HttpClient / syncTapd / MR 集成测试
│   ├── test-m5-integration.mjs     # M5 recover / tools / queue / logger 测试
│   └── audit-patterns.mjs          # AGENT-SKILL-MAPPING ↔ personas 双向审计
│
├── docs/architecture/              # 设计文档
├── examples/cordis.patch.yml.example  # 部署示例
└── README.md                       # 包级入口
```

> 注：实际**没有** `services/agent-runner.ts`（重命名为 `story-runner.ts`），也没有 `services/notifier.ts`（重命名为 `story-notifier.ts`）。`utils/git.ts` 不存在——git 通过 ctx.fs / ctx.shell / ctx.subprocess 直接调，不封装。`schemas/` 子目录是 draft 设想，**实际所有 schema 都集中在 `domain/schema.ts`**。

### 2.2 package.json

```json
{
  "name": "@yangzhitong/dsh-auto-rd",
  "version": "0.1.0",
  "description": "TAPD-driven automated research & development pipeline for DeepSeek Harness",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/index.d.ts",
      "import": "./lib/index.js"
    }
  },
  "files": [
    "lib",
    "cordis.yml",
    "README.md",
    "LICENSE",
    "NOTICE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json && npm run copy:personas",
    "copy:personas": "node -e \"...copy src/agents/personas/*.md to lib/agents/personas/...\"",
    "watch": "tsc -p tsconfig.json --watch",
    "lint": "tsc --noEmit -p tsconfig.json"
  },
  "keywords": [
    "deepseek-harness", "cordis", "auto-rd", "tapd", "gitlab", "ai-agent"
  ],
  "license": "MIT",
  "dependencies": {
    "zod": "^3.22.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "*",
    "@deepseek-ai/dsh-agent": "*",
    "@deepseek-ai/dsh-session": "*",
    "@deepseek-ai/dsh-tools": "*",
    "@deepseek-ai/dsh-storage-domain": "*"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/cordis":         { "optional": true },
    "@deepseek-ai/dsh-agent":      { "optional": true },
    "@deepseek-ai/dsh-session":    { "optional": true },
    "@deepseek-ai/dsh-tools":      { "optional": true },
    "@deepseek-ai/dsh-storage-domain": { "optional": true }
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.10.0",
    "@deepseek-ai/cordis": "*"
  }
}
```

> 关键设计点：
> - 所有 DSH `peerDependencies` 都标 `optional: true`——这是 §7.5 / §13.1 描述的 **best-effort** 模式：DSH 没在装时 plugin 也能编译 / 跑 / 测试
> - `files` 数组列 `LICENSE` + `NOTICE`——确保发布时 attribution 跟着走（NOTICE 列出 obra/superpowers + mattpocock/skills 来源）
> - `copy:personas` 脚本把 13 persona markdown 从 `src/` 复制到 `lib/`——personas 是运行时文本资产，不走 TS 编译

### 2.3 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./lib",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "lib": ["ES2022"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "lib", "**/*.test.ts"]
}
```

### 2.4 cordis.yml (Plugin 注册到 DSH)

```yaml
# 这里的文件是 ~/.dsh/profiles/web/cordis.patch.yml 里追加的内容：

- id: auto-rd
  name: '@your-org/dsh-auto-rd'
  config:
    # TAPD 接入
    tapdBaseUrl: 'https://api.tapd.cn'
    tapdApiToken: '<your-tapd-api-token>'
    tapdPollIntervalMs: 60000
    
    # GitLab 接入
    gitlabBaseUrl: 'https://gitlab.example.com'
    gitlabApiToken: '<your-gitlab-api-token>'
    
    # Module 静态映射
    workspaceRoot: 'C:/work'
    modules:
      - id: payment
        title: '支付模块'
        repoUrl: 'https://gitlab.example.com/payment/payment-service.git'
        defaultBranch: 'main'
      - id: order
        title: '订单模块'
        repoUrl: 'https://gitlab.example.com/order/order-service.git'
        defaultBranch: 'main'
      - id: user
        title: '用户模块'
        repoUrl: 'https://gitlab.example.com/user/user-service.git'
        defaultBranch: 'main'
    
    # 限流
    maxConcurrentStoriesPerModule: 1
    maxTotalConcurrentStories: 4
    
    # 模型路由
    agentModel: 'sonnet'
```

### 2.5 主入口 src/index.ts

```typescript
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { tapdPoller } from './services/tapd-poller'
import { storyQueue } from './services/story-queue'
import { agentRunner } from './services/agent-runner'
import { workspaceManager } from './services/workspace-manager'
import { gitlabMerger } from './services/gitlab-merger'
import { storyNotifier } from './services/notifier'
import { autoRdSidebarPanel } from './services/ui-panel'
import { autoRdSubagentProvider } from './services/agent-provider'
import { autoRdStatusTool } from './tools/auto-rd-status'
import { autoRdTriggerTool } from './tools/auto-rd-trigger'
import { autoRdRetryTool } from './tools/auto-rd-retry'
import { defineAutoRdDomain } from './domain/storage'

export const Config = z.object({
  tapdBaseUrl: z.string().url(),
  tapdApiToken: z.string(),
  tapdPollIntervalMs: z.number().int().positive().default(60000),
  gitlabBaseUrl: z.string().url(),
  gitlabApiToken: z.string(),
  workspaceRoot: z.string(),
  modules: z.array(z.object({
    id: z.string(),
    title: z.string(),
    repoUrl: z.string().url(),
    defaultBranch: z.string().default('main'),
  })),
  maxConcurrentStoriesPerModule: z.number().int().positive().default(1),
  maxTotalConcurrentStories: z.number().int().positive().default(4),
  agentModel: z.string().default('sonnet'),
})

export const inject = [
  'storageDomain',
  'workspaceRegistry',
  'subagents',
  'tools',
  'timer',
  'web',
  'fs',
  'shell',
  'subprocess',
  'agents',
  'sessionPersistence',
] as const

export function apply(ctx: Context, config: z.infer<typeof Config>) {
  // 1. 打开 storageDomain，定义 storageDomain 表
  const domain = defineAutoRdDomain(ctx.storageDomain)
  
  // 2. 启动各核心服务（ctx.plugin 会建立 fiber 依赖关系）
  ctx.plugin(workspaceManager, { domain, ...config })
  ctx.plugin(storyQueue, { domain, ...config })
  ctx.plugin(agentRunner, { domain, ...config })
  ctx.plugin(tapdPoller, { domain, ...config })
  ctx.plugin(gitlabMerger, { domain, ...config })
  ctx.plugin(storyNotifier, { domain, ...config })
  ctx.plugin(autoRdSidebarPanel, { domain, ...config })
  
  // 3. 注册 SubAgent Provider
  ctx.plugin(autoRdSubagentProvider, { domain, ...config })
  
  // 4. 注册 model-facing tools
  ctx.tools.register(autoRdStatusTool(domain))
  ctx.tools.register(autoRdTriggerTool(domain))
  ctx.tools.register(autoRdRetryTool(domain))
  
  // 5. 注册 system prompt section，让模型知道 auto-rd 可用
  ctx.systemPrompt.section({
    name: 'auto-rd',
    order: 100,
    text: AUTO_RD_SYSTEM_PROMPT,
  })
  
  logger.info('auto-rd plugin started')
}

const AUTO_RD_SYSTEM_PROMPT = `
# Auto-RD Plugin Active

You have access to an automated research and development pipeline that processes TAPD stories.

## Available Tools

- \`auto_rd_status\`: View current state of all stories (pending, in-progress, completed, failed)
- \`auto_rd_trigger\`: Manually trigger or restart a story
- \`auto_rd_retry\`: Retry a blocked/failed story

## Auto-RD Architecture

Each Module in the configured modules array represents a long-lived workspace (e.g., "payment", "order").
Each Story from TAPD is assigned to a Module and processed independently.

When a Story is being processed:
1. Context Agent investigates the codebase
2. Clarification Agent identifies ambiguities
3. Brainstorm Agents propose solutions
4. Critic Agent attacks the proposals
5. Decision Agent forms the final approach
6. Spec Agent writes the formal specification
7. Planner Agent breaks down into implementation tasks
8. Implementation Agents write the code
9. Test/Fix/Verify/Review Agents ensure quality
10. Final Verification + GitLab MR creation

You can observe the entire pipeline through:
- The auto-rd sidebar panel showing all stories and their states
- Each Story's main session containing the conversation timeline
- Sub-sessions for each Agent showing detailed execution
- Tool calls and trajectories visible in the Harness UI

If a story is blocked, the system will notify you with details and required actions.
`
```

---

## 3. 核心服务设计

### 3.1 服务 / 文件清单

> 截至 `feature/m4-ui` HEAD（`58a5945`），`packages/dsh-auto-rd/src/` 下 13 个服务/工具/工具类 + 13 个 agent + 4 个 misc。

| 名称 | 文件 | 角色 | 触发 | 状态 |
|---|---|---|---|---|
| `tapdPoller` | `services/tapd-poller.ts` | 拉 TAPD story 入队 | `tapdPollIntervalMs`（默认 60s）timer | 后台 |
| `syncTapd` (exported fn) | `services/tapd-poller.ts` | 回写 story 状态到 TAPD | `tapd_syncing` stage 调用 | 按需 |
| `storyQueue` | `services/story-queue.ts` | 扫 pending story + 并发限流 + 调 `storyRunner.runStory` | 10s timer | 后台 |
| `storyRunner` | `services/story-runner.ts` | 19-state 状态机推进 | 同步调用 | 按需 |
| `agentProvider` | `services/agent-provider.ts` | 13 个 agent 模板 + SubAgent provider + stub handler | 同步调用 | 按需 |
| `workspaceManager` | `services/workspace-manager.ts` | Module Workspace + Story Worktree 创建/清理 | 同步调用 | 按需 |
| `gitlabMerger` | `services/gitlab-merger.ts` | pushBranch + findExistingMR + createOrReuseMR | `mr_creating` stage 调用 | 按需 |
| `recoverStories` (exported fn) | `services/recover.ts` | Plugin mount 时把 ACTIVE state story 重置回 `pending` | mount 时一次 | 一次性 |
| `storyNotifier` | `services/story-notifier.ts` | 5s 扫 blocked story，推送到 user session | 5s timer | 后台 |
| `autoRdSidebarPanel` | `services/ui-panel.ts` | Sidebar UI（`sidebar.worktable.project` slot） | DSH mount 时注册 | 一次性 |
| `autoRdPromptSection` | `services/system-prompt-section.ts` | System prompt section 注册 | mount 时一次 | 一次性 |
| `httpClient` | `utils/http-client.ts` | 通用 HTTP wrapper：timeout/retry/错误分类 | `gitlabMerger` / `tapdPoller` / `syncTapd` 用 | 共享工具 |
| `plannerParser` | `services/planner-parser.ts` | 解析 Planner markdown 为 `ParsedPlannerTask[]` | `planning` stage 用 | 共享工具 |
| `personaLoader` | `agents/persona-loader.ts` | tri 路径加载 persona markdown（lib/src/cwd） | 每个 agent dispatch | 共享工具 |
| `autoRdStatusTool` | `tools/auto-rd-status.ts` | 模型可调：summary/stories/tasks 查询 | 模型调用 | 一次性注册 |
| `autoRdTriggerTool` | `tools/auto-rd-trigger.ts` | 模型可调：poll_now / advance_story / mark_reviewed | 模型调用 | 一次性注册 |
| `autoRdRetryTool` | `tools/auto-rd-retry.ts` | 模型可调：retry / skip / reset_to_pending | 模型调用 | 一次性注册 |

### 3.1.1 Agents（13 个，模板 + stub handler）

每个 agent 文件都在 `packages/dsh-auto-rd/src/agents/`：

| Agent | 文件 | 输出 artifact | 对应 stage |
|---|---|---|---|
| `ContextAgent` | `context.ts` | `01-context.md` | `context` |
| `ClarificationAgent` | `clarification.ts` | `02-clarification.md` | `clarification` |
| `BrainstormAgent` | `brainstorm.ts` | `03-proposal-{1,2,3}.md` | `brainstorm` (3 路并行: minimal/clean/novel) |
| `CriticAgent` | `critic.ts` | `04-critique.md` | `critic` |
| `DecisionAgent` | `decision.ts` | `05-decision.md` | `decision` |
| `SpecAgent` | `spec.ts` | `06-spec.md` | `spec` |
| `PlannerAgent` | `planner.ts` | `07-tasks.md` | `planning` |
| `ImplementationAgent` | `implementation.ts` | `08-impl-<taskId>.md` | `implementing` (per-task) |
| `TestAgent` | `test.ts` | `09-test-report.md` | `testing` |
| `FixAgent` | `fix.ts` | `10-fix-report.md` | `fixing` |
| `VerificationAgent` | `verification.ts` | `11-verify-report.md` | `verifying` |
| `ReviewAgent` | `review.ts` | `12-review-<taskId>-<axis>.md` | `reviewing` (2 轴并行) |
| `FinalVerifyAgent` | `final-verify.ts` | `13-final-verify-<axis>.md` | `final_verifying` (2 轴并行) |

每个 agent 都有同名 persona markdown 在 `packages/dsh-auto-rd/src/agents/personas/`，由 `persona-loader.ts` 三路查找加载，运行时通过 SubAgent provider 注入到子 session 的 system prompt。

### 3.2 服务依赖图

```
[Plugin mount]
  ├─ tapdPoller ──┐
  ├─ storyQueue ──┤─── timers
  ├─ storyNotifier┘
       ↓
  storyQueue.tick() → storyRunner.runStory()
                          ↓
                       agentProvider.dispatch()
                          ↓              ├─→ workspaceManager
                       (any of 13)      ├─→ gitlabMerger (push + createMR)
                          ↓              └─→ tapdPoller.syncTapd

[Plugin mount / best-effort UI effect]
  ├─ tools:    autoRdStatusTool / autoRdTriggerTool / autoRdRetryTool
  ├─ slots:    autoRdSidebarPanel (sidebar.worktable.project)
  └─ prompt:   autoRdPromptSection

[Plugin mount / once]
  └─ recoverStories (mount 前调)
```

每个服务都通过 Cordis inject 或 ctx.get('xxx') 获取依赖。`tools` / `slots` / `systemPrompt` / `sessions` 在 DSH 进程里提供，**best-effort** —— 拿不到就 warn + skip，plugin 在 DSH 进程外跑只缺 UI 表面。
```

### 3.3 src/services/tapd-poller.ts (TAPD 轮询服务)

```typescript
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from './domain/storage'
import type { Story } from '../domain/story'
import type { Module } from '../domain/module'

interface TapdStoryConfig {
  tapdBaseUrl: string
  tapdApiToken: string
  tapdPollIntervalMs: number
  modules: Array<{ id: string; title: string; repoUrl: string; defaultBranch: string }>
}

export function tapdPoller(
  ctx: Context, 
  config: TapdStoryConfig & { domain: Domain<any> }
) {
  const modules = new Map<string, Module>(config.modules.map(m => [
    m.id, 
    {
      id: m.id,
      title: m.title,
      repoUrl: m.repoUrl,
      defaultBranch: m.defaultBranch,
      workspacePath: `${config.workspaceRoot}/${m.id}`,
      createdAt: new Date().toISOString(),
    }
  ]))

  // 初始化 modules 表
  for (const m of modules.values()) {
    if (!config.domain.table('modules').get(m.id)) {
      await config.domain.table('modules').put(m.id, m)
    }
  }

  const poll = async () => {
    try {
      const stories = await fetchTapdStories(config)
      for (const tapdStory of stories) {
        const moduleId = inferModule(tapdStory)
        if (!moduleId || !modules.has(moduleId)) continue
        
        const storyId = tapdStory.id
        if (config.domain.table('stories').get(storyId)) continue // 已存在，跳过
        
        const story: Story = {
          id: storyId,
          moduleId,
          tapdId: tapdStory.id,
          title: tapdStory.title,
          description: tapdStory.description,
          acceptanceCriteria: tapdStory.acceptance_criteria,
          state: 'pending',
          branch: `auto-rd/${tapdStory.id}`,
          worktreePath: `${config.workspaceRoot}/${moduleId}/.auto-rd/worktrees/${tapdStory.id}`,
          mainSessionId: '',  // 由 agentRunner 创建时填入
          artifacts: {},
          retryCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        
        await config.domain.table('stories').put(storyId, story)
        logger.info(`Enqueued new story ${storyId} for module ${moduleId}`)
      }
    } catch (e) {
      logger.error(`TAPD poll failed: ${e.message}`)
    }
  }

  // 启动定时器
  ctx.effect(() => {
    const dispose = ctx.timer.interval(poll, config.tapdPollIntervalMs)
    return dispose
  }, 'tapd-poller')

  // 立即执行一次
  poll()
}

function inferModule(story: TapdStory): string | null {
  // 根据 story 的字段推断 Module
  // TAPD 通常用 label / category / 字段标识 Module
  return story.module ?? null
}

async function fetchTapdStories(config: TapdStoryConfig): Promise<TapdStory[]> {
  // 调用 TAPD API 拉取待处理 Story
  const url = `${config.tapdBaseUrl}/v1/stories?status=open`
  const response = await ctx.web.fetch(url, {
    headers: { 'Authorization': `Bearer ${config.tapdApiToken}` }
  })
  return response.json()
}
```

### 3.4 src/services/story-queue.ts (Story 队列调度)

```typescript
export function storyQueue(
  ctx: Context,
  config: { domain: Domain<any>, maxConcurrentStoriesPerModule: number, maxTotalConcurrentStories: number }
) {
  const tick = async () => {
    const allStories = [...config.domain.table('stories').values()]
    
    // 找出 pending 和 retrying 的 story
    const candidates = allStories.filter(s => 
      s.state === 'pending' || 
      (s.state === 'failed' && s.retryCount < 3)
    )
    
    // 限流检查
    const executing = allStories.filter(s => isExecuting(s.state))
    if (executing.length >= config.maxTotalConcurrentStories) return
    
    // 按 Module 分组，每个 Module 只允许一个 executing
    const moduleRunningCounts = new Map<string, number>()
    for (const s of executing) {
      moduleRunningCounts.set(s.moduleId, (moduleRunningCounts.get(s.moduleId) ?? 0) + 1)
    }
    
    for (const story of candidates) {
      const count = moduleRunningCounts.get(story.moduleId) ?? 0
      if (count >= config.maxConcurrentStoriesPerModule) continue
      if (executing.length + Object.values(moduleRunningCounts).reduce((a, b) => a + b, 0) >= config.maxTotalConcurrentStories) break
      
      // 触发 Agent 执行
      ctx.agentRunner.runStory(story).catch(e => {
        logger.error(`Story ${story.id} run failed: ${e.message}`)
      })
      
      moduleRunningCounts.set(story.moduleId, count + 1)
    }
  }

  ctx.effect(() => {
    return ctx.timer.interval(tick, 10000)
  }, 'story-queue-tick')

  tick()
}

function isExecuting(state: StoryState): boolean {
  return ['context', 'clarification', 'brainstorm', 'critic', 'decision',
          'spec', 'planning', 'implementing', 'testing', 'fixing',
          'verifying', 'reviewing', 'final_verifying', 'mr_creating']
    .includes(state)
}
```

### 3.5 src/services/agent-runner.ts (Agent 执行器)

```typescript
import { autoRdSubagentProvider } from './agent-provider'

export function agentRunner(
  ctx: Context,
  config: { domain: Domain<any>, agentModel: string }
) {
  // 暴露 runStory 给 storyQueue 调用
  ctx.agentRunner = {
    async runStory(story: Story) {
      const currentState = = story.state
      
      // 创建主 session（如果还没有）
      if (!story.mainSessionId) {
        const session = await ctx.agents.create({
          // ... agent options
          persona: 'auto-rd-orchestrator',
        })
        story.mainSessionId = session.id
        await config.domain.table('stories').put(story.id, story)
      }
      
      // 状态机：驱动 Story 前进
      while (!isTerminalState(story.state)) {
        const next = await executeStage(ctx, story, config)
        if (next === story.state) {
          // 没有变化（blocked），退出循环
          break
        }
        story.state = next
        story.updatedAt = new Date().toISOString()
        await config.domain.table('stories').put(story.id, story)
      }
    }
  }
  
  // ... executeStage 实现：根据当前 state 调用对应 Agent
}
```

---

## 4. 存储模型

### 4.1 storageDomain 表结构

```typescript
// 当前真实 schema（M3 + M4-A 落地后）。代码源：packages/dsh-auto-rd/src/domain/schema.ts
import { z } from 'zod'

const ModuleRecord = z.object({
  id: z.string(),
  title: z.string(),
  repoUrl: z.string().url(),
  defaultBranch: z.string(),
  workspacePath: z.string().describe('Absolute path to the cloned module workspace'),
  createdAt: z.string().describe('ISO 8601 timestamp'),
})

/**
 * 19-state story machine. Terminal: completed, failed.
 * Branch: pending (queue), blocked (human).
 * Active: context → ... → tapd_syncing.
 */
const StoryStateSchema = z.enum([
  'pending',
  'context',
  'clarification',
  'brainstorm',
  'critic',
  'decision',
  'spec',
  'planning',
  'implementing',
  'testing',
  'fixing',
  'verifying',
  'reviewing',
  'final_verifying',
  'mr_creating',
  'tapd_syncing',
  'completed',
  'failed',
  'blocked',
])

const ArtifactRef = z.object({
  kind: z.enum([
    'context', 'clarification', 'proposal', 'critique', 'decision',
    'spec', 'plan', 'implementation', 'test', 'fix',
    'verification', 'review', 'final_verify',
  ]),
  filename: z.string(),  // 相对路径于 worktree/.auto-rd/stories/<id>/artifacts/
  summary: z.string(),
  createdAt: z.string(),
})

/**
 * StoryRecord v3 (M4-A 加 checkpoint 字段后).
 * Checkpoint 字段是 M4 核心设计 —— 见 §8 与 §10.
 */
const StoryRecord = z.object({
  id: z.string(),
  moduleId: z.string(),
  tapdId: z.string(),
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.string().optional(),
  state: StoryStateSchema,
  branch: z.string(),
  worktreePath: z.string().optional(),
  mainSessionId: z.string().optional(),
  artifacts: z.record(z.string(), ArtifactRef).default({}),
  retryCount: z.number().int().min(0).default(0),
  blockedReason: z.string().optional(),
  mrUrl: z.string().optional(),

  // ---- M4-A checkpoint 字段 ----
  // 每次 stage handler 入口检查这些字段；非空即跳过对应副作用。
  // 这是 "checkpoint + idempotent recovery" 设计。
  pushedSha: z.string().optional(),         // pushBranch 成功后写
  pushedAt: z.string().optional(),
  mrIid: z.number().int().optional(),       // createOrReuseMR 成功后写
  mrCreatedAt: z.string().optional(),
  mrReused: z.boolean().optional(),        // true = list existing MR 复用
  tapdSyncedAt: z.string().optional(),     // syncTapd 成功后写
  tapdSyncAttempts: z.number().int().min(0).optional(), // 失败计数, ≥20 → failed

  createdAt: z.string(),
  updatedAt: z.string(),
})

/**
 * TaskRecord v3 (M3 加 payload/attemptCount/blocked 后).
 * payload 是 Planner markdown 解析后的结构化 task 定义；
 * attemptCount 是 SD-4 5-round fix breaker 的依据。
 */
const TaskRecord = z.object({
  id: z.string(),
  storyId: z.string(),
  title: z.string(),
  description: z.string(),
  // ---- Planner payload ----
  payload: z.object({
    taskId: z.string(),
    title: z.string(),
    files: z.array(z.string()),
    dependsOn: z.array(z.string()),
    estimatedMinutes: z.number().int().min(0).optional(),
    red: z.object({                  // RED 步: 失败的测试
      file: z.string(),
      testName: z.string(),
      assertion: z.string(),
    }).optional(),
    green: z.object({                // GREEN 步: 让 RED 过的最小修改
      file: z.string(),
      change: z.string(),
    }).optional(),
    verify: z.object({               // VERIFY 步: 跑测试
      run: z.string(),
      expectedPass: z.boolean(),
    }).optional(),
    commit: z.object({               // COMMIT 步: Conventional Commits
      type: z.string(),
      scope: z.string(),
      subject: z.string(),
    }).optional(),
    specExcerpt: z.string().optional(),
  }).optional(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed', 'blocked']),
  attemptCount: z.number().int().min(0).default(0),  // SD-4 breaker
  implementationSessionId: z.string().optional(),
  implementationResult: z.string().optional(),
  blockedReason: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export function defineAutoRdDomain(storageDomain: any) {
  return storageDomain.open({
    name: 'auto-rd',
    version: 3,                     // M4-A: 1 → 2 (M3 payload), 2 → 3 (M4-A checkpoint)
    layout: 'per-record',
    tables: {
      modules: { valueSchema: ModuleRecord },
      stories: { valueSchema: StoryRecord },
      tasks: { valueSchema: TaskRecord },
    },
  })
}
```

### 4.1.1 Schema 版本演化

| 版本 | commit | 变化 | 兼容性 |
|---|---|---|---|
| 1 | first commit | modules + stories + tasks 三表，basic fields | -- |
| 2 | `f7a49d5` (M3 schema + planner parser) | TaskRecord 加 `payload` / `attemptCount` / `blockedReason`，status 增 `'blocked'` | 旧 record 缺字段时 zod 报错（payload default 不存在所以是 required add） |
| 3 | `4b4a41d` (M4-A5) | StoryRecord 加 7 个 checkpoint 字段（`pushedSha` / `pushedAt` / `mrIid` / `mrCreatedAt` / `mrReused` / `tapdSyncedAt` / `tapdSyncAttempts`） | 全部 optional，向后兼容 |

升 version 时 zod strict mode 会拒绝旧 record；插件按**软迁移**模式处理（旧 record 用 default 填充，失败则 `recoverStories` 重置 story 到 pending）。M4-A 没硬迁——缺 checkpoint 字段对老 record 是无害的（undefined 视为"未做"，自动补做）。

### 4.1.2 Checkpoint 字段表

| 字段 | 写入者 | 读取者 | 含义 |
|---|---|---|---|
| `pushedSha` | `mr_creating` pushBranch 成功 | `mr_creating` 重入 | "已经 push 到 origin" |
| `pushedAt` | 同上 | 日志 | push 时间 |
| `mrIid` | `mr_creating` createOrReuseMR 成功 | `mr_creating` 重入 | "GitLab MR 已建/已找到" |
| `mrCreatedAt` | 同上 | 日志 | MR 创建时间 |
| `mrReused` | 同上 | 日志 / debug | true = list existing 找到旧的；false = 新建 |
| `tapdSyncedAt` | `tapd_syncing` syncTapd 成功 | `tapd_syncing` 重入 | "TAPD 已经回写" |
| `tapdSyncAttempts` | `tapd_syncing` 每次失败自增 | breaker 判断 | 网络故障计数, ≥ 20 → `failed` |

### 4.2 文件系统布局

```
workspaceRoot/
└── payment/                                    # Module Workspace
    ├── .git/                                  # Repo
    ├── src/, tests/, docs/                    # 原有代码
    └── .auto-rd/                              # auto-rd 元数据
        ├── stories/
        │   └── TAPD-123456/                   # Story 目录
        │       ├── artifacts/                 # 大 artifact 文件
        │       │   ├── 01-context.md
        │       │   ├── 02-clarification.md
        │       │   ├── 03-proposal-a.md
        │       │   ├── 03-proposal-b.md
        │       │   ├── 04-critique.md
        │       │   ├── 05-decision.md
        │       │   ├── 06-spec.md            # 最终 Spec
        │       │   ├── 07-tasks.md
        │       │   ├── 08-impl-t-1.md
        │       │   ├── 09-test-t-1.md
        │       │   ├── 10-verify-t-1.md
        │       │   └── 11-review.md
        │       ├── worktree/                  # git worktree 目录
        │       └── meta.json                  # Story 元数据
        └── pending-changes/                   # 临时修改暂存
```

### 4.3 为什么 Artifact 存文件系统

| 维度 | storageDomain | 文件系统 |
|---|---|---|
| 大小限制 | 整个 unit 加载到内存 | 无限制 |
| 查询性能 | ✅ KV lookup | ❌ 需 ls / glob |
| 全文搜索 | ❌ 需额外索引 | ✅ grep 直接用 |
| 用户可见 | ❌ 隐藏在 storages/ | ✅ 在 Module 目录下 |
| 跨 Module 共享 | ✅ | ❌ |

**结论**：metadata (State、Story 关系) 进 storageDomain，Artifact 内容进文件系统，**两边通过 path 关联**。

---

## 5. Story 状态机

### 5.1 状态列表

| State | 含义 | 触发 | 机制 | 下一步 |
|---|---|---|---|---|
| `pending` | 等待处理 | TAPD 拉取 / `recoverStories` 重置 | - | → `context` |
| `context` | Context Agent 调查中 | storyQueue tick | 1 个 agent | → `clarification` |
| `clarification` | 需求澄清中 | storyRunner | 1 个 agent | → `brainstorm` 或 `blocked` |
| `brainstorm` | 3 路 Brainstorm 并行 | storyRunner | **3 并行**：`minimal`/`clean`/`novel` variation | → `critic` |
| `critic` | Critic 评审中 | storyRunner | 1 个 agent | → `decision` |
| `decision` | 形成最终方案 | storyRunner | 1 个 agent | → `spec` |
| `spec` | 生成 Spec | storyRunner | 1 个 agent | → `planning` |
| `planning` | 拆分任务 | storyRunner | Planner + planner-parser | → `implementing`（无 task → `blocked`） |
| `implementing` | Task 实现中 | storyRunner | per-task 顺序 dispatch（按 `dependsOn` DAG） | → `testing`（全部 task 完成） |
| `testing` | Test Agent 跑测试 | storyRunner | 1 个 agent | → `fixing`（失败）或 `verifying` |
| `fixing` | Fix Agent 修代码 | storyRunner | **SD-4 5-round breaker**：SUM(attemptCount) ≥ 5 → `blocked` | → `testing` |
| `verifying` | Verification 验证 | storyRunner | 1 个 agent | → `reviewing` |
| `reviewing` | Code Review | storyRunner | **CR-1 双轴并行**：`standards` + `spec` | → `final_verifying` 或 `fixing` |
| `final_verifying` | Story 级最终验证 | storyRunner | **SD-6 双轴并行**：同上但作用于整个 branch | → `mr_creating` 或 `fixing` |
| `mr_creating` | 创建 GitLab MR | storyRunner | **checkpoint 模式**：`pushedSha` + `mrUrl` 跳过已做 | → `tapd_syncing` |
| `tapd_syncing` | 回写 TAPD | storyRunner | **checkpoint 模式** + **20 次 cap**：transient ≥ 20 → `failed` | → `completed` |
| `completed` | 成功 | (终态) | - | - |
| `failed` | 失败 | breaker trip / 20 次 sync cap | - | retry（auto）或 manual |
| `blocked` | 等待人工介入 | 任意阶段可被路由 | - | manual（`auto_rd_retry`） |

### 5.1.1 关键设计点（patterns borrowed）

| ID | 名称 | 实现位置 | 含义 |
|---|---|---|---|
| **SD-2** | Fresh subagent per task | `agent-provider.ts: ensureImplementationSpec(taskId)` | 每个 task 有独立 `ImplementationAgent` 实例，dispatch 按 taskId lookup |
| **SD-3** | No-subagents contract | `ImplementationAgent` spec tool filter | spec 不含 subagent 工具；AgentProvider 不暴露 spawn-to-handler |
| **SD-4** | 5-round fix breaker | `story-runner.ts: runFixingStage()` | SUM(`task.attemptCount`) across story ≥ 5 → `blocked` |
| **SD-5** | Two-stage review | `reviewing` + `final_verifying` 是两个 stage | review 找问题，final_verify 确认无问题 |
| **SD-6** | Whole-branch review | `final_verifying` 跑在完整 branch 上 | 不是 per-task；汇总所有 impl + verify report |
| **CR-1** | Two-axis review | `agent-provider.ts: reviewSpecByAxis` | `standards` axis + `spec` axis 双轴并行；任一 reject → `fixing` |
| **DP-1** | Parallel final-verify dispatch | `Promise.allSettled(['standards','spec'])` | 与 CR-1 同 pattern，作用于 whole-branch |
| **DP-2** | Don't merge verdicts | 双轴独立写 `12-review-*.md` / `13-final-verify-*.md` | 不合并为单一文件；orchestrator 在 routing 层看 verdict |
| **T-1~T-4** | TDD discipline | `planner-parser` + persona | RED/GREEN/VERIFY/COMMIT 步骤严格，test 不可删 |
| **V-1~V-3** | Fresh evidence | persona 强制"在本次消息内跑命令" | Verify / Review 都重新执行命令，不看旧 log |
| **F-1** | Re-run on integration tree | `FinalVerifyAgent` tool filter | 强制 fresh re-run，不复用单 task report |

### 5.2 状态转移图

```
TAPD poller ─→ pending ─→ context ─→ clarification ─→ brainstorm ─┐
                                                  ├─ B_minimal ────┤
                                                  ├─ B_clean ──────┤
                                                  └─ B_novel ──────┘
                                                                    ↓
                                                          critic → decision → spec → planning
                                                                                    │
                                                                                    ↓ planner-parser
                                                                                    ↓ (per-task DAG)
                                                                        implementing (per-task 顺序)
                                                                                    ↓
                                                                        testing ←─→ fixing (5-round breaker)
                                                                                                ↓ ≥ 5
                                                                                              blocked
                                                                                    ↓
                                                                              verifying
                                                                                    ↓
                                                                  reviewing (双轴 parallel)
                                                                                    ↓
                                                                  final_verifying (双轴 parallel)
                                                                                    ↓
                                                                mr_creating (push + createMR, checkpoint)
                                                                                    ↓
                                                                tapd_syncing (PATCH /changes, checkpoint)
                                                                                    ↓ ≥ 20 transient
                                                                                  failed
                                                                                    ↓
                                                                              completed

任意阶段 → blocked (通知用户) → manual resume via auto_rd_retry
任意阶段 → failed (3次后 / breaker trip / sync cap) → permanent failure
```

### 5.3 状态机实现

真实实现在 `packages/dsh-auto-rd/src/services/story-runner.ts`。关键代码骨架（**与 first commit draft 显著不同**）：

```typescript
const STAGE_HANDLERS: Record<StoryState, StageHandler | null> = {
  pending: async () => 'context',
  context: runContextAgent, clarification: runClarificationAgent,
  brainstorm: runBrainstormAgents, critic: runCriticAgent,
  decision: runDecisionAgent, spec: runSpecAgent,
  planning: runPlanningStage, implementing: runImplementingStage,
  testing: runTestingStage, fixing: runFixingStage,
  verifying: runVerifyingStage, reviewing: runReviewingStage,
  final_verifying: runFinalVerifyingStage,
  mr_creating: runMrCreatingStage, tapd_syncing: runTapdSyncingStage,
  completed: async (s) => s.state,
  failed: async (s) => s.state,
  blocked: async (s) => s.state,
}

export class StoryRunner {
  async runStory(storyId: string): Promise<void> {
    let story = this.deps.storage.stories().get(storyId)!
    while (!isTerminalState(story.state)) {
      const handler = STAGE_HANDLERS[story.state]!
      let next: StoryState
      try {
        next = await handler(story, this.deps)
      } catch (err) {
        story.retryCount += 1
        if (story.retryCount >= 3) {
          story.state = 'failed'
          story.blockedReason = `Stage ${prevState} failed 3 times: ${err.message}`
        }
        // 否则保持当前 state 等下一 tick 重试
      }
      if (next === story.state) break  // handler 主动保持当前 state（transient 错误）
      story.state = next
      await stories.put(story.id, story)
    }
  }
}
```

**关键不同点**：

1. **handler 返回相同 state ≠ 错误**：transient 错误下 handler 不抛——它写 checkpoint / log 然后返回**同一个** state，runner 检测 `next === story.state` 自动退出 while-loop，等下一 tick 重试（**不**进 retryCount++）
2. **handler 抛错 = config error**：config / programming 错误才抛，runner 才计 retryCount
3. **SD-4 breaker 在 handler 内**：不是 runner 计——`runFixingStage` 看 `tasks` 表 SUM(attemptCount) ≥ 5 → 返回 `blocked`
4. **CR-1 / DP-1 双轴在 handler 内**：`Promise.allSettled` 在 `runReviewingStage` / `runFinalVerifyingStage` 内实现

### 5.4 Checkpoint 模式（mr_creating / tapd_syncing）

M4-A 引入。**两个 stage handler 入口先检查 StoryRecord checkpoint 字段**：

```
runMrCreatingStage(story, deps):
  if not story.pushedSha:
    pushBranch(...)           # 可能 fail -> 重试不重做
    story.pushedSha, pushedAt = ...
  if not story.mrUrl:
    createOrReuseMR(...)      # 可能 fail -> 重试 list existing 重用
    story.mrUrl, mrIid, mrReused = ...
  return 'tapd_syncing'

runTapdSyncingStage(story, deps):
  if not story.tapdSyncedAt:
    syncTapd(...)             # 可能 fail -> 重试不重复
    story.tapdSyncedAt = now
  return 'completed'
```

效果：Plugin 重启 / network 抖动 / MR 重复创建都不会让 story 卡死。详见 §8.4 和 §10.3。

---

## 6. Agent 注册与 SubAgent Provider

### 6.1 为什么不直接调 subagents.start('spawn')

- DSH 原生 `spawn` provider 启动的是**通用 Agent**，没有 auto-rd 特定的 persona
- 每个 Stage 需要不同的 system prompt 和工具 filter
- auto-rd 自己的 SubAgent Provider **可以**：
  - 注入 auto-rd 上下文（Story 元数据、当前 Artifact）
  - 限制工具（如 Clarification Agent 不能改代码）
  - 统一管理 persona

### 6.2 Agent Provider（真实实现）

代码：`packages/dsh-auto-rd/src/services/agent-provider.ts`，类名 `AgentProvider`。

**重要**：与早期 draft 不同，**auto-rd 不注册自定义 DSH subagent provider**——它**直接调 DSH `subagents.start()`**，通过 label（agent name）做路由。DSH 的 `subagents` service 自己已经处理 persona / toolFilter / output format 的注入。

```typescript
// 真实 SubagentsService 最小接口（窄类型，src/types/dsh-services.ts 同源）
interface SubagentsService {
  start(args: {
    provider?: string
    label: string
    request: Record<string, unknown>
  }): Promise<{ childId?: string }>
}

// AgentSpec —— 所有 13 agent 实现的接口（src/agents/base.ts）
export interface AgentSpec {
  readonly name: string
  readonly persona: string
  readonly toolFilter?: { allow?: string[]; deny?: string[] }
  readonly outputFormat: 'free-form' | 'structured'
}

// AgentDispatchResult —— dispatch 的 3 路结果（不是 throw）
export type AgentDispatchResult =
  | { status: 'success'; summary?: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string }

// RegistryEntry —— AgentProvider 的内部记录
interface RegistryEntry {
  spec: AgentSpec
  handler: AgentHandler
}

export class AgentProvider {
  private readonly registry = new Map<string, RegistryEntry>()
  // Brainstorm: 3 variations, each a separate AgentSpec
  private brainstormSpecByVariation: Partial<Record<BrainstormVariation, AgentSpec>> | null = null
  private brainstormHandler: AgentHandler | null = null
  // Implementation: SD-2 fresh subagent per task
  private implementationSpecByTaskId: Map<string, AgentSpec> = new Map()
  private implementationDefaultSpec: AgentSpec | null = null
  private implementationHandler: AgentHandler | null = null
  // Review / FinalVerify: CR-1 two-axis parallel
  private reviewSpecByAxis: Partial<Record<ReviewAxis, AgentSpec>> | null = null
  private finalVerifySpecByAxis: Partial<Record<ReviewAxis, AgentSpec>> | null = null

  constructor(private readonly ctx: Context, private readonly deps: AgentProviderDeps) {
    this.subagents = (this.ctx as any).subagents as SubagentsService | null
    this.registerAll()
  }

  async dispatch(req: AgentDispatchRequest): Promise<AgentDispatchResult> {
    const entry = this.lookup(req)
    return entry.handler(req, this.deps)
  }
}
```

**关键不变式**：
- 所有 agent 走同一个 `dispatch()` 入口，差异在 registry lookup（按 name / taskId / variation / axis）
- SubAgentsService **best-effort**——拿不到时 dispatch 走 stub handler（写 artifact + emit sentinel），不抛错（见 §7.5）
- 每个 agent handler 返回 `AgentDispatchResult`，**不 throw**——runner 在 §5.3 中处理 transient 错误

### 6.3 Agent 基类

```typescript
// src/agents/base.ts
export interface AgentContext {
  storyId: string
  stage: StoryState
  inputArtifact?: Artifact
  moduleWorkspace: string
  storyBranch: string
  storyWorktree: string
}

export abstract class BaseAgent {
  abstract readonly name: string
  abstract readonly systemPrompt: string
  abstract readonly toolFilter?: string[]
  
  async run(ctx: Context, agentCtx: AgentContext): Promise<Artifact> {
    const fullPrompt = = `${this.systemPrompt}

# Current Context

- Story: ${agentCtx.storyId}
- Stage: ${agentCtx.stage}
- Module Workspace: ${agentCtx.moduleWorkspace}
- Story Branch: ${agentCtx.storyBranch}
- Worktree: ${agentCtx.storyWorktree}

# Input Artifact
${agentCtx.inputArtifact ? formatArtifact(agentCtx.inputArtifact) : 'None'}

### 6.3 Agent 基类（真实 `AgentSpec`）

实际所有 agent 都实现 `AgentSpec` interface（`src/agents/base.ts`）。**没有 class 继承**——每个 agent 是独立 const object：

```typescript
// src/agents/base.ts
export interface AgentSpec {
  readonly name: string
  readonly persona: string                  // persona markdown 文本
  readonly toolFilter?: {
    allow?: string[]
    deny?: string[]
  }
  readonly outputFormat: 'free-form' | 'structured'
}

// src/agents/context.ts (示例)
export const ContextAgent: AgentSpec = {
  name: 'context',
  persona: readFileSync(join(personasDir, 'context.md'), 'utf8'),
  toolFilter: {
    allow: ['fs_read', 'fs_search', 'fs_glob', 'bash', 'git_status', 'git_log', 'web_fetch'],
  },
  outputFormat: 'free-form',
}
```

**为什么不用 class 继承**：
- 13 个 agent 行为差异极大（不同的 sentinel / artifact / dispatch 模式），class 继承只能共享 boilerplate，对实际逻辑没帮助
- const object 直接 dispatch 给 `AgentProvider.registry` Map，零间接层
- persona 是**运行时文本资产**，不是代码——`.md` 文件独立维护

**persona 加载**：`persona-loader.ts` 提供三路查找（`lib/agents/personas/` + `src/agents/personas/` + cwd/personas/），miss 时返回空串（非 fatal）。13 个 agent 启动时一次性 cache。

### 6.4 13 个 Agent 列表（真实 tool filter 同步）

> 代码源：`packages/dsh-auto-rd/src/agents/*.ts` —— M3 commit (`2c90f2a`) 加了 `git_log` / `git_commit` 到 ImplementationAgent / FixAgent。

| Agent | 工具 Filter（allow list） | 输入 Artifact | 输出 Artifact | Persona 文件 |
|---|---|---|---|---|
| ContextAgent | `fs_read, fs_search, fs_glob, bash, git_status, git_log, web_fetch` | (Story 描述) | `01-context.md` | `agents/context.ts` |
| ClarificationAgent | `fs_read, fs_search, fs_glob, web_fetch` | context | `02-clarification.md` | `agents/clarification.ts` |
| BrainstormAgent × 3 | `fs_read, fs_search, fs_glob, web_fetch` | context + clarification | `03-proposal-{1,2,3}.md` | `agents/brainstorm.ts`（3 variation） |
| CriticAgent | `fs_read, fs_search, fs_glob` | proposals + clarification | `04-critique.md` | `agents/critic.ts` |
| DecisionAgent | `fs_read, fs_search` | proposals + critique | `05-decision.md` | `agents/decision.ts` |
| SpecAgent | `fs_read, fs_search, fs_write` | decision + clarification | `06-spec.md` | `agents/spec.ts` |
| PlannerAgent | `fs_read, fs_search, fs_write` | spec | `07-tasks.md` | `agents/planner.ts` |
| ImplementationAgent (per-task) | `fs_read, fs_search, fs_glob, fs_write, fs_edit, bash, git_status, git_diff, git_log, git_commit` | spec + tasks + 上游 task artifact | `08-impl-<taskId>.md` | `agents/implementation.ts` |
| TestAgent | `fs_read, fs_search, fs_glob, fs_write, bash, git_diff, git_log` | spec + impl reports | `09-test-report.md` | `agents/test.ts` |
| FixAgent (per-task) | `fs_read, fs_search, fs_edit, fs_write, bash, git_diff, git_log, git_commit` | test-report (failures) | `10-fix-report.md` | `agents/fix.ts` |
| VerificationAgent | `fs_read, fs_search, fs_glob, bash, git_diff, git_log, web_fetch` | spec + test report + impl reports | `11-verify-report.md` | `agents/verification.ts` |
| ReviewAgent × 2 axes | `fs_read, fs_search, git_diff, git_log, git_show` | spec + diff + all reports | `12-review-<taskId>-<axis>.md` | `agents/review.ts`（`standards` + `spec`） |
| FinalVerifyAgent × 2 axes | `fs_read, fs_search, git_diff, git_log, git_show, git_status, bash` | 所有 artifact + branch state | `13-final-verify-<axis>.md` | `agents/final-verify.ts` |

**M3 调整说明**：
- ImplementationAgent 加 `git_log` + `git_commit`：让 impl agent 可以查历史 commit（避免重复实现）+ 自己提交
- FixAgent 同样加 `git_log` + `git_commit`：fix 后必须 commit
- ContextAgent 加 `bash` + `git_status + git_log`：context 调查需读 git 历史
- VerificationAgent 加 `git_log`：对照 commit 历史确认 verify 跑过
- FinalVerifyAgent 加 `bash`：需要 fresh re-run 命令（V-1~V-3）

**关键不变式**：
- **没有 agent 有 `subagent_*` 工具**——SD-3 契约：spec 层禁止 spawn 其它子 agent
- **没有 agent 有 `web_registerFetchProvider` / `ctx.manage.subagent`**——非 M5 阶段用不到
- **写权限**只在 spec / planner / impl / test / fix 这 5 个 agent

### 6.5 Agent 设计原则（基于 DSH 真实机制）

每个 Agent 都遵守这些不变式：

1. **Persona 是一段完整的 markdown**（不是 fragment），由 `ctx.systemPrompt.section()` 注入到子 Agent 的 system prompt
2. **Tool filter 通过 `ctx.tools.restrict()` 设置**，在 SubAgent Provider 的 `start()` 中调用
3. **输出格式契约**：每个 Agent 在 persona 末尾输出一个 sentinel token（如 `[CONTEXT_COMPLETE]`、`[TEST_PASS]`），状态机据此判断成功/失败/需要重试/需要人工
4. **Artifact 落文件系统**：每个 Agent 把报告写到 `worktree/.auto-rd/stories/<story-id>/artifacts/<name>.md`
5. **不可变职责**：每个 Agent 只能做 persona 里的事，不跨职责

### 6.6 Stage-Agent 映射

| Story 状态 | 调用的 Agent | Artifact | 下一状态判定 |
|---|---|---|---|
| `context` | ContextAgent | `01-context.md` | sentinel = `[CONTEXT_COMPLETE]` → `clarification` |
| `clarification` | ClarificationAgent | `02-clarification.md` | `[CLARIFICATION_COMPLETE]` → `brainstorm`；`[CLARIFICATION_BLOCKED]` → `blocked` |
| `brainstorm` | BrainstormAgent × 3（并行，variation=minimal/clean/novel） | `03-proposal-{1,2,3}.md` | 三个都 sentinel → `critic` |
| `critic` | CriticAgent | `04-critique.md` | `[CRITIQUE_COMPLETE]` → `decision` |
| `decision` | DecisionAgent | `05-decision.md` | `[DECISION_COMPLETE]` → `spec` |
| `spec` | SpecAgent | `06-spec.md` | `[SPEC_COMPLETE]` → `planning` |
| `planning` | PlannerAgent | `07-tasks.md` | `[PLAN_COMPLETE]` → `implementing` |
| `implementing` | ImplementationAgent × N（按 Plan 顺序） | `08-impl-{task_id}.md` | 全部 `[IMPL_*_COMPLETE]` → `testing`；任一 `[IMPL_*_BLOCKED]` → `blocked` |
| `testing` | TestAgent | `09-test-report.md` | `[TEST_PASS]` → `verifying`；`[TEST_FAIL]` → `fixing` |
| `fixing` | FixAgent | `10-fix-report.md` | `[FIX_COMPLETE]` → `testing`（重测）；`[FIX_BLOCKED]` → `blocked` |
| `verifying` | VerificationAgent | `11-verify-report.md` | `[VERIFY_PASS]` → `reviewing`；`[VERIFY_PARTIAL]`/`REJECT` → `fixing` |
| `reviewing` | ReviewAgent × 2 axes | `12-review-<taskId>-<axis>.md` | `[REVIEW_<AXIS>_APPROVE]` → `final_verifying`；任一 `[REVIEW_<AXIS>_CHANGES]` → `fixing` |
| `final_verifying` | FinalVerifyAgent × 2 axes | `13-final-verify-<axis>.md` | 两轴都 `[FINAL_READY]` → `mr_creating`；任一 `[FINAL_BLOCKED]` → `blocked` |
| `mr_creating` | (orchestrator 直接调 gitlabMerger) | n/a | 成功 → `tapd_syncing` |
| `tapd_syncing` | (orchestrator 直接调 tapdPoller.syncTapd) | n/a | 成功 → `completed` |

### 6.7 Sentinel Token 权威表

> 真实实现：`packages/dsh-auto-rd/src/services/agent-provider.ts` 第 364-898 行。Runner / handler 通过正则匹配最后一行的 sentinel token 决定下一状态。
>
> **格式约定**：全部大写，`_` 分隔，前后 `[...]` 包裹。Sentinel 必须在 artifact 文件**最后一行**——runner 解析最后非空行。

| Sentinel | 发出者 | Stage | 含义 | 路由 |
|---|---|---|---|---|
| `[CONTEXT_COMPLETE]` | ContextAgent | `context` | 环境验证完成 | → `clarification` |
| `[CLARIFICATION_COMPLETE]` | ClarificationAgent | `clarification` | 零开放问题，需求明确 | → `brainstorm` |
| `[CLARIFICATION_BLOCKED]` | ClarificationAgent | `clarification` | 必须问用户 | → `blocked` |
| `[BRAINSTORM_MINIMAL_COMPLETE]` | BrainstormAgent (minimal) | `brainstorm` | minimal variation 完成 | 等另两路 |
| `[BRAINSTORM_CLEAN_COMPLETE]` | BrainstormAgent (clean) | `brainstorm` | clean variation 完成 | 等另两路 |
| `[BRAINSTORM_NOVEL_COMPLETE]` | BrainstormAgent (novel) | `brainstorm` | novel variation 完成 | 三路齐 → `critic` |
| `[CRITIQUE_COMPLETE]` | CriticAgent | `critic` | 评审完成 | → `decision` |
| `[CRITIQUE_BLOCKED]` | CriticAgent | `critic` | 系统性 gap（**罕见**——回 clarification） | → `clarification`（roll back） |
| `[DECISION_COMPLETE]` | DecisionAgent | `decision` | 决策完成 | → `spec` |
| `[SPEC_COMPLETE]` | SpecAgent | `spec` | spec 自检通过 | → `planning` |
| `[PLAN_COMPLETE]` | PlannerAgent | `planning` | tasks 列表完整（**0 个 task 时 runner 短路**） | → `implementing` |
| `[IMPL_TASK_COMPLETE]` | ImplementationAgent (per-task) | `implementing` | RED/GREEN/VERIFY/COMMIT 5 步全过 | 下一个 task；都过完 → `testing` |
| `[IMPL_TASK_BLOCKED]` | ImplementationAgent (per-task) | `implementing` | task 需要新文件 / 不可改代码 | → `blocked` |
| `[TEST_PASS]` | TestAgent | `testing` | 所有 AC ✅ 且无其它 break | → `verifying` |
| `[TEST_FAIL]` | TestAgent | `testing` | 任一 AC ❌ | → `fixing` |
| `[FIX_COMPLETE]` | FixAgent (per-task) | `fixing` | 测试变绿且无副作用 | → `testing`（**重测**） |
| `[FIX_BLOCKED]` | FixAgent (per-task) | `fixing` | 5-round breaker trip（**5 round 触发后由 runner 直接改 blocked**——fix agent 自己不 emit） | (runner 处理) |
| `[VERIFY_PASS]` | VerificationAgent | `verifying` | spec 满足 | → `reviewing` |
| `[VERIFY_PARTIAL: <note>]` | VerificationAgent | `verifying` | 部分 spec 满足 | → `fixing` |
| `[VERIFY_REJECT: <note>]` | VerificationAgent | `verifying` | spec 严重不满足 | → `fixing` |
| `[REVIEW_<AXIS>_APPROVE]` | ReviewAgent (per axis) | `reviewing` | `<axis>` 通过（`standards` / `spec`） | 两轴 APPROVE → `final_verifying` |
| `[REVIEW_<AXIS>_CHANGES: ...]` | ReviewAgent (per axis) | `reviewing` | `<axis>` 不通过（带 finding 数） | 任一 CHANGES → `fixing` |
| `[FINAL_READY]` | FinalVerifyAgent (per axis) | `final_verifying` | 全 branch 验证通过（zero Critical/Important） | 两轴 READY → `mr_creating` |
| `[FINAL_BLOCKED]` | FinalVerifyAgent (per axis) | `final_verifying` | 发现 Critical / 长期 Important | 任一 BLOCKED → `blocked` |

**Token 总数**：23 个 sentinel + 2 个轴（`<AXIS>`, `<VARIATION>`）参数化模板 = 实际 token 形态 **~30 个**。

**错误处理**：runner 解析时若**找不到任何 sentinel**：
- logging agent name + artifact path + 最后 200 字符
- throw `SentinelNotFoundError` → runner 抛（**这是真错——配置 / persona 损坏**），retryCount++
- 不 retry 超 3 次 → `failed`

**反向 contract**：persona 文档**不能**改 sentinel 字面量。改 sentinel 必须同步改：
1. `agents/personas/*.md` 文档
2. `services/agent-provider.ts` stub handler 输出的字符串
3. `services/story-runner.ts` 解析逻辑
4. `docs/architecture/auto-rd-native-plugin-design.md` §6.7（本节）

---

## 7. UI 表面

> **2026-09 修订：§7.1 的原设计与真实平台冲突，已按验证结果重写。**
>
> 原 §7.1 声称 host 进程可以 `ctx.get('slots')` 并向 `sidebar.worktable.project`
> 注册一个返回「JSON tree」的 renderer。用 Cordis Inspect 对真实运行时核验后，
> 这两点**都不成立**：
>
> - **host service catalog 里没有 `slots`**。`slots` 只存在于 client realm。
> - list slot 的注册元数据只有 `{ id, order?, label? }`，**没有 renderer 参数**；
>   slot 的 cell 是一个 **React 组件**，接收 ownerProps 与注入的 hooks。
>   对 `sidebar.panellist`（"Global panel icons. Each list id addresses the
>   matching main panel"），ownerProps 是
>   `SidebarPanelIconOwnerProps { size: number; active: boolean }`。
>   也不存在任何「JSON element tree」协议。
>
> 因此 §7.1 的 host 侧 sidebar 面板**在架构上不可能实现**，原实现里那个
> 第三个 `register()` 参数是无效的。本节保留原设计**意图**（模块/Story 可见、
> 状态徽标、MR 链接、best-effort 降级），改用平台真实机制描述。
>
> 其余小节（§7.2 notifier、§7.3 tools、§7.4 system prompt）经核验**成立**，
> 但字段名有误，已在 §7.4 更正。

### 7.1 UI 分层：host 提供数据，client 负责渲染

真实机制分两层，**两层都已实现**：

| 层 | 能力 | 本插件的落地 |
|---|---|---|
| host（Node） | 读写 storageDomain、注册 tool、注册 prompt section、注册 HTTP route | ✅ `ui-panel.ts` 纯数据投影 + `panel-route.ts` 的 `GET /auto-rd/panel` + 3 个 tool |
| client（浏览器） | 注册 slot、渲染 React cell | ✅ `src/client/client.js`：填充 `sidebar.panellist`（图标）+ `main`（面板体），轮询 host route |

**host 侧已实现且已验证的部分**（`services/ui-panel.ts`）：

1. **`buildPanelModel(storage)`** —— 纯函数数据投影：
   按 module 分组、`updatedAt` 倒序、每模块上限 `PANEL_STORY_LIMIT = 10`、
   计算 `overflow`、统计 `inFlight / blocked / completed / failed` 总数。
   不依赖 React，可单测（34 条断言，见 `scripts/test-ui-panel.mjs`）。

2. **`renderPanelText(model)`** —— 同一份数据的纯文本渲染。这是 host **能**
   产出的形态，也是 `auto_rd_status` tool 返回的内容，所以即使没有 client
   插件，这些信息仍可从对话里取得。

3. **State badge 字符**（`stateBadge()`）：
   - `\u2713` ✓ completed
   - `\u2717` ✗ failed
   - `\u26A0` ⚠ blocked
   - `\u21BB` ↻ active (implementing/testing/fixing/...)
   - `\u00B7` · pending

4. **MR 链接**：`renderPanelText()` 在 `mrUrl` 非空时输出
   `[MR](<mrUrl>)`，client 侧应渲染为 `<a href={mrUrl} target="_blank">`。

5. **best-effort 降级**：`registerAutoRdPanel()` 探测 host 是否意外出现
   `slots` service；无论结果如何都**不会**从 host 注册面板，而是记录一条
   精确的日志，说明该面板属于 client 侧贡献。插件其余功能完全不受影响。

**client 侧坐标**（供 client 贡献使用，已从 `ui-panel.ts` 导出）：

```typescript
export const CLIENT_PANEL_SLOT  = 'sidebar.panellist'   // list slot
export const CLIENT_PANEL_ID    = 'auto-rd-modules'     // 同时是 main keyed slot 的 key
export const CLIENT_PANEL_ORDER = 100
export const CLIENT_PANEL_LABEL = 'Auto-RD'
```

`sidebar.panellist` 的语义是「每个 list id 对应一个 main panel」，所以用同一个
`id` 注册即同时得到 sidebar 按钮与 main 面板。

**✅ client 半已实现（2026-09）**

文件：`packages/dsh-auto-rd/src/client/client.js`（构建时原样复制到 `lib/client.js`，
由 `copy:client` 步骤完成）。

**契约来源**：不是猜的，是读已安装的 shipped client 插件
`@deepseek-ai/dsh-client-ui-sidebar` 得到的。此前这个字段的形状无法确定，
因此当时刻意没有提交无法验证的 bundle；本轮在
`$DSH_HOME/profiles/node_modules/@deepseek-ai/` 下找到了约 40 个真实 client
包，阻塞即解除。

**验证后的真实机制**：

1. `package.json` 里声明 `dsh.client`：
   ```json
   "dsh": { "client": { "inject": [], "platform": "web" } }
   ```
   `inject` 列的是**需要先加载的 client 插件包名**。本插件只依赖 core 的
   `slots`，并用 `slots.inject()` 等 slot 声明出现，所以留空即可。

2. bundle 位于 `exports['./client']`，且**不是 ES module**，而是 shell 自己的
   模块封装：
   ```js
   window.__ModuleLoader__.load({
     id: "<package name>",
     factory: (require) => {
       var module = { exports: {} }; var exports = module.exports
       // ... require("react") 等外部依赖 ...
       exports.apply = apply      // shell 调用这个
       exports.inject = inject    // 短服务名数组
       return module.exports
     }
   })
   ```

3. **client 侧的 `inject` 用短服务名**（`["slots"]`），而且 client realm 里
   `slots` **确实是** service（`ctx.slots`）——正是 host 侧不存在、导致面板
   必须跨两个 realm 的那个 service。

4. 填充 slot 的 API：
   ```js
   ctx.slots.register({ name, id?, key?, order?, label? }, Component)
   ```
   list slot 用 `id`（`sidebar.panellist`），keyed slot 用 `key`（`main`）。
   `Component` 是 React 组件，接收 ownerProps 与注入的 hooks。

5. `ctx.slots.inject(key, cb)` 等待某个 slot 被声明后再执行 `cb`——第三方面板
   填充自己并不声明的 slot 时这是安全路径（直接 `register` 若早于声明会 throw）。

**本插件 client 半做的事**：

| 注册 | Slot | 形式 | 组件 |
|---|---|---|---|
| sidebar 入口 | `sidebar.panellist`（list） | `{ id: 'auto-rd-modules', order: 100, label: 'Auto-RD' }` | `AutoRdIcon`，读 ownerProps `{ size, active }` |
| main 面板 | `main`（keyed） | `{ key: 'auto-rd-modules' }` | `AutoRdPanel` |

两者都走 `ctx.slots.inject`，随插件 fiber 一起卸载。

**数据从哪来**：浏览器读不到 host 的 storageDomain，所以 host 侧用
`webServer` 注册了 `GET /auto-rd/panel`（见 `services/panel-route.ts`），
返回 `buildPanelModel()` 的 JSON；client 面板每 5s 轮询它，渲染 module 分组、
状态徽标与 MR 链接。拉取失败只写进组件 state 显示一行错误，组件不抛异常。

**为什么只 require `react`**：刻意不用 JSX，因此不需要 `react/jsx-runtime`，
也不需要构建步骤——文件原样复制即可，少一个可以搞错的外部依赖（测试会
在出现任何其它外部依赖时直接失败）。

**已验证**（`scripts/test-client-half.mjs`，60 条断言）：在最小 shell 沙箱里
求值 bundle——假 `window.__ModuleLoader__` 捕获声明，假 `require` 只提供
`react`。覆盖 envelope id 等于包名、`apply`/`inject` 与短名 `slots`、两个
`slots.inject` 都被排队且声明到来前不注册、sidebar 填充带 id/order/label、
main 填充带匹配的 key、图标响应 `{ size, active }`、面板真去 fetch 文档化的
URL 并把 model 落进 state、HTTP 503 变成 state 里的错误、**effect cleanup
真的停掉轮询**（首次跑这个测试把进程挂住了，就是这样发现的），以及 client 的
id/slot/order/URL 常量与 host 导出的完全一致（防止两侧漂移）。

**⏳ 仍待真实环境验收**：shell 真的加载这个 bundle、面板真的在浏览器里渲染
出来。这需要把包装进 DSH profile 并刷新页面，在当前环境做不到。除 DOM 之外
的结构与行为都已覆盖。

**注意失败模式**：`clientModules` 对畸形声明或缺失 bundle 的处理是
> "aggregates into one loud throw (**FAILED fiber**; the boot activation audit
> reports it)"

即一个错的 `dsh.client` 可能让整个 GUI 启动失败。所以这里的每条形状都对齐了
真实 bundle，而不是「看起来对」。

### 7.2 StoryNotifier（轮询模式）

代码：`packages/dsh-auto-rd/src/services/story-notifier.ts`

**真实实现不是 event-driven**——是 **5s 轮询**：

```typescript
const POLL_INTERVAL_MS = 5_000

class StoryNotifierService {
  private notifiedStories = new Set<string>()
  
  async tick(): Promise<void> {
    for (const story of storage.stories().values()) {
      if (story.state !== 'blocked') continue
      if (notifiedStories.has(story.id)) continue
      await notify(story)
      notifiedStories.add(story.id)
    }
    // 全清空时重置 Set —— story 可被重新 block
  }
}
```

**为什么不用 Cordis event**：Cordis 没提供 storage-changed event；runner 在 transition 时确实 emit 事件，但那是 runner 内部 emit，**外部 subscriber 拿不到**。轮询是最轻的解耦——runner 不必知道 notifier 存在

**消息格式**：
```
🔔 Auto-RD: Story <id> ("<title>") is blocked in state=<state>.

Reason: <blockedReason>

Use the `auto_rd_retry` or `auto_rd_trigger` tool to recover. Common actions:
`action="mark_reviewed", decision="approve"` to release the block;
`action="advance_story"` to wake the queue.
```

priority: 'background'——不打断用户当前对话

**Best-effort**：subagents service 拿不到就 warn 跳过，story 仍在 storage 里，auto_rd_status 仍能查

### 7.3 3 个 Model-Callable Tools

#### 7.3.1 `auto_rd_status`

文件：`tools/auto-rd-status.ts`，注册名：`'auto_rd_status'`

参数（zod 校验）：
```typescript
{
  scope?: 'stories' | 'tasks' | 'summary'   // default: 'summary'
  moduleId?: string                          // filter
  state?: StoryState                         // filter
  limit?: number                             // default 50, max 500
}
```

返回：
- `summary`：总故事数 + 按 state 计数 + 模块数 + 待处理 task 数
- `stories`：每条 story 的 id / title / state / moduleId / branch / updatedAt / mrUrl
- `tasks`：每条 task 的 id / storyId / status / attemptCount / blockedReason

#### 7.3.2 `auto_rd_trigger`

文件：`tools/auto-rd-trigger.ts`

参数（discriminatedUnion）：
```typescript
{ action: 'poll_now' }
| { action: 'advance_story', storyId: string }
| { action: 'mark_reviewed', storyId: string, decision: 'approve' | 'request_changes' | 'skip', note?: string }
```

返回：`{ ok: boolean, ... }`，不抛错（DSH 处理 throw 差）

`mark_reviewed` 行为：
- `approve`：state → `pending`，retryCount → 0，blockedReason 清除
- `request_changes`：append 到 blockedReason，state 不变
- `skip`：state → `failed`，record decision

#### 7.3.3 `auto_rd_retry`

文件：`tools/auto-rd-retry.ts`

参数：
```typescript
{ storyId: string, action: 'retry' | 'skip' | 'reset_to_pending', note?: string }
```

`action` 区别：
- `retry`：state → pending，retryCount = 0（vs `reset_to_pending` 不重置 retryCount）
- `skip`：terminal failed
- `reset_to_pending`：state → pending，retryCount 不变（breaker trip 后想保留计数）

### 7.4 System Prompt Section

文件：`services/system-prompt-section.ts`，`name` = `auto-rd-overview`，`order` = 50

> **字段名已更正（2026-09）**：真实 `PromptSection` 是
> ```typescript
> interface PromptSection {
>   readonly name: string                                              // 不是 id
>   readonly order: number
>   readonly text: string | ((context: AssembleContext) => string)     // 不是 content
>   readonly complete?: boolean
> }
> ```
> 早先实现传的是 `{ id, order, content }`，service 收到的是 undefined 的
> name 与 undefined 的 body —— 这段 prompt **从未真正注册成功**，模型也就
> 不会知道这三个工具的存在。`section()` 返回精确的 Cordis effect disposer；
> 重名或非有限 order 会 throw，因此调用点用 try/catch 包住并降级为一条 error 日志。

注入内容（截短）：

```
## Auto-RD Pipeline
You have access to an auto-rd plugin that drives a 19-state pipeline...
The plugin runs in the background; you can observe and control it via
three tools:
- auto_rd_status: query what stories and tasks are in flight
- auto_rd_trigger: take an out-of-band action
- auto_rd_retry: recover a blocked or failed story

When a story is in state 'blocked', the user is the human-in-the-loop
checkpoint. Use auto_rd_status to see which stories are blocked and
their blockedReason; use auto_rd_retry to recover.

Do NOT proactively call these tools unless the user has asked about
auto-rd or a story has just transitioned to blocked.
```

明确**禁止**模型主动调除非用户问 —— 避免污染正常对话

### 7.5 真实 DSH Service 接口（本地 narrow 类型）

Cordis 包**不**暴露 storageDomain / tools / systemPrompt / subagents —— 这些由 DSH 进程注入。代码用**本地 narrow 类型**（`src/types/dsh-services.ts`）+ `ctx.get('xxx') as Service | undefined`，避免 import `@deepseek-ai/dsh-*` 包。

**这些类型不是猜测**：每一个都通过 Cordis Inspect 的 host `Service` provider 从真实运行时读出并裁剪到本插件实际调用的成员。维护时应以该来源为准，而不是以调用点的假设为准。

```typescript
// src/types/dsh-services.ts（验证后的形状，节选）
export interface StorageDomainService {
  open(spec: DomainSpec): Promise<Domain>      // 异步！且同名 domain 重复 open 会 reject
}
export interface KvTable<K extends string, V> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>          // 没有 values()
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V) => V): Promise<V>
}
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: ToolOutputDefinition                 // 必填！缺了 register 会 reject
  execute(args: unknown, exec?: unknown): Promise<unknown>
}
export interface PromptSection {
  readonly name: string                        // 不是 id
  readonly order: number
  readonly text: string | ((context: unknown) => string)   // 不是 content
  readonly complete?: boolean
}
export interface SubagentsService {
  sendMessage(sender: AgentRef, targetId: string, content: ..., options?: ...): Promise<unknown>
  //           ^^^^^^^^^^^^^ Agent，不是 provider 名字符串
}
export interface SessionsService {
  list(): SessionRef[]                         // 不接受参数
}
```

**为什么不 import DSH 包**：plugin 在 standalone build（CI / 测试）下也需要编译通过。DSH 是私有部署包，import 会失败。窄类型保留 local compile；真实契约由上面的核验流程负责维护。

---

## 8. GitLab MR 集成

> 真实实现：M4-A commits (`583e121`/`da9b7dc`/`06ec568`/`5a51d76`/`4b4a41d`/`bf8ab05`)。本节不是 draft——已落地的代码。

### 8.1 模块拆分

| 模块 | 文件 | 角色 |
|---|---|---|
| `HttpClient` | `utils/http-client.ts` | timeout / retry / 429 Retry-After / 错误分类 |
| `GitLabMerger` | `services/gitlab-merger.ts` | `pushBranch` / `findExistingMR` / `createMR` / `createOrReuseMR` |
| `syncTapd` | `services/tapd-poller.ts`（导出） | POST `/changes` → 404 → PATCH `/changes` 回落 |

### 8.2 pushBranch（GitLab MR 创建流程）

代码：`services/gitlab-merger.ts: pushBranch(worktreePath, branch, gitlabConfig)`。

```typescript
export async function pushBranch(
  worktreePath: string,
  branch: string,
  config: { baseUrl: string; token: string; userName: string; userEmail: string }
): Promise<{ sha: string; pushedAt: string }> {
  // 1. 配置 git identity（per-push, 避免全局污染）
  await run('git', ['config', 'user.name', config.userName], { cwd: worktreePath })
  await run('git', ['config', 'user.email', config.userEmail], { cwd: worktreePath })

  // 2. 拿到 HEAD SHA（push 前先记）
  const localSha = (await run('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })).stdout.trim()

  // 3. push（force-with-lease 不是 force——避免覆盖别人 commit）
  await run('git', ['push', '--force-with-lease', 'origin', branch], { cwd: worktreePath })

  return { sha: localSha, pushedAt: new Date().toISOString() }
}
```

返回 `(sha, pushedAt)` 给 runner 写 checkpoint 字段（`story.pushedSha` / `story.pushedAt`）。

### 8.3 createOrReuseMR（find-or-create 模式）

```typescript
export async function createOrReuseMR(
  story: StoryRecord,
  module: ModuleRecord,
  config: { baseUrl: string; token: string }
): Promise<{ mrIid: number; mrUrl: string; reused: boolean }> {
  // 1. 找现有 MR（list MRs for this source_branch + target_branch）
  const existing = await findExistingMR(story, module, config)
  if (existing) {
    return { mrIid: existing.iid, mrUrl: existing.web_url, reused: true }
  }
  // 2. 没有就新建
  const created = await createMR(story, module, config)
  return { mrIid: created.iid, mrUrl: created.web_url, reused: false }
}
```

**`reused: true`** 让 runner 知道这是复用——log 区分 + 避免"duplicate MR"噪音。

### 8.4 projectIdFromRepoUrl

URL → GitLab project id 提取。处理3 种 URL 形态：

| URL 形态 | 提取方式 |
|---|---|
| `https://gitlab.com/group/sub/repo.git` | `encodeURIComponent('group/sub/repo')` |
| `git@gitlab.com:group/sub/repo.git` (scp-style) | 去掉 `git@` 前缀和 `:repo.git` 后缀，转 `/` |
| `https://gitlab.com/group/sub/repo`（无 `.git`） | 同上，加 `.git` 后缀 |

测试：`scripts/test-m4-fakes.mjs` 测试 4-6 覆盖3 种形态 + nested group。

### 8.5 MR 创建流程（端到端）

```typescript
// story-runner.ts: runMrCreatingStage
async runMrCreatingStage(story, deps) {
  const module = deps.storage.modules().get(story.moduleId)
  const gitlabConfig = { ...deps.config.gitlab, baseUrl: deps.config.gitlabBaseUrl }

  // 1. push（如没 push 过）
  if (!story.pushedSha) {
    const { sha, pushedAt } = await pushBranch(story.worktreePath!, story.branch, gitlabConfig)
    story.pushedSha = sha
    story.pushedAt = pushedAt
    await deps.storage.stories().put(story.id, story)
  }

  // 2. find-or-create MR
  if (!story.mrUrl) {
    const { mrIid, mrUrl, reused } = await createOrReuseMR(story, module!, gitlabConfig)
    story.mrIid = mrIid
    story.mrUrl = mrUrl
    story.mrReused = reused
    story.mrCreatedAt = new Date().toISOString()
    await deps.storage.stories().put(story.id, story)
  }

  return 'tapd_syncing'
}
```

checkpoint 模式确保 push / create MR 都不会重做（详见 §10.3 / §A.5）。

### 8.6 syncTapd（回写 TAPD）

代码：`services/tapd-poller.ts: syncTapd(story, config, deps)`。

```typescript
export async function syncTapd(
  story: StoryRecord,
  config: { baseUrl: string; token: string; workspaceIds: string[] },
  deps: { httpClient: HttpClient; logger: Logger }
): Promise<void> {
  // 1. POST /changes（新版本优于直接 PATCH /stories/:id）
  const postBody = {
    workspace_id: config.workspaceIds[0],     // primary workspace
    entity_type: 'story',
    entity_id: story.tapdId,
    changes: { status: 'done', mr_url: story.mrUrl, git_branch: story.branch },
  }
  try {
    await deps.httpClient.post(`${config.baseUrl}/v1/changes`, postBody, authHeaders(config.token))
    return
  } catch (err) {
    if (!isNotFound(err)) throw err
    // 2. 404 → PATCH 回落（/stories/:id）
    await deps.httpClient.patch(
      `${config.baseUrl}/v1/stories/${story.tapdId}`,
      postBody.changes,
      authHeaders(config.token),
    )
  }
}
```

**POST-then-PATCH 回落原因**：TAPD 新版 `/changes` endpoint 对老 workspace 不支持，POST 404 → fallback 到经典 PATCH `/stories/:id`。

### 8.7 失败 cap

`tapd_syncing` stage 内：
- 每次 transient 失败 → `story.tapdSyncAttempts += 1`
- ≥ 20 → state → `failed`（**不是** `blocked`——网络问题不该让人介入）
- 写入 `story.tapdSyncedAt` 在成功后——下次 re-enter 跳过

详见 §10.3 / §5.4。

---

## 9. TAPD 集成

### 9.1 TAPD Story 字段映射

| TAPD 字段 | auto-rd 字段 |
|---|---|
| `id` | `tapdId` |
| `name` | `title` |
| `description` | `description` |
| `acceptance_criteria` | `acceptanceCriteria` |
| `module` (自定义) | `moduleId`（由 config.modules 中匹配 `repoUrl` 反查） |
| `status === 'open'` | 拉取条件 |
| `priority` | （**当前未使用**——TAPD 字段映射到 StoryRecord 但 orchestrator 不排序） |

### 9.2 TAPD 凭证存储

cordis.yml config（**默认配置见 §2.2**）：

```yaml
config:
  tapdApiToken: '<your-token>'
  tapdWorkspaceIds: ['<workspace-id-1>', '<workspace-id-2>']
  tapdBaseUrl: 'https://api.tapd.cn'
  tapdPollIntervalMs: 60000
  useTapdMock: false   # true = 用本地 MOCK_TAPD_FIXTURE
```

**多 workspace**：config 接受 `tapdWorkspaceIds: string[]`，poller 顺序拉取每个 workspace 的 open stories。返回的 story 全部塞进 storage（去重靠 `tapdId`）。

**Mock 模式**：`useTapdMock: true` 时，poller 用 `MOCK_TAPD_FIXTURE` 而不是真 TAPD。**生产部署必须 false**。

### 9.3 MOCK_TAPD_FIXTURE

代码：`src/tapd-mock.ts`（如果存在；else 内联在 `tapd-poller.ts`）。返回与 TAPD 真实响应 envelope **结构等价**的 fixture，用于：

- 离线开发（无 TAPD 凭据）
- `npm run test:m4` / `test:m5`
- e2e smoke test（fake-server in-process）

### 9.4 TAPD 拉取的真实实现

代码：`services/tapd-poller.ts: fetchTapdStories(config)`。

```typescript
async function fetchTapdStories(config, deps): Promise<TapdStory[]> {
  const url = `${config.baseUrl}/v1/stories?workspace_id=${config.workspaceIds[0]}&status=open`
  const resp = await deps.httpClient.get(url, authHeaders(config.token))
  // 多 envelope 容错：响应可能是 {data: [...]} / {stories: [...]} / {items: [...]} / 直接 [...]
  const body = resp.json() as RawTapdListResponse | RawTapdApiStory[]
  const items = Array.isArray(body) ? body : body.data ?? body.stories ?? body.items ?? []
  return items.map(toTapdStory)
}
```

**envelope 容错**：TAPD 不同 endpoint 返回不同 envelope shape——poller 接受所有4 种形态。

**`enqueueIfNew()` 流程**（`tapd-poller.ts`）：
1. fetch story 列表
2. 对每条 story：若 `storage.stories().get(story.id)` 已存在，skip
4. 否则：构造完整 `StoryRecord`（含 `moduleId` 推断、`worktreePath` 占位），put 到 storage
5. log `enqueued tapd-${id}`

---

## 10. 跨重启恢复

### 10.1 Plugin 启动流程

```
DSH 启动
  ↓
dsh-base compose 应用
  ↓
auto-rd 真 plugin 在 cordis.yml 中配置，DSH 启动时自动 mount
  ↓
apply(ctx, config) 执行（见 §13.1 8 步）
  ↓
1. 打开 storageDomain，读所有 stories
2. recoverStories(storage, logger): 把 ACTIVE state story 重置回 pending
3. 启动 tapdPoller / storyQueue / storyNotifier 后台服务
4. 注册 UI（best-effort）
  ↓
正常调度开始
```

### 10.2 恢复实现（M1 真实版）

```typescript
// packages/dsh-auto-rd/src/services/recover.ts
const TERMINAL_STATES: ReadonlySet<StoryState> = new Set<StoryState>([
  'completed', 'failed', 'blocked', 'pending',
])

export async function recoverStories(
  storage: AutoRdStorage,
  logger: Logger,
): Promise<{ recovered: string[] }> {
  const recovered: string[] = []
  for (const story of storage.stories().values()) {
    if (TERMINAL_STATES.has(story.state)) continue

    const previous = story.state
    story.state = 'pending'
    story.updatedAt = new Date().toISOString()
    story.retryCount = 0          // 重置 breaker 计数
    await storage.stories().put(story.id, story)
    recovered.push(story.id)
    logger.warn(`[recover] story ${story.id} was ${previous} → reset to pending`)
  }
  return { recovered }
}
```

**关键决策**：**不**检查 mainSessionId 是否还活着——M1 实现选择粗暴重置。原因：
- DSH session API 版本敏感，跨 DSH 升级易坏
- 重置后 StoryQueue 重新 dispatch，runner 入口检查 checkpoint（mr_creating / tapd_syncing 已写过的副作用会跳过）——所以**部分完成的副作用不会被重做**
- 已经在文件系统里的 artifact / commit 不受影响——见 §10.3

### 10.3 Artifact 保护 + Checkpoint 模式（M4 升级）

**两层保护**：

1. **文件系统 artifact**：`worktree/.auto-rd/stories/<story-id>/artifacts/*.md` 在 plugin 重启后**永远不丢**——独立于 session，DSH 重启对它们无影响

2. **StoryRecord checkpoint 字段**（M4-A 新增，见 §4.1.2）：外部副作用（push branch / 创建 MR / sync TAPD）的"已完成"状态写到 storage 里：
   - `pushedSha` / `mrUrl` / `tapdSyncedAt` 等
   - 重新 mount 后，`mr_creating` / `tapd_syncing` stage handler 入口检查这些字段
   - **非空就跳过对应副作用**——避免 push 重复 / MR 重复创建 / TAPD 状态被覆盖

效果：
```
场景 1: push 成功 → MR create 401 → plugin 重启
  recover 把 state 重置为 pending
  runner 重跑 → context → ... → mr_creating
  mr_creating 入口：story.pushedSha 存在 → 跳过 push
  mr_creating: 创建 MR 成功 → story.mrUrl 写

场景 2: push 成功 → MR 成功 → sync TAPD 401 → plugin 重启
  recover 把 state 重置为 pending
  runner 重跑 → ... → mr_creating → tapd_syncing
  mr_creating 跳过 push + 复用已有 MR（list existing）
  tapd_syncing 入口：story.tapdSyncedAt 不存在 → 调 syncTapd
  syncTapd 成功 → story.tapdSyncedAt 写
```

**checkpoint + recover 双层组合**让"plugin 重启 + 网络瞬时故障"场景**完全不需要人工介入**。

### 10.4 未做的事（未来扩展）

- ❌ **Cold resume mainSessionId**：暂不做。DSH session API 跨版本不一致；checkpoint + 文件系统 artifact 已经覆盖绝大多数用例。`StoryRecord.mainSessionId` 字段仍在 schema 里保留，等 API 稳定后再接。
- ❌ **Stuck-session detection**：用 session list 查 `state='executing'` 时间 > N min 的孤儿 session。未实现——`recoverStories` 目前对所有 ACTIVE state 一律重置为 `pending`（见 §10.2），不做存活性判断。
- ✅ **Concurrent plugin instance 防多写**：**已实现**，但不是通过显式锁——而是
  storageDomain 自身的约束：`open()` 对同名 domain 第二次调用会以
  `already-open` reject（真实契约："reject a name that is already open
  (`already-open`)"）。因为 `AUTORD_DOMAIN_NAME` 是常量 `'auto-rd'`，
  同进程内第二个实例会在 `apply()` 阶段直接 mount 失败，而不是两个实例
  并发写同一批表。

  实现位置：`AutoRdStorage.open()` → `apply()` 为 async，让这个 rejection
  成为 mount 失败（快速且可见），而不是半初始化状态。

  另外 `apply()` 把自己的 disposer 注册进 `ctx.effect`，卸载时
  `storage.close()` 释放 domain——否则一次 reload 就会留下打开着的 domain，
  让下一次 mount 撞上 `already-open`。

  回归测试：`scripts/test-mount-smoke.mjs` 的 "double mount: the second
  apply() rejects" 与 "teardown: closed the storage domain" 两条断言。

### 10.5 Logger Rate Limit（M5）

#### 问题

`packages/dsh-auto-rd/src/utils/logger.ts` 是 plugin 内所有日志的唯一出口。当外部系统出问题时（TAPD 5xx spike / GitLab 网络中断），同一 warn / error 消息会在每个循环 tick（10s / 5s / 60s）刷屏，淹没控制台正常输出。

#### 解决方案

**Sliding-window rate limit per (level, msgPrefix) bucket**：

| 配置 | 值 | 说明 |
|---|---|---|
| Window | 60_000 ms | 1 分钟滑动窗口 |
| Max emits per bucket | 5 | 每桶最多 5 次 |
| Bucket key | `${level}:${msg.slice(0, 60)}` | 同 level + 前 60 字符合并 |
| Bucket cap | 256 | LRU 淘汰最老 bucket，防泄漏 |

**触发逻辑**：

1. 第 1-5 次 emit：正常通过
2. 第 6 次 emit：bucket tripped → 输出 **一条 summary line**（`"Logger: N further <level> messages suppressed in last 60s"`），后续 emit silently drop
3. 60s 后窗口重置

**Summary line 降一级**：
- suppressed 是 `warn` → summary 输出在 `warn`
- suppressed 是 `error` → summary 输出在 `warn`（避免隐藏 error 信息，但确保 summary 本身可见）

#### 关键设计点

- **Module-level 共享**：所有 `Logger` 实例共享 bucket registry——多个 service log 同一消息也只算一个 bucket
- **Prefix 合并**：`"TAPD 503 transient failure"` 和 `"TAPD 503 transient failure retry"` 共用同 bucket（前 60 字符相同）
- **Test hooks**：`__resetLoggerRateLimit()` + `__loggerRateLimitSnapshot()` 暴露内部状态（测试用，生产环境不调）
- **Bounded memory**：MAX_BUCKETS=256 防 unbounded bucket 增长

#### 测试

`scripts/test-m5-integration.mjs` 测试 18-24：

- test 18: 前 5 个 emit 全部通过
- test 19: 第 6 个 emit 触发 summary line
- test 20: 不同 message 独立计数
- test 21: 同 prefix（不论 suffix）合并 bucket
- test 22: error-level 也限流
- test 23: 低于 threshold 的 debug / info 不计
- test 24: snapshot 反映 bucket 内部状态

---

## 11. 并发控制

### 11.1 限流策略

每个 Module 最多同时 1 个 Story executing，全局最多 4 个 Story executing。

```typescript
function canStartStory(story: Story, executing: Story[], config: any): boolean {
  // 全局限流
  if (executing.length >= config.maxTotalConcurrentStories) return false
  
  // Module 限流
  const moduleExecuting = executing.filter(s => s.moduleId === story.moduleId)
  if (moduleExecuting.length >= config.maxConcurrentStoriesPerModule) return false
  
  return true
}
```

### 11.2 Story 排队顺序

按 `tapdId` 升序（FIFO），priority 字段未来可扩展。

---

## 12. 人工介入

> 真实实现（M4-UI 后）有 **3 个 model-callable tool**和 **5s 轮询 notifier**——不只是 §12.3 draft 的单个 tool。原 §12.2 的 `ctx.on('story-blocked')` 假设了不存在的 Cordis event，已替换为 §7.2 描述的 polling 实现。

### 12.1 Blocked 触发场景

| 场景 | Block 原因 | 路由阶段 | 用户介入方式 |
|---|---|---|---|
| Clarification Agent 发现需求必须问用户 | `clarification: user_input_required` | `clarification` | 用户补充信息 → `auto_rd_retry(retry)` |
| Implementation 任务卡死（连续 5 轮 fix 不行） | `fixing: breaker_tripped` (SD-4) | `fixing` | 用户调查后改代码 → `auto_rd_retry(retry)` 或 `auto_rd_retry(skip)` |
| Verification 发现 Spec 不满足 | `verifying: spec_mismatch` | `verifying` | 用户确认 Spec 调整 → `auto_rd_retry(retry)` |
| Planner 解析出 0 个 task | `planning: zero_tasks` | `planning` | 用户调整 Spec → `auto_rd_retry(retry)` |
| **MR create 401/403/404（非 transient）** | `mr_creating: gitlab_config_error` | `mr_creating` | 修 token / project 访问权限 → `auto_rd_retry(retry)` |
| **TAPD sync 401（非 transient）** | `tapd_syncing: tapd_config_error` | `tapd_syncing` | 修 token → `auto_rd_retry(retry)` |
| TAPD sync 20 次 transient 失败 | 实际上**不进 blocked**——进 `failed` | `tapd_syncing` | 修网络 / TAPD 状态后 → `auto_rd_retry(reset_to_pending)` |

**注意 blocked vs failed 区分**：

| 状态 | 含义 | 用户介入 |
|---|---|---|
| `blocked` | 配置 / 设计问题，需要**人为判断** | 调 `auto_rd_retry(retry/skip)` 或 `auto_rd_trigger(mark_reviewed)` |
| `failed` | **网络或环境长期不可恢复**（20 次 sync cap、runner 抛 3 次） | 修环境后 `auto_rd_retry(reset_to_pending)`（保留 retryCount 让 breaker 仍生效）或 `auto_rd_retry(retry)`（清零）|

### 12.2 通知机制（5s 轮询）

实现：`packages/dsh-auto-rd/src/services/story-notifier.ts`（详见 §7.2）

**不是** `ctx.on('story-blocked')` event——Cordis 没提供 storage-changed event。Notifier 每 5s 扫 storage，已通知的进 `Set` 去重，全清空后重置 Set。

```typescript
const POLL_INTERVAL_MS = 5_000

async tick(): Promise<void> {
  for (const story of storage.stories().values()) {
    if (story.state !== 'blocked') continue
    if (notifiedStories.has(story.id)) continue
    await notify(story)
    notifiedStories.add(story.id)
  }
}
```

**消息格式**（推到 user session）：

```
🔔 Auto-RD: Story <id> ("<title>") is blocked in state=<state>.

Reason: <blockedReason>

Use the `auto_rd_retry` or `auto_rd_trigger` tool to recover. Common actions:
`action="mark_reviewed", decision="approve"` to release the block;
`action="advance_story"` to wake the queue.
```

**Best-effort**：subagents service 拿不到就 warn 跳过。Story 仍 blocked 在 storage——auto_rd_status / sidebar 仍能看到。

### 12.3 Model-Callable Tools（3 个）

#### 12.3.1 `auto_rd_retry` —— 手动恢复 blocked/failed story

文件：`tools/auto-rd-retry.ts`

```typescript
{
  storyId: string,
  action: 'retry' | 'skip' | 'reset_to_pending',
  note?: string
}
```

| action | state 转换 | retryCount | 用途 |
|---|---|---|---|
| `retry` | `*` → `pending` | **重置为 0** | breaker trip 后想完全清零 |
| `reset_to_pending` | `*` → `pending` | **不变** | 想保留 breaker 计数（看用户 fix 是否真的进步）|
| `skip` | `*` → `failed`（终态） | 不变 | 用户决定放弃这条 story |

**不抛错**——找不到 story 返回 `{ok:false, error:'story_not_found'}`。DSH 处理 throw 差。

#### 12.3.2 `auto_rd_trigger` —— 主动触发操作（M4-U3）

文件：`tools/auto-rd-trigger.ts`

```typescript
{ action: 'poll_now' }
| { action: 'advance_story', storyId: string }
| { action: 'mark_reviewed', storyId: string, decision: 'approve' | 'request_changes' | 'skip', note?: string }
```

| action | 行为 |
|---|---|
| `poll_now` | 立即调 `tapdPoller.tick()`——不等下个 interval |
| `advance_story` | 直接调 `storyRunner.runStory(storyId)`——绕开 StoryQueue 的并发限流（人手动触发应该立即执行） |
| `mark_reviewed.approve` | state → `pending`，retryCount → 0，blockedReason 清 |
| `mark_reviewed.request_changes` | append 到 blockedReason，state 不变 |
| `mark_reviewed.skip` | state → `failed`，record decision |

#### 12.3.3 `auto_rd_status` —— 查 pipeline 状态（M4-U2）

文件：`tools/auto-rd-status.ts`

```typescript
{
  scope?: 'summary' | 'stories' | 'tasks'   // default 'summary'
  moduleId?: string
  state?: StoryState
  limit?: number                            // default 50, max 500
}
```

返回纯 JSON 数据，不抛错。模型在用户问"auto-rd 现在在干嘛"时调。

### 12.4 三 tool 的关系图

```
            ┌──────────────┐
            │ user session │
            └──────┬───────┘
                   │
       模型可调（zod 校验参数）
                   │
   ┌───────────────┼───────────────┐
   ▼               ▼               ▼
auto_rd_status  auto_rd_trigger  auto_rd_retry
   (查)            (操作)         (恢复)
   │               │               │
   ▼               ▼               ▼
storage       tapdPoller.tick  StoryRecord
              storyRunner.runStory  state/retryCount
              storage.stories.put  state/retryCount
              storage.stories.put  blockedReason
```

**3 tool 互不依赖**——任何顺序、任何组合都能调。模型可一次性查（status）→ 决定怎么操作（trigger/retry）。

### 12.5 Human-in-the-loop 协议

故事进 `blocked` 后：

1. **Notifier 5s 内推到 user session**（priority='background'）
3. **用户回复**：
   - 调 `auto_rd_status(scope='stories', state='blocked')` 看全图
   - 选 tool：
     - **配置问题**（401/403/404/breaker_tripped） → `auto_rd_retry(retry)` 修环境后清零重跑
     - **设计问题**（spec_mismatch / zero_tasks） → `auto_rd_trigger(mark_reviewed, approve)` release block 后改 Spec
     - **放弃** → `auto_rd_retry(skip)` 永久终止
4. **模型不主动调** —— system prompt 明确"Do NOT proactively call unless the user has asked"

---

## 13. 依赖关系图

### 13.1 Plugin apply 顺序

DSH 启动时按以下顺序 mount auto-rd plugin（真实实现 `src/index.ts`，M4-UI 后 6 步）：

```
1. validate config (ConfigSchema.parse)
2. construct logger
3. open storageDomain (AutoRdStorage opens domain v3)
4. seed modules from config.modules (idempotent)
5. construct services
     ├─ workspaceManager
     ├─ agentProvider
     ├─ storyRunner
     ├─ storyQueue
     ├─ tapdPoller
     └─ storyNotifier
6. recoverStories(storage, logger)         // fire-and-log
7. ctx.effect('auto-rd:timers'):           // timer block
     ├─ queue.start()
     ├─ poller.start()
     └─ notifier.start()
8. ctx.effect('auto-rd:ui'):               // UI block (best-effort)
     ├─ tools: register auto_rd_status / auto_rd_trigger / auto_rd_retry
     ├─ registerAutoRdPromptSection()
     └─ registerAutoRdPanel()
```

**为什么分两个 ctx.effect**：timer effect 必须在 storage + services 准备好之后启动；UI effect 是 best-effort（DSH service 缺就 warn），独立 effect 让 UI 注册失败不影响 backend 运行。

**inject 列表**（`src/index.ts`）：
```typescript
export const inject = [
  'storageDomain',      // AutoRdStorage
  'workspaceRegistry',  // WorkspaceManager
  'timer',              // ctx.effect
  'web',                // tapdPoller (useTapdMock=false)
  'fs', 'shell', 'subprocess',  // git / file ops
  'subagents',          // storyNotifier
  'agents',
  'sessionPersistence',
  'tools',              // 3 model-callable tools
  'slots',              // Sidebar UI
  'systemPrompt',       // system prompt section
  'sessions',           // storyNotifier.findUserSessionId
] as const
```

DSH 必须在所有 inject 都可用时才激活 plugin；缺一个 → plugin 不 mount + 报错。这是 DSH 强制的"软依赖"——我们可以容忍 inject service 在运行时偶尔不可用，但启动期必须齐。

### 13.2 依赖关系图

```
                    ┌─────────────────────────────────┐
                    │         外部系统                  │
                    └─────────────────────────────────┘
                       │ TAPD API          │ GitLab API
                       ▼                   ▼
        ┌────────────────────────────────────────────┐
        │        @yangzhitong/dsh-auto-rd 真 Plugin   │
        │                                            │
        │  ┌─────────────────────────────────┐      │
        │  │ backend:  13 service / utility  │      │
        │  │  - TapdPoller / StoryQueue /     │      │
        │  │    StoryRunner / AgentProvider / │      │
        │  │    WorkspaceManager /            │      │
        │  │    GitLabMerger / Recover /      │      │
        │  │    StoryNotifier /               │      │
        │  │    HttpClient / PlannerParser /  │      │
        │  │    PersonaLoader                 │      │
        │  └─────────────────────────────────┘      │
        │  ┌─────────────────────────────────┐      │
        │  │ UI: best-effort (DSH host only) │      │
        │  │  - SidebarPanel                 │      │
        │  │  - 3 tools (auto_rd_*)         │      │
        │  │  - SystemPromptSection          │      │
        │  └─────────────────────────────────┘      │
        └────────────────────────────────────────────┘
            │          │            │           │
            ▼          ▼            ▼           ▼
        DSH Storage  DSH Agents  DSH Tools  DSH Sidebar
        Domain       Service     Registry   Panel
            │          │            │           │
            └──────────┴────────────┴───────────┘
                       │
                       ▼
                  DSH Base Compose
                       │
                       ▼
                  Cordis Runtime
```

---

## 14. M1 实施计划

### M1 目标：跑通骨架 + TAPD 拉取 + Context Agent

**预计 2-3 天**。

### M1 任务清单

- [ ] 创建 plugin 工程（package.json, tsconfig.json, cordis.yml）
- [ ] 安装依赖（zod, 等）
- [ ] 实现 storageDomain 表结构（modules + stories 两张表）
- [ ] 实现主入口（apply + Config + inject）
- [ ] 实现 TapdPoller（基础 fetch + 解析）
- [ ] 实现 WorkspaceManager（创建 Module Workspace + git worktree）
- [ ] 实现 ContextAgent（基类 + 第一个具体 Agent）
- [ ] 实现 SubAgent Provider（注册 auto-rd provider）
- [ ] 实现 StoryQueue（基础调度循环）
- [ ] 实现 storageDomain 状态机（pending → context → completed）
- [ ] 编写 mock TAPD payload 用于测试

### M1 验证标准

1. DSH 启动后，auto-rd 真 plugin 自动加载
2. Plugin 启动后扫描 TAPD mock，识别 1 个待处理 Story
3. Story 状态从 pending → context
4. Context Agent 启动，读取 Module Workspace 代码，写 Context Artifact 到文件系统
5. Story 状态从 context → completed（验证最小闭环）
6. 在 storageDomain `~/.dsh/storages/auto-rd.json` 中看到 Story 记录

### M1 不做的事

- 不实现 Clarification/Brainstorm 等 11 个其他 Agent
- 不接真实 TAPD（用 mock）
- 不接 GitLab（不创建 MR）
- 不实现 Sidebar UI（仅 console log）

### M1 完成后

- M2: 实现 Clarification → Brainstorm → Critic → Decision → Spec → Planner
- M3: 实现 Implementation → Test → Fix → Verify → Review → Final Verify
- M4: GitLab MR 集成 + 回写 TAPD + Sidebar UI
- M5: 限流、错误恢复、人工介入、端到端测试

---

## 15. 实施落地总结（M1-M4 已完成）

> 截至 `feature/m4-ui` HEAD (`58a5945`)，M1-M4 全部落地。每个里程碑的核心 commit hash 与设计要点如下。

### 15.1 M1 — 关闭验证循环

Commit: `0dfda44` "M1: close the verification loop"

要点：
- `services/tapd-poller.ts` 的 `enqueueIfNew()` 在 enqueue 时预填 `story.worktreePath`
- `services/agent-provider.ts` 探测 `ctx.get('subagents')` —— 有真服务则走真 SubAgentProvider，缺则走 stub handler（M1 跑通 fake 路径）
- `services/recover.ts`（新建）：`recoverStories(storage, logger)` 把 ACTIVE 状态 story 重置回 `pending`（清 `retryCount: 0`），支持跨重启
- `index.ts` 在 timer 启动前调 recoverStories

### 15.2 M2 — 接通 pre-spec 7 个 stage

Commit: `a3d17bb` "M2: wire the seven pre-spec stages end to end"

要点：
- 6 个新 persona：`clarification.md` / `brainstorm.md`（从 `.md.tmpl` 重整）/ `critic.md` / `decision.md` / `spec.md` / `planner.md` —— 每个引用具体 pattern id + sentinel
- `brainstorm.ts` 重整到 `minimal` / `clean` / `novel` 三 variation（对齐 §6.6）
- `agent-provider.ts` 加 Brainstorm 三路 variation lookup + 6 stub handler + sentinel token
- `persona-loader.ts` 三路查找（lib/ + src/ + cwd fallback）+ miss 时返回空串（非 fatal）
- `package.json` `build` 链 `tsc && copy:personas`，`copy:personas` 把 `*.md` 复制到 `lib/agents/personas/`
- `story-runner.ts` 6 个 stage handler 接通；spec 之后用 `notInM2Yet` 短路到 `completed`

### 15.3 M3 — 19 state 端到端打通

Commits（5 个）：
- `ad3318d` M3 personas：implementation / test / fix / verification / review / final-verify
- `2c90f2a` M3 agents：implementation（重整）+ fix（新建）
- `f7a49d5` M3 schema + planner parser
- `9e8c3b9` M3 agent-provider：6 个 stub + per-task / per-axis dispatch
- `10d9c6f` M3 story-runner：19 state 全打通

要点：
- **Schema v3**：`TaskRecord` 加 `payload`（taskId, title, files, dependsOn, estimatedMinutes, red, green, verify, commit, specExcerpt）、`attemptCount`、`blockedReason`、`status` 增 `'blocked'`；`AUTORD_DOMAIN_VERSION` 从 1 升到 3
- **Planner markdown parser**：解析 `### TXXX` 头，分容忍自由格式、缺可选步骤、内联 `**bold**` 标记；`findKvLine` 用 `line.replace(/\*\*/g, '')` 剥所有 `**`——早期版本只剥边缘，导致 T002 `**Depends on**` 解析失败
- **5-round fix breaker（SD-4）**：`fixing` stage 用 story 所有 task 的 `attemptCount` 之和作 breaker——≥ 5 → `blocked`
- **双轴并行 review（CR-1 / SD-6）**：`reviewing` 和 `final_verifying` 都用 `Promise.allSettled` over `['standards', 'spec']`——任一 reject → `fixing`
- **Fresh subagent per task（SD-2）**：`ImplementationAgent` 按 taskId 实例化，dispatch 时按 taskId lookup
- **No-subagents contract（SD-3）**：ImplementationAgent spec 不含 subagent-tool 权限，AgentProvider 不暴露 spawn-other-subagent
- **M3 stub 行为**：每个 stage handler 调用 AgentProvider stub handler，stub 写 `08-impl-<taskId>.md` / `09-test-report.md` / `10-fix-report.md` / `11-verify-report.md` / `12-review-<taskId>-<axis>.md` / `13-final-verify-<axis>.md` + sentinel token 供状态机解析
- **MR / TAPD stub**：`mr_creating` 写 `99-mr.md`（无真 push），`tapd_syncing` 写 `98-tapd-sync.md`（无真 TAPD API）—— M4-A 接真服务

### 15.4 M4-A — GitLab MR + TAPD 真接

Commits（6 个，`feature/m4-integration` 分支，merge 到 `main` as `bf8ab05`）：
- `583e121` A1: HttpClient（timeout / retry / 错误分类 / 429 Retry-After）
- `da9b7dc` A2: TAPD poller 真接（`useTapdMock` 开关 + 多 envelope + 多 workspace）
- `06ec568` A3: syncTapd（POST `/changes` + 404→PATCH 回落）
- `5a51d76` A4: GitLabMerger（push + findExistingMR + createOrReuseMR + projectIdFromRepoUrl）
- `4b4a41d` A5: runner 接真调用（checkpoint 模式 + 重启可恢复）
- `bf8ab05` A6: ESM `.js` 后缀修复 + 22 测试

要点（M4-A 核心设计）：
- **Checkpoint + Idempotent Recovery**（M4 灵魂）：mr_creating / tapd_syncing 每个外部副作用写 checkpoint 进 StoryRecord：
  - `pushedSha` / `pushedAt`：已 push 则跳过
  - `mrIid` / `mrUrl` / `mrCreatedAt` / `mrReused`：已建 MR 则跳过（list 已有则 reused=true）
  - `tapdSyncedAt` / `tapdSyncAttempts`：已 sync 则跳过；≥ 20 次失败 → `failed`（非 `blocked`）
- **失败哲学**：transient（5xx / 超时 / 网络）→ 保持当前 state 重试；non-transient（401 / 403 / 404 项目不存在）→ `blocked`（config error）
- **HttpClient** 错误分类：`HttpError(transient)` / `HttpTimeoutError` / `HttpNetworkError`，重试策略：5xx / 408 / 429 → backoff（250ms × 2^n，上限 5s），其它 4xx 立即抛
- **TAPD fetch** 多 envelope 兼容（`{data}` / `{stories}` / `{items}` / top-level array）；`name → title`、`acceptance_criteria → acceptanceCriteria`、`module.{id,name} → category` 字段映射
- **GitLabMerger** 用 URL-encoded project id（`group%2Frepo`）—— 兼容 SaaS 与 self-hosted
- **22 个 fake-server test** 覆盖 HttpClient / TAPD / GitLab 全部路径

### 15.5 M4-UI — Sidebar UI + Tools + Notifier + System Prompt

Commits（8 个，`feature/m4-ui` 分支，HEAD `58a5945`）：
- `86bd47e` U1: DSH service 类型声明（本地 narrow types）
- `5c2412b` U2: `auto_rd_status` tool（summary / stories / tasks 三 scope）
- `8a6c129` U3: `auto_rd_trigger` tool（poll_now / advance_story / mark_reviewed）
- `33f949e` U4: `auto_rd_retry` tool（retry / skip / reset_to_pending）
- `02f5757` U5: StoryNotifier（5s 轮询 blocked stories + 推送 user session）
- `81fedac` U6: System prompt section 注册
- `4a259b1` U7: Sidebar 面板（`sidebar.worktable.project` slot，JSON tree 渲染）
- `58a5945` U8: `index.ts` 接线全部 UI

要点（M4-UI 核心设计）：
- **Best-effort 容错**：所有 DSH service 通过 `ctx.get('slots') as SlotsService | undefined` 获取——拿不到就 `warn + skip`，plugin 在 DSH 进程外也能跑
- **本地类型声明**（`src/types/dsh-services.ts`）：cordis 包不暴露 slots / tools / systemPrompt——这些是 DSH 注入的；用本地 narrow 接口声明依赖，runtime 不引用私有 DSH 包
- **Sidebar renderer 返回 JSON tree**：`{type:'div'|'span'|..., children:[...]}`——host 进程不依赖 React runtime，由 DSH client side 转译
- **Notifier 用轮询而非 Cordis event**：Cordis 没 `storage-changed` event；notifier 每 5s 扫 storage，已通知过的进 Set 避免重复
- **3 tool zod 校验**：discriminatedUnion / strict object——错参数返回 `{ok:false, error:'invalid_parameters'}` 而非 throw（DSH 处理 throw 差）
- **inject 列表扩展**：`slots` / `systemPrompt` / `sessions` 加入 inject，Cordis 在 DSH 提供全部 service 后才激活

### 15.6 后续里程碑状态

| 里程碑 | 文档定义 | 落地状态 |
|---|---|---|
| M5 限流 | §11 | 全部落地：`StoryQueue.tick()` 全局 + per-module 限流 + 3 个 StoryQueue 集成测试（`npm run test:m5`） |
| M5 错误恢复 | §10.2 + §10.5 | 全部落地：`recoverStories` mount 前调用 + 7 个 checkpoint 字段 + §10 双层保护文档 + Logger rate limit 防 log 洪水 |
| M5 人介入 | §12 | 全部落地：3 tool + StoryNotifier + system prompt section（**`test:m5` 覆盖 19 个 tool / recover 用例**） |
| M5 集成测试 | §13.3 + 附录 A.3 | 部分落地：**`test:m5` 51 pass**（recover / 3 tool / queue 限流 / status / Logger rate limit / state transitions），**e2e 仍待真凭据 + 真 DSH 进程** |

**测试矩阵总览**：

| 测试集 | 覆盖范围 | 用例数 |
|---|---|---|
| `npm run test:m4` | HttpClient / syncTapd / gitlab-merger（fake-server in-process） | 22 pass + 10 parser pass |
| `npm run test:m5` | recover / 3 tool / StoryQueue / status / Logger rate limit | 51 pass |

**M5 e2e 是唯一外部缺口**——需要：
1. TAPD 公司内网 / 公网凭据
2. GitLab 自部署 / SaaS 凭据 + 测试 project
3. 真 DSH runtime（`~/.dsh/profiles/web/cordis.patch.yml` 配置）+ 真 plugin mount
4. 跑通 story 端到端 → 验证 sidebar 渲染 / tool 调用 / notifier 推送

**凭据安全约束**：M5 e2e 真凭据**绝不**再贴文本。走：
- `process.env` + 子进程注入
- DSH secret reference（`@secret:tapd_api_token` 形式）
- `.gitignore` 排除 `~/.dsh/secrets/` 目录
- 已泄露的 chat 内 token（`81b6d71f...` / `LCxXUtsJ...`）需用户**主动 revoke**

---

文档版本：v1.5  
最后更新：Round 14 后（commit + M5 Logger rate limit + §10.5 文档 + clarification persona stale TODO 清除）  
下一步：M5 e2e（需用户主动提供凭据走安全通道）+ 探索报告归档

---

## 附录 A：关键问题与答案

### A.1 为什么不直接用 dynamic plugin？

Dynamic Plugin 在源码层明确声明**不跨 DSH 重启持久**（参考 `dsh-tool-cordis` 的 system prompt）。auto-rd 是长跑服务，不适合 dynamic plugin 形态。

### A.2 真 Plugin 安装路径

修改 `~/.dsh/profiles/web/cordis.patch.yml`，添加 auto-rd 行即可：

```bash
echo '- id: auto-rd
  name: "@yangzhitong/dsh-auto-rd"
  config: {...}' >> ~/.dsh/profiles/web/cordis.patch.yml
```

### A.3 部署 / 测试流程

1. 开发：本地 `~/.dsh/profiles/web/node_modules/@yangzhitong/dsh-auto-rd/`
2. 编译：`pnpm run build`（产物在 `lib/`）
3. 修改 cordis.patch.yml 添加 auto-rd 行
4. 重启 DSH → auto-rd 自动加载
5. 在 DSH console 中查看 `[cordis:auto-rd]` 标签的 log
6. 跑测试：`npm run test:m4`（fake-server 22 pass + parser 10 pass）

### A.4 调试

- Plugin 自己的 console.log 带 `[auto-rd]` 前缀
- storageDomain 数据：`~/.dsh/storages/auto-rd.json` + per-record `auto-rd/stories/*.json`
- 文件系统 artifact：`workspaceRoot/<module>/.auto-rd/stories/<story-id>/artifacts/*.md`
- Storage inspect：`npx dsh storage inspect auto-rd` 列出所有 record

### A.5 M4-A: Checkpoint + Idempotent Recovery 设计回顾

> M4-A 是整个 plugin 最关键的设计决策——**外部副作用必须可恢复**。

#### 问题

TAPD API + GitLab API + 网络瞬时故障是常态。Plugin 重启 / 任务中断不应该让 story 卡在 `mr_creating` 或 `tapd_syncing`。

#### 解法

1. **每个外部副作用对应 StoryRecord 一个 checkpoint 字段**（§4.1.2）：
   - `pushBranch` → `pushedSha` / `pushedAt`
   - `createOrReuseMR` → `mrIid` / `mrUrl` / `mrCreatedAt` / `mrReused`
   - `syncTapd` → `tapdSyncedAt` / `tapdSyncAttempts`

2. **Stage handler 入口先检查 checkpoint**：字段非空 → 跳过对应副作用，直接进入下一段

3. **recoverStories 粗暴重置 ACTIVE state story → pending**（§10.2）：runner 重跑时会从 checkpoint 字段恢复"已完成"上下文

4. **20 次 transient cap**：tapd_syncing 失败计数 ≥ 20 → `failed`（不是 blocked——网络问题不该让人介入）

#### 案例

```
push 成功 → MR create 401 → plugin 重启
  ↓ recoverStories
state = pending, retryCount = 0
  ↓ runner 重跑 → ... → mr_creating
push 检查：pushedSha 存在 → skip
createOrReuseMR：list existing 复用 → success
  ↓ state = tapd_syncing
tapd 检查：tapdSyncedAt 不存在 → 调 syncTapd → success
  ↓ state = completed
```

**M1-M3 没有 checkpoint 模式**——它们没有外部副作用，只在 worktree + storage 里跑。Checkpoint 是 M4 引入，专门解决"plugin 重启 + 外部副作用 + 网络故障"三角。

#### 权衡

- ❌ 旧 record 在 v3 schema 下缺 checkpoint 字段 → 跑旧 record 时**会自动补做**（unpushed code 重新 push）
- ❌ partial state 风险：push 成功但 MR 失败时，"未 MR" 状态用户可见 30s（等 next tick）
- ✅ 99% 网络瞬时故障无需人工
- ✅ idempotent recovery 不需要 Cold Resume session ID（M1 决策）

### A.6 M4-UI: Best-Effort UI 设计回顾

> Sidebar / 3 tool / system prompt 都是 M4-UI 加的——它们的共性是 **best-effort**。

#### 问题

DSH 进程注入的 service（`slots` / `tools` / `systemPrompt` / `subagents` / `sessions`）不一定可用：
- Standalone build（CI / 测试）跑在裸 Node，无 DSH host
- DSH 版本升级可能改 API 形状
- 部署时可能禁用某些 service

#### 解法

```typescript
// 每个 DSH service 调用都通过 ctx.get('xxx') 而不是 inject:['xxx']
const slots = ctx.get('slots') as SlotsService | undefined
if (!slots) {
  ctx.logger('auto-rd').warn('slots service not available; sidebar will not register')
  return false  // 不抛错
}
// ... 正常使用 slots
```

- **inject 列表只放真正必需的**（storageDomain / timer / web / fs / shell 等）—— 缺一 plugin 不能 mount
- **DSH host-only services 用 ctx.get**—— 拿不到就 warn + skip，plugin 其余功能全活

#### 应用

| Service | 用法 | 缺时行为 |
|---|---|---|
| `storageDomain` | `inject` | DSH 不挂（plugin 不 mount） |
| `timer` | `inject` | DSH 不挂 |
| `subagents` (notifier 用) | `ctx.get` | 跳过 notifier，story 仍 blocked 在 storage—— sidebar / status 仍能查 |
| `slots` (sidebar 用) | `ctx.get` | 跳过 sidebar |
| `tools` (3 model-callable) | `ctx.get` | 跳过 3 tool—— plugin 自己仍能跑 |
| `systemPrompt` (section) | `ctx.get` | 跳过 section |
| `sessions` (notifier 找 user session) | `ctx.get` | notifier 全静默 |

#### 权衡

- ✅ Plugin 在所有 DSH 形态都跑得起来（CI / dev / production / 不同 DSH 版本）
- ✅ UI surface 可逐步启用，新 DSH service 出现时不需要 plugin 改
- ❌ DSH service 实际 API 改变时**不会立即发现**——本地 narrow 类型不强制 contract（依赖 DSH runtime assertion / 测试发现）
- ✅ 突发 warn / error log 不再淹没正常 log——`Logger` (M5 §9) 5/60s 滑动窗口限流

#### 关键不变式

> **Plugin 的"核心功能"（runner / queue / poller / recovery）绝不能依赖 DSH UI service。**

UI 是 **advisor + controller**，不是 **driver**。这是 M4-UI 加完后 plugin 仍然可以"跑通骨架 + TAPD 拉取 + Context Agent"的根本原因——M1 验证标准在 M4-UI 后仍然成立。

---

文档版本：v1.1  
最后更新：Round 10（§12 + 附录 A retrospective）后 `8846b81`  
下一步：M5 e2e（需真 TAPD / GitLab 凭据 + DSH runtime）+ 探索报告归档