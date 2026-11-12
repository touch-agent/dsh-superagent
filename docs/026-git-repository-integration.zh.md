# Git 仓库集成：把源码类产出交给 git 管理的可行方案

> 状态：**调研（2026-11-12），只评估、不实现**。本文不新增 schema、不改运行时、不改默认行为；结论中的「可做」是落地路径判断，不是已实现能力。
>
> 基线：`touch-agent/dsh-superagent` 的 `main@e7bc281`；现有空间与租约实现以工作树中的代码和 [013](013-workspace-model.zh.md) 为准。
>
> 输入：2026-11-12 的调研请求；[013 工作空间模型](013-workspace-model.zh.md)、[006 部署](006-deployment.md)、[021 任务优先界面](021-ux-redesign.zh.md)、[022 DSH 上游扩展点](022-harness-extension-requests.zh.md)、[012 平台演进](012-platform-evolution.zh.md)、[001 领域模型](001-domain.md)。
>
> 一句话结论：**推荐「A + C」组合——每工单一个从 Source 远端仓派生的 worktree、一条唯一分支、一个由人评审/合并的 PR（auto-merge 仅在 Delivery requirements 允许时；本部署禁止）；Source 远端是唯一权威，产品只做仓库绑定、生命周期、回收和审计，不自己托管 git 仓库。**

## 0. 结论摘要

| # | 结论 | 影响 |
| --- | --- | --- |
| 1 | **Git 是源码类产出的唯一历史与合并权威**。产品不应成为第二套 SCM，也不应在 PR 之外再造「已合并」的事实。 | 排除「产品内部维护一份权威历史」的默认解释。 |
| 2 | **推荐 A + C**：A（每工单 worktree + 分支 + PR）负责执行隔离与本地可验证；C（只对接 Source 配置的远端仓）负责权威与授权边界。两者不是二选一，A 是执行形态，C 是事实来源。 | 与现有部署做法连续，不需要推翻 `Execution.directory`。 |
| 3 | **B（产品内置 bare repo）不作为 v1 方案**。产品要同时承担对象存储、GC、配额、备份、密钥托管和「本地镜像与远端谁为准」的对账；收益主要是离线与集中缓存，成本却落在插件边界之外。 | B 最多作为部署侧 mirror（产品不拥有、不写入），不能成为默认权威。 |
| 4 | **C 只作为完整方案时不够**。「临时检出」是 A 去掉本地基线缓存；「API 直写」没有工作目录，无法跑构建/测试，也无法维持 `Execution.directory` 与 `space_lease` 的语义。 | C1 可作降级；C2 只适合纯文本/非可执行产出，不适合源码。 |
| 5 | **D（与宿主 workspace 绑定的子仓/嵌套）在 DSH `0.2.1-rc.5` 上不具备落地条件**。每个 Ticket 目录今天已被 `workspaceRegistry.create` 注册为宿主 workspace（D1），但宿主只有注册：`delete` 保留目录、`rename` 只改标题，没有 git provider、目录创建删除/写租约；D2（宿主拥有仓库生命周期）才需要新契约，D1 没有产品收益。嵌套仓仍有父/子清理顺序风险。 | D 留到宿主 git provider/目录生命周期契约出现之后；[012 §6.6](012-platform-evolution.zh.md) 的 workspace handle 不等于 git provider。 |
| 6 | **现状的四个缺口是产品级缺口，不是文档缺口**：谁有提交权、并发写同一分支/同一仓、结束后回收、git 动作的审计链。现有 `space_lease` 只解决「同一目录同一时刻一个写者」，不解决另外三个。 | 需要仓库绑定、分支/PR 不变量、回收策略和审计记录，不能只靠 prepare 脚本。 |
| 7 | **P1 可先在插件内做「观察与护栏」，但要缩小范围**：`owner/name` 从 `deployment.repository` 取，默认分支/clone 路径从 git 派生或显式配置；校验分支占用与凭据卫生；审计只做结束快照（不持久化、不记录每次 push）；提供 GC dry-run 和 E2 只读视图；不自动删任何东西。P1 不改 DB schema，但可能需要 settings key/API 字段。 | 不改 DB schema，也能先回答「这个工单在哪个仓、哪条分支、哪个 PR」；设置/API 契约变更要单独列出。 |
| 8 | **P2 才需要持久化与操作**：仓库绑定、push 时间线、GC 操作、配额与保留策略需要 schema/API；这些仍在本仓库（kernel + runtime + panel）内。 | 不能把 P2 说成「宿主缺口」；它是产品自己的生命周期工作。 |
| 9 | **P3 才需要宿主/部署支持**：OS 级隔离与可轮换的凭据主体（部署）、宿主 git provider/目录生命周期/写租约、workspace 列表投影、宿主级配额/密钥托管。 | 与 [022 §2.3](022-harness-extension-requests.zh.md) 的「列表投影需要宿主」和 [006](006-deployment.md) 的「专用 OS 账户」一致。 |
| 10 | **本文没有跑 PoC**。第 6 节给的是可执行步骤、指标和失败判据；在这些判据通过前，只能称「条件可行」，不能称「已验证可落地」。 | 独立 review 的结论见 PR review 评论，不把提案当实现。 |

**明确不做**（本文边界）：

- 不在产品内实现 git 服务端、对象存储、打包协议、HA 或备份；不把 bare repo 当默认权威。
- 不直接 merge；auto-merge 仅在 Delivery requirements 明确允许时开启（默认关闭，本部署禁止）；不自动 rebase 到 `main`、不自动强推；人和 GitHub 分支保护仍是合并门。
- 不新增 `WorkspaceRef`/`space` 注册表，不把仓库绑定做成第二个空间 locator；`Execution.directory` 仍是唯一 locator（[013 §0](013-workspace-model.zh.md)）。
- 不把源码产出塞进 Deliverable 的预览链当替代品；Deliverable 是「一个修订的交付证据」，PR/commit 是它的开发 profile 载体（[001](001-domain.md)、[021 §3.4](021-ux-redesign.zh.md)）。
- 本文不实现任何 P1/P2 项；它们是后续任务的输入。

## 1. 现状盘点

### 1.1 空间、`space_lease` 与 `Execution.directory`

[013](013-workspace-model.zh.md) 已经确定：

- **`Execution.directory` 是空间的唯一 locator**；不建 `WorkspaceRef`、不建 `space` 注册表。空间类型、分支、持有者、状态都从 `Execution`、Assignment、Session 与租约派生（013 §0 结论 2）。
- **一个 tracked Ticket 默认一个可写空间**；同一 Ticket 的多次 Assignment 复用它，子 Ticket 默认有自己的空间（013 §0 结论 3、§4.3）。
- **只做写租约**。同一空间同一时刻至多一个写租约（同一 Ticket 可重入）；**租约是协调语义，不是安全隔离**；worker 仍可用绝对路径读写别的目录（013 §5.2）。
- **prepare 前预留、prepare 后校验并激活、Ticket 结束释放**；prepare 失败释放；不做 TTL/心跳，重启后按 `processEpoch` 与活跃 Session 判 stale（013 §4.2、§4.3）。
- **Phase 2 不自动回收、不复用**；`checkout` 保留 7 天、`scratch` 保留 1 天、`project` 长期、`root` 不回收，是 Phase 3 的设计，尚未实现（013 §4.4）。
- **不保证目录级安全隔离**；子 Ticket 的 shell guard 只是工具级限制（013 §1.3、§5.2）。

实现证据：`packages/dsh/src/executor/dsh.ts` 的 `prepareDirectory`、`verifyCheckout`、`verifySpace`；`packages/dsh/src/app/spaces.ts` 的 `SpaceLeases`；`docs/003` 的「Preparing a Ticket directory」。`space_lease` 只有 `locator_key`、holder（ticket/assignment/session）、`processEpoch`、`epoch`、state 和时间，没有 branch、PR、commit 字段。

**这对 git 集成的直接含义**：租约能保证「同一个工作目录不被两个活工单同时写」，但不能保证「同一条远程分支不被两个目录同时推」；它也不记录「这个目录对应哪个仓库的哪条分支」。后者需要仓库绑定，而不是空间绑定。

### 1.2 每工单 worktree、分支与 PR（worker 现状做法）

部署的 prepare 约定（[006 §Execution](006-deployment.md)）是：

```sh
git -C /home/me/src/widgets fetch --no-tags \
  "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" \
  "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&
git -C /home/me/src/widgets worktree add \
  -b "agent/$DSH_SUPERAGENT_NAME" \
  "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
```

其中 `DSH_SUPERAGENT_NAME = <worktree 名>-<ticket id 前 12 位>`，所以分支名就是 `agent/<worktree>-<id>`；`DSH_SUPERAGENT_DIR` 是 `Execution.directory`。执行器在目录不存在时跑 prepare，超时 10 分钟；已存在目录一律视为已准备（[013 §1.2](013-workspace-model.zh.md)、[003](003-execution.md)）。

PR 归属不是显式记录，而是约定：

- 分支最后一段必须等于 Ticket 短名（`github-pull.ts` 的 `ticketBranch` / `claimPull`）；
- 一个 PR 同时只能绑定一个 open Ticket；一个 Ticket 已有另一个 open PR 时，新的 PR 不会自动绑定（显式报告仍可绑定第二个）；
- agent 账号开的 PR 自动关联到该分支上唯一的 open Ticket；
- 子 Ticket 被 shell guard 阻止常见 `gh pr/issue/api/repo/release/workflow/auth`、`git push/remote/fetch/clone`、`curl`/`wget`/`ssh` 等；但正则不匹配 `git -C <dir> push`，也不拦脚本包装，所以这是**工具级限制，不是不变量**。子 Ticket 只做本地工作并报告，父 owner 负责推送、开 PR、最终上报（[013 §1.3](013-workspace-model.zh.md)、`packages/dsh/src/app/sessions.ts` 的 `childShellReason`）；
- agent 不直接 merge；auto-merge 仅在 Delivery requirements 允许时开启（默认关闭，本部署禁止）。PR 仍是合并门。

这条链路已经能工作，但它是**部署约定 + 提示词纪律**，不是产品级契约：prepare 命令由部署方提供，分支名由部署方拼，PR 关联靠分支名推断，产品不记录 commit、base、remote 和「这条分支属于哪个仓库」。

### 1.3 凭据、提交身份与「谁有提交权」

- **GitHub 凭据**：部署用一个 agent GitHub 账号，`gh` 通过 `worker-bin/gh` shim 固定为该账号；`<stateDir>/worker-gitconfig` 把 `credential.helper` 指向 `gh auth git-credential`，重写 SSH 为 HTTPS，并设置 LFS filter；`GH_TOKEN`/`GITHUB_TOKEN` 被移除，`GIT_ASKPASS` 置空，git 不提示；setup 校验 helper（[006 §Setup checks](006-deployment.md)、`packages/dsh/src/infra/environment.ts`）。
- **提交身份**：`worker-gitconfig` 设置 `user.useConfigOnly = true`，不写 `user.name`/`user.email`；所以 git 不会从操作者 OS 用户猜身份。worker 提示词要求按交付要求写作者，否则用 `$DSH_SUPERAGENT_GITHUB_ACCOUNT` 和 `$DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL`（`packages/dsh/prompts/worker.md`）。**这是提示词级约束，不是代码校验**。
- **提交/推送权**：agent 账号对源仓库有写权限；所有 root worker 共享这一凭据；`space_lease` 不是权限；`blockedCommands` 只按命令名拦截，不分析 `gh` 子命令或 git 子命令；`gh pr merge` 没有被运行时结构性禁止。仓库默认提示词允许按 Delivery requirements 开启 auto-merge（`packages/dsh/prompts/team/delivery.md`），本部署的 Delivery requirements 则禁止；真正阻止自合并的仍是提示词、评审文化和 GitHub 分支保护/权限。
- **凭据卫生检查**：`verifyDirectory` 只检查 Ticket 目录里 local/worktree scope 的 `credential.*` 与 `http.*extraheader`，不检查 `core.hooksPath`、`url.*.insteadOf`、`include.path`、别的仓库、操作者 home、`gh` 配置或进程环境。worker 以操作者 OS 用户运行，`danger-full-access`，能读操作者 home（[006 §Permissions and isolation](006-deployment.md)）。专用 OS 账户是部署级缓解，不是插件能力。

| 主体 | 实际能做什么 | 边界/证据 |
| --- | --- | --- |
| 人评审者 | 评审、合并/关闭 PR，决定是否返工 | GitHub 权限与分支保护；agent 不应代合并。 |
| agent GitHub 账号 | 对源仓库 push 分支、开 PR；技术上也可调用 merge API；按 Delivery requirements 可开 auto-merge | 006 给账号写权限；运行时未禁止 `gh pr merge`；本部署禁止 auto-merge，仓库默认提示词则允许按条件开启。 |
| root worker 进程 | 在 Ticket 目录读写、`git commit/push`、`gh pr create`；也可 `cd` 到别处 | `danger-full-access` + 共享凭据；`space_lease` 不是权限。 |
| 子 Ticket worker | 本地编辑/commit，向父 owner 报告 | `childShellReason` 阻止常见 push/gh，但 `git -C`/脚本包装可绕过；工具级 guard，非不变量。 |
| 操作者 OS 用户 | 读 home、gh 配置、别的仓库 | 006 的专用 OS 账户是部署级边界；插件无法隔离。 |
| 产品运行时 | 记录 Ticket→PR 绑定、目录/租约、报告 | 不拦截每条 git 命令；git 动作不在 action ledger。 |

### 1.4 产出物、Deliverable 与 git 的关系

- [001](001-domain.md) 的 Deliverable 是「一个 artifact + 一个 revision + 评审用的 preview + 可判定的验收标准」；开发 profile 的交付物就是 diff/PR，验收是 `PR merged`（[012 §7](012-platform-evolution.zh.md)）。
- [021 §3.4](021-ux-redesign.zh.md) 明确：文件页的「任务文件」是按任务归档的交付物，**不是执行空间**；执行空间只在任务详情高级区或 E2/E3 出现，不成为导航层级。
- [012 §7.2](012-platform-evolution.zh.md) 给开发 profile 的保留策略是「30–90 天（代码在 git 里）」，audit 永久；这与「worktree/分支可以回收，但 PR/commit/审计骨架要留下」一致。

**因此 git 集成的产品语义应是**：工作目录和分支是**可回收的执行痕迹**；PR/commit 是**已交付的源码修订**；Ticket/PR 绑定与审计是**不可丢的骨架**。现状把三者混在「目录 + 分支名约定」里，没有分开。

### 1.5 现状缺口

| # | 缺口 | 证据 | 后果 |
| --- | --- | --- | --- |
| G1 | **提交权没有产品级主体与范围**：agent 账号有仓写权限，所有 root worker 共享；`commit` action level 不是对 `git commit` 的运行时闸门；`gh pr merge` 未被结构性禁止。 | [006](006-deployment.md) 的账号模型；`environment.ts` 的 shim 只做转发；`action.ts` 的 `commit` 是概念等级。 | 越权提交/合并只能靠提示词、分支保护和 OS 账户；多仓库时范围更模糊。 |
| G2 | **并发只覆盖目录，不覆盖分支/远端**：`space_lease` 按 locator；`verifyCheckout` 只查同一个 clone 的 `git worktree list`；不同 clone 的同名分支、远端 push 竞态、PR 与 merge 竞态都不在租约内。 | `spaces.ts` 的 `locatorKey`；`dsh.ts` 的 `verifyCheckout`；PR 绑定只在 open PR 层去重。 | 两个工单理论上可写同名远程分支；force-push 可覆盖；共享 clone 的 fetch/prune/gc 可能互相干扰。 |
| G3 | **结束不回收**：Ticket 结束只释放租约，不删目录、不删分支、不 prune worktree、不 gc 对象；013 的 Phase 3 保留策略未实现。 | 013 §4.4；`SpaceLeases.release` 只更新行；`dsh.ts` 的结束路径。 | worktree、分支、构建产物、LFS 缓存和对象库持续增长；旧目录可能被误当新空间。 |
| G4 | **git 动作没有工单级审计链**：action ledger 记录 orchestrator 动作，worker 的 `git commit/push` 是 shell；产品只记录 PR follow，不记录 base SHA、head SHA、push 结果、force-push、脏状态、GC 决定。 | `packages/dsh/src/executor/dsh.ts`；`github-pull.ts`；`tests` 中的 action/trace 范围。 | 回答不了「这个工单到底推了哪些 commit、有没有本地未推的、分支何时被删」；force-push/关闭 PR 会留下断链。 |
| G5 | **仓库绑定是隐式的**：产品只知道 `DSH_SUPERAGENT_GITHUB_REPOSITORY` 和 `Execution.directory`；prepare 可以 checkout 别的仓库，worker 也可以 `cd` 到别处；没有 `repo` 字段或绑定记录。 | 013 §1.5、P11；`execution-environment.ts` 的变量；`dsh.ts` 只校验目录像 git worktree。 | 「这个空间属于哪个仓、基于哪个 base、对应哪条分支」只能从部署脚本和目录猜；跨仓交付靠人工。 |
| G6 | **身份/署名是提示词级**：`user.useConfigOnly=true` 只保证「必须显式设置」，不保证作者是 agent；人类 co-author trailer 靠人工。 | `environment.ts` 的 worker-gitconfig；worker prompt。 | commit 作者可被任意设置；评审 credit 与工单的对应关系不可机器验证。 |
| G7 | **离线/基线漂移没有契约**：本地 clone 是缓存；base 可能过期；fetch/push/PR 需要网络。产品没有「离线提交、稍后推送」的队列或状态。 | 006 的 prepare；013 §1.2；当前没有 sync 任务。 | 断网时工作可以继续但交付不可见；重连后需要人工 rebase/重推。 |
| G8 | **配额与特殊仓库形态未覆盖**：没有 per-ticket 磁盘配额；没有 LFS/submodule 的 prepare 约定；对象库与 worktree 的成本没有计量。 | 006 要求按需安装 `git-lfs`；013 没有配额项。 | 大仓/LFS 仓库可能 prepare 超时或磁盘爆；GC 决策缺少输入。 |

**现状里应当保留的决定**：git 是权威（不造第二套历史）；PR 是合并门（agent 不合并）；一工单一个可写空间（不并发写同一目录）；`Execution.directory` 是唯一 locator（不新增空间注册表）；子 Ticket 不直接推远端（父 owner 收口）。这些与本文推荐一致，不能为了「内置仓库」而推翻。

## 2. 设计约束与不变量

| # | 不变量 | 理由/来源 |
| --- | --- | --- |
| I1 | 源码产出的历史与合并事实以 git 远端 + PR 为准；产品不产生第二套「已合并」。 | GitHub 的 merge/CI/分支保护是现有验收门（[012](012-platform-evolution.zh.md)）。 |
| I2 | 每个 Source 只对接它配置的远端仓；跨仓任务拆子 Ticket，不自动改绑。 | 013 §0 结论 7、§3.2；避免「一个空间两个仓」。 |
| I3 | `Execution.directory` 是唯一空间 locator；仓库绑定是它的属性/派生，不是第二个 locator。 | 013 §0 结论 2。 |
| I4 | 同一目录同一时刻一个写者；同一 Ticket 可重入；不同 Ticket 默认不同目录。 | 013 §4.3、§5.1。 |
| I5 | （目标不变量）一条 Ticket 分支、一个 open PR；PR base 显式记录（默认是默认分支，栈式 PR 不在 v1）；agent 不直接 merge，auto-merge 仅按 Delivery requirements（默认关闭，本部署禁止）。 | 现状只做自动绑定去重；显式报告仍可绑定第二个 PR；仓库默认提示词可开 auto-merge，故作为目标而非现状。 |
| I6 | 凭据只在部署提供的 shim/git 配置里；不写入仓库、remote URL、日志、指标或提示词。 | 006 的凭据卫生；013 不把租约当授权。 |
| I7 | 失败不丢工作：prepare/verify/push 失败保留可恢复证据；脏工作树不自动删除。 | 013 §4.4 的脏空间规则。 |
| I8 | 离线只承诺「本地可读/可提交」；推送、PR、评审、合并需要网络，不承诺离线交付。 | 现状与 006 的部署模型。 |
| I9 | 不把源码产出塞进 Deliverable preview 作为替代；PR/commit 是开发 profile 的交付物，Deliverable 负责验收证据。 | 001、021 §3.4、012 §7。 |

**可接受的变更**（后续任务，不是本文）：

- 增加只读的 `repo` 绑定投影（先派生，后持久化）；不新增空间类型。
- 增加 `git` 审计事件/表（P2）；不改变 Action/Approval/Acceptance 语义。
- 增加 GC 操作 API 与配额（P2）；默认只 dry-run，删除需要显式动作。

## 3. 候选方案对比

### 3.0 共同的比较前提

- 一个 Source 配置一个仓库 `owner/name`，一个默认分支（通常 `main`），一个 agent 账号。
- 源码产出必须经过 commit → push → PR；agent 不直接 merge；auto-merge 按 Delivery requirements（默认关闭，本部署禁止）。
- 本地执行要有目录，因为 `Execution.directory`、Session cwd、`space_lease` 都以目录为锚；不能假设一个「无目录」的交付路径。
- 比较的是**产品默认形态**，不是「理论上能不能用脚本拼出来」。

### 3.1 方案 A：每工单 worktree + 分支 + PR

**机制**：部署维护一个本地基线 clone（或 bare mirror），每个 Ticket 用 `git worktree add -b agent/<name>` 得到独立工作树；worker 在树里改、commit、push 到 Source 远端同名分支；`gh pr create` 开 PR；PR 由人批准/合并（或按 Delivery requirements 的 auto-merge）。产品用 `Execution.directory` 记录树，用分支最后一段关联 Ticket。

| 维度 | 结论 | 说明 |
| --- | --- | --- |
| 并发隔离 | **强（目录级，非安全隔离）** | 每工单一棵树、一条分支，`space_lease` 保证同目录一个写者；共享 clone 的对象库、worktree 元数据、`.git/config`、hooks、`info/attributes`、refs、alternates 都是共享面。不同 clone 的同名分支、远端 push 竞态不在租约内。 |
| 冲突与 rebase 归属 | **工单 worker** | 同一分支内的冲突由该 Ticket 的 worker 解决；跨工单冲突在 PR 合并时由后合并者 rebase/解决；子 Ticket 由父 owner 收口；人不自动代做 rebase。 |
| 凭据存放轮换 | **现有 shim** | agent 账号 + `worker-gitconfig` + `gh` shim；轮换 = 重新 `gh auth login`/换账号；没有 per-ticket token；范围是账号对所有可写仓的权限。 |
| 离线可用性 | **中** | clone 在本地时可读、可 commit、可 rebase；fetch/push/PR/评审需要网络；没有离线队列。 |
| 配额与 GC | **弱（默认没有）** | 需要新增 worktree/分支/对象的保留与清理；worktree 共享对象库，单树主要是工作文件 + 构建产物；不清理会线性增长。 |
| 审计链 | **中** | PR + commit + 分支名 + GitHub merge 是外部审计链；产品只绑定 PR，不记录 base/head/force-push/脏状态；本地 reflog 不是持久审计。 |
| 与 `space_lease` 生命周期 | **天然对齐** | 目录就是 worktree；prepare 前预留、校验后激活、结束释放；分支/PR 比租约活得久，GC 必须在租约释放后另判 PR 状态。 |
| 失败回滚 | **可做但要显式** | prepare 失败释放租约；push 拒绝不 force，fetch/rebase；PR 失败保留分支；回滚分支/目录用 `git worktree remove` + `git branch -d`；脏树先导出 patch。 |
| 插件边界影响 | **小** | 完全在部署 + 插件内：prepare 命令、shim、PR 绑定、面板都是现有能力；不需要宿主改 git 或新增 slot。 |

**判断**：这是今天就能跑、且不新增 SCM 的形态；缺的是产品化（绑定、回收、审计），不是机制。它是推荐方案的执行层。

### 3.2 方案 B：产品内置 bare repo

**机制**：产品在 `<stateDir>` 下创建并维护 bare repo（`git init --bare`），从 Source 远端 fetch；每个 Ticket 从它 `worktree add`；提交先落到内置 repo，再 push 到 Source 远端（或在内置 repo 就是唯一权威时直接交付）。产品负责 refs、对象、GC、配额、备份和（可选的）远端镜像。

| 维度 | 结论 | 说明 |
| --- | --- | --- |
| 并发隔离 | **强，但集中** | 产品可对同一个 bare repo 串行化 `worktree add`、ref 更新和 fetch；每工单仍是一棵树。代价是单仓锁成为全局瓶颈，且要处理 `git worktree` 元数据与并发 fetch/prune。 |
| 冲突与 rebase 归属 | **产品 + worker** | 产品可强制「先 rebase 再合」；但冲突内容仍要 worker/人解决。若内置 repo 是权威，rebase 责任从 GitHub 转到产品，产品要自己实现合并队列与回滚。 |
| 凭据存放轮换 | **产品托管密钥** | fetch/push 需要产品持有远端凭据；token 落在 stateDir/keyring/KMS，需要加密、轮换、审计、最小权限。比 A 多一个高价值秘密面。 |
| 离线可用性 | **强** | 本地 bare repo 有完整对象时可读/可提交/可看历史；远端不可达时先落本地，稍后 push；镜像可能过期，重连要处理分叉。 |
| 配额与 GC | **产品全责** | 要按仓库/租户/Ticket 计量对象、worktree、LFS 缓存；实现 `gc`、`prune`、过期 ref、备份、`fsck`；磁盘翻倍（内置 + worktree）与损坏恢复都是产品责任。 |
| 审计链 | **强（本地）但要对账** | 产品可记录每次 ref 更新、commit、fetch/push；但内置 repo 与 Source 远端可能分叉，需要「谁是权威」的对账和冲突告警。两套历史会增加解释成本。 |
| 与 `space_lease` 生命周期 | **需要扩展** | worktree 仍可按目录租；但 bare repo 的生命周期独立于 Ticket，GC/备份/迁移不能只按租约释放；要新增仓库级锁与生命周期。 |
| 失败回滚 | **强但风险高** | 产品可 reset/delete refs、恢复备份；一旦内置权威库损坏，影响所有 Ticket；需要事务/备份/`fsck` 演练，比 A 的「删一棵树」重得多。 |
| 插件边界影响 | **大** | 产品变成 git 托管方：对象存储、GC、配额、密钥、备份、HA 都进来；这与「可替换边界」和插件定位冲突。若要镜像远端，还要处理 PR/CI/分支保护在远端、历史在本地的不一致。 |

**判断**：B 的收益是离线与集中缓存，但这些收益可以用「部署侧本地 mirror」拿到，不必让产品托管权威。**v1 拒绝 B 作为权威**；最多允许部署把 A 的基线 clone 做成由部署维护、产品只读使用的 mirror，产品不拥有、不写入它。

### 3.3 方案 C：只对接 Source 配置的远端仓

**机制**：产品不维护长期本地基线仓，只把 Source 配置的 `owner/name` 当唯一仓库端点。有两种子形态：

- **C1 临时检出**：每个 Ticket 临时 clone/fetch（可 shallow/filter），在临时目录工作，push 后删除；不保留共享 clone。
- **C2 API 直写**：不检出，用 GitHub Git Data API（blob/tree/commit/ref）和 PR API 直接生成提交与 PR；agent 产出文件内容，产品负责建树。

| 维度 | C1 临时检出 | C2 API 直写 |
| --- | --- | --- |
| 并发隔离 | 每 Ticket 独立 clone，隔离强；但并发 clone 的网络/磁盘成本高。 | 无本地树；GitHub Git Data API 没有 compare-and-swap；ref 创建靠「已存在即失败」，更新靠非快进拒绝；API 限流与远端竞态仍在。 |
| 冲突与 rebase 归属 | 同 A：worker 在临时树里解决；push/PR 失败要重 clone。 | 无法本地 rebase/解决冲突；冲突只能重新检出或人工处理；不适合多方并发改同一文件。 |
| 凭据存放轮换 | 同 A：gh/git credential helper。 | 只要 gh token；但每次 API 调用都带 token，日志/代理面更大；无 git credential helper 这一层。 |
| 离线可用性 | **差**：没有本地基线缓存，断网即无法开始。 | **无**：完全依赖 GitHub API。 |
| 配额与 GC | 临时目录可删，GC 简单；但每次全量/过滤 clone 的磁盘峰值与网络配额高。 | 本地无对象；受 GitHub 仓库配额/API 限流约束；无本地 GC 问题。 |
| 审计链 | 同 A 的 PR/commit；临时目录删除后本地证据少。 | API 响应 + PR；没有本地 reflog；树/commit 的中间对象不可见，排障更难。 |
| 与 `space_lease` 生命周期 | 临时目录仍是 locator，可租；prepare 变成 clone，超时/失败语义要重写。 | **没有目录**：无法维持 `Execution.directory`、Session cwd、`space_lease` 与「目录即空间」的语义；会把执行模型改成无空间。 |
| 失败回滚 | 删临时目录；已 push 的分支/PR 要单独清。 | 删 ref/PR 容易；但 blob/tree/commit/ref/PR 是多调用、非原子；PR 创建可在 ref 更新后失败，留下无 PR 分支；且无法本地验证构建。 |
| 插件边界影响 | 插件内可做，但把 prepare 从「worktree」改成「clone」，成本更高。 | 插件内可用 gh 做，但破坏「源码产出可本地验证」的前提；不是源码交付的完整方案。 |

**判断**：C1 是 A 的「无缓存」变体，可作为离线/隔离的降级，但不该是默认；C2 只适合纯文本、无需构建/测试的产出，不适合源码。**C 的价值是「Source 远端是唯一权威」这条约束，不是「不要本地目录」。**

### 3.4 方案 D：与宿主 workspace 绑定的子仓/嵌套

**机制**：不自己管理 worktree，而是把仓库做成 DSH 宿主 workspace 的子目录/嵌套仓库（或让 workspace 本身是 git 仓，Ticket 在 `subdir` 工作）；设想由宿主的工作区注册/归档/删除生命周期承载目录；产品只记录「Ticket → 宿主 workspace」。现状只有注册，见下。

需要把 D 拆成两层，否则会把「注册」当成「生命周期」：

- **D1（今天已有，但没有产品收益）**：`Sessions.ensure` 在创建 worker Session 时调用 `workspaceRegistry.create(cwd)`（`packages/dsh/src/app/sessions.ts`），所以每个 Ticket 目录今天已经是宿主 workspace；`WorkspaceRegistry.create` 要求目录已存在，只注册元数据，不创建目录。它不提供 git 绑定、写租约或回收。
- **D2（未实现，才是 D 的提案）**：宿主拥有目录的创建/删除/移动，并提供 git provider/写租约/回收；当前 `WorkspaceRegistry.delete` 明确保留目录和 session log，`rename` 只改标题、不改 path，也没有 git provider 或租约钩子。D2 需要新的宿主契约。

| 维度 | 结论 | 说明 |
| --- | --- | --- |
| 并发隔离 | **弱** | 宿主 workspace 列表没有写租约；D1 注册后仍靠产品的 `space_lease`。D2 若由宿主管理目录，还要把「一个目录一个写者」搬进宿主，否则是两套协调。 |
| 冲突与 rebase 归属 | **不清** | 宿主不知道 git；嵌套仓的父仓/子仓冲突、父目录清理顺序仍要 worker 处理。宿主 `delete` 保留目录，不会级联删仓，但也没有 git 级清理顺序。 |
| 凭据存放轮换 | **继承/更复杂** | 嵌套仓会继承父仓/宿主配置；产品要额外保证父仓和子仓都没有 `credential.*`/`http.*extraheader`，还要检查 `core.hooksPath`/`url.*.insteadOf`/`include.path`；凭据仍是 agent 账号，轮换点更多。 |
| 离线可用性 | **取决于宿主** | 本地 workspace 可离线；如果宿主将来是云 workspace/provider（012 §6.6），离线就不成立。 |
| 配额与 GC | **两套生命周期** | 宿主管 workspace 注册/归档/删除，产品管 git worktree/branch/objects；宿主 `delete` 保留目录，所以产品仍要单独 GC；没有统一配额。 |
| 审计链 | **分裂** | 宿主 Session/workspace 审计与 git 审计是两条链；Ticket → workspace → commit 的映射要跨系统对账。 |
| 与 `space_lease` 生命周期 | **冲突（身份层）** | 宿主 workspace 是第二个身份；租约仍按 `Execution.directory`。D1 不移动/改名目录，所以不会直接改 locator；但若把宿主 workspace 当空间，就会违反 013 §0 结论 2。D2 若移动目录，才需要新的 locator/迁移契约。 |
| 失败回滚 | **跨系统** | 宿主 `delete` 保留目录（不会连带删仓），但宿主没有 git 回滚/patch 导出；产品仍需自己的回滚与对账。D2 若真的删除目录，风险才升级。 |
| 插件边界影响 | **D1 小，D2 需宿主** | D1 已由 `Sessions.ensure` 完成，只提供注册/可见性；D2 需要宿主 git provider、目录创建删除/写租约；列表投影/过滤只影响 E2。DSH `0.2.1-rc.5` 没有 D2 的组合。 |

**判断**：D1 今天已经存在，但它只是「把已有 worktree 注册成宿主 workspace」，不解决 git 生命周期，产品收益接近零；D2 才是「宿主拥有仓库目录」的提案，需要新宿主契约。D 不是 A 的更省事替代；留到宿主 git provider/目录生命周期出现之后重评。

### 3.5 横向对比

| 维度 | A worktree+PR | B 内置 bare | C1 临时检出 | C2 API 直写 | D 宿主嵌套 |
| --- | --- | --- | --- | --- | --- |
| 并发隔离 | 强（协调，非沙箱） | 强（集中锁） | 强（每票独立） | 中（ref 乐观） | 弱（宿主无租约） |
| 冲突/rebase 归属 | worker | 产品+worker | worker | 无法本地 | 不清 |
| 凭据 | 现有 shim | 产品托管 | 现有 shim | gh token | 继承/更复杂 |
| 离线 | 中 | 强 | 差 | 无 | 取决于宿主 |
| 配额/GC | 无，需补 | 产品全责 | 临时目录简单 | 无本地 | 两套 |
| 审计链 | PR+commit | 本地+PR 对账 | PR+commit | API+PR | 分裂 |
| 与 lease | 对齐 | 需扩展 | 对齐 | 无目录 | 冲突 |
| 失败回滚 | 可做 | 强但高风险 | 可做 | 无 CAS、非原子 | 跨系统 |
| 插件边界 | 小 | 大 | 小 | 小但破坏执行 | 需宿主 |

**排序**：A（执行）+ C（权威约束）> C1（降级）> B（缓存/离线，不作权威）> D（等宿主）> C2（不适用于源码）。

## 4. 推荐方案

### 4.1 形态：Source 远端为唯一权威的每工单 worktree + 分支 + PR（A + C）

```text
Source 配置（owner/name、默认分支、agent 账号）
        │
        ├─ 部署本地基线 clone / mirror（部署维护，产品不写；缓存，不是权威）
        │        │
        │        └─ git worktree add -b agent/<name>  <Execution.directory>
        │
        └─ 每个 Ticket：
             1. prepare 创建 worktree + 唯一分支
             2. space_lease 预留 → prepare → 校验 → 激活
             3. worker 改代码、commit（agent 作者）、push 同名分支
             4. gh pr create；PR 绑定 Ticket（分支最后一段）
             5. 人评审/批准；merge 由人完成，或按 Delivery requirements 的 auto-merge（默认关闭，本部署禁止）；CI/分支保护是门
             6. Ticket 结束 → 释放租约；保留 worktree/分支到保留期
             7. GC：Ticket 已结束且不可恢复、无 live Session/后台进程、无未关闭 PR、租约已释放且删除前重新取得、保留期到、树干净 → 删树/删分支/记录审计；`git gc` 是仓库级维护，不按 Ticket
```

这不是「新架构」，而是把现有部署约定提升为产品契约：**A 负责执行，C 负责事实与授权边界**。

#### 4.1.1 落地前置（不满足就不能按「可落地」宣称）

这些是运维/产品前置，不是 P1 代码能自动补的；任一项不满足，A+C 只能算「有条件可行」，不能算「可落地」。

| 前置 | 为什么是前置 | 不满足时的处理 |
| --- | --- | --- |
| 一个 Source 一个仓、一个明确默认分支 | A+C 的前提；跨仓不在 v1 | 跨仓拆子 Ticket；不自动改绑。 |
| GitHub 分支保护 + 合并策略（人合并；若允许 auto-merge，需 match-head-commit 与审批） | agent 账号有写/合并能力；提示词不是门 | 先由运维配置分支保护与合并策略；否则不宣称「agent 不会自合并」。 |
| agent 账号最小权限 / 专用 OS 账户 | 所有 root worker 共享凭据；`danger-full-access` | 接受残余风险或先做账户隔离；R1/R2 不能靠插件消除。 |
| 本地基线 clone、`git worktree`、`gh`、网络 | A 的执行与 PR 交付 | 缺任一即无法 prepare 或交付；离线只能本地 commit。 |
| LFS/submodule 的 prepare 支持（若仓库使用） | 否则检出/构建不完整 | 预检并拒绝，或明确不支持。 |
| `maxWorkers` 与磁盘容量足以覆盖并发生效数 | 8 并发不等于 8 槽 | PoC 先配置 `maxWorkers ≥ 8`；否则只测排队，不测并发。 |

### 4.2 为什么是 A + C

1. **与现有代码连续**：`Execution.directory`、`space_lease`、prepare、分支名与 PR 自动绑定都已在（PR base 尚未持久化）；不需要迁移空间模型，不需要第二套 locator。
2. **源码可本地验证**：worker 必须在本地跑测试/构建；C2 没有工作目录，无法证明产出可运行。
3. **GitHub 仍是合并门**：PR、CI、分支保护、人类评审都在远端；产品不复制这些能力。
4. **回收与审计可以增量做**：先读后写、先 dry-run 后删除；不需要先造 bare repo。
5. **插件边界最小**：产品只增加绑定、校验、GC、审计与 E2 视图；不托管对象存储和密钥。

### 4.3 产品需要补的六件事

| # | 能力 | P1（插件内，观察/护栏） | P2（持久化/操作） | 不做的部分 |
| --- | --- | --- | --- | --- |
| 1 | **仓库绑定** | `owner/name` 取 `deployment.repository`；默认分支从 `git symbolic-ref refs/remotes/origin/HEAD` 或 `gh repo view --json defaultBranchRef` 派生，clone 路径从 `git rev-parse --git-common-dir` 派生，或新增显式配置；与 `git rev-parse --show-toplevel`、`remote.origin.url` 对账（URL 归一化：ssh/https、`.git`、大小写）；不匹配即 fail closed。P1 不改 DB schema，但可能改 settings/API 契约。 | 持久化 `ticket → repo/base/branch` 绑定与 base SHA；仍从 `Execution.directory` 派生空间，不建第二 locator。 | 不做 `WorkspaceRef`/`space` 注册表。 |
| 2 | **分支/PR 不变量** | 校验分支名 = `agent/<ticket name>`；校验同 clone 内分支未被其他 worktree 占用；校验 PR base 是声明的 base（默认分支）、head 是 Ticket 分支（`PullSchema` 目前无 base，P1 需 `gh pr view` 或字段扩展）；一个 Ticket 只认一个 open PR。 | 记录 base SHA、head SHA、PR number、merge commit；push 拒绝/force-push 告警；PR 关闭/合并对账。 | 不自动 merge、不自动 rebase、不自动强推。 |
| 3 | **凭据与身份** | 继续用 `worker-gitconfig` + `gh` shim；校验 Ticket 目录无 `credential.*`/`http.*extraheader`/`core.hooksPath`/`url.*.insteadOf`/`include.path`；校验 commit 作者是 agent 或显式声明；日志/指标不出现 token。 | 可选：`gh` shim 拒绝 `auth token`/`pr merge` 等高风险子命令（仅当部署禁止 auto-merge；仍非安全边界）；轮换 runbook。 | 插件不做 OS 级隔离/密钥托管；那是部署/宿主。 |
| 4 | **回收/保留** | GC dry-run：以 013 §4.4 为唯一 predicate，列出可回收的 worktree/分支/本地 ref，标出「可恢复/脏/有未关闭 PR/租约未释放/有 live Session/后台进程」；不删除。 | 删除前重新取得写租约并持仓库级锁；按 head 查 GitHub/`git ls-remote`，不只靠 `follows`；`git worktree remove`、`git worktree prune`、`git branch -d`；`-D` 仅在 tip 可达远端或已存 bundle/patch 时；`git gc` 移到仓库级维护；dirty=tracked+非 ignored untracked，ignored 构建产物单列；失败保留并告警。 | 不自动删脏树；不删有未关闭 PR 的分支；不删审计骨架；不按 Ticket 跑 `git gc`。 |
| 5 | **审计链** | 报告时快照：`git rev-parse HEAD`、`git rev-list --count base..HEAD`、`git ls-remote` 对照、PR head/base/merge（可能扩展 `PullSchema` 或直接 `gh pr view`）；写入 worker 报告 summary 或执行日志（`orchestrator_report` 无结构化 git facts，P1 只能文本检索）。不记录每次 push/force-push，不新增 span kind，不承诺持久查询；P1 不能证明「哪些 push 发生过」。 | 新增 append-only git 审计事件（表或事件流）；可选 `worker-bin/git` 包装记录 argv/前后 HEAD/remote ref（需脱敏，仍非安全边界）；记录 force-push/关闭/GC；按 Ticket/PR 可重建。 | 不记录每条 shell 命令；不做第二套 commit 历史。 |
| 6 | **配额/可观测** | 采集每 Ticket 的 worktree 大小、仓库对象库总量 + 分支可达对象增量（对象共享，不能按 Ticket 归因）、worktree 数、分支数；E2 显示；超阈值告警。 | 租户/仓库配额、保留策略配置、超限拒绝或只告警；LFS/submodule 的 prepare 预检。 | 不把配额做成授权；不影响 Ticket 的 Action/Approval。 |

### 4.4 插件内可做 vs 需宿主/部署支持

| 层 | 可做 | 依据/边界 |
| --- | --- | --- |
| **插件内（本仓库）** | prepare 契约与校验；仓库绑定/分支/PR 不变量；credential 卫生检查；GC dry-run 与 P2 GC；审计事件；E2 只读空间/仓库视图；配额采集；flag 回退。 | kernel/runtime/panel 都在本仓库；P1 可能改 settings/API 契约，P2 才改 schema。 |
| **部署/运维** | 本地基线 clone；`executor.prepare`；agent GitHub 账号与 `gh` 包装；专用 OS 账户；GitHub 分支保护/权限；备份。 | [006](006-deployment.md) 的账号/凭据/隔离；产品不能替代 OS 账户与 GitHub 权限。 |
| **DSH 宿主** | 宿主 git provider/目录生命周期/写租约；workspace 列表投影/过滤（仅 E2 深集成）；宿主级配额/密钥托管（如果有）。 | [022 §2.3](022-harness-extension-requests.zh.md) 明确 workspace 列表没有投影/过滤钩子；[012 §6.6](012-platform-evolution.zh.md) 的 workspace handle 是演进目标；[013 附录 B](013-workspace-model.zh.md) 的 `WorkspaceProvider` 是产品 Phase 4 的抽象，不是宿主现状。 |
| **不需要宿主** | git 本身、worktree、分支、PR、提交、审计。 | git 是外部程序；插件已经有 `git` 命令与凭据 helper。 |

**关键区分**：仓库绑定/GC/审计是**本仓库的产品工作**，不是宿主缺口；只有 D2（宿主 git 生命周期）和 OS 级隔离/密钥/配额才需要宿主或部署。不要把所有难点都归给上游。

### 4.5 分阶段落地与回退

| 阶段 | 内容 | 验收 | 回退 |
| --- | --- | --- | --- |
| P0（本文） | 结论、对比、风险、PoC 判据；更新索引与 TRACKING。 | `tests/docs.spec.ts`、`check:tracking`；独立 review。 | 纯文档，删除即回退。 |
| P1 | 仓库绑定只读校验；分支/PR 不变量；凭据卫生；GC dry-run；E2 只读；审计到报告/日志（文本快照，非结构化审计；不持久化，P2 前不承诺历史/push 级重建）。 | 不新增 DB schema；列出 settings/API 契约变更；现有测试 + 新增只读检查；PoC-1/2/5 通过（P5 只验结束快照，push 时间线留 P2）。 | flag 关闭回到现状；不删任何数据。 |
| P2 | `repo` 绑定与 git 审计持久化；GC 操作；配额/保留配置；LFS/submodule 预检。 | schema 变更按 006 备份规则回滚；GC 用故障注入的不变量测试（不写「100% 安全」）；PoC-3/4 与 P5 的 push 时间线通过。 | 关 GC 操作；保留审计行；回滚=按 006 恢复备份。 |
| P3 | 宿主 git provider/目录生命周期/写租约；列表投影（若 E2 深集成）；产品实现 provider（013 Phase 4）。 | 宿主 API 可用；D2 的 PoC 重评。 | 不依赖宿主的能力继续用 A。 |
| P4 | 多仓库/跨仓子 Ticket、离线队列、云 workspace。 | 真实需求与配额数据。 | 保持一 Source 一仓。 |

### 4.6 失败与回滚语义

- **prepare 失败/超时**：释放预留租约；空目录删除、非空保留；Ticket 失败，不自动重试（013 §4.2）。记录命令输出与目录状态。
- **校验失败**（不是本 worktree、locator 不匹配、分支被别的 worktree 占用、凭据配置不合规）：释放租约，Ticket 失败；保留目录供排查。
- **push 被拒**：不 force；fetch + rebase（worker 所有），或报告冲突；保留本地 commit 和分支；不丢工作。
- **PR 创建失败**：分支保留，Ticket 报告 blocked/failed；重试可复用分支；不重复开 PR。
- **PR 关闭未合并**：Ticket 结束；分支保留到保留期；审计记录 closed 与 head SHA；不自动删除。
- **PR 合并**：人合并或按 Delivery requirements 的 auto-merge 后 Ticket 结束；GC 至少等到保留期；不自动 reset/rebase 本地分支。
- **脏工作树**：dirty = tracked 改动 + 非 ignored 的 untracked；ignored 构建产物单列。永不自动删；导出 patch/未跟踪文件清单，人工确认后再回收（013 §4.4）。
- **GC**：以 013 §4.4 为唯一 predicate；删除前重新取得写租约并持仓库级锁；按 head 查 GitHub/`ls-remote`；`-D` 仅当 tip 可达远端或已存 bundle/patch；`git gc` 走仓库级维护，不设 per-ticket SLA。
- **本地对象损坏**：`git fsck` + 备份恢复；不静默重置；GC 失败保留元数据并告警。

## 5. 风险与未解问题

### 5.1 风险清单与检测手段

| # | 风险 | 场景 | 检测 | 缓解 | 残留 |
| --- | --- | --- | --- | --- | --- |
| R1 | **越权写/越权合并** | root worker 用绝对路径写别的仓库；agent 账号可 `gh pr merge`；子 guard 只按命令名，`git -C`/脚本包装可绕过。 | 对比 Ticket 分支/PR 与 agent 账号的 commit/PR 列表；审计 `git -C` 目标；检查 `core.hooksPath`/`url.*.insteadOf`/`include.path`；分支保护；`gh` 子命令日志。 | 专用 OS 账户；细粒度/短期 token；GitHub 分支保护禁止自合并；`gh` shim 高风险子命令拒绝（P1，仍非安全边界）。 | 插件无法做 OS 隔离；只能降低概率，不能证明零越权。 |
| R2 | **凭据泄露** | token 出现在命令、日志、remote URL、`.git/config`、hooks、`url.*.insteadOf`、代理、崩溃转储；worker 读操作者 home。 | `git config --show-origin` 扫 `credential|http|core.hooksPath|url.*.insteadOf|include.path`；`gh auth token` 负向测试；密钥扫描（gitleaks/trufflehog）；日志 redaction；进程环境抽查。 | 只用 helper；不写 URL；`GH_TOKEN` 移除；专用 OS 账户；轮换 runbook；CI secret scan。 | 共享账号下，root worker 仍可能 `gh auth token` 读 token；需 OS/宿主级主体隔离。 |
| R3 | **磁盘膨胀** | worktree、分支、对象、构建产物、LFS 缓存累积；共享 clone 的对象不随 worktree 删除释放。 | `du` per worktree；`git worktree list`；`git count-objects -vH`；分支数；配额告警。 | 保留期 + GC；`worktree remove` + `branch -d`；仓库级 `gc` 单独维护；LFS prune；大仓预检。 | 共享对象库的回收需要停机/锁；并发 GC 有风险；不能按 Ticket 归因对象大小。 |
| R4 | **并发写同分支** | 两个目录配到同一分支；不同 clone 同名分支；force-push；stale worker 继续写。 | `git worktree list` 分支占用；push 前后 remote HEAD；`--force-with-lease` 旧 SHA；PR head SHA；租约 vs live Session。 | 一 Ticket 一分支；verifyCheckout；禁止普通 force-push；分支保护；push 后对账。 | 不同 clone 之间没有分布式锁；远端只能靠 git 拒绝非快进/分支保护。 |
| R5 | **审计缺口** | 本地 commit 未推；force-push 覆盖；分支删除；PR 关闭未合并；子 Ticket 的本地提交；GC 后无记录。 | 结束前比较本地 HEAD 与 remote HEAD；PR state/mergeCommit；push 事件；GC 日志；`git fsck` dangling。 | P1 记录 base/head/PR；P2 持久审计；结束前「未推即告警」；GC 保留骨架。 | 强制推/删分支在 GitHub 侧也可能被清理；需要保留 ref/备份策略。 |
| R6 | **基线漂移 / rebase** | `main` 前进，分支落后；合并冲突；谁负责 rebase 不清。 | PR `mergeable`/base SHA；CI；冲突提示；分支与 base 的 merge-base。 | 合并前由 worker rebase；分支保护要求 up-to-date；人不自动代做；记录 base SHA。 | 高并发仓里 rebase 反复；没有 merge queue。 |
| R7 | **跨仓/多仓** | 一个任务改两个仓；prepare 只覆盖一个；worker `cd` 到别处。 | `git rev-parse --show-toplevel` vs 绑定；PR 仓库 vs Source；子 Ticket 空间。 | 一 Ticket 一仓；跨仓拆子 Ticket；绑定校验；报告里显式列仓库。 | 产品没有多仓绑定；子 Ticket 协调靠父 owner。 |
| R8 | **LFS/submodule/大仓** | prepare 未拉 LFS；submodule 未初始化；clone 超时。 | prepare 日志；`git lfs ls-files`；`git submodule status`；超时。 | prepare 预检；按需安装 git-lfs；文档写清限制；大仓用 shallow/filter。 | 过滤 clone 可能缺对象；测试可能失败。 |
| R9 | **GC 误删** | 脏树、未关闭 PR、未合并分支、可恢复 Ticket、后台进程、审计需要的历史被删。 | dry-run 清单；013 §4.4 predicate；按 head 查 PR；租约/live Session；保留期。 | 先 dry-run；删除需显式动作；删除前重取租约+repo 锁；脏树保留；审计行不删；`worktree remove` 不用 `rm -rf`。 | 人工误操作；PR 状态 API 限流/`observePulls` 关闭时状态可能过期。 |
| R10 | **Source 配置变更** | 仓库改名/迁移、默认分支变化、账号换人；旧 worktree/remote 失效。 | setup/健康检查；`remote.origin.url`；默认分支；`gh repo view`。 | 绑定校验失败即停；不静默换仓；迁移 runbook；保留旧目录只读。 | 历史 PR/分支链接可能失效；需要归档。 |
| R11 | **离线/网络** | 断网时提交未推；重连后 base 变了；push 失败重试。 | 本地 HEAD vs remote；push 错误；队列状态。 | 保留本地 commit；重连 fetch/rebase；不 force；报告 blocked；P4 再做队列。 | 没有自动离线交付；用户需知道「未推 = 未交付」。 |
| R12 | **GC 与 resume 竞态** | Ticket 已结束但可恢复；后台进程仍在写；删除时 resume；PR 已关闭/重开而 `follows` 未更新。 | 删除前后对比 lease/Session/PR head；`ps`/租约心跳；GitHub by head。 | 删除前重取写租约；仓库级锁；二次确认；先存 bundle/patch。 | 仍有外部进程/人工 `rm` 的风险；插件无法完全防止。 |

### 5.2 未解问题

| # | 问题 | 需要谁决定 | 何时 |
| --- | --- | --- | --- |
| Q1 | 提交权是否只给 agent 账号，还是按 Ticket/租户发短期 token？ | 产品 + 运维/安全 | P2 前；影响 R1/R2。 |
| Q2 | 是否所有源码产出一律走 PR？docs-only、单文件修复能否直接推？ | 产品 | P1；建议一律 PR，保持单一门。 |
| Q3 | 一条 Ticket 一条分支一个 PR，还是允许 follow-up PR？ | 产品/内核 | P1；现状自动绑定按单 open PR，返工复用分支。 |
| Q4 | 谁负责 rebase：worker、父 owner、人，还是产品自动？ | 产品 | P1；建议 worker 负责，产品只校验 up-to-date。 |
| Q5 | 是否允许 force-push？只允许 `--force-with-lease`？ | 产品 + 运维 | P1；建议默认禁止，分支保护兜底。 |
| Q6 | GC 保留期默认 7 天/1 天是否合适？谁批准删除？ | 产品 + 运维 | P2；先 dry-run 收集数据。 |
| Q7 | 仓库绑定放哪里：从 Source 派生，还是持久化字段/表？ | 内核/产品 | P1 派生；P2 再定 schema。 |
| Q8 | 审计粒度：只记 push/PR，还是每条 git 命令？ | 产品/安全 | P2；建议只记交付链，shell 命令不做全局审计。 |
| Q9 | 多仓库任务是否只允许子 Ticket？ | 产品 | P2；现状是一 Source 一仓。 |
| Q10 | 离线提交是否需要产品级队列？ | 产品 | P3/P4；先支持「本地 commit、稍后 push」。 |
| Q11 | D2 的宿主 git provider/目录生命周期/写租约何时可用？是否值得等？ | 宿主/产品 | P3；没有这些接口不启动 D2。 |
| Q12 | 专用 OS 账户是否作为部署硬要求？ | 运维/安全 | P1；如果不做，R1/R2 的残留不可接受。 |
| Q13 | LFS/submodule 是否在 v1 支持？ | 产品 | P1/P2；至少 prepare 预检与文档限制。 |
| Q14 | 产品是否需要部署侧 mirror 来支持离线/性能？ | 产品/运维 | P3；优先部署侧 mirror，不进入产品权威。 |

## 6. 验证计划（PoC）

> 本文没有执行 PoC。下面是可复现的步骤、指标和失败判据；只有全部通过，才能把「条件可行」改成「已验证」。

### 6.1 假设与失败判据

- **H1**：每工单 worktree + 唯一分支在 8 个并发 Ticket（`executor.maxWorkers ≥ 8`）下不产生分支冲突，租约不放行第二个写者；槽位不足时只验证排队，不验证并发。
- **H2**：冲突/rebase 的归属可解释：同一分支由该 Ticket worker 解决，跨分支由后合并者解决，产品不自动改写历史。
- **H3**：prepare/commit/GC 的耗时与磁盘在可接受范围，GC 不删脏/未关闭 PR/未到期/可恢复/仍有 live Session 的工作。
- **H4**：结束时可从产品记录 + GitHub 重建「Ticket → 分支 → commit → PR → merge」；P1 只验快照，P2 才验 force-push/关闭 PR 告警。
- **H5**：凭据卫生检查能发现 repo 配置里的 `credential.*`/`http.*extraheader`/`core.hooksPath`/`url.*.insteadOf`/`include.path`，secret scan 在测试仓找不到 token。

**失败判据（任一即失败）**：

1. 任意两个并发 Ticket 使用同一分支，或同一目录出现两个活写者。
2. 任一 commit 在结束前既不在本地也不在远端（丢工作）。
3. 回滚后残留 worktree/分支/租约，或脏树被删除。
4. 审计链缺 base/head/PR 中任一项（P1），或 P2 无法解释 force-push/关闭 PR。
5. secret scan 命中 token；或 Ticket 目录 git config 含凭据。
6. GC 删除了脏树、有未关闭 PR 的分支、未到保留期的目录、可恢复 Ticket 或仍有 live Session/后台进程的工作。
7. prepare p95 超过基线 2 倍，或超过现有 10 分钟超时（视为不可用）。
8. 8 并发、`maxWorkers ≥ 8` 下无法达到 6/8 在 2×单票 p95 内 ready（吞吐不可接受）。

### 6.2 PoC 步骤

| 步骤 | 动作 | 观测/产物 |
| --- | --- | --- |
| P0 基线 | 用当前部署配置（006 的 prepare）在测试仓跑每种仓库样本 ≥20 个 Ticket（至少小/中/大 3 种），不启用 GC；记录 prepare/commit/PR 时间、worktree 数、磁盘。某仓型不足 20 时只报 p50+max，不报 p95。 | 基线数字；现状失败模式。 |
| P1 并发 | 本地 bare remote + 8 个 Ticket，分支名唯一；跑 prepare、commit、push；观察 `git worktree list`、租约、push 结果。 | 并发冲突数、prepare/commit p50/p95、分支占用。 |
| P2 冲突/rebase | 两个 Ticket 改同一文件；先合并一个，另一个 rebase；记录冲突解决者与耗时；注入 base 前进。 | 冲突归属、rebase 次数、失败原因。 |
| P3 失败注入 | prepare 中途杀进程；prepare 返回非零；verify 失败；push 被拒；commit 后杀 worker；PR 创建失败。 | 每个场景的租约、目录、分支、PR、审计状态；回滚成功率。 |
| P4 GC | 20 个结束 Ticket：干净/脏/未关闭 PR/已合并/未到期/可恢复各 ≥3；跑 dry-run，再跑删除；测 `worktree remove/prune/branch -d` 与仓库级 `gc`。 | GC 耗时、回收字节、误删数、残留数；竞态场景单列。 |
| P5 审计 | P1 只验结束快照：从 Ticket id 对照 HEAD/`rev-list base..HEAD`/PR head/base/merge；P2 再注入 force-push、关闭未合并 PR、删除分支并对比时间线。 | 快照字段完整率；P1 不承诺 push 级时间线；P2 才验 force-push 告警。 |
| P6 离线 | 断开网络，读/改/commit；重连后 fetch/rebase/push/PR；记录失败与重试。 | 本地 commit 保留率、重连成功率、耗时。 |
| P7 凭据 | 在 Ticket 目录写 `credential.helper`/`http.extraheader`，确认 verify 失败；在日志/命令/remote URL 注入假 token，确认 secret scan 命中/不泄漏。 | 负向测试结果。 |

**环境**：本地 bare repo 即可覆盖 A 的 worktree/分支/GC/租约；PR 相关用一次性 GitHub 测试仓或 fake `gh`；不碰生产 stateDir、不碰真实业务仓。所有 token 用测试账号/短期凭据，日志脱敏。并发 PoC 显式配置 `executor.maxWorkers ≥ 8`，并记录实际 worker 槽数；否则 8 个 Ticket 只证明排队，不证明并发。

### 6.3 指标

下表是**初始阈值**，PoC 固定环境与仓库样本后按实测校准；校准前不把它们当产品 SLA。

| 指标 | 定义 | 目标/判据 |
| --- | --- | --- |
| prepare p50/p95/max | 从预留租约到激活的墙钟时间（按小/中/大仓分层；n≥20） | p95 不超过基线 2 倍；不触及 10 分钟超时；大仓单独报告；n<20 只报 p50+max。 |
| commit p50/p95 | `git commit` + `git push`（本地/远端分开） | 本地 commit p95 ≤5s；push 成功率 ≥95%（固定网络），失败有分类；不丢 commit。 |
| PR 创建 p50/p95 | `gh pr create` 到 PR 可见 | 首次成功率 ≥95%；失败可重试且不重复开 PR；失败原因有分类。 |
| GC p50/p95 | 单 Ticket 清理（worktree/branch）与仓库级 `gc` 分开 | 单 Ticket ≤2s、100 个分支批量 ≤60s（初始目标，按实测校准）；仓库级 `gc` 单独报告，不设 per-ticket SLA。 |
| 并发工单数 | 同一仓同时 prepare/commit 的 Ticket 数（记录 `maxWorkers`） | 8 个并发、`maxWorkers ≥ 8` 时无分支冲突、无租约违规；≥6/8 在 2×单票 p95 内 ready，其余有可解释失败；槽位不足时单独报告。 |
| 回滚成功率 | P3 的 6 个场景中恢复租约/目录/分支/审计的比例 | 6/6；无残留；每场景有独立记录。 |
| 审计完整率 | 有 base/head/PR/merge 记录的 Ticket 比例（n≥20） | 100%；force-push/关闭 PR 的告警属 P2，P1 只验快照字段。 |
| 磁盘 | 每 Ticket worktree、仓库对象库总量+分支可达对象增量、LFS 缓存 | PoC 先定预算；worktree/对象/构建产物分别计量；超预算 2 倍或磁盘余量 <20% 告警；GC 后增长可解释。 |
| 秘密泄漏 | secret scan 命中数、git config 命中数 | 0；负向测试必须命中。 |

### 6.4 PoC 通过后仍不证明的事

- 多租户/多 OS 账户下的隔离（需要专用账户与真实权限）。
- GitHub 分支保护、组织策略、CI 计费与限流。
- 大仓/LFS/submodule 的真实长尾。
- 宿主 git provider/目录生命周期的 D2 方案（未实现，不能替 A 证明）。
- 生产规模下的 GC 并发与对象库锁竞争。
- P1 只做结束快照，不证明 push 时间线；force-push 告警需要 P2 的 git wrapper/GitHub timeline。
- 注入假 token 只能证明扫描器工作，不能证明 root worker 不能 `gh auth token` 读真实 token；需要真实主体隔离与负向测试。
- 子 guard 不能证明无法 push：应实测 `git -C <dir> push`、脚本包装等绕过；这是工具级限制，不是不变量。

## 7. 落地性自查（review 输入）

这一节故意用反方问题检查推荐，不是结论；review 结论写在 PR review 评论。

1. **「A 已存在」不等于「A 已产品化」**：仓库绑定、分支/PR 证据、GC、审计都不存在；本文推荐的是 P1/P2 工作，不是现状能力。若把现有部署脚本当交付，就是高估。
2. **「插件内可做」是否过度**：仓库绑定与 GC 可以在本仓库做，但「专用 OS 账户/细粒度凭据/宿主 git 生命周期」不在插件内；不写清边界就会把安全问题留给提示词。
3. **GC 的「自动」是否安全**：没有脏检查、PR 状态、租约/live Session 的联合判断，自动删除会毁工作；P1 只能 dry-run，P2 才谈删除。
4. **C2 是否被公平比较**：API 直写对「纯文本产出」可行，但对需要构建/测试的源码不成立；本文把它排除，不是忽略。
5. **D 是否值得等**：宿主只有 workspace 注册，没有 git provider/目录生命周期；等 D2 会把源码交付拖住；A 可以先跑，D 作为 Phase 4 重评。
6. **指标是否可复现**：prepare/commit/GC 的 p95 依赖仓库大小、网络、机器；PoC 必须固定环境与仓库样本，否则数字不可比。
7. **「一个 PR」是否过强**：现状允许返工复用分支，PR 关闭后重开；如果产品需要 follow-up PR，I5 要放宽，但必须保持「一个 open PR」的绑定去重。
8. **P1 的「观察」是否足够**：P1 只能做结束快照，不能证明每次 push/force-push；`orchestrator_report` 也没有结构化 git facts。把 P1 当「审计」会高估；P2 的 git wrapper/GitHub timeline 才是补口。
9. **D1 是否被误当 D2**：宿主已经为每个 Ticket 目录创建 workspace 注册，但 `delete` 保留目录、`rename` 只改标题、没有 git provider/写租约；「已注册」不等于「宿主管理仓库生命周期」。
10. **auto-merge 是否被忽略**：仓库默认提示词允许按 Delivery requirements 开启 auto-merge，本部署的 Delivery requirements 禁止；I5 与审计必须区分「agent 不直接 merge」和「配置允许 auto-merge」。

## 附录 A：证据索引

| 主题 | 证据 |
| --- | --- |
| 空间唯一 locator、租约 | [013 §0](013-workspace-model.zh.md)、§1.2、§4.2、§4.3、§5 |
| 租约不是安全隔离 | [013 §5.2](013-workspace-model.zh.md)、[006 §Permissions](006-deployment.md) |
| prepare/目录/10 分钟 | [003](003-execution.md) 的「Preparing a Ticket directory」、[006 §Execution](006-deployment.md) |
| 凭据/身份/隔离 | [006 §Accounts、§Setup checks、§Permissions](006-deployment.md)；`packages/dsh/src/infra/environment.ts` |
| 分支/PR 绑定 | `packages/dsh/src/sources/github-pull.ts`；`packages/dsh/src/sources/github.ts` 的 `DSH_SUPERAGENT_NAME` |
| 子 Ticket 限制 | `packages/dsh/src/app/sessions.ts` 的 `childShellReason`；[013 §1.3](013-workspace-model.zh.md) |
| 空间回收（Phase 3，未实现） | [013 §4.4](013-workspace-model.zh.md) |
| 产出物/执行空间区分 | [021 §3.4、§7.2](021-ux-redesign.zh.md)；[001](001-domain.md) 的 Deliverable |
| 保留策略 | [012 §7.2](012-platform-evolution.zh.md) |
| workspace handle/provider | [012 §6.6](012-platform-evolution.zh.md)；[013 附录 B](013-workspace-model.zh.md) |
| 宿主 workspace 列表限制 | [022 §2.3](022-harness-extension-requests.zh.md) |
| PR/审计现状 | `packages/dsh/src/executor/dsh.ts`、`packages/dsh/src/app/spaces.ts`、`tests/action.spec.ts`、`tests/outbox.spec.ts` 的范围 |

## 附录 B：决策记录

| 日期 | 决策 | 理由 | 状态 |
| --- | --- | --- | --- |
| 2026-11-12 | 推荐 A + C；B 不作 v1 权威 | 与现状连续、源码可本地验证、GitHub 仍是合并门；B 的产品成本大于收益 | 调研 |
| 2026-11-12 | C2 不用于源码 | 没有工作目录，无法构建/测试，破坏 `Execution.directory`/lease | 调研 |
| 2026-11-12 | D 留 Phase 4 | 宿主只有 workspace 注册，无 git provider/目录生命周期/写租约；D1 无产品收益；嵌套仍有清理顺序风险 | 调研 |
| 2026-11-12 | P1 只观察/护栏，P2 才持久化/删除 | 先证明绑定与审计，再做不可逆操作 | 调研 |
| 2026-11-12 | 仓库绑定不建第二 locator | 保持 `Execution.directory` 单一事实源 | 调研 |

## 附录 C：与现有任务的关系

- [T3-12/T3-13](plan/TASK-PLAN.zh.md) 已交付空间只读投影与写租约；本文的 P1 直接复用。
- [T3-06](plan/TASK-PLAN.zh.md) 的 warm 池未开始；跨 Ticket 复用会引入「空间还在被谁用」的问题，本文不把 GC 与 warm 池绑在一起。
- [X-13](plan/TASK-PLAN.zh.md) 的 TRACKING 自动化已落地；本文新增 X-15 记录调研状态。
- [022](022-harness-extension-requests.zh.md) 的 workspace 列表座位是 D/E2 的宿主前提；本文只引用，不重复提上游请求。