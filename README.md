# Auto-RD Harness

> TAPD-driven automated research & development pipeline for [DeepSeek Harness](https://github.com/deepseek-ai/dsh).

## What is this?

**auto-rd-harness** is a deployment-level [Cordis plugin](https://github.com/deepseek-ai/cordis) for [DeepSeek Harness](https://github.com/deepseek-ai/dsh) that:

1. **Pulls stories** from TAPD
2. **Runs an automated engineering pipeline** for each story (13-stage workflow)
3. **Produces code, MRs, and tests** with quality gates
4. **Reports everything in Harness's native UI** (no separate dashboard)

## Pipeline Stages

Each TAPD story flows through these stages:

```
pending → context → clarification → brainstorm → critic → decision
       → spec → planning → implementing → testing ⇄ fixing
       → verifying → reviewing → final_verifying → mr_creating
       → tapd_syncing → completed
```

Each stage is a specialized Agent persona. See [`packages/dsh-auto-rd/src/agents/`](./packages/dsh-auto-rd/src/agents/) for the full list.

## Architecture

This plugin is **not** a dynamic Cordis plugin. It is a **deployment-level plugin** that ships with DSH on every startup. See [`docs/architecture/auto-rd-native-plugin-design.md`](./docs/architecture/auto-rd-native-plugin-design.md) for the design rationale.

## Repository Layout

```
auto-rd-harness/
├── packages/
│   └── dsh-auto-rd/              # The actual Cordis plugin (TypeScript + one client bundle)
│       └── src/client/client.js  #   the browser half (sidebar panel + main panel)
├── docs/
│   └── architecture/             # Design docs
├── examples/                     # cordis.patch.yml snippets
├── scripts/                      # Test suites and the install-to-dsh helper
├── .github/workflows/            # CI
├── README.md
├── LICENSE (MIT)
└── NOTICE                        # Acknowledgements
```

## Testing

```bash
npm run build          # tsc + copy the personas and the client bundle
npm run lint           # tsc --noEmit
npm run test:all       # every suite, with a summary table
```

`test:all` runs 21 suites / 925 assertions: the pipeline state machine and
tools, the real subprocess test runner, the real git diff reader and
committer, the project probe, the plan/spec/clarify/design generators, the
storage adapter against the verified `KvTable` contract, the DSH host
contracts, a full `apply()` mount against a faithful fake host, the panel
HTTP route, the client bundle, a bidirectional audit of the Agent
pattern mapping, and the `install-to-dsh` lifecycle (idempotent install,
header preservation, dry-run, uninstall). Individual suites are exposed as
`test:m5`, `test:probe`, `test:mount`, `test:install-to-dsh`, and so on.

Four things need a real environment and are listed with concrete
verification steps in
[`packages/dsh-auto-rd/README.md`](./packages/dsh-auto-rd/README.md#verifying-a-deployment):
a live mount inside DSH, the panel route over HTTP, the client panel in a
browser, and the TAPD/GitLab round trips.

## Installation

```bash
# One command, from the repo root
npm run install:dsh
```

That script wires the plugin into your local DSH profile (writes the managed block in `cordis.patch.yml`, runs the package-manager add) and prints the next step (set `DSH_TAPD_API_TOKEN` / `DSH_GITLAB_API_TOKEN` in the shell that launches DSH, then restart DSH).

For the full guide — including uninstall, `--dry-run`, non-default profiles, and a bilingual walkthrough — see **[`docs/installation.md`](./docs/installation.md)**. (中文 / English; 中文在前)

## Acknowledgements

This project draws heavily from two outstanding agent-skill ecosystems:

- **[obra/superpowers](https://github.com/obra/superpowers)** — software development methodology + composable skill library
- **[mattpocock/skills](https://github.com/mattpocock/skills)** — engineering skills for daily coding

The 13 Agent personas in this plugin are adapted from specific patterns in those repositories. See [`packages/dsh-auto-rd/src/agents/AGENT-SKILL-MAPPING.md`](./packages/dsh-auto-rd/src/agents/AGENT-SKILL-MAPPING.md) for the pattern-by-pattern mapping.

## License

MIT — see [`LICENSE`](./LICENSE).

Portions of this codebase are derived from obra/superpowers and mattpocock/skills. Both are MIT-licensed; see [`NOTICE`](./NOTICE) for attributions.