# PRD — Auto-RD 流水线「会话原生化」重构

- 日期:2026-09-18
- 状态:草案,待评审
- 范围:`packages/dsh-auto-rd` 的 host 端(`src/services/*`、`src/index.ts`、`src/agents/*`)+ client 端会话跳转
- 关联文档:[auto-rd-native-plugin-design.md](../architecture/auto-rd-native-plugin-design.md)

## 1. 背景与问题

当前 Auto-RD 的流水线是 **plugin 后台驱动状态机** 的形态:一个 19 状态的 `StoryRunner` 循环(`story-runner.ts`),每个阶段通过 `agent-provider.dispatch()` 去 `subagents.start()` spawn 一个**孤立**的 subagent。

这套机制存在三个结构性问题:

1. **会话树是散的**。`ensureSession`(`story-runner.ts:217`)创建 story 会话时,既没传 `parentSession` 也没传 `agentPreset`;`subagents.start` 每次 dispatch 的 agent 子会话同样没挂 parent。三层会话(用户会话 / story 会话 / agent 子会话)互不隶属,DSH 会话树里看不到"一个需求从澄清到 MR 的完整会话轨迹"。

2. **角色流程是硬编码的,不是原生会话**。13 个 agent persona(`src/agents/*`)通过 deterministic handler(`agent-provider.ts:401` 起)硬推状态,而不是让一个主会话在原生上下文里跑这套角色流程。这导致:状态机、persona、DSH 会话三者各走各的,一旦要接真实 model 的增量判断,接缝全是手工胶水。

3. **AC 语义倒置**(本 PRD 之前发现的问题)。`clarification` 把"缺验收标准"当 hard-gate(`clarify.ts:150`),`spec` 又要求"每个 AC 都有 scenario"(`spec.md` persona)——但 TAPD 拉来的只有**标题 + 描述**。验收标准本该是**流水线的产物**,却被当成了**输入门槛**。

## 2. 愿景(核心假设)

> **流水线不是 plugin 里的一段后台代码,而是 DSH 的一个会话模式(agent preset)。**

用户触发一条 TAPD 需求后:

1. 在 DSH 对应工作区下 **创建一个主会话**,标题 = TAPD 需求标题;
2. 该会话 **默认绑定一个"auto-rd 流水线"模式**(agent preset);
3. 这个模式的 system prompt 已经设计好,内嵌整套角色编排(context → clarification → brainstorm → … → verify → MR);
4. 由这个主会话 **原生执行**整条角色流程,角色之间靠会话上下文继承,产物(验收标准、规格、计划、MR)自然落在会话里。

这样"创建会话 → 选模式 → 走流程"就和 DSH 里开一个"创作模式"会话一样顺畅,而不是 plugin 在后台偷偷推状态机。

## 3. 现状调研结论(截至 2026-09-18)

### 3.1 已确认的事实

- `CreateSessionOptions.meta` 已声明 `agentPreset?: string`、`parentSession?: string`、`origin?: 'subagent'`(`dsh-services.ts:123-129`),但全仓库只有这一处声明,**没有任何代码使用它们**。
- `settings.yaml` 里存在 `agent-presets: { default: cordis }`,证明 DSH 有 agent-presets 机制,当前默认 preset 名为 `cordis`。
- 现有会话创建路径 `ensureSession`(`story-runner.ts:217`)只传了 `meta: { cwd, origin: 'subagent' }`,标题通过 `sessionTitle.rename(handle, story.title)` 事后设置。
- `systemPrompt.section()` 可用于往会话注 prompt section(`system-prompt-section.ts:37`),当前已注册一个 `auto-rd-overview`。
- client 端已有"会话可点跳转"(`sessions.open(mainSessionId)`,`client.js:1433-1445`)。

### 3.2 开放项结论(已从 DSH 源码确证,2026-09-18 更新)

四个开放项均已在 DSH checkout(`~/.npm/_npx/.../node_modules/@deepseek-ai/dsh` 下的 `dsh-agent-presets` / `dsh-session` / `dsh-subagent` / `dsh-agent`)找到源码证据,不再需要上游答复。

| # | 结论 | 证据 |
|---|---|---|
| O-1 | ✅ **能自定义注册 preset** | preset 来自两处:包内 `presets/`(shipped root)+ `<dshHome>/.agent-presets`(user root);`dsh-agent-presets` 支持「创作即复制」——复制既有 preset 目录到 user root。id 规则 `[a-z0-9][a-z0-9-]*` |
| O-2 | ✅ **prompt 来自 preset 的插件行** | preset 的 `agent.cordis.yml` 列出插件行,插件通过 `systemPrompt.section()` 注入段落;preset 决定模型看到的「工具 schema + 提示词段落 + skill」 |
| O-3 | ⚠️ **继承的是「组装」,不是「会话历史」** | `applyChildComposition` 里 `composeFrom(childCtx, parent.ctx)` 让子 agent 加入父方组装(工具+prompt sections);`SubagentStartRequest.persona`/`toolFilter` 只对该 child 生效。README 明确「子 agent 加入其父方的组装」。**对话历史的继承不是这条路径保证的** → 因此设计上改走「产物文件交接」(见架构文档 §1.3) |
| O-4 | ✅ **agentPreset 是一等字段,传了即组装** | `SessionCreateRequest { ..., agentPreset? }`、`ensureSession(sessionId, cwd, explicit, agentPreset)` 按它组装,创建 header 记录 `agentPreset`;`ctx.agentPresets.resolve()/mount()` 是常驻服务 |

> 勘误:上一版此节称「本地 profile 没装 dsh-agent/dsh-session 源码,无法确证」——**不成立**,源码就在 DSH 的 npm-cache checkout 里,四个问题均可从本地确证。

## 4. 目标(成功标准)

1. 触发一条 TAPD 需求时,DSH 工作区下出现一个标题为该需求标题的主会话。
2. 该主会话绑定一个"auto-rd 流水线"模式(preset),其 system prompt 完整描述角色流程。
3. 流水线由该主会话原生推进(而非 plugin 后台硬推状态机),每个角色的产出落在会话上下文里。
4. **验收标准由流水线生成**,不再是拉取时的输入门槛。
5. 会话跳转(`sessions.open`)能打开这个主会话,且会话树能看到 story 主会话 → agent 子会话的父子关系。
6. `npm run lint` 干净;受影响 suite(`test:ui` / `test:route` / `test:client` / `test:stage` / `test:recover`)通过。

## 5. 架构设想(待 O-1~O-4 答复后细化)

### 5.1 会话拓扑

```
DSH 工作区
 └─ 主会话(标题 = TAPD 需求标题;agentPreset = auto-rd-pipeline)
     └─ 各角色子会话(parentSession = 主会话;通过 subagents 原生继承上下文)
```

- `ensureSession` 创建主会话时传 `meta: { cwd: worktree, parentSession: <工作区会话>, agentPreset: 'auto-rd-pipeline' }`。
- agent dispatch 改走"主会话内原生推进",而非每次 spawn 干净会话。

### 5.2 角色流程(从"状态机"转向"编排 prompt")

角色顺序保持不变(context → clarification → brainstorm×3 → critic → decision → spec → planning → implementing → testing → fixing → verifying → reviewing → final_verifying → mr_creating → tapd_syncing),但:

- **编排信息**(下一步该谁、该产出什么、产物写哪个文件)从 prompt 表达,而不是 STAGE_HANDLERS 的硬编码 if/else;
- 每个角色仍是独立的 persona(`src/agents/personas/*.md` 复用),但由主会话在原生上下文里依次扮演。

### 5.3 AC 语义修正

- **删除** `clarification` 的 `missing_acceptance_criteria` hard-gate(`clarify.ts:150`)。
- 验收标准在 **spec 阶段从 title + description + 选定方案里生成**,作为 `06-spec.md` 的产出。
- `verifying` / `reviewing` 阶段对照这个**生成的** AC 做验证(而非从 TAPD 期望字段)。

## 6. 不在范围

- 不改变 TAPD 拉取逻辑(增量分页拉取已在 `feat(tapd)` 落地)。
- 不引入真实浏览器路由、不持久化分页页码。
- 不做多需求并发调度重构(沿用现有 `maxConcurrentStoriesPerModule` / `maxTotalConcurrentStories`)。

## 7. 依赖与前置

O-1~O-4 已从 DSH 源码确证(§3.2),自定义 preset **可行**,完整愿景(A 路线)成立。降级方案(§8)从「默认走」降级为「兜底」,仅在 preset 交付方式(§10.1)出现意外时启用。

落地方案见[会话原生化实现设计](./auto-rd-session-native-pipeline.md):拆 A(拓扑修复)/ B(编排迁移)/ C(AC 语义)三块,A + C 先行,B 单独里程碑。

## 8. 降级方案(兜底,非默认)

若 preset 交付方式出现意外(例如安装流程无法把 preset 复制进 `~/.dsh/.agent-presets/`):

- 保留"每 story 一个主会话",标题 + 工作区 + `parentSession` 挂靠照做;
- system prompt 继续用 `systemPrompt.section()` 注入(现有 `auto-rd-overview` 扩展为完整编排);
- 角色推进仍依赖现有 STAGE_HANDLERS,但补齐 `parentSession` 让会话树至少有父子关系;
- 验收标准的语义修正(§5.3)与 preset 无关,**独立落地**。

## 9. 开放项

- 「角色之间靠会话上下文继承」的确切机制:DSH 确证的是「组装继承」(工具+prompt sections),**对话历史继承不是这条路径**。设计上已改走「产物文件交接」规避(架构文档 §1.3),但若未来想走「continuable children」(`startContinuable` + `sendMessage`)实现子会话历史继承,仍需单独验证。当前里程碑不依赖它。
