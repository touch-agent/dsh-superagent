# 工作空间模型设计：空间与任务树正交

> 状态：**设计提案 v1.0（2026-11-09，docs-only，未实现）**。本文回答「工作空间是什么、和任务树/分支/Session 什么关系、什么情况下用哪种空间、怎么并发与回收、界面上怎么表达」，不改变领域契约、授权、代码或现有 UI。
>
> 依据：2026-11-09 的工作空间模型设计请求；现状以 `origin/main`（`89f2034`，子 Ticket Phase 2a 合入后）为准。
>
> 关联：[docs/001](001-domain.md)（Ticket/Assignment/Execution 边界）、[docs/003](003-execution.md)（目录、prepare、轻量工单）、[docs/005](005-panel.md)（面板分层）、[docs/007](007-architecture.md)（Executor/Session 实现）、[docs/011](011-design-principles.zh.md)（注意力、组织内部化、六层上下文、可替换边界）、[012-platform-evolution.zh.md](012-platform-evolution.zh.md)（workspace handle 与三层执行）、任务视图架构设计（`docs/tasks-view-architecture.zh.md`，任务树与子 Ticket）、[TASK-PLAN](plan/TASK-PLAN.zh.md)、[TRACKING](plan/TRACKING.zh.md)。

## 0. 结论摘要

| # | 结论 | 影响 |
| --- | --- | --- |
| 1 | **空间不是任务层级**。工作空间是执行侧的引用（reference），回答「工作在哪里发生、谁现在可以写」；任务树回答「谁授权谁做什么」。两者正交，空间不得成为树节点，任务也不得因目录嵌套而获得空间所有权。 | 不改 Ticket/Assignment 的授权语义；任务视图不新增空间节点。 |
| 2 | **一个 tracked Ticket 默认拥有一个可写空间**（代码检出、临时目录或项目工作区），同一 Ticket 的多次 Assignment 复用它；子 Ticket 默认拥有自己的空间，不与父共享可写空间。lightweight Ticket 没有空间。 | 保留「一工单一 Session 一目录」的既有直觉，但把「目录」升级为「空间句柄 + 租约」。 |
| 3 | **写者唯一**。同一空间同一时刻至多一个写租约（同一 Ticket 可重入）；只读共享只允许发生在项目基线、已提交修订或无写者的检出上。租约是协调，不是安全边界。 | 两个任务同时改同一目录不再靠运气；冲突变成可解释的排队/阻塞，而不是静默覆盖。 |
| 4 | **空间身份不是路径**。`WorkspaceRef` 记录稳定 id、类型、provider、locator、分支/修订、所有者、保留策略；路径只是 provider 的 locator。 | 为本地目录、云工作区、临时桶留出替换边界；路径变化不改变空间归属。 |
| 5 | **子 Ticket 独立空间**。新子 Ticket 的检出放在执行根的兄弟目录（或 provider 分配的独立位置），不再放在父目录内部；父 owner 的「合并/解冲突」是 VCS 与审阅职责，不是对子目录的写权限。旧嵌套目录保留为兼容布局，不自动搬迁。 | 修复父子目录嵌套带来的误删、相对路径和「父写子」风险；TaskPlan 的合并语义有了空间落点。 |
| 6 | **根空间只做只读与维护**。主 Session 在系统根工作；用户可见的文件改动仍必须由 Ticket 的空间承载。根空间写操作是部署/维护行为，不冒充 Ticket 审计。 | 不把「主 Session 顺手改一下」变成无审计的第三种执行形态。 |
| 7 | **生命周期显式化**：创建（prepare）→ 校验 → 租用 → 释放 → 重置/复用 → 回收。交付后保留到 PR 关闭 + 保留期；脏空间不自动删除；重启后按 epoch 恢复过期租约，不静默抢占。 | 解决 worktree 泄漏、prepare 半成品被当成「已准备」、重启后租约悬挂。 |
| 8 | **UI 默认不出现空间**。E0 不显示路径/空间 id；E1 任务详情只给一个「空间」区块（类型、分支、状态、持有者）；E2 管理面板新增只读「空间」视图，回答「谁在哪个空间做什么」。完整任务页可切换「按空间分组」，右栏不新增空间 tab，任务树不画空间。 | 符合 docs/011 原则 A/B：空间是内部执行事实，不是默认叙事；需要排障/审计时按需打开。 |
| 9 | **与 docs/011 的取舍**：空间是 agent 维度（工作目录）的载体，不是第七层上下文；空间视图是 E2 信任控制台，不是默认面；provider/lease/GC 属于可替换的执行边界，不进入授权与验收不变量。 | 不新增授权主体、不新增默认注意力成本、不把目录当隔离或权限。 |
| 10 | **分五阶段落地**：Phase 0 本文与词汇；Phase 1 只读投影与 E2 视图；Phase 2 写租约与子 Ticket 独立空间；Phase 3 复用/回收与 warm 池；Phase 4 provider（云/桶）。现有 worktree 约定、`executor.prepare`、分支/PR 绑定保持兼容。 | 计划落点见 [T3-12、T3-13](plan/TASK-PLAN.zh.md)；T3-06 的 warm 池受 Phase 2 租约约束。 |

**明确不做**（本设计边界）：

- 不把空间建成第二个授权聚合，不新增 `Mandate`/`Decision`/`Acceptance`。
- 不承诺目录级安全隔离；worker 仍是 `danger-full-access`，真正的隔离属于 OS 账户/容器/多租户（docs/012 M4）。
- 不在任务树里画空间层级，不做「把任务拖到空间」的组织操作，不做 per-space 权限。
- 不自动把两个 live Ticket 塞进同一个可写检出；也不自动搬迁旧的嵌套子目录。
- 轻量工单仍不获得空间；`commit`/`send`/`spend` 仍必须走 tracked Ticket。

## 1. 现状盘点

### 1.1 系统根、执行根与主 Session

- 一进程一 system：主 Session 的工作目录是 `<stateDir>/system`；默认执行根是 `<stateDir>/system/work`，可由 `executor.directory` 改到别处。主 Session 的目录是上下文根；worker 目录默认是它下面的一层，配置后可落在别处。
- 这些都只是默认值，**不是安全边界**：worker 以操作者 OS 用户运行，可以 `cd` 到任何位置，也可以用绝对路径执行程序。
- 主 Session 在系统根直接使用工具；这类调用不进入某个 Ticket 的 action ledger，也没有「空间」归属。它是路由、读上下文、做部署/维护的场所。

证据：[docs/003](003-execution.md) 的「The Executor」「Preparing a Ticket directory」；`packages/dsh/src/app/execution-environment.ts` 的 `systemRoot` / `executionRoot`；`packages/dsh/src/app/runtime.ts` 的主 Session workspace 注释。

### 1.2 每工单目录与 prepare

- 每个**根** tracked Ticket 在受理时得到 `execution: { name, directory, assignment }`：`name = <worktree name>-<ticket id 前 12 位>`，`directory = <execution root>/<name>`。子 Ticket 不走这条路径：它在委派时直接得到 `<父目录>/child-<n>`（见 1.3）。
- 首次启动前，如果目录不存在，执行器在 **`dirname(directory)`** 运行一次 `executor.prepare`，带 `DSH_SUPERAGENT_DIR` 等执行变量，10 分钟超时：根 Ticket 的 cwd 是执行根，子 Ticket 的 cwd 是父目录。典型部署命令用 `git worktree add` 创建检出和分支。
- **已存在的目录一律视为已准备**：这是当前最重要的隐含契约。它让重启/重试不必重复 prepare，但也意味着半成品、手工目录、上一次失败留下的非空目录都可能被当作准备好的空间。
- prepare 失败会直接让 Ticket 失败并记录输出，不自动重试；空目录会被删除，非空目录保留。
- prepare 后会 `verifyDirectory`：检查目录里 local/worktree scope 的 git 配置没有自定义 `credential.*` 或 `http.*extraheader`。它校验凭据卫生，不校验分支、脏状态或空间归属。

证据：`packages/dsh/src/executor/dsh.ts` 的 `ticketExecution`、`prepareDirectory`、`launch`；[docs/003](003-execution.md) 的「Preparing a Ticket directory」。

### 1.3 父子工单的目录关系

- 子 Ticket 由父 owner 委派创建，`execution.directory = <父目录>/child-<n>`，`name = <父 name>-child-<n>`。
- 子 Ticket 有自己的 `worker-<childTicketId>` Session 和 Assignment，但它的目录**物理嵌套在父目录内部**；首次启动时 prepare 在父目录里运行，在子目录这个位置创建检出（若配置了 prepare 命令）。
- 这带来三个具体问题：
  1. 父目录的 VCS 会把子目录看成未跟踪内容；父 worker 执行 `git clean -fdx`、`git stash -u` 或删除目录时可能连带毁掉子空间；
  2. 父/子同时工作时，相对路径、递归搜索、打包和文件监听会把两边的工作混在一起；
  3. 目录层级看起来像任务层级，读者容易把「子目录」误读为「子任务的空间所有权」，而实际上授权关系在 Ticket/Delegation，不在目录。
- 子 worker 当前的 shell guard 只按命令名拦截常见网络/GitHub/git remote/sqlite/state 路径命令（`gh`、`git push/fetch/clone`、`curl`/`wget`/`ssh`、`sqlite3` 等），不是网络隔离，可被其他方式绕过，也**不限制 cwd 逃逸**；父/子目录隔离是约定，不是强制。子 Ticket 也不能推送远端或开 PR；父 owner 负责最终合并/上报。

证据：`packages/kernel/src/tickets.ts` 的 `delegate`（`childExecution`）；`packages/dsh/src/app/sessions.ts` 的 `childShellReason` 与 `workOnly`；[TASK-PLAN](plan/TASK-PLAN.zh.md) T3-10 的「子 owner 受限执行配置」。

### 1.4 lightweight：没有空间

- 轻量工单没有 Assignment、worker Session 和 workspace 目录，走 `InlineWork`；当前能力是一次只读仓库查文件（最多 4 个路径），不执行 `commit`/`send`/`spend`。
- 它读的是仓库 API 的相对路径，不是某个检出目录；审计靠 action ledger。因此它**没有「空间」这个执行事实**，也不应该伪造一个。
- 这条边界是正确的：未来若要让 inline 执行写操作，必须先有空间与租约，否则审计和副作用不可控。

证据：`packages/dsh/src/executor/inline.ts` 文件头注释与 `MAX_PATHS`；[docs/003](003-execution.md) 的「Lightweight tickets」；[TASK-PLAN](plan/TASK-PLAN.zh.md) T3-05 的 Phase 0。

### 1.5 分支、Session 与空间的耦合

- 部署的 prepare 约定通常创建 `agent/<ticket short name>` 分支；仓库默认 `executor.prepare` 为空，所以分支创建是部署约定，不是当前默认行为。PR 归属靠「分支最后一段 = Ticket 短名」的约定，而不是空间记录。
- 每个 Ticket 的 worker Session 持久存在，重试、追加输入、人工继续都复用同一 Session 和目录；`execution.directory` 在 Ticket 生命周期内不变。
- 跨 Ticket 的 warm 池尚未实现（T3-06 未开始）；当前没有「换一个 Ticket 复用另一个 Session/目录」的路径，因此暂时没有跨 Ticket 抢占问题，但一旦做 warm 池就会立刻遇到「空间还在被谁用」的问题。
- 空间、分支、Session 三者目前是**隐式绑定**：换目录要换 Session，换 Ticket 要换目录，分支从 prepare 命令里猜。没有一处显式声明「这个空间属于谁、现在谁在写、对应哪个分支」。
- prepare 决定的空间来自部署设置与 Source 仓库，**不一定等于任务实际要改的仓库**。跨仓库/跨项目任务可能在 prepared 目录之外新建检出，而执行器仍把 prepared 目录当作该 Ticket 的空间、Session 也固定在那里；当前没有「切换/声明实际写空间」的记录。

证据：`packages/dsh/src/executor/dsh.ts` 的 `workerSessionId`、`launch`；[docs/003](003-execution.md) 的「The Executor」「Retry」「Restart」；[TASK-PLAN](plan/TASK-PLAN.zh.md) T3-06。

### 1.6 并发与回收

- 并发由 `WorkerSlots` 管：限制同时在跑的 worker 数，给人工消息留一个额外槽；它是**计算资源**的闸门，不是数据/目录的写权限。
- 没有跨 Ticket 的空间锁、租约或冲突检测；两个 Ticket 只有在 prepare 命令把同一个目录给它们时才会真正冲突，而系统无法识别这种「同空间」。
- Ticket 结束后不回收目录：worktree、分支、未提交文件和构建产物会持续堆积；没有保留策略、脏状态检查或 GC。`git worktree` 的元数据也会越积越多。
- 重启后，Session/目录/Assignment 会恢复；但没有「租约 epoch」概念，无法区分「上次进程留下的占用」和「当前仍在写」。

证据：`packages/dsh/src/executor/dsh.ts` 的 `WorkerSlots`、`resume`、`shutdown`；[docs/003](003-execution.md) 的「Concurrency」「Restart」。

### 1.7 现状问题清单

| # | 问题 | 证据 | 后果 |
| --- | --- | --- | --- |
| P1 | 子目录嵌套让空间从属于任务路径 | `tickets.ts` 的 `childExecution.directory = parent/child-n` | 父清理误删子工作；相对路径混淆；读者把目录当层级 |
| P2 | 空间身份只是路径字符串 | `execution.directory` | 无法判断两个 Ticket 是否同空间；无法表达共享/只读挂载 |
| P3 | 没有写者唯一约束 | 只有 `WorkerSlots` | 手工配置或未来复用可导致静默覆盖 |
| P4 | 没有生命周期与回收 | Ticket 结束不删目录 | 磁盘/worktree/分支泄漏；旧检出被误当新空间 |
| P5 | prepare 的「目录存在即已准备」过于宽松 | `launch` 的 `stat(workspace)` | 半成品/错误分支/上一次残留被当作准备好的空间 |
| P6 | 根空间写入无 Ticket 审计 | 主 Session 直接使用工具 | 「谁在根目录改了什么」无法按工单追溯 |
| P7 | 分支/PR/空间/Session 隐式耦合 | 分支名约定 + `execution.directory` | warm 池、迁移、复用都缺少显式契约 |
| P8 | 父子并发写没有协调 | 子目录嵌套 + 父 worker 可写父目录 | 父写子目录、子写父文件都不受阻止 |
| P9 | 空间不可观测 | 任务投影只给 `execution.name`、assignments 与 sessionId，未投影 directory/空间状态/租约 | 回答不了「谁在哪个空间做什么」，排障靠翻目录 |
| P10 | lightweight 无空间 | `InlineWork` | 当前可接受；若未来 inline 写文件，审计会断链 |
| P11 | prepare 的空间 ≠ 任务实际写空间 | prepare 绑定部署仓库；worker 可 `cd` 到别的仓库工作 | 执行器/UI 错认空间；回收落在错误目录；跨仓库交付靠人工约定 |

### 1.8 现状中应当保留的决定

1. 一进程一 system，主 Session 是上下文根；目录不是安全边界。这两句必须继续成立，避免把空间误当沙箱。
2. 一 Ticket 一持久 Session；同一 Ticket 的重试/追问复用目录、分支、PR。
3. 子 Ticket 有自己的 owner/worker 与 Assignment；它继承授权，不是第二授权主体。
4. lightweight 无 Assignment/worker/空间；`commit` 以上必须 tracked。
5. prepare 可替换：部署可以用 `git worktree`，也可以用普通目录、云盘或未来的 provider。
6. 目录名带 Ticket id 后缀，默认唯一；分支后缀绑定 PR。迁移不应破坏这两条。

## 2. 概念模型

### 2.1 定义

**工作空间（Space，界面短称「空间」）**：一次工作可以发生的位置，以及该位置的访问方式、修订状态与当前租约。它是执行侧的引用，不是领域聚合；不进入 Ticket/Mandate/Decision，不作为授权主体。

> 命名提醒：DSH 宿主自己也把 Session 的工作目录注册为 `workspace`（`workspaceRegistry`）。本文的「空间」是 superagent 的执行引用，不是宿主 workspace；实现时用 `WorkspaceRef`/`space` 命名，不要把两者混为一谈。

**空间句柄（WorkspaceRef）**：持久化的引用，回答「这是哪个空间」。建议字段：

```ts
interface WorkspaceRef {
  id: string                    // 注册表分配的稳定 id，不是路径；主键
  identityKey: string           // 去重键：provider + 规范 locator（realpath/大小写/符号链接归一）
  kind: SpaceKind               // root | project | checkout | scratch | subdir | remote
  provider: string              // local-git | local-dir | 未来的 cloud
  locator: string               // 路径 / URL；provider 的实现细节，可读但不是身份
  revision?: { branch?: string; base?: string; commit?: string }
  owner: { kind: 'system' | 'project' | 'ticket'; ticketId?: string; rootTicketId?: string }
  retention?: 'transient' | 'review' | 'audit'
  lineage?: { derivedFrom?: string; createdBy?: string }
}
```

`id` 由注册表在创建/收养时分配；`identityKey` 用于判重，注册表对 `(provider, identityKey)` 建唯一约束。改路径字符串不改变归属；移动/改名必须走显式的 provider `relocate`，不能靠改 `locator`。

**写租约（write lease）**：一个空间同一时刻至多一个写者。租约记录 `{ spaceId, holder: { ticketId, assignmentId?, sessionId? }, host, acquiredAt, renewedAt, expiresAt, epoch, state }`。**租约属于 Ticket**；`assignmentId`/`sessionId` 只是当前执行者的元数据，跨 Assignment 保持不变。写租约是协调机制：它让冲突可解释、可排队、可审计，但不授予动作等级，也不阻止恶意进程绕过目录。

**只读租约/挂载（read claim）**：声明「我在读这个空间」。只允许出现在项目基线、只读快照、或没有写者的检出上；在 `checkout` 上与写租约互斥，在项目基线上可多读者共存。它不承诺跨修订的一致快照。

**空间所有者（owner）**：生命周期归属。系统拥有根空间；部署/项目拥有项目基线；Ticket 拥有自己的检出/临时目录。所有者与租约持有者不是一回事：父 Ticket 可以审阅子 Ticket 的空间，但不拥有它；子 Ticket 结束释放租约后，父可以只读挂载或把分支合入自己的空间。

### 2.2 空间类型

| 类型 | 是什么 | 谁写 | 典型用途 | 生命周期 |
| --- | --- | --- | --- | --- |
| `root` | 主 Session 的系统根（`<stateDir>/system`） | 主 Session 的维护/路由操作；不是用户工作 | 读上下文、部署/维护、路由 | 进程级持久；不随 Ticket 回收 |
| `project` | 项目基线（根仓库的本地克隆/缓存/共享只读检出） | 部署维护（fetch/更新）持写租约；worker 只读 | prepare 的源、跨 Ticket 的只读上下文 | 长生命周期；定期 fetch |
| `checkout` | 每 Ticket 的 VCS 检出（worktree） | 该 Ticket 独占写租约 | 代码修改、测试、分支、PR | Ticket 生命周期 + 交付保留期 |
| `scratch` | 每 Ticket 的临时目录（可无 VCS） | 该 Ticket 独占写租约 | 文档草稿、数据分析、临时产物 | Ticket 生命周期 + 短保留期 |
| `subdir` | 另一个空间的路径视图（如 monorepo 包） | 跟随所属 `checkout` 的租约，不单独写 | 限定 cwd、减少上下文 | 跟随所属空间；不单独回收 |
| `remote` | 未来：云工作区、对象桶、远程容器 | provider 决定；语义同写租约 | 云端长任务、共享工作区 | provider 回收 |

**类型选择不是权限等级**。`checkout` 不比 `scratch` 更「可信」；`root` 不比 `checkout` 更「安全」。类型只描述工作形态与生命周期。

对应需求里的说法：根仓库 ≈ `project`，项目 worktree ≈ `checkout`，临时目录 ≈ `scratch`，子目录 ≈ `subdir`；`root` 是系统根，`remote` 是未来的 provider 空间。

**`project` 在 Phase 1 允许缺省**：现有状态只有 `execution.directory`，没有基线实体。Phase 1 只投影 `root`/`checkout`/`unknown`，不伪造 `project`；Phase 2 才由 prepare 显式声明（或从 git common dir 推断）基线，并启用基线读。

### 2.3 与任务树正交

```text
任务树（授权 / 委派 / 审阅）                空间图（执行位置 / 租约，正交）
─────────────────────────────              ─────────────────────────────────
根 Ticket ── 子 Ticket A                   根空间（只读/维护）
    │            └─ 子 Ticket B            项目基线（只读共享）
    │                                        ├─ 检出：根 Ticket（写租约）
    └─ Assignment / worker-<ticketId>        ├─ 检出：子 Ticket A（写租约）
                                             ├─ 检出：子 Ticket B（写租约）
                                             └─ 临时目录：某个 Ticket（写租约）
```

关系规则：

1. **任务树的边是授权/委派边，不是目录边**。父 Ticket 不因「父」而拥有子空间；子 Ticket 不因「子」而继承父的可写空间。
2. **空间图的边是派生/引用边**。`checkout`/`scratch` 从 `project` 派生；`subdir` 引用一个 `checkout`；没有「父空间 → 子空间」的任务式层级。
3. **一个 Ticket 至多一个写空间**，可以有零个或多个只读空间（项目基线、审阅对象、子交付分支）。写空间是它的主工作区；只读空间是上下文。
4. **一个空间至多一个写者**（同一 Ticket 可重入）。只读声明不改变所有权。
5. **Assignment 是「某段时间在某个空间里执行」的记录**；Session 在生命周期内固定到空间。重试/追问复用；warm 池复用是显式释放后的例外。
6. **分支/PR 是空间修订的属性，不是任务层级的属性**。一个 `checkout` 可以有一个分支；`scratch` 没有分支；子 Ticket 的分支是委派草稿，根 Ticket 的分支才是对外 PR 分支。

### 2.4 与现有概念的关系

| 现有概念 | 与空间的关系 | 不变量 |
| --- | --- | --- |
| `Ticket` | 通过 `Execution` 引用空间；空间不是 Ticket 的字段语义 | 空间不授予授权；Ticket 的结束条件不变 |
| `Assignment` | 在空间里执行；launch 触发租约获取与续期，但租约属于 Ticket，Assignment 只是当前 holder | 一个 Ticket 的多个 Assignment 复用同一写空间 |
| worker `Session` | 固定在空间 locator 上；Session 的 cwd 就是空间 | 换空间必须重建 Session；warm 复用同一空间也要清空/重建上下文，不能把旧目标带过去 |
| `Delegation` / 子 Ticket | 子 Ticket 默认有自己的空间；父 owner 只读审阅子分支 | 父子空间不嵌套、不共享写租约 |
| 分支 / PR | `checkout.revision.branch`；PR 归属仍看分支后缀 | 子 Ticket 不直接开 PR；根 Ticket 拥有对外 PR |
| `Approval` / `Action` | 与空间无关；动作闸门仍按根 Mandate | 租约不改变 `maxActionLevel` |
| `Deliverable` | 工件的 locator 可以指向空间里的文件；预览/验收不依赖目录 | 空间回收不得早于交付被接受/PR 关闭 |
| `Activity` / `trace` | 空间事件（创建/租用/释放/回收/冲突）可作为 trace span | 默认不产生人的通知 |

### 2.5 关键不变量

| # | 不变量 | 为什么 |
| --- | --- | --- |
| I1 | 同一空间同一时刻至多一个写租约；`checkout` 上写租约与只读声明互斥；同一 Ticket 可重入 | 防止同一检出被两个 worker 同时改或读到半成品 |
| I2 | 写租约绑定活 Ticket；Ticket 结束/停止/失败重试按规则释放或保留 | 避免悬挂租约和「幽灵写者」 |
| I3 | 任务树父子不自动共享写空间；父不能写子空间，子不能写父空间 | 空间正交，冲突显式化 |
| I4 | 一个对外 PR 只属于一个根 Ticket 的一个写空间分支 | 保持 PR 归属与审计唯一 |
| I5 | 空间是引用，不是授权；租约不授予动作等级 | 不复制授权、不让目录成为权限 |
| I6 | 路径是 locator，不是身份，也不是安全边界 | provider 可替换；不把目录当沙箱 |
| I7 | lightweight 无写空间；`commit` 以上必须 tracked | 保持轻量工单的审计边界 |
| I8 | 回收不得删除未交付的工作；脏空间需人工确认 | 防止不可逆丢失 |
| I9 | 根空间不承载用户可见的文件改动（**目标不变量；Phase 1/2 未强制**） | 根写入无 Ticket 审计；强制前不能声称已审计 |
| I10 | 子 Ticket 的空间不对抗父 owner 的审阅/合并责任 | 父仍是最终目标与集成负责人 |

## 3. 判定规则

### 3.1 何时在根空间操作

根空间只用于：

- **只读上下文**：读仓库、读文档、查状态、跨项目查找；
- **路由/编排**：主 Session 评估 Trigger、派发、回复；
- **部署/维护**：安装、配置、健康检查、修复 state；这些是运维动作，不是用户工作；
- **轻量工单的只读执行**：inline 通过仓库 API 读文件，不落在根目录。

**规则（建议的目标规则；当前主 Session 仍可写，Phase 1/2 不改工具权限）**：用户可见的文件改动（提交、交付物、草稿落盘）必须由 Ticket 的空间承载；根空间不写用户工作。若确实需要根写入（例如部署修复），按运维授权处理，留痕在部署/运维日志，不写 Ticket action ledger；在强制前不声称根写入已被审批。

### 3.2 何时必须新建空间

满足任一条件，必须为 tracked Ticket 新建一个可写空间：

1. 会产生 commit、分支或 PR；
2. 交付物是文件/目录，需要被审阅或保留；
3. 工作跨多轮、可能超过一次 30 分钟预算；
4. 与其他 live Ticket 共享同一项目/仓库，需要隔离；
5. 需要实验、失败可丢弃、不能污染主工作区；
6. 子 Ticket 需要写代码/文件（默认独立空间，见 3.3）。

不需要新建空间的情况：只读调查、纯对话答复、单动作且无需落盘的 lightweight 工单。

**跨仓库/跨项目任务**：一个 Ticket 仍只有一个写空间。把该 Ticket 的唯一写空间**改绑**到实际目标仓库，prepared 目录转为只读/落地；若确实要同时提交两个仓库，拆成两个子 Ticket（各一写空间），多仓库 `project` 留到 Phase 4。不引入第二个写空间。

### 3.3 子任务默认继承父空间还是另开

**默认另开**，这是本设计对现状的明确修正：

- 子 Ticket 的写空间从**项目基线**派生，放在**执行根下的兄弟目录**（例如 `<execution root>/<child name>`），与父目录平级，不放在父目录内部；孙 Ticket 同样平铺在执行根下，名字含父名；prepare 的 cwd 是执行根，不是父目录；
- 子 Ticket 的分支是委派草稿；子不能推送/开 PR（现状 guard 已如此）；父 owner 在自己的空间里做最终合并、冲突解决和上报；
- 子 Ticket 只读父的在制品时，可以**只读挂载**父空间（不取写租约），但只在父无写者时成立；若父正在写，必须用 snapshot/detached 副本读已提交修订，不能直接读 live checkout；否则读项目基线的对应修订；
- **禁止**父子同时写同一空间；需要「父先做、子接着做」时，按顺序释放/获取租约（handoff），不是共享。

例外（必须显式记录）：纯只读研究型子 Ticket 可以只读挂载父空间并只产出报告；它不得写文件。若它需要写，回到默认：另开空间。

### 3.4 何时复用

- **同一 Ticket 的重试、追问、人工继续**：复用同一空间、分支、Session；租约重入。
- **同一 Ticket 的后续 Assignment**：复用；不重新 prepare。
- **跨 Ticket 复用**：默认不复用。只有同时满足以下条件才允许（Phase 3，显式操作）：
  1. 前一个 Ticket 已结束且租约已释放；
  2. 空间已 reset/verify（干净、分支归位、无残留进程）；
  3. 新 Ticket 明确接受该空间（E2 操作或部署策略），而不是按目录存在自动复用；
  4. PR/分支状态允许（没有未关闭的同分支 PR 冲突）。
- **同 Ticket 的 warm/复用**：复用同一空间、同一 Session，但清空本轮上下文，不改变 Ticket 目标。**跨 Ticket 的 warm 复用**必须等 T3-13 的租约/空间 reset：**释放租约 → reset 空间 → 重置/重建 Session → 新 Ticket 获取租约**；不能把带着旧 Ticket 目标和历史的 Session 直接指到新空间。

### 3.5 空间选择决策表

| 情形 | 空间 | 租约 | Session | 分支/PR |
| --- | --- | --- | --- | --- |
| lightweight 只读小活 | 无空间 | 无 | 主 Session inline | 无 |
| tracked 只读调查/答复 | `project` 只读（Phase 2 起）或该 Ticket `checkout` 只读（Phase 1）；也可 `root` 只读 | 读声明 | 该 Ticket worker | 无 |
| tracked 代码修改/PR | 新建 `checkout`（从项目基线派生） | 写，独占 | 该 Ticket worker | `agent/<ticket>`，根 Ticket 开 PR |
| tracked 文档/数据落盘，无 VCS | 新建 `scratch` | 写，独占 | 该 Ticket worker | 无 |
| 子 Ticket 写代码/文件 | 新建自己的 `checkout`/`scratch`（兄弟目录） | 写，独占 | 子 worker | 委派草稿分支；不直接开 PR |
| 子 Ticket 只读父在制品 | 只读挂载父 `checkout`（条件满足时）或读 `project` | 读声明 | 子 worker | 无 |
| 同一 Ticket 重试/追问 | 复用原空间 | 写，重入 | 原 Session | 原分支/PR |
| 同一项目第二个 live Ticket | 新建独立 `checkout` | 写，独占 | 新 worker | 各自分支；父/人负责合并 |
| 前一个 Ticket 已结束的后续工作 | 默认新建；显式复用需 reset/verify | 写，独占 | 新/重置 Session | 按新 Ticket 分支 |
| 跨仓库/跨项目任务 | 改绑唯一写空间到实际目标仓库；prepared 目录只读/落地；同时写两仓则拆子 Ticket | 写，独占 | 该 Ticket worker | 按目标仓库分支 |
| 审阅一个 PR | `project` 只读；或 detached/snapshot 的指定修订；不能直接读 live checkout 来获得已提交修订 | 读或写 | 审阅 worker | 不推送 |
| 根空间维护 | `root` | 无/维护 | 主 Session | 无 |

### 3.6 冲突与抢占规则

1. **写者冲突**：目标空间已有写租约 → 新 Assignment 停在 `working / queued`，原因写 `spaceLeaseHeld`（持有者的 Ticket 标题，不显示内部 id/path）；不占 worker 槽，不自动失败。
2. **只读者遇到写者**：`checkout` 上读与写互斥，后来者排队（`spaceReadHeld` / `spaceLeaseHeld`），不允许把「正在写」的检出当作稳定输入；项目基线的多读者可继续，维护写等待。只有基线读才在 UI 标「可能变动」。
3. **人工抢占**：E2 操作「停止旧 worker → 释放租约 → 新 holder 获取」；不能在旧 worker 仍在写时并发转移。抢占要记审计（谁、何时、为什么）。
4. **过期租约**：host 重启/崩溃后，租约带 `epoch`；恢复时若没有对应活 Session，标 `stale` 并允许重新获取；若无法判断，停在 `blocked` 请人决定，不静默抢占。
5. **父子冲突**：旧嵌套布局下，父的 `git clean`/删除可能破坏子空间；Phase 2 前在文档与提示中明确禁止，Phase 2 起新子空间不再嵌套；旧布局不自动迁移，发现时在 E2 标「旧布局」。
6. **合并冲突**：不同 `checkout` 改同一文件是正常的 VCS 合并冲突，由父 owner/人解决；空间租约只防同一检出并发写，不防跨检出的语义冲突。

## 4. 生命周期

### 4.1 状态机

```text
planned → preparing → ready → leased
             ↘ failed      ↘ shared → ready
ready → reusable → reclaimed
leased → stale → ready（恢复/释放后）或 reclaimed（人工清理）
failed → preparing（重试）或 reclaimed（人工清理）
```

- `planned`：已写入 `Execution` 引用，目录尚未创建。
- `preparing`：prepare 运行中；超时/失败 → `failed`（Ticket 失败，不自动重试）。
- `ready`：目录存在、通过校验，没有租约；可从 `leased`/`shared`/`stale` 释放或恢复而来。
- `leased`：有写租约，holder 是 Ticket。
- `shared`：有只读声明；只允许基线/无写者/只读快照；释放回到 `ready`。
- `reusable`：租约已释放且 reset/verify 通过；可被同一 Ticket 或显式复用。
- `reclaimed`：目录已移除，元数据保留用于审计；不可再租用。
- `stale`：租约的 host/epoch 与当前进程不匹配，且没有活 Session；等待恢复或人工处理，不自动抢占。

转移的触发：

| 从 | 到 | 触发 |
| --- | --- | --- |
| `planned` | `preparing` | 首次 launch |
| `preparing` | `ready` | prepare + 校验通过 |
| `preparing` | `failed` | prepare 失败/超时 |
| `failed` | `preparing` | 重试（人或后续 Assignment） |
| `failed` | `reclaimed` | 人工清理非空目录 |
| `ready` | `leased` | 获取写租约 |
| `ready` | `shared` | 只读声明 |
| `leased` | `ready` | Ticket 结束/人工释放 |
| `shared` | `ready` | 释放只读声明 |
| `leased` | `stale` | host/epoch 不匹配且无活 Session |
| `stale` | `ready` | 恢复后释放/重新获取前 |
| `stale` | `reclaimed` | 人工确认后清理 |
| `ready` | `reusable` | reset/verify 通过 |
| `reusable` | `reclaimed` | 回收执行 |

### 4.2 创建与校验

- **创建仍由 `executor.prepare` 负责**；本设计不引入新的创建入口。prepare 的契约从「目录存在即可」升级为「准备后声明空间类型、分支/修订、写租约」。
- **Phase 2 的 prepare 后置条件**（建议）：
  1. `locator` 存在且可访问；
  2. 若是 VCS 空间，分支/修订与声明一致，且该分支没有在另一个 worktree 检出；
  3. 没有别的活写租约；
  4. `verifyDirectory` 通过（凭据卫生）；
  5. 记录 `WorkspaceRef` 与创建事件；若任务实际写空间与 prepared 目录不同，显式改绑并记录原因，不静默使用。
- **身份与收养**：Phase 1 只用投影 id（可由 directory 派生），不持久化；Phase 2 才建注册表。`identityKey` 由 provider 计算。`local-git` 用 `realpath(worktree root)`（同时记录 git common dir 作为仓库归属），`local-dir` 用 `realpath`；大小写/符号链接先归一。注册表对 `(provider, identityKey)` 唯一。旧 `execution.directory` 首次启动时计算 key：命中则绑定；未命中则创建 `legacy:true` 的 checkout，不移动/不 reset。同一 key 的第二个 Ticket 获取写租约时排队——T3-13 的验收就用这个 key 断言「同空间」。planned 阶段用规范绝对路径，创建后校准；路径改名必须走显式 `relocate`，不能只改字符串。
- **已存在目录**：Phase 1 保持现状（视为已准备）；Phase 2 改为「先查空间注册表，再校验；没有注册的旧目录按 legacy 收养，不直接当新空间」。这修复 P5，同时兼容现有 worktree。
- **prepare 失败**：保持「Ticket 失败、不自动重试、空目录删除、非空保留」；失败信息要说明是命令失败还是校验失败。

### 4.3 租用与释放

- 获取写租约的时机：**在 prepare 之后、worker 启动之前**；如果租约被占，Assignment 排队，不占 worker 槽。
- 释放时机：Ticket 结束（completed/dropped/stopped）后，先停止后台工作，再释放。`ready` 待审阅的 Ticket **尚未结束**，因此保留写租约（人可能要求返工）；当它结束（PR 合并/关闭、验收完成，或部署在无 PR 时 ready 即结束）时释放。若人要求返工，Ticket 仍活，租约继续。
- 失败/阻塞的 Ticket：保持租约（可能重试/人工继续）；只有 Ticket 结束或人工释放才释放。
- 同一 Ticket 的重入：同一 `holder.ticketId` 的 Assignment 可重入，不阻塞自己；`holder.assignmentId`/`sessionId` 随当前执行者更新，租约本身不换手。
- 续期与过期：worker 每轮开始/结束与运行中每 60 秒续期，TTL 5 分钟。活 Session 存在时不自动过期；只有 host/epoch 不匹配且无活 Session 才标 `stale`。新 holder 获取时 `epoch + 1`，旧 epoch 租约作废；不做文件系统级 fencing，旧进程的写入仍可能发生，必须靠停止/恢复/审计处理。
- 释放必须幂等；重复释放无副作用；释放后空间进入 `reusable` 前要 reset/verify。

### 4.4 回收与保留

- 默认保留策略：`checkout` 在 PR 关闭/交付接受后保留 **7 天**（可配置），供人复查与返工；`scratch` 保留 **1 天**；`project` 长期保留；`root` 不回收。
- 回收条件：Ticket 已结束、租约已释放、无未关闭 PR、无脏文件、无后台进程；任一不满足则保留并标原因。
- 脏空间：不自动删除；在 E2 显示「可回收但有未提交改动」，需要人工确认（或导出补丁后删除）。
- 子空间：子 Ticket 被父接受/取消后进入保留/回收；父在合并期可只读挂载子分支。
- 回收动作优先用 provider 的 `remove`（如 `git worktree remove` + `git worktree prune`），不要直接 `rm -rf` 一个 git worktree；失败要保留元数据并告警。
- 审计：空间 id、Ticket、分支/修订、创建/释放/回收时间、最后提交、是否脏，保留在状态存储；目录可以删，审计骨架不删。

### 4.5 重启与恢复

- 租约带 `epoch`/`host`/`expiresAt`；`expiresAt` 只用于发现孤儿，活 Session 不会因 TTL 被抢。重启后对每个 live Ticket：
  1. 读空间引用；目录存在则校验，缺失则按 prepare 规则重建；
  2. 若租约持有者是本进程且 Session 已恢复 → 保持；
  3. 若没有活 Session/Assignment 且 host/epoch 不匹配 → 标 `stale`，新 Assignment 可获取；
  4. 若无法判断（例如目录被外部进程占用）→ `blocked`，请人决定。
- 恢复顺序：父先于子（现有 `resume` 已按深度排序）；孤儿子 Ticket 仍按现有 `orphanChild` 规则交人。
- 恢复不自动删除/重置任何空间；reset 是显式动作。旧 epoch 的 worker 若仍活着，先 E2/人工停止，不能与新 holder 并发写。

## 5. 并发、隔离与可见性

### 5.1 并发模型

- **计算并发**：`WorkerSlots` 管 worker 数；空间租约不替代它。
- **数据并发**：写租约管同一空间；不同空间并发写同一仓库是允许的，冲突在合并时解决。
- **执行点**：租约在「获取空间 / 启动 worker」时检查，不是每条命令的沙箱；worker 仍可用绝对路径读写别的目录。读写互斥是协调与审计语义，不是强制隔离。
- **获取顺序**：先租空间，再占 worker 槽；租约等待期间不占槽，避免「占着槽等目录」拖垮并发。
- **死锁**：本设计一个 Ticket 只有一个写空间，不存在多写空间排序；要同时写两个仓库就拆子 Ticket（见 3.2）。只读声明可随时释放，不参与死锁。
- **父子并发**：默认独立空间，可并行；父的合并/审阅在子结束后进行。旧嵌套布局下，父子并行被视为高风险，E2 标警告。
- **warm 池**：复用 Session 前必须释放/重置空间；池中的 Session 不持有任何空间的写租约。

### 5.2 隔离级别

| 级别 | 含义 | 现状/计划 |
| --- | --- | --- |
| `exclusive` | 一个写者，其他只读或等待 | 默认 `checkout`/`scratch` |
| `shared-read` | 多读者，无写者（或只读快照） | `project` 基线、已结束的交付分支 |
| `ephemeral` | 用完即弃，短保留 | `scratch` |
| `sandbox` | OS/容器级隔离 | **不在本设计**；属于部署/多租户（docs/012 M4） |

**必须反复说明**：`exclusive` 是协调语义，不是安全隔离。worker 仍能越界读写；子 Ticket 的 shell guard 只是工具级限制。不要把「独立空间」宣传成「安全沙箱」。

### 5.3 可见性

- **E0 默认面**：不出现空间名、路径、租约、分支；只出现目标/状态/需决定/结果。
- **E1 任务详情/审查面**：显示空间区块（类型、显示名、分支、状态、持有者 Ticket 标题、最后活动）；不显示内部 id、绝对路径、Session id；需要时提供「复制路径/打开目录」到 E2。
- **E2 管理面板**：只读「空间」视图；显示 locator、租约、epoch、stale、回收资格；这是排障/审计面。
- **E3 原始面**：Session 记录、日志、实际目录；明确进入，遵守隐私与脱敏。
- **冲突是例外**：只有「需要人决定/无法继续」的租约冲突才进入 E1/E0 的阻塞原因，且只给 Ticket 标题与「同一空间被占用」的事实，不给路径。

## 6. UI 交互

### 6.1 原则

1. **空间不是任务层级**：任务树/任务列表不出现空间节点，不画「父空间 → 子空间」的树。
2. **默认不显示**：E0 零空间元素；E1 只在详情里一块；E2 按需打开。
3. **先只读**：Phase 1 只显示，不提供写操作；Phase 2 才开放释放/回收/复用，且全部在 E2。
4. **不伪造**：lightweight 不显示空空间；没有分支的 `scratch` 不显示分支；没有租约不显示「持有者」。
5. **词表稳定**：界面用「空间 / 代码检出 / 项目基线 / 临时目录 / 写租约 / 只读」；内部 id、`workspace-`、绝对路径不进默认面。

### 6.2 E1 任务详情的「空间」区块

建议布局（文字线框）：

```text
空间
  类型      代码检出
  名称      widgets（显示名；完整目录名/路径只在 E2）
  分支      agent/workspace-84b6e789923d
  状态      进行中 · 写租约
  持有者    本任务
  最后活动  2 分钟前
  [在 E2 查看]（只读）
```

规则：

- E1 只读：释放/回收/复用都在 E2，且 Phase 2 才出现。
- 子 Ticket 显示「由父任务 <标题> 审阅」，不显示父目录路径；旧嵌套布局加「旧布局」标签与 E2 警告。
- `ready` 待审阅时状态显示「待审查 · 保留中」，并说明保留到 PR 关闭 + 保留期。
- 冲突时显示「另一个任务正在写入同一空间，已排队」或「空间准备失败」，并提供 E2 入口；不显示对方路径。
- lightweight 详情显示「轻量执行：无独立空间」一句，不显示空的租约/分支字段。
- 默认不显示空间区块的折叠标题；只有打开任务详情才出现，不新增通知。

### 6.3 E2 管理面板的「空间」视图

**位置**：管理面板新增一个只读视图（可作为 Execution 页的一个 section，或独立「空间」tab；Phase 1 先 section，避免七个 tab 变八个）。**不进入右栏**，不进入主会话默认面。

**列表字段**：

| 字段 | 内容 | 说明 |
| --- | --- | --- |
| 空间 | 显示名（Ticket 短名/项目名，可去掉 id 后缀） | locator 只在展开详情或「复制路径」时出现（E2） |
| 类型 | 代码检出/项目基线/临时目录/根空间/子目录视图 | `kind` 映射 |
| 项目/仓库 | 来源仓库显示名 | 多项目时区分 |
| 分支/修订 | 分支名或短 commit | 无则不显示 |
| 持有者 | Ticket 标题 + 状态 | 不显示 Ticket id |
| 模式 | 写 / 只读 | 租约 |
| 状态 | 准备中/就绪/进行中/待审查/可回收/过期/冲突 | 状态机映射 |
| 最后活动 | 相对时间 | 来自 activity/trace |
| 操作 | 释放/回收/复用/复制路径 | Phase 2，需确认 |

**视图与交互**：

- **筛选**：类型、状态、项目、仅看冲突/过期、仅看可回收。
- **「谁在做什么」**：默认按空间分组，展开显示该空间当前的 Ticket/Assignment/worker 状态与最后活动；不显示命令内容（E3），需要时再进 Session。
- **按空间分组**：完整任务页可切换「按任务 / 按空间」；默认按任务。分组只是镜头，不改变任务树，不产生拖拽/移动。
- **创建**：默认由 prepare 自动创建；E2 只提供「新建临时目录」这类运维操作，不提供「给任意任务新建检出」的绕过入口。
- **复用**：E2 对可复用空间显示「复用给任务…」，要求选择任务、确认 reset/verify、记录审计；默认不自动跨 Ticket 复用。
- **回收**：单条确认，显示脏/PR/后台进程状态；不提供批量删除；脏空间必须先确认/导出。
- **空态**：无空间时显示「还没有独立空间；受理工单会自动创建」；无冲突时显示「没有空间冲突」；可回收时显示数量与入口。
- **响应式**：360px 右栏不出现空间视图；完整页表格在窄屏改为卡片，字段不横向溢出；键盘可达；颜色不是唯一状态标识。

### 6.4 注意力成本

| 新增元素 | 受众 | 注意力成本 | 替换/避免 | 为什么不能只按需 |
| --- | --- | --- | --- | --- |
| E1 空间区块 | 打开任务详情的人 | 低（一块只读信息） | 不替代现有内容；不新增通知 | 审查时需要知道「在哪、谁在用」；没有它就得翻目录 |
| E2 空间视图 | 运维/排障者 | 中（多一个入口） | 不进入 E0/E1 默认面 | 排障/回收必须能看全量；默认面不能承担 |
| 租约冲突提示 | 需要决定的人 | 例外才出现 | 不新增通知类型；复用阻塞原因 | 没有它，冲突会表现为「卡住」 |
| 「按空间分组」 | 完整任务页用户 | 可选，默认关 | 不改变任务树默认 | 跨任务看「谁在做什么」时才需要 |

**不新增默认通知**：空间事件只入库/进 trace，不推送；只有阻塞/需要人决定时，按现有 Report/Attention 规则进入默认面。

### 6.5 明确不做的界面

- 任务树中的空间节点、空间父子树、空间泳道默认视图；
- 把任务拖到空间、把空间当项目/分组、空间级成员/权限；
- 默认显示绝对路径、Session id、`worker-` 前缀、租约 epoch；
- 为每个空间自动开一个面板 tab；
- 用空间状态替代 Ticket 状态或授权状态。

## 7. 与 docs/011 原则的关系与冲突取舍

### 7.1 逐条对照

| 原则 | 本设计的关系 | 取舍 |
| --- | --- | --- |
| **A 注意力是瓶颈** | 空间是执行细节；E0 不出现；E1 只给审查所需的一块；E2 才给全量；冲突是例外 | 不新增默认通知；空间视图默认关闭；「一个结果一条通知」不变 |
| **B 组织与执行默认内部** | 空间是内部执行事实，不是组织架构；任务树/空间图都不该成为默认叙事 | 空间视图放 E2；不把「按空间分组」做成默认任务树；信任阶段只读 |
| **C 可组合的六层上下文** | 空间是「agent」维度里工作目录的载体，不是第七层；`subdir` 是路径视图，不是新维度；轻量无空间时该维度缺席 | 不新增上下文维度；空间不参与授权装配；子 Ticket 只拿根上下文 + 子目标，不继承父的私有空间内容（只读挂载是显式例外） |
| **D 可替换边界** | provider/locator/租约/回收属于执行边界，可替换；Ticket/Assignment/Projection 三个窄接口不变 | 不把目录布局写进领域契约；kernel 只看到引用；删除/替换 provider 不改变授权与验收 |
| **安全与授权不变量** | 空间/租约不改变 Mandate、Action、Approval、Acceptance | 目录不是安全边界；真正的隔离是 OS/租户，不在本设计 |
| **可观测性优先** | 空间事件进 trace/activity；E2 可查；默认不推送 | 记录优先，展示分级 |

### 7.2 与 012 的 workspace handle

[012](012-platform-evolution.zh.md) §5.1 把 `Workspace` 列为 Reference 层新概念，§6.6 提出统一句柄 `{ read, write, exec, url }`，并让 `Run` 变成 `{ workItemId, mode, sessionRef?, workspaceRef }`。本设计与之兼容，但做三点收敛：

1. **不把 Workspace 做成领域聚合**：它是执行引用；Ticket 不直接持有 workspace 字段，`Execution` 里保存 `WorkspaceRef`（可先 additive，后替换 `directory`）。
2. **不引入新的 `Run` 实体**：现有 `Assignment` 就是 run；warm/inline 是执行方式，不是新的持久聚合。空间租约按 Ticket 持有，`holder.assignmentId`/`sessionId` 只是当前执行者元数据。
3. **句柄先做本地最小实现**：`{ locator, kind, provider }` + 租约/回收；`{ read, write, exec, url }` 作为 Phase 4 的 provider 接口，不在 Phase 1 造抽象层。

### 7.3 与 003「一工单一 Session 一目录」的冲突

- 保留「一 Ticket 一 Session」与「一 Ticket 一主目录」，但把「目录」重述为「写空间的 locator」；一个 Ticket 可以有只读空间，但只有一个写空间。
- 子 Ticket 的目录从「父目录内」改为「执行根下的独立兄弟目录」（平铺，名字含父名）；这是行为变化，放在 Phase 2 并用 flag/兼容旧布局。prepare 的 cwd 随之从父目录变为执行根，相对路径命令要迁移。003 在执行层面仍成立：每个 tracked Ticket 有自己的 Session 和目录。
- lightweight 仍无空间；003 的轻量边界不变。

### 7.4 与 011 B/C/D 的潜在冲突

| 冲突 | 裁决 |
| --- | --- |
| 空间视图会不会把执行细节推到默认面？ | 不会：只在 E1 详情与 E2 面板；右栏不加 tab；默认不通知 |
| 空间会不会变成第七层上下文？ | 不会：它是 agent 维度的工作目录载体；`subdir` 是视图；轻量缺席 |
| 空间图会不会变成新的组织树？ | 不会：不画空间层级、不拖拽、不做空间权限；空间图只是引用关系 |
| 可替换 provider 与分支/PR 绑定会不会冲突？ | 分支/PR 是 `checkout` provider 的可选属性；provider 不提供 VCS 时就没有分支/PR，但 Ticket/交付/审计仍成立 |
| 目录隔离会不会被当成安全边界？ | 明确否定；安全隔离是 OS/租户/沙箱的独立工作；租约只防误写 |

### 7.5 方案取舍

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| A. 现状：路径即空间 | 零改动 | 无法共享/独占/回收；父子嵌套风险 | 保留为兼容基线，不扩展 |
| B. 空间引用 + 写租约（本设计） | 冲突可解释；生命周期可控；provider 可替换；改动渐进 | 需要注册表/租约/UI；Phase 2 有行为变化 | **推荐** |
| C. 空间作为领域聚合 + 权限 | 表达力强 | 复制授权、schema/迁移成本高、与 Ticket 边界冲突 | 暂不采用；未来若多租户需要，另立设计 |

## 8. 分阶段落地与迁移影响

### 8.1 Phase 0：词汇与现状（本 PR）

- 交付：本文；在 [TASK-PLAN](plan/TASK-PLAN.zh.md) 增加 T3-12/T3-13，在 [TRACKING](plan/TRACKING.zh.md) 建行；不改变代码/数据/UI。
- 验收：`tests/docs.spec.ts`、`pnpm check:tracking`；独立 review 结论写成 PR review 评论。
- 回退：删除文档与计划行即可。

### 8.2 Phase 1：只读投影与 E2 视图（T3-12，约 4 人日）

- 交付：
  - `Execution` 的只读投影 `workspace: { kind, name, locator?, branch?, state, holder?, legacy? }`，从现有 `execution`/Assignment/Session 派生；`kind` 在 Phase 1 只保证 `root`/`checkout`/`unknown`，不伪造 `project`；**不新增 schema**，lightweight 不伪造；
  - `GET spaces`（管理 API，只读）与 E2「空间」section/只读列表；
  - E1 任务详情空间区块（只读）；
  - feature flag `workspace.view`，关闭即回旧界面；
  - 文档：003 补空间 locator 与父子 prepare cwd 的事实；006 补配置说明（不改变默认）。
- 验收：
  - 根/子/旧嵌套/lightweight 四类投影正确；子 Ticket 显示持有者与「旧布局」；
  - 360px 右栏不出现空间视图；E0 无空间元素；
  - 无 schema 变化、无写接口、无租约行为；
  - `tests/spaces.spec.ts`、`tests/panel-spaces.spec.tsx`、`pnpm check`；
  - 若新增可见 UI，PR 需同场景 Before/After 截图（Phase 1 实现时执行）。
- 回退：关 flag；删除只读端点/视图。

### 8.3 Phase 2：写租约与子 Ticket 独立空间（T3-13，约 7 人日）

- 交付：
  - 空间注册表与租约（additive schema，例如 `space` + `space_lease` 表；只加表/索引，不改旧记录）；
  - 执行器在 prepare 后获取写租约、Ticket 结束时释放；冲突排队/`spaceLeaseHeld`/stale 恢复；租约按 Ticket 持有，Assignment 只更新当前 holder 元数据；
  - 子 Ticket 新空间放执行根下的兄弟目录（平铺）；旧嵌套目录按 legacy 收养，不自动搬迁；prepare cwd 变化要写迁移说明并演练；
  - prepare 后置校验（分支、脏状态、无其他写者、凭据卫生）；
  - E2 释放/回收/复用操作（需确认、审计）；
  - 文档 003/006 更新。
- 验收：
  - 两个 Ticket 指向同一空间（同 `identityKey`）：第二个排队，不覆盖；同一 Ticket 重试可重入；
  - 父/子默认不同目录；父清理不会删除子空间；旧嵌套有警告；
  - 重启后 stale 租约恢复；不静默抢占；父先于子恢复；
  - 子 Ticket 仍不能推送/开 PR；父整合子分支；
  - `tests/spaces.spec.ts`、`tests/runtime-concurrency.spec.ts`、`tests/migration.spec.ts`、`tests/panel-spaces.spec.tsx`、`pnpm check`；
  - 迁移演练：旧库/旧 worktree 按 `identityKey` 正常收养，无重复 prepare；子空间 prepare cwd 改为执行根后，相对路径命令的迁移结果符合预期。
- 回退：两个独立 flag——`workspace.lease` 关闭回到路径模式，`workspace.childSibling` 关闭保留旧嵌套布局；additive 表保留不影响旧读；不删除旧目录。

### 8.4 Phase 3：复用、回收与 warm 池（约 5 人日，可与 T3-06 合并）

- 交付：reset/verify、保留策略与 GC、E2 回收队列、warm 池空间释放/重置契约、metrics（空间数/字节/冲突/过期/回收/脏空间）。
- 验收：同 Ticket 的 5 个小活从第 2 个起冷启动为 0；跨 Ticket 的 warm 复用必须在 T3-13 后单独验收（否则不得声称）；GC 后进程/目录回落；脏空间不自动删除；PR 未关闭不回收；`tests/spaces.spec.ts` 增用例。
- 回退：关 GC/复用 flag；保留手工回收。

### 8.5 Phase 4：provider 与云端（后续，不排期）

- 交付：`WorkspaceProvider` 接口（`create/verify/read/write/exec/url/reset/remove`）、本地 `local-git`/`local-dir` 实现、云端/桶的适配；核心不依赖本地路径。
- 验收：同一组租约/回收/审计契约在本地与一个远端 provider 上通过；没有 provider 时降级为本地目录；不改变默认 UI。
- 回退：provider 配置切回本地；远端空间只读或保留，不丢审计。

### 8.6 迁移影响

| 对象 | 影响 | 迁移 |
| --- | --- | --- |
| 现有 worktree | 视为 legacy `checkout`；路径不变 | Phase 2 首次启动时按 `identityKey` 收养并校验；不移动/不重置 |
| 旧嵌套子目录 | 保留；父清理风险仍在 | 标「旧布局」；新子 Ticket 用执行根下的兄弟目录；不自动搬迁 |
| `executor.prepare` | 命令签名不变；后置条件更严；子 Ticket 的 cwd 从父目录变为执行根 | 保持默认；Phase 2 增加校验与迁移演练，相对路径命令要改成绝对路径或基于 `$DSH_SUPERAGENT_DIR` |
| 分支/PR 绑定 | 不变 | 仍看分支最后一段；空间记录作为补充 |
| Session | 仍固定到空间；warm 复用需重置 | Phase 3 实现；Phase 1/2 不做跨 Ticket 复用 |
| schema | Phase 1 无；Phase 2 additive 表 | 旧库直接打开；不重写旧记录；回退保留表 |
| 配置 | 新增可选 `executor.workspace.*`（保留天数/provider）与 flag `workspace.lease`/`workspace.childSibling` | 默认值保持现状；不配置即旧行为 |
| 文档 | 003/006 在 Phase 2 更新；013 为提案 | 实现前不把提案写成现状 |
| 测试 | 新增 spaces/panel/migration 用例 | 现有 1600+ 测试保持通过 |

### 8.7 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 租约悬空/误判 | Ticket 卡住或两个写者 | epoch + 心跳 + stale 恢复；无法判断时请人决定 |
| 旧嵌套目录被父清理 | 子工作丢失 | 文档/提示禁止；新布局兄弟目录；E2 警告；不自动 `git clean` |
| GC 删掉未交付工作 | 不可逆 | 脏/PR/后台检查；人工确认；保留元数据 |
| 目录隔离被误当安全 | 安全预期错位 | 文档反复声明；OS/租户隔离另做 |
| 空间视图增加注意力 | 默认面变吵 | 只在 E1/E2；flag；不做默认通知 |
| provider 抽象过早 | 复杂度上升 | Phase 1/2 只做本地最小实现；Phase 4 才抽象 |
| 跨 Ticket 复用引入上下文污染 | 旧目标/历史泄漏 | 先释放、reset、重建 Session；显式操作 |

## 9. 开放问题与建议

| # | 问题 | 建议 | 需要谁决定 |
| --- | --- | --- | --- |
| Q1 | 空间是领域实体还是执行引用？ | 执行引用；不进 kernel 授权 | 架构评审 |
| Q2 | 一个 Ticket 是否允许两个写空间？ | 不允许；跨仓库改绑唯一写空间，或拆子 Ticket；多仓库 `project` 待 Phase 4 | 产品/架构 |
| Q3 | 子 Ticket 默认共享父空间吗？ | 不共享；写则另开，只读可挂载 | 产品/架构 |
| Q4 | 跨 Ticket 复用默认开启吗？ | 默认关闭；显式 E2 操作 + reset | 运维/产品 |
| Q5 | 保留期默认多少？ | checkout 7 天、scratch 1 天，可配 | 运维 |
| Q6 | 根空间是否允许写用户文件？ | 目标不允许；Phase 1/2 无强制，需决定 operator audit/审批方式 | 产品/安全 |
| Q7 | 租约存表还是 KV？ | 存表（可查询/可审计）；Phase 2 additive | 实现评审 |
| Q8 | 只读挂载 live 检出是否允许？ | 不允许读 live checkout 取已提交修订；用基线或 detached/snapshot | 实现评审 |
| Q9 | 子目录是否可成为写空间？ | 不单独；作为 checkout 的 scoped cwd/view | 实现评审 |
| Q10 | 云端 provider 优先级？ | Phase 4 再定；先本地 | 产品 |
| Q11 | 空间命名用「空间」还是「工作空间」？ | 界面短称「空间」，文档/代码用 WorkspaceRef | 文案 |
| Q12 | 租约过期/抢占策略？ | 活 Session 不自动过期；host/epoch 不匹配才 stale；不做 FS fencing | 实现评审 |
| Q13 | 根写入如何强制与审计？ | 目标规则；强制/审批方式待定，Phase 1/2 不声称已强制 | 产品/安全 |

## 10. 术语表

| 术语 | 含义 | 不用于 |
| --- | --- | --- |
| 空间 / 工作空间 | 一次工作发生的位置 + 访问方式 + 修订 + 租约 | 任务层级、授权主体、沙箱 |
| 空间句柄 / `WorkspaceRef` | 持久化引用（id/identityKey/kind/provider/locator/revision/owner） | 用户默认面 |
| 项目基线 | 共享只读克隆/缓存 | 每 Ticket 的写空间 |
| 代码检出 | 每 Ticket 的 VCS worktree | 共享写空间 |
| 临时目录 | 每 Ticket 的非 VCS 工作目录 | 长期项目空间 |
| 子目录视图 | 另一个空间的路径视图 | 新的任务层级 |
| 写租约 | 某 Ticket 对某空间的独占写权；holder 含当前 Assignment/Session | 授权/动作等级 |
| 只读声明 | 声明读某空间，不取写权 | 一致性快照保证 |
| 回收 | 删除目录、保留元数据 | 删除审计 |
| legacy / 旧布局 | 子目录嵌套在父目录内的既有空间 | 新空间默认 |
| identityKey | 判重用的规范身份；local 用 realpath/git common dir | locator（可读路径） |

## 附录 A：现状证据索引

| 事实 | 位置 |
| --- | --- |
| 系统根/执行根 | `packages/dsh/src/app/execution-environment.ts`（`systemRoot`、`executionRoot`） |
| 每 Ticket 的 `execution` 与目录命名 | `packages/dsh/src/executor/dsh.ts`（`ticketExecution`） |
| prepare 在父目录运行、已存在即已准备、失败不重试 | 同上（`prepareDirectory`、`launch`）；[docs/003](003-execution.md) |
| 目录凭据卫生校验 | `packages/dsh/src/infra/environment.ts`（`verifyDirectory`） |
| 子 Ticket 目录嵌套 | `packages/kernel/src/tickets.ts`（`delegate` 的 `childExecution`） |
| 子 Ticket 的 shell 限制 | `packages/dsh/src/app/sessions.ts`（`childShellReason`、`workOnly`） |
| lightweight 无空间 | `packages/dsh/src/executor/inline.ts`；[docs/003](003-execution.md) |
| Session 创建/工作目录 | `packages/dsh/src/app/sessions.ts`（`ensure`） |
| Worker 槽/并发 | `packages/dsh/src/executor/dsh.ts`（`WorkerSlots`） |
| 任务投影暴露 `execution.name`/assignments/sessionId，未暴露 directory | `packages/dsh/src/app/tasks.ts` |
| 012 的 workspace handle 与三层执行 | [012-platform-evolution.zh.md](012-platform-evolution.zh.md) §5.1、§6.6 |
| 011 的 E0–E3、六层上下文、执行边界 | [011-design-principles.zh.md](011-design-principles.zh.md) §2、§4.3、§5.2 |

## 附录 B：接口草案（非实现）

```ts
type SpaceKind = 'root' | 'project' | 'checkout' | 'scratch' | 'subdir' | 'remote'

interface WorkspaceRef {
  id: string
  identityKey: string          // provider 规范身份；唯一索引 (provider, identityKey)
  kind: SpaceKind
  provider: string
  locator: string
  revision?: { branch?: string; base?: string; commit?: string }
  owner: { kind: 'system' | 'project' | 'ticket'; ticketId?: string; rootTicketId?: string }
  retention?: 'transient' | 'review' | 'audit'
  lineage?: { derivedFrom?: string; createdBy?: string }
}

interface SpaceLease {
  spaceId: string
  mode: 'write' | 'read'
  holder: { ticketId: string; assignmentId?: string; sessionId?: string }
  host: string
  acquiredAt: string
  renewedAt: string
  expiresAt: string
  epoch: number
  state: 'active' | 'released' | 'stale' | 'revoked'
}

interface WorkspaceProvider {
  create(ref: WorkspaceRef): Promise<void>
  verify(ref: WorkspaceRef): Promise<{ ok: boolean; detail?: string }>
  reset(ref: WorkspaceRef): Promise<void>
  remove(ref: WorkspaceRef): Promise<void>
  url(ref: WorkspaceRef): string | undefined
  relocate?(ref: WorkspaceRef, next: string): Promise<void>
  snapshot?(ref: WorkspaceRef, rev: string): Promise<WorkspaceRef>
}
```

接口边界：`WorkspaceProvider` 在 runtime，不进 kernel；kernel 的 `Execution` 只保存引用（Phase 1 先 additive），不依赖本地路径语义。租约的获取/释放由 Executor 调 runtime 服务，不进入授权闸门。

## 附录 C：决策记录

| 日期 | 决策 | 理由 | 状态 |
| --- | --- | --- | --- |
| 2026-11-09 | 空间是执行引用，不是领域聚合 | 避免复制授权/schema 成本；与 012 的 Reference 层一致 | 提案 |
| 2026-11-09 | 一 Ticket 一写空间；子 Ticket 默认另开 | 修复父子嵌套；保持任务树与空间正交 | 提案 |
| 2026-11-09 | 空间身份用 `identityKey`（realpath/git common dir）判重，旧目录按 key 收养 | 让「同空间」可测；路径不是身份 | 提案 |
| 2026-11-09 | 跨仓库改绑唯一写空间；同时写两仓拆子 Ticket | 不引入第二写空间/排序；多仓库 provider 后续 | 提案 |
| 2026-11-09 | 租约按 Ticket 持有，Assignment 只是当前 holder；活 Session 不因 TTL 被抢 | 跨 Assignment 重入；避免误抢占 | 提案 |
| 2026-11-09 | 子 Ticket 空间平铺到执行根下；prepare cwd 变为执行根 | 目录与任务树正交；需迁移相对路径命令 | 提案 |
| 2026-11-09 | 写者唯一 + 只读声明；lane 不等于安全边界 | 冲突可解释；不夸大隔离 | 提案 |
| 2026-11-09 | UI 只在 E1/E2；任务树不画空间 | 符合 011 A/B | 提案 |
| 2026-11-09 | 分阶段、additive、旧 worktree 收养 | 保护现有 1600+ 测试与部署 | 提案 |