# 安装指南 · Installation

> **默认语言：中文。** English follows below.

本插件以 **Cordis 部署级插件** 形式集成到本地 DSH（DeepSeek Harness）中。下面是完整的一键安装流程。

---

## 中文

### 标准安装（DSH 官方三件套）

DSH 的 bundle 装载依赖三件事都必须到位（[DSH 文档 — bundles & patches](https://github.com/deepseek-ai/dsh)）：

1. 包已经安装在 profile 的 `node_modules` 中；
2. 包被记入 `<profile>/package.json#dsh.profile.bundles`，loader 才能解析；
3. `<profile>/cordis.patch.yml` 中有对应的 `- id / name / config` 行，激活图才能挂载。

**`npm run install:dsh` 三步一并完成**，不需要手动编辑任何文件：

```powershell
npm run install:dsh
```

脚本会：

1. `npm run build` 一次，确保 `lib/` 和 `lib/client.js` 是新的（dry-run 不跑）；
2. `npm pack` 把本地包打成 tarball，缓存到 `<profile>/node_modules/.cache/autord-install/`（绕开 cmd.exe 对 `@` 的转义问题）；
3. `pnpm add -C $env:DSH_HOME\profiles\web @file:<tarball>`（自动检测 npm / pnpm / yarn —— DSH profile 默认带 pnpm）；
4. 在 `<profile>/package.json` 的 `dsh.profile.bundles` 列表里加上 `@yangzhitong/dsh-auto-rd`（幂等）；
5. 在 `<profile>/cordis.patch.yml` 中**追加**一个**受控块**（marker 包裹），里面是 `packages/dsh-auto-rd/cordis.patch.yml` 的默认 loader entry 副本——DSH loader 在 user overlay 里看到这个块时，会按 `- id:` 匹配 bundle 自身注入的 entry（bundle 用了 `- insert:` 形态，user overlay 用 `- id:` patch 形态来覆盖它的 `config:`），所以**不会**产生重复 entry：
   ```yaml
   # >>> auto-rd (managed by scripts/install-to-dsh.mjs) >>>
   - id: auto-rd
     name: '@yangzhitong/dsh-auto-rd'
     config:
       tapdBaseUrl: 'https://api.tapd.cn'
       tapdApiToken: ''
       ...
   # <<< auto-rd <<<
   ```
   块外原内容**字节级保留**；
6. 打印下一步：编辑 patch 文件设置 token + 模块 → 重启 DSH。

整个过程是**幂等**的：重跑 `npm run install:dsh` 不会重复装包、不会写第二份配置——已存在的受控块会被就地刷新。

### 设置凭据（环境变量，不入文件）

凭据通过 `!!js "process.env.X || ''"` 引用，**任何时候都不会被写入文件或日志**。在启动 DSH 的那个 shell 里：

```powershell
$env:DSH_TAPD_API_TOKEN   = '<你的 TAPD token>'
$env:DSH_GITLAB_API_TOKEN = '<你的 GitLab token>'
dsh web      # 或你平时启动 DSH 的命令
```

如果你用 `setx` 持久化，**注意重启 DSH 之前** token 已经存在于用户环境——而该用户的进程列表里也看得到它。这本身是 Windows 进程模型的限制，不是插件问题。如果你希望更严格，可以用：

```powershell
$env:DSH_TAPD_API_TOKEN   = '<token>'
$env:DSH_GITLAB_API_TOKEN = '<token>'
dsh web
```

即"只为这次启动设一次"。

### 编辑模块列表 / 自定义配置

`cordis.patch.yml` 受控块里的 `config:` 是 `packages/dsh-auto-rd/cordis.patch.yml` 的副本（install 脚本剥掉 bundle 的 `- insert:` 外壳，保留 entry 内的 `id / name / config`）。把它改成你的真实仓库：

```yaml
- id: auto-rd
  name: '@yangzhitong/dsh-auto-rd'
  config:
    tapdApiToken: '<your-tapd-token>'   # 或者保留 !!js 引用
    workspaceRoot: 'C:/work'
    modules:
      - id: payment
        title: 'Payment Service'
        repoUrl: 'https://gitlab.example.com/payment/payment-service.git'
        defaultBranch: 'main'
```

每次编辑后，重启 DSH 即可。

### 卸载

```powershell
npm run uninstall:dsh
```

会做三件事：移除 `cordis.patch.yml` 的受控块、从 `package.json#dsh.profile.bundles` 中摘除、`pnpm remove @yangzhitong/dsh-auto-rd`。其余 loader 配置保留不动。

### 标志与高级用法

```powershell
# 试运行（不真装，不写文件；显示每一步会做什么）
npm run install:dsh -- --dry-run

# 装到非默认 profile
npm run install:dsh -- --profile D:\my-profile\web

# 卸载 + 试运行
npm run uninstall:dsh -- --dry-run

# 帮助
node scripts/install-to-dsh.mjs --help
```

### 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `spawnSync pnpm ENOENT` | pnpm 没在 PATH。装 pnpm 或用 `--profile` 指定用 npm 的 profile |
| 启动后 DSH 报 `loader entries failed to apply` | 检查 `cordis.patch.yml` 中 `!js` 表达式的语法；确保 env var 已设 |
| `modules: []` 警告 | 至少配一个模块，否则插件无事可做 |
| **侧栏有 Auto-RD 但面板空白** | `webServer` 没装或没在激活图里。检查 DSH 是否在 web profile 下启动、是否启用了 `@deepseek-ai/dsh-host-webserver` |
| **侧栏没有 Auto-RD** | 重启 DSH 之前必须 token 已设；浏览器 console 跑 `cordis_inspect what:"client"` 看 `sidebar.panellist` 下有没有 `auto-rd-modules` cell |
| **Console 报 `register: unknown option 'order'`** | 你的 DSH 版本早于 ui-slots 重构前。请升级到 0.1.6 或以上版本（DSH `dsh-v0.1.6-alpha.1` 起 ui-sidebar 才引入 `id`/`order`/`label` 字段） |

---

## English

### Standard install (DSH's official three pieces)

A DSH bundle is wired up when **all three** of these are true (see [DSH docs — bundles & patches](https://github.com/deepseek-ai/dsh)):

1. The package is installed in the profile's `node_modules`;
2. The package is listed under `<profile>/package.json#dsh.profile.bundles`, so the loader can resolve it;
3. `<profile>/cordis.patch.yml` has a matching `- id / name / config` row, so the activation graph mounts it.

**`npm run install:dsh` does all three**, no manual editing required:

```powershell
npm run install:dsh
```

The script:

1. Runs `npm run build` so `lib/` and `lib/client.js` are fresh (skipped in dry-run);
2. `npm pack` produces a tarball cached under `<profile>/node_modules/.cache/autord-install/` (avoids cmd.exe's `@` quoting issue);
3. `pnpm add -C <profile> @file:<tarball>` (auto-detects npm / pnpm / yarn — DSH profiles ship with pnpm);
4. Appends `@yangzhitong/dsh-auto-rd` to `<profile>/package.json#dsh.profile.bundles` (idempotent);
5. **Appends a managed block** to `<profile>/cordis.patch.yml` containing the plugin's default loader entry (copied from `packages/dsh-auto-rd/cordis.patch.yml`, with the bundle's `- insert:` wrapper stripped so the user overlay uses the patch form `- id:` and merges into the bundle-inserted entry instead of inserting a duplicate). Everything outside the block is preserved byte-for-byte;
6. Prints next steps (edit the patch to set tokens + modules → restart DSH).

The operation is **idempotent**: re-running refreshes the managed block in place rather than duplicating it.

### Credentials (env vars, never on disk)

Tokens are referenced via `!!js "process.env.X || ''"`. They are **never** written to disk or echoed in logs. In the shell that launches DSH:

```powershell
$env:DSH_TAPD_API_TOKEN   = '<your TAPD token>'
$env:DSH_GITLAB_API_TOKEN = '<your GitLab token>'
dsh web
```

### Module list / custom config

The `config:` inside the managed block is copied from the plugin's default `cordis.patch.yml`. Edit it to point at your real repos:

```yaml
- id: auto-rd
  name: '@yangzhitong/dsh-auto-rd'
  config:
    tapdApiToken: '<your-tapd-token>'   # or keep the !!js reference
    workspaceRoot: 'C:/work'
    modules:
      - id: payment
        title: 'Payment Service'
        repoUrl: 'https://gitlab.example.com/payment/payment-service.git'
        defaultBranch: 'main'
```

Restart DSH after each edit.

### Uninstall

```powershell
npm run uninstall:dsh
```

Three things: removes the managed block from `cordis.patch.yml`, removes the bundle from `package.json#dsh.profile.bundles`, runs `pnpm remove`. Other loader config is untouched.

### Flags

```powershell
npm run install:dsh -- --dry-run          # preview only
npm run install:dsh -- --profile <dir>    # non-default profile
npm run uninstall:dsh -- --dry-run        # preview uninstall
node scripts/install-to-dsh.mjs --help    # full help
```

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `spawnSync pnpm ENOENT` | pnpm not on PATH. Install it or use a profile whose lockfile is npm/yarn |
| `loader entries failed to apply` on DSH start | Check `!js` syntax in `cordis.patch.yml`; ensure env vars are set before launching DSH |
| `modules: []` warning | Configure at least one module |
| **Sidebar shows Auto-RD but panel body empty** | `webServer` is not mounted (missing `@deepseek-ai/dsh-host-webserver`). Confirm you launched `dsh web`, not headless / sdk. |
| **Sidebar does not show Auto-RD at all** | Confirm env vars were set before DSH restart. In browser console, run `cordis_inspect what:"client"` and check whether `sidebar.panellist` has an `auto-rd-modules` cell. |
| **Console reports `register: unknown option 'order'`** | Your DSH predates the ui-slots refactor. The `id`/`order`/`label` list-cell fields require DSH 0.1.6 (`dsh-v0.1.6-alpha.1`) or later. |