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
│   └── dsh-auto-rd/              # The actual Cordis plugin (TypeScript)
├── docs/
│   └── architecture/             # Design docs
├── examples/                     # cordis.patch.yml snippets
├── .github/workflows/            # CI
├── README.md
├── LICENSE (MIT)
└── NOTICE                        # Acknowledgements
```

## Installation

```bash
# Install into your DSH profile
cd ~/.dsh/profiles/web
pnpm add @yangzhitong/dsh-auto-rd
```

Add to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- id: auto-rd
  name: '@yangzhitong/dsh-auto-rd'
  config:
    tapdApiToken: '<your-tapd-api-token>'
    gitlabApiToken: '<your-gitlab-api-token>'
    workspaceRoot: 'C:/work'
    modules:
      - id: payment
        title: 'Payment Service'
        repoUrl: 'https://gitlab.example.com/payment/payment-service.git'
        defaultBranch: 'main'
```

Restart DSH. The plugin mounts automatically.

## Acknowledgements

This project draws heavily from two outstanding agent-skill ecosystems:

- **[obra/superpowers](https://github.com/obra/superpowers)** — software development methodology + composable skill library
- **[mattpocock/skills](https://github.com/mattpocock/skills)** — engineering skills for daily coding

The 13 Agent personas in this plugin are adapted from specific patterns in those repositories. See [`packages/dsh-auto-rd/src/agents/AGENT-SKILL-MAPPING.md`](./packages/dsh-auto-rd/src/agents/AGENT-SKILL-MAPPING.md) for the pattern-by-pattern mapping.

## License

MIT — see [`LICENSE`](./LICENSE).

Portions of this codebase are derived from obra/superpowers and mattpocock/skills. Both are MIT-licensed; see [`NOTICE`](./NOTICE) for attributions.