# CLAUDE.md

本仓库的 agent 约定统一维护在 [AGENTS.md](./AGENTS.md),开始工作前请先阅读。

## 测试约定

本仓库的 `npm run test:all` 跑全部 suite,耗时很长。**在实现类任务里,agent 只需要跑自己相关的测试** —— 也就是本次改动直接修改或新增的代码所对应的 suite。判定标准:

- 修改了 `packages/.../src/**` 下的源文件 → 跑受影响的单测,例如 `npm run test:ui`、`test:route`、`test:client`、`test:storage`、`test:mount`、`test:patterns`、`test:tools`、`test:host`、`test:executor`、`test:diff`、`test:wtgit`、`test:probe`、`test:plan`、`test:clarify`、`test:spec`、`test:design`、`test:reasons`、`test:stage`、`test:watch`。
- 新增或修改了 `scripts/test-*.mjs` 下的测试文件 → 单独跑那个 suite 即可。
- `npm run lint`(tsc `--noEmit`) 始终要跑,确认类型干净。
- **不**跑 `npm run test:all` —— 那只是给 CI 和最终发布前的人类用的,agent 实现环节默认不需要。

如果一个改动跨多个模块,就把对应的 suite 都跑一遍;只跑自己相关的,不要顺手把别的 suite 也带进去。
