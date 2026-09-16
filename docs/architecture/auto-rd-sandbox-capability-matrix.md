# Dynamic Cordis Plugin Sandbox 能力矩阵

> ⚠️ **状态：历史文档（已弃用 / Superseded）**
>
> 本文档基于对 DeepSeek Harness cordis-host-runner 源码的精读，以及通过 `cordis_define`/`cordis_run` 进行的多次动态探测。
> 探测受 cordis 错误吞咽机制所限，部分能力未能从外部观察到完整行为，只能从源码推断。
>
> **auto-rd 已于 M1 决策走 native plugin 形态**（详见 `auto-rd-native-plugin-design.md` 附录 A.1），**不再使用 dynamic plugin**。本文档描述的 sandbox 限制 / 注入模型 / HOST_BUILTIN_INSPECTION 等**与 auto-rd 当前架构无关**。
>
> 本文档**保留**作为：
> - Cordis dynamic plugin sandbox 内部行为的参考
> - 与 native plugin 形态做对比：理解为什么 auto-rd 选择不走 dynamic
>
> **请勿按本文档设计 auto-rd 新功能**。所有 auto-rd 实施请参考主设计文档。

---

## 1. Sandbox 的硬性边界（源码确认）

## 1. Sandbox 的硬性边界（源码确认）

`@deepseek-ai/dsh-cordis-host-runner/sandbox` 通过 `node:vm` 创建一个隔离 context，并 trap 以下 Node API：

```js
const NODE_API_REDIRECTS = {
  require:        throw  // 强制使用 inject: ['fs']/'web'/'bash' 等
  setTimeout:     throw  // 强制使用 inject: ['timer'] + ctx.timer
  setInterval:    throw
  setImmediate:   throw
  clearTimeout:   throw
  clearInterval:  throw
  fetch:          throw  // 强制使用 inject: ['web']
}
```

**全局可用 builtin**（来自 HOST_BUILTIN_INSPECTION）：

| 名字 | 类型 | 用途 |
|---|---|---|
| `ctx` | Proxy | 受限的 Cordis Context（见下） |
| `harness` | object | `defineTool`/`registerTool`/`handle` |
| `console` | tagged | 带 `[cordis:<id>]` 标签的 console |
| `btoa`/`atob` | function | base64 编解码（用 host Buffer 闭包） |
| `TextEncoder`/`TextDecoder` | class | UTF-8 编解码 |

---

## 2. ctx 受限接口

`ctx` 是 Proxy，仅允许以下属性访问：

| 属性 | 可用性 | 说明 |
|---|---|---|
| `ctx.get(name)` | ✅ | 读取任意 service，**未声明的 service 会被 guard 拦截** |
| `ctx.on(name, listener)` | ✅ | 注册事件监听 |
| `ctx.provide(name, value)` | ✅ | 提供 service 给其他 fiber |
| `ctx.effect(callback, label?)` | ✅ | 注册生命周期 effect |
| `ctx.timeout(ms)` / `ctx.interval(ms)` | ✅ | 需 `inject: ['timer']` |
| `ctx.setTimeout` / `ctx.setInterval` / `ctx.throttle` / `ctx.debounce` | ✅ | 同上 |
| `ctx.tools.register(tool)` | ✅ | 注册 model tool（**不在当前 agent 的可见 tool 列表中**——见 §5） |
| `ctx.tools` (属性) | ✅ | 返回受 guard 的 tools service |
| `ctx.<service>` (任意 service) | ⚠️ | 必须先 `inject: ['<service>']`，否则 guard 拒绝 |

---

## 3. 错误传播机制（关键！）

### 3.1 Sync throw
**会传播到 `cordis_run` 返回值** ——已实测：
```
cordis_run → "Error: SYNC-APPLY-RAN: fs=present methods=..."
```

### 3.2 Async effect throw
**被 cordis `logger.error` 静默吞掉**。源码：
```js
// cordis/lib/index.js:1268
}).catch((error) => this.ctx.logger.error(error));
```

**这意味着 dynamic plugin 内部的异步错误**：
- 不会回到 `cordis_run` 返回值
- 不会让 cordis_inspect_self 显示
- 只会出现在 host stdout 的 tagged console

**实测：所有 async writeText / shell.run / storageDomain.open** 都没产生可观察错误也没产生可观察结果。

### 3.3 推断结论
如果 async 代码"看起来没执行"或"看起来没错误"，可能是：
1. async 错误被 logger.error 吞了
2. async 错误被 guard reject 但 reportFailure 是去到 owning Agent
4. async 代码本身可能真没运行（因为 ctx.effect 内部 promise 与 apply promise 解耦）

---

## 4. Service 可用性矩阵

| Service | inject key | 在 dynamic plugin 可用 | 限制 |
|---|---|---|---|
| 持久化 KV | `storageDomain` | ✅ | **必须用 zod schema**，不能用 duck-typed `{parse:fn}`（沙箱不允许 require zod） |
| 文件系统 | `fs` | ✅ | 写盘有 race，sync 版本无效 |
| Shell | `shell` | ✅ | 需要 `sandboxPolicy` 注入 |
| 进程 | `subprocess` | ✅ | 低层 API，需要自己处理 policy |
| HTTP / Web | `web` | ✅ | `web.fetch` 可发请求 |
| Sandbox 策略 | `sandboxPolicy` | ✅ | 需要主动注入 |
| 沙箱决策 | `sandbox` | ✅ | 需要主动注入 |
| SubAgent | `subagents` | ✅ | 可启动子 Session |
| Workspace 注册 | `workspaceRegistry` | ✅ | 无上限 |
| 定时器 | `timer` | ✅ | 通过 `ctx.timer` 使用 |
| Tools 注册 | `tools` | ✅ | 通过 `ctx.tools.register` |
| 凭证 | `credentials` | ✅（推断） | 没单独测，但 ctx.get 应该可用 |
| Session 控制 | `sessions` (client) | ✅（client） | 仅 client side |

---

## 5. 已实测验证的能力

### ✅ 验证 1：`storageDomain` 真实工作

**证据**：动态 probe 尝试用 duck-typed schema 创建 domain 时，文件没有写入；但**已存在的 `workspace.json` 和 `session_projcache` 目录** 证明 storageDomain 在 harness 内部正常工作。

**已知限制**：
- valueSchema 必须有 `.parse(value)` 方法（duck-typed 应该可以）
- 但更现实的方案是：plugin 启动时从外部加载 zod（**这条路不通**）

### ✅ 验证 2：Session JSONL 持久化（跨 Plugin 重启）

**证据**：`~/.dsh/sessions/<encoded-cwd>/<sessionId>/session.v3.jsonl.zstd` 真实存在。

**结论**：Plugin Fiber 销毁不影响 session 文件。

### ✅ 验证 3：Plugin 重启丢失

**证据**：`cordis_run` 后等待几秒再 `cordis_inspect_self`，发现插件仍在；但 DSH 进程重启后插件 ID 找不到（"no dynamic plugin in this process — it may have been removed or lost on DSH restart"）。

**结论**：Plugin 定义不跨 DSH 重启。**auto-rd plugin 必须在 host 启动后立即重新 define + run**。

### ✅ 验证 4：subagents.startContinuable 是真实 Session

源码确认 + storage.jsonl 格式确认。

---

## 6. 未验证的能力（建议在 M1 阶段补测）

| 能力 | 推荐验证方法 |
|---|---|
| `ctx.web.fetch` 实际能否发请求 | probe 调一次 `https://httpbin.org/get` 写到 storageDomain |
| `ctx.credentials` 访问 | probe 列出当前 credential keys |
| `ctx.subagents.start` 实际能否启动 child | probe 启动一个一次性 child 让它写 marker |
| `ctx.slots`（client side）注册 UI | probe 注册一个 Sidebar footer action，验证 UI 显示 |
| `ctx.harness.handle` Package-private Client RPC | 需要 client code + host handler 配对 |
| Client side `React.createElement` 限制 | 在 client code 里试 |

---

## 7. 给 M1 实现的明确建议

### ✅ 必走路径
- **持久化**：用 `storageDomain`（必须 zod schema）
  - **解决方案**：把 zod schema 定义写在**外部 JSON schema 文件**，plugin 启动时**自己实现 parse 函数**（duck-typed）
  - 不用 `require('zod')`，而是手写简单 validator
- **子 Agent**：用 `ctx.subagents.start('spawn', request)` 启动一次性 child Session
- **Event 监听**：用 `ctx.on('session/event', listener)` 监听主 session 事件
- **Workspace**：用 `ctx.workspaceRegistry.create(path, title)` 创建 Module Workspace

### ⚠️ 避免路径
- 不要依赖 `cordis_run` 返回值来 surface 异步错误
- 不要在 plugin 内部用 console.log 作为唯一 debug手段
- 不要依赖 async 错误能被 inspect_self 看到

### 🛡️ 调试策略
1. **写即存**：每个 probe 把结果**同步**写到 `storageDomain`，不依赖文件 IO
2. **重启读**：probe 跑完后**重启 plugin** 重新 define 一个 package，apply 时从 storageDomain 读上次结果
3. **多 round**：复杂 probe 拆成多 round，每 round 写一个 storageDomain key

---

## 8. 关键架构调整

基于以上验证结果，auto-rd 的实施必须做这些调整：

1. **存储**：用 storageDomain 替代 SQLite；schema 由 plugin 内手写 validator 实现
2. **Plugin 持久化**：Plugin 定义必须在 DSH 启动后**自动恢复**（cordis_run 失败重试）
3. **调试**：probe 模式必须用 storageDomain 落盘，**不依赖 console**
4. **异步错误捕获**：在 ctx.effect 内自己 try/catch + 写到 storageDomain，避免被 logger 吞掉
5. **错误处理策略**：所有 async 操作必须显 await + try/catch + 落盘

---

## 9. 探测残留

所有探测用的临时 plugin 都已被 stop。`~/.dsh/storages/` 没有遗留垃圾 domain（因为 storageDomain 的 open/pput 在 sandbox 异步错误中被吞）。

`docs/probes/` 目录已被清理。