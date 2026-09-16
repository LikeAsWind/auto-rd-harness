# @yangzhitong/dsh-auto-rd

> Cordis plugin for DeepSeek Harness — TAPD-driven automated R&D pipeline.

## Status

✅ **M1-M4 + M4-UI complete.** M5 integration tests at 51 pass; M5 e2e (real TAPD + GitLab + DSH runtime) remains as a user-side prerequisite.

Currently:
- ✅ 13 Agent personas (Pattern-borrowed from obra/superpowers + mattpocock/skills)
- ✅ storageDomain v3 schema (modules, stories, tasks + 7 M4 checkpoint fields)
- ✅ Config schema (zod, 16 keys)
- ✅ Plugin lifecycle (apply, 8-step mount, inject list)
- ✅ TapdPoller (real TAPD API + mock fallback + multi-envelope parsing)
- ✅ WorkspaceManager (module workspace + worktree)
- ✅ SubAgentProvider (per-task dispatch, no-subagents contract, sentinel tokens)
- ✅ StoryQueue scheduler (global + per-module concurrency limits, 10s tick)
- ✅ StoryRunner (19-state machine, 5-round fix breaker, two-axis parallel review)
- ✅ recoverStories (cross-restart state reset)
- ✅ Sidebar UI (JSON tree renderer, polling notifier, 3 model-callable tools)
- ✅ System prompt section registration
- ✅ GitLab MR creation (push + createOrReuseMR with checkpoint recovery)
- ✅ TAPD syncTapd (POST/PATCH with 404 fallback + 20-attempt cap)
- ✅ Logger rate limit (5/60s sliding window per bucket)
- ✅ M5 integration test suite (51 pass)

## Architecture

13 specialized Agent personas drive each Story through a 19-state machine:

```
pending → context → clarification → brainstorm → critic → decision
       → spec → planning → implementing → testing ⇄ fixing
       → verifying → reviewing → final_verifying → mr_creating
       → tapd_syncing → completed
```

Each Agent is implemented as a class with:
- `name`: identifier
- `persona`: full markdown system prompt (injected via `ctx.systemPrompt.section()`)
- `toolFilter`: subset of tools the subagent can use
- `outputFormat`: how the orchestrator parses the subagent's final message

See [`src/agents/`](./src/agents/) for the full list. Each Agent file header documents which patterns it borrows from obra/superpowers and mattpocock/skills.

## Installation

See the [main repository README](../../README.md) for installation instructions.

## Development

```bash
# Inside the monorepo root
pnpm install
pnpm --filter @yangzhitong/dsh-auto-rd build
pnpm --filter @yangzhitong/dsh-auto-rd lint
pnpm --filter @yangzhitong/dsh-auto-rd test
```

## Configuration

The plugin reads its config from the DSH profile's `cordis.patch.yml`:

```yaml
- id: auto-rd
  name: '@yangzhitong/dsh-auto-rd'
  config:
    tapdApiToken: '<your-tapd-api-token>'
    # ... see packages/dsh-auto-rd/cordis.yml for full default config
```

See [`cordis.yml`](./cordis.yml) for the default config schema.

## License

MIT — see [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).