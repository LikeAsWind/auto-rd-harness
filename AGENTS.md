## Agent skills

### Issue tracker

议题记录在 `LikeAsWind/auto-rd-harness` 的 GitHub Issues 中,通过 `gh` CLI 操作。详见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个标准 triage 角色,label 字符串与角色名一致。详见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局:仓库根目录下一份 `CONTEXT.md` 加 `docs/adr/`。详见 `docs/agents/domain.md`。

## 命令执行安全

所有命令与文件内容都必须以**明文、可审计**的方式执行或写入。**禁止用 `base64`(或 `xxd`、`base32`、`od`、解码后执行等)对命令或文件内容做编码/混淆**来绕过审批或审计。

- 写文件用明文 heredoc(`cat > f <<'EOF'`),命令直接明文执行。
- 命令超时或被策略拦截时,修根因,不要用编码手段绕过。

## 测试约定

`npm run test:all` 跑全部 suite,耗时很长,agent 实现类任务里**不要**默认跑它。具体哪些算"自己相关的测试":

- 修改了 `packages/.../src/**` 下的源文件 → 跑对应模块的单测(`test:ui` / `test:route` / `test:client` / `test:storage` / `test:mount` / `test:patterns` / `test:tools` / `test:host` / `test:executor` / `test:diff` / `test:wtgit` / `test:probe` / `test:plan` / `test:clarify` / `test:spec` / `test:design` / `test:reasons` / `test:stage` / `test:watch` 等),以及任何直接 `node scripts/test-*.mjs` 的 suite。
- 新增或修改了 `scripts/test-*.mjs` 下的测试文件 → 单独跑那个 suite 即可。
- 跨模块改动 → 把对应的 suite 都跑一遍;只跑自己相关的,不要顺手把别的 suite 也带进去。
- `npm run lint`(tsc `--noEmit`) 始终要跑,确认类型干净。

`npm run test:all` 留给 CI 和发布前的人类,agent 默认不需要。
