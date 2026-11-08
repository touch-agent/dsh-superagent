# 任务视图架构设计（提案）

> 状态：**设计提案，未实现**。这份文档只回答「任务视图应该长成什么、数据从哪里来、和现有工单/事件/会话/交付物怎么接」，不包含业务代码改动。
>
> 依据：2026-11-08 用户对「状态 › 任务」页面的反馈——右侧栏应像事件视图一样有任务视图；用户要从任务视角看到跨源事件最终规划、合并、执行了哪些任务，关系、执行者、会话、产物是什么；任务可再拆分，默认关心 2–3 级；第一级应是由多个事件归纳、可人工修改的任务类别；形态可以有树、图、看板。
>
> 参考：本地原型 `~/.dsh/bot/workspace/prototype/tasks.html`、`task.html`、`task-chat.html`、`activity.html`，以及同目录的《任务地图与交付模型设计》《对话与任务融合设计》。参考的是信息结构，不照抄视觉。
>
> 修订：2026-11-08 PR #26 评论指出，任务应是多层树/图，每个任务节点有自己的 worker；父 worker 能动态创建子任务，并负责最终目标、交付物审查、合并与冲突解决。本稿据此增加“子任务（Subtask）”模型与父子执行契约；`Ticket` 仍是唯一的授权聚合，子任务不另开授权。#29 合入后，worker 只属于 tracked 节点（Ticket/Subtask）；lightweight Ticket 是任务树叶子，没有 worker，见 3.5。

## 0. 结论摘要

| # | 结论 | 影响 |
| --- | --- | --- |
| 1 | **不新增第二个“顶层授权聚合”**。顶层任务仍是 `Ticket`；子任务（`Subtask`）挂在 Ticket 下，是同一授权内的委派工作，不另开 Mandate。 | 不复制授权、不产生两套结束条件、不让 Executor 直接创建 Ticket。 |
| 2 | **只新增一个可持久化的覆盖层：任务类别（`TaskCategory`）及任务归属（`TaskPlacement`）**。类别是展示与组织元数据，不授予任何权限。 | 人工改名/合并/拆分只改覆盖层，不改 `Ticket`。 |
| 3 | 第一级类别由 **Agent 在工单受理后异步归纳**，人工修改优先；低置信度进入“未归类”，永不隐藏工作。 | 需要一个小模型调用队列与置信度阈值；可关闭并回退。 |
| 4 | 层级为 **类别 → 任务（Ticket）→ 子任务（Subtask）→ 更深子任务**；每个 **tracked** 任务节点有自己的 worker，lightweight Ticket 是叶子、没有 worker。默认显示 3 层（类别 + Ticket + 一级子任务），更深折叠。 | 符合“最多关心 2–3 级”；执行单元（Assignment/Session）不是任务层级，放在节点详情；lightweight 与 tracked 的边界见 3.5。 |
| 5 | **右侧栏新增“任务”tab**，与“事件”并列；两者共享选中态，可互相定位。状态页保留完整任务页。 | 同一份 `GET tasks` 投影，两处不会给出不同归属。 |
| 6 | 视图：右栏只做列表/紧凑树；完整页做列表、树、看板、时间线图。图不伪造依赖关系。 | 窄栏不塞看板与图，避免信息不可读。 |
| 7 | **类别覆盖层第一阶段不改 schema**：存 `KV` 文档，`GET tasks` 只做加法；子任务在第 2 期用 schema 15 加法建表。旧任务树保留为回退。 | 老数据照常读；类别可开关回退；子任务 schema 15 是单向迁移，回滚需降级迁移/备份。 |
| 8 | **父 worker 负责最终目标、子任务交付审查、合并与冲突解决**；子任务自己的 worker 只对子目标负责，不能结束父任务。 | 父子责任清晰；子任务问题先回到父 worker，避免把注意力打散给用户。 |
| 9 | 分五期落地：右栏只读任务视图 → **子任务树 + 每个 tracked 节点的 worker + 父子契约** → 类别归纳（只读）→ 人工编辑/看板/交付详情 → 硬化；lightweight 的运行时前置单列 Phase 0。 | 子任务是核心执行能力，单独一期；类别与视图随后；lightweight 不做 worker/子任务，且在 Phase 0 接通前不作为 Phase 1 验收。 |

## 1. 现状

### 1.1 已经有什么

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 授权工作单元 | `Ticket`：来源 Trigger、Mandate、Channels、Subscriptions、Inputs、Assignments、Execution、结束状态 | `packages/kernel/src/model.ts` |
| 执行者与会话 | 每个 tracked 工单一个 worker Session：`worker-<ticketId>`；同一工单的多次 Assignment 共享它；worker 可再开 subagent Session。lightweight 没有 Assignment/worker Session/workspace，走 inline executor；当前 inline 只是 kernel 契约，生产未注入 | `packages/dsh/src/executor/dsh.ts`、`packages/dsh/src/app/sessions.ts`、#29 |
| 任务拆分 | 当前只有 subagent Session（临时执行细节），**没有独立子任务、没有子任务自己的 worker**；父 worker 不能动态建子任务，也不能审子交付/合并/解冲突 | `packages/dsh/src/executor/dsh.ts`、`packages/dsh/src/app/sessions.ts` |
| 交付物契约 | `Artifact` + `PreviewRef` + 验收条件；worker 在 report 时经 `enterReview` 校验并写入 `Assignment.report.review`；工单页已能渲染与批准；**任务树/任务视图还没有汇总展示** | `packages/kernel/src/deliverable.ts`、`packages/kernel/src/assignments.ts`、`packages/dsh/src/app/views/tickets.ts` |
| 任务树 | 管理面板“任务”tab：里程碑 → 计划任务 → 工单 → PR/审查；可折叠、有状态汇总、耗时与可选的工单时间线图 | `packages/dsh/src/app/tasks.ts`、`packages/dsh/src/client/tasks.tsx` |
| 归属推导 | 从标题/`Mandate.scope` 里的 `T<M>-<N>` 取计划任务；审查工单按标题里的 `PR #N` 归到被审工单（无法唯一确定时退回同任务唯一实现工单）；PR 从报告/范围里的 URL 归到打开它的工单 | `packages/dsh/src/app/ownership.ts` |
| 事件视图 | 右侧栏“事件”tab：按任务分组、来源、状态、最新事件、筛选、未读数 | `packages/dsh/src/client/system.tsx`、`packages/dsh/src/app/activity.ts` |
| 状态页 | 主会话“状态”tab 内嵌完整管理面板；任务页目前在这里 | `packages/dsh/src/client/index.tsx`、`packages/dsh/src/client/app.tsx` |

### 1.2 用户看到的偏差

1. **任务页是工程计划视图，不是用户任务视图**：第一层是 `里程碑 M2`、`任务 T2-01` 这类计划编号，来自工单标题里的约定；用户不认这些编号，也无法把“税务申报”“客户投标”这类真正的任务类别改出来。
2. **任务页在主区，不在右栏**：事件已经在右栏，任务却要进“状态”页；用户希望在同一个监督位置切换“任务 / 事件”。
3. **只有“树 + 图”，没有看板**；图是每个里程碑内工单的并行时间线，不是任务关系图。
4. **只看到“做了什么”，看不到“谁在做、在哪个会话、产出什么”**：树行只有状态、进度、耗时；执行者、Session、交付物要逐条点进工单页。
5. **看不到来源**：同一个任务可能从对话、飞书、GitHub 多路进来，但任务树不显示来源锚点与最近事件；事件页有来源，任务页没有。
6. **没有“合并/拆分/改名”**：归属是读取时从标题推导的，标题不写计划编号就掉进“未列入计划”；用户无法纠正。
7. **“未列入计划”会越积越多**：没有归纳层，未编号的工单只能一条条平铺，任务页会退化成长列表。
9. **任务与计划混为一谈**：`M2/T2-03` 是研发计划，不是用户目标；两者应有不同维度，而不是让计划编号充当第一级类别。
10. **只有两层容器，且没有父子任务关系**：父 worker 不能动态创建“有自己 worker 的子任务”，也不能审查子交付、合并结果、解决冲突；现有 subagent 只是执行细节，不能承担子任务的目标与交付。

### 1.3 现状与目标的差距

| 维度 | 现状 | 目标 | 差距性质 |
| --- | --- | --- | --- |
| 第一级 | 计划里程碑 `M*` | 由多个事件归纳、用户可改的任务类别 | 新覆盖层 + 归纳服务 |
| 第二级 | 计划任务 `T*` / 工单 | 任务（工单） | 重新定义展示层，不改聚合 |
| 第三级 | 审查、PR 叶子 | 子任务（Subtask，自己的 worker）与交付物；执行单元放到节点详情 | 新 Subtask 模型 + 子 worker + 父子契约 |
| 归属 | 标题/范围正则 | 人工优先、归纳次之、未归类兜底 | 新归属解析链 |
| 编辑 | 无 | 类别改名/合并/拆分/移动/恢复自动 | 新写接口 + 审计 |
| 表面 | 状态页任务 tab | 右栏任务 tab + 状态页完整页 | 新右栏 tab + 共享投影 |
| 视图 | 树、时间线图 | 列表、树、看板、时间线图 | 新看板；图重新定位 |
| 信息 | 状态/进度/耗时 | 加来源、执行者、会话、交付物、最近事件 | 投影扩展 |
| 执行者 | tracked：通用 worker Session；lightweight：inline，无 worker（kernel 契约，生产未接通） | 每个 tracked 节点有自己的 worker；lightweight 明示无 worker/无审批 | 先展示 `worker-<ticketId>` / `subtask-<subtaskId>` / “轻量”，不伪造名字 |
| 拆分 | 只有 subagent 会话 | 父 worker 动态委派子任务、审交付、合并、解冲突 | 新 `delegate_task` 工具 + Subtask 持久化 + 子 worker 生命周期 |
| 规划 | 只有工单标题/范围里的计划编号；worker 的执行计划不落库 | 已受理任务与执行单元可见；未受理的计划不伪造 | 结构化 plan 是另一个模型，不在本设计里硬造 |
| 身份 | 标题里的计划编号 | 稳定类别 id + 工单 id | 新 id 与别名 |
| 兼容 | 计划树 | 计划树保留为回退/计划维度 | 双读、开关 |

## 2. 设计原则

1. **授权不变**。任务视图是读模型加展示元数据；类别、归属、改名都不改变 `Ticket`、`Mandate`、`Assignment`，也不产生新的执行权限。子任务（Subtask）继承父 Ticket 的授权，不另开 Mandate；任何需要独立授权的工作仍必须成为 `Ticket`（走 Eval）。
2. **一份数据，多个看法**。列表、树、看板、图、右栏、状态页都读同一个 `GET tasks` 投影；不允许某个视图自己推导一套归属。
3. **未归类必须可见**。归纳失败、置信度低、用户没改的工单进入“未归类”，不隐藏、不丢弃、不静默合并。
4. **人工修改优先且可撤销**。人的改名/合并/拆分是覆盖层；Agent 只能建议，不能覆盖人工决定；任何覆盖都能“恢复自动归纳”。
5. **默认三层，更深折叠**。类别 + Ticket + 一级子任务默认可见；二级以下子任务与执行细节按需展开，避免树把默认视图撑爆。
6. **来源是锚点，不是层级**。任务不按 GitHub/飞书/对话分组；来源作为任务上的 chip 与锚点列表，避免“多源任务”被拆成多条。
7. **不伪造结构**。没有依赖数据就不画依赖边；没有交付物就不显示空的“交付”区块；没有子任务就不编造子任务；subagent 不冒充子任务。
8. **先只读，再可编辑**。先把任务视角跑通并验证归纳质量，再开放写操作；写操作前先把冲突与审计做好。

## 3. 概念模型

### 3.1 八个概念

| 概念 | 定义 | 是否新实体 | 谁写 |
| --- | --- | --- | --- |
| 事件 Event | 任一来源的一次输入：对话消息、IM、邮件、GitHub Issue/PR/CI、网页变化等；落地为 `Trigger` 与活动记录 | 否 | Source / Engine |
| 工单 Ticket | 一次被授权的工作：有来源、Mandate、执行、结束条件；顶层任务。form 为 tracked（有 Assignment/worker）或 lightweight（inline，无 Assignment/worker/workspace） | 否 | Engine |
| 任务 Task | 用户视角的一个任务节点，可能是 `Ticket`，也可能是 `Subtask`；不是独立存储 | 否（投影） | 读模型 |
| 子任务 Subtask | **tracked Ticket** 下的子任务：有自己的 worker、目标、报告、交付物；由父 worker 委派，继承父 Mandate。lightweight Ticket 不能有 Subtask | **是** | Engine（Delegation） |
| 任务类别 TaskCategory | 第一级“工作线/大类”：由多个 Ticket 归纳，可人工改名/合并/拆分 | **是** | `TaskCatalogue` |
| 任务归属 TaskPlacement | 一个 Ticket 属于哪个类别，以及来源是“归纳”“人工”还是“继承审查对象” | **是** | `TaskCatalogue` |
| 执行单元 ExecutionUnit | 一个任务节点内的一次执行：Assignment、worker Session、subagent Session；不是任务层级 | 否（投影） | Executor |
| 交付物 Deliverable | 一个 **tracked** 任务节点产出的一次交付：artifact + preview + 验收条件 | 已有契约，已接入 `Assignment.report.review` 与工单页；lightweight 只有 inline summary/action ledger，不是 Deliverable | 评审面（现有）；任务视图只读汇总 |

### 3.2 关系

```text
事件流（多源）
  │  受理 / 合并
  ▼
工单 Ticket（L2，授权聚合；tracked 一个 worker，lightweight 无 worker）
  │  origin / channels / inputs / follows
  │
  ├─ 子任务 Subtask（L3，仅 tracked；自己的 worker，继承父 Mandate）
  │    ├─ 子任务（L4，折叠，自己的 worker）
  │    └─ 执行单元 / 交付物（节点详情）
  │
  ├─ 执行单元 / 交付物（tracked 的 Ticket worker；lightweight 走 inline）
  ├─ 来源锚点：Thread / Channel（GitHub PR、飞书群、对话线程…）
  └─ 归属 → 任务类别 TaskCategory（L1，可编辑）
```

一条任务可以来自多个事件、多个来源；事件不是任务的父级，而是任务的“来路”。多个事件先合并到同一工单（受理批次、订阅、输入、绑定 Channel），工单再被归纳到一个类别。子任务由父 worker 在执行中创建，不是来源事件。

### 3.3 为什么不再造一个顶层 `Task` 聚合

`Ticket` 已经承载了顶层任务需要的一切：来源、授权、执行、输入、订阅、结束条件。再建一个顶层 `Task` 会带来：

- 两套状态与结束条件，面板与执行器必然对不上；
- 授权分叉：`Task` 没有 Mandate，执行时又要回填 Ticket；
- 迁移成本：所有历史工单需要重建关联；
- 与现有“事件按任务分组”的读模型冲突。

因此“任务”是 `Ticket`（以及它下面的 `Subtask`）的**用户面命名**，不是第二个顶层授权表。新实体是 `Subtask` 与类别/归属：前者是执行树的一部分，后两者是展示元数据。

### 3.4 为什么不让子任务直接变成子 Ticket

评论要的是“每个 **tracked** 任务节点有自己的 worker、父 worker 能动态创建子任务、并负责最终目标与交付审查”；#29 的 lightweight Ticket 是明确的叶子例外，见 3.5。这也不等于“每个节点都是 Ticket”：

- 现有规则是 **只有 Eval 创建 Ticket**；如果父 worker 直接创建子 Ticket，就绕过了授权、Decision 与 Mandate 记录。
- 子 Ticket 需要独立的 Mandate、结束条件、来源身份与 Channel；多数子任务是同一授权内的拆分，不需要这些。
- `Subtask` 继承父 Ticket 的 Mandate，由 **Engine 的 delegation 操作**创建，父 worker 只是请求者；子任务不能越过父 Mandate 的动作级别，也不能直接对人发消息。
- 需要独立授权的子工作，才升级为**子 Ticket**：走一个内部 delegation Eval，记录 `parentTicketId`、独立 Mandate 与结束条件。这是后续阶段，不与 Subtask 混用。

结论：**子任务（Subtask）负责“执行树”，Ticket 负责“授权树”**；UI 上两者都显示为任务节点，但授权边界不同。

### 3.5 轻量 Ticket 与 tracked 任务树（#29 合入后）

#29 已把 Ticket 明确分成两种 form：`TicketForm = 'tracked' | 'lightweight'`，`ticket.form` 缺省为 tracked；`ticketForm()` 读取。二者都是 `Ticket`，都有 Mandate、来源、Inputs、结束状态，但执行方式不同：

| 维度 | tracked Ticket | lightweight Ticket（#29） |
| --- | --- | --- |
| 执行 | 有 Assignment、`worker-<ticketId>`、workspace | 无 Assignment、无 worker Session、无 workspace；`InlineExecutor` 内联执行 |
| 动作级别 | 可 read/draft，也可在授权内 commit/send/spend | 只允许 read/draft；`commit`/`send`/`spend` 被 kernel 拒绝 |
| 状态/重试 | Assignment 报告、`requestStatus`、`retry` | 无 Assignment；不适用 worker report/retry；`completed` 或 `dropped` 结束 |
| 恢复 | Assignment 可恢复 | 当前没有重启恢复路径 |
| 审计 | 活动/交付/PR | 每步 Action span + 最后 Report span；按 run token 关联 |
| 交付/验收 | `Assignment.report.review` + `Review.confirmations` | **没有 `Assignment.report.review`**；只有 inline action ledger 与 summary，没有人工确认门 |
| 子任务 | 可作为父节点，委派 Subtask | **不能委派**：没有父 worker，也没有可审查子交付的 worker |

**结论：lightweight 是任务树里的叶子，不是另一种顶层任务，也不是 Subtask。** 任务树节点仍是 `Ticket`；UI 用 `form` badge 区分。轻量任务可以出现在任一 L1 类别下，但没有 L3 子节点，也没有“自己的 worker”。

**落地状态（先校正一个前提）**：#29 合入的是 **kernel 契约**（`TicketForm`、`ticketForm()`、`InlineExecutor` 端口与测试），不是生产可用的 lightweight 运行时。当前 `assembly.ts` 没有注入 `inline`，没有生产 `InlineExecutor` 实现，Eval 也还不写 `form`（见 `docs/003-execution.md`），所以产品今天仍只创建 tracked Ticket；lightweight 只能由 kernel 测试构造。本文把 lightweight 作为**前向兼容的任务形态**设计，不把它当成“已经能受理”的运行时事实。

因此 Phase 1 的验收只覆盖 tracked；lightweight 行/详情只有在 Phase 0 接通运行时后才算验收项。见 3.5.5 与 9 的 Phase 0。

#### 3.5.1 哪些节点 lightweight，哪些必须 tracked

| 适合 lightweight | 必须 tracked |
| --- | --- |
| 一次 read/draft、即时返回、无需落盘 workspace | 需要 workspace、文件/分支/PR、跨轮多步执行 |
| 不产生需要人验收的交付物 | 有 artifact/revision/preview，需要 `Review`/人工确认 |
| 不需要 commit/send/spend | 需要 commit/send/spend 或外部写 |
| 不需要重试、状态查询、失败恢复 | 可能阻塞、需要重试/恢复/人工接管 |
| 不需要子任务、不需要父 worker 审查 | 需要 `Subtask`、父审阅、合并/冲突解决 |
| 结果可以用 summary + action ledger 说明 | 需要交付物审查、批准历史、可审计的合并 |

判断规则：**不确定就 tracked**。轻量化的收益是低延迟、低成本；代价是没有 workspace、没有 review、没有重试/恢复、不能拆子树。凡是“要给人审”“要落盘”“要外部写”“要拆”的工作，都不应塞进 lightweight。

**form 选择是受理约束，不只是文案建议**：`prepareTicket`/accept 只有在以下全部成立时才可把 Ticket 标为 lightweight：部署已注入生产 `InlineExecutor`；Eval/assessor 明确写了 `form='lightweight'`；任务没有 Review/`HumanCriterion`、没有 artifact/preview、没有 workspace/外部写、没有子任务、没有 PR/follows、没有重试/恢复要求。任一不成立，`prepareTicket` 必须回退 tracked，或拒绝 accept（`UserError('lightweightUnsupported')`）。**审查 Ticket 永远 tracked**；review 需要人的确认门，不能落进 lightweight。该约束要由 accept/prepareTicket 层执行，不能只写在文档表格里。

#### 3.5.2 层级、交付物与 review 的取舍

- **层级**：类别 → Ticket（tracked 或 lightweight）→（仅 tracked）Subtask → 更深 Subtask。lightweight 没有子节点；`Subtask` 永远是 tracked（有独立 worker）。**不要造“lightweight Subtask”**：没有 worker 就没有父审阅责任人，父子契约不成立。
- **父节点**：只有 tracked Ticket 能成为父节点；lightweight 不能调 `delegate_task`。如果 tracked 父任务里有一小块独立工作，父 worker 自己做、开 subagent 执行步骤，或建 tracked Subtask；不要用 lightweight Ticket 冒充子任务。
- **交付物**：tracked 节点的交付走 `Assignment.report.review`；lightweight 只有 summary/action ledger，**不产生 `DeliverableSummary`、不产生 `Review`、不进入人工确认队列**。任务视图对 lightweight 显示“轻量执行，无交付审批”，不要显示空的“待验收”卡片。
- **review/attention**：lightweight 不出现 `review`/`answer`/`delivery` 等 person stage，也不应有“待人确认”的 attention；它可以在执行中显示 `working`，完成后 `done`；`dropped` 用 `done` + `terminal='dropped'`，显示“已放弃”，不能映射成 live 的 `idle`。如果业务需要人看结果，选 tracked，而不是给 lightweight 硬加一个 review 阶段。
- **类别**：类别覆盖层只按 Ticket 归类，tracked 与 lightweight 都算 Ticket；lightweight 也进入 L1 归纳/人工归类，但 classifier 的输入是标题、Mandate、来源与 inline summary（没有 worker 报告）。子任务仍不单独分类。
- **父完成门**：只对 tracked 父 Ticket 生效；lightweight 没有子任务，不参与 `delegate_task`、`accept_subtask`、`Subtask.resolution`。

#### 3.5.3 冲突、迁移与兼容

与评论的“每个任务节点有自己的 worker”存在字面冲突：**#29 明确 lightweight 没有 worker**。本稿的取舍是：

- “每个任务节点”在任务树里解释为 **每个 tracked 节点**；lightweight 是 Ticket 的叶子形态，用 `form` badge 明示“无 worker/无审批”。不把 lightweight 画成有 worker，也不为它伪造 Assignment。
- 如果产品坚持“所有节点都必须有 worker”，那 lightweight 就不能作为任务树节点；但 #29 目前只是 kernel 契约、生产未接通，不能拿“运行时事实”做论据。建议先保留 form 差异并在 UI 明确边界；等 Phase 0 接通后，再按真实使用数据决定是否保留 lightweight 作为任务树叶子。
- 如果父任务需要审查一小块工作，**不要**把 lightweight 任务挂到父下；用 tracked Subtask。父审阅/合并/`resolution` 只对 tracked 子树成立。

**迁移建议**：

1. **存量兼容**：`form` 缺省 tracked，旧 Ticket 不改；lightweight 没有 Assignment/workspace，任务视图必须容忍 `assignments = 0`、`sessionId` 缺失、`deliverables` 为空。
2. **lightweight → tracked（升级）**：不在原 Ticket 上直接改 `form`。当前没有“结束时把未消费 follow-up 交回 Eval”的 handback：`Tickets.end`/`letGo` 之后 `evaluateDue` 走 `tickets.wake`，同一 Thread 的 follow-up 仍 inline 续跑。因此**唯一可靠路径是新的 Thread/对话**（不属于旧 lightweight Ticket 的订阅/来源），由这条新请求经 Eval 选择 **tracked Ticket**。让旧 inline run 自然结束（`dropped` 或已完成），新 tracked Ticket 不合并旧节点；保留旧 action ledger、Mandate 与审计，不伪造 Assignment 历史。本文不引入未建模的 `supersedes`/`relatedTicketId` 字段；如果产品需要“升级来源”标注，应另立一个显式的 Ticket 关系字段并单独迁移，不能只在文档里提。
3. **tracked → lightweight（降级）**：不做。会丢失 Assignment、worker、workspace、review 与恢复能力；需要轻量时新建 lightweight Ticket。
4. **自动转换**：第 1/2 期不做“运行中自动升级”。升级需要新的授权/Assignment 语义，先由人/父 worker 明确发起 follow-up；不要用改 `form` 字段绕过 Eval。
5. **历史**：不要把历史 subagent、inline action、旧 lightweight 运行追溯成 Subtask；它们是执行细节，不是任务层级。

#### 3.5.4 对视图与数据模型的影响

- `TaskView` 增加 `form: 'tracked' | 'lightweight'`；`SubtaskView` 不增加 form（永远 tracked）。
- `TaskView.execution` **保持必填**（沿用现有契约）；lightweight 返回 `{ assignments: 0, subagents: 0 }`，`sessionId`/`name` 缺省。这样 UI 不会因字段缺失而崩，也不需要第二个 execution 形状；详情显示 inline 的 step/action 摘要，而不是 worker Session。
- `TaskView.deliverables` 对 lightweight 为空；新增可选的 `inline?: { steps: number; lastActionAt?: string; summary?: string; traceId?: string }`，只做摘要，不冒充 `DeliverableSummary`。
- 行 UI：lightweight 显示“轻量”badge，无展开箭头、无“查看 worker”、无“待验收”；详情页显示 action ledger 与 summary，并提示“需要保留/审批/外部写时，请发起 tracked 任务”。
- 状态：lightweight 不套 tracked 的 `ticketStage` 等待逻辑；只按 inline run 的进行/结束投影为 `queued`/`working`/`done`。`dropped` 也用 `status=done` + `terminal='dropped'` 表达，绝不使用 live 的 `idle`；不进入 `review`/`answer`/`delivery`/`blocked` 的 attention 集合。
- 测试：lightweight 无 Assignment/Session/workspace；任务视图不显示 worker/交付/子任务；不触发父完成门；tracked 父下不出现 lightweight 子节点；升级后出现两个节点、旧 lightweight 不被改写；类别计数两者都算。

#### 3.5.5 分期影响

- 第 1 期：只读视图只验收 tracked；lightweight 行/详情作为前向兼容形状，只有在 Phase 0 接通生产 `InlineExecutor` + Eval form selection 后才验收。若尚未接通，`TaskView.form` 字段仍可存在，但产品不会产生 lightweight Ticket；测试用 kernel fixture，不写“受理后”验收。
- 第 2 期：Subtask 只允许 tracked 父；`delegate_task` 只对 tracked worker 开放；lightweight 没有父完成门。
- 第 3 期：类别分类覆盖两种 form；lightweight 的输入少，允许人工纠正；不要用 inline action 当类别证据。
- 第 4 期：交付/审批/看板只对 tracked 展示；lightweight 的看板卡片只显示状态和 brief，不显示“待验收”。
- 第 5 期：补 lightweight 重启恢复/升级路径（如产品需要），否则明确“lightweight 不做恢复”。

## 4. 层级与归属

### 4.1 任务树层级

| 层 | 内容 | 默认 | 展开 |
| --- | --- | --- | --- |
| L1 类别 | Agent 归纳的工作线/大类，人工可改；只包含 Ticket | 显示 | 始终显示（含“未归类”） |
| L2 任务 | `Ticket`；tracked 有自己的 worker、来源、执行、结束条件、交付；lightweight 只有来源、inline 执行、结束状态，是叶子 | 显示 | 始终显示；lightweight 无子节点 |
| L3 子任务 | `Subtask`；父 worker 委派，自己的 worker、目标、报告、交付 | 显示 | 默认展开一级 |
| L4+ 更深子任务 | 子任务再委派；受深度与数量上限约束 | 折叠 | 点“展开更多”或节点详情 |

执行单元（Assignment、Session、subagent）与交付物**不是任务层级**，放在节点详情；这样“默认 2–3 级”是任务层级，不会被执行细节撑爆。

规则：

- 每个 **tracked** `Ticket`/`Subtask` 节点最多一个自己的 worker；worker 的身份是 `worker-<ticketId>` 或 `subtask-<subtaskId>`。lightweight Ticket 没有 worker（3.5）。
- **不能把子任务 session 编成 `worker-<ticketId>-<subtaskId>`**：现有 `ticketOfSession` 只切 `worker-` 前缀，会把 `-sub` 当成 ticketId。子任务用独立前缀 `subtask-<subtaskId>` + `session → (ticketId, subtaskId)` 注册表；`ticketOfSession`、`Sessions.decorate`/`ticketOf`、预设选择、工具注册与 `workOnly` 都要按注册表解析，且写保护同时检查父 Ticket 存活与子任务未结束。
- **Executor 的事件处理也要按 `(ticketId, subtaskId)` 解析**：`DshExecutor.install` 的 `ticketOf`、`agent/status`、`agent/inbox/claimed`、`session/event`、`agent/error` 处理器都 keyed by `ticketOfSession(agent.id)`；子 session 若解析成父 Ticket，会把子 turn 的 `workerIdle`/`failed` 写到父 Assignment 上。要加 per-subtask lifecycle（子 idle/error 只推进子状态），并让 `Sessions.limitSubagent` 解析最近的 worker/subtask、套用该节点的 `workOnly`/受限执行配置，不能把子 subagent 绑到父 Ticket 绕过限制。
- 子任务只能由父节点的 worker 通过 `delegate_task` 请求 Engine 创建；Engine 校验深度、宽度与父 Mandate/maxActionLevel；`scope` 只是执行提示。
- 子任务默认继承父 Ticket 的类别，**不单独跑分类器、不计入类别任务数**；类别是 Ticket 的组织方式。
- 最大深度默认 5，单节点最多 8 个子任务、单 Ticket 同时活跃子任务最多 32；可配置，超限返回明确错误。
- UI 默认显示 L1–L3；L4 折叠并显示“还有 N 层/ N 个”，用户最多关心 2–3 级。

### 4.2 合并规则：多个事件如何成为一个任务

按优先级从高到低：

1. **显式引用**：消息回复了某任务、带了工单 id、在任务线程内 → 挂到该工单（现有 `orchestrator_route` / 订阅 / Input 机制）。
2. **同一受理批次**：同一次 Eval 接受的多个 Trigger 属于同一工单的 `origin.triggerIds`。
3. **同一来源线程**：同一 Thread 的后续事件通过订阅进入同一工单，不新建任务。
4. **绑定来源**：PR、飞书群、对话线程通过 `bindChannel` / `follows` 成为同一任务的锚点。
5. **语义归纳**：以上都不命中时，才允许 Agent 判断“这是已有任务的补充，还是新任务”；中置信度给建议，低置信度进“未归类”，不静默合并。

原则：**宁可问一句，不要默默挂错**；挂错比漏挂更伤信任（沿用《对话与任务融合设计》的判定）。

注意：这是**事件合并**，不是把两个已授权工单合并成一个。工单合并会改变授权、结束条件与审计链，当前不支持；重复工单只能用只读的“重复于/替代”关联或人工停掉其中一个，不能用类别合并代替。

上表第 5 条是**建议**能力，不是自动挂载：事件进入工单仍走现有的 Eval、订阅与派发路径，语义判断最多提示“可能属于任务 X”，不能静默挂载。

### 4.3 拆分规则：执行步骤、子任务、子 Ticket

拆分分三种，边界不能混：

| 拆分类型 | 谁创建 | 有自己 worker | 授权 | UI |
| --- | --- | --- | --- | --- |
| 执行内步骤 | 父 worker 直接开 subagent Session | 子 Session，不是独立 worker | 继承父节点 | 节点详情，不是任务层级 |
| 子任务 Subtask | 父 worker 调 `delegate_task`，**Engine 写入** | **是**，`subtask-<subtaskId>` | 继承同一个 Mandate 与 maxActionLevel；`scope` 只是提示，不能扩权 | L3+ 任务节点 |
| 子 Ticket | 内部 delegation Eval（后续阶段） | 是 | 独立 Mandate、来源、结束条件；记录 `parentTicketId` | L3+ 任务节点，kind = ticket |

规则：

- **父 worker 可以动态创建子任务，但只能在 Engine 的 delegation 操作里创建**。worker 调 `delegate_task(title, goal, scope?)`；Engine 校验父 Ticket 存活、父 worker 在运行、父 Mandate/maxActionLevel 原样继承、深度/宽度/配额未超限，然后创建 `Subtask` 与子 worker。worker 不能直接写表、不能直接创建 Ticket。`Mandate.scope` 是自由文本，运行时不计算“文本子集”；不要把它当授权边界。
- **子任务继承授权，不继承“结束父任务”的权力**。子 worker 只对子目标负责；父 worker 对最终目标、交付审查、合并与冲突解决负责。子 worker 不能把父 Ticket 标为完成。
- **子任务的问题先回父 worker**。子 worker 的 `blocked`/问题报告给父 worker；父 worker 决定自己答、改写子任务、换一个子任务，或汇总成一个 `human_action` 问人。默认不让每个子 worker 直接打扰用户。
- **父 worker 的结束门**：`ready`/`dropped`/人停止/PR 合并都经过 `Tickets.end`；父 `failed` 不是终态（取消子任务、Ticket 保持 live）；未结束（无当前有效 `resolution`）= `queued`/`working`/`waiting`/`review`/`blocked`/`failed`/`orphaned`。`failed`/`orphaned` 必须有当前有效的 `Subtask.resolution`（接受/取消/失败；退回是重开，不是终态处置）才放行；子任务失败不自动结束父任务，父 worker 决定重试、拆新子任务或报失败。详见 4.6。
- **停止级联**：人停止父 Ticket → 所有子任务停止；停止一个子任务只停该子树，不影响父任务和其他分支。父任务结束/失败后，子 worker 不能继续写。
- **合并与冲突**：子任务默认把交付物交给父 worker，不直接交给最终用户；父 worker 审查、接受或退回，合并子结果（代码合并分支/文档合并修订）。父 worker 解决不了冲突时，才升级为一个人问题。**父的接受只代表工作交付被接受，不代替 `Review.confirmations` 的人确认**；子任务里需要人确认的验收条件通过 6.6 的 `TaskReviewView` 聚合进最终 Ticket review，仍由人按 `reviewRevision` 确认；不能靠父 worker 在最终报告里重写一遍。
- **执行步骤不是子任务**：subagent 仍是节点详情里的执行单元；不要为了“看起来像树”把 subagent 伪装成子任务。
- **更深的子任务**受最大深度 5、单节点 8 个、单 Ticket 32 个活跃子任务约束；超限返回明确错误，不静默截断。
- **子 worker 的工具与目录**：只注册执行工具；不注册 `send_message`、向人提问、orchestrator 类工具，也不注册 commit/send/spend/merge/审批请求工具，子→父只走 Engine 的报告通道；cwd 限制在父任务目录的子目录或独立工作树，不能写父任务受保护文件。`delegate_task` 只对 Ticket/Subtask 的 worker 开放，主会话没有。
- **仅“不注册工具”挡不住外部动作**：`WORK_TOOLS` 含 `bash`，且 `Sessions.ensure` 当前给所有 session `danger-full-access`；子 worker 可以用 `git push`/`gh pr create`/`curl` 绕过工具列表。第 2 期必须给子 worker 一个**受限执行配置**（网络关闭、无 git remote/gh、`bash` 命令策略、cwd jail、无 `subagent`），并由 `Sessions.ensure`/`limitSubagent` 强制；做不到就明确降级为“只能靠父审阅提示”，不能声称子 worker 不能做外部动作。
- **需要独立授权才升级为子 Ticket**：不同来源/人、独立动作级别、独立结束条件或独立 Channel；走 delegation Eval，不能用 Subtask 绕过。

当前运行时只有 subagent Session 的基础，没有 `Subtask`、`delegate_task`、子 worker 生命周期或父完成门；这些是第 2 期的主要工程。

### 4.4 归属解析链

```text
人工归属（TaskPlacement.basis = manual）
  > 审查工单跟随被审工单（basis = inherited）
  > Agent 归纳（basis = derived，且未被人工重置）
  > 未归类
```

注意：计划编号 `T2-03` **不进入这条链**。计划是另一个维度，作为任务上的“计划”标签或“按计划查看”的备用视图保留；不要再用计划编号充当 L1 类别。

审查工单**不单独跑分类器**：它跟随被审工单的类别（`basis = inherited`），被审工单未归类则审查也进“未归类”；人工仍可单独改审查工单的归属，人工优先。

`inherited` 是**读时解析**，不写一条会漂移的 placement：审查 Ticket 不单独存 inherited placement；投影按 `reviewedTicketId` 找被审 Ticket 的 placement，若没有人工 placement 就返回 `basis='inherited'`。这样被审 Ticket 移动/合并时，审查自动跟随，不需要级联更新；审查 Ticket 自己有人工 placement 时覆盖继承。`TaskPlacement` 里出现的 `inherited` 只能是投影结果，不能由写接口持久化。

子任务**不单独归类**：它继承父 Ticket 的类别，类别任务数只统计 Ticket；子任务不进入“未归类”，也不参与类别建议。

### 4.5 关系的种类

用户问的“关系”至少有五种，不能都塞进一棵树：

| 关系 | 含义 | 展示位置 | 现在有没有数据 |
| --- | --- | --- | --- |
| 归属 | Ticket 属于哪个类别 | 列表/树的分组头 | 新增覆盖层 |
| 父子 | 父任务下有哪些子任务，父/子谁负责 | 树的 L3+、父节点详情 | **暂无**，第 2 期新增 Subtask |
| 包含 | 节点内有哪些执行单元与交付物 | 节点详情 | 工单/会话有，交付物在 `Assignment.report.review` |
| 来路 | 任务由哪些事件、哪个来源而来 | 任务行来源 chip、详情“来源锚点” | 有（origin/channels/inputs/follows） |
| 审查 | 哪个审查工单在审哪个任务 | 树中审查节点 | 有（`ownership.ts`） |
| 并行/汇合 | 任务何时并行、何时结束 | 时间线图 | 有（任务起止时间） |
| 依赖 | A 是否等 B 才能开始 | 暂不画 | **没有**，不要伪造 |

结论：树表达“归属 + 父子 + 包含 + 审查”，图表达“并行/汇合”，看板表达“状态分布”，来源 chip 表达“来路”。依赖关系等有了真实的依赖字段再做。

**审查关系的显式形状**：`TaskView.kind='review'` 且 `reviewedTicketId` 指向被审 Ticket；`TaskCategoryView.tasks` 仍是扁平的（不嵌套存储），UI 按 `reviewedTicketId` 把 review 行挂在被审 Ticket 下；被审 Ticket 不在当前类别时，review 行作为带“审查”标签的顶层行显示。类别计数同时计入 review Ticket，并另给 `counts.reviews`；不把 review 行藏进 `progress`，否则“树里能看到审查关系”不成立。

### 4.6 父子执行契约

```text
父 worker（worker-<ticketId>）
  │ delegate_task(title, goal, scope?)
  ▼
Engine：校验父任务存活、父 Mandate/maxActionLevel 原样继承、深度/宽度/配额
  │ 创建 Subtask + 子 worker（subtask-<subtaskId>）
  ▼
子 worker：只对子目标负责，向父 worker 报告
  │ progress / ready / blocked / failed（带交付物）
  ▼
父 worker：审查交付、接受/退回/取消、合并、解决冲突
  │ 父 Ticket 在 ready/结束前必须没有未结束子任务
  ▼
父 Ticket ready → 人工最终验收
```

| 动作 | 谁发起 | 结果 |
| --- | --- | --- |
| `delegate_task` | 父 worker | Engine 创建 Subtask 与子 worker，写入父子关系 |
| 子任务报告 | 子 worker | 进入父 worker 的输入；不直接产生人的注意力请求 |
| `accept_subtask` | 父 worker | 子任务完成，写 `resolution.kind='accepted'` + `acceptedReportAt=report.at`，交付物可被父合并；不等于父任务完成 |
| `return_subtask` | 父 worker | 子任务带修改意见重开；清除整个 `resolution`、旧 `merge` 失效，state 回 `working`，子 worker 继续（不写 'returned'，否则会误判为已处置） |
| `cancel_subtask` | 父 worker | 停止子树；父任务记录原因 |
| `ready` | 父 worker | 仅在无未结束子任务且 6.6 聚合可批准时允许；进入人工验收 |
| `human_action` | 父 worker | 子任务问题被父汇总后，最多一个问题问人 |

责任边界：

- **父 worker**：目标拆解、选择委派、审查子交付、合并结果、解决冲突、对最终交付负责；可以自己继续做，不是每个任务都必须拆；不能把“子任务都完成了”当成自己的完成。
- **子 worker**：在给定 scope 内完成子目标、按契约报告、把问题回父；不能扩大 scope、不能直接找人、不能结束父任务。
- **人**：最终验收父 Ticket；可以停止父任务（级联），默认不直接回答子 worker。
- **Prompt/工具**：runtime 给父 worker 注入 `delegate_task`/`accept_subtask`/`return_subtask`/`cancel_subtask`，给子 worker 注入报告与“问题回父”规则；工具 schema 由 runtime 定义，worker 不能自己扩权。

结束路径与守卫（必须做在 `Tickets.end`/`unfinished`，不能只在 worker report 里判断）：

- **未结束子任务（unresolved）** = 状态属于 `queued`/`working`/`waiting`/`review`/`blocked`/`failed`/`orphaned`，且没有**当前有效**的终态 `Subtask.resolution`。有效规则：`cancelled`/`failed` 始终有效；`accepted` 只在 `acceptedReportAt === report.at` 时有效（子任务再次报告会让旧接受失效）。`done`/`dropped`/`cancelled` 已结束；`failed`/`orphaned` 必须由父写有效 `resolution` 才算处置。`return_subtask` 会**清除** resolution 并把 state 回 `working`，因此不会把重新打开的子任务误算成已处置。`SubtaskSummary.unresolved` 必须用同一有效规则，不能只看字段是否存在。
- **所有结束路径共用一道门**：`Assignments.report` 的 `ready`/`dropped`、`Tickets.threadClosed`/`followsDone` 的 PR/线程合并、人停止父 Ticket，最终都经过 `Tickets.end`；父 `failed` 不是结束路径，见下。`Tickets.end` 检查 `unfinished(ticket)` 是否包含未结束子任务。不能只挡 `ready`。
- **`ready`**：有未结束子任务时 **拒绝该 report**（`UserError` 代码 `unfinishedSubtasks`），不把 `ready` 写进 `Assignment.report`；父收到“还有 N 个子任务未结束”的清单，继续处理。`Assignments.review`/`reviewTicket` 也必须再查一次未结束子任务，不能只靠 `Tickets.end` 或报告阶段。父必须对每个失败/孤儿子任务写 `resolution`（accepted/cancelled/failed）后才能再次报 `ready`；`return_subtask` 是重开，不是终态处置。
- **`dropped` / 人停止**：终态；Engine 取消所有子任务（写 `resolution.kind = cancelled`，原因记录），再结束父 Ticket；人停止的 outcome 是 `stopped`，不是 `failed`。
- **父 `failed`**：**不是终态**。现有 `TicketOutcome` 没有 `failed`，`failed` 是等人处理的阶段；Engine 取消所有子任务，父 Ticket 保持 live，`waitsForPerson`/`canRetry` 照旧，人重试时开新 Assignment，不复活旧子任务。不要为了级联失败去改 `TicketOutcome`/`Tickets.retry`。
- **`follows`/PR 合并**：如果还有未结束子任务，**不静默结束**。`Tickets.threadClosed`/`followsDone` 写 `Ticket.endPending = { by:'thread'|'follows', outcome, at, reason, ref }`（不写 `ended`），并追加一个 `TicketInput` `end-gate`（见 6.5），Engine 立即启动/恢复父 Assignment；父处理子任务后再调用 `Tickets.end` 应用 pending。父 Assignment 不可恢复、或父已 `blocked` 且无人处理时，生成一个 attention（不是每子任务一个）；人可取消子树并按 pending 结束，或重试父。若父已经结束/记录缺失，直接级联取消子树并写 `ended`，不留下无主 pending。`Assignments.report` 不能绕过这个 pending。父把最后一个子任务处置完并报 `ready`/`dropped` 时，`Tickets.end` 先过未结束子任务门，再应用 pending 的 `by`/`outcome`/`reason`；pending 只决定结束原因，不改变父 worker 对最终目标的完成判断。
- **`waiting`**：这是父 worker 正常一轮结束的状态（Executor 每轮结束都会报 `waiting`），**不是父不可用**；子任务继续工作，子报告通过 `subtask-report` 唤醒父，父下一轮继续审阅。此时 `TaskView` 的父状态按 6.3 是 `working`，不是 `idle`。
- **`blocked`**：父在等人/等外部决定；子任务只允许只读/草稿类本地工作，外部动作暂停；`workOnly` 在父 `blocked` 时只注册只读工具，父恢复后再注册执行工具。父 session 不存在/已结束且没有可恢复的 Assignment 时，`workOnly` 拒绝子 worker 写入并标记 `orphaned`。

失败与恢复：

- 子任务失败/阻塞 → 父 worker 收到报告，决定重试、换子任务、自己接管或报失败；父任务不会自动失败。父必须在 `Subtask.resolution` 里写处置，不能把 failed 子任务当没看见。
- 父 worker 停止/结束 → 子 worker 停止；父任务结束后子任务不能继续写。
- **恢复顺序**：先恢复父 Ticket/父 worker，再恢复子任务记录与子 worker；不能因为“父 session 还没加载”就把所有子任务标 orphaned。`working` 子任务重启后先标 `blocked`（原因 `restart`），父可用后恢复 `working`；只有父 Ticket/父 subtask 记录缺失或已结束，才标 `orphaned`。
- 父不可用的孤儿子任务交给人的一次决定（重试/取消/接管），不静默重跑、不静默标完成。
- **合并记录**：父 `accept_subtask` 时写 `Subtask.merge`（子 revision、冲突列表、`merged`/`escalated`/`none`、解决人/时间）；父解决不了冲突时升级为一个人问题。没有合并记录的“已接受”不算可审计的合并。之后 `return_subtask` 必须清除/标记该 `merge` 失效；重新接受时写新的合并记录，不能沿用旧 revision 的合并。
- **子 worker 不做外部动作**：子 worker 只做 read/draft/local write；commit、send、spend、开 PR、合并 PR 由父 worker 执行或经父发起 Approval。**但工具列表本身不够**：子 worker 的 `bash` 必须走 4.3 的受限执行配置（无网络/remote/gh、命令策略、cwd jail、无 `subagent`），否则本条的“不能”不成立，只能降级为父审阅提示。`Review.confirmations` 仍由人在最终 Ticket 确认。
- **报告唤醒**：子任务报告通过 `TicketInput` 的新 `subtask-report` 变体进入父 worker；每个子任务最多一条待处理报告；父在 `waiting`/空闲时由 Engine 启动/恢复父 Assignment（不触发 Eval、不创建 Ticket、不产生人的注意力请求）。父不可恢复时才走 orphaned。

## 5. 第一级类别：归纳与人工修改

### 5.1 生成流程

```text
Ticket accepted
   │
   ├─ 入队 task.classify（异步、可去重、失败重试有上限）
   │     输入：标题、Mandate.scope、来源、origin Trigger 摘要、最近报告摘要、
   │           已有类别列表（名称 + 一句目标 + 代表性任务标题）
   │     输出：{ categoryId?, suggestedCategory?{name, goal}, confidence, reason }
   │
   ├─ confidence ≥ 高阈值 且命中已有类别 → 直接归属（state = applied）
   ├─ confidence ≥ 高阈值 但没有匹配 → 写入类别建议，不立即建类
   ├─ 中阈值 且命中已有类别 → 归属但 state = suggested，任务详情显示“Agent 建议”
   ├─ 中阈值 但没有匹配 / 低阈值 / 调用失败 → 未归类（保留“重新归纳”入口）
```

- **只分类 Ticket，不分类 Subtask**：子任务继承父 Ticket 的类别；类别任务数只统计 Ticket，避免子任务把类别计数撑大。
- **类别是长出来的，不是预定义分类法**：每次归类都参考“已有类别 + 代表性任务”，从已受理 Ticket 与来源事件里归纳出两三条，再逐步长到上限；不要求用户先建一套分类。
- **一个任务不建类**：单工单的高置信“新类别”只进建议池；同一候选累计 **2 个支持任务**（或批量归纳预览确认）后才允许建类，避免“一任务一类别”。建议按归一化名称合并，同名不区分大小写。
- **归档类别不再接收新任务**：分类器只在 `active` 类别里匹配；归档类别保留历史归属，要重新启用需人工恢复。
- **批量归纳**：除单工单归类外，用户点“整理任务”或定期（例如每周）把未归类任务与最近任务放在一起看，提出 2–3 个类别或合并建议；批量结果先预览再应用，不自动合并。
- **触发时机**：工单受理后异步执行，不阻塞受理；同一工单 2 秒内多次事件合并为一次。
- **模型**：复用 Eval/Executor 已配置的模型；输出严格 JSON schema；只读标题、范围、来源与摘要，不读文件内容、不读私密消息全文。
- **成本**：每工单一次调用；积压工单用批处理 + 进度条；可配置关闭（关闭时全部进“未归类”）。
- **回退**：模型不可用 → 未归类；不因归纳失败影响工单执行。
- **重跑**：用户可“重新归纳”单个任务/全部未归类；类别合并/拆分后可批量重跑。

### 5.2 置信度与兜底

阈值建议：高 **≥ 0.80**，中 **0.55–0.80**，低 **< 0.55**；先固定，验收后再调。

| 情况 | 处理 |
| --- | --- |
| 高置信命中已有类别 | 直接归属（`state = applied`），记录 `confidence` 与 `reason` |
| 高置信但没有匹配 | 写入类别建议，不立即建类；同一候选累计 ≥2 个任务或批量预览确认后才建类；类别已达上限时改为“建议合并到最接近的类别” |
| 中置信命中已有类别 | 归属但 `state = suggested`，任务详情可一键接受/改 |
| 中置信但没有匹配 | 未归类，显示候选类别名，不建类 |
| 低置信/冲突（两个类别接近） | 未归类，任务详情给“归到 A / B”两个候选，不猜 |
| 建议累计 ≥2 个任务 | 进入“类别建议”区，用户可一键采用；不采用则保留 30 天后过期 |
| 模型失败 | 未归类；不重试超过 2 次，避免阻塞队列 |
| 人工已归属 | 永不覆盖；除非用户点“恢复自动归纳” |

类别上限建议 **7 个活跃类别**（原型用 5，工程上留余量）；超过时提示合并，不自动删。类别为空且 30 天无新任务 → 自动归档（可恢复），不删除。

### 5.3 类别的字段与生命周期

- `name`：短名称，2–8 个汉字或 2–4 个英文词；由 Agent 生成，用户可改。
- `goal`：一句话目标，用于判断新任务是否属于该类；用户可改。
- `order`：人工排序；默认按“需我处理的任务数、最近活动”排。
- `state`：`active` / `archived`；归档保留历史归属与别名。
- `aliases`：合并后旧名称，用于搜索与文档回溯。
- 类别 id 稳定、随机（`cat_...`），改名不改 id；任务归属只认 id。
- **建议不是类别**：类别建议存在 `suggestions`，不占 7 个活跃类别上限；采用后才生成类别与归属。
- 语言：类别名按用户当前语言生成，存原文、不自动翻译；切换界面语言不重命名。

### 5.4 人工编辑边界

**可以改（覆盖层）**：

- 类别：新建、改名、改目标、排序、归档/恢复。
- 建议：接受/忽略“类别建议”；接受只对**仍无人工 placement** 的 `ticketIds` 生效：生成类别并写 `basis='manual'`（用户确认），`reason` 记 `accepted:<suggestionId>`，建议 `state = accepted`。若某个支持 Ticket 在建议生成后已有人工 placement，整次接受返回 `409 manualPlacementConflict`（列出冲突 ticketId），不覆盖、不部分写入；用户可先移除人工归属或重新生成建议。忽略只写 `state = dismissed` + `dismissedAt`，**不写归属**，30 天内不再展示。
- 归属：把任务移到另一类、从“未归类”归入某类、把任务移出类别。
- 合并：把类别 A 合并到 B；A 的任务全部迁到 B，`basis` 置为 `manual`（用户确认），`reason` 记 `merged:A`；A 的名称写入 B 的别名并归档。
- 拆分：从类别 A 拆出新类别 B，选择要迁走的任务；被选中的任务 `basis` 置为 `manual`，未选中的留在 A。
- 恢复自动：删除人工归属，重新归纳。
- 归档不丢任务：归档类别默认从主列表隐藏，但“显示已归档”仍可看到其任务；要清空归档类别，必须先移动/合并任务，不能静默把任务丢进“未归类”。

**不可以从任务视图改（仍走原界面）**：

- 工单标题、Mandate、状态、结束、重试、停止、交付验收。
- 任务级别的“完成/失败”不能手动拖拽修改；看板拖拽只允许改类别，不允许改状态。
- 不能通过改名类别影响工单的搜索/授权/通知。

**Agent 的权限**：

- 可以建议类别与归属；
- 在用户未人工修改前，可以自动应用“高置信且命中已有类别”的结果；新类别只进建议；
- 任务的人工归属永不被覆盖；类别被人工改名后，Agent 以新名字继续归类，但不能改回旧名，也不能把已人工移动的任务移回；
- 合并/拆分只能由人触发；Agent 可以提出“这两类看起来重复”，但不自动执行。

### 5.5 冲突与审计

- 覆盖层文档带 `revision`；写请求带 `baseRevision`，不匹配返回 `409`，UI 提示“已被其他操作更新，请刷新”。
- 单用户本地运行冲突很少，但未来多人/多端必须要有。
- 每次写记录 `history`：`at`、`actor`（human / agent / system）、`action`（含 `classify`、`suggest`、`accept-suggestion`、`dismiss-suggestion`、`move`、`merge`、`split` 等）、`before`、`after`、`reason`。这份 history 存在覆盖层文档内，不依赖 `activity` 表；后续若要进事件流，再加只读投影。
- 类别变更属于展示元数据，**不写 Mandate、不产生通知、不触发 Eval**。

## 6. 数据模型与接口

### 6.1 覆盖层与子任务类型

```ts
interface TaskCategory {
  id: string                    // cat_...
  name: string
  goal?: string
  order: number
  state: 'active' | 'archived'
  aliases?: string[]            // 合并后的旧名
  createdAt: string
  updatedAt: string
}

type TaskPlacement = {
  ticketId: string
  categoryId: string
  reason?: string                             // Agent 给的一句理由 / 人工备注
  updatedAt: string
  updatedBy: { kind: 'human' } | { kind: 'agent'; model?: string } | { kind: 'system' }
} & (
  | { basis: 'manual'; state: 'applied'; confidence?: never }       // 人工移动/确认
  | { basis: 'inherited'; state: 'applied'; confidence?: never }    // 跟随被审工单
  | { basis: 'derived'; state: 'applied' | 'suggested'; confidence: number } // 中置信 = suggested
)

interface CategorySuggestion {
  id: string                    // sug_...
  name: string
  goal?: string
  ticketIds: string[]           // 支持任务；≥2 才可建类
  confidence: number
  state: 'open' | 'dismissed' | 'accepted'
  reason?: string
  createdAt: string
  expiresAt: string
  dismissedAt?: string
  acceptedAt?: string
}

interface TaskCatalogueChange {
  at: string
  actor: { kind: 'human' } | { kind: 'agent'; model?: string } | { kind: 'system' }
  action: 'create' | 'update' | 'rename' | 'merge' | 'split' | 'move' | 'archive' | 'restore' | 'reset'
    | 'classify' | 'suggest' | 'accept-suggestion' | 'dismiss-suggestion'
  before?: unknown
  after?: unknown
  reason?: string
}

interface TaskCatalogue {
  version: 1
  revision: number
  categories: TaskCategory[]
  placements: Record<string, TaskPlacement>   // ticketId -> placement
  suggestions: CategorySuggestion[]           // 含 open/dismissed/accepted；读取只展示 open 且未过期
  history: TaskCatalogueChange[]              // 最近 N 条，可截断
  updatedAt: string
}

// 子任务是运行时数据，不是展示覆盖层；存 SQL 表（schema 15），不进 KV。
interface Subtask {
  id: string                       // sub_...
  ticketId: string
  parentSubtaskId?: string         // 缺省 = 直接挂在 Ticket 下
  title: string
  goal: string
  scope?: string                   // 执行提示，不是授权；继承父 Mandate
  state: 'queued' | 'working' | 'waiting' | 'review' | 'blocked' | 'failed' | 'done' | 'dropped' | 'cancelled' | 'orphaned'
  workerSessionId: string          // subtask-<subtaskId>
  depth: number                    // 1 = Ticket 的直接子任务
  createdBy: { kind: 'worker'; sessionId: string }   // 只有父 worker 能请求；没有 human 创建路径
  createdAt: string
  startedAt?: string
  endedAt?: string
  report?: { state: ReportState; summary: string; at: string; review?: Review }
  // 父对子任务的唯一决策记录；是 canonical，不再另存 report.accepted。
  // accepted 只表示父 worker 接受工作交付，不等于人的 Review.confirmations 确认。
  // accepted 记录 report.at；子任务再次报告会使旧 accepted 失效，必须重新接受。
  // 只记录终态处置；return_subtask 清除本字段，不写 'returned'。
  resolution?: {
    kind: 'accepted' | 'cancelled' | 'failed'
    by: ActorRef
    at: string
    /** accepted 时必填，绑定被接受的那次报告；新报告/退回后失效。 */
    acceptedReportAt?: string
    reason?: string
  }
  workspace?: { kind: 'worktree' | 'branch' | 'directory'; ref: string }
  merge?: { at: string; by: ActorRef; into?: string; childRevisions: string[]; conflicts: string[]; resolution: 'merged' | 'escalated' | 'none'; reason?: string }
}

// 最终审查的聚合投影；不是新的存储，也不改变单条 Review 契约。
type ReviewSource =
  | { kind: 'ticket'; assignmentId: string }
  | { kind: 'subtask'; subtaskId: string }

interface ReviewConfirmationView {
  /** 稳定标识：ticket:<assignmentId>:<index> 或 subtask:<subtaskId>:<index> */
  ref: string
  source: ReviewSource
  criterion: HumanCriterion
  /** 仅当当前 reviewRevision 已被批准时由投影填充；不是单独确认。 */
  coveredBy?: { by: ActorRef; at: string; reviewRevision: string }
}

interface TaskReviewView {
  /** 当前聚合的指纹；子报告/父报告/验收条件任一变化都会变。 */
  reviewRevision: string
  deliverables: DeliverableSummary[]   // 按 artifact.key 去重；见 6.3
  criteria: RuleCriterion[]
  confirmations: ReviewConfirmationView[]
  accepted?: { by: ActorRef; at: string; reviewRevision: string }
}

interface PendingEnd {
  by: 'thread' | 'follows'   // human stop 走取消级联，不用 pending
  outcome: 'completed' | 'dropped' | 'stopped'
  at: string
  reason?: string
  ref?: string
}
// Ticket 的加法字段：endPending?: PendingEnd。它存在时 Ticket 仍是 live，
// 只是结束被未结束子任务挡住；不能与 ended 同时存在。
```

`Subtask.report.review` 与 `Assignment.report.review` 必须由同一个 `enterReview(deliverable)` 生成，不能手拼；`DeliverableSummary` 只是它的投影，`previewRef.revision` 必须等于 `artifact.revision`，`criteria`/`confirmations` 直接来自 `Review`。这样父审阅和人工最终验收看到的是同一套验收条件。

`TaskReviewView` 是 Ticket 级聚合：父报告 + 所有已接受子任务的 `report.review` 按 6.3 的规则合并；`reviewRevision` 绑定当前聚合。人批准的是这个聚合，不是某一份父报告；子确认因此不会被父 worker 的接受吞掉。

`Subtask.resolution.kind='accepted'` 必须带 `acceptedReportAt` 且等于当前 `report.at`；缺失或过期按“未处置”处理，不能因为字段存在就放行父结束。

### 6.2 存储

**类别覆盖层第一阶段用 KV 文档，不升 schema**：

- key：`task-catalogue.v1`；值：上面的 `TaskCatalogue`；
- 单写者：新增 `TaskCatalogue` 服务（`packages/dsh/src/app/task-catalogue.ts`），所有写操作在 `Store.atomic` 内一次替换文档；
- 读：`tasks.ts` 读取目录并合并投影；`GET tasks` 不写库；
- 为什么不用 SQL 表：类别/归属是低频、小体量、强一致的覆盖层；一个 JSON 文档足够，避免 schema 迁移与回滚成本。
- 何时升级：出现多人并发编辑、按类别分页查询、类别历史长期保留时，再升 schema 16（schema 15 已给子任务），建 `task_category` / `task_placement` 两表；文档形状可 1:1 映射，迁移是加法。

**子任务存储（第 2 期，schema 15）**：

- 新表 `subtask`：`id`、`ticket_id`、`parent_subtask_id`、`title`、`goal`、`scope`、`state`、`worker_session_id`、`depth`、`created_by`、`created_at`、`started_at`、`ended_at`、`report_json`、`resolution_json`、`workspace_json`、`merge_json`。
- 索引：`(ticket_id, state)`、`(ticket_id, depth)`、`parent_subtask_id`；父完成门查“该 ticket 是否有未结束子任务”。
- 迁移是加法：旧 Ticket 没有子任务，视图显示空；不把历史 subagent Session 追溯成子任务。
- 类别覆盖层仍走 KV；子任务不写 KV，避免把执行数据塞进展示文档。

**兼容**：没有 `task-catalogue.v1` 时，任务页按现有计划树渲染；首次归纳/人工编辑时创建文档。类别 KV 不需要迁移；子任务表由 Store 自动迁移到 schema 15（旧库迁移后 `subtask` 为空），这是前向迁移，不是“无需迁移”。

**损坏处理**：文档解析失败时不覆盖、不写回；任务页回退旧树并提示，保留原始 JSON 供诊断。

### 6.3 投影

在现有 `TaskBoardView` 上做**加法**，保留 `milestones` 一个版本：

```ts
interface TaskBoardView {
  generatedAt: string
  categories: TaskCategoryView[]       // 新：含 active/archived，默认只渲染 active，切“已归档”再显示
  unclassified: TaskView[]             // 新
  suggestions: CategorySuggestion[]    // 新：只含 open 且未过期的类别建议，不占类别上限
  milestones: TaskMilestone[]          // 兼容保留；后续标记 deprecated
  totals: {
    milestones: number                  // 旧字段保留
    tasks: number                       // 旧字段保留：计划任务数
    tickets: number                     // 旧字段保留
    open: number                        // 旧字段：live Ticket（Ticket.ended 缺失），不是 tasks - done
    attention: number                   // 新
  }
}

// 新视图的任务总数从 `categories[].tasks` + `unclassified` 计算；
// 不要复用旧 `totals.tasks`（它是计划任务数，不是用户任务数）。

interface TaskCategoryView {
  id: string
  name: string
  goal?: string
  order: number
  state: 'active' | 'archived'
  aliases?: string[]
  status: ActivityStatus               // 类别汇总：用 6.3 的父状态，按失败 > 阻塞 > 待人 > 进行中 > 排队 > 全部完成 > 空闲取最高
  tasks: TaskView[]                     // 扁平；review 行按 reviewedTicketId 在 UI 缩进，不嵌套存储
  counts: {
    tasks: number          // 该类别下所有 Ticket，含 review Ticket
    unfinished: number     // live Ticket，语义与旧 totals.open 一致
    attention: number
    working: number
    done: number
    failed: number
    dropped: number        // 含 lightweight dropped；按 terminal 计，不按 status=done 计
    cancelled: number
    stopped: number        // terminal 优先于 status 计数；有 terminal 时不再计 failed/done
    reviews: number        // kind='review' 的子集；仅信息，不参与 tasks 求和
  } // 对账：tasks = unfinished + done + failed + dropped + cancelled + stopped；tasks 含 review Ticket，reviews 是子集
}

type DeliverableSummary = {
  /** 去重键：`<artifact.kind>:<artifact.ref>:<artifact.revision>`。 */
  key: string
  /** 至少一项；父报告与子报告产出同一 artifact/revision 时合并到同一行。 */
  sources: ReviewSource[]
  at: string                           // 最近一次 report 时间
  artifact: Artifact
  previewRef: PreviewRef
  criteria: RuleCriterion[]            // 机器验收条件
  confirmations: HumanCriterion[]      // 需人确认的条件
  parentAccepted?: { by: ActorRef; at: string } // 子交付被父 worker 接受；不等于人确认
  humanAccepted?: { by: ActorRef; at: string; reviewRevision: string } // 最终聚合被批准
}

interface TaskSourceView {
  source: string                       // github / feishu / conversation / email…
  threadKey: string                    // `source:id`
  label?: string
  url?: string
  open?: boolean                       // 线程是否还开着
  facts: ThreadFacts                   // 来源自己的事实（PR 号、CI、群名…）
  lastEventAt?: string
  lastEvent?: string
}

interface TaskView {
  id: string                           // Ticket.id（裸 id，不加 `ticket:` 前缀）
  kind: 'ticket' | 'review'            // review 是审查 Ticket；其余为 ticket
  reviewedTicketId?: string            // kind='review' 时必填；来自 ownership 推导
  title: string
  form: 'tracked' | 'lightweight'      // 数据里 form 缺省按 tracked
  categoryId?: string
  status: ActivityStatus
  terminal?: 'dropped' | 'cancelled' | 'stopped' // 结束原因；dropped/cancelled 的 status 仍是 done，不能靠 idle 表达
  pendingEnd?: PendingEnd              // PR/线程已关闭但子任务未结束时的挂起结束
  attention?: boolean
  plan?: PlanRef                       // 计划标签，不再当层级
  origin: { source: string; triggerId: string; preview: string; at: string }
  sources: TaskSourceView[]            // 来源锚点：PR、Issue、群、对话线程
  lastEventAt?: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  progress?: { done: number; total: number } // 沿用现有 Ticket 节点的 review 完成数，不是执行步骤
  suggestedCategory?: { id: string; name: string; goal?: string; confidence: number }
  execution: {
    name?: string                      // 现有 Execution.name（工作目录短名）
    sessionId?: string                 // worker-<ticketId>
    assignments: number                // lightweight 固定 0
    subagents?: number                 // 宿主可读时才有；lightweight 为 0
  }
  deliverables: DeliverableSummary[]   // tracked：TaskReviewView 的去重交付；lightweight：始终空数组
  review?: TaskReviewView              // tracked 详情：父+已接受子任务的聚合；lightweight 无
  inline?: { steps: number; lastActionAt?: string; summary?: string; traceId?: string } // lightweight 的执行摘要，不是 DeliverableSummary
  subtasks?: SubtaskView[]             // 仅 tracked 详情查询返回；lightweight 无子任务
  subtaskSummary: { total: number; queued: number; running: number; waiting: number; done: number; dropped: number; cancelled: number; blocked: number; failed: number; orphaned: number; unresolved: number } // running = working/review; unresolved = 上述状态且无 resolution
  executionUnits?: ExecutionUnitView[] // 懒加载或详情读
}

interface SubtaskView {
  id: string                           // sub_...
  parentId?: string                    // 父 subtask；缺省 = 直接挂 Ticket
  title: string
  goal: string
  state: Subtask['state']              // 精确状态；UI 显示
  status: ActivityStatus               // 仅展示/分组；attention 必须从 state 计算，不能读 status
  terminal?: 'dropped' | 'cancelled'   // 终态原因；与 status=done 搭配，禁止用 idle
  workerSessionId: string              // subtask-<subtaskId>
  depth: number
  startedAt?: string
  endedAt?: string
  durationMs?: number
  progress?: { done: number; total: number }
  deliverables: DeliverableSummary[]
  resolution?: Subtask['resolution']   // 可能是旧 accepted；读取时要检查 acceptedReportAt === report.at
  workspace?: Subtask['workspace']
  merge?: Subtask['merge']
  subtasks?: SubtaskView[]             // 懒加载；默认只取一层
  executionUnits?: ExecutionUnitView[] // 节点详情
}

interface ExecutionUnitView {
  kind: 'assignment' | 'subagent'
  id: string                           // assignment id 或子 Session id
  label?: string
  state?: string                       // assignment.state 或子 Session 状态
  sessionId?: string
  startedAt?: string
  endedAt?: string
  deliverable?: DeliverableSummary
}
```

`DeliverableSummary` 不再要求“恰好一个 owner”：它由 `sources: ReviewSource[]` 表达来源，至少一项；同一 artifact/revision 的父/子报告合并成一行并列出所有来源。读取时拒绝空 sources、未知 source、以及 `previewRef.revision !== artifact.revision`。

`TaskView.suggestedCategory` 从 `suggestions` 中包含该 ticket 的条目填充；建议本身不写 `TaskPlacement`，采用后才生成类别与归属。

`Subtask.state` 到 `ActivityStatus` 的映射（只用于展示/分组，不能反推父状态或 attention）：

| Subtask.state | SubtaskView.status | terminal | 显示 |
| --- | --- | --- | --- |
| `queued` | `queued` | — | 排队 |
| `working` | `working` | — | 进行中 |
| `waiting` | `idle` | — | “等待父/下一轮”；父行按 4.6 视为 working，不把 waiting 当 blocked |
| `review` | `review` | — | 待父审阅 |
| `blocked` | `blocked` | — | 阻塞（具体原因看 state/reason） |
| `failed` | `failed` | — | 失败，等父 `resolution` |
| `done` | `done` | — | 已完成 |
| `dropped` | `done` | `dropped` | 已放弃（无交付） |
| `cancelled` | `done` | `cancelled` | 已取消 |
| `orphaned` | `blocked` | — | 孤儿，等父/人处置 |

关键约束：

- **终态绝不用 `idle`**：`idle` 在现有活动模型里是 live、等下一 Trigger 的状态，且被 `matchesActivityFilter('running')` 包含；`dropped`/`cancelled` 用 `done` + `terminal` 表达，否则会出现在“进行中”。
- **`waiting` 不是 `blocked`**：它只是父 worker 一轮正常结束；子任务继续工作。`SubtaskView.status` 是展示字段，attention/父状态/类别汇总必须从 `Subtask.state` 与 `resolution` 计算；任何代码不得用 `SubtaskView.status` 判断“需处理”。
- **`orphaned`** 保持 `blocked` 展示，但必须带原因；它仍是 unresolved，父/人必须写 `resolution`。

`Subtask.report.state`（`ReportState`）到 `Subtask.state` 的映射：`progress→working`、`waiting→waiting`、`ready→review`、`blocked→blocked`、`failed→failed`、`dropped→dropped`。报告里的 `state` 用 `ReportState`，不要重复定义字符串。`dropped` 是“没留下可交付物”，与父主动 `cancelled` 区分。

`TaskView` 是投影，不是存储；不要把它写回 `Ticket`。

**lightweight 的状态单独投影**：不套 tracked 的 `activityStatusOf`/`ticketStage`（它没有 Assignment）。inline run 进行中 → `working`，已排队 → `queued`，`completed` → `done`，`dropped` → `done` + `terminal='dropped'`；不进入 `review`/`answer`/`delivery`/`blocked`，也不产生 `attention`。lightweight 没有子任务，不参与下面的父状态投影。`done` 不表示“成功”，只是已结束；成功/放弃由 `terminal` 区分。

**父 Ticket 的状态要感知子任务**，不能直接套现有 `activityStatusOf`（父在等子任务时会被算成 `idle`）：

| 父状态 | 规则 |
| --- | --- |
| `blocked` | 有未结束（无 `resolution`）子任务处于 `failed`/`orphaned`/`blocked`，或父自己有未回答的 `attention` |
| `working` | 有 `queued`/`working`/`waiting`/`review` 子任务，且没有未结束的 failed/orphaned/blocked |
| 其他 | 没有未结束子任务时，沿用现有 `activityStatusOf`/`ticketStage` |

类别汇总/`status` 按这个父状态计算；`counts.attention` 与右栏“需处理”按下面的 attention 规则计算，不能只看父状态，否则会漏掉普通 `review`/`answer`/`delivery`。

**`attention` 不能只等价于 `status = blocked`，也不能由 `SubtaskView.status` 计算**：沿用现有 `matchesActivityFilter('attention')` 的 person-stage 集合 `{review, answer, delivery, blocked, failed}`，对每个 **未结束的** tracked Ticket 计算；再加上未结束子任务的 `state ∈ {blocked, failed, orphaned}` 且无 `resolution`。lightweight 没有 review/answer/delivery，也没有子任务，默认 `attention = false`。所以父状态为 `working` 但子任务失败时，`attention` 仍为 true；`waiting` 子任务不会因为显示成 `idle` 进入 attention；已结束 Ticket（含 closed/stopped/failed 结束态）一律 `attention = false`，不能把已结束工作算进“需处理”。

### 6.4 API（提案）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `tasks` | 任务页/右栏共用投影；支持 `?category=`、`?status=`、`?source=`、`?q=`；只返回 Ticket 与 `subtaskSummary`，不返回子任务数组 |
| `GET` | `tasks/:ticketId` | 任务详情：来源、子任务、执行单元、去重交付、`TaskReviewView`、最近事件；可由 `GET tickets/:id` 扩展 |
| `GET` | `subtasks/:id` | 子任务详情：父/子、worker、报告、交付物；只读 |
| `POST` | `tickets/:id/approve` | 人工批准最终聚合；body 必须带 `{reviewRevision}`，过期/未结束子任务/确认缺失都拒绝 |
| `GET` | `tasks/:ticketId?subtasks=2` | 子任务展开深度；默认 1 层，最多 5 层 |
| `POST` | `task-categories` | 新建类别 |
| `POST` | `task-categories/suggestions/:id/accept` | 采用建议：只写仍无人工 placement 的 Ticket；有人工冲突返回 409，不覆盖 |
| `DELETE` | `task-categories/suggestions/:id` | 忽略建议：写 `state=dismissed`/`dismissedAt`，不删除记录 |
| `PATCH` | `task-categories/:id` | 改名/目标/排序/归档 |
| `POST` | `task-categories/:id/merge` | 合并到目标类别 |
| `POST` | `task-categories/:id/split` | 拆出新类别 |
| `PATCH` | `tasks/:ticketId/placement` | 人工移动任务 |
| `DELETE` | `tasks/:ticketId/placement` | 恢复自动归纳 |
| `POST` | `tasks/reclassify` | 批量重跑（未归类/全部） |

所有写接口必须带当前 `TaskCatalogue.revision` 作为 `baseRevision`；返回新 revision。错误沿用现有 `UserError` 风格，面板本地化。建议接受还要在服务端重查每个 `ticketIds` 的 placement：任一已是 `manual` 就返回 `409 { code:'manualPlacementConflict', ticketIds }`，不写类别、不改建议状态，避免“采用建议覆盖后来的人工移动”。

请求体示例：

```jsonc
// POST task-categories/:id/merge
{ "targetId": "cat_...", "baseRevision": 12, "reason": "两个客户交付线重复" }
// POST task-categories/:id/split
{ "name": "税务申报", "goal": "...", "ticketIds": ["t_..."], "baseRevision": 13 }
// PATCH tasks/:ticketId/placement
{ "categoryId": "cat_..." , "baseRevision": 14, "reason": "用户手动移动" } // null = 移出类别
// POST task-categories/suggestions/:id/accept
{ "baseRevision": 15 }
```

### 6.5 事件与审计

- 类别/归属的变更记录在 `TaskCatalogue.history`，在任务详情“变更记录”展示；不进入 `activity` 表，避免为展示元数据扩展 `DomainEvent`。
- 任务状态、执行、交付仍由现有领域事件与 `activity` 提供；任务视图只读。
- 子任务的 started/report/ended 进入现有活动流时，需要给 `ActivityRecord.subject` 增加 `subtask` 类型（加法）；父任务的事件仍聚合到 Ticket，避免右栏被每个子任务刷屏。
- 子任务报告以 `TicketInput` 的新 `subtask-report` 变体进入父 worker，**不是用户消息**：不触发 Eval、不创建 Ticket、不产生人的注意力请求。父 worker 的审阅动作（接受/退回/取消）只写 `Subtask.resolution`（canonical）与 `Subtask.merge`、活动记录；不再写 `report.accepted`，避免两份接受记录漂移。

```ts
// 加在 TicketInput 的 closed union 里；不是 Trigger，不经过 Eval
| { id: string; kind: 'subtask-report'; subtaskId: string; state: ReportState
    summary: string; at: string; review?: Review }
| { id: string; kind: 'end-gate'; pending: PendingEnd }
```

- **唤醒规则**：子任务报告或 `end-gate` 入队后，Engine 立即尝试启动/恢复父 Assignment（即使父刚才报告 `waiting`/空闲），不经过 Eval、不创建 Ticket；同一子任务最多一条待处理报告，后续报告合并/替换，避免父被刷屏。`end-gate` 与 `subtask-report` 可同批投递，父按“先处理子任务、再应用 pending end”的顺序消费。父 Ticket/父 worker 已不可恢复时，报告不投递，子任务转 `orphaned` 交人；`end-gate` 则转成一次 attention。
- 这是 `TicketInput` 的加法变体；现有 `trigger`/`text`/`note`/`binding` 等路径不变，旧客户端忽略陌生 kind。
- 如果后续需要“类别变更也出现在事件流”，再把 `task.category.*` 加为 `DomainEvent`，并给 `ActivityRecord.subject` 增加 `category` 类型；这是加法，旧记录不受影响。

### 6.6 最终审查聚合（子任务确认进入 Ticket）

`Assignment.report.review` 仍然只描述**一次** Assignment 的交付；任务树需要的是 **Ticket 级聚合**。增加只读投影 `TaskReviewView`（不是新存储，不改变现有 `Review` 契约）：

1. **收集**：父 Ticket 最新 Assignment report 的 `review` + 每个 `Subtask.resolution.kind='accepted'` 且 `acceptedReportAt === report.at` 的 `Subtask.report.review`。`return_subtask`（清空 resolution）/`cancelled`/`failed`/新报告使旧接受失效，不进入聚合。
2. **交付去重**：按 `DeliverableSummary.key = artifact.kind:artifact.ref:artifact.revision` 合并；同一 revision 的父子交付只保留一行，`sources` 记录 `{kind:'ticket',assignmentId}` 与 `{kind:'subtask',subtaskId}`。这样“父合并后最终交付只出现一次”有可执行键，不靠 UI 去重。
3. **确认聚合**：每个来源的 `Review.confirmations` 保留为 `ReviewConfirmationView`，`ref` 用稳定下标（`ticket:<assignmentId>:<i>` / `subtask:<subtaskId>:<i>`），并带 `source`/`criterion`；人能看到每条确认来自哪个子交付。投影不把 `HumanCriterion` 改写成父 worker 的声明。
4. **评审指纹**：`reviewRevision = sha256` over 排序后的 `(sourceKind, sourceId, report.at, artifact.key, criteria, confirmations)`。任何子报告、父报告或验收条件变化都会换 revision。
5. **最终批准**：`POST tickets/:id/approve` 必须带 `{reviewRevision}`；`Assignments.review` 重新计算当前聚合：
   - `reviewRevision` 不匹配 → `409 reviewStale`，不写批准；
   - 仍有未结束子任务 → `unfinishedSubtasks`；
   - 聚合里任一 `HumanCriterion` 没有来源/不在当前 revision → 拒绝；聚合中的每条确认都由批准整体覆盖；
   - 通过后写 `Assignment.report.accepted = {by,at,reviewRevision}`，并在 `TaskReviewView.accepted` 记录同一 revision。
   `Tickets.end` 对 `outcome='completed'` 且聚合里有 `confirmations` 的结束也必须要求 `TaskReviewView.accepted.reviewRevision` 等于当前 revision；`dropped`/人停止可以不走批准，但不能把未确认的交付标成“已验收”。批准成功后，如果没有 `follows`/`pendingEnd`，`Assignments.review` 调 `Tickets.end(..., 'completed')`；有 follows 则等 PR/线程关闭，有 pending 则按 pending 应用。

   为了让这条门有入口：`Assignments.report` 的 `ready` 在聚合含 `confirmations` 时**不直接调用 `Tickets.end`**，而是进入 review 阶段并保留 `TaskReviewView`；人 `approve` 后才结束（有 follows/pending 时先不结束，等 PR/线程关闭走 pending）。没有 `confirmations` 的 ready 仍按现有路径结束。这是对现有“ready 即结束”的一处有意识改动；只在有最终确认时生效。若 PR/线程关闭的 `Tickets.end` 遇到含 `confirmations` 但尚未批准的聚合，也不能静默结束：写 `endPending`（by=thread/follows）并生成一次“PR 已合并，待最终确认”的 attention；人 `approve` 后应用 pending。父 worker 已不存在的，直接交人，不让 pending 永久挂着。
6. **父子责任**：`accept_subtask` 只写 `Subtask.resolution.kind='accepted'` 与 `merge`，**不写**人的确认；父 worker 的接受不能替代 `Assignments.review`。只有最终 Ticket 的聚合批准才把 `humanAccepted` 填到对应交付行。
7. **无交付的 Ticket**：`TaskReviewView` 为空；仍可结束，但不能声称“已验收”；UI 显示“无交付”。
8. **lightweight**：没有 `Assignment.report.review`/`Subtask`，不产生 `TaskReviewView`；`TaskView.review` 缺省，人工不能批准一个不存在的 review。

UI：Ticket 详情的“交付与审查”区块读 `TaskReviewView`，不再只读 `ticket.review` 的最新 Assignment；`TaskView.review` 是详情字段，列表只显示去重后的 `deliverables` 摘要。`GET tickets/:id` 的 review 视图同步改为聚合，避免两套验收口径。

测试：子任务有 `HumanCriterion` → 父接受后仍出现在最终 review；人批准的 `reviewRevision` 覆盖该条；子任务再次报告后旧 revision 失效，必须重新批准；父子同一 artifact/revision 只出现一行；未结束子任务不能批准；父 worker 不能通过 `accept_subtask` 清掉人的确认。

## 7. UI 形态与状态

### 7.1 两个面，一个投影

| 面 | 定位 | 内容 |
| --- | --- | --- |
| 右侧栏“任务”tab | 监督时随手看，和事件并列 | 紧凑列表/树、子任务一层、筛选、选中详情、与事件互相定位 |
| 状态页“任务” | 完整管理 | 列表/树/看板/图、类别管理、任务与子任务详情、批量操作 |

两者都读 `GET tasks`；右栏不另建接口，状态页也不另算归属。

### 7.2 右侧栏任务 tab

**注册方式**：按现有 events tab 的写法，先用 `ctx.get('sidebarRightTabs')?.register({ kind: 'system-tasks', id: 'dsh-superagent.tasks', title, priority: 'extension', guide })` 注册**类型**；再在 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` 两个槽按同一个 `key` 注册 body/title。`sidebar.right.pane.tab` 是 body 槽，不是类型注册本身。用户看到的是一排 tab：`任务 | 事件`，这满足“和事件视图一样、可 tab 切换”，同时保留每个 tab 独立打开/关闭/浮动/停靠的宿主能力。

**挂载约束**：右栏 tab 不在管理面板的 React 树里，不能依赖 `TasksPage` 的 `usePanel()` context。新建一个轻量 `TasksStore`（`GET tasks` 的 fetch/poll + 选中态），右栏与状态页都可复用它；状态页仍保留自己的路由与详情导航。

**布局（约 360px 宽）**：

```text
┌ 任务  [3 需处理]                    ⟳ 在状态页打开 ┐
│ [全部] [需我处理] [进行中] [失败]                  │
│ 类别：全部 · 客户服务 · 业务拓展 · …（横向滚动）      │
├──────────────────────────────────────────────────┤
│ 客户服务                            3 个任务 · 1 待办 │
│  ● 华兴科技 2025 汇算清缴       进行中  3/5  12m   │
│    对话 · 飞书 · PR #21              交付 1 待验收   │
│    └ 资料解析（sub_…）          完成    subtask-…  │
│    └ 底稿核算（sub_…）          进行中  subtask-…  │
│  ● 恒润制造 2025 涉税风险体检   需我处理            │
│    …                                              │
│ 业务拓展                                             │
│  ● 某税局智能问答系统投标       进行中  …            │
├──────────────────────────────────────────────────┤
│ 未归类                            1 个任务           │
│  ● 等固定资产清单到位后补进底稿  来自邮件            │
└──────────────────────────────────────────────────┘
```

- **默认列表**，不默认树：窄栏里树的缩进与连线会吃掉宽度；点任务行按需取一级子任务，再点“展开执行”看 Assignment/subagent。
- **类别分组头**只在有类别时出现；“未归类”永远在最后，不隐藏。
- **建议区**：未归类上方显示“类别建议：客户服务（3 个任务）[采用] [忽略]”；建议不占类别上限，采用后才进入类别列表。
- **任务行**：状态点 + 标题 + 状态词 + 来源 chip（最多 3 个，超出显示 `+N`）+ 进度/交付摘要 + 最近事件时间。父 worker 与 Session 放在展开区；子任务行显示自己的 worker，不挤来源 chip。lightweight 行加“轻量”badge，不显示 worker/Session，也没有展开箭头。
- **展开区**：仅 tracked 节点有；子任务行（标题、状态、自己的 worker）、父 worker 的交付审查/合并摘要、最近 3 条事件、“打开任务页”。子任务行再展开执行细节。lightweight 的详情是 action ledger + summary，不伪装成“待验收”。
- **选中与联动**：`TaskSelection = { kind: "ticket" | "subtask"; id: string }`。选中 Ticket 后切到“事件”tab，事件列表筛到该 Ticket；选中子任务时筛到父 Ticket，并在任务 tab 展开该子任务。在事件里点某条记录，切回“任务”tab 并定位对应 Ticket/子任务。两 tab 共享这个轻量状态（Session 内，不写库）。注意：现有 `EventsTab` 只有 all/attention/running/failed 筛选，**没有按任务筛选**；第 1 期要给事件分组加一个 `task` 维度，否则联动落不了地。
- **未读/需处理**：tab 标题显示需处理任务数（review/answer/delivery/blocked/failed，加上未结束子任务的 blocked/failed/orphaned），与事件未读数分开，避免两个数字混在一起。
- **数据范围**：`GET tasks` 是进程级数据，不按当前 Session 过滤；任何 Session 打开任务 tab 都看到同一份任务，和现有 `EventsTab` 一致。`masterId` 未知时只显示“正在连接主会话”，已知后正常显示；不要照搬 `SystemView` 的“仅主会话”限制（那只适用于状态页内嵌）。
- **不抢注意力**：任务 tab 不因未读自动弹出；只有用户打开时才读取/轮询，避免和事件 tab 的自动打开叠加。

### 7.3 状态页任务页

保留现有 tab，但内容重构：

```text
任务
[全部] [需我处理] [进行中] [失败] [已归档]   搜索…
类别：[全部] [客户服务] [业务拓展] …          + 新建类别
视图：[列表] [树] [看板] [时间线]             排序：[需我处理优先 ▾]
────────────────────────────────────────────────────────
客户服务                                    3 个任务 · 1 待办
  华兴科技 2025 汇算清缴     进行中   3/5   12m   …展开
    └ 资料解析（子任务）      完成     subtask-…  交付通过
    └ 底稿核算（子任务）      进行中   subtask-…  2/3
        └ 固定资产底稿        进行中   subtask-…  执行细节
  恒润制造 2025 涉税风险体检  需我处理  …
未归类
  …
```

- **列表**：默认。一行一个 Ticket（tracked 或 lightweight），类别分组行可折叠；tracked Ticket 行展开一级子任务，子任务行再展开执行细节；lightweight 行无展开。
- **树**：类别 → Ticket → 子任务 → 更深子任务；默认展开到 L3，L4+ 折叠；执行单元/交付物在节点详情，不占层级。
- **看板**：列 = 状态（需我处理 / 进行中 / 等待 / 已完成 / 失败；9 个 `ActivityStatus` 到 5 列的映射在第 4 期定），泳道 = 类别；卡片 = Ticket。卡片显示子任务完成数与父 worker 的审阅/合并状态（lightweight 卡片只显示 inline 摘要，不显示待验收/子任务）；点卡片展开子任务，不默认把每个子任务画成独立卡片。拖拽**只发生在类别泳道之间（纵向）**，横向状态列只读；试图横向拖时提示“状态由执行决定”，不允许绕过授权与结束条件。
- **时间线**：沿用现有“每个类别一条时间轴、每个任务一条泳道”的画法；Ticket 泳道内显示子任务条与父 worker 的合并点，表达父子并行与汇合；没有依赖数据就不画依赖箭头。现有 `graphOf` 可按类别复用，但要把“里程碑”换成“类别”。
- **类别管理**：分组行内联改名；多选任务后“移动到/合并到”；类别菜单“拆分/归档/恢复自动”；“已归档”开关显示归档类别与其任务。最近一次编辑可撤销。
- **审查 Ticket 行**：`kind='review'` 的任务用“审查”标签，按 `reviewedTicketId` 缩进到被审 Ticket 下；被审 Ticket 不在当前类别时单独成行。类别计数把 review Ticket 计入 `tasks`，并另显示 `counts.reviews`；不要把审查关系塞进 `progress` 数字。
- **结束原因**：dropped/cancelled/stopped 行显示“已放弃/已取消/已停止”，状态点仍按 done/terminal 表达，不能显示成 idle/进行中；`pendingEnd` 行显示“PR 已合并，N 个子任务待处置”。
- **建议**：未归类/批量归纳产生建议时，显示在“建议”区；采用后建类并写入归属，忽略则 30 天内不再提示。
- **任务详情**：可由现有工单页扩展，也可新开 `?task=` 路由；建议先扩展工单页（见 7.4），避免第二套详情。

### 7.4 任务详情

顶层任务 = 工单；子任务详情复用同一套组件，隐藏 Mandate/来源锚点，显示父目标、子 scope、自己的 worker 与父审阅状态。详情不是新数据源，而是把现有工单页重组为“任务面”：

| 区块 | 内容 | 现有来源 |
| --- | --- | --- |
| 头 | 标题、form（tracked/轻量）、类别（仅 Ticket 可改）、状态、来源（子任务显示父 Ticket）、耗时 | `GET tickets/:id` / `GET subtasks/:id` + `form` + 类别 |
| 目标与来路 | Ticket 显示 Mandate scope、origin Trigger 摘要、计划标签；子任务显示父目标、子 scope、委派原因 | 现有 + `Subtask` |
| 子任务 | 仅 tracked：直接子任务列表（标题、状态、自己的 worker、交付摘要、最近报告）；父节点显示“审阅/合并”进度；停止父任务/重试仍走工单页；子任务由父 worker 取消。lightweight 无此区块 | `TaskView.subtasks` / `SubtaskView` |
| 谁在执行 | tracked：父 worker、当前节点 worker、子会话（subagent）、Assignment 历史；lightweight：显示 inline 执行与 action ledger，不显示 worker/Assignment；不编造“执行 Agent”名字 | `workerSessionId`、`Subtask.workerSessionId`、assignments、inline action |
| 来源锚点 | Channels/Threads、PR/Issue/群/对话线程、关闭状态、最近事件；子任务继承父 Ticket 的来源，不单独建锚点 | `threads` |
| 产出与交付 | tracked：每个节点从自己的 `report.review` 汇总 artifact/revision/preview/验收条件/批准状态；Ticket 详情用 6.6 `TaskReviewView` 展示父+已接受子任务的去重交付与确认来源，人按 `reviewRevision` 一次批准。子任务交付先由父 worker 审查。lightweight：只显示 inline summary/action ledger，**没有 Review/确认** | `latestReport` / `report.review`（现有 + 子任务）+ `TaskReviewView`；lightweight 用 inline action |
| 父审阅/合并 | 子任务交付被接受/退回的记录、`Subtask.merge`（子 revision、冲突、`merged`/`escalated`）、冲突处理；只有父 worker 能推进 | `Subtask.report` / `Subtask.merge` + 活动 |
| 事件 | 该任务最近事件，可跳事件 tab | activity |
| 工作目录 | 现有工单页展示的执行目录 | `Execution.directory`（现有） |
| 操作 | tracked：打开工单、打开会话、打开 PR、改名/移动类别；停止/重试/验收仍走原按钮。lightweight：无会话/重试/验收按钮，只可发起 tracked follow-up | 现有 + form |

任务级“目标”先用 `Mandate.scope` 与 origin 文本表达，不为任务新增 `goal` 字段；如果后续用户确实需要一句话目标，再在覆盖层加（不改 `Ticket`）。

**会话要分四类，不能只给一个“Session”按钮**：

- 来源会话：任务从哪段对话/线程来（对话 Source 的主会话或 Thread），回答“当初是谁在哪说的”；
- 父 worker：`worker-<ticketId>`，回答“谁对最终目标负责”；
- 当前节点 worker：Ticket 节点就是父 worker；子任务是 `subtask-<subtaskId>`，回答“这个子任务谁在做”；
- 子会话：节点 worker 开的 subagent，回答“节点里拆出去的哪一步是谁在做”。
- lightweight：没有以上四类 worker/session；只显示 inline run 的 step/action ledger，不伪造会话。

任务详情分别给入口；任务行只显示当前节点 worker，父 worker/来源会话放在展开区/详情，避免窄栏堆按钮。

### 7.5 三视图的分工

| 视图 | 回答什么问题 | 适合宽度 | 第一期 |
| --- | --- | --- | --- |
| 列表 | 有哪些任务、谁需要我处理 | 右栏 + 全页 | 是（第 1 期 Ticket，第 2 期子任务） |
| 树 | 一个类别下任务怎么拆、子任务与父/子 worker 是什么关系 | 全页（右栏只做紧凑展开） | 第 2 期（Ticket 树第 1 期） |
| 看板 | 各类任务堆在哪个状态、哪里堵住 | 全页 | 第 4 期 |
| 时间线 | 父子任务什么时候并行、什么时候汇合/合并 | 全页 | 第 2 期起（复用现有图，加子任务条） |

右栏不提供看板/图：360px 下看板列与时间轴都不可读；给“在状态页打开”入口。

### 7.6 状态与空态

| 状态 | 表现 |
| --- | --- |
| 首次加载 | 骨架/“正在读取任务”，不闪空态 |
| 无任务 | “还没有任务。从对话或来源事件派一件。” + 打开主会话 |
| 有任务、无类别 | 显示任务列表 + “生成任务类别”按钮；不阻塞 |
| 有未归类 | 未归类分组置底、常显，可一键归入 |
| 有类别建议 | 未归类上方显示建议卡片（名称、支持任务数、采用/忽略），不自动建类 |
| 只看已归档 | 归档类别默认隐藏；打开“已归档”显示其类别与任务，不丢任务 |
| 归纳中 | 类别头显示“归纳中…”；任务仍可见 |
| 归纳失败 | 未归类 + “重新归纳”，不弹错误对话框 |
| 空筛选 | “当前筛选下没有任务” + 清除筛选 |
| 读取失败 | 错误条 + 重试；保留上次数据并标“可能已过期” |
| 子任务未结束 | 父 Ticket 状态按“有未结束子任务”投影为 `working`/`blocked`，不显示 `idle`；父行显示“N 个子任务未结束”；父任务不能显示“已完成” |
| 子任务失败/阻塞 | 子任务行标失败/阻塞；父行显示“待父 worker 处理”，不自动把父任务标失败 |
| 子任务等待父/审批 | 子任务行显示“等待父/审批”；父行按 6.3 投影为 working/blocked，不把等待算成 idle |
| 子任务孤儿 | 父 worker 不在了：标 `orphaned`，父行提示“需要人决定重试/取消”，不静默重跑 |
| 轻量任务 | 行标“轻量”，无展开、无 worker/交付/审批；详情显示 action ledger + summary；需要保留/审批/外部写时提示发起 tracked 任务 |
| 父任务停止 | 子树全部显示“已取消”，禁用子任务写操作 |
| 主会话未知 | 显示“正在连接主会话”，不显示空列表；已知后正常显示，右栏不按当前 Session 过滤 |
| 写冲突 | 提示“已被其他操作更新”，刷新后重试；不静默覆盖 |

### 7.7 交互与可访问性

- 状态不只靠颜色：状态点 + 文字 + `aria-label`。
- 行可键盘聚焦，`Enter` 打开，`Esc` 收起详情；展开按钮有 `aria-expanded`。
- 看板拖拽必须有键盘替代（菜单“移动到类别”）。
- 右栏 360px、状态页 1440/1280 两档验证；深浅主题都验证。
- 不新增装饰性动画；折叠/展开用宿主已有过渡，尊重 `prefers-reduced-motion`。
- 视觉沿用 DSH token，不引入新色板；类别只用小圆点标识，不整行染色。

## 8. 与现有实现的工程差距

| 区域 | 需要改/新增 | 说明 |
| --- | --- | --- |
| 归属 | `ownership.ts` 推导 Ticket→计划/审查父级；事件→工单的索引由 `tasks.ts` 消费；新增类别解析链，计划解析降为标签 | 计划编号不再决定 L1；不要把 `ownership.ts` 说成事件归属的唯一来源 |
| 投影 | `app/tasks.ts` 增加 `categories`/`unclassified`/`TaskView.subtasks`/`TaskView.form`/`inline`/`kind`/`reviewedTicketId`/`review`；保留 `milestones` | 一个投影，所有视图共用；review 关系来自 `ownership.ts`，不能由客户端猜；lightweight 不能套 tracked 的 Assignment 假设 |
| 子任务模型 | 新 `Subtask`（kernel 类型）+ `subtask` 表（schema 15）+ 迁移 | 执行数据，不是覆盖层 |
| 委派 | 新 `delegate_task` 工具 + Engine 校验（父存活、同 Mandate/maxActionLevel、深度/宽度/配额）+ 子 worker Session | worker 只能请求，Engine 写；文本 scope 不参与授权 |
| 子 worker 生命周期 | Executor 为每个子任务起独立 worker（`subtask-<subtaskId>`），持久化、重启恢复、停止级联；受限执行配置（网络/remote/gh/命令/cwd/无 subagent） | 不是 subagent；不能复用临时子会话；仅靠工具列表挡不住外部动作 |
| 父审阅 | 子任务报告进入父 worker 输入；`accept/return/cancel_subtask`；结束门（不只 ready）；`TaskReviewView` 聚合子确认，`reviewRevision` 绑定最终批准；`Subtask.merge` 合并/冲突记录 | 父接受不等于人确认；子确认不能漏；合并可审计 |
| 报告唤醒 | `TicketInput` 增加 `subtask-report` 变体；Engine 启动/恢复父 Assignment，每个子任务最多一条待处理报告 | 不经过 Eval；父空闲也能收到子报告 |
| 结束门 | `Tickets.end`/`unfinished` 纳入子任务；`Assignments.report` 的 ready/dropped、`threadClosed`/`followsDone`、人停止全走同一门；PR/线程关闭未完成时写 `Ticket.endPending` + `end-gate` 输入；父 failed 非终态、取消子任务；失败/孤儿需 `Subtask.resolution` | 不能只挡 ready，不能静默结束，也不能留下无主 pending；不要新增 failed outcome |
| 归纳 | 新 `TaskCategorizer` + 效果队列 `task.classify`；建议池 `suggestions` | 只分类 Ticket；异步、可关闭、可重试 |
| 覆盖层 | 新 `TaskCatalogue`（KV） | 单写者、revision、history |
| API | `api.ts`/`http.ts` 增加类别写接口、`GET subtasks/:id`、`?subtasks=` 查询参数 | 加法，旧字段保留 |
| 右栏 | `client/index.tsx` 注册类型（`sidebarRightTabs.register`）+ body/title 两个槽；新 `TasksTab` | 与 `EventsTab` 并列，共享 selection；子任务只展开一层 |
| 面板 | `client/tasks.tsx` 重构为列表/树/看板/图；新增 Ticket/子任务详情 | 现有树/图代码可复用 |
| 事件联动 | `system.tsx` 的 `ActivityGroup` 与任务选择共享；`EventsTab` 增加 `task` 筛选 | 子任务事件聚合到父 Ticket，避免刷屏 |
| 会话 | 父/子 worker Session 分别显示；子任务用 `subtask-<subtaskId>` 与 `(ticketId, subtaskId)` 注册表，扩展 `ticketOfSession`、`Sessions.decorate`/`ticketOf`/`workOnly`/`limitSubagent`/预设/工具注册、`DshExecutor.install` 的 status/inbox/session/error 处理器与 per-subtask lifecycle；subagent 仍是执行细节 | 不伪造执行者；不能复用 `worker-` 前缀；子事件不能写到父 Assignment |
| 交付 | tracked：每个节点由自己的 `report.review` 投影；`TaskReviewView` 按 artifact key 去重父子交付、聚合 `confirmations`；子任务交付先给父 worker 审阅，Ticket 最终交付再按 `reviewRevision` 给人。lightweight：只有 inline summary/action ledger，没有 Review/确认 | 不建第二份交付库；不把 inline summary 冒充交付；父子同一 revision 不重复 |
| 迁移 | 类别 KV + schema 15 子任务表；旧 Ticket 无子任务；不追溯 subagent | 回滚见第 10 节 |
| 测试 | 归属规则、投影、写冲突、父子门禁、委派配额、停止级联、重启恢复、右栏 UI、事件联动、空态/错误态；tracked + lightweight 共存、lightweight 无 worker/交付/子任务；review 聚合/revision、terminal 映射、pendingEnd、建议冲突 | 见第 9 期验收 |

## 9. 分阶段落地

### 第 0 期：lightweight 运行时前置（仅在产品要支持轻量时）

这不是任务视图本身的工期，而是第 1 期里 lightweight 行能否验收的前置条件：

- 生产 `InlineExecutor` 实现并注入 `assembly.ts`；`Tickets.startInline`/`wake` 能在生产装配下运行；
- Eval/assessor 显式选择 `form`，`prepareTicket` 执行 3.5.1 的约束（review/workspace/子树/外部写必须 tracked）；
- 没有生产 `inline` 时，accept 不得选择 lightweight；启动时缺 `inline` 必须拒绝，而不是静默创建无执行器的 Ticket；
- 重启恢复策略明确：当前 lightweight 不做恢复；升级只走新 Thread/对话（3.5.3）。

**Phase 0 未完成前，第 1 期只验收 tracked；lightweight 行只做前向兼容渲染，不声称产品已能受理。** 这避免把 kernel-only 状态伪装成运行时事实。

### 第 1 期：右栏只读任务视图（先让用户看见）

- 注册右侧栏“任务”tab；列表/紧凑展开；共享 `GET tasks`。
- 任务行显示来源、最近事件、最近一次交付摘要（`report.review`）和 form badge；tracked 显示父 worker，lightweight 显示“轻量”，不显示 worker/交付。任务详情链接到工单页。
- 保留现有计划树作为状态页的回退视图；不做类别、不做子任务、不做编辑。
- 验收：右栏能在 360px 下看清任务与状态；切到事件 tab 能按任务筛选；两处状态一致；无新增写路径。

### 第 2 期：子任务树 + 每个 tracked 节点的 worker + 父子契约

这是本轮评论要求的核心，单独一期，不能塞进“不改 schema”的第 1 期。

**2a 运行时**

- schema 15 加法建 `subtask` 表；`Subtask` 类型与状态机。
- Engine 的 `delegate_task`：父 worker 请求，Engine 校验父存活、同 Mandate/maxActionLevel、深度 ≤5、单节点 ≤8、单 Ticket 活跃 ≤32，创建 Subtask 与子 worker。
- 子 worker：独立 Session、独立目标/scope、向父报告；不能创建 Ticket、不能直接找人。
- 父 worker：收到子报告；`accept_subtask` / `return_subtask` / `cancel_subtask`；父 `ready` 前检查无未结束子任务；合并/冲突记录；`accept_subtask` 只写 `resolution`，子确认进入 6.6 聚合，不替人确认。
- 结束门：`ready`/`dropped`/人停止/`follows` PR 合并都经过 `Tickets.end`，不能只挡 `ready`；PR/线程关闭有未结束子任务时写 `endPending` + `end-gate`，父处置后应用；父 `failed` 不是终态，取消子任务后 Ticket 保持 live；失败/孤儿子任务先写 `resolution`。
- 停止级联、失败不自动上卷、重启恢复、孤儿标记 `orphaned`。
- 活动流：`ActivityRecord.subject` 增加 `subtask`；父 Ticket 聚合显示。

**2b 视图**

- 列表/树显示 tracked Ticket → 子任务（默认一层，更深折叠）；子任务行显示自己的 worker、状态、交付摘要；Ticket 详情的交付审查用 6.6 `TaskReviewView`，显示子确认来源与 `reviewRevision`。lightweight 是叶子，不显示子任务。
- 父节点详情显示子任务、父审阅/合并状态；子节点详情复用组件，隐藏 Mandate/来源锚点。
- 右栏只显示一层子任务；完整树进状态页。
- 验收：父 worker 能创建 2 个子任务，各自有 worker；父能看到子交付并接受/退回；有未结束子任务时父不能 `ready`；停止父任务级联停止子任务；重启后子任务状态不丢；超过深度/宽度返回明确错误；不产生子 Ticket。

### 第 3 期：类别归纳（只读）

- 新增 `TaskCatalogue` KV 与 `TaskCategorizer`；新 Ticket 异步归类；历史 Ticket 可手动触发批量归纳。
- 任务页/右栏按类别分组；“未归类”常显；类别上限与归档；类别建议只读展示（不自动建类）。
- 子任务继承父类别，不单独分类。
- 保留“按计划查看”开关。
- 验收：类别可解释（有 reason）；未归类不隐藏；模型失败不影响任务；事件分组与任务分组不矛盾；类别计数只算 Ticket（tracked 与 lightweight 都算）。

### 第 4 期：人工编辑、执行细节、交付详情、看板

- 类别改名、改目标、排序、移动、合并、拆分、归档/恢复、恢复自动；采用/忽略类别建议。
- tracked 节点详情展示 Assignment / worker Session / subagent；交付物详情展示 artifact/revision/验收状态/批准历史。lightweight 详情展示 inline action ledger/summary，不显示这些。
- 看板（状态列 × 类别泳道，卡片 = Ticket，显示子任务进度）；时间线加子任务条与父合并点。
- 验收：人工修改不被 Agent 覆盖；刷新/重启后保持；合并/拆分后任务不丢；冲突提示可恢复；看板不改变任务状态；交付物空态不误导。

### 第 5 期：硬化

- 性能：单次投影、无 N+1、右栏轮询与 SSE 协调；bundle budget；子任务树懒加载。
- 可访问性、深浅主题、窄屏；键盘与读屏。
- 迁移/回滚演练；日志与指标（归纳成功率、人工纠正率、未归类比例、子任务深度/失败率、父审阅时长）。
- 子 Ticket（若决定做）：必须先完成 delegation Eval 授权设计，不在本期偷偷加。

### 9.1 可测的验收指标

- **360px 右栏**：无横向滚动；标题最多 2 行；状态、来源、最近事件在首屏可见；展开/折叠点击目标 ≥28px。
- **投影性能**：500 个工单、每工单 ≤5 个来源时，`GET tasks` 本地 p95 ≤300ms；单次请求 SQL 查询数 ≤10（测试里计数，禁止按工单循环查询）；右栏任务 chunk gzip 增量 ≤20KB（`check:size`）。
- **联动**：选中任务后事件 tab 只显示该任务的事件；返回任务 tab 后选中不丢；刷新后选中可丢，但状态一致。
- **人工优先**：人工改过的任务重跑分类器/重启后不被移走；`baseRevision` 过期返回 409，刷新后可重试。
- **建议**：单个任务不会产生新类别；同一候选累计 2 个任务才出现“采用”按钮；采用后类别与归属同时写入。
- **归档**：归档类别默认隐藏；打开“已归档”仍能看到其任务；任务不会静默进“未归类”。
- **回滚（类别）**：关闭 `taskView.categories` 后刷新回到旧计划树；重新打开后类别/归属仍在；读取失败不覆盖文档。
- **回滚（子任务）**：schema 15 是前向迁移，旧二进制不能打开；验证 down migration 或备份恢复后，子任务表与 worker 状态一致，无孤儿子任务继续写。
- **交付物**：有 `report.review` 的任务，详情首屏直接显示 artifact/revision/验收状态；没有时显示“暂无交付”，不显示空卡片。
- **最终审查聚合**：父 + 已接受子任务的交付按 `artifact.kind:ref:revision` 去重；子任务有 `HumanCriterion` 时，父 `accept_subtask` 后仍出现在 `TaskReviewView`，人必须按当前 `reviewRevision` 批准；子任务再次报告后旧 revision 失效（`409 reviewStale`），旧批准不能复用。
- **审查关系**：`kind='review'` 的 Ticket 带 `reviewedTicketId`，类别计数 `tasks` 包含它、`reviews` 单独可对账；树里挂在被审 Ticket 下，不混成普通任务。
- **终态**：`dropped`/`cancelled` 子任务显示 `done` + `terminal`，不出现在“进行中”；`waiting` 子任务显示 `idle`/“等待父”，但 attention 与父状态仍按 `state` 计算，不能把 waiting 算 blocked。
- **pendingEnd**：PR/线程已关闭但有未结束子任务时，Ticket 不写 `ended`，显示 `pendingEnd`；父恢复后处理并应用 pending，父不可恢复则一次 attention，不能永久挂起。

- **轻量/ tracked 共存**：Phase 0 接通后，lightweight 受理后无 Assignment/worker/workspace；任务视图不显示 worker/交付/子任务，不进入 review/attention；tracked 行仍正常；类别同时计数；lightweight 不能 `delegate_task`；升级后出现新 tracked 节点、旧 lightweight 不被改写。Phase 0 未接通时，此项改为 kernel fixture 测试，不声称产品可受理。
- **父子任务**：父 worker 能在一次运行里创建 2 个子任务，两个子 worker 的 Session id 不同且都能独立报告；父节点在子任务未结束时提交 `ready` 必须被 Engine 拒绝；停止父任务后所有子 worker 在 5 秒内进入 `cancelled`；深度 6、单节点 9 个、单 Ticket 33 个活跃子任务时返回明确错误。
- **子任务审阅**：子任务交付进入父 worker 输入；父 `accept_subtask` 后子任务完成、父任务仍未完成；`return_subtask` 后子 worker 收到意见并继续；父合并后最终交付只出现一次，不在任务视图重复记账。
- **恢复**：运行中重启，子任务从 `subtask` 表恢复；父 worker 不在的孤儿子任务显示 `orphaned` 并要求人决定，不静默重跑、不静默标完成。
- **子任务投影**：500 个 Ticket、2000 个子任务时，`GET tasks` 只返回 Ticket 与 `subtaskSummary`，不返回子任务数组，p95 ≤400ms；单次请求 SQL 查询数 ≤12；展开一个 Ticket 时按需取一层，≤200ms；右栏不因每个子任务多一次查询（禁止 N+1）。

### 9.2 子任务契约测试（第 2 期）

- 子 worker 没有 `delegate_ticket`、`send_message`、commit/send/spend/merge/审批请求工具；尝试创建 Ticket 或直接找人必须失败并记录。
- 子 worker 的 `bash` 受限：`git push`、`gh pr create`、`curl` 外网、写父受保护路径、`subagent` 都失败；子 worker 的 subagent 不能借 `limitSubagent` 重新拿到父/子执行工具。
- `subtask-<subtaskId>` 能通过注册表解析到 `(ticketId, subtaskId)`，不会把 `-sub` 当 ticketId；`decorate`/`ticketOf`/`workOnly`/`limitSubagent`/预设/工具注册都命中子任务，写保护同时检查父 Ticket 与子任务状态。
- 子 session 的 `agent/status`/`agent/error` 只推进子任务，不调用父 Assignment 的 `workerIdle`/`failed`；子 worker 的 subagent 绑定最近的子任务并继承受限执行配置。
- `delegate_task` 在深度 6、单节点 9 个、单 Ticket 33 个活跃子任务时拒绝；错误可读，不静默截断。
- 子 worker 不能提高 `maxActionLevel`；父 Mandate 原样继承，文本 `scope` 不能当授权。
- 父 `ready`/`dropped`、人停止、`follows`/PR 合并四条结束路径：有未结束子任务时都不能静默结束；`dropped`/人停止取消子树，PR 合并先挂起并产生一个注意力请求；父 `failed` 取消子树但 Ticket 保持 live、可重试。
- `ready` 有未结束子任务时返回 `unfinishedSubtasks` 且不写 ready 报告；`Assignments.review`/`reviewTicket` 对未结束子任务同样拒绝，防止人提前批准。
- 父在 `waiting`/空闲时子任务报告能唤醒父 Assignment 并得到新 turn；同一子任务连续报告只保留一条待处理，不重复唤醒。
- 父 `failed` 后子 worker 写入被拒绝、状态为 `cancelled`；父 `blocked` 时子 worker 只有只读/草稿权限；父 `waiting`（正常轮末）时子 worker 继续工作，不能被降为只读。
- 重启恢复先父后子，不因父 session 尚未加载而误标 orphaned；父记录缺失/已结束才 `orphaned`，交人一次。
- 合并冲突有记录：可解决时写 `Subtask.merge.resolution = merged`；不可解决时只产生一个 `human_action`，不重复记账。
- 子任务事件聚合到父 Ticket，不增加人的注意力计数/未读数；右栏事件过滤只按父 Ticket。
- 父状态投影：未结束子任务存在时为 `working`/`blocked`，绝不因父报告 `waiting` 显示 `idle`。
- `Subtask.state` 映射：`waiting→idle`、`dropped→done+terminal`、`cancelled→done+terminal`，且任何测试/代码不得用 `SubtaskView.status` 计算 attention。
- `attention`/`counts.attention` 对未结束 Ticket 的 person-stage `review/answer/delivery/blocked/failed` 和未结束子任务 `blocked/failed/orphaned` 为 true；已结束 Ticket 一律 false；`waiting` 子任务不进入 attention。
- 最终 review：子任务带 `HumanCriterion` 时，父接受后确认仍在 `TaskReviewView`；批准必须带当前 `reviewRevision`；子任务新报告使旧 revision 失效并返回 `reviewStale`；父子同一 artifact/revision 只出现一行。
- `pendingEnd`：PR 关闭 + 未结束子任务时 Ticket 不 ended、发 `end-gate` 唤醒父；父处置后按 pending 结束；父不可恢复时一次 attention，不永久挂起。
- 建议接受：支持任务中任一已有 `manual` placement 时返回 `409 manualPlacementConflict`，不覆盖、不部分写入。
- 类别继承：review Ticket 的 `inherited` placement 是读时解析，被审 Ticket 移动后自动跟随；不产生需要级联的持久化 placement。
- form 选择：未注入 `inline`、需要 review/workspace/子任务/外部写时，accept 不得选 lightweight；review Ticket 永远 tracked。
- `return_subtask` 后旧 `Subtask.merge` 与 `resolution` 失效；重新接受写新 revision 的合并记录，不能复用旧合并。
- 类别/归属：子任务不进入分类器、不计入类别任务数、不产生类别建议；父类别改变时子任务跟随。

## 10. 迁移与兼容

迁移是**前向**的：类别覆盖层可开关回退；`subtask` 表是 schema 15 的真实迁移，旧二进制不能忽略。回滚需要 down migration、升级前数据库副本或 JSON 导出/导入。

| 场景 | 策略 |
| --- | --- |
| 老数据库 | 类别仍用 KV，`task-catalogue.v1` 不存在时按现有计划树渲染；子任务用 schema 15 **加法建表**，旧库迁移后 `subtask` 为空，旧数据不动 |
| 老工单 | 可批量归纳类别；没有子任务就显示空子任务；未归纳前进“未归类”或按计划查看，不丢 |
| 老 subagent | **不追溯成子任务**：subagent 仍是执行细节；历史 Ticket 不会因为曾经开过子会话就长出 L3 |
| 旧客户端/旧二进制 | 旧客户端可忽略新增 JSON 字段；但旧二进制**打不开** schema 15 数据库（`Store` 拒绝高于 `SCHEMA_VERSION` 的库），不能当回滚方案 |
| 归纳服务不可用 | 全部未归类；任务页仍可用；不阻塞工单 |
| 子任务开关 | `taskView.subtasks` 默认 **on**（第 2 期后）；关闭前要求没有未结束子任务，否则提示先停止/等待，不静默隐藏仍在写文件的子 worker；开关只隐藏功能，不降 schema |
| 回滚 | schema 15 是前向迁移：旧二进制不能打开，必须 down migration、恢复升级前备份或 JSON 导入；`taskView.subtasks` 开关只隐藏子树/停止新委派，不降 schema；`taskView.categories` 可回旧计划树，KV 保留 |
| 开关位置 | Settings › 任务视图 › “类别视图”/“子任务树”，默认都 on；关闭后 `GET tasks` 不返回对应字段，面板回退；不做后台写 |
| 数据导出 | `task-catalogue.v1` 是普通 JSON；`subtask` 可按 ticket 导出 JSON；删除前提示导出，删除类别即恢复自动/未归类 |
| 未来子 Ticket | 若做，`Ticket` 加 `parentTicketId` 与 delegation Eval；`subtask` 表不改成 Ticket，UI 用 `kind` 区分 |
| 计划维度 | 计划编号保留为任务标签与“按计划查看”，不再作为 L1 |

**不做的事**：不迁移历史工单标题、不改 `Mandate.scope`、不把类别写进工单、不在读取时写库、不把历史 subagent 追溯成子任务、不让 worker 直接建 Ticket。

## 11. 风险与待决问题

### 风险

1. **归纳错误**：把无关任务合并会伤害信任。缓解：高阈值、人工优先、未归类、可撤销、显示 reason。
2. **模型成本/延迟**：每 Ticket 一次调用。缓解：异步、去重、批处理、可关闭、失败不阻塞。
3. **隐私**：归纳会读标题/范围/来源摘要。缓解：不读文件与私密全文；沿用现有模型；可关闭。
4. **类别膨胀/频繁改名**：用户认知不稳定。缓解：上限、别名、稳定 id、归档而非删除。
5. **右栏太窄**：列表可读，树/看板不可读。缓解：右栏只做列表/紧凑展开，完整视图进状态页。
6. **交付物只到节点最近报告/聚合粒度**：`TaskReviewView` 能聚合父与已接受子任务的**当前**交付并去重，但没有跨 Assignment 的完整交付时间线；任务视图先显示当前聚合，历史版本需要产品定义。
7. **子任务越权**：让 worker 直接建子任务，容易绕过 Eval/Mandate。缓解：只有 Engine 的 `delegate_task` 能写；继承同一个 Mandate/maxActionLevel；外部动作仍走 Action/Approval；需要独立授权时升级子 Ticket，不能拿 Subtask 绕过。
8. **父审阅越权**：父 worker 接受子交付，不等于人确认验收条件。缓解：6.6 的 `TaskReviewView` 聚合子确认并以 `reviewRevision` 绑定最终批准；父的 `accept_subtask` 只写 `resolution.kind='accepted'`，不写人的批准。
9. **委派失控/成本**：父 worker 递归拆任务，子 worker 数量与模型成本爆炸。缓解：深度 5、单节点 8、单 Ticket 32 个活跃上限；配额与预算；父 stop 级联；UI 显示子任务数。
10. **父 worker 成为瓶颈**：所有子交付都要父审阅，父可能排队。缓解：子任务状态与交付摘要可并行查看；父可批量接受低风险交付；父阻塞时人可停止/接管；指标看父审阅时长。
11. **父子死锁**：父等子完成，子等父回答。缓解：子问题只回父；父必须定期处理子输入；超时/心跳；父不可用时人可取消子树。
12. **合并冲突**：多个子任务改同一文件/同一文档。缓解：代码子任务用独立分支/工作树，父合并；文档用 revision/复制；父解决不了再升级为人问题；不自动覆盖。
13. **孤儿子 worker**：父进程/父 worker 消失，子 worker 继续写。缓解：持久化父子关系；父结束级联停子；重启**先恢复父再判断**孤儿，不能因父 session 未加载误标；孤儿不自动重跑，交人。
14. **注意力碎片化**：每个子 worker 都找人，用户被淹没。缓解：默认子→父、父→人；父汇总成一个 `human_action`；子任务不直接发 IM。
15. **事件与任务口径漂移**：两个视图各自推导会矛盾。缓解：共用 `ownershipIndex` + `TaskCatalogue` 解析链；子任务事件聚合到父 Ticket。
16. **多人/多端**：当前单用户本地；覆盖层 revision 只解决并发写，不解决权限；子任务 worker 的停止/接管也需要权限。多用户需另做权限模型。
17. **“任务”命名过载**：代码里已有 Ticket、Assignment、Session、Subtask；UI 固定“任务节点 = Ticket 或 Subtask”，文档明确“子任务不是 Ticket”。
18. **执行者身份不足**：当前只有通用 worker，没有角色/姓名/指派；父/子 worker 先显示 Session id，不凭空生成“执行 Agent”名字。
19. **“规划中”的任务不可见**：运行时没有结构化 plan；任务视图只展示已受理 Ticket 与执行中的 Subtask；要展示“还没成为 Ticket 的计划”，需要单独 plan 模型，本期不伪造。这是待决问题 14，不是已解决的范围。
20. **子任务 UI 过深**：默认 3 层，L4+ 折叠；超过 5 层拒绝创建；右栏不展示深层；避免树把用户淹没。

### 待决问题（需要产品决策）

| # | 问题 | 建议 |
| --- | --- | --- |
| 1 | L1 是“业务类别/工作线”还是“目标”？一个任务能否属于多个类别？ | 一个主类别 + 可选标签；先不做多归属 |
| 2 | 类别上限 5 还是 7？ | 7 个活跃类别，超过提示合并 |
| 3 | 新工单自动归类还是只给建议？ | 已有类别高置信自动；新类别单任务只建议，累计 2 个任务或批量确认后建类；中置信建议、低置信未归类 |
| 4 | 看板列用状态还是类别？ | 状态列 + 类别泳道；拖拽只改类别 |
| 5 | 图是时间线还是依赖图？ | 先时间线；有依赖数据再画依赖 |
| 6 | 子任务与子 Ticket 的边界？ | 第 2 期先做 Subtask（继承父 Mandate）；需要独立授权时才做子 Ticket，走 delegation Eval |
| 7 | 交付物挂工单还是任务节点？ | 顶层 Ticket 的交付在 `Assignment.report.review`；子任务有自己的 report/review，父审阅后并入最终交付；任务视图只读汇总，不另挂一份 |
| 8 | 类别是否进事件流？ | 先存 history；需要时再扩展 `DomainEvent` |
| 9 | 归纳用哪个模型/是否可关？ | 复用评估模型；设置里可关，关闭即未归类 |
| 10 | 子任务最大深度/宽度？ | 默认 5 层、单节点 8 个、单 Ticket 32 个活跃；可配置，超限报错 |
| 11 | 子任务用独立目录/分支吗？ | 代码类默认独立分支/工作树，父合并；只读/分析类可共享父目录；由 Executor 按任务类型决定 |
| 12 | 子 worker 能否直接找人？ | 默认不能；问题回父 worker，父汇总后最多一个人问题 |
| 13 | 父 worker 能否自动接受子交付？ | 先人工可审计的父审阅；低风险/只读子任务可配置自动接受，但必须有记录 |
| 14 | “规划中”是否包括尚未受理的 pre-Ticket 计划项？ | 本期任务视图只展示已受理 Ticket 与执行中的 Subtask；pre-Ticket 计划保留旧计划树/“按计划查看”，要进新视图需另建 plan 模型，不伪造 Task |
| 15 | 审查 Ticket 是顶层任务还是被审任务的关系行？ | 计入类别任务数；`kind='review'` + `reviewedTicketId`，UI 缩进；被审任务不在当前类别时单独成行 |
| 16 | 人能否停止/重派/重试单个子任务？ | 第 2 期只给父 worker `cancel_subtask`；单子任务人工操作需要新的权限/恢复契约，先不做 |
| 17 | “执行者”是否要角色/姓名/指派？ | 当前只显示 `worker-<id>`/`subtask-<id>`；角色/指派是独立产品模型，不在本期伪造 |
| 18 | 旧计划树与新类别树如何同页共存？ | 第 1 期保留 `milestones` 作为回退/“按计划查看”；默认按类别，不把计划编号当 L1；两套视图共用同一 Ticket 读模型，不双写 |

## 12. 参考与证据

- 现状截图（仓库内）：
  - `docs/images/tasks-board/after-tree.png`：当前“里程碑 → 任务 → 工单 → PR/审查”树。
  - `docs/images/tasks-board/after-graph.png`：当前按里程碑的工单时间线图。
  - `docs/images/session-entry/after-events-groups.png`：右侧栏事件按任务分组。
- 原型（本地，不在仓库）：
  - `prototype/tasks.html`：任务地图、类别筛选、卡片/列表、右侧事件栏。
  - `prototype/task.html`：任务详情、子任务/执行 Agent/会话/产出、任务线程、交付物。
  - `prototype/task-chat.html`：任务对话。
  - `prototype/activity.html`：任务执行流水。
- 相关设计文档（本地）：《任务地图与交付模型设计》《对话与任务融合设计：同一份数据，两种视图》《交互模型设计：长程对话 + 任务视图》。
- 代码入口：`packages/dsh/src/app/tasks.ts`、`ownership.ts`、`activity.ts`、`packages/dsh/src/client/tasks.tsx`、`system.tsx`、`packages/kernel/src/model.ts`、`deliverable.ts`、`packages/dsh/src/executor/dsh.ts`。

## 附录 A：一个跨源任务的走查

1. 陈立在对话里说“准备华兴科技 2025 汇算清缴底稿”；主会话派发 → 对话 Source 产生 Trigger → Eval 接受 → `Ticket` 建立，origin 是对话，worker Session 为 `worker-<ticketId>`。
2. 张敏从邮件/飞书补来“研发费用辅助账已上传”；消息通过订阅/绑定进入同一 `Ticket`，成为 Input 与来源锚点，不新建任务。
3. 归纳服务在受理后运行：现有类别有“客户服务/业务拓展/产品与工具”，工单标题与 scope 指向客户交付 → 归入“客户服务”，confidence 高，记录 reason。
4. 父 worker 判断需要并行拆两份工作，调 `delegate_task` 创建两个子任务：
   - “资料解析”（`sub_1`，worker `subtask-sub_1`），只读解析邮件与附件；
   - “底稿核算”（`sub_2`，worker `subtask-sub_2`），在独立分支上生成底稿。
   任务页显示 类别“客户服务” → Ticket“华兴科技 2025 汇算清缴” → 两个子任务（各自的 worker、状态、交付）。
5. “资料解析”的子 worker 又开一个 subagent 做 OCR；这是子任务内的执行细节，不显示成 L4 任务。子任务完成后把摘要与交付交给父 worker，不直接找人。
6. 父 worker 审查“底稿核算”的交付，发现固定资产清单缺失，`return_subtask` 退回；“底稿核算”子 worker 补充后再次提交，父 `accept_subtask`。父 worker 合并两个子结果，生成 Ticket 的最终交付。
7. Ticket 提交 `ready` 前，Engine 检查两个子任务都已结束；没有未结束子任务，才允许进入人工验收。验收仍走工单/评审面，不在任务页直接改状态。
8. 用户觉得“客户服务”太粗，改为“税务申报”；只改类别名，Ticket、子任务与授权不变；子任务自动跟随父类别，不单独归类。
9. 用户把“某税局投标”从“客户服务”拖到“业务拓展”；看板只改类别，不改任务状态；事件流不产生新事件，任务详情显示“由 陈立 移动，原因：…”。
10. 如果人停止这个 Ticket，两个子 worker 一起停止；如果父 worker 取消“底稿核算”，“资料解析”与父 Ticket 继续，父 worker 决定是否重派。
