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

## Verifying a deployment

Automated coverage stops short of four things that need a real environment.
This is how to check each one.

```bash
# 1. Build and run every suite (19 suites, 893 assertions)
npm run build
npm run test:all          # see the root package.json for the full list
```

### 2. The host half actually mounts

The mount path is exercised end to end against a faithful fake host
(`npm run test:mount`), but a real mount needs a running DSH:

```bash
# add the row to ~/.dsh/profiles/web/cordis.patch.yml, then restart DSH
# and look for these lines in the DSH log:
#   auto-rd plugin starting up
#   [auto-rd] registered tools: auto_rd_status / auto_rd_trigger / auto_rd_retry
#   Registered system-prompt section: auto-rd-overview
#   Registered panel route: GET /auto-rd/panel
#   [auto-rd] plugin mounted — poller + queue + notifier running
```

### 3. The panel data route answers

```bash
curl -s localhost:3080/auto-rd/panel | head -40
# -> { "ok": true, "generatedAt": "...", "model": { "modules": [...], ... }, "text": "..." }
```

### 4. The client panel renders

The client half is declared with `dsh.client` and served from
`exports["./client"]` → `lib/client.js`. After installing the package into a
profile and reloading the GUI, **Auto-RD** should appear in the sidebar
(`sidebar.panellist#auto-rd-modules`) and open a main-column panel listing
modules, stories, state badges and MR links.

> The `dsh.client` declaration is validated at boot: a malformed declaration
> or a missing bundle makes the boot activation audit fail the fiber. The
> shape here was read off a shipped client plugin
> (`@deepseek-ai/dsh-client-ui-sidebar`) rather than inferred, and
> `npm run test:client` pins it.

### 5. TAPD and GitLab round-trips

Both have production-grade code and fake-server tests (`npm run test:m4`).
A live run needs real credentials — supply them via `process.env` or a DSH
secret reference, never as literal text in a committed file.

## Development

```bash
# Inside the monorepo root
pnpm install
pnpm --filter @yangzhitong/dsh-auto-rd build
pnpm --filter @yangzhitong/dsh-auto-rd lint
```

## Layout

```
src/
  index.ts              plugin entrypoint: apply(ctx, config)
  config.ts             zod config schema
  client/client.js      the browser half (copied verbatim to lib/client.js)
  domain/               storageDomain schema + the table adapter
  agents/               13 AgentSpecs + personas/ + AGENT-SKILL-MAPPING.md
  services/             the pipeline: runner, queue, providers, integrations
  tools/                3 model-callable tools
  types/dsh-services.ts verified DSH host contracts (see §7.5 of the design)
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