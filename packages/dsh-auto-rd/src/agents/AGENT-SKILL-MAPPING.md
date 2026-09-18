# Agent ↔ Reference Pattern Mapping (Decomposed)

> 每个参考 skill 拆成**独立的 pattern**（借鉴单元）。
> 每个 Agent 只借鉴它需要的**具体 pattern**，不是整个 skill。
> 这消除了"一个 skill 被多个 Agent 重复对标"的歧义。

## 参考 Pattern 清单（按 skill 来源分组）

### From obra/brainstorming

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **B-1: Three Paths 分类** | spike / bounded / architectural 分类法 | "When in doubt, take the heavier" |
| **B-2: One Question At A Time** | 一次只问一个问题，never stack | "Only one question per message" |
| **B-3: Multiple-Choice 优先** | 优先用多选题，少用开放式 | "Prefer multiple choice questions" |
| **B-4: HARD-GATE** | 实现前必须获批（spike/bounded/architectural 三种都需） | "the approval gate never does" |
| **B-5: Propose 2-3 Approaches** | 设计阶段提 2-3 个方案 + 权衡 | "Propose 2-3 different approaches with trade-offs" |
| **B-6: Lead With Recommended** | 推荐方案放第一个 + 解释为什么 | "Lead with your recommended option" |
| **B-7: YAGNI Ruthlessly** | 每个方案都砍掉不必要的功能 | "YAGNI ruthlessly" |
| **B-8: Spec Self-Review** | 写完 spec 后做 5 项 self-review | "look at it with fresh eyes" |

### From obra/using-git-worktrees

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **W-1: Step 0 Detect Isolation** | 检测是否已在 worktree | "Before creating anything, check if you are already in an isolated workspace" |
| **W-2: Native Tools First** | 优先用平台原生 worktree 工具 | "Prefer your platform's native worktree tools" |
| **W-3: Verify Clean Baseline** | setup 后跑一遍测试确认基线干净 | "Run tests to ensure workspace starts clean" |

### From obra/writing-plans

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **PL-1: File Structure First** | 拆任务前先映射文件结构 | "Before defining tasks, map out which files will be created or modified" |
| **PL-2: Task Right-Sizing** | 任务是"独立 test cycle + 独立 reviewer gate" | "smallest unit that carries its own test cycle and is worth a fresh reviewer's gate" |
| **PL-3: Bite-Sized Steps (2-5 min)** | 每个 step 是 2-5 分钟的单动作 | "Each step is one action (2-5 minutes)" |
| **PL-4: TDD Step Template** | RED → verify fail → minimal → verify pass → commit | "Write the failing test → Run it to make sure it fails → ..." |
| **PL-5: No Placeholders** | 禁止 "TBD / TODO / similar to / appropriate" | "These are plan failures — never write them" |
| **PL-6: Plan Self-Review** | 写完后做 spec coverage / placeholder / type consistency 检查 | "After writing the complete plan, look at the spec with fresh eyes" |
| **PL-7: Execution Handoff** | 完成后提供 Subagent-Driven vs Inline 二选一 | "Subagent-Driven (recommended) - I dispatch a fresh subagent per task" |

### From obra/subagent-driven-development

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **SD-1: Rulings, Not Stalls** | 自动决策并记录在 ledger，不阻塞等用户 | "A running plan does not wait on a human" |
| **SD-2: Fresh Subagent Per Task** | 每个 task 用全新 subagent（无上下文污染） | "Fresh subagent per task + task review + broad final review" |
| **SD-3: No-Subagents Contract** | Implementer 不 dispatch subagent | "the implementer never dispatches subagents" |
| **SD-4: 5-Round Fix Loop + Breaker** | 最多 5 轮 fix，第 5 轮后 adjudicate | "Five rounds maximum per task" / "breaker trips" |
| **SD-5: Two-Stage Review** | 每个 task 后做 spec compliance + code quality 两阶段 review | "task review (spec compliance + code quality)" |
| **SD-6: Final Review = Broad Whole-Branch Review** | 所有 task 完成后做 whole-branch review | "broad whole-branch review at the end" |
| **SD-7: Ledger Cross-Compaction** | 进度写 ledger 文件（跨 compaction 持久化） | "Track progress in a ledger file, not only in todos" |
| **SD-8: Hand Artifacts As Files** | 把 diff/report 写成文件递给 subagent，不贴上下文 | "Hand artifacts over as files" |

### From obra/test-driven-development

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **T-1: Iron Law (No Code Without Failing Test)** | 没有 failing test 不写 production code | "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST" |
| **T-2: Verify RED Before GREEN** | 写实现前先确认 test 因 feature missing 而 fail | "Confirm: Test fails (not errors), Failure message is expected" |
| **T-3: Verify GREEN Pristine** | 确认 pass + 其他 tests 仍 pass + output 无 error/warning | "Output pristine (no errors, warnings)" |
| **T-4: Code Before Test? Delete It** | 不删除等于在作弊 | "Code before test? Delete it. Start over." |
| **T-5: Never Fix Bug Without Test** | 修 bug 前必须有 reproducing test | "Never fix bugs without a test" |

### From obra/systematic-debugging

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **D-1: Iron Law (No Fix Without Root Cause)** | 不调查 root cause 不修 | "NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST" |
| **D-2: Four Phases** | Root Cause → Pattern → Hypothesis → Implementation | "You MUST complete each phase before proceeding" |
| **D-3: 3-Fix Architectural Question** | 3 次失败后质疑架构 | "If ≥ 3: STOP and question the architecture" |
| **D-4: Multi-Component Boundary Check** | 多组件系统在每个边界加 instrumentation | "For EACH component boundary: Log what data enters/exits" |

### From obra/verification-before-completion

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **V-1: Iron Law (Fresh Evidence)** | 没在当前 message 跑验证，不能 claim pass | "NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE" |
| **V-2: Gate Function (5 Steps)** | IDENTIFY → RUN → READ → VERIFY → CLAIM | "BEFORE claiming any status" |
| **V-3: Common Failures Table** | tests pass / bug fixed / agent completed 都需 fresh evidence | "Claim / Requires / Not Sufficient" |

### From obra/finishing-a-development-branch

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **F-1: Step 1 Verify Tests (Re-Run on Integration Tree)** | 完工前 re-run on the tree about to be integrated | "Run the project's full test suite ... A green run only proves the tree it ran on" |
| **F-2: Detect Environment** | GIT_DIR vs GIT_COMMON 决定 menu | "This determines which menu to show" |
| **F-3: Three Options Menu** | merge locally / push PR / keep as-is | "present exactly these 3 options" |
| **F-4: Cleanup Workspace** | merge 后清理 worktree（不能 force） | "Never --force on your own initiative" |

### From obra/requesting-code-review

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **RC-1: Diff Range (BASE..HEAD)** | 每次 review 用具体 SHA range | "BASE_SHA=$(git rev-parse HEAD~1) ... HEAD_SHA=$(git rev-parse HEAD)" |
| **RC-2: Severity Scale (Critical/Important/Minor)** | 严重度 3 级 | "Critical / Important / Minor" |
| **RC-3: ⚠️ Cannot Verify From Diff** | 标记需要跨 task / unchanged code 才能验证的 finding | "⚠️ Cannot verify from diff" |
| **RC-4: Reviewer Can Be Wrong** | reviewer 错了要 push back（带 reasoning） | "Push back if reviewer is wrong (with reasoning)" |
| **RC-5: Never Skip Review for Simple** | 简单的代码也要 review | "Never skip review because 'it's simple'" |

### From obra/dispatching-parallel-agents

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **DP-1: One Agent Per Independent Domain** | 独立失败用独立 agent | "Dispatch one agent per independent problem domain" |
| **DP-2: Parallel Dispatch in One Response** | 一次 response 多 dispatch = 并行 | "Multiple dispatch calls in one response = parallel execution" |

### From mattpocock/code-review

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **CR-1: Two-Axis Review Pattern** | Standards + Spec 两轴，**两个并行 subagent** | "Both axes run as parallel sub-agents" |
| **CR-2: Standards Axis = Repo + Fowler Baseline** | Standards 轴用 repo 标准 + Fowler 12 smell | "On top of whatever the repo documents, the Standards axis always carries the smell baseline" |
| **CR-3: Spec Axis = Line-by-Line Check** | Spec 轴用 spec 行级引用 + missing/extra/wrong | "Quote the spec line for each finding" |
| **CR-4: Don't Merge or Rerank** | 两轴 findings 不合并 | "Do not merge or rerank findings" |
| **CR-5: Fowler 12 Smell Baseline** | 12 个 code smell 完整清单 | "Mysterious Name / Duplicated Code / Feature Envy / ..." |

### From mattpocock/grilling

| Pattern ID | 内容 | 独立的标志 |
|---|---|---|
| **G-1: Grill Relentlessly Until Every Branch Resolved** | 反复追问直到设计树每个分支都解决 | "Interview the user relentlessly ... until every branch of the design tree is resolved" |
| **G-2: One Question Per Topic** | 一次一个 topic（与 B-2 类似但属不同 skill） | "one at a time" |

---

## Agent ↔ Pattern Mapping（唯一，无重复）

| Agent | 借鉴的 Patterns（带 ID） | Pattern 总数 |
|---|---|---|
| **ContextAgent** | W-1（Step 0 Detect） / W-2（Native Tools First） / W-3（Verify Clean Baseline） | 3 |
| **ClarificationAgent** | B-1（Three Paths） / B-2（One Question） / B-3（Multiple-Choice） / G-1（Grill Relentlessly） | 4 |
| **ResolutionAgent** | SD-1（Rulings, Not Stalls） / SD-7（Ledger Cross-Compaction） / SD-8（Hand Artifacts As Files） | 3 |
| **BrainstormAgent** | B-5（Propose 2-3） / B-6（Lead With Recommended） / B-7（YAGNI Ruthlessly） | 3 |
| **CriticAgent** | CR-3（Spec Line-by-Line） / RC-2（Severity Scale） / RC-4（Reviewer Can Be Wrong） | 3 |
| **DecisionAgent** | SD-1（Rulings, Not Stalls） / SD-7（Ledger Cross-Compaction） / PL-7（Execution Handoff） / RC-4（Reviewer Can Be Wrong） | 4 |
| **SpecAgent** | B-8（Spec Self-Review） / PL-5（No Placeholders） | 2 |
| **PlannerAgent** | PL-1（File Structure） / PL-2（Task Right-Sizing） / PL-3（Bite-Sized Steps） / PL-4（TDD Step Template） / PL-5（No Placeholders） / PL-6（Plan Self-Review） | 6 |
| **ImplementationAgent** | T-1（Iron Law No Code Without Test） / T-4（Code Before Test? Delete It） / SD-2（Fresh Subagent Per Task） / SD-3（No-Subagents Contract） / SD-8（Hand Artifacts As Files） | 5 |
| **TestAgent** | T-2（Verify RED Before GREEN） / T-3（Verify GREEN Pristine） / T-4（Code Before Test? Delete It） / V-1（Fresh Evidence） / V-2（Gate Function） / V-3（Common Failures Table） | 6 |
| **FixAgent** | D-1（Iron Law No Fix Without Root Cause） / D-2（Four Phases） / D-3（3-Fix Architectural Question） / D-4（Multi-Component Boundary Check） / T-4（Code Before Test? Delete It） / T-5（Never Fix Bug Without Test） / SD-4（5-Round Fix Loop + Breaker） | 7 |
| **VerificationAgent** | V-1（Fresh Evidence） / V-2（Gate Function） / V-3（Common Failures） / F-1（Re-Run on Integration Tree） | 4 |
| **ReviewAgent** | CR-1（Two-Axis Review） / CR-2（Standards = Repo + Fowler） / CR-3（Spec Line-by-Line） / CR-4（Don't Merge or Rerank） / CR-5（Fowler 12 Smell） / RC-1（Diff Range） / RC-2（Severity Scale） / RC-3（⚠️ Cannot Verify） / RC-4（Reviewer Can Be Wrong） / SD-5（Two-Stage Review） | 10 |
| **FinalVerifyAgent** | CR-1（Two-Axis Review） / CR-2（Standards = Repo + Fowler） / CR-3（Spec Line-by-Line） / CR-4（Don't Merge or Rerank） / CR-5（Fowler 12 Smell） / DP-1（One Agent Per Domain） / DP-2（Parallel Dispatch in One Response） / F-1（Re-Run on Integration Tree） / V-1（Fresh Evidence） / SD-6（Final Review = Whole-Branch） / SD-7（Ledger Cross-Compaction） | 11 |

## 关键发现：哪些 Pattern 被多个 Agent 共享

这样拆开后，可以清楚看到 **Pattern 复用图**：

| Pattern ID | 被几个 Agent 用 | 在哪些 Agent |
|---|---|---|
| **V-1: Fresh Evidence** | 3 | TestAgent, VerificationAgent, FinalVerifyAgent |
| **V-2: Gate Function** | 2 | TestAgent, VerificationAgent |
| **V-3: Common Failures Table** | 1 | TestAgent |
| **CR-1: Two-Axis Review** | 2 | ReviewAgent, FinalVerifyAgent |
| **CR-2: Standards Axis** | 2 | ReviewAgent, FinalVerifyAgent |
| **CR-3: Spec Line-by-Line** | 3 | CriticAgent, ReviewAgent, FinalVerifyAgent |
| **CR-4: Don't Merge/Rerank** | 2 | ReviewAgent, FinalVerifyAgent |
| **CR-5: Fowler 12** | 2 | ReviewAgent, FinalVerifyAgent |
| **RC-2: Severity Scale** | 2 | CriticAgent, ReviewAgent |
| **RC-4: Reviewer Can Be Wrong** | 2 | DecisionAgent, ReviewAgent |
| **SD-7: Ledger** | 3 | DecisionAgent, FinalVerifyAgent, ResolutionAgent |
| **F-1: Re-Run on Integration Tree** | 2 | VerificationAgent, FinalVerifyAgent |
| **PL-5: No Placeholders** | 2 | SpecAgent, PlannerAgent |
| **PL-7: Execution Handoff** | 1 | DecisionAgent |
| **B-2: One Question At A Time** | 1（但 G-2 也类似） | ClarificationAgent |
| **T-1: Iron Law (No Code Without Test)** | 1 | ImplementationAgent |
| **T-4: Code Before Test? Delete It** | 3 | ImplementationAgent, TestAgent, FixAgent |
| **D-1: Iron Law (No Fix Without Root Cause)** | 1 | FixAgent |

**没有重复对标**：每个 Pattern 只属于一个或少数几个职能相关的 Agent。

**真正共享的 Pattern** 都是**通用工程原则**（Fresh Evidence, Severity Scale, Re-Run Tests 等），它们的复用是合理的，不是错对。

## 设计原则

> 一个 Agent 借鉴的 Pattern 集合应该**唯一标识它的角色**，不与其他 Agent 重叠。

按这个原则检查：

- **TestAgent** vs **VerificationAgent** vs **FinalVerifyAgent** 看似都借鉴 V-1/V-2，但其实**粒度不同**：
  - TestAgent：跑 per-AC 的具体测试
  - VerificationAgent：跑 whole-suite + 行为 5-question check
  - FinalVerifyAgent：跑 whole-branch tests + 两轴 review
- **ReviewAgent** vs **FinalVerifyAgent** 看似都借鉴 CR-1/CR-2/CR-3/CR-4/CR-5，但其实**粒度不同**：
  - ReviewAgent：per-task 两轴 review
  - FinalVerifyAgent：whole-branch 两轴 review（**并行 dispatch 两个 subagent**）

这些"复用"是**正确的设计模式复用**，不是错误的对标。

## 与之前 Mapping 的差异

之前：

- 每个 Agent 标注"借鉴 X skill"（skill 级别），导致多个 Agent 共享同一 skill → 看起来重复对标
- 没有区分 skill 内的不同 pattern

现在：

- 每个 Agent 标注"借鉴 X pattern（属于 Y skill）"（pattern 级别）
- 真正共享的只是通用工程原则的 pattern，不是"对标错误"