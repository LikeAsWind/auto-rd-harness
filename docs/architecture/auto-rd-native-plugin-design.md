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
~/.dsh/profiles/web/node_modules/@your-org/dsh-auto-rd/
├── package.json                    # Node.js 包定义
├── tsconfig.json                   # TypeScript 配置
├── cordis.yml                      # Plugin compose 配置
├── README.md
├── lib/                            # 编译产物 (gitignored)
├── src/                            # TypeScript 源码
│   ├── index.ts                    # 主入口 apply(ctx, config)
│   ├── config.ts                   # Config schema (zod)
│   │
│   ├── services/                   # 核心服务
│   │   ├── tapd-poller.ts          # TAPD 拉取
│   │   ├── story-queue.ts          # Story 队列 + 调度
│   │   ├── agent-runner.ts         # Agent 执行器
│   │   ├── workspace-manager.ts    # Workspace + Worktree
│   │   ├── gitlab-merger.ts        # GitLab MR
│   │   ├── notifier.ts             # 用户通知
│   │   └── ui-panel.ts             # Sidebar UI
│   │
│   ├── agents/                     # Agent 模板
│   │   ├── base.ts                 # Agent 基类
│   │   ├── context.ts              # Context Agent
│   │   ├── clarification.ts        # Clarification Agent
│   │   ├── brainstorm.ts           # Brainstorm Agent
│   │   ├── critic.ts               # Critic Agent
│   │   ├── decision.ts             # Decision Agent
│   │   ├── spec.ts                 # Spec Agent
│   │   ├── planner.ts              # Planner Agent
│   │   ├── implementation.ts       # Implementation Agent
│   │   ├── test.ts                 # Test Agent
│   │   ├── fix.ts                  # Fix Agent
│   │   ├── verification.ts         # Verification Agent
│   │   ├── review.ts               # Code Review Agent
│   │   └── final-verify.ts         # Final Verification Agent
│   │
│   ├── domain/                     # 领域模型
│   │   ├── module.ts               # Module
│   │   ├── story.ts                # Story + StoryState
│   │   ├── task.ts                 # Task
│   │   └── artifact.ts             # Artifact
│   │
│   ├── tools/                      # Model-facing tools
│   │   ├── auto-rd-status.ts       # 查看 Story 状态
│   │   ├── auto-rd-trigger.ts      # 手动触发 Story
│   │   └── auto-rd-retry.ts        # 手动重试 blocked Story
│   │
│   └── utils/
│       ├── git.ts                  # git 命令封装
│       ├── http.ts                 # HTTP 客户端
│       └── logger.ts               # auto-rd 自己的 logger
│
└── schemas/                        # 数据 schema (zod)
    ├── story.ts
    ├── task.ts
    └── artifact.ts
```

### 2.2 package.json

```json
{
  "name": "@your-org/dsh-auto-rd",
  "version": "0.1.0",
  "description": "TAPD-driven auto research & development pipeline for DeepSeek Harness",
  "type": "module",
  "main": "lib/index.ts",
  "exports": {
    ".": "./lib/index.ts"
  },
  "scripts": {
    "build": "tsc -p .",
    "watch": "tsc -p . --watch",
    "lint": "tsc --noEmit"
  },
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
  "keywords": ["deepseek-harness", "auto-rd", "tapd", "gitlab"],
  "license": "UNLICENSED"
}
```

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
    "sourceMap": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "lib"]
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

| State | 含义 | 触发 | 下一步 |
|---|---|---|---|
| `pending` | 等待处理 | TAPD 拉取 | → `context` |
| `context` | Context Agent 调查中 | storyQueue | → `clarification` |
| `clarification` | 需求澄清中 | agentRunner | → `brainstorm` |
| `brainstorm` | 多 Brainstorm 并行 | agentRunner | → `critic` |
| `critic` | Critic 评审中 | agentRunner | → `decision` |
| `decision` | 形成最终方案 | agentRunner | → `spec` |
| `spec` | 生成 Spec | agentRunner | → `planning` |
| `planning` | 拆分任务 | agentRunner | → `implementing` |
| `implementing` | Task 实现中 | agentRunner | ↔ `testing`/`fixing` |
| `testing` | Test Agent 跑测试 | agentRunner | → `fixing` 或 `verifying` |
| `fixing` | Fix Agent 修代码 | agentRunner | → `testing` |
| `verifying` | Verification 验证 | agentRunner | → `reviewing` |
| `reviewing` | Code Review | agentRunner | → `final_verifying` |
| `final_verifying` | Story 级最终验证 | agentRunner | → `mr_creating` |
| `mr_creating` | 创建 GitLab MR | gitlabMerger | → `tapd_syncing` |
| `tapd_syncing` | 回写 TAPD | notifier | → `completed` |
| `completed` | 成功 | (终态) | - |
| `failed` | 失败 | 任意阶段 | retry 或 manual |
| `blocked` | 等待人工介入 | 任意阶段 | manual |

### 5.2 状态转移图

```
TAPD → pending → context → clarification → brainstorm ─┐
                                                      ├→ critic → decision
                              Brainstorm B ────────────┤
                              Brainstorm C ────────────┘
                                                        ↓
                                                      spec → planning
                                                        ↓
                                                   implementing ⇄ testing
                                                                    ↓
                                                                 fixing → testing
                                                                 testing → verifying
                                                                 verifying → reviewing
                                                                 reviewing → final_verifying
                                                                 final_verifying → mr_creating
                                                                 mr_creating → tapd_syncing
                                                                 tapd_syncing → completed

任意阶段 → blocked (通知用户) → manual resume
任意阶段 → failed (3次后) → permanent failure
```

### 5.3 状态机实现

```typescript
async function executeStage(
  ctx: Context, 
  story: Story, 
  config: any
): Promise<StoryState> {
  const stageHandlers: Record<StoryState, (story: Story) => Promise<StoryState>> = {
    pending: async (s) => 'context',
    context: async (s) => await runContextAgent(ctx, s, config),
    clarification: async (s) => await runClarificationAgent(ctx, s, config),
    brainstorm: async (s) => await runBrainstormAgents(ctx, s, config),
    critic: async (s) => await runCriticAgent(ctx, s, config),
    decision: async (s) => await runDecisionAgent(ctx, s, config),
    spec: async (s) => await runSpecAgent(ctx, s, config),
    planning: async (s) => await runPlannerAgent(ctx, s, config),
    implementing: async (s) => await runImplementationAgents(ctx, s, config),
    testing: async (s) => await runTestAgent(ctx, s, config),
    fixing: async (s) => await runFixAgent(ctx, s, config),
    verifying: async (s) => await runVerificationAgent(ctx, s, config),
    reviewing: async (s) => await runReviewAgent(ctx, s, config),
    final_verifying: async (s) => await runFinalVerifyAgent(ctx, s, config),
    mr_creating: async (s) => await gitlabMerger.createMR(ctx, s, config),
    tapd_syncing: async (s) => await tapdPoller.syncTapd(ctx, s, config),
    completed: async (s) => s.state,
    failed: async (s) => s.state,
    blocked: async (s) => s.state,
  }
  
  const handler = stageHandlers[story.state]
  if (!handler) {
    logger.error(`No handler for state ${story.state}`)
    return story.state
  }
  
  try {
    return await handler(story)
  } catch (e) {
    logger.error(`Stage ${story.state} failed for story ${story.id}: ${e.message}`)
    story.retryCount += 1
    if (story.retryCount >= 3) {
      story.state = 'failed'
      story.blockedReason = `Stage ${story.state} failed 3 times: ${e.message}`
    } else {
      // 重试相同状态
    }
    return story.state
  }
}
```

---

## 6. Agent 注册与 SubAgent Provider

### 6.1 为什么不直接调 subagents.start('spawn')

- DSH 原生 `spawn` provider 启动的是**通用 Agent**，没有 auto-rd 特定的 persona
- 每个 Stage 需要不同的 system prompt 和工具 filter
- auto-rd 自己的 SubAgent Provider **可以**：
  - 注入 auto-rd 上下文（Story 元数据、当前 Artifact）
  - 限制工具（如 Clarification Agent 不能改代码）
  - 统一管理 persona

### 6.2 注册一个 SubAgent Provider

```typescript
import type { SubagentProvider, ResolvedSubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'

const PROVIDER_NAME = 'auto-rd'

export function autoRdSubagentProvider(
  ctx: Context,
  config: { domain: Domain<any>, agentModel: string }
) {
  const provider: SubagentProvider = {
    name: PROVIDER_NAME,
    capabilities: {
      agentOptions: true,
      outputSchema: true,
      depthLimit: true,
      toolFilter: true,
      persona: true,
    },
    inheritsParentContext: false,
    agentRouteDefaults: {
      provider: 'anthropic',
      model: config.agentModel,
    },

    async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
      // 根据 storyId + stage 选择 Agent 模板
      const { storyId, stage } = extractContext(request)
      const agent = await createAgentForStage(ctx, storyId, stage, request)
      return runAgent(agent, request)
    },

    async prepareContinuable(request): Promise<{ seed: any[] }> {
      // 可选：返回 cold resume 时的种子消息
      return { seed: [] }
    },
  }

  ctx.subagents.registerProvider(provider)
}
```

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

# Your Task

[Agent-specific instructions]
`

    const session = await ctx.agents.create({
      model: config.agentModel,
      persona: { id: this.name, content: fullPrompt },
      toolFilter: this.toolFilter ? { allow: this.toolFilter } : undefined,
    })

    const result = await session.execute({
      prompt: [{ type: 'text', text: 'Begin your task.' }],
    })

    return parseArtifact(result, this.name)
  }
}
```

### 6.4 12 个 Agent 列表

| Agent | 工具 Filter | 输入 Artifact | 输出 Artifact | Persona 文件 |
|---|---|---|---|---|
| ContextAgent | `fs_read, fs_search, fs_glob, web_fetch` | (Story 描述) | context.md | `src/agents/context.ts` |
| ClarificationAgent | `fs_read, fs_search, fs_glob, web_fetch` | context.md | clarification.md | `src/agents/clarification.ts` |
| BrainstormAgent | `fs_read, fs_search, fs_glob, web_fetch` | context + clarification | proposal-{1,2,3}.md | `src/agents/brainstorm.ts` |
| CriticAgent | `fs_read, fs_search, fs_glob` | proposals + clarification | critique.md | `src/agents/critic.ts` |
| DecisionAgent | `fs_read, fs_search` | proposals + critique | decision.md | `src/agents/decision.ts` |
| SpecAgent | `fs_read, fs_search, fs_write` | decision + clarification | spec.md | `src/agents/spec.ts` |
| PlannerAgent | `fs_read, fs_search, fs_write` | spec.md | tasks.md | `src/agents/planner.ts` |
| ImplementationAgent | `fs_read, fs_search, fs_glob, fs_write, fs_edit, bash, git_status, git_diff` | spec + tasks + 上游 task artifact | impl-{task_id}.md | `src/agents/implementation.ts` |
| TestAgent | `fs_read, fs_search, fs_glob, fs_write, bash, git_diff, git_log` | spec + impl reports | test-report.md | `src/agents/test.ts` |
| FixAgent | `fs_read, fs_search, fs_edit, fs_write, bash, git_diff` | test-report (failures) | fix-report.md | `src/agents/fix.ts` |
| VerificationAgent | `fs_read, fs_search, fs_glob, bash, git_diff, web_fetch` | spec + test report + impl reports | verify-report.md | `src/agents/verification.ts` |
| ReviewAgent | `fs_read, fs_search, git_diff, git_log, git_show` | spec + diff + all reports | review-report.md | `src/agents/review.ts` |
| FinalVerifyAgent | `fs_read, fs_search, git_diff, git_log, git_show, git_status` | 所有 artifact + branch state | final-verify-report.md | `src/agents/final-verify.ts` |

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
| `reviewing` | ReviewAgent | `12-review-report.md` | `[REVIEW_APPROVE]` → `final_verifying`；`[REVIEW_CHANGES]` → `fixing` |
| `final_verifying` | FinalVerifyAgent | `13-final-verify-report.md` | `[FINAL_READY]` → `mr_creating`；`[FINAL_BLOCKED]` → `blocked` |
| `mr_creating` | (orchestrator 直接调 gitlabMerger) | n/a | 成功 → `tapd_syncing` |
| `tapd_syncing` | (orchestrator 直接调 tapdPoller.syncTapd) | n/a | 成功 → `completed` |

---

## 7. Event 桥接与 UI

### 7.1 Sidebar 面板 (UI Surface)

挂在 `sidebar.worktable.project` slot 上，**list 类型**：

```typescript
import type { Context } from '@deepseek-ai/cordis'
import { defineSlot } from '@deepseek-ai/dsh-client-ui-tool'  // 假设

export function autoRdSidebarPanel(
  ctx: Context,
  config: { domain: Domain<any> }
) {
  ctx.slots.register('sidebar.worktable.project', {
    id: 'auto-rd-modules',
    order: 100,
    label: () => 'Auto-RD Modules',
  }, () => {
    const modules = [...config.domain.table('modules').values()]
    const stories = [...config.domain.table('stories').values()]
    
    return React.createElement('div', { className: 'auto-rd-panel' },
      modules.map(m => 
        React.createElement(ModuleSection, { 
          module: m, 
          stories: stories.filter(s => s.moduleId === m.id) 
        })
      )
    )
  })
}
```

### 7.2 StoryNotifier 推送 blocked 通知

```typescript
export function storyNotifier(
  ctx: Context,
  config: { domain: Domain<any> }
) {
  ctx.on('story-blocked', async (story: Story, reason: string) => {
    // 找出用户当前的主 session
    const userSession = await findActiveUserSession(ctx)
    if (!userSession) return
    
    // 向用户 session 发送 prompt
    await ctx.subagents.sendMessage(
      ctx.agents.requireInitiator(),
      userSession.id,
      [{
        type: 'text',
        text: `🔔 Auto-RD: Story ${story.id} 在 "${story.state}" 阶段被 block。\n\n原因: ${reason}\n\n请使用 auto_rd_retry 工具处理。`,
      }],
      { /* options */ }
    )
  })
}
```

---

## 8. GitLab MR 集成

### 8.1 MR 创建流程

```typescript
export function gitlabMerger(
  ctx: Context,
  config: { 
    gitlabBaseUrl: string, 
    gitlabApiToken: string,
    domain: Domain<any>,
  }
) {
  ctx.gitlabMerger = {
    async createMR(story: Story): Promise<StoryState> {
      const module = config.domain.table('modules').get(story.moduleId)!
      
      // 1. Push Story Branch 到 GitLab
      await pushBranch(ctx, story.worktreePath, story.branch)
      
      // 2. 构造 MR 描述
      const description = await buildMRDescription(story, config)
      
      // 3. 调用 GitLab API 创建 MR
      const projectId = await getProjectId(ctx, module.repoUrl, config)
      const mr = await gitlabCreateMR(ctx, projectId, {
        source_branch: story.branch,
        target_branch: module.defaultBranch,
        title: `[Auto-RD] ${story.title} (TAPD-${story.tapdId})`,
        description,
      }, config)
      
      story.mrUrl = mr.web_url
      await config.domain.table('stories').put(story.id, story)
      
      return 'tapd_syncing'
    }
  }
}

async function buildMRDescription(story: Story, config: any): Promise<string> {
  // 收集所有 artifact 内容拼成 MR 描述
  const artifacts = Object.values(story.artifacts)
  // ...
}
```

### 8.2 回写 TAPD

```typescript
export async function syncTapd(
  ctx: Context, 
  story: Story, 
  config: any
): Promise<StoryState> {
  await ctx.web.fetch(`${config.tapdBaseUrl}/v1/stories/${story.tapdId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${config.tapdApiToken}` },
    body: JSON.stringify({
      status: 'completed',
      mr_url: story.mrUrl,
      git_branch: story.branch,
    }),
  })
  return 'completed'
}
```

---

## 9. TAPD 集成

### 9.1 TAPD Story 字段映射

| TAPD 字段 | auto-rd 字段 |
|---|---|
| `id` | `tapdId` |
| `name` | `title` |
| `description` | `description` |
| `acceptance_criteria` | `acceptanceCriteria` |
| `module` (自定义) | `moduleId` |
| `status === 'open'` | 拉取条件 |
| `priority` | 优先级 |

### 9.2 TAPD 凭证存储

cordis.yml config：

```yaml
config:
  tapdApiToken: '<your-token>'
```

**注意**：cordis.yml 包含敏感信息，需注意权限。生产环境应该用 DSH 的 credentials service：

```typescript
const cred = await ctx.credentials.resolve({ kind: 'tapd', account: 'default' })
```

但目前 dsh-credentials 服务未必在所有版本都暴露给真 plugin，**先用 config，验证后再切换**。

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
apply(ctx, config) 执行
  ↓
1. 打开 storageDomain，读所有 stories
2. 检查每个 executing 状态的 story 是否还活着
   - Story 还在但 child Session 已死 → 重新启动当前 stage
   - Story 主 Session 还在 → 跳过（不需要恢复）
3. 启动 tapdPoller、storyQueue 等后台服务
  ↓
正常调度开始
```

### 10.2 恢复实现

```typescript
async function recoverStories(ctx: Context, config: any) {
  const allStories = [...config.domain.table('stories').values()]
  const executing = allStories.filter(s => isExecuting(s.state))
  
  for (const story of executing) {
    const isAlive = await isStoryAlive(ctx, story)
    if (!isAlive) {
      logger.warn(`Story ${story.id} state=${story.state} but child session dead, restarting`)
      // 从当前 state 重新开始，不需要从头回
      ctx.agentRunner.runStory(story).catch(...)
    } else {
      logger.info(`Story ${story.id} state=${story.state} still running, no recovery needed`)
    }
  }
}

async function isStoryAlive(ctx: Context, story: Story): Promise<boolean> {
  if (!story.mainSessionId) return false
  // 检查 session 是否还在 sessions 列表中
  const session = ctx.sessions.get(story.mainSessionId)
  return session !== undefined
}
```

### 10.3 Artifact 保护

**关键**：因为 Artifact 进文件系统 + 子 Session 是独立的 JSONL log，**Plugin 重启后所有历史都不会丢失**。Agent 可以从 Artifact 文件读取之前阶段的结果。

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

### 12.1 Blocked 触发场景

| 场景 | Block 原因 | 用户介入方式 |
|---|---|---|
| Clarification Agent 发现需求必须问用户 | `clarification: user_input_required` | 用户补充信息 + `auto_rd_retry` |
| Implementation Agent 遇到无法解决的冲突 | `implementation: merge_conflict` | 用户手动 merge + `auto_rd_retry` |
| Verification 发现 Spec 不满足 | `verification: spec_mismatch` | 用户确认 Spec 调整 + `auto_rd_retry` |
| Test 连续失败 3 次 | `test: persistent_failure` | 用户调查后调整代码 + `auto_rd_retry` |

### 12.2 通知机制

```typescript
ctx.on('story-blocked', async (story, reason) => {
  // 1. 写到 UI 面板（Sidebar）
  // 2. 推到用户主 session
  // 3. 写入 blocked Story 详情
})
```

### 12.3 auto_rd_retry 工具

```typescript
ctx.tools.register({
  name: 'auto_rd_retry',
  description: 'Manually retry or skip a blocked/failed story',
  parameters: {
    storyId: { type: 'string', required: true },
    action: { 
      type: 'enum', 
      enum: ['retry', 'skip', 'reset_to_pending'],
      required: true 
    },
    note: { type: 'string', required: false },
  },
  async execute(args, exec) {
    const story = config.domain.table('stories').get(args.storyId)
    if (!story) throw new Error(`Story ${args.storyId} not found`)
    
    if (args.action === 'retry') {
      story.state = 'pending'  // 重新调度
      story.retryCount = 0
    } else if (args.action === 'skip') {
      story.state = 'failed'
      story.blockedReason = `Skipped by user: ${args.note ?? ''}`
    } else if (args.action === 'reset_to_pending') {
      story.state = 'pending'
    }
    
    story.updatedAt = new Date().toISOString()
    await config.domain.table('stories').put(story.id, story)
    return { ok: true, story }
  },
})
```

---

## 13. 依赖关系图

```
                    ┌─────────────────────────────────┐
                    │         外部系统                  │
                    └─────────────────────────────────┘
                       │ TAPD API          │ GitLab API
                       ▼                   ▼
        ┌────────────────────────────────────────────┐
        │        @your-org/dsh-auto-rd 真 Plugin       │
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
| M5 限流 | §11 | 部分落地：`StoryQueue.tick()` 已实现全局 + per-module 限流（§11.1 匹配） |
| M5 错误恢复 | §10.2 | 部分落地：`recoverStories` 在 mount 前调用；**缺 checkpoint 模式文档**（M4-A 已实现但 §10.2 没补） |
| M5 人介入 | §12 | 全部落地：3 tool + StoryNotifier + system prompt section |
| M5 端到端测试 | §13.3 + 附录 A.3 | **未落地**：仅 M4-A 的 22 个 fake-server 单元测试，**无真凭据 / 真 DSH 进程的 e2e** |

**M5 e2e 是当前最大缺口**——需要：
1. TAPD 公司内网 / 公网凭据
2. GitLab 自部署 / SaaS 凭据 + 测试 project
3. 真 DSH runtime（`~/.dsh/profiles/web/cordis.patch.yml` 配置）+ 真 plugin mount
4. 跑通 story 端到端 → 验证 sidebar 渲染 / tool 调用 / notifier 推送

---

文档版本：v0.2  
最后更新：M4-UI 完成后（commit `58a5945` + gap-analysis `0992eba`）  
下一步：M5 e2e + 文档与代码同步（见 `gap-analysis.md`）

---

## 附录 A：关键问题与答案

### A.1 为什么不直接用 dynamic plugin？

Dynamic Plugin 在源码层明确声明**不跨 DSH 重启持久**（参考 `dsh-tool-cordis` 的 system prompt）。auto-rd 是长跑服务，不适合 dynamic plugin 形态。

### A.2 真 Plugin 安装路径

修改 `~/.dsh/profiles/web/cordis.patch.yml`，添加 auto-rd 行即可：

```bash
echo '- id: auto-rd
  name: "@your-org/dsh-auto-rd"
  config: {...}' >> ~/.dsh/profiles/web/cordis.patch.yml
```

### A.3 部署 / 测试流程

1. 开发：本地 `~/.dsh/profiles/web/node_modules/@your-org/dsh-auto-rd/`
2. 编译：`pnpm run build`（产物在 `lib/`）
3. 修改 cordis.patch.yml 添加 auto-rd 行
4. 重启 DSH → auto-rd 自动加载
5. 在 DSH console 中查看 `[cordis:auto-rd]` 标签的 log

### A.4 调试

- Plugin 自己的 console.log 带 `[auto-rd]` 前缀
- storageDomain 数据：`~/.dsh/storages/auto-rd.json` + per-record `auto-rd/stories/*.json`
- 文件系统 artifact：`workspaceRoot/<module>/.auto-rd/stories/<story-id>/artifacts/*.md`

---

文档版本：v0.1  
最后更新：架构重设计阶段  
下一步：实施 M1 骨架