# @yangzhitong/dsh-auto-rd

> Cordis plugin for DeepSeek Harness — TAPD-driven automated R&D pipeline.

## Status

🚧 **M1 (skeleton in progress)**

Currently:
- ✅ Agent personas (Pattern-borrowed from obra/superpowers + mattpocock/skills)
- ✅ storageDomain table schemas (modules, stories, tasks)
- ✅ Config schema (zod)
- 🚧 Plugin lifecycle (apply, mount)
- ⏳ TapdPoller (M1 next)
- ⏳ WorkspaceManager (M1 next)
- ⏳ SubAgentProvider (M1 next)
- ⏳ StoryQueue scheduler (M1 next)
- ⏳ Sidebar UI (M2)
- ⏳ GitLab MR creation (M4)

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