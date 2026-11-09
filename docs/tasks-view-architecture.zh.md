# 任务视图架构设计（提案）

> 状态：**设计提案，未实现**。这份文档只回答「任务视图应该长成什么、数据从哪里来、和现有工单/事件/会话/交付物怎么接」，不包含业务代码改动。
>
> 依据：2026-11-08 用户对「状态 › 任务」页面的反馈——右侧栏应像事件视图一样有任务视图；用户要从任务视角看到跨源事件最终规划、合并、执行了哪些任务，关系、执行者、会话、产物是什么；任务可再拆分，默认关心 2–3 级；第一级应是由多个事件归纳、可人工修改的任务类别；形态可以有树、图、看板。
>
> 参考：本地原型 `~/.dsh/bot/workspace/prototype/tasks.html`、`task.html`、`task-chat.html`、`activity.html`，以及同目录的《任务地图与交付模型设计》《对话与任务融合设计》。参考的是信息结构，不照抄视觉。
>
> 修订（2026-11-09）：用户决定把任务树从「独立 `Subtask` 类型」改为 **`Ticket` 自引用**。每个节点都是 `Ticket`；子节点用 `parentTicketId` 指向父节点，每个 tracked 节点有自己的 owner/worker，父 owner 负责审查、再委派或自己执行，并向自己的上级报告。子 Ticket **不创建新 Mandate**，不是授权主体；它继承根 Ticket 的授权与 `maxActionLevel`，对外动作仍经根 Ticket 的 `Approval` 与 outbox。子节点受限执行：不能创建授权根 Ticket、不能直接找人、不能提级、不能外发。本文档的 §3.4、§4.3、§4.6、§6、§7、§9、§10 随之改写，并替代 PR #26 中「`Subtask` 是独立持久化类型」的部分；实现（T3-10 Phase 2a 代码）另开工单。本修订同时吸收 2026-11-09 的人类补充要求：子工单完成后先向父工单 owner 报告，父 owner 判断后再向自己的上级报告，根节点向人给出结论；每次「报告—判断—再委派/自干—上报」都留痕（trace/disposition/approval），并定义父 owner 缺位或已结束时的处理。

## 0. 结论摘要

| # | 结论 | 影响 |
| --- | --- | --- |
| 1 | **节点统一为 `Ticket`，不再新增 `Subtask` 类型**。根 Ticket 由 Eval 创建；子 Ticket 由父 owner 请求 Engine 的 `delegate_ticket` 创建，`parentTicketId` 指向父节点。子 Ticket 仍是 Ticket，但没有自己的 Mandate/Decision，不能独立存在。 | 不复制授权、不产生第二个类型/第二套结束条件；任务树、详情、事件、交付共用 Ticket 读模型。 |
| 2 | **只新增一个可持久化的覆盖层：任务类别（`TaskCategory`）及任务归属（`TaskPlacement`）**。类别是展示与组织元数据，不授予任何权限。 | 人工改名/合并/拆分只改覆盖层，不改 `Ticket`。 |
| 3 | 第一级类别由 **Agent 在根 Ticket 受理后异步归纳**，人工修改优先；低置信度进入“未归类”，永不隐藏工作。 | 需要一个小模型调用队列与置信度阈值；可关闭并回退。 |
| 4 | 层级为 **类别 → 根 Ticket → 子 Ticket → 更深子 Ticket**；每个 **tracked** Ticket 节点都有自己的 owner 与 worker（`worker-<ticketId>`），lightweight Ticket 是叶子、没有 owner/worker/子节点。全页树默认展开 3 层（类别 + 根 Ticket + 一级子 Ticket），更深折叠；右栏默认是列表，不默认树。 | 符合“最多关心 2–3 级”；执行单元（Assignment/Session）不是任务层级，放在节点详情；lightweight 与 tracked 的边界见 3.5。 |
| 5 | **右侧栏新增“任务”tab**，与“事件”并列；两者共享选中态，可互相定位。状态页保留完整任务页。 | 同一份 `GET tasks` 投影，两处不会给出不同归属。 |
| 6 | 视图：右栏只做列表/紧凑树；完整页做列表、树、看板、时间线图。图不伪造依赖关系。 | 窄栏不塞看板与图，避免信息不可读。 |
| 7 | **子 Ticket 复用 `ticket` 表，只加 JSON 字段 `parentTicketId`/`rootTicketId`/`delegation` 与两个生成列/索引（schema 15，加法）**；不建 `subtask` 表。旧 Ticket 没有 `parentTicketId`，读作根 Ticket。 | 老数据照常读；schema 15 是前向迁移，旧二进制**必须**被拒绝，否则会把子 Ticket 误当授权根；回滚需 down migration/备份。 |
| 8 | **授权根唯一**：只有根 Ticket 有 `Mandate`/`Decision`，是 Approval/outbox 的 `ticketId`；子 Ticket 只带 `rootTicketId`，没有 Mandate/Decision，不是授权主体。子节点不能创建授权根 Ticket、不能直接找人、不能提高动作级别、不能外发；对外动作仍由根 Ticket 的 `Approval` 与 outbox 执行。 | 授权不变量不变；子 Ticket 的“完成”只是父 owner 接受工作交付，不等于人的验收。 |
| 9 | **父 owner 审查链**：子 Ticket 完成后向父工单 owner 报告；父 owner 判断，未完成则 `return_child`（重开 attempt）或自己执行/再委派，完成则 `accept_child` 并向自己的上级报告；根 owner 向人给出最终结论。每次报告、判断、再委派/自干、上报都写 trace/disposition；对外动作只走根 Approval/outbox。父 owner 缺位/已结束时，报告不得丢失：先恢复父，再升级到最近的在世祖先 owner/人一次，不静默重跑或完成。 | 组织分工清晰；父接受不等于人确认；每个节点仍可解释；注意力只在根/最近可用上级聚合。 |
| 10 | 分五期落地：右栏只读任务视图 → **子 Ticket 树 + 每节点 owner/worker + 父 owner 审查与结束门** → 类别归纳（只读）→ 人工编辑/看板/交付详情 → 硬化；lightweight 的运行时前置单列 Phase 0。 | 子 Ticket 是核心执行能力，单独一期；类别与视图随后；lightweight 不做 owner/子 Ticket，且在 Phase 0 接通前不作为 Phase 1 验收。 |

## 1. 现状

### 1.1 已经有什么

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 授权工作单元 | `Ticket`：来源 Trigger、Mandate、Channels、Subscriptions、Inputs、Assignments、Execution、结束状态 | `packages/kernel/src/model.ts` |
| 执行者与会话 | 每个 tracked 工单一个 worker Session：`worker-<ticketId>`；同一工单的多次 Assignment 共享它；worker 可再开 subagent Session。lightweight 没有 Assignment/worker Session/workspace，走 inline executor；当前 inline 只是 kernel 契约，生产未注入 | `packages/dsh/src/executor/dsh.ts`、`packages/dsh/src/app/sessions.ts`、#29 |
| 任务拆分 | 当前只有 subagent Session（临时执行细节），**没有持久化子 Ticket、没有子节点自己的 owner/worker**；父 owner 不能动态建子 Ticket，也不能审子交付/合并/解冲突。目标模型见 §3.4、§4.3、§4.6 | `packages/dsh/src/executor/dsh.ts`、`packages/dsh/src/app/sessions.ts` |
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
10. **只有两层容器，且没有父子任务关系**：父 owner 不能动态创建“有自己 owner/worker 的子 Ticket”，也不能审查子交付、合并结果、解决冲突；现有 subagent 只是执行细节，不能承担子 Ticket 的目标与交付。

### 1.3 现状与目标的差距

| 维度 | 现状 | 目标 | 差距性质 |
| --- | --- | --- | --- |
| 第一级 | 计划里程碑 `M*` | 由多个事件归纳、用户可改的任务类别 | 新覆盖层 + 归纳服务 |
| 第二级 | 计划任务 `T*` / 工单 | 任务（工单） | 重新定义展示层，不改聚合 |
| 第三级 | 审查、PR 叶子 | 子 Ticket（`parentTicketId` 自引用，自己的 owner/worker）与交付物；执行单元放到节点详情 | Ticket 自引用 + 父 owner 审查链；不新增 `Subtask` 类型 |
| 归属 | 标题/范围正则 | 人工优先、归纳次之、未归类兜底 | 新归属解析链 |
| 编辑 | 无 | 类别改名/合并/拆分/移动/恢复自动 | 新写接口 + 审计 |
| 表面 | 状态页任务 tab | 右栏任务 tab + 状态页完整页 | 新右栏 tab + 共享投影 |
| 视图 | 树、时间线图 | 列表、树、看板、时间线图 | 新看板；图重新定位 |
| 信息 | 状态/进度/耗时 | 加来源、执行者、会话、交付物、最近事件 | 投影扩展 |
| 执行者 | tracked：通用 worker Session；lightweight：inline，无 worker（kernel 契约，生产未接通） | 每个 tracked Ticket 节点有自己的 owner/worker；lightweight 明示无 owner/worker/审批 | 默认展示 owner 角色（根 owner / 子 Ticket owner / “轻量”），不显示 `worker-` 或 Session id；内部 id 只在折叠的技术详情（E2）出现 |
| 拆分 | 只有 subagent 会话 | 父 owner 动态委派子 Ticket、审交付、合并、解冲突，并向上报告 | 新 `delegate_ticket` 工具 + `Ticket.parentTicketId` + 父 owner 审查链 |
| 规划 | 只有工单标题/范围里的计划编号；worker 的执行计划不落库 | 已受理任务与执行单元可见；未受理的计划不伪造 | 结构化 plan 是另一个模型，不在本设计里硬造 |
| 身份 | 标题里的计划编号 | 稳定类别 id + 工单 id | 新 id 与别名 |
| 兼容 | 计划树 | 计划树保留为回退/计划维度 | 双读、开关 |

## 2. 设计原则

1. **授权根唯一，子 Ticket 不是授权主体**。任务视图是读模型加展示元数据；类别、归属、改名都不改变 `Ticket`、`Mandate`、`Assignment`。只有 Eval 创建授权根 Ticket；只有 Engine 的 delegation 创建子 Ticket。子 Ticket 没有自己的 Mandate/Decision，只记录 `rootTicketId`；所有动作闸门、Approval 与 outbox 都解析到根 Ticket。子节点不能创建授权根 Ticket、不能直接找人、不能提高动作级别、不能外发。需要独立授权的工作仍必须成为新的根 Ticket（走 Eval），不能拿子 Ticket 绕过。
2. **节点即 Ticket**。任务树里的每个节点都是 `ticket` 表里的一行 `Ticket`；父子关系只是 `parentTicketId` 自引用，不是第二个实体、第二套状态机。不要把 subagent Session、Assignment 或旧 `Subtask` 记录画成任务节点。
3. **一份数据，多个看法**。列表、树、看板、图、右栏、状态页都读同一个 `GET tasks` 投影；不允许某个视图自己推导一套归属或父子关系。
4. **未归类必须可见**。归纳失败、置信度低、用户没改的根 Ticket 进入“未归类”，不隐藏、不丢弃、不静默合并。
5. **人工修改优先且可撤销**。人的改名/合并/拆分是覆盖层；Agent 只能建议，不能覆盖人工决定；任何覆盖都能“恢复自动归纳”。
6. **树默认三层，右栏默认列表**。全页树视图默认展开类别 + 根 Ticket + 一级子 Ticket；更深子 Ticket 与执行细节按需展开，避免树把默认视图撑爆。右栏仍是列表，点开 Ticket 才显示一级子 Ticket，不默认画树（§7.2–§7.3）。
7. **来源是锚点，不是层级**。任务不按 GitHub/飞书/对话分组；来源作为根 Ticket 上的 chip 与锚点列表，避免“多源任务”被拆成多条。子 Ticket 继承根 Ticket 的来源锚点，不单独建来源。
8. **不伪造结构**。没有依赖数据就不画依赖边；没有交付物就不显示空的“交付”区块；没有子 Ticket 就不编造子节点；subagent 不冒充子 Ticket。
9. **父 owner 审查与上报**。每个 tracked Ticket 节点有 owner；子 Ticket 的 owner 向父 Ticket 的 owner 报告，父 owner 判断后选择退回/再委派/自己执行/向上报告。根 owner 向人给出结论。父 owner 的接受只表示工作交付被接受，不代替人的 `Review.confirmations`；父 owner 不决定根 Ticket 的最终验收。
10. **先只读，再可编辑**。先把任务视角跑通并验证归纳质量，再开放写操作；写操作前先把冲突与审计做好。

## 3. 概念模型

### 3.1 概念

| 概念 | 定义 | 是否新实体 | 谁写 |
| --- | --- | --- | --- |
| 事件 Event | 任一来源的一次输入：对话消息、IM、邮件、GitHub Issue/PR/CI、网页变化等；落地为 `Trigger` 与活动记录 | 否 | Source / Engine |
| 根 Ticket RootTicket | 一次被授权的工作：有来源 Trigger、Mandate、Decision、执行、结束条件；没有 `parentTicketId`。form 为 tracked（有 Assignment/worker）或 lightweight（inline，无 Assignment/worker/workspace） | 否 | Eval / Engine |
| 子 Ticket ChildTicket | 同一 `ticket` 表里的 Ticket，`parentTicketId` 指向父 Ticket、`rootTicketId` 指向授权根；有自己的 owner/worker、Assignment、报告、交付与结束条件，但**没有自己的 Mandate/Decision**，不是授权主体 | 否（Ticket 自引用） | Engine 的 delegation |
| 任务 Task | 用户视角的一个任务节点；就是根 Ticket 或子 Ticket，不是独立存储 | 否（投影） | 读模型 |
| owner | 对一个 Ticket 节点负责的 worker；tracked 节点的 owner 是 `worker-<ticketId>`，lightweight 没有 owner | 否（派生） | Executor / Runtime |
| worker | 执行该节点 Assignment 的 Session；当前 owner 与 worker 是同一 Session，字段分开是为了以后可以出现“负责人 ≠ 执行者”的角色模型 | 否（投影） | Executor |
| 任务类别 TaskCategory | 第一级“工作线/大类”：由多个根 Ticket 归纳，可人工改名/合并/拆分 | **是** | `TaskCatalogue` |
| 任务归属 TaskPlacement | 一个根 Ticket 属于哪个类别，以及来源是“归纳”“人工”还是“继承审查对象” | **是** | `TaskCatalogue` |
| 执行单元 ExecutionUnit | 一个任务节点内的一次执行：Assignment、worker Session、subagent Session；不是任务层级 | 否（投影） | Executor |
| 交付物 Deliverable | 一个 tracked Ticket 节点产出的一次交付：artifact + preview + 验收条件；lightweight 只有 inline summary/action ledger，不是 Deliverable | 已有契约，已接入 `Assignment.report.review` 与工单页；任务视图只读汇总 |

### 3.2 关系

```text
事件流（多源）
  │  受理 / 合并
  ▼
根 Ticket（L2，授权聚合；有 Mandate/Decision；tracked 一个 owner/worker，lightweight 无 owner/worker）
  │  origin / channels / inputs / follows
  │
  ├─ 子 Ticket（L3，`parentTicketId`；自己的 owner/worker；无 Mandate/Decision，继承根授权）
  │    ├─ 子 Ticket（L4，折叠，自己的 owner/worker）
  │    └─ 执行单元 / 交付物（节点详情）
  │
  ├─ 执行单元 / 交付物（tracked 根 Ticket 的 worker；lightweight 走 inline）
  ├─ 来源锚点：Thread / Channel（GitHub PR、飞书群、对话线程…）
  └─ 归属 → 任务类别 TaskCategory（L1，可编辑）
```

一条任务可以来自多个事件、多个来源；事件不是任务的父级，而是任务的“来路”。多个事件先合并到同一根 Ticket（受理批次、订阅、输入、绑定 Channel），根 Ticket 再被归纳到一个类别。子 Ticket 由父 owner 在执行中请求 Engine 创建，不是来源事件，也不继承新的来源锚点。

### 3.3 为什么不再造一个顶层 `Task` 聚合

`Ticket` 已经承载了顶层任务需要的一切：来源、授权、执行、输入、订阅、结束条件。再建一个顶层 `Task` 会带来：

- 两套状态与结束条件，面板与执行器必然对不上；
- 授权分叉：`Task` 没有 Mandate，执行时又要回填 Ticket；
- 迁移成本：所有历史工单需要重建关联；
- 与现有“事件按任务分组”的读模型冲突。

因此“任务”是 `Ticket` 的**用户面命名**，不是第二个顶层授权表。子 Ticket 也不是第二个顶层聚合：它不能独立于根 Ticket 存在，不能有自己的 Mandate/Decision，不能成为 Approval/outbox 的主体。

### 3.4 为什么子节点也是 Ticket（而不是独立 `Subtask` 类型）

旧稿把子节点建成独立的 `Subtask` 持久化类型。它带来三个问题：

1. **同一棵树两套模型**：`Ticket` 与 `Subtask` 各有一套状态、结束、报告、交付读法；任务视图、事件、Session、交付聚合都要写两次，且容易漂移。
2. **子节点像“第二授权层”**：`Subtask` 不是 Ticket，却有自己的 worker、报告和接受记录；很难向读者和代码解释“它为什么不是第二授权主体”。
3. **执行细节泄漏成领域概念**：为了区分 `worker-<ticketId>` 与 `subtask-<id>-<attempt>`，需要额外的 Session 注册表、`ticketOfSession` 分支和事件解析；这些复杂度来自类型分裂，不是任务本身。

本修订改为：**子节点就是 Ticket，用 `parentTicketId` 自引用**。这并不重新打开“第二顶层 Task”的问题，因为授权边界由以下不变量固定：

- 只有 **Eval** 创建**根 Ticket**；只有 **Engine 的 delegation** 创建**子 Ticket**。worker 不能直接写表、不能触发 Eval、不能创建授权根 Ticket。
- 子 Ticket **没有自己的 `Mandate`/`Decision`**；它只存 `rootTicketId`。所有动作闸门、`Approval`、outbox 都以根 Ticket 为准；子 Ticket 的 `maxActionLevel` 就是根 Mandate 的 `maxActionLevel`，不能抬高。
- 子 Ticket **不能独立存在**：根 Ticket 结束/被停止时，子 Ticket 级联停止；根 Ticket/父 Ticket 记录缺失时，子 Ticket 进入 `orphaned`，交人决定，不静默续跑。
- 子 Ticket **不能成为分类、通知、审批的主体**：类别只归根 Ticket；对外通知/审批只记根 Ticket；子 Ticket 的报告只回到父 owner。
- 子 Ticket 的 owner **不能创建授权根 Ticket**；它只能通过 `delegate_ticket` 请求 Engine 创建**同一 `rootTicketId` 下的下级子 Ticket**。所以“不能建 Ticket”指的是不能创建授权根或独立 Ticket，不是禁止更深的委派；否则深度 5 与“继续委派”都不成立。

结论：**授权树只有根 Ticket；执行树是 Ticket 自引用**。UI 上所有节点都显示为任务节点，但只有根 Ticket 有授权、Approval 与最终人工验收。

### 3.5 轻量 Ticket 与 tracked 任务树（#29 合入后）

#29 已把 Ticket 明确分成两种 form：`TicketForm = 'tracked' | 'lightweight'`，`ticket.form` 缺省为 tracked；`ticketForm()` 读取。二者都是 Ticket，都有 Mandate、来源、Inputs、结束状态，但执行方式不同：

| 维度 | tracked Ticket | lightweight Ticket（#29） |
| --- | --- | --- |
| 执行 | 有 Assignment、`worker-<ticketId>`、workspace | 无 Assignment、无 worker Session、无 workspace；`InlineExecutor` 内联执行 |
| 动作级别 | 可 read/draft，也可在授权内 commit/send/spend | 只允许 read/draft；`commit`/`send`/`spend` 被 kernel 拒绝 |
| 状态/重试 | Assignment 报告、`requestStatus`、`retry` | 无 Assignment；不适用 worker report/retry；`completed` 或 `dropped` 结束 |
| 恢复 | Assignment 可恢复 | 当前没有重启恢复路径 |
| 审计 | 活动/交付/PR | 每步 Action span + 最后 Report span；按 run token 关联 |
| 交付/验收 | `Assignment.report.review` + `Review.confirmations` | **没有 `Assignment.report.review`**；只有 inline action ledger 与 summary，没有人工确认门 |
| 子 Ticket | 可作为父节点，owner 可 `delegate_ticket` | **不能委派**：没有 owner/worker，也没有可审查子交付的 worker |
| 授权主体 | 根 Ticket 是授权主体；tracked 子 Ticket 不是 | 根 Ticket 是授权主体；lightweight 不能做子 Ticket |

**结论：lightweight 是任务树里的叶子，不是另一种顶层任务，也不是子 Ticket。** 任务树节点仍是 `Ticket`；UI 用 `form` badge 区分。轻量任务可以出现在任一 L1 类别下，但没有 L3 子节点，也没有“自己的 owner/worker”。

**落地状态（2026-11-09 更新）**：#29 合入 **kernel 契约**（`TicketForm`、`ticketForm()`、`InlineExecutor` 端口与测试）；T3-05 Phase 0 已把生产 `InlineWork` 注入 `assembly.ts`，Eval、`orchestrator_route` 与 `orchestrator_dispatch` 可写 `form: lightweight`，`executor.lightweight` 可回退 tracked。能力边界仍是**一次只读仓库查文件**（最多 4 个路径，不 commit/send/spend）；改单元格、发草稿等仍需 tracked。任务视图的 lightweight 叶子按这个边界验收，而不是按“任意小活都能 inline”验收。

因此 Phase 1 的验收只覆盖 tracked；lightweight 行/详情只有在 Phase 0 接通运行时后才算验收项。见 3.5.5 与 9 的 Phase 0。

#### 3.5.1 哪些节点 lightweight，哪些必须 tracked

| 适合 lightweight | 必须 tracked |
| --- | --- |
| 一次 read/draft、即时返回、无需落盘 workspace | 需要 workspace、文件/分支/PR、跨轮多步执行 |
| 不产生需要人验收的交付物 | 有 artifact/revision/preview，需要 `Review`/人工确认 |
| 不需要 commit/send/spend | 需要 commit/send/spend 或外部写 |
| 不需要重试、状态查询、失败恢复 | 可能阻塞、需要重试/恢复/人工接管 |
| 不需要子 Ticket、不需要父 owner 审查 | 需要子 Ticket、父 owner 审阅、合并/冲突解决 |
| 结果可以用 summary + action ledger 说明 | 需要交付物审查、批准历史、可审计的合并 |

判断规则：**不确定就 tracked**。轻量化的收益是低延迟、低成本；代价是没有 workspace、没有 review、没有重试/恢复、不能拆子树。凡是“要给人审”“要落盘”“要外部写”“要拆”的工作，都不应塞进 lightweight。

**form 选择是受理约束，不只是文案建议**：`prepareTicket`/accept 只有在以下全部成立时才可把 Ticket 标为 lightweight：部署已注入生产 `InlineExecutor`；Eval/assessor 明确写了 `form='lightweight'`；任务没有 Review/`HumanCriterion`、没有 artifact/preview、没有 workspace/外部写、没有子 Ticket、没有 PR/follows、没有重试/恢复要求。任一不成立，`prepareTicket` 必须回退 tracked，或拒绝 accept（`UserError('lightweightUnsupported')`）。**审查 Ticket 永远 tracked**；review 需要人的确认门，不能落进 lightweight。该约束要由 accept/prepareTicket 层执行，不能只写在文档表格里。**子 Ticket 永远 tracked**：它需要自己的 owner/worker 与父审阅。

#### 3.5.2 层级、交付物与 review 的取舍

- **层级**：类别 → 根 Ticket（tracked 或 lightweight）→（仅 tracked）子 Ticket → 更深子 Ticket。lightweight 没有子节点；子 Ticket 永远是 tracked（有独立 owner/worker）。**不要造“lightweight 子 Ticket”**：没有 owner/worker 就没有父审阅责任人，父子契约不成立。
- **父节点**：只有 tracked Ticket 能成为父节点；lightweight 不能调 `delegate_ticket`。如果 tracked 父任务里有一小块独立工作，父 owner 自己做、开 subagent 执行步骤，或建 tracked 子 Ticket；不要用 lightweight Ticket 冒充子 Ticket。
- **交付物**：tracked 节点的交付走 `Assignment.report.review`；lightweight 只有 summary/action ledger，**不产生 `DeliverableSummary`、不产生 `Review`、不进入人工确认队列**。任务视图对 lightweight 显示“轻量执行，无交付审批”，不要显示空的“待验收”卡片。
- **review/attention**：lightweight 不出现 `review`/`answer`/`delivery` 等 person stage，也不应有“待人确认”的 attention；它可以在执行中显示 `working`，完成后 `done`；`dropped` 用 `done` + `terminal='dropped'`，显示“已放弃”，不能映射成 live 的 `idle`。如果业务需要人看结果，选 tracked，而不是给 lightweight 硬加一个 review 阶段。
- **类别**：类别覆盖层只按**根 Ticket** 归类，tracked 与 lightweight 根都算；lightweight 也进入 L1 归纳/人工归类，但 classifier 的输入是标题、Mandate、来源与 inline summary（没有 worker 报告）。子 Ticket 继承根类别，不单独分类、不计入类别任务数。
- **父完成门**：只对 tracked 父 Ticket 生效；lightweight 没有子 Ticket，不参与 `delegate_ticket`、`accept_child`、`Delegation.resolution`。

#### 3.5.3 冲突、迁移与兼容

与评论的“每个任务节点有自己的 worker”存在字面冲突：**#29 明确 lightweight 没有 worker**。本稿的取舍是：

- “每个任务节点”在任务树里解释为 **每个 tracked Ticket 节点**；lightweight 是 Ticket 的叶子形态，用 `form` badge 明示“无 owner/worker/审批”。不把 lightweight 画成有 worker，也不为它伪造 Assignment。
- 如果产品坚持“所有节点都必须有 worker”，那 lightweight 就不能作为任务树节点；但 #29 目前只是 kernel 契约、生产未接通，不能拿“运行时事实”做论据。建议先保留 form 差异并在 UI 明确边界；等 Phase 0 接通后，再按真实使用数据决定是否保留 lightweight 作为任务树叶子。
- 如果父任务需要审查一小块工作，**不要**把 lightweight 任务挂到父下；用 tracked 子 Ticket。父审阅/合并/`resolution` 只对 tracked 子树成立。

**迁移建议**：

1. **存量兼容**：`form` 缺省 tracked，旧 Ticket 不改；lightweight 没有 Assignment/workspace，任务视图必须容忍 `assignments = 0`、`sessionId` 缺失、`deliverables` 为空。
2. **lightweight → tracked（升级）**：不在原 Ticket 上直接改 `form`。当前没有“结束时把未消费 follow-up 交回 Eval”的 handback：`Tickets.end`/`letGo` 之后 `evaluateDue` 走 `tickets.wake`，同一 Thread 的 follow-up 仍 inline 续跑。因此**唯一可靠路径是新的 Thread/对话**（不属于旧 lightweight Ticket 的订阅/来源），由这条新请求经 Eval 选择 **tracked Ticket**。让旧 inline run 自然结束（`dropped` 或已完成），新 tracked Ticket 不合并旧节点；保留旧 action ledger、Mandate 与审计，不伪造 Assignment 历史。本文不引入未建模的 `supersedes`/`relatedTicketId` 字段；如果产品需要“升级来源”标注，应另立一个显式的 Ticket 关系字段并单独迁移，不能只在文档里提。
3. **tracked → lightweight（降级）**：不做。会丢失 Assignment、owner/worker、workspace、review 与恢复能力；需要轻量时新建 lightweight Ticket。
4. **自动转换**：第 1/2 期不做“运行中自动升级”。升级需要新的授权/Assignment 语义，先由人/父 owner 明确发起 follow-up；不要用改 `form` 字段绕过 Eval。
5. **历史**：不要把历史 subagent、inline action、旧 `Subtask` 运行追溯成子 Ticket；它们是执行细节或旧提案，不是任务层级。若旧数据库曾有实验性 `subtask` 表，schema 15 迁移不读取它，导出后另行处置。

#### 3.5.4 对视图与数据模型的影响

- `TaskView` 增加 `form: 'tracked' | 'lightweight'`、`parentTicketId?`、`rootTicketId`、`depth`、`owner`/`worker`；子 Ticket 的 `TaskView` 复用同一形状（递归 `children`），不增加第二种 View 类型。
- `TaskView.execution` **保持必填**（沿用现有契约）；lightweight 返回 `{ assignments: 0, subagents: 0 }`，`sessionId`/`name` 缺省。这样 UI 不会因字段缺失而崩，也不需要第二个 execution 形状；详情显示 inline 的 step/action 摘要，而不是 worker Session。
- `TaskView.deliverables` 对 lightweight 为空；新增可选的 `inline?: { steps: number; lastActionAt?: string; summary?: string; traceId?: string }`，只做摘要，不冒充 `DeliverableSummary`。
- 行 UI：lightweight 显示“轻量”badge，无展开箭头、无“查看 owner/worker”、无“待验收”；详情页显示 action ledger 与 summary，并提示“需要保留/审批/外部写时，请发起 tracked 任务”。
- 状态：lightweight 不套 tracked 的 `ticketStage` 等待逻辑；只按 inline run 的进行/结束投影为 `queued`/`working`/`done`。`dropped` 也用 `status=done` + `terminal='dropped'` 表达，绝不使用 live 的 `idle`；不进入 `review`/`answer`/`delivery`/`blocked` 的 attention 集合。
- 测试：lightweight 无 Assignment/Session/workspace；任务视图不显示 owner/worker/交付/子 Ticket；不触发父完成门；tracked 父下不出现 lightweight 子节点；升级后出现两个节点、旧 lightweight 不被改写；类别计数两者都算。

#### 3.5.5 分期影响

- 第 1 期：只读视图只验收 tracked；lightweight 行/详情作为前向兼容形状，只有在 Phase 0 接通生产 `InlineExecutor` + Eval form selection 后才验收。若尚未接通，`TaskView.form` 字段仍可存在，但产品不会产生 lightweight Ticket；测试用 kernel fixture，不写“受理后”验收。
- 第 2 期：子 Ticket 只允许 tracked 父；`delegate_ticket` 只对 tracked owner 开放；lightweight 没有父完成门。
- 第 3 期：类别分类覆盖两种 form 的根 Ticket；lightweight 的输入少，允许人工纠正；不要用 inline action 当类别证据；子 Ticket 只继承类别、不单独分类。
- 第 4 期：交付/审批/看板只对 tracked 展示；lightweight 的看板卡片只显示状态和 brief，不显示“待验收”。
- 第 5 期：补 lightweight 重启恢复/升级路径（如产品需要），否则明确“lightweight 不做恢复”。

## 4. 层级与归属

### 4.1 任务树层级

| 层 | 内容 | 默认 | 展开 |
| --- | --- | --- | --- |
| L1 类别 | Agent 归纳的工作线/大类，人工可改；只包含根 Ticket | 显示 | 始终显示（含“未归类”） |
| L2 根 Ticket | `Ticket`；有 Mandate/Decision、来源、执行、结束条件；tracked 有自己的 owner/worker，lightweight 只有来源、inline 执行、结束状态，是叶子 | 显示 | 始终显示；lightweight 无子节点 |
| L3 子 Ticket | `Ticket`（`parentTicketId` 指向根/父）；父 owner 委派，自己的 owner/worker、目标、报告、交付；无自己的 Mandate/Decision | 显示 | 默认展开一级 |
| L4+ 更深子 Ticket | 子 Ticket 再委派；受深度与数量上限约束 | 折叠 | 点“展开更多”或节点详情 |

执行单元（Assignment、Session、subagent）与交付物**不是任务层级**，放在节点详情；这样“默认 2–3 级”是任务层级，不会被执行细节撑爆。

规则：

- 每个 **tracked Ticket 节点**最多一个自己的 owner/worker；worker Session 是 `worker-<ticketId>`，根和子 Ticket 用同一个命名规则，**不再引入 `subtask-<id>-<attempt>` 前缀**。owner 与 worker 当前是同一个 Session；`TaskView` 仍分开呈现，便于以后出现“负责人 ≠ 执行者”。子 Ticket 的 owner 对父 Ticket 的 owner 负责，见 4.6。
- lightweight Ticket 没有 owner/worker（3.5）；子 Ticket **永远是 tracked**，不能是 lightweight。不要把子 Session（subagent）当 worker，也不要把旧 `Subtask` 记录当节点。
- 子 Ticket **没有自己的 `Mandate`/`Decision`**，只存 `rootTicketId`；任务视图、详情、授权检查都必须把它解析到根 Ticket。任何代码不得用子 Ticket 自己的 `mandate` 做动作闸门或审批。
- 子 Ticket 只能由父 owner 通过 `delegate_ticket` 请求 Engine 创建；Engine 校验父/根 Ticket 存活、父 owner 在运行、同一 `rootTicketId`、根 `maxActionLevel` 原样继承、深度/宽度/配额未超限。worker 不能直接写表、不能触发 Eval、不能创建授权根 Ticket。子 Ticket 的 owner 可以请求更深子 Ticket，但仍受同一 root 与上限约束。
- **`parentTicketId` 创建后不可改**；不支持把节点移到另一个父、把子 Ticket 提升为根。需要另一条授权线时，由人/来源经 Eval 新建根 Ticket，不能改父字段绕过。
- 子 Ticket 默认继承根 Ticket 的类别，**不单独跑分类器、不计入类别任务数**；类别是根 Ticket 的组织方式。
- 最大深度默认 5（根下最多 5 层子 Ticket），单节点最多 8 个直接子 Ticket、单根同时活跃子 Ticket 最多 32；可配置，超限返回明确错误。Engine 还要拒绝自引用、祖先环与重复父链。
- UI 的**树视图**默认展开 L1–L3；L4 折叠并显示“还有 N 层/N 个”，用户最多关心 2–3 级。**列表与右栏**默认只显示类别 + 根 Ticket，点开 Ticket 才显示一级子 Ticket；两者共用同一投影，不因默认形态不同而算出不同归属（§7.2–§7.3）。

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

### 4.3 拆分规则：执行步骤、子 Ticket、根 Ticket

拆分分三种，边界不能混：

| 拆分类型 | 谁创建 | 有自己 owner/worker | 授权 | UI |
| --- | --- | --- | --- | --- |
| 执行内步骤 | 节点 owner 直接开 subagent Session | 子 Session，不是独立 worker | 继承该节点 | 节点详情，不是任务层级 |
| 子 Ticket | 父 owner 调 `delegate_ticket`，**Engine 写入** | **是**，`worker-<childTicketId>` | **继承根 Ticket 的 Mandate 与 maxActionLevel；没有自己的 Mandate/Decision**；`goal`/`scope` 只是执行提示，不能扩权 | L3+ 任务节点 |
| 根 Ticket | Eval（新的来源/授权线） | 是 | 独立 Mandate、Decision、来源、结束条件 | 顶层任务，不是子节点 |

规则：

- **父 owner 可以动态创建子 Ticket，但只能在 Engine 的 delegation 操作里创建**。owner 调 `delegate_ticket(goal, scope?)`；Engine 校验父 Ticket 存活、父 owner 在运行、同一 `rootTicketId`、根 Mandate/`maxActionLevel` 原样继承、深度/宽度/配额未超限，然后创建子 Ticket 与子 worker。worker 不能直接写表、不能直接创建授权根 Ticket、不能触发 Eval。`Mandate.scope` 是自由文本，运行时不计算“文本子集”；不要把它当授权边界。
- **子 Ticket 继承授权，不继承“结束父任务”的权力**。子 owner 只对子目标负责；父 owner 对最终目标、交付审查、合并与冲突解决负责。子 owner 不能把父/根 Ticket 标为完成，也不能修改自己的 `parentTicketId`/`rootTicketId`/`maxActionLevel`。
- **子 Ticket 的问题先回父 owner**。子 owner 的 `blocked`/`failed`/`ready` 报告给父 owner；父 owner 决定自己答、退回子 Ticket、换一个子 Ticket、自己接管，或汇总成一个 `human_action` 问人。默认不让每个子 owner 直接打扰用户。
- **父 owner 的审查与上报**：子完成后必须向父工单 owner 报告；父 owner 判断“未完成”则 `return_child`（重开 attempt，旧 attempt 作废）或自己执行/再委派；“完成”则 `accept_child`，然后向自己的上级（父的父；根节点则向人给出结论）报告。具体动作、留痕与缺位处理见 4.6。
- **父 owner 的结束门**：`ready`/`dropped`/人停止/PR 合并都经过 `Tickets.end`；父 Ticket 在结束前必须没有未结束子 Ticket。未结束（无当前有效 `Delegation.resolution`）= 子 Ticket 仍 live 且处于 queued/working/waiting/review/blocked/failed/orphaned；`failed`/`orphaned` 必须有当前有效的 `resolution`（接受/取消/失败；退回是重开，不是终态处置）才放行；子 Ticket 失败不自动结束父任务，父 owner 决定重试、拆新子 Ticket 或报失败。详见 4.6。
- **停止级联**：人停止根 Ticket → 所有子 Ticket 停止；父 owner 停止一个子 Ticket 只停该子树，不影响父任务和其他分支。父/根 Ticket 结束或失败后，子 worker 不能继续写。
- **合并与冲突**：子 Ticket 默认把交付物交给父 owner，不直接交给最终用户；父 owner 审查、接受或退回，合并子结果（代码合并分支/文档合并修订）。父 owner 解决不了冲突时，才升级为一个人问题。**父的接受只代表工作交付被接受，不代替 `Review.confirmations` 的人确认**；子 Ticket 里需要人确认的验收条件通过 6.6 的 `TaskReviewView` 聚合进根 Ticket review，仍由人按 `reviewRevision` 确认；不能靠父 owner 在最终报告里重写一遍。
- **执行步骤不是子 Ticket**：subagent 仍是节点详情里的执行单元；不要为了“看起来像树”把 subagent 伪装成子 Ticket。
- **更深的子 Ticket** 受最大深度 5、单节点 8 个直接子 Ticket、单根 32 个活跃子 Ticket 约束；超限返回明确错误，不静默截断。
- **子 owner 的工具与目录**：只注册执行工具；不注册创建根 Ticket/Eval、`send_message`、向人提问、orchestrator 类工具，也不注册 commit/send/spend/merge/审批请求工具；子→父只走 Engine 的报告通道；cwd 限制在父任务目录的子目录或独立工作树，不能写父任务受保护文件。`delegate_ticket` 只对 Ticket owner 开放，主会话没有；子 owner 只能请求同根的下级子 Ticket。
- **仅“不注册工具”挡不住外部动作**：`WORK_TOOLS` 含 `bash`，且 `Sessions.ensure` 当前给所有 session `danger-full-access`；子 owner 可以用 `git push`/`gh pr create`/`curl` 绕过工具列表。第 2 期必须给子 owner 一个**受限执行配置**（网络关闭、无 git remote/gh、`bash` 命令策略、cwd jail、无 `subagent`、无 delegation 到根），并由 `Sessions.ensure`/`limitSubagent` 强制；做不到就明确降级为“只能靠父审阅提示”，不能声称子 owner 不能做外部动作。
- **需要独立授权才升级为根 Ticket**：不同来源/人、独立动作级别、独立结束条件或独立 Channel；走 Eval，不能用子 Ticket 绕过。子 Ticket 不能有自己的 Approval 或 outbox；对外动作仍由根 Ticket 的 Approval 与 outbox 执行。

当前运行时只有 subagent Session 的基础，没有 `Ticket.parentTicketId`、`delegate_ticket`、子 owner 生命周期或父 owner 审查门；这些是第 2 期的主要工程。

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

子 Ticket **不单独归类**：它继承根 Ticket 的类别，类别任务数只统计根 Ticket；子 Ticket 不进入“未归类”，也不参与类别建议。父/根类别改变时子 Ticket 跟随，不需要级联写 placement。

### 4.5 关系的种类

用户问的“关系”至少有五种，不能都塞进一棵树：

| 关系 | 含义 | 展示位置 | 现在有没有数据 |
| --- | --- | --- | --- |
| 归属 | 根 Ticket 属于哪个类别 | 列表/树的分组头 | 新增覆盖层 |
| 父子 | 父 Ticket 下有哪些子 Ticket，父/子 owner 谁负责 | 树的 L3+、父节点详情 | **暂无**，第 2 期新增 `parentTicketId` 与 `delegation` |
| 包含 | 节点内有哪些执行单元与交付物 | 节点详情 | 工单/会话有，交付物在 `Assignment.report.review` |
| 来路 | 根 Ticket 由哪些事件、哪个来源而来 | 任务行来源 chip、详情“来源锚点” | 有（origin/channels/inputs/follows）；子 Ticket 继承根锚点 |
| 审查 | 哪个审查工单在审哪个任务 | 树中审查节点 | 有（`ownership.ts`） |
| 并行/汇合 | 任务何时并行、何时结束 | 时间线图 | 有（任务起止时间） |
| 依赖 | A 是否等 B 才能开始 | 暂不画 | **没有**，不要伪造 |

结论：树表达“归属 + 父子 + 包含 + 审查”，图表达“并行/汇合”，看板表达“状态分布”，来源 chip 表达“来路”。依赖关系等有了真实的依赖字段再做。

**审查关系的显式形状**：`TaskView.kind='review'` 且 `reviewedTicketId` 指向被审 Ticket；`TaskCategoryView.tasks` 仍是扁平的（不嵌套存储），UI 按 `reviewedTicketId` 把 review 行挂在被审 Ticket 下；被审 Ticket 不在当前类别时，review 行作为带“审查”标签的顶层行显示。类别计数同时计入 review Ticket，并另给 `counts.reviews`；不把 review 行藏进 `progress`，否则“树里能看到审查关系”不成立。

### 4.6 父子执行契约：报告—判断—再委派/自干—上报

每个 Ticket 节点有 owner（对该节点负责的 worker）与 worker（执行该节点 Assignment 的 Session）；tracked 节点的 owner 就是 `worker-<ticketId>`。lightweight 没有 owner/worker。**子 Ticket 的 owner 向父 Ticket 的 owner 报告；父 owner 判断后再向自己的上级报告；根 owner 向人给出结论。** 这条链是执行责任链，不是授权链：任何节点都不能因此获得新的 Mandate、Approval 或 outbox 权限。

```text
根 Ticket owner（worker-<rootTicketId>）
  │ delegate_ticket(goal, scope?)
  ▼
Engine：校验父/根 Ticket 存活、同一 root、根 Mandate/maxActionLevel、深度/宽度/配额
  │ 创建子 Ticket（parentTicketId, rootTicketId, 无 Mandate/Decision）+ worker-<childTicketId>
  ▼
子 Ticket owner（worker-<childTicketId>）：执行，向父 owner 报告 progress/ready/blocked/failed
  │
  ▼
父 owner：审查交付与目标
  ├─ 未完成 → return_child（attempt+1，旧 attempt 作废）或自己接管/再委派
  └─ 完成   → accept_child（结束子 Ticket）
                ├─ 父目标未完成 → 记录，继续处理剩余子 Ticket/自干
                └─ 父目标已完成 → 向自己的上级报告
                                   ├─ 上级是父 Ticket → 继续沿父 owner 链上报
                                   └─ 上级是根 → 根 owner 向人给出最终结论（root ready/review）
```

#### 4.6.1 报告

- 子 Ticket 的 Assignment 报告 `ready` 时，Engine 在父 Ticket 写入一条 `TicketInput` `child-report`（`childTicketId`、`attempt`、`assignmentId`、`reportAt`、`state`、`summary`、可选 `review`），并唤醒父 owner 的 Assignment（父在 `waiting`/空闲也能收到；不经过 Eval、不创建 Ticket、不产生人的注意力请求）。子 `blocked`/`failed` 同样回到父 owner；`progress`/`waiting` 默认不打扰父。
- 每个子 Ticket 最多一条待处理报告；后续报告合并/替换，避免父被刷屏。父 owner 必须先消化报告，再接受新的同子报告；已接受/已取消的子 Ticket 的迟到报告被拒绝。
- 父 owner 把子问题汇总后，最多向人发起一个 `human_action`；**子 owner 不能直接找人**。子报告里的 `attention`/`human_action` 不直接投给人：Engine 只把它作为 `child-report` 交给父 owner，由父 owner 汇总；只有父 owner 不可用并升级到最近在世祖先/人时，才产生一次人的 attention。根 owner 的最终结论走根 Ticket 的 `ready`/`review`/通知路径，不由子 owner 直发。
- 父 owner 接受子交付后，**若该节点的目标已全部完成**：它本身是子 Ticket 就向自己的父 owner 报告，是根 Ticket 就向人给出结论；若目标未完成，只记录接受并继续处理剩余子 Ticket/自干，不提前上报“完成”。这样“报告—判断—再委派/自干—上报”逐层闭合。

#### 4.6.2 判断

父 owner 对每条子报告必须写一个明确处置，不能静默忽略：

| 判断 | 动作 | 结果 |
| --- | --- | --- |
| 完成且交付可接受 | `accept_child(childTicketId, merge?)` | 子 Ticket `ended { by:'executor', outcome:'completed', reason:'accepted-by-parent' }`，写 `Delegation.resolution.kind='accepted'`、`acceptedReportAt`、`acceptedAttempt`；终止子 worker；延迟报告被拒；父继续，父目标完成后再向上报告。 |
| 未完成、需子 owner 补充 | `return_child(childTicketId, reason)` | 子 Ticket 重开：`attempt += 1`，清除旧 `resolution`/旧 merge/旧 report 的接受效力，启动新 Assignment/worker；旧 attempt 的 session/报告全部作废。不写 `returned` 终态。子 Ticket 已被接受但根尚未最终批准时也可退回；必须同时清除 accepted/merge 并让根的 `reviewRevision` 失效；根已最终批准后，父 owner 不得单方面退回。 |
| 父 owner 自己接管剩余工作 | 继续自己的 Assignment，写 `ChildReportDisposition.decision='self-work'` | 子 Ticket 可 `cancel_child` 或保留待补充；父的交付负责到底；不得把子的未完成工作算成已完成。 |
| 换一个子 Ticket/重新委派 | `cancel_child` 旧子并 `delegate_ticket` 新子，或 `return_child` 后改 goal | 写 `reassigned` 与替换 id；旧子不再被接受，交付按新子重做。 |
| 父 owner 取消子 Ticket（不再重试） | `cancel_child(childTicketId, reason)` | 子 Ticket `ended { by:'executor', outcome:'stopped', reason }`，写 `Delegation.resolution.kind='cancelled'`；终止子 worker；父继续/上报。 |
| 子 Ticket 已失败且不再重试 | `cancel_child(childTicketId, reason, disposition='failed')` | 子 Ticket `ended { by:'executor', outcome:'dropped', reason:'child-failed' }`，写 `Delegation.resolution.kind='failed'`；终止子 worker；父继续/上报；不得留下 live 的“已失败”子 Ticket。 |
| 冲突/需要人的决定 | 根 owner 汇总成一个 `human_action` | 不重复打扰；不把冲突藏进父报告。 |

父 owner 的接受只表示子 Ticket 的工作交付被接受，**不写人的 `Review.confirmations`，不结束根 Ticket，不替代最终人工验收**。根 Ticket 的最终验收仍由人按 `reviewRevision` 批准（6.6）。

#### 4.6.3 留痕：trace / disposition / approval

每次「报告—判断—再委派/自干—上报」都必须可复核，不能只留在 worker 的对话里：

| 环节 | 记录 | 位置 |
| --- | --- | --- |
| 子报告 | `TicketInput.kind='child-report'`（id、childTicketId、attempt、assignmentId、reportAt、state、summary、review?）；投递状态 `deliveredAt`/`readAt` | 父 Ticket 的 `inputs`；`GET tasks/:id` 详情可见 |
| 父判断 | `ChildReportDisposition`（decision、by、at、reason、traceId、replacementTicketId?） | 子 Ticket 的 `delegation.lastDisposition`；父/子 trace |
| 取消/失败 | `ChildReportDisposition.decision='cancelled'/'failed'` + `Delegation.resolution` + 子 Ticket `ended`（stopped/dropped）；终止子 worker | 子 Ticket / 父 trace；activity |
| 再委派 | 新 `ticket.delegated` 事件 + `delegation.delegate` trace stage（parentTicketId、childTicketId、attempt、depth） | 根/父 trace；activity |
| 自干 | 父 Assignment 的 `progress`/`ready` 报告 + `delegation.self-work` trace stage（reason、childTicketId、remaining scope） | 父 trace；activity |
| 上报 | 父（作为子）向祖父报告时的 `child-report` 输入；根向人的结论走根 `ready`/`review`/通知，附 `childReportId` 链 | 祖父 inputs / 根 review；trace |
| 对外动作 | 根 Ticket 的 `Approval`（`ticketId=rootTicketId`，`requestedForTicketId=childTicketId`）+ outbox（`ticketId=rootTicketId`，`originTicketId=childTicketId`） | 根 Approval/outbox；子不能自行审批/外发 |

- **trace**：子 trace 记录自己的 `report`/`ended`；父 trace 记录 `delegation.report`、`delegation.review`、`delegation.delegate`、`delegation.self-work`、`delegation.report-up`。子/父 trace 用 `parentTraceId` 关联，父审阅结论带 `childReportId`、`attempt`、`artifact.key`/`reviewRevision`（有交付时）。
- **disposition**：`ChildReportDisposition` 是父判断的 canonical 记录；未判断的报告在详情显示“待父 owner 审阅”，不能显示成已接受。`accept/return/cancel` 都写 disposition，退回不是终态处置。
- **approval**：只有根 Ticket 有 Approval；子发起的对外动作只生成根 Approval，并带 `requestedForTicketId` 便于审计；outbox 同理，`ticketId` 必须是根。父 owner 的判断不是 Approval，子 owner 也不能审批自己的动作。
- **activity**：子报告/审阅/委派/上报进入 activity，但按根 Ticket 聚合；不增加人的未读数/通知预算。`ActivityRecord.subject` 可带 `parentTicketId`/`rootTicketId`；根视图按根分组，子行详情可下钻。

#### 4.6.4 结束门、`pendingEnd` 与停止级联

- **未结束子 Ticket（unresolved）** = 子 Ticket 仍 live，且没有**当前有效**的终态 `Delegation.resolution`。终态必须与 `Ticket.ended` 成对：`accepted`→completed、`cancelled`→stopped、`failed`→dropped；**只有 resolution 没有 ended，或只有 ended 没有 resolution，按未处置/损坏处理**（写 attention，不静默放行父结束）。有效规则：`cancelled`/`failed` 始终有效；`accepted` 只在 `acceptedReportAt === report.at` 且 `acceptedAttempt === attempt` 时有效（接受前若已有更新报告，旧接受无效；接受后子 Ticket 已结束，迟到报告被拒绝）。`ended` 的子 Ticket 已结束；`orphaned` 不是终态 resolution，仍按 unresolved 处理，直到最近在世祖先/人接受/退回/取消。`return_child` 清除 resolution 并把子 Ticket 回 `working`，因此不会把重新打开的子 Ticket 误算成已处置。
- **所有结束路径共用一道门**：`Assignments.report` 的 `ready`/`dropped`、`Tickets.threadClosed`/`followsDone` 的 PR/线程合并、人停止父/根 Ticket，最终都经过 `Tickets.end`；父 `failed` 不是结束路径，见下。`Tickets.end` 检查直接子 Ticket 的 unresolved 集合（每个子自己也受同一道门约束，所以直接子全部结束即子树结束）。不能只挡 `ready`。
- **`ready`**：有未结束子 Ticket 时 **拒绝该 report**（`UserError` 代码 `unfinishedChildTickets`），不把 `ready` 写进 `Assignment.report`；父 owner 收到“还有 N 个子 Ticket 未结束”的清单，继续处理。`Assignments.review`/`reviewTicket` 也必须再查一次未结束子 Ticket，不能只靠 `Tickets.end` 或报告阶段。父 owner 必须对每个失败/孤儿子 Ticket 写 `resolution`（accepted/cancelled/failed）后才能再次报 `ready`；`return_child` 是重开，不是终态处置。
- **`dropped` / 人停止**：终态；Engine 取消所有子 Ticket（写 `Delegation.resolution.kind='cancelled'`，原因记录），再结束父/根 Ticket；人停止的 outcome 是 `stopped`，不是 `failed`。子 Ticket 被级联停止时写 `ended { by:'human', outcome:'stopped', reason:'parent-stopped' }`。
- **父 `failed`**：**不是终态**。现有 `TicketOutcome` 没有 `failed`，`failed` 是等人处理的阶段；Engine 让子 Ticket 进入只读/`blocked`（原因 `parent-failed`）而不是静默取消，保留子工作；父 Ticket 保持 live，`waitsForPerson`/`canRetry` 照旧，人/父 owner 重试时开新 Assignment，恢复后子 Ticket 继续；若父最终不可恢复，人取消子树并按 pending 结束。不要为了级联失败去改 `TicketOutcome`/`Tickets.retry`。
- **`follows`/PR 合并**：如果还有未结束子 Ticket，**不静默结束**。`Tickets.threadClosed`/`followsDone` 写 `Ticket.endPending = { by:'thread'|'follows', outcome:'merged'|'closed', at, reason, ref }`（不写 `ended`），并追加一个 `TicketInput` `end-gate`，Engine 立即启动/恢复父 owner 的 Assignment；父 owner 处理子 Ticket 后再调用 `Tickets.end` 应用 pending。父 Assignment 不可恢复、或父已 `blocked` 且无人处理时，生成一个 attention（不是每子 Ticket 一个）；人可取消子树并按 pending 结束，或重试父。若父已经结束/记录缺失，直接级联取消子树并写 `ended`，不留下无主 pending。`Assignments.report` 不能绕过这个 pending。父把最后一个子 Ticket 处置完并报 `ready`/`dropped` 时，`Tickets.end` 先过未结束子 Ticket 门，再应用 pending 的 `by`/`outcome`/`reason`；pending 只决定结束原因，不改变父 owner 对最终目标的完成判断。**任何 `Tickets.end` 一旦真正结束，都清除 `endPending`；人 stop/`dropped` 的结局优先，直接丢弃 pending 并用 `stopped`/`dropped`。**
- **`waiting`**：这是父 owner 正常一轮结束的状态（Executor 每轮结束都会报 `waiting`），**不是父不可用**；子 Ticket 继续工作，子报告通过 `child-report` 唤醒父，父下一轮继续审阅。此时 `TaskView` 的父状态按 6.3 是 `working`，不是 `idle`。
- **`blocked`**：父在等人/等外部决定；子 Ticket 只允许只读/草稿类本地工作，外部动作暂停；`workOnly` 在父 `blocked` 时只注册只读工具，父恢复后再注册执行工具。父 session 不存在/已结束且没有可恢复的 Assignment 时，`workOnly` 拒绝子 owner 写入并标记 `orphaned`。
- **停止级联**：人停止根 → 根及其所有子 Ticket 停止；父 owner `cancel_child` 只停该子树，不影响父和其他分支。父/根结束或失败后，子 worker 不能继续写。子 Ticket 停止后，其迟到报告/旧 attempt 全部拒绝。

#### 4.6.5 失败、孤儿、重启恢复与父 owner 缺位

- 子 Ticket 失败/阻塞 → 父 owner 收到报告，决定重试、换子 Ticket、自己接管或报失败；父任务不会自动失败。父 owner 必须写 `Delegation.resolution` 并结束/终止子 Ticket（`cancelled`/`failed` 走 `cancel_child`，`accept` 走 `accept_child`），不能把 failed 子 Ticket 当没看见，也不能留下“已处置但仍在写”的子 owner。
- 父 owner 停止/结束 → 子 owner 停止；父/根任务结束后子 Ticket 不能继续写。父 owner 暂时不可用但父 Ticket 仍 live、Assignment 可恢复时，先恢复父，再把排队报告投递；不能因为父 session 还没加载就把所有子 Ticket 标 orphaned。
- **恢复顺序**：先恢复根/父 Ticket 与父 owner，再恢复子 Ticket 记录与子 owner。`working` 子 Ticket 重启后先标 `blocked`（原因 `restart`），父可用后恢复 `working`；只有父/根 Ticket 记录缺失、父已结束、或父 owner 无任何可恢复 Assignment 时，才标 `orphaned`。
- **父 owner 缺位或已结束**：
  - 父 Ticket live、父 owner session 缺失但父 Assignment 可恢复：先重启父；报告留在父 `inputs`（`undelivered`/未读），子 Ticket 进入只读等待，不丢报告、不自动完成。
  - 父 Ticket live、父 owner 不可恢复：子 Ticket 标 `orphaned`，Engine 向上找到**最近的在世祖先 owner**（祖父 owner 链；没有则根 owner/人），只发一次 attention；该 owner 可重试父、取消子树，或在能核对交付时接受/退回子 Ticket，但不得静默重跑或标完成。
  - 父 Ticket 已结束/记录缺失：子 Ticket 不能继续写；若报告在途，写一条孤儿记录并升级一次给最近在世祖先/人；人可查看交付后取消或另开新根 Ticket 重做，不能把子 Ticket 挂到一个已结束父上“补接受”。
  - 根 owner 缺位/根已结束：人收到一次结论/缺口；根保持 live 或按现有结束路径处理，子 Ticket 不自动外发、不自动完成。
- **迟到 attempt**：`Delegation.attempt` 从 1 开始；`return_child` 递增并换新 Assignment/worker。Engine 只接受 `report.attempt === delegation.attempt` 且 `assignmentId` 属于当前 Assignment 的报告；旧 attempt 的 session 已终止，迟到报告被拒（`staleChildAttempt`/`childClosed`），不能推进父状态或 `reviewRevision`。`accept_child` 记录 `acceptedReportAt`/`acceptedAttempt`，接受后迟到报告被拒；接受前若子有新报告，旧接受失效。由于子 Ticket 用普通 `worker-<ticketId>` 命名，`ticketOfSession` 不需要新前缀，但 `agent/status`、`agent/error`、`session/event` 处理器必须校验 assignment/attempt，不能把旧 attempt 的事件写到新尝试或父状态上。
- **合并记录**：父 `accept_child` 时写 `Delegation.merge`（子 revision、冲突列表、`merged`/`escalated`/`none`、解决人/时间）；父解决不了冲突时升级为一个人问题。没有合并记录的“已接受”不算可审计的合并。之后 `return_child` 必须清除/标记该 `merge` 失效；重新接受时写新的合并记录，不能沿用旧 revision 的合并。
- **子 owner 不做外部动作**：子 owner 只做 read/draft/local write；commit、send、spend、开 PR、合并 PR 由父/根 owner 执行或经根发起 Approval。**但工具列表本身不够**：子 owner 的 `bash` 必须走 4.3 的受限执行配置（无网络/remote/gh、命令策略、cwd jail、无 `subagent`），否则本条的“不能”不成立，只能降级为父审阅提示。`Review.confirmations` 仍由人在最终根 Ticket 确认。
- **报告唤醒**：子报告通过 `TicketInput` 的 `child-report` 变体进入父 owner；每个子 Ticket 最多一条待处理报告；父在 `waiting`/空闲时由 Engine 启动/恢复父 Assignment（不触发 Eval、不创建 Ticket、不产生人的注意力请求）。父不可恢复时才走 orphaned 升级。

## 5. 第一级类别：归纳与人工修改

### 5.1 生成流程

```text
Ticket accepted（只对根 Ticket；子 Ticket 继承根类别，不单独入队）
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

- **只分类根 Ticket，不分类子 Ticket**：子 Ticket 继承根 Ticket 的类别；类别任务数只统计根 Ticket，避免子 Ticket 把类别计数撑大。
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
- **分类不是自我进化提案**：归类只写可撤销的显示覆盖层；新类别、合并、拆分、验收模板仍只建议。高置信命中已有类别的自动归属可关闭，写入 `history`，且不改变授权、验收条件或上下文装配（见设计原则 PR #30 的 C.1/C.2）。
- **类别不是群组/组织上下文**：群组由 Source 的 Channel 地址与 Thread/Subscription 派生（设计原则 C.3）；类别只表示展示归属，不派生成员名单、不进入 prompt 装配、不授予任何权限。两者可以同时存在，但不能互相替代。

## 6. 数据模型与接口

### 6.1 覆盖层与 Ticket 自引用

任务类别覆盖层不变：

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
  ticketIds: string[]           // 支持任务；≥2 才可建类；只收根 Ticket
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
  placements: Record<string, TaskPlacement>   // ticketId -> placement；只收根 Ticket
  suggestions: CategorySuggestion[]           // 含 open/dismissed/accepted；读取只展示 open 且未过期
  history: TaskCatalogueChange[]              // 最近 N 条，可截断
  updatedAt: string
}
```

Ticket 自引用：所有节点都在同一张 `ticket` 表里，类型上分根/子两种形态。

```ts
// 现有 Ticket 的公共部分；字段语义不变。
interface TicketBase {
  id: string
  title: string
  form?: TicketForm
  channels: ChannelRef[]
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  attention?: Attention
  assignments: Assignment[]
  inputs: TicketInput[]
  undelivered: string[]
  follows?: Follow[]
  answers?: string[]
  createdAt: string
  updatedAt: string
  /** 根 Ticket 记录自己的来源；子 Ticket 复制根的 origin 以保持 trace 连续，实际委派记录在 delegation。 */
  origin: { triggerId: string; triggerIds: string[] }
  execution?: Execution
  delivery?: { error: string; at: string }
  /** 子 Ticket 必填、根 Ticket 缺省；创建后不可改。 */
  parentTicketId?: string
  /** 授权根：根 Ticket 可缺省（即自身），子 Ticket 必填。 */
  rootTicketId?: string
  /** 仅子 Ticket；父 owner 的委派、attempt、处置、合并记录。 */
  delegation?: Delegation
}

interface RootTicket extends TicketBase {
  parentTicketId?: never
  rootTicketId?: never
  decisionId: string
  mandate: Mandate
  delegation?: never
}

interface ChildTicket extends TicketBase {
  parentTicketId: string
  rootTicketId: string
  /** 子 Ticket 不创建新的 Mandate/Decision，字段必须缺省。 */
  decisionId?: never
  mandate?: never
  delegation: Delegation
}

type Ticket = RootTicket | ChildTicket

interface Delegation {
  parentTicketId: string
  rootTicketId: string
  goal: string                     // 子目标；父 owner 写，子 owner 不能改
  scope?: string                   // 执行提示，不是授权；不能扩 maxActionLevel
  requestedBy: { ticketId: string; sessionId: string }   // 父 owner 的 worker
  attempt: number                  // 1-based；return_child 递增，旧 attempt 作废
  createdAt: string
  startedAt?: string
  endedAt?: string
  reportCount?: number
  lastReportAt?: string
  /** 父 owner 对最新报告的判断；未判断时缺省，详情显示“待父 owner 审阅”。 */
  lastDisposition?: ChildReportDisposition
  /** 终态处置：accepted/cancelled/failed；return_child 会清除它，不写 'returned'。
   *  终态必须与 Ticket.ended 成对出现：accepted→completed，cancelled→stopped，
   *  failed→dropped；只有 resolution 没有 ended 视为未处置/损坏，不能放行父结束。 */
  resolution?: {
    kind: 'accepted' | 'cancelled' | 'failed'
    by: ActorRef
    at: string
    /** accepted 时必填，绑定被接受的那次报告与 attempt；接受前的新报告/退回后失效。 */
    acceptedReportAt?: string
    acceptedAttempt?: number
    reason?: string
    traceId?: string
  }
  merge?: { at: string; by: ActorRef; into?: string; childRevisions: string[]; conflicts: string[]; resolution: 'merged' | 'escalated' | 'none'; reason?: string }
  workspace?: { kind: 'worktree' | 'branch' | 'directory'; ref: string }
}

interface ChildReportDisposition {
  reportId?: string                // accepted/returned 时必填；cancel/fail 可缺省
  childTicketId: string
  attempt: number
  assignmentId?: string            // accepted/returned 时必填
  reportAt?: string                // accepted/returned 时必填
  decision: 'accepted' | 'returned' | 'reassigned' | 'self-work' | 'escalated' | 'cancelled' | 'failed'
  by: ActorRef                     // 父 owner（或升级后的最近在世祖先）
  at: string
  reason?: string
  traceId: string
  replacementTicketId?: string     // reassigned 时的新子 Ticket
}
```

**授权字段的边界**：`RootTicket` 才有 `decisionId`/`mandate`；`ChildTicket` 只有 `rootTicketId`。运行时提供 `rootTicket(ticket)` / `rootMandate(ticket)` 访问器，所有动作闸门、Approval、outbox 都从根解析；不能用子 Ticket 自己的字段兜底，也不能给子 Ticket 复制一份 Mandate。子 Ticket 的 `origin` 复制根 Trigger 仅用于 trace 连续，**不表示新的接受/Decision**；实际委派记录在 `delegation.requestedBy`。

最终审查聚合仍是 Ticket 级只读投影，来源改为 Ticket：

```ts
type ReviewSource = { kind: 'ticket'; ticketId: string; assignmentId: string }

interface ReviewConfirmationView {
  /** 稳定标识：`ticket:<ticketId>:<assignmentId>:<index>`。 */
  ref: string
  source: ReviewSource
  criterion: HumanCriterion
  /** 仅当当前 reviewRevision 已被批准时由投影填充；不是单独确认。 */
  coveredBy?: { by: ActorRef; at: string; reviewRevision: string }
}

type DeliverableSummary = {
  /** 去重键：`<artifact.kind>:<artifact.ref>:<artifact.revision>`。 */
  key: string
  /** 至少一项；根/已接受子 Ticket 产出同一 artifact/revision 时合并到同一行。 */
  sources: ReviewSource[]
  at: string
  artifact: Artifact
  previewRef: PreviewRef
  criteria: RuleCriterion[]
  confirmations: HumanCriterion[]
  parentAccepted?: { by: ActorRef; at: string } // 子交付被父 owner 接受；不等于人确认
  humanAccepted?: { by: ActorRef; at: string; reviewRevision: string }
}

interface ReviewAggregate {
  reviewRevision: string
  deliverables: DeliverableSummary[]
  criteria: RuleCriterion[]
  confirmations: ReviewConfirmationView[]
}

type TaskReviewView = ReviewAggregate & {
  accepted?: { by: ActorRef; at: string; reviewRevision: string }
}

interface PendingEnd {
  by: 'thread' | 'follows'   // human stop 走取消级联，不用 pending
  outcome: 'merged' | 'closed'
  at: string
  reason?: string
  ref?: string
}
// Ticket 的加法字段：endPending?: PendingEnd。它存在时 Ticket 仍是 live，
// 只是结束被未结束子 Ticket 挡住；不能与 ended 同时存在。
// 视图层叫 pendingEnd、Ticket 层叫 endPending，是同一状态的两个层名，不是两份记录。
```

**Approval / outbox 的根归属**：`Approval.ticketId` 与 `OutboundSend.ticketId` 必须是根 Ticket；新增可选的 `requestedForTicketId` / `originTicketId` 记录是哪个子 Ticket 发起的，便于审计。子 Ticket 不能有自己的 Approval，也不能直接写 outbox；父/根 owner 代为发起时，动作级别仍受根 Mandate 的 `maxActionLevel` 限制。

`Delegation.resolution.kind='accepted'` 必须带 `acceptedReportAt` 且等于当前 `report.at`、`acceptedAttempt === attempt`；缺失或过期按“未处置”处理，不能因为字段存在就放行父结束。`Delegation.lastDisposition` 与 `resolution` 是父判断的 canonical 记录，不能只写在 trace 或聊天里。

### 6.2 存储

**类别覆盖层第一阶段用 KV 文档，不升 schema**：

- key：`task-catalogue.v1`；值：上面的 `TaskCatalogue`；
- 单写者：新增 `TaskCatalogue` 服务（`packages/dsh/src/app/task-catalogue.ts`），所有写操作在 `Store.atomic` 内一次替换文档；
- 读：`tasks.ts` 读取目录并合并投影；`GET tasks` 不写库；
- 为什么不用 SQL 表：类别/归属是低频、小体量、强一致的覆盖层；一个 JSON 文档足够，避免 schema 迁移与回滚成本。
- 何时升级：出现多人并发编辑、按类别分页查询、类别历史长期保留时，再升 schema 16，建 `task_category` / `task_placement` 两表；文档形状可 1:1 映射，迁移是加法。

**子 Ticket 复用 `ticket` 表（第 2 期，schema 15）**：

- **不建 `subtask` 表**。`ticket.value` 的 JSON 增加 `parentTicketId`、`rootTicketId`、`delegation`；根 Ticket 不写这些字段，旧行天然是根。
- `SCHEMA_VERSION` 从 14 升到 15，只做**加法生成列与索引**，不重写任何记录：
  ```sql
  ALTER TABLE ticket ADD COLUMN parent TEXT AS (value ->> '$.parentTicketId');
  ALTER TABLE ticket ADD COLUMN root   TEXT AS (COALESCE(value ->> '$.rootTicketId', id));
  CREATE INDEX ticket_parent ON ticket(parent) WHERE parent IS NOT NULL;
  CREATE INDEX ticket_root   ON ticket(root);
  ```
  （`Store.addColumns()` 按现有 `SETS` 机制自动补列/索引；生成列表达式来自 JSON，旧库迁移后根 Ticket 的 `parent` 为 NULL、`root` 等于自身。若现有 `addColumns()` 只支持普通列类型，就在 schema 14→15 迁移中显式执行上面的 SQL，不要为生成列硬塞普通列定义。）
- **索引与现有查询的关系**：
  - `ticket_open`/`ticket_active` 仍按每行计算；根/子 Ticket 都能被 `tickets.get(id)` 读取。
  - `tickets.list()/open()/active()` **默认只返回根 Ticket**（`parent IS NULL`），供 Eval、派发、类别计数、任务页、指标使用；否则子 Ticket 会被误当独立工作。
  - 新增 `tickets.childrenOf(ticketId)`（`WHERE parent = ?`，直接子）与 `tickets.subtree(rootTicketId)`（`WHERE root = ?`，用于停止级联/聚合）；执行器重启另用内部 `allActive()` 同时恢复根与子，不混入 Eval。
  - `Tickets.end` 的直接子查询用 `childrenOf`；每个子自己也过同一道门，所以直接子全部结束即子树结束。
  - `tasks.ts`/`activity.ts`/`metrics`/`views/tickets.ts` 的列表与计数必须显式带根过滤；`ownership.ts` 只对根 Ticket 推计划/审查归属，子 Ticket 继承根。
- **索引意义**：`ticket_parent` 支持父审阅/结束门/一层展开；`ticket_root` 支持根级配额（单根活跃子 Ticket ≤32）、级联停止与最终审查聚合。没有这两个索引就会退化成全表 JSON 扫描。
- **迁移是加法**：旧 Ticket 没有 `parentTicketId`，视图显示为根；旧 `delegation` 不存在时子字段为空；`attempt` 缺省读作 1。不把历史 subagent Session 或实验性 `subtask` 表追溯成子 Ticket；若旧库有实验表，导出后由迁移清理，不读取。
- **为什么仍要升 schema**：虽然 JSON 字段本身是加法，但旧二进制（schema 14）打开 schema 15 库必须被拒绝；否则它会把子 Ticket 当根 Ticket 参与 Eval/通知/审批，破坏“授权根唯一”。schema 15 是保护不变量的一部分，不只是存储细节。

**兼容**：没有 `task-catalogue.v1` 时，任务页按现有计划树渲染；首次归纳/人工编辑时创建文档。类别 KV 不需要迁移；schema 15 由 Store 自动迁移，旧库迁移后子 Ticket 为空，这是前向迁移，不是“无需迁移”。

**损坏处理**：文档解析失败时不覆盖、不写回；任务页回退旧树并提示，保留原始 JSON 供诊断。发现子 Ticket 的 `rootTicketId` 缺失/指向不存在/成环时，投影拒绝把它当任务节点，写一条 attention 并只读展示，不能猜一个根。

### 6.3 投影

在现有 `TaskBoardView` 上做**加法**，保留 `milestones` 一个版本：

```ts
interface TaskBoardView {
  generatedAt: string
  categories: TaskCategoryView[]       // 新：含 active/archived，默认只渲染 active，切“已归档”再显示
  unclassified: TaskView[]             // 新：只含根 Ticket
  suggestions: CategorySuggestion[]    // 新：只含 open 且未过期的类别建议，不占类别上限
  milestones: TaskMilestone[]          // 兼容保留；后续标记 deprecated
  totals: {
    milestones: number                  // 旧字段保留
    tasks: number                       // 旧字段保留：计划任务数
    tickets: number                     // 旧字段保留：根 Ticket 数
    open: number                        // 旧字段：live 根 Ticket（Ticket.ended 缺失），不是 tasks - done
    attention: number                   // 新：只计人的注意力，不计子 Ticket 的“待父审阅”
    children: number                    // 新：live 子 Ticket 数；只做信息，不进类别计数
  }
}

// 新视图的任务总数从 `categories[].tasks` + `unclassified` 计算（只算根 Ticket）；
// 不要复用旧 `totals.tasks`（它是计划任务数，不是用户任务数），也不要把子 Ticket 加进类别计数。

interface TaskCategoryView {
  id: string
  name: string
  goal?: string
  order: number
  state: 'active' | 'archived'
  aliases?: string[]
  status: ActivityStatus               // 类别汇总：按根 Ticket 的父状态，失败 > 阻塞 > 待人 > 进行中 > 排队 > 全部完成 > 空闲取最高
  tasks: TaskView[]                     // 扁平：只含根 Ticket；review 行按 reviewedTicketId 在 UI 缩进，不嵌套存储
  counts: {
    tasks: number          // 该类别下所有根 Ticket，含 review Ticket
    unfinished: number     // live 根 Ticket，语义与旧 totals.open 一致
    attention: number      // 人的注意力，只计根 Ticket
    working: number
    done: number
    failed: number
    dropped: number        // 含 lightweight dropped；按 terminal 计，不按 status=done 计
    stopped: number        // status 仍按现有 activityStatusOf=failed；counts 用 terminal=stopped 兜底，不把已停止计入 failed
    reviews: number        // kind='review' 的子集；仅信息，不参与 tasks 求和
  } // 对账：tasks = unfinished + done + failed + dropped + stopped；tasks 含 review Ticket，reviews 是子集；子 Ticket 另见 TaskView.childSummary
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

interface TaskActorView {
  ticketId: string                     // owner/worker 所属 Ticket
  role: 'owner' | 'worker'             // owner = 对该节点负责；worker = 执行 Session；当前同一 Session
  label?: string                       // E1 角色文案：根 owner / 子 Ticket owner / 父 owner
  sessionId?: string                   // `worker-<ticketId>`；只在 E2 技术详情出现
}

interface TaskView {
  id: string                           // Ticket.id（裸 id，不加 `ticket:` 前缀）
  kind: 'ticket' | 'review'            // review 是审查 Ticket；其余为 ticket；子 Ticket 也走 ticket + parentTicketId
  reviewedTicketId?: string            // kind='review' 时必填；来自 ownership 推导
  title: string
  form: 'tracked' | 'lightweight'      // 数据里 form 缺省按 tracked；子 Ticket 永远 tracked
  parentTicketId?: string              // 子 Ticket 必填；根缺省
  rootTicketId: string                 // 根 = 自身；子 = 授权的根
  depth: number                        // 根 = 0；子 = 父 + 1
  owner?: TaskActorView                // 该节点的 owner；lightweight 没有，投影为 undefined
  worker?: TaskActorView               // 该节点的执行 worker；当前与 owner 同 Session；lightweight 无
  parentOwner?: TaskActorView          // 子 Ticket：报告接收者（父 Ticket 的 owner）
  categoryId?: string
  status: ActivityStatus
  terminal?: 'dropped' | 'stopped'     // dropped 的 status=done；stopped 沿用现有 activityStatusOf=failed。cancelled 由 Delegation.resolution 表达
  pendingEnd?: PendingEnd              // PR/线程已关闭但子 Ticket 未结束时的挂起结束
  attention?: boolean                  // 只表示“需要人”；子 Ticket 的待父审阅不算人
  plan?: PlanRef                       // 计划标签，不再当层级
  origin: { source: string; triggerId: string; preview: string; at: string } // 子 Ticket 复制根 origin 以保持 trace
  sources: TaskSourceView[]            // 根：来源锚点；子：继承根锚点，不单独展开
  lastEventAt?: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  progress?: { done: number; total: number } // 沿用现有 Ticket 节点的 review 完成数，不是执行步骤
  suggestedCategory?: { id: string; name: string; goal?: string; confidence: number }
  execution: {
    name?: string                      // 现有 Execution.name（工作目录短名）
    sessionId?: string                 // worker-<ticketId>；子 Ticket 同样是 worker-<childId>
    assignments: number                // lightweight 固定 0
    subagents?: number                 // 宿主可读时才有；lightweight 为 0
  }
  delegation?: {
    parentTicketId: string
    rootTicketId: string
    goal: string
    scope?: string
    attempt: number
    lastDisposition?: ChildReportDisposition
    resolution?: Delegation['resolution']
    merge?: Delegation['merge']
    orphaned?: { reason: string; at: string } // 父/根不可用，等待最近在世祖先/人
  }
  children?: TaskView[]                // 仅详情查询返回；默认一层，更深按 depth 懒加载；lightweight 不返回
  childSummary: {
    total: number
    live: number
    queued: number
    working: number
    waiting: number
    review: number          // 待父 owner 审阅，不是人的 review
    blocked: number
    failed: number
    orphaned: number
    accepted: number
    cancelled: number
    unresolved: number      // live 且无当前有效 resolution；父结束门看这个
  }
  deliverables: DeliverableSummary[]   // tracked：当前节点 report.review 的去重交付；lightweight：始终空数组
  review?: TaskReviewView              // 根详情：根 + 已接受子 Ticket 的聚合；子详情：自己的交付与“确认进入根 review”
  inline?: { steps: number; lastActionAt?: string; summary?: string; traceId?: string } // lightweight 的执行摘要，不是 DeliverableSummary
  executionUnits?: ExecutionUnitView[] // 懒加载或详情读
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

`DeliverableSummary` 不要求“恰好一个 owner”：它由 `sources: ReviewSource[]` 表达来源，至少一项；同一 artifact/revision 的根/子报告合并成一行并列出所有来源。读取时拒绝空 sources、未知 source、以及 `previewRef.revision !== artifact.revision`。

`TaskView.suggestedCategory` 从 `suggestions` 中包含该根 Ticket 的条目填充；建议本身不写 `TaskPlacement`，采用后才生成类别与归属。子 Ticket 不参与建议。

**子 Ticket 的状态**：子 Ticket 是普通 Ticket，直接用现有 `activityStatusOf`/`ticketStage`，不再维护第二套 `Subtask.state`：

| 子 Ticket 的实际阶段 | 投影 status | 显示 |
| --- | --- | --- |
| 已排队、无 current Assignment | `queued` | 排队 |
| Assignment running / 最近报告 progress | `working` | 进行中 |
| 最近报告 waiting、父 owner 暂无新输入 | `idle` | “等待父/下一轮”；父行按 4.6 视为 working |
| 最近报告 ready，父 owner 未处置 | `review` | 待父 owner 审阅（不是人的 review） |
| 最近报告 blocked / 父 blocked | `blocked` | 阻塞（具体原因看 report/attention） |
| 最近报告 failed | `failed` | 失败，等父 owner 处置 |
| ended outcome completed/merged/closed | `done` | 已接受/完成 |
| ended outcome dropped | `done` + `terminal='dropped'` | 已放弃（无交付） |
| ended outcome stopped | `failed` + `terminal='stopped'` | 已停止；父级联停止也走这里 |
| 父/根不可用 | `blocked` + `delegation.orphaned` | 孤儿，等最近在世祖先/人 |

关键约束：

- **终态绝不用 `idle`**：`idle` 在现有活动模型里是 live、等下一 Trigger 的状态，且被 `matchesActivityFilter('running')` 包含；`dropped`/`stopped` 用 `done`/`failed` + `terminal` 表达，否则会出现在“进行中”。取消由 `Delegation.resolution.kind='cancelled'` 表达，不新造 `terminal='cancelled'`。
- **`waiting` 不是 `blocked`**：它只是父 owner 一轮正常结束；子 Ticket 继续工作。`TaskView.status` 是展示字段，attention/父状态/类别汇总必须从子 Ticket 的 `ticketStage`、`Delegation.resolution` 与 `delegation.orphaned` 计算；任何代码不得用 `TaskView.status` 判断“需处理”。
- **`orphaned`** 保持 `blocked` 展示，但必须带原因；它仍是 unresolved，父/最近在世祖先/人必须处置。

**旧 `Subtask` 投影的等价迁移**（实现时只用于迁移对照，不再保留类型）：旧 `queued/working/waiting/review/blocked/failed/done/dropped/cancelled/orphaned` 分别对应上表的子 Ticket 阶段；旧 `Subtask.report.state` 到阶段的映射仍按 `progress→working`、`waiting→idle`、`ready→review`、`blocked→blocked`、`failed→failed`、`dropped→done+dropped`；旧 `cancelled` 对应 ended `dropped` + `resolution.kind='cancelled'`。旧 `subtask-<id>-<attempt>` Session 迁移为 `worker-<childTicketId>` 后，attempt 由 `Delegation.attempt`/Assignment 记录，不再靠 Session 名前缀。

`TaskView` 是投影，不是存储；不要把它写回 `Ticket`。

**lightweight 的状态单独投影**：不套 tracked 的 `activityStatusOf`/`ticketStage`（它没有 Assignment）。inline run 进行中 → `working`，已排队 → `queued`，`completed` → `done`，`dropped` → `done` + `terminal='dropped'`；不进入 `review`/`answer`/`delivery`/`blocked`，也不产生 `attention`。lightweight 没有子 Ticket，不参与下面的父状态投影。`done` 不表示“成功”，只是已结束；成功/放弃由 `terminal` 区分。

**父 Ticket 的状态要感知子 Ticket**，不能直接套现有 `activityStatusOf`（父在等子 Ticket 时会被算成 `idle`）：

| 父状态 | 规则 |
| --- | --- |
| `blocked` | 有未结束（无有效 `resolution`）子 Ticket 处于 `failed`/`orphaned`/`blocked`，或父自己有未回答的 `attention`，或父/子 owner 缺位 |
| `working` | 有 `queued`/`working`/`waiting`/`review` 子 Ticket，且没有未结束的 failed/orphaned/blocked |
| 其他 | 没有未结束子 Ticket 时，沿用现有 `activityStatusOf`/`ticketStage` |

类别汇总/`status` 按根 Ticket 的这个父状态计算；`counts.attention` 与右栏“需处理”按下面的 attention 规则计算，不能只看父状态，否则会漏掉普通 `review`/`answer`/`delivery`。

**`attention` 只表示“需要人”，不能由 `TaskView.status` 计算**：沿用现有 `matchesActivityFilter('attention')` 的 person-stage 集合 `{review, answer, delivery, blocked, failed}`，对每个 **未结束的根 Ticket** 计算；再加上未结束子 Ticket 的 `failed`/`orphaned`/`blocked` 且无有效 `resolution`，以及 `pendingEnd`/父 owner 缺位的升级项。**子 Ticket 的 `ready`/“待父审阅”不计入人的 attention**：它是父 owner 的工作队列；只有父 owner 不可用并升级到人时才计一次。lightweight 没有 review/answer/delivery，也没有子 Ticket，默认 `attention = false`。所以根状态为 `working` 但子 Ticket 失败时，`attention` 仍为 true；已结束 Ticket（含 closed/stopped 结束态）一律 `attention = false`，不能把已结束工作算进“需处理”。

### 6.4 API（提案）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `tasks` | 任务页/右栏共用投影；只返回**根 Ticket** 与 `childSummary`，不返回子 Ticket 数组；支持 `?category=`、`?status=`、`?source=`、`?q=` |
| `GET` | `tasks/:ticketId` | 任务详情：来源、`children`（默认一层）、执行单元、去重交付、`TaskReviewView`、最近事件；根或子 Ticket 都可查；子 Ticket 返回 `parentTicketId`/`rootTicketId`/`delegation` |
| `GET` | `tasks/:ticketId?depth=2` | 子 Ticket 展开深度；默认 1 层，最多 5 层；不改变投影的“只根列表” |
| `GET` | `tickets/:id` | 现有工单详情；根与子 Ticket 都可读，但子 Ticket 的响应必须标明 `rootTicketId`，不得暴露为可独立结束/审批的工单 |
| `POST` | `tickets/:id/approve` | **只对根 Ticket**；body 必须带 `{reviewRevision}`，过期/未结束子 Ticket/确认缺失/子 Ticket 都拒绝。子 Ticket 的批准只由父 owner 的 `accept_child` 完成，且不等于人确认 |
| `POST` | `task-categories` | 新建类别 |
| `POST` | `task-categories/suggestions/:id/accept` | 采用建议：只写仍无人工 placement 的根 Ticket；有人工冲突返回 409，不覆盖 |
| `DELETE` | `task-categories/suggestions/:id` | 忽略建议：写 `state=dismissed`/`dismissedAt`，不删除记录 |
| `PATCH` | `task-categories/:id` | 改名/目标/排序/归档 |
| `POST` | `task-categories/:id/merge` | 合并到目标类别 |
| `POST` | `task-categories/:id/split` | 拆出新类别 |
| `PATCH` | `tasks/:ticketId/placement` | 人工移动根 Ticket；子 Ticket 返回 400（跟随根） |
| `DELETE` | `tasks/:ticketId/placement` | 恢复自动归纳 |
| `POST` | `tasks/reclassify` | 批量重跑（未归类/全部根 Ticket） |

**委派不是 HTTP 写接口**：子 Ticket 只能由 worker 工具 `delegate_ticket` 请求 Engine 创建；面板/API 没有“新建子 Ticket”入口，防止人绕过父 owner 审查与根授权。父 owner 的 `accept_child`/`return_child`/`cancel_child` 同样是 worker 工具（或经 Engine 的内部命令），不是任务视图的写 API。

所有类别写接口必须带当前 `TaskCatalogue.revision` 作为 `baseRevision`；返回新 revision。错误沿用现有 `UserError` 风格，面板本地化。建议接受还要在服务端重查每个 `ticketIds` 的 placement：任一已是 `manual` 就返回 `409 { code:'manualPlacementConflict', ticketIds }`，不写类别、不改建议状态，避免“采用建议覆盖后来的人工移动”。

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
- **子 Ticket 的事件聚合到根 Ticket**：`ActivityRecord.subject` 仍用 `kind:'ticket'`，子 Ticket 的事件带 `parentTicketId`/`rootTicketId`（详情/过滤器用），任务视图按根分组、子行可下钻；不增加人的未读数，不为每个子 Ticket 发 notice。`ActivityRecord.subject.kind` 不新增 `subtask`，避免第二个实体。
- **子报告进入父的输入**：`TicketInput` 增加 `child-report` 变体；它不是 Trigger、不经过 Eval、不创建 Ticket、不产生人的注意力请求。父 owner 的判断写 `ChildReportDisposition`（canonical）与 `Delegation.resolution`/`merge`；不另存 `report.accepted`，避免两份接受记录漂移。
- **trace 留痕**：子 trace 记录自己的 `report`/`ended`；父 trace 记录 `delegation.report`、`delegation.review`、`delegation.delegate`、`delegation.self-work`、`delegation.report-up`，带 `childReportId`、`attempt`、`artifact.key`/`reviewRevision`（有交付时）。子/父 trace 用 `parentTraceId` 关联，见 4.6.3。
- **Approval/outbox 的根归属**：只有根 Ticket 有 Approval/outbox；子发起的对外动作记录 `requestedForTicketId`/`originTicketId` 指向子 Ticket，但 `ticketId` 必须是根。父 owner 的接受不是 Approval；人只批准根聚合。
- **DomainEvent 加法**：可新增 `ticket.delegated`、`ticket.child.reported`、`ticket.child.reviewed` 三个事件（或复用 `ticket.created`/`ticket.ended` 并在 detail 带 `parentTicketId`），供 activity 与审计读取；旧客户端忽略陌生事件。无论用哪种，子 Ticket 的创建/结束不再伪造第二次“受理”。

```ts
// 加在 TicketInput 的 closed union 里；不是 Trigger，不经过 Eval
| { id: string; kind: 'child-report'; childTicketId: string; attempt: number; assignmentId: string
    reportAt: string; state: ReportState; summary: string; review?: Review; at: string }
| { id: string; kind: 'end-gate'; pending: PendingEnd }
```

- **唤醒规则**：子报告或 `end-gate` 入队后，Engine 立即尝试启动/恢复父 owner 的 Assignment（即使父刚才报告 `waiting`/空闲），不经过 Eval、不创建 Ticket；同一子 Ticket 最多一条待处理报告，后续报告合并/替换，避免父被刷屏。`end-gate` 与 `child-report` 可同批投递，父按“先处理子 Ticket、再应用 pending end”的顺序消费。父 Ticket/父 owner 已不可恢复时，报告不投递，子 Ticket 转 `orphaned` 并升级一次；`end-gate` 则转成一次 attention。
- 这是 `TicketInput` 的加法变体；现有 `trigger`/`text`/`note`/`binding` 等路径不变，旧客户端忽略陌生 kind。
- 如果后续需要“类别变更也出现在事件流”，再把 `task.category.*` 加为 `DomainEvent`，并给 `ActivityRecord.subject` 增加 `category` 类型；这是加法，旧记录不受影响。

### 6.6 最终审查聚合（子 Ticket 确认进入根 Ticket）

`Assignment.report.review` 仍然只描述**一次** Assignment 的交付；任务树需要的是 **根 Ticket 级聚合**。增加 kernel 级只读聚合 `ReviewAggregate`（app 的 `TaskReviewView` 是它的序列化；不是新存储，不改变现有 `Review` 契约）：

1. **收集**：根 Ticket 最新 Assignment report 的 `review` + 每个**已被其父 owner 接受**的子 Ticket（含更深子 Ticket，递归）的最新 `Assignment.report.review`。接受条件：`Delegation.resolution.kind='accepted'` 且 `acceptedReportAt === report.at` 且 `acceptedAttempt === attempt`。`return_child`（清空 resolution）/`cancelled`/`failed` 不进入聚合；接受前的新报告使旧 accepted 失效，接受后的迟到报告被拒绝。
2. **交付去重**：按 `DeliverableSummary.key = artifact.kind:artifact.ref:artifact.revision` 合并；同一 revision 的根/子交付只保留一行，`sources` 记录 `{kind:'ticket', ticketId, assignmentId}`。这样“父合并后最终交付只出现一次”有可执行键，不靠 UI 去重。
3. **确认聚合**：每个来源的 `Review.confirmations` 保留为 `ReviewConfirmationView`，`ref` 用稳定下标（`ticket:<ticketId>:<assignmentId>:<i>`），并带 `source`/`criterion`；人能看到每条确认来自哪个子交付。投影不把 `HumanCriterion` 改写成父 owner 的声明。
4. **评审指纹**：`reviewRevision = sha256` over 排序后的 `(ticketId, assignmentId, attempt, report.at, artifact.key, criteria, confirmations)`。任何子报告、根报告或验收条件变化都会换 revision。
5. **最终批准**：`POST tickets/:id/approve` **只接受根 Ticket**，且必须带 `{reviewRevision}`；`Assignments.review` 重新计算 `ReviewAggregate`：
   - 目标不是根 Ticket → `notAuthorizationRoot`，不写批准；
   - `reviewRevision` 不匹配 → `409 reviewStale`，不写批准；
   - 仍有未结束子 Ticket → `unfinishedChildTickets`；
   - 聚合里任一 `HumanCriterion` 没有来源/不在当前 revision → 拒绝；聚合中的每条确认都由批准整体覆盖；
   - 通过后写 `Assignment.report.accepted = {by,at,reviewRevision}`；`TaskReviewView.accepted` 只是这个字段的序列化，不另存。
   `Tickets.end` 对 `outcome` 为 `completed`/`merged`/`closed` 且聚合里有 `confirmations` 的结束也必须要求 `Assignment.report.accepted.reviewRevision` 等于当前 revision；`dropped`/人停止可以不走批准，但不能把未确认的交付标成“已验收”。**批准后的结束顺序**：有 `endPending` → 应用 pending；否则 `followsDone(ticket)` 已成立（PR/线程在 ready 前就关闭）→ 用它的 `outcome`（`merged`/`closed`）结束；否则没有 follows → `completed`；还有 open follows → 等待关闭。这样“PR 先合并、后补最终确认”不会挂死，也不会丢掉 merged。
6. **父子责任**：`accept_child` 只写 `Delegation.resolution.kind='accepted'` 与 `merge`，**不写**人的确认；父 owner 的接受不能替代 `Assignments.review`。只有最终根 Ticket 的聚合批准才把 `humanAccepted` 填到对应交付行。子 Ticket 不能单独调用 approve；子交付的人确认只在根聚合出现。
7. **无交付的 Ticket**：`ReviewAggregate` 为空；仍可结束，但不能声称“已验收”；UI 显示“无交付”。
8. **lightweight**：没有 `Assignment.report.review`/子 Ticket，不产生 `TaskReviewView`；`TaskView.review` 缺省，人工不能批准一个不存在的 review。

**实现边界（当前 vs 本提案）**：以上 `ReviewAggregate`、`reviewRevision` 与带 revision 的 `POST tickets/:id/approve` 都是**提案**。当前 `reviewTicket`/`Assignments.review` 只接受最新 Report 的 review，没有 revision 参数，也不会返回 `409 reviewStale`；`POST tickets/:id/approve` 只对 review-stage、带 preview 的 Report 记录接受者/时间，不结束 Ticket，后续 Report 会覆盖它。实现 6.6 之前，现有验收路径不变；设计原则（PR #30）里「按 revision 确认」也只能在 6.6 落地后成立，不能当作当前不变量。

UI：根 Ticket 详情的“交付与审查”区块读 `TaskReviewView`，不再只读 `ticket.review` 的最新 Assignment；`TaskView.review` 是详情字段，列表只显示去重后的 `deliverables` 摘要。子 Ticket 详情显示自己的交付与“已进入根 review 的确认”，并明确“父 owner 已接受 ≠ 人已确认”。`GET tickets/:id` 的 review 视图同步改为聚合，避免两套验收口径。

测试：子 Ticket 有 `HumanCriterion` → 父 `accept_child` 后仍出现在根 `TaskReviewView`；人批准的 `reviewRevision` 覆盖该条；接受前子 Ticket 新报告使旧 revision 失效，必须重新批准；接受后报告被拒绝；根/子同一 artifact/revision 只出现一行；未结束子 Ticket 不能批准根；根/子 Ticket 都不能通过 `accept_child` 清掉人的确认；子 Ticket 直接调用 approve 必须被拒绝。

## 7. UI 形态与状态

### 7.1 两个面，一个投影

| 面 | 定位 | 内容 |
| --- | --- | --- |
| 右侧栏“任务”tab | 监督时随手看，和事件并列 | 紧凑列表/紧凑树、一级子 Ticket、筛选、选中详情、与事件互相定位 |
| 状态页“任务” | 完整管理 | 列表/树/看板/图、类别管理、根/子 Ticket 详情、批量操作 |

两者都读 `GET tasks`；右栏不另建接口，状态页也不另算归属。

> **展示边界（对齐设计原则 PR #30 的 E0–E3）**：任务视图属于 **E1**。默认行与详情显示目标、owner 角色、状态、交付、阻塞与来源，不显示 `worker-` 或 Session id；原始 id、Assignment/subagent 细节与 trace 只在折叠的“技术详情/执行细节”（E2）出现。E0 仍只给目标、状态、需决定与结果。该边界也符合 `docs/005` 的原则 4（内部标识只出现在折叠详情）。

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
│    └ 资料解析（子 Ticket）        完成     子 owner   │
│    └ 底稿核算（子 Ticket）        待父审阅  子 owner   │
│  ● 恒润制造 2025 涉税风险体检   需我处理            │
│    …                                              │
│ 业务拓展                                             │
│  ● 某税局智能问答系统投标       进行中  …            │
├──────────────────────────────────────────────────┤
│ 未归类                            1 个任务           │
│  ● 等固定资产清单到位后补进底稿  来自邮件            │
└──────────────────────────────────────────────────┘
```

- **默认列表**，不默认树：窄栏里树的缩进与连线会吃掉宽度；点根 Ticket 行按需取一级子 Ticket，再点“展开执行”看 Assignment/subagent。
- **类别分组头**只在有类别时出现；“未归类”永远在最后，不隐藏。
- **建议区**：未归类上方显示“类别建议：客户服务（3 个任务）[采用] [忽略]”；建议不占类别上限，采用后才进入类别列表。
- **任务行**：状态点 + 标题 + 状态词 + 来源 chip（最多 3 个，超出显示 `+N`）+ 进度/交付摘要 + 最近事件时间。根行显示“根 owner”；子 Ticket 行显示“子 Ticket owner”，展开区再显示“父 owner”。不挤来源 chip，也不显示 worker/Session id。lightweight 行加“轻量”badge，不显示 owner/Session，也没有展开箭头。
- **展开区**：仅 tracked 节点有；子 Ticket 行（标题、状态、owner 角色、最近报告、父 owner 审阅状态）、父 owner 的交付审查/合并摘要、最近 3 条事件、“打开任务页”。子 Ticket 行再展开“技术细节”（E2）时才显示 `workerSessionId`/subagent/Assignment。lightweight 的详情是 action ledger + summary，不伪装成“待验收”。
- **选中与联动**：`TaskSelection = { kind: 'ticket'; id: string }`。**所有节点都是 Ticket，不再有 `kind:'subtask'` 的选中类型。** 选中根 Ticket 后切到“事件”tab，事件列表筛到该根 Ticket（子 Ticket 事件按根聚合）；选中子 Ticket 时同样筛到根 Ticket，并在任务 tab 展开该子 Ticket。在事件里点某条记录，切回“任务”tab 并定位对应根/子 Ticket。两 tab 共享这个轻量状态（Session 内，不写库）。注意：现有 `EventsTab` 只有 all/attention/running/failed 筛选，**没有按任务筛选**；第 1 期要给事件分组加一个 `task` 维度，否则联动落不了地。
- **未读/需处理**：tab 标题显示需处理任务数（根 Ticket 的 review/answer/delivery/blocked/failed，加上子 Ticket 的 failed/orphaned/blocked 且父 owner 不可用），与事件未读数分开；“待父 owner 审阅”不计入人的数字。这样窄栏不会把父 owner 的工作队列误报成人的待办。
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
    └ 资料解析（子 Ticket）  完成      子 owner  父已接受
    └ 底稿核算（子 Ticket）  待父审阅  子 owner  2/3
        └ 固定资产底稿（子 Ticket） 进行中  子 owner  执行细节
  恒润制造 2025 涉税风险体检  需我处理  …
未归类
  …
```

- **列表**：默认。一行一个根 Ticket（tracked 或 lightweight），类别分组行可折叠；tracked 根 Ticket 行展开一级子 Ticket，子 Ticket 行再展开执行细节；lightweight 行无展开。列表默认不把子 Ticket 平铺成顶层，避免类别计数与“任务总数”被撑大。
- **树**：类别 → 根 Ticket → 子 Ticket → 更深子 Ticket；默认展开到 L3，L4+ 折叠；执行单元/交付物在节点详情，不占层级。`TaskView.children` 递归，UI 不维护第二套 Subtask 类型。
- **看板**：列 = 状态（需我处理 / 进行中 / 等待 / 已完成 / 失败；9 个 `ActivityStatus` 到 5 列的映射在第 4 期定），泳道 = 类别；卡片 = 根 Ticket。卡片显示子 Ticket 完成数与父 owner 的审阅/合并状态（lightweight 卡片只显示 inline 摘要，不显示待验收/子 Ticket）；点卡片展开子 Ticket，不默认把每个子 Ticket 画成独立卡片。拖拽**只发生在类别泳道之间（纵向）**，横向状态列只读；试图横向拖时提示“状态由执行决定”，不允许绕过授权与结束条件。
- **时间线**：沿用现有“每个类别一条时间轴、每个任务一条泳道”的画法；Ticket 泳道内显示子 Ticket 条与父 owner 的合并点，表达父子并行与汇合；没有依赖数据就不画依赖箭头。现有 `graphOf` 可按类别复用，但要把“里程碑”换成“类别”。
- **类别管理**：分组行内联改名；多选根 Ticket 后“移动到/合并到”；类别菜单“拆分/归档/恢复自动”；“已归档”开关显示归档类别与其任务。最近一次编辑可撤销。
- **审查 Ticket 行**：`kind='review'` 的任务用“审查”标签，按 `reviewedTicketId` 缩进到被审 Ticket 下；被审 Ticket 不在当前类别时单独成行。类别计数把 review Ticket 计入 `tasks`，并另显示 `counts.reviews`；不要把审查关系塞进 `progress` 数字。审查 Ticket 是根 Ticket，不是子 Ticket。
- **结束原因**：根/子 Ticket 的 dropped 行显示“已放弃”（done+terminal），stopped 行显示“已停止”（failed+terminal）；子 Ticket 的 cancelled 由 `Delegation.resolution.kind='cancelled'` 显示“父已取消”，仍用 done/失败 + terminal 表达状态，不显示成 idle/进行中。`pendingEnd` 行显示“PR 已合并，N 个子 Ticket 待处置”。
- **建议**：未归类/批量归纳产生建议时，显示在“建议”区；采用后建类并写入归属，忽略则 30 天内不再提示。
- **任务详情**：可由现有工单页扩展，也可新开 `?task=` 路由；建议先扩展工单页（见 7.4），避免第二套详情。

### 7.4 任务详情

顶层任务 = 根 Ticket；子 Ticket 详情复用同一套组件，但**只读、隐藏 Mandate/来源锚点**，显示根授权引用、父目标、子 goal/scope、自己的 owner、父 owner 与父审阅状态。详情不是新数据源，而是把现有工单页重组为“任务面”：

| 区块 | 内容 | 现有来源 |
| --- | --- | --- |
| 头 | 标题、form（tracked/轻量）、类别（仅根 Ticket 可改）、状态、来源（子 Ticket 显示根来源）、耗时 | `GET tickets/:id` / `GET tasks/:id` + `form` + 类别 |
| 目标与来路 | 根 Ticket 显示 Mandate scope、origin Trigger 摘要、计划标签；子 Ticket 显示根 Mandate 引用、父目标、子 `delegation.goal`/`scope`、委派原因与 attempt | 现有 + `Delegation` |
| 子 Ticket | 仅 tracked：直接子 Ticket 列表（标题、状态、owner 角色、交付摘要、最近报告、父审阅处置）；父节点显示“审阅/合并”进度；停止父任务/重试仍走根工单页；子 Ticket 由父 owner 退回/取消/接受。lightweight 无此区块 | `TaskView.children` / `delegation` |
| 谁在执行 | tracked：显示根 owner / 当前节点 owner / 父 owner / 子会话（subagent）的**角色标签**；`workerSessionId` 只在“技术详情”（E2）显示；lightweight：显示 inline 执行与 action ledger，不显示 owner/Assignment；不编造“执行 Agent”名字 | `workerSessionId`、assignments、inline action |
| 来源锚点 | 根 Ticket 的 Channels/Threads、PR/Issue/群/对话线程、关闭状态、最近事件；子 Ticket 继承根来源，不单独建锚点 | `threads` |
| 产出与交付 | tracked：每个节点从自己的 `report.review` 汇总 artifact/revision/preview/验收条件/批准状态；根 Ticket 详情用 6.6 `TaskReviewView` 展示根 + 已接受子 Ticket 的去重交付与确认来源，人按 `reviewRevision` 一次批准。子 Ticket 交付先由父 owner 审查；子详情显示“父 owner 已接受 ≠ 人已确认” | `latestReport` / `report.review`（根/子）+ `TaskReviewView`；lightweight 用 inline action |
| 父审阅/合并 | 子 Ticket 的报告与 `ChildReportDisposition` 历史（报告、判断、再委派/自干、上报）、`Delegation.merge`（子 revision、冲突、`merged`/`escalated`）、冲突处理；只有父 owner 能推进；父 owner 不能替人确认 | `Delegation` + 活动/trace |
| 事件 | 该 Ticket 最近事件（子 Ticket 事件按根聚合，可下钻），可跳事件 tab | activity |
| 工作目录 | 现有工单页展示的执行目录；子 Ticket 显示自己的受限期目录/工作树 | `Execution.directory`（现有） |
| 操作 | 根：打开工单、打开会话、打开 PR、改名/移动类别；停止/重试/验收仍走原按钮。子 Ticket：只读检查、看报告/交付/父处置；没有人可以直接“批准子 Ticket”或绕过父 owner；需要人工干预时经根 attention。lightweight：无会话/重试/验收按钮，只可发起 tracked follow-up | 现有 + form |

任务级“目标”先用根 Ticket 的 `Mandate.scope` 与 origin 文本表达；子 Ticket 有 `Delegation.goal`（父 owner 写），但这不是新的授权字段。如果后续用户确实需要给根 Ticket 加一句话目标，再在覆盖层加（不改 `Ticket`）。

**会话要分五类，不能只给一个“Session”按钮**：

- 来源会话：根 Ticket 从哪段对话/线程来（对话 Source 的主会话或 Thread），回答“当初是谁在哪说的”；
- 根 owner：`worker-<rootTicketId>`，回答“谁对最终目标负责”；
- 当前节点 owner：根节点就是根 owner；子 Ticket 是 `worker-<childTicketId>`，回答“这个子 Ticket 谁负责”；
- 父 owner：子 Ticket 的上报/审阅对象，回答“子完成后向谁报告”；它不是执行者；
- 子会话：节点 worker 开的 subagent，回答“节点里拆出去的哪一步是谁在做”。
- lightweight：没有以上五类 owner/session；只显示 inline run 的 step/action ledger，不伪造会话。

任务详情分别给入口；任务行只显示 **owner 角色**，根 owner/父 owner/来源会话入口放在展开区/详情；`worker-` 内部 id 只在折叠的“技术详情”（E2）出现，避免窄栏堆按钮、也避免把内部标识当默认信息。

### 7.5 三视图的分工

| 视图 | 回答什么问题 | 适合宽度 | 第一期 |
| --- | --- | --- | --- |
| 列表 | 有哪些任务、谁需要我处理 | 右栏 + 全页 | 是（第 1 期根 Ticket，第 2 期子 Ticket） |
| 树 | 一个类别下任务怎么拆、子 Ticket 与父/子 owner 是什么关系 | 全页（右栏只做紧凑展开） | 第 2 期（根 Ticket 树第 1 期） |
| 看板 | 各类任务堆在哪个状态、哪里堵住 | 全页 | 第 4 期 |
| 时间线 | 父子任务什么时候并行、什么时候汇合/合并 | 全页 | 第 2 期起（复用现有图，加子 Ticket 条） |

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
| 子 Ticket 未结束 | 父 Ticket 状态按“有未结束子 Ticket”投影为 `working`/`blocked`，不显示 `idle`；父行显示“N 个子 Ticket 未结束”；父任务不能显示“已完成” |
| 子 Ticket 待父审阅 | 子行显示“待父 owner 审阅”，父行不死锁；父 owner 的报告/判断在展开区可见，不计入人的“需处理” |
| 子 Ticket 失败/阻塞 | 子行标失败/阻塞；父行显示“待父 owner 处理”，不自动把父任务标失败 |
| 子 Ticket 等待父/审批 | 子行显示“等待父/审批”；父行按 6.3 投影为 working/blocked，不把等待算成 idle |
| 子 Ticket 孤儿 | 父/根不可用：子行标 `orphaned`，父行提示“需要最近在世祖先/人决定重试/取消”，不静默重跑 |
| 父 owner 缺位 | 父 Ticket live 但 owner 不可恢复：子行显示“等待父恢复”，根行提示“父 owner 缺位”；升级后显示一次人的决定入口 |
| PR/线程已关闭、子 Ticket 未结束 | 父行显示“PR 已合并/已关闭，N 个子 Ticket 待处置”（`pendingEnd`），不显示完成，也不丢弃 pending |
| 轻量任务 | 行标“轻量”，无展开、无 owner/交付/审批；详情显示 action ledger + summary；需要保留/审批/外部写时提示发起 tracked 任务 |
| 父任务停止 | 子树全部显示“已取消/已停止”，禁用子 Ticket 写操作 |
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

| # | 差距 | 现状 | 要做 | 风险 |
| --- | --- | --- | --- | --- |
| 1 | 任务层级 | 只有计划树/工单，没有持久化父子 | `Ticket.parentTicketId`/`rootTicketId`/`delegation`；根/子 union；创建后不可改父 | 旧代码把子 Ticket 当根；必须用根过滤与访问器 |
| 2 | 授权边界 | Ticket 自身有 Mandate/Decision；没有“子 Ticket 无授权”的路径 | 根/子类型分离；动作闸门/Approval/outbox 解析根；`rootMandate()`；子 Ticket 禁止 approve/外发/提级 | 误把子 Ticket 的字段当授权；独立 review 专门核对不变量 |
| 3 | 委派 | 只有 subagent；没有 `delegate_ticket` | 工具 + Engine 校验（父/根存活、同 root、maxActionLevel、深度/宽度/配额、无环）；创建子 Ticket/worker | worker 直接写表；深度/配额绕过；child 创建根 |
| 4 | 子 Ticket owner/worker | 只有 `worker-<ticketId>` 与 `subtask-` 两种设想 | 统一用 `worker-<ticketId>`（根/子同规则），去掉 `subtask-` 前缀/注册表；子 owner 受限执行配置 | 旧 attempt 事件写错节点；会话目录/工具越权 |
| 5 | 父 owner 审阅 | 没有父 owner 输入/判断/上报 | `child-report` input、`ChildReportDisposition`、`accept/return/cancel` 工具、唤醒规则、逐层上报 | 父被刷屏；报告丢失；父接受冒充人确认 |
| 6 | 结束门 | `Tickets.end` 只处理单 Ticket；没有子 Ticket/unresolved 概念 | 所有结束路径过同一道门；`unfinishedChildTickets`；`endPending`；级联停止；失败/孤儿/重启/迟到 attempt | 只挡 `ready`；PR 合并挂死；迟到报告推进父 |
| 7 | 交付聚合 | 只有单 Assignment `report.review` | `ReviewAggregate` + `reviewRevision` + 根 approve；去重键；确认来源；子 Ticket 确认进入根 | 两套验收口径；父接受覆盖人确认；revision 过期 |
| 8 | 存储/索引 | `ticket(id,value)`；无父子查询 | schema 15 生成列 `parent/root` + 索引；`childrenOf`/`subtree`/`allActive`；根过滤；不建 subtask 表 | 全表扫描；旧二进制误读；回滚删数据 |
| 9 | 类别覆盖层 | 只有计划树；没有 category/placement | `TaskCatalogue` KV + 服务 + 迁移/回退；只归类根 Ticket | 文档损坏；人工覆盖冲突；子 Ticket 计数污染 |
| 10 | 投影 | `tasks.ts` 只做计划树/工单节点 | 类别/根/子/owner/worker/childSummary/delegation/pendingEnd；父状态感知子 Ticket；attention 只计人 | 子 Ticket 撑大类别计数；待父审阅误报人的 attention |
| 11 | UI | 计划树为主 | 右栏任务 tab、列表/树/看板/时间线、详情区块、父审阅/上报可见、空态/错误态 | 窄栏不可读；E2 id 泄漏；父审阅不可见 |
| 12 | API | 无类别/placement/children 读接口 | `GET tasks` 根 + `GET tasks/:id` children；`POST approve` 根 + revision；类别写接口；委派不走 HTTP | 旧客户端忽略字段；子 Ticket 被直接 approve |
| 13 | 事件/审计 | activity 只按 Ticket；没有子报告 | 子事件聚合根；`child-report` input；trace/disposition；Approval/outbox 根归属 | 通知刷屏；审计缺口；子动作无法追到根 |
| 14 | 测试 | 无子 Ticket / delegation / 父审阅 | `tests/delegation.spec.ts`、`tests/tasks-view.spec.ts`、`tests/review-aggregate.spec.ts`、查询/权限/迁移测试；独立 review 核对授权不变量 | 覆盖缺口会让“授权根唯一”只停在文档 |

实现顺序建议：先做 schema 15 + 类型/访问器 + 根过滤（1/2/8），再做委派与子 owner（3/4），然后父审阅链（5），最后结束门/交付聚合（6/7）；视图（10/11/12）在 4.6 稳定后接。类别覆盖层可以与第 2 期并行，但不应阻塞子 Ticket 运行时。

## 9. 分阶段落地

### 第 0 期：lightweight 运行时前置（仅在产品要支持轻量时）

这不是任务视图本身的工期，而是第 1 期里 lightweight 行能否验收的前置条件：

- 生产 `InlineExecutor` 实现并注入 `assembly.ts`；`Tickets.startInline`/`wake` 能在生产装配下运行；
- Eval/assessor 显式选择 `form`，`prepareTicket` 执行 3.5.1 的约束（review/workspace/子 Ticket/外部写必须 tracked）；
- 没有生产 `inline` 时，accept 不得选择 lightweight；启动时缺 `inline` 必须拒绝，而不是静默创建无执行器的 Ticket；
- 重启恢复策略明确：当前 lightweight 不做恢复；升级只走新 Thread/对话（3.5.3）。

**Phase 0 未完成前，第 1 期只验收 tracked；lightweight 行只做前向兼容渲染，不声称产品已能受理。** 这避免把 kernel-only 状态伪装成运行时事实。

### 第 1 期：右栏只读任务视图（先让用户看见）

- 注册右侧栏“任务”tab；列表/紧凑展开；共享 `GET tasks`。
- 任务行显示来源、最近事件、最近一次交付摘要（`report.review`）和 form badge；tracked 显示根 owner，lightweight 显示“轻量”，不显示 owner/交付。任务详情链接到工单页。
- 保留现有计划树作为状态页的回退视图；不做类别、不做子 Ticket、不做编辑。
- 验收：右栏能在 360px 下看清任务与状态；切到事件 tab 能按任务筛选；两处状态一致；无新增写路径。

### 第 2 期：子 Ticket 树 + 每节点 owner/worker + 父 owner 审查与结束门

这是本轮评论要求的核心，单独一期，不能塞进“不改 schema”的第 1 期。

**2a 运行时**

- **存储**：schema 15 只加 `ticket.parent`/`ticket.root` 生成列与索引，**不建 `subtask` 表**；`Ticket` 的 JSON 加 `parentTicketId`/`rootTicketId`/`delegation`；旧行读作根；根过滤默认进入 `tickets.list/open/active()`。
- **类型/访问器**：`RootTicket`/`ChildTicket` union；根才有 `mandate`/`decisionId`；`rootTicket()`/`rootMandate()` 统一解析；子 Ticket 的 `origin` 复制根 Trigger 以保持 trace 连续，不产生新 Decision。`parentTicketId` 创建后不可改；拒绝自引用/祖先环。
- **委派**：`delegate_ticket`（只对 Ticket owner 开放）：Engine 校验父/根 Ticket 存活、父 owner 在运行、同一 `rootTicketId`、根 Mandate/`maxActionLevel` 原样继承、深度 ≤5、单节点 ≤8、单根活跃子 Ticket ≤32；创建子 Ticket + `worker-<childTicketId>`。子 owner 只能请求同根的下级子 Ticket，不能创建授权根 Ticket/Eval，不能直接写表。
- **子 owner**：普通 `worker-<ticketId>`，不引入 `subtask-<id>-<attempt>` 前缀/注册表；`ticketOfSession`/`decorate`/`ticketOf` 复用；子 owner 只用受限执行配置（网络关闭、无 git remote/gh、`bash` 命令策略、cwd jail、无 `subagent`、无 delegation 到根）；不注册直接找人/commit/send/spend/merge/审批工具。做不到就明确降级为父审阅提示，不声称“子不能外部动作”。
- **父 owner 审阅链**：子报告进入父 `TicketInput.kind='child-report'`；父在 `waiting`/空闲时被唤醒（不经过 Eval、不创建 Ticket、不产生人的注意力请求）；父 owner 用 `accept_child`/`return_child`/`cancel_child` 写 `ChildReportDisposition` 与 `Delegation.resolution`/`merge`；`accept_child` 结束子 Ticket 并终止子 worker，父继续向自己的上级报告。每步写 trace（`delegation.report/review/delegate/self-work/report-up`）。
- **结束门**：`ready`/`dropped`/人停止/`follows` PR 合并都经过 `Tickets.end`，不能只挡 `ready`；`ready` 有未结束子 Ticket 时拒绝（`unfinishedChildTickets`）且不写报告；`Assignments.review`/`reviewTicket` 也复查。PR/线程关闭有未结束子 Ticket 时写 `endPending` + `end-gate`，父处置后应用；父不可恢复时一次 attention，不永久挂起。
- **级联与恢复**：人停止根/父取消子 Ticket 级联停止子树；父 `failed` 不是终态，子 Ticket 保持工作/只读，父可重试；父结束/记录缺失时子 Ticket 取消或 orphaned；重启先父后子，父可用后子恢复，只有父记录缺失/已结束才 `orphaned`；迟到 attempt 被拒。
- **活动/审计**：子 Ticket 事件按根聚合；`ActivityRecord.subject` 不新增 `subtask` kind；Approval/outbox 的 `ticketId` 必须是根，新增 `requestedForTicketId`/`originTicketId` 记录子来源；父接受不写人的确认。

**2b 视图**

- 列表/树显示根 Ticket → 子 Ticket（默认一层，更深折叠）；子 Ticket 行显示 owner 角色、状态、待父审阅/父处置、交付摘要，不显示内部 worker/Session id；根详情用 6.6 `TaskReviewView`，显示子确认来源与 `reviewRevision`。lightweight 是叶子，不显示子 Ticket。
- 父节点详情显示子 Ticket、父 owner 的报告/判断/再委派/自干/上报记录；子节点详情复用组件，隐藏 Mandate/来源锚点，显示根授权引用与父 owner。
- 右栏只显示一层子 Ticket；完整树进状态页；选中统一为 `{kind:'ticket', id}`，没有 subtask 选中类型。
- 验收：父 owner 能创建 2 个子 Ticket，各有自己的 owner/worker；子报告回到父 owner，父能接受/退回/自干/再委派并逐层上报；有未结束子 Ticket 时父不能 `ready`；停止父级联停止子；重启后子状态不丢；超过深度/宽度/配额返回明确错误；不产生独立根 Ticket。

### 第 3 期：类别归纳（只读）

- 新增 `TaskCatalogue` KV 与 `TaskCategorizer`；新根 Ticket 异步归类；历史根 Ticket 可手动触发批量归纳。
- 任务页/右栏按类别分组；“未归类”常显；类别上限与归档；类别建议只读展示（不自动建类）。
- 子 Ticket 继承根类别，不单独分类、不计入类别任务数。
- 保留“按计划查看”开关。
- 验收：类别可解释（有 reason）；未归类不隐藏；模型失败不影响任务；事件分组与任务分组不矛盾；类别计数只算根 Ticket（tracked 与 lightweight 都算）。

### 第 4 期：人工编辑、执行细节、交付详情、看板

- 类别改名、改目标、排序、移动、合并、拆分、归档/恢复、恢复自动；采用/忽略类别建议。
- tracked 节点详情展示 Assignment / worker Session / subagent；交付物详情展示 artifact/revision/验收状态/批准历史。lightweight 详情展示 inline action ledger/summary，不显示这些。
- 看板（状态列 × 类别泳道，卡片 = 根 Ticket，显示子 Ticket 进度）；时间线加子 Ticket 条与父合并点。
- 验收：人工修改不被 Agent 覆盖；刷新/重启后保持；合并/拆分后任务不丢；冲突提示可恢复；看板不改变任务状态；交付物空态不误导。

### 第 5 期：硬化

- 性能：单次投影、无 N+1、右栏轮询与 SSE 协调；bundle budget；子 Ticket 树懒加载；根过滤索引。
- 可访问性、深浅主题、窄屏；键盘与读屏。
- 迁移/回滚演练（schema 15、旧二进制拒绝、down migration/备份）；日志与指标（归纳成功率、人工纠正率、未归类比例、子 Ticket 深度/失败率、父审阅时长、孤儿子 Ticket 数、每结果通知数）。
- 复核授权不变量：子 Ticket 没有 Mandate/Decision、不能成为 Approval/outbox 主体、不能创建授权根；把这项写成 CI 测试 + 独立 review 检查点，不只依赖文档。

### 9.1 可测的验收指标

- **360px 右栏**：无横向滚动；标题最多 2 行；状态、来源、最近事件在首屏可见；展开/折叠点击目标 ≥28px。
- **投影性能**：500 个根 Ticket、2000 个子 Ticket 时，`GET tasks`（只根 + `childSummary`）本地 p95 ≤300ms；单次请求 SQL 查询数 ≤10（测试里计数，禁止按根循环查询子）；展开一个根的一层子 Ticket ≤200ms、SQL ≤12；右栏任务 chunk gzip 增量 ≤20KB（`check:size`）。
- **联动**：选中根/子 Ticket 后事件 tab 只显示该根聚合的事件；返回任务 tab 后选中不丢；刷新后选中可丢，但状态一致。
- **人工优先**：人工改过的根 Ticket 重跑分类器/重启后不被移走；`baseRevision` 过期返回 409，刷新后可重试。
- **建议**：单个根 Ticket 不会产生新类别；同一候选累计 2 个根 Ticket 才出现“采用”按钮；采用后类别与归属同时写入；任意支持 Ticket 已有人工 placement 时整次 409，不部分写入。
- **归档**：归档类别默认隐藏；打开“已归档”仍能看到其任务；任务不会静默进“未归类”。
- **回滚（类别）**：关闭 `taskView.categories` 后刷新回到旧计划树；重新打开后类别/归属仍在；读取失败不覆盖文档。
- **回滚（子 Ticket）**：schema 15 是前向迁移，旧二进制不能打开；验证 down migration 或备份恢复后，子 Ticket 行/父链一致，无孤儿继续写；`taskView.childTickets` 关闭只停止新委派/隐藏子树，不降 schema。
- **交付物**：有 `report.review` 的根/子 Ticket，详情首屏直接显示 artifact/revision/验收状态；没有时显示“暂无交付”，不显示空卡片。
- **最终审查聚合**：根 + 已接受子 Ticket 的交付按 `artifact.kind:ref:revision` 去重；子 Ticket 有 `HumanCriterion` 时，父 `accept_child` 后仍出现在根 `TaskReviewView`，人必须按当前 `reviewRevision` 批准；接受前子 Ticket 新报告使旧 revision 失效（`409 reviewStale`），旧批准不能复用；接受后报告被拒绝。
- **审查关系**：`kind='review'` 的根 Ticket 带 `reviewedTicketId`，类别计数 `tasks` 包含它、`reviews` 单独可对账；树里挂在被审 Ticket 下，不混成普通任务。
- **终态**：`dropped`/`stopped` 子 Ticket 显示 `done`/`failed` + `terminal`，不出现在“进行中”；取消由 `Delegation.resolution.kind='cancelled'` 表达，不新造 `terminal='cancelled'`；`waiting` 子 Ticket 显示 `idle`/“等待父”，但 attention 与父状态仍按 `ticketStage`/resolution 计算，不能把 waiting 算 blocked。
- **父子任务**：父 owner 能在一次运行里创建 2 个子 Ticket，两个子 owner 的 Session 不同且都能独立报告；父节点在子 Ticket 未结束时提交 `ready` 必须被 Engine 拒绝；停止父后所有子 owner 在 5 秒内停止；深度 6、单节点 9 个、单根 33 个活跃子 Ticket 时返回明确错误。
- **报告链**：每条子报告都有 `ChildReportDisposition`；`accept/return/self-work/reassigned/escalated` 五类判断都能在详情与 trace 里看到；父接受后子 Ticket 结束；退回后 attempt 递增、旧报告失效；父自己接管/再委派有记录；父（作为子）向祖父报告，根向人给出结论；未判断的报告显示“待父 owner 审阅”，不能被当成已接受。
- **父 owner 缺位**：父 live 但 session 缺失、Assignment 可恢复时，先恢复父并投递报告；不可恢复时子 `orphaned`，只向最近在世祖先/人升级一次；父已结束时子取消/孤儿化，不把报告补写到已结束父；根 owner 缺位时人收到一次缺口提示。
- **恢复**：运行中重启，先恢复根/父再恢复子；父可用后子从 `blocked(restart)` 恢复；父记录缺失/已结束才 `orphaned`；不静默重跑、不静默标完成。
- **授权不变量**：子 Ticket 没有 `mandate`/`decisionId`；`rootMandate()` 解析根；动作闸门/Approval/outbox 的 `ticketId` 是根；子 Ticket 直接 `approve`、创建根 Ticket、直接找人、提高 `maxActionLevel`、直接外发都必须失败；只有 Eval 创建根、只有 Engine delegation 创建子；子 owner 可以请求更深子 Ticket，但仍同根。
- **pendingEnd**：PR/线程已关闭但有未结束子 Ticket 时，Ticket 不写 `ended`，显示 `pendingEnd`；父恢复后处理并应用 pending，父不可恢复则一次 attention，不能永久挂起；人 stop/`dropped` 清除 pending 并用 `stopped`/`dropped` 结束。
- **轻量/ tracked 共存**：Phase 0 接通后，lightweight 受理后无 Assignment/owner/workspace；任务视图不显示 owner/交付/子 Ticket，不进入 review/attention；tracked 行仍正常；类别同时计数；lightweight 不能 `delegate_ticket`；升级后出现新 tracked 节点、旧 lightweight 不被改写。Phase 0 未接通时，此项改为 kernel fixture 测试，不声称产品可受理。
- **子 Ticket 投影**：500 个根 Ticket、2000 个子 Ticket 时 `GET tasks` 只返回根与 `childSummary`，不返回子数组；展开一层按需取；禁止 N+1；`tasks` 类别计数不含子 Ticket；`totals.children` 另算。
- **查询/旧数据**：旧库无 `parentTicketId` 的行全部当根；`tickets.list/open/active()` 默认不含子；`childrenOf`/`subtree` 正确；没有 `subtask` 表；旧二进制打开 schema 15 被拒绝。

### 9.2 子 Ticket 契约测试（第 2 期）

**授权不变量**

- 子 Ticket 是 Ticket：`parentTicketId`/`rootTicketId` 正确，`mandate`/`decisionId` 缺省；`rootTicket()` 解析到根；旧代码/投影不得把子 Ticket 当根。
- 只有 Eval 创建根 Ticket；只有 Engine 的 `delegate_ticket` 创建子 Ticket；worker 不能直接写表/触发 Eval；子 owner 不能创建授权根或独立 Ticket，但可以请求同根的下级子 Ticket；没有 `subtask` 表/类型残留。
- 动作闸门、`Approval.ticketId`、`OutboundSend.ticketId` 都是根；子发起时 `requestedForTicketId`/`originTicketId` 记录子来源；子 Ticket 直接 `approve` 返回 `notAuthorizationRoot`；子不能提高 `maxActionLevel`，不能直接找人，不能 commit/send/spend/merge，不能经 outbox 外发。
- 子 owner 的 `bash` 受限：`git push`、`gh pr create`、`curl` 外网、写父受保护路径、`subagent` 都失败；子 owner 的 subagent 不能借 `limitSubagent` 重新拿到父/子执行工具；受限配置缺失时必须显式降级，不能声称“子不能外部动作”。
- 子 Ticket 的 owner/worker 是 `worker-<childTicketId>`，能通过 `ticketOfSession`/`decorate`/`ticketOf` 命中；`workOnly`/预设/工具注册同时检查父/根与子状态；旧 attempt 的 `agent/status`/`agent/error`/event 被丢弃（`staleChildAttempt`），不能改新 attempt 或父状态。

**委派与父审阅链**

- `delegate_ticket` 在深度 6、单节点 9 个、单根 33 个活跃子 Ticket 时拒绝；错误可读，不静默截断；自引用/祖先环/重复父链被拒；`parentTicketId` 创建后不可改。
- 父 owner 创建 2 个子 Ticket，各自 owner/worker 不同；子报告进入父 `TicketInput.kind='child-report'` 并唤醒父；同一子 Ticket 连续报告只保留一条待处理，不重复唤醒。
- 父 `accept_child` 写 `ChildReportDisposition.decision='accepted'` 与 `Delegation.resolution.kind='accepted'`/`acceptedReportAt`/`acceptedAttempt`/`merge`；子 Ticket `ended`（completed），子 worker 终止；父接受不写人的 `Review.confirmations`。
- 父 `return_child` 后 attempt 递增，旧 report/disposition/merge/resolution 失效；新 attempt 的 worker 报告才被接受；重新接受写新 revision 的合并记录，不能复用旧合并；子详情不显示旧 attempt 的交付/时长。已接受子 Ticket 在根最终批准前被 `return_child` 时，accepted/merge 清除、根 `reviewRevision` 失效；根已最终批准后不得单方面退回。
- 终态 integrity：`accepted`/`cancelled`/`failed` 必须分别与子 Ticket `ended` 的 completed/stopped/dropped 成对；只有 resolution 没有 ended、只有 ended 没有 resolution、或 live 子 Ticket 带 failed resolution 时，父结束门必须报错/生成 attention，不能放行；`cancel_child(disposition='failed')` 必须终止子 worker 并写 dropped 结束。
- 父“自干”写 `decision='self-work'` 与 trace，不把子的未完成工作算成已完成；“再委派”写 `reassigned` 与替换 id；升级给人只产生一个 `human_action`，不重复记账。
- 父（作为子）在完成自己的子 Ticket 后向祖父 owner 报告；根 owner 向人给出结论；每步有 `delegation.report/review/delegate/self-work/report-up` trace；`ChildReportDisposition` 与 `TicketInput` 投递/读取状态可查；未判断的报告显示“待父 owner 审阅”，不能显示成已接受。
- 父 `ready`/`dropped`、人停止、`follows`/PR 合并四条结束路径：有未结束子 Ticket 时都不能静默结束；`ready` 返回 `unfinishedChildTickets` 且不写报告；`Assignments.review`/`reviewTicket` 同样拒绝；`dropped`/人停止取消子树；PR 合并先 `pendingEnd` + 一次 attention；父 `failed` 不取消子 Ticket（子保持只读/`blocked`，父 Ticket 保持 live、可重试），与 4.6.4 的恢复语义一致。
- 父在 `waiting`/空闲时子报告能唤醒父并得到新 turn；父 `failed` 后子 owner 写入被拒绝、按设计只读/恢复；父 `blocked` 时子 owner 只有只读/草稿权限；父 `waiting`（正常轮末）时子 owner 继续工作，不能被降为只读。
- 重啟恢复先父后子，不因父 session 尚未加载而误标 orphaned；父记录缺失/已结束才 `orphaned`，交人一次；父 owner 不可恢复时升级到最近在世祖先/人；父已结束时报告不补写到已结束父。
- 父 `waiting` 时父状态投影为 `working`/`blocked`，绝不因父报告 `waiting` 显示 `idle`；子 `dropped`/`stopped` 用 `done`/`failed` + `terminal`，取消由 resolution 表达；任何测试/代码不得用 `TaskView.status` 计算 attention。
- `attention`/`counts.attention` 只对未结束根 Ticket 的 person-stage `review/answer/delivery/blocked/failed` 与子 Ticket `blocked/failed/orphaned`（父 owner 不可用）为 true；`待父审阅` 不计入人的 attention；已结束 Ticket 一律 false；`waiting` 子 Ticket 不进入 attention；子报告自带 `attention`/`human_action` 时不直接送人，只作为父 owner 的 `child-report`，父不可用时才升级一次。
- 最终 review：子 Ticket 带 `HumanCriterion` 时，父接受后确认仍在根 `TaskReviewView`；批准必须带当前 `reviewRevision`；接受前子新报告使旧 revision 失效并返回 `reviewStale`；接受后报告被拒绝；根/子同一 artifact/revision 只出现一行；子 Ticket 直接 approve 被拒。
- `pendingEnd`：PR 关闭 + 未结束子 Ticket 时 Ticket 不 ended、发 `end-gate` 唤醒父；pending.outcome 原样保留 `merged`/`closed`；父处置后按 pending 结束；父不可恢复时一次 attention，不永久挂起。
- 审批先于/后于关闭：PR 在父 `ready` 前已合并时，审批后按 `followsDone.outcome` 结束（`merged`/`closed`），不等待不会再来的一次 close；PR 未合并时审批等待 close。
- 人 stop/`dropped` 遇到已有 `endPending`：清除 pending，分别以 `stopped`/`dropped` 结束，不能改写成 `merged`，也不能留下 ended+pending。
- 建议接受：支持 Ticket 中任一已有 `manual` placement 时返回 `409 manualPlacementConflict`，不覆盖、不部分写入。
- 类别继承：review Ticket 的 `inherited` placement 是读时解析，被审 Ticket 移动后自动跟随；不产生需要级联的持久化 placement；子 Ticket 不进入分类器、不计入类别任务数、不产生类别建议。
- form 选择：未注入 `inline`、需要 review/workspace/子 Ticket/外部写时，accept 不得选 lightweight；review Ticket 永远 tracked；子 Ticket 永远 tracked。
- 查询：`tickets.list/open/active()` 只返回根；`childrenOf` 只返回直接子；`subtree` 用 root 索引；旧行当根；没有 `subtask` 表；schema 15 旧二进制拒绝。

## 10. 迁移与兼容

迁移是**前向**的：类别覆盖层可开关回退；子 Ticket 用 schema 15 生成列/索引 + JSON 字段，旧二进制不能忽略。回滚需要 down migration、升级前数据库副本或 JSON 导出/导入。

| 场景 | 策略 |
| --- | --- |
| 老数据库 | 类别仍用 KV，`task-catalogue.v1` 不存在时按现有计划树渲染；schema 15 只加 `ticket.parent`/`ticket.root` 生成列与索引，旧行 `parent=NULL`、`root=id`，不重写、不建 `subtask` 表 |
| 老工单 | 全部读作根 Ticket；可批量归纳类别；没有子 Ticket 就显示空子树；未归纳前进“未归类”或按计划查看，不丢 |
| 老 subagent | **不追溯成子 Ticket**：subagent 仍是执行细节；历史 Ticket 不会因为曾经开过子会话就长出 L3；历史 inline action 也不是子 Ticket |
| 旧客户端/旧二进制 | 旧客户端可忽略新增 JSON 字段；但旧二进制**打不开** schema 15 数据库（`Store` 拒绝高于 `SCHEMA_VERSION` 的库），不能当回滚方案；这正是防止子 Ticket 被误当授权根的安全门 |
| 归纳服务不可用 | 全部未归类；任务页仍可用；不阻塞工单 |
| 子 Ticket 开关 | `taskView.childTickets` 默认 **on**（第 2 期后）；关闭前要求没有未结束子 Ticket，否则提示先停止/等待，不静默隐藏仍在写文件的子 owner；开关只停止新委派/隐藏子树，不降 schema、不删除子行 |
| 回滚 | schema 15 是前向迁移：旧二进制不能打开，必须 down migration、恢复升级前备份或 JSON 导入；down 步骤：停 Engine → 处置/导出所有子 Ticket（取消/归档）→ 删除 `parentTicketId` 非空的行（或整表从备份恢复）→ 删除 `ticket_parent`/`ticket_root` 索引与生成列 → `SCHEMA_VERSION=14`。不能只删索引留下子行，否则旧二进制会把它们当根 |
| 开关位置 | Settings › 任务视图 › “类别视图”/“子 Ticket 树”，默认都 on；关闭后 `GET tasks` 不返回对应字段，面板回退；不做后台写 |
| 数据导出 | `task-catalogue.v1` 是普通 JSON；子 Ticket 可按 `rootTicketId` 导出子树 JSON（含 `delegation`/报告/交付引用）；删除前提示导出；删除类别即恢复自动/未归类 |
| 计划维度 | 计划编号保留为任务标签与“按计划查看”，不再作为 L1 |

**查询/索引变更**（与现有 `ticket` 表的关系）：

- `tickets.get(id)` 根/子都可读；`Tickets.list/open/active()` 默认根过滤，新增 `childrenOf`/`subtree`/内部 `allActive`；Eval、派发、类别计数、指标、右栏列表不得看到子 Ticket。
- `ticket_open`/`ticket_active` 仍按每行；根级“活跃子 Ticket ≤32”用 `WHERE root=? AND parent IS NOT NULL AND value -> '$.ended' IS NULL`（`ticket_root` 索引）；一层展开用 `ticket_parent`。
- `activity`/`ownership`/`views/tickets.ts` 对子 Ticket 事件按根聚合；子 Ticket 不参与计划归属推导；`ownership` 只对根跑。
- 旧数据无需回填；生成列由 SQLite 从 JSON 计算。若某行 `rootTicketId` 缺失/指向不存在/成环，投影只读报错并写 attention，不猜根。

**不做的事**：不迁移历史工单标题、不改 `Mandate.scope`、不把类别写进工单、不在读取时写库、不把历史 subagent 追溯成子 Ticket、不让 worker 直接建授权根 Ticket、不建 `subtask` 表。

## 11. 风险与待决问题

### 已决（本修订）

- 节点统一为 `Ticket`，子节点用 `parentTicketId`；不新增 `Subtask` 类型/表。
- 子 Ticket 不创建新 Mandate/Decision，继承根授权与 `maxActionLevel`；对外动作只走根 Approval/outbox；子不是授权主体。
- 子 owner 不能创建授权根 Ticket、不能直接找人、不能提级、不能外发；可以请求同根的下级子 Ticket。
- 父 owner 审查链与逐层上报；父接受不等于人确认。
- 默认上限：深度 5、单节点 8 个直接子 Ticket、单根 32 个活跃子 Ticket。
- 类别只归类根 Ticket；子 Ticket 继承，不单独分类/计数。
- 存储：schema 15 生成列/索引 + JSON 字段；不建 `subtask` 表；旧行当根；旧二进制拒绝。
- 独立 review 必须核对“子节点不成为授权主体”，结论写成 PR review 评论。

### 风险

1. **归纳错误**：把无关任务合并会伤害信任。缓解：高阈值、人工优先、未归类、可撤销、显示 reason。
2. **模型成本/延迟**：每根 Ticket 一次调用。缓解：异步、去重、批处理、可关闭、失败不阻塞。
3. **隐私**：归纳会读标题/范围/来源摘要。缓解：不读文件与私密全文；沿用现有模型；可关闭。
4. **类别膨胀/频繁改名**：用户认知不稳定。缓解：上限、别名、稳定 id、归档而非删除。
5. **右栏太窄**：列表可读，树/看板不可读。缓解：右栏只做列表/紧凑展开，完整视图进状态页。
6. **交付物只到节点最近报告/聚合粒度**：`TaskReviewView` 能聚合根与已接受子 Ticket 的**当前**交付并去重，但没有跨 Assignment 的完整交付时间线；任务视图先显示当前聚合，历史版本需要产品定义。
7. **子 Ticket 被误当授权主体**：同一张表/同一类型，旧代码或新查询很容易把子 Ticket 当根。缓解：根/子类型分离；只有根有 Mandate/Decision；动作闸门/Approval/outbox 只认根；`list/open/active` 根过滤；测试与独立 review 专门核对。
8. **旧二进制/旧客户端误读**：旧二进制打开 schema 15 必须被拒绝；旧客户端只忽略字段，不改变行为。缓解：schema bump、根过滤、迁移演练、旧客户端不写。
9. **父审阅越权**：父 owner 接受子交付，不等于人确认验收条件。缓解：6.6 聚合子确认并以 `reviewRevision` 绑定最终批准；父的 `accept_child` 只写 `resolution.kind='accepted'`，不写人的批准。
10. **委派失控/成本**：owner 递归拆任务，子 owner 数量与模型成本爆炸。缓解：深度 5、单节点 8、单根 32 个活跃上限；配额与预算；父 stop 级联；UI 显示子 Ticket 数。
11. **父 owner 成为瓶颈**：所有子交付都要父审阅，父可能排队。缓解：子状态与交付摘要可并行查看；父可批量接受低风险交付；父阻塞时人可停止/接管；指标看父审阅时长与待处理报告数。
12. **父子死锁**：父等子完成，子等父回答。缓解：子问题只回父；父必须定期处理子输入；超时/心跳；父不可用时升级到最近在世祖先/人。
13. **合并冲突**：多个子 Ticket 改同一文件/同一文档。缓解：代码子 Ticket 用独立分支/工作树，父合并；文档用 revision/复制；父解决不了再升级为人问题；不自动覆盖。
14. **孤儿子 owner**：父进程/父 owner 消失，子 owner 继续写。缓解：持久化父子关系；父结束级联停子；重启**先恢复父再判断**孤儿，不能因父 session 未加载误标；孤儿不自动重跑，交人。
15. **注意力碎片化**：每个子 owner 都找人，用户被淹没。缓解：默认子→父、父→人；父汇总成一个 `human_action`；子 Ticket 的“待父审阅”不计入人的未读；子不直接发 IM。
16. **报告链丢失/静默接受**：父 owner 没看到报告、或直接把子标记完成。缓解：`child-report` 输入 + `ChildReportDisposition` + trace；未判断显示待审阅；接受需要 `acceptedReportAt`/attempt；父接受不等于人确认。
17. **父 owner 缺位/已结束**：报告无人处理，子 owner 继续写。缓解：4.6.5 的恢复/升级/级联规则；只升级一次；已结束父不补接受；人可取消/另开根 Ticket。
18. **事件与任务口径漂移**：两个视图各自推导会矛盾。缓解：共用 `ownershipIndex` + `TaskCatalogue` 解析链；子 Ticket 事件按根聚合；根过滤统一。
19. **多人/多端**：当前单用户本地；覆盖层 revision 只解决并发写，不解决权限；子 owner 的停止/接管也需要权限。多用户需另做权限模型。
20. **“任务”命名过载**：代码里已有 Ticket、Assignment、Session、ChildTicket；UI 固定“任务节点 = Ticket”，文档明确“子 Ticket 不是授权主体”。避免把子 Ticket 说成“第二 Ticket”；它仍是 Ticket，但不是根/授权主体。
21. **执行者身份不足**：当前只有通用 worker，没有角色/姓名/指派；根/子 owner 先显示 Session id（E2），不凭空生成“执行 Agent”名字。
22. **“规划中”的任务不可见**：运行时没有结构化 plan；任务视图只展示已受理根 Ticket 与执行中的子 Ticket；要展示“还没成为 Ticket 的计划”，需要单独 plan 模型，本期不伪造。这是待决问题 14，不是已解决的范围。
23. **子 Ticket UI 过深**：默认 3 层，L4+ 折叠；超过 5 层拒绝创建；右栏不展示深层；避免树把用户淹没。
24. **回滚成本**：schema 15 是前向迁移，down 需要删子行/恢复备份；不能只关开关。缓解：升级前备份、导出子树、演练 down migration；开关只停止新委派。

### 待决问题（需要产品决策）

| # | 问题 | 建议 |
| --- | --- | --- |
| 1 | L1 是“业务类别/工作线”还是“目标”？一个任务能否属于多个类别？ | 一个主类别 + 可选标签；先不做多归属 |
| 2 | 类别上限 5 还是 7？ | 7 个活跃类别，超过提示合并 |
| 3 | 新工单自动归类还是只给建议？ | 已有类别高置信自动；新类别单任务只建议，累计 2 个任务或批量确认后建类；中置信建议、低置信未归类 |
| 4 | 看板列用状态还是类别？ | 状态列 + 类别泳道；拖拽只改类别 |
| 5 | 图是时间线还是依赖图？ | 先时间线；有依赖数据再画依赖 |
| 6 | 父 owner 能否自动接受低风险子交付？ | 默认人工可审计的父审阅；只读/低风险子 Ticket 可配置自动接受，但必须有 disposition/trace，且不能替代人的最终确认 |
| 7 | 子 Ticket 最大深度/宽度/活跃数？ | 默认 5 / 8 / 32；可配置，超限报错 |
| 8 | 子 Ticket 用独立目录/分支吗？ | 代码类默认独立分支/工作树，父合并；只读/分析类可共享父目录；由 Executor 按任务类型决定 |
| 9 | 人能否停止/重派/重试单个子 Ticket？ | 第 2 期只给父 owner `cancel_child`/`return_child`；单子 Ticket 人工操作需要新的权限/恢复契约，先不做；人可通过根 attention 要求父处置 |
| 10 | “执行者”是否要角色/姓名/指派？ | 当前只显示根 owner/子 owner 角色；角色/指派是独立产品模型，不在本期伪造 |
| 11 | 旧计划树与新类别树如何同页共存？ | 第 1 期保留 `milestones` 作为回退/“按计划查看”；默认按类别，不把计划编号当 L1；两套视图共用同一 Ticket 读模型，不双写 |
| 12 | 父 owner 的报告 SLA/超时如何处理？ | 先给“待父审阅”计数与指标；超时后升级到最近在世祖先/人一次；具体阈值待真实使用数据 |

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
- 代码入口：`packages/kernel/src/model.ts`（Ticket/ChildTicket/Delegation/TicketInput）、`tickets.ts`（结束门/根过滤）、`assignments.ts`/`deliverable.ts`（ReviewAggregate）、`approval.ts`/`ports.ts`（根 Approval/outbox）、`packages/dsh/src/app/store.ts`（schema 15/生成列）、`tasks.ts`、`ownership.ts`、`activity.ts`、`views/tickets.ts`、`packages/dsh/src/client/tasks.tsx`、`system.tsx`、`packages/dsh/src/executor/dsh.ts`、`packages/dsh/src/app/sessions.ts`。
- 相关文档：`docs/001-domain.md`（只有 Eval 创建授权 Ticket）、`docs/003-execution.md`（Assignment/worker/review）、`docs/009-conversation-tasks.md`（Ticket 是任务聚合）、`docs/011-design-principles.zh.md`（授权不变量、E0–E3、六层上下文与替换边界）。

## 附录 A：一个跨源任务的走查

1. 陈立在对话里说“准备华兴科技 2025 汇算清缴底稿”；主会话派发 → 对话 Source 产生 Trigger → Eval 接受 → **根 Ticket** 建立，origin 是对话，worker 为 `worker-<rootTicketId>`。根 Ticket 有 Mandate/Decision，是唯一授权主体。
2. 张敏从邮件/飞书补来“研发费用辅助账已上传”；消息通过订阅/绑定进入同一根 Ticket，成为 Input 与来源锚点，不新建任务。
3. 归纳服务在受理后运行：现有类别有“客户服务/业务拓展/产品与工具”，工单标题与 scope 指向客户交付 → 归入“客户服务”，confidence 高，记录 reason。子 Ticket 不参与归类。
4. 根 owner 判断需要并行拆两份工作，调 `delegate_ticket` 创建两个**子 Ticket**：
   - “资料解析”（`t_child1`，`parentTicketId=<root>`，`rootTicketId=<root>`，worker `worker-t_child1`），只读解析邮件与附件；
   - “底稿核算”（`t_child2`，worker `worker-t_child2`），在独立分支上生成底稿。
   两者都没有自己的 Mandate/Decision；Engine 校验同根、根 `maxActionLevel`、深度/数量后写入。任务页显示 类别“客户服务” → 根 Ticket“华兴科技 2025 汇算清缴” → 两个子 Ticket（各自 owner、状态、待父审阅、交付）。
5. “资料解析”的子 owner 又开一个 subagent 做 OCR；这是子 Ticket 内的执行细节，不显示成 L4 任务，也不产生第三个子 Ticket。子 Ticket 完成后把摘要与交付作为 `child-report` 报告给**父工单 owner**，不直接找人。
6. 父 owner 审查“底稿核算”的交付，发现固定资产清单缺失，`return_child` 退回（attempt+1，旧报告作废）；子 owner 补充后再次报告，父 `accept_child` 并写 `ChildReportDisposition`/`resolution`/`merge`。父 owner 合并两个子结果，生成根 Ticket 的最终交付。
7. 父 owner 在根 Ticket 上提交 `ready` 前，Engine 检查两个子 Ticket 都已结束/处置；没有未结束子 Ticket，才允许进入人工验收。验收仍走根工单/评审面，按 6.6 `reviewRevision` 批准；子 Ticket 的确认进入根聚合，父接受不等于人确认。
8. 这个根 Ticket 的 owner 向人给出结论（根 ready/review/通知）。同一机制也适用于更深节点：某个子 Ticket 自己还有子 Ticket 时，它完成自己的子 Ticket 后按同样方式向父 owner 报告；只有根 owner 直接向人给出最终结论。
9. 用户觉得“客户服务”太粗，改为“税务申报”；只改类别名，根 Ticket、子 Ticket 与授权不变；子 Ticket 自动跟随根类别，不单独归类。
10. 用户把“某税局投标”从“客户服务”拖到“业务拓展”；看板只改类别，不改任务状态；事件流不产生新事件，任务详情显示“由 陈立 移动，原因：…”。
11. 如果人停止这个根 Ticket，根与两个子 owner 一起停止；如果父 owner 取消“底稿核算”，只停该子树，“资料解析”与根 Ticket 继续，父 owner 决定是否重派/自干。所有停止/取消都写 `Delegation.resolution`/trace，迟到报告被拒。
