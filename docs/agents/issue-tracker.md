# Issue tracker:GitHub

本仓库的议题与规格记录为 GitHub issue。所有操作使用 `gh` CLI。

## 约定

- **创建 issue**:`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取 issue**:`gh issue view <number> --comments`,用 `jq` 过滤评论,同时取回 label。
- **列出 issue**:`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,按需加上 `--label` 与 `--state` 过滤。
- **评论 issue**:`gh issue comment <number> --body "..."`
- **增删 label**:`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**:`gh issue close <number> --comment "..."`

仓库信息从 `git remote -v` 推断;在克隆目录内运行时 `gh` 会自动识别。

## 把 pull request 作为 triage 入口

**PR 作为需求入口:no。** _(如果本仓库把外部 PR 视为需求提议,改为 `yes`;`/triage` 会读取该开关。)_

设为 `yes` 时,PR 与 issue 走同一套 label 和状态,使用对应的 `gh pr` 命令:

- **读取 PR**:`gh pr view <number> --comments`,diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**:`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`,然后只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的项(丢弃 `OWNER`/`MEMBER`/`COLLABORATOR`)。
- **评论 / 打标 / 关闭**:`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 中 issue 与 PR 共用一个编号空间,因此单独的 `#42` 可能是任一种:先用 `gh pr view 42` 解析,失败再退回 `gh issue view 42`。

## 当技能说「发布到 issue tracker」

创建一个 GitHub issue。

## 当技能说「取回相关 ticket」

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

由 `/wayfinder` 使用。**map** 是一个 issue,其**子** issue 作为 ticket。

- **Map**:一个打上 `wayfinder:map` label 的 issue,正文包含 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **子 ticket**:作为 GitHub sub-issue 关联到 map 的 issue(对 sub-issues 端点调用 `gh api`)。若未启用 sub-issues,则把子项加入 map 正文的任务列表,并在子项正文顶部写 `Part of #<map>`。Label:`wayfinder:<type>`(`research`/`prototype`/`grilling`/`task`)。一旦被领取,ticket 指派给推进的开发者。
- **阻塞关系**:使用 GitHub 的**原生 issue dependencies**,这是规范且在 UI 中可见的表示。添加一条边:`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`,其中 `<blocker-db-id>` 是阻塞项的数字**数据库 id**(`gh api repos/<owner>/<repo>/issues/<n> --jq .id`,**不是** `#number` 也不是 `node_id`)。GitHub 通过 `issue_dependencies_summary.blocked_by` 报告(仅统计未关闭的阻塞项,即实时闸门)。若 dependencies 不可用,退回到在子项正文顶部写一行 `Blocked by: #<n>, #<n>`。当所有阻塞项都关闭时,ticket 解除阻塞。
- **前沿查询**:列出 map 的未关闭子项(`gh issue list --state open`,限定在 map 的 sub-issues / 任务列表内),剔除存在未关闭阻塞项(`issue_dependencies_summary.blocked_by > 0`,或 `Blocked by` 行中仍有未关闭 issue)或已有 assignee 的项;按 map 中的顺序取第一个。
- **领取**:`gh issue edit <n> --add-assignee @me`,是该 session 的第一次写操作。
- **结案**:`gh issue comment <n> --body "<answer>"`,然后 `gh issue close <n>`,再把上下文指针(gist + 链接)追加到 map 的 Decisions-so-far。
