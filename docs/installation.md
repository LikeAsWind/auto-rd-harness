# 安装指南 · Installation

> **默认语言：中文。** English follows below.

本插件以 **Cordis 部署级插件** 形式集成到本地 DSH（DeepSeek Harness）中。下面是完整的一键安装流程。

---

## 中文

### 一行安装（推荐）

在仓库根目录执行：

```powershell
npm run install:dsh
```

脚本会：

1. `pnpm add -C $env:DSH_HOME\profiles\web @yangzhitong/dsh-auto-rd@file:packages/dsh-auto-rd`
   （自动检测 npm / pnpm / yarn —— DSH profile 默认带 pnpm）
2. 在 `$env:DSH_HOME\profiles\web\cordis.patch.yml` 中插入**受控块**（marker 包裹）：
   - 块内是 `auto-rd` 这一个 loader entry
   - 块外原内容**字节级保留**
3. 提示下一步：设置环境变量 → 重启 DSH

整个过程是**幂等**的：重复跑 `npm run install:dsh` 不会重复装包、不会写第二份配置。

### 设置凭据（环境变量，不入文件）

凭据通过 `!js "process.env.X || ''"` 引用，**任何时候都不会被写入文件或日志**。在启动 DSH 的那个 shell 里：

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

### 编辑模块列表

`cordis.patch.yml` 中 `modules:` 是空数组。改成你的真实仓库：

```yaml
    modules:
      - id: payment
        title: 'Payment Service'
        repoUrl: 'https://gitlab.example.com/payment/payment-service.git'
        defaultBranch: 'main'
      - id: order
        title: 'Order Service'
        repoUrl: 'git@gitlab.example.com:order/order-service.git'
        defaultBranch: 'main'
```

每次编辑模块列表后，重启 DSH 即可。

### 卸载

```powershell
npm run uninstall:dsh
```

会做两件事：移除 `cordis.patch.yml` 的受控块，并执行 `pnpm remove @yangzhitong/dsh-auto-rd`。其余 loader 配置保留不动。

### 标志与高级用法

```powershell
# 试运行（不真装，不写文件）
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
| DSH 启动后侧栏找不到 Auto-RD | 检查 `[3/3] Next steps` 中的环境变量；重启 DSH 之前 token 必须存在 |

---

## English

### One-line install (recommended)

From the repo root:

```powershell
npm run install:dsh
```

The script:

1. Runs `pnpm add -C $env:DSH_HOME\profiles\web @yangzhitong/dsh-auto-rd@file:packages/dsh-auto-rd`
   (auto-detects npm / pnpm / yarn — DSH profiles ship with pnpm).
2. Inserts a **managed block** in `$env:DSH_HOME\profiles\web\cordis.patch.yml`,
   wrapped in begin/end markers. The block contains the single
   `auto-rd` loader entry; everything outside it is preserved byte-for-byte.
3. Prints next steps (set env, restart DSH).

The operation is **idempotent** — re-running it does not reinstall or duplicate the patch.

### Credentials (env vars, never on disk)

Tokens are referenced via `!js "process.env.X || ''"`. They are **never** written to disk or echoed in logs. In the shell that launches DSH:

```powershell
$env:DSH_TAPD_API_TOKEN   = '<your TAPD token>'
$env:DSH_GITLAB_API_TOKEN = '<your GitLab token>'
dsh web
```

### Module list

Edit `modules:` in the patch block to point at your real repos:

```yaml
    modules:
      - id: payment
        title: 'Payment Service'
        repoUrl: 'https://gitlab.example.com/payment/payment-service.git'
        defaultBranch: 'main'
```

Restart DSH after editing.

### Uninstall

```powershell
npm run uninstall:dsh
```

Removes the managed block and runs `pnpm remove`. Other loader config is untouched.

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
| Auto-RD sidebar missing in DSH | Confirm env vars are set in the shell that starts DSH, then restart |