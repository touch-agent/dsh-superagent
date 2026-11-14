# 029 项目任务视图：项目、层级、负责人与待处理

> 状态：**设计已定稿；P0 数据与派发层已实现（见附录 D），面板 UI 未实现**。本文档仍是字段与接口契约；实现记录、偏差与未完成项见附录 D。历史说明：本单最初只交付设计文档、可点击 HTML 原型、同视口截图与迁移可行性说明；后续数据层单按本设计落地，不改面板 UI。
>
> 输入：工单 `717a055c…`（「重设计任务视图」）、触发 `f37bfc2c…`，以及 2026-11-14 人工 review 对 #86 的三条意见（项目/任务/子任务都是 Ticket；项目由主会话识别并绑定负责 worker；项目可归档、默认看未归档）。基线：`touch-agent/dsh-superagent` main `46e1089`。
>
> 关系：承接任务视图架构提案（`docs/tasks-view-architecture.zh.md`）和 [021](021-ux-redesign.zh.md)、[023](023-ux-first-batch.zh.md)、[024](024-ux-second-batch.zh.md)、[026](026-ux-third-batch.zh.md)、[028](028-plugin-main-page.zh.md)。本版按 review 把「项目」从 Ticket 之上的 KV 覆盖层改为 **Ticket 的一种层级**，并把创建路径改为「主会话识别项目 → 项目负责 worker → 任务」。

## 0. 结论摘要

| # | 结论 | 为什么 | 影响 |
| --- | --- | --- | --- |
| 1 | **项目、任务、子任务都是 Ticket，只是层级不同。** 项目是 `kind='project'` 的容器 Ticket；任务仍是根 Ticket，带 `projectTicketId`；子任务仍是现有 `parentTicketId` 子 Ticket。 | review 明确要求「本质上都是 Ticket，只补层级归属字段，复用负责人、会话、状态」。这比另建 Project 实体/覆盖层少一套数据、少一次 join，也不会让项目视图与 Ticket 真相分叉。 | Ticket 只加可选字段 `kind`、`projectTicketId`、`archivedAt`、`goal`；子任务仍由现有 `parentTicketId` 表示，不新建 Project 表、不写 `task-catalogue.v1`。 |
| 2 | **项目 Ticket 是容器，不是第二个任务执行/任务授权根；另有仅做协调的项目会话。** 它没有**任务执行** Assignment、交付物、审批；不按任务完成而结束；归档只写 `archivedAt`。项目负责 worker 有一个**项目协调 Session**（复用 `worker-<ticketId>` 会话设施，不进入任务执行队列），负责协调、建任务和指派，不产生交付/验收。 | 项目是持续工作线，不能被一个任务完成结束；也不能让项目抢走任务的 Mandate/Approval。 | 项目不进入「全部任务」的扁平列表；`GET tasks` 的 `tasks` 仍是根任务，项目单独在 `projects` 投影。 |
| 3 | **层级固定为：项目 → 任务（根 Ticket）→ 子任务（子 Ticket）→ 更深子 Ticket。** 项目 → 任务用 `projectTicketId`；任务 → 子任务沿用现有 `parentTicketId`/`delegation`。 | 任务必须保留根 Ticket 的授权、attention、审批和结束语义；若把任务改成项目的子 Ticket，父审查会吞掉人的验收，且旧 `GET tasks` 根列表会消失。 | 任务仍是根；`projectTicketId` 只是归属。子任务仍继承任务授权并向任务 owner 汇报。 |
| 4 | **项目负责 worker 是项目 Ticket 的 `profile` 快照；它负责协调和拆任务，不是所有任务的执行者。** 项目必须绑定一个可用的 worker/profile，不再静默回退「默认执行配置」。 | review 要求项目有负责 worker，且该 worker 能创建任务、指派其他 worker；这必须是一项受 Mandate 约束的能力，不能只是展示字段。 | 项目卡/详情显示「负责 worker」；项目级 attention 负责 worker 不可用；已有任务按自己的 owner 执行，不被项目 worker 改写。 |
| 5 | **创建路径是「主会话识别项目 → 绑定项目负责 worker → 该 worker 拆任务/指派 worker」。** 主会话识别到同一项目的新需求，直接派给该项目负责 worker；项目 owner 可自己干（任务 owner=自己）或指派其他 worker。 | review 明确项目由主会话识别，并给 worker 创建任务/指派 worker 的权限。原设计「必须先改创建流程」把因果关系说反了：这条路径本身就是设计。 | 新增 worker 能力 `create-task`、`assign-worker`，受项目 Mandate 的 capability/scope 约束；视图不直接造 Ticket。 |
| 6 | **项目有 active/archived；默认只显示未归档，已归档可查看。** 归档不取消任务、不隐藏待办；有未结束/待人任务时也可归档。 | review 要求「用户明确说明或手动归档；界面优先显示未归档，也可以查看已归档」。上一版的归档拦截会让用户无法按自己的意愿归档。 | 项目列表加 `未归档 / 已归档` 过滤；归档项目从默认列表移出，但任务仍在「全部任务」、待人项仍在「待你处理」。 |
| 7 | **「待你处理」仍只指真正需要人的根任务动作，项目/归档不改变这个语义。** 根任务（包括项目任务）的 review/answer/delivery/blocked/failed 是人的事；子任务等父 owner 不是。 | 现有 `attentionFor` 的保守语义是对的；项目是组织层，不能把子任务的父审升级成人，也不能因为归档把待办藏掉。 | 项目卡、任务行、通知抽屉读同一投影；归档项目的待办在抽屉/首屏带「已归档」标记，不被过滤。 |
| 8 | **迁移结论：现有 92 个 Ticket 仍是任务，不自动长出项目；项目只能由主会话/人明确建立，再把已有任务归入。** 真实数据 0 个项目、0 个 `parentTicketId`、0 个 profile 快照。 | 标题/计划编号/来源不是项目信号；review 也要求项目由主会话识别，不是按标题猜。 | P0 先加字段并映射旧数据；P1 建项目/绑定 worker；P2 项目任务与 worker 能力；不自动归组。 |
| 9 | **不假装拥有宿主能力。** 项目页仍在插件右侧栏任务页/面板回退页；不改宿主导航/侧栏/通知中心；不预填宿主输入框；不做多人/跨设备。 | 公开扩展点仍是 `sidebar.right.pane.tab`、页头入口、`openSession`、插件自己的抽屉/管理 API。 | 新任务/拆解通过主对话；项目页只做定位、读取和已有动作。 |

## 1. 现状与证据

### 1.1 当前界面

当前任务页（面板回退形态，1440×900，浅色，真实本地任务状态）见 [before-tasks.png](images/plugin-main-page/before-tasks.png)；右侧栏形态见 [after-side-tasks.png](images/plugin-main-page/after-side-tasks.png)（该 fixture 没有任务，只用于看布局；文件名为历史批次命名，内容为当前实现）。它已经能回答“每个任务到哪了”，但首屏仍是**没有项目层的任务列表**：

- 顶部是主 Agent 卡和一句说明，下面是 `列表 / 任务树（E2）/ 计划树（E2）/ 图（E2）` 和 `全部 / 待我处理 / 进行中 / 失败` 过滤。
- 每行是任务标题、状态、审查/产出物、负责人和最近产出；选中后展开一层子任务或右侧详情。
- “待你处理”在宽面板是右侧卡片，在右侧栏是列表下方的一块；它按任务聚合，不按项目聚合。
- 没有“项目”这一层。用户看到的第一个对象是任务，不是“我在推进哪几条线”。

这和 2026-11-08 的反馈（任务视图要能看关系、负责人、会话、产物）相比已经前进了一步，但没有回答本次更前置的问题：**我有哪几个项目、各自负责 worker 是谁、哪个在等我。**

### 1.2 真实数据聚合（只读，不读取标题/内容）

2026-11-14 对本地 `~/.dsh/state/superagent/orchestrator.sqlite` 做只读聚合：

| 指标 | 值 | 说明 |
| --- | --- | --- |
| Ticket 总数 | 92 | 历史与当前 |
| `parentTicketId` 非空 | **0** | 没有一个子 Ticket |
| 有子 Ticket 的根 | **0** | 根 → 子层级在真实数据中为空 |
| open 根 Ticket | 3 | 当前仍开放 |
| 根 `attention` 非空 | 0 | 抓取时没有待人处理的根 |
| 标题带 `T<数字>-<数字>` | 35 | 计划编号只是标题标签 |
| Mandate scope 带计划编号 | 40 | 同上，不是父子关系 |
| `Ticket.profile` 非空 | **0** | 历史 Ticket 都走默认执行配置 |

这组数字直接支持工单里的判断：**层级设计存在，但真实数据几乎不产生层级任务。** 原因不是 UI 没画树，而是创建路径和项目容器都缺位（见 §2、§6）。

> 隐私：只取了计数，没有读取或输出任何任务标题、来源内容、会话内容或账号。正式交付时也不把个人数据写进 PR。

### 1.3 代码事实

| 事实 | 位置 |
| --- | --- |
| `Ticket` 已有 `parentTicketId`/`rootTicketId`/`delegation`；子 Ticket 没有自己的 Mandate/Decision，继承根的授权。 | `packages/kernel/src/model.ts`、`packages/kernel/src/tickets.ts` |
| 子 Ticket 只能由父 owner 通过 `orchestrator_child`（内部 `Engine.delegate`）创建；子节点有独立 owner/worker，向父 owner 汇报，父 owner 接受/退回/改派。 | `packages/dsh/src/app/tools/executor.ts`、`packages/kernel/src/engine.ts` |
| `TaskBoardView.tasks` 是根 Ticket 列表；`GET tasks/:id?depth=1..5` 才展开子节点；`TaskView` 已有 `owner`、`childSummary`、`delegation`、`deliverables`、`blocker`、`goal`、`attention`。 | `packages/dsh/src/app/tasks.ts` |
| 任务页默认是 `列表`；`任务树（E2）`、`计划树（E2）`、`图（E2）` 是二级视图，计划树/图基于标题或 scope 里的计划编号，不写数据。 | `packages/dsh/src/client/tasks.tsx`、`packages/dsh/src/app/ownership.ts` |
| 没有项目/任务类别代码。`TaskCategory`/`TaskPlacement` 只存在于设计提案；`SpaceKind 'project'` 是部署基线空间，明确“从不从 Ticket 发明”，与本设计的项目无关。 | `docs/tasks-view-architecture.zh.md`、`packages/dsh/src/app/spaces.ts` |
| 通知投影（`GET overview` → `noticeItems`）已经用 `title / what / next / consequence / actions` 解释待处理，并按 attention/progress/system 分组；但它不知道项目。 | `packages/dsh/src/client/notifications.ts` |
| 当前插件可注册右侧栏任务页、主对话页头四图标、打开现有 Session；不能替换宿主导航/侧栏/通知中心。 | `packages/dsh/src/client/index.tsx`、[028](028-plugin-main-page.zh.md) |

## 2. 数据模型

### 2.1 现有字段与新增字段

| 能力 | 现有字段/投影 | 本版怎么用 |
| --- | --- | --- |
| 层级 | `Ticket.parentTicketId`、`rootTicketId`、`delegation` | 保留给任务 → 子任务；项目 → 任务用新 `projectTicketId`，不改现有父子语义。 |
| 每级负责人 | `Ticket.profile`（受理时快照）、`TaskView.owner`、`worker-<ticketId>` Session | 项目 Ticket 的 `profile` 快照就是项目负责 worker；项目有自己的**项目协调 Session**（`worker-<projectTicketId>`，复用现有会话设施），只做协调/建任务/指派，不执行任务、不交付；任务/子任务仍用自己的 owner 和执行 Session。 |
| 状态 | `activityStatusOf`、`TaskView.status`、`childSummary` | 项目状态由子任务聚合；项目自身不执行，只有 active/archived 与聚合健康。 |
| 授权 | `Mandate`、`Decision`、`Approval` | 任务仍是根授权单元；项目 Ticket 只承载项目范围，不产生第二个任务授权根。 |
| 交付/验收 | `deliverables`、`review`、`Approval` | 不变；项目不产生交付物，不批准。 |
| 待处理 | `attentionFor`、`TaskView.attention` | 不变；项目任务仍是根，归档不改变 attention。 |
| 项目 | **无** | 新增 `kind='project'` 的 Ticket + `archivedAt` + `goal`；项目列表是新投影，不是新实体。 |
| 项目归属 | **无** | 新增可选 `Ticket.projectTicketId`；任务和子任务都可带，子任务从任务继承。 |

**新增 Ticket 字段（全部可选，旧数据默认）：**

| 字段 | 类型 | 默认/约束 | 说明 |
| --- | --- | --- | --- |
| `kind?` | `'project' \| 'task'` | 缺省 = `task` | 只区分项目容器和任务；**子任务不新增 kind**，仍由现有 `parentTicketId` 表示。项目/任务/子任务都是 Ticket，只是层级字段不同。 |
| `projectTicketId?` | `string` | 缺省 = 未归入项目 | 项目归属；只指向 `kind='project'` 的 Ticket。项目 Ticket 自身不设；子任务随父任务继承。 |
| `goal?` | `string` | 缺省 = 空 | 项目的一句话目标（project only；v1 不用于任务）。任务详情的 `goal` 仍是现有 `GoalView` 投影，不混用。 |
| `archivedAt?` | ISO string | 缺省 = active | 只用于项目 Ticket；可恢复，不是 `ended`。 |

**新增 Mandate 字段（只给项目负责 worker 的项目 Mandate）：**

| 字段 | 类型 | 默认/约束 | 说明 |
| --- | --- | --- | --- |
| `capabilities?` | `('create-task' \| 'assign-worker')[]` | 缺省 = 无；项目受理时按项目 owner worker 授予 | 项目协调能力 allowlist；受 project scope 约束，不能扩大现有授权；不映射到 action level。项目 accept 未写 capability 时，项目卡显示项目级 attention，不静默给权限。 |

**为什么项目 → 任务不用 `parentTicketId`：** 现有 `parentTicketId` 同时是**授权/汇报父链**（子 Ticket 没有自己的 Mandate/Decision，父 owner 接受子报告）。如果把任务挂成项目的子 Ticket，任务的验收会变成项目 worker 的父审，人的验收/attention 被吞掉，旧根任务列表也会消失。项目 → 任务只是**归属**，任务必须继续是根授权单元；所以用 `projectTicketId`，而任务 → 子任务继续用 `parentTicketId`。

**层级不变量（P0 校验/回填）：** 项目 Ticket：`kind='project'`、无 `parentTicketId`/`rootTicketId`/`projectTicketId`；根任务：`kind='task'`、无 `parentTicketId`；子任务：`parentTicketId` 非空，`projectTicketId` 随父任务继承。旧数据 `kind` 缺省为 `task`；旧子 Ticket（当前 0 个）按 `parentTicketId` 读作子任务。`kind='subtask'` 不落库，避免与 `parentTicketId` 双写。

**`Mandate.capabilities` 的定位：** 它是项目协调能力 allowlist，不是外部动作等级；现有 action level（read/draft/commit/send/spend）仍约束 worker 对外部世界的动作。`create-task`/`assign-worker` 的检查在项目协调 Session 内做，只看项目 scope、capability 和 owner/指派目标，不能凭 action level 自动获得。

### 2.2 项目 Ticket 的边界

| 问题 | 结论 |
| --- | --- |
| 项目 Ticket 能执行吗？ | **不能执行任务。** 没有任务交付 Assignment、交付物、验收按钮，不进入任务执行队列；但它有一个**项目协调 Session**（见 §2.5），只做协调/建任务/指派。 |
| 项目 Ticket 有 Mandate 吗？ | 有，但只定义项目范围和负责 worker 的协调能力（创建任务/指派 worker）；项目 Ticket 本身也经主会话/人的现有 accept 创建 project Mandate/Decision，并在受理时写入项目 scope 与 `create-task`/`assign-worker` capability；不把项目变成任务审批根。项目 worker 创建任务走 §2.5 的受理契约，由现有 Decision 模型 + 新增受理 seam 签发任务 Mandate（scope 收窄，actor=受理者，不是 worker 自签）；任务仍是根授权单元。默认不新增人工点击，但这是需产品/安全确认的新契约。 |
| 项目什么时候结束？ | **不随任务完成结束。** 只有人明确说归档/手动归档，写 `archivedAt`；归档可恢复。 |
| 项目能嵌套项目吗？ | v1 不做；`projectTicketId` 只指向项目，项目 Ticket 不能再有 `projectTicketId`。 |
| 项目负责 worker 能替人验收吗？ | **不能。** 项目 worker 只能创建/指派任务；任务的 review/answer/blocked/failed 仍走人的 attention。 |
| 项目 worker 能改任务 owner 吗？ | 只在任务尚未开始/允许改派时，通过 `assign-worker` 能力改；不能改已结束任务，不能越过项目范围。 |

### 2.3 负责人绑定规则

1. **项目负责 worker 是项目 Ticket 的 `profile` 快照。** 创建项目时选择 profile head；项目卡/详情显示 worker 名 + 版本。它负责项目协调、创建任务、指派 worker，不是所有任务的执行者。
2. **项目必须绑定可用 worker。** 不再静默回退“默认执行配置”；profile 停用/不存在时是项目级 attention「负责 worker 不可用」，新任务不静默创建。已有任务继续按自己的快照执行。
3. **换项目负责 worker 只影响之后的新任务。** 项目 Ticket 的 `profile` 更新；已有任务不被改写；卡面/设置框说明影响范围。
4. **任务 owner 独立。** 项目 worker 自己干时，任务 `profile` 设为项目 worker；指派别人时，任务 `profile` 设为指定 worker。任务详情同时显示「任务负责人」和「项目负责 worker」，不混为一个人。
5. **子任务继承任务 owner（现有规则）。** 子任务向任务 owner 汇报；项目 worker 不直接接受子任务报告；项目视图只聚合。
6. **权限不外溢。** `create-task`/`assign-worker` 只作用于当前项目、当前 Mandate 的 capability/scope 内；不能创建项目外任务、不能把任务移出项目、不能扩大 scope。action level 仍只管外部动作，不用于授予这两个能力。

### 2.4 不破坏现有接口与数据

- **旧 Ticket 不变语义：** 缺省 `kind='task'`、`projectTicketId` 为空；旧根任务仍走原有 Decision/Mandate/Attention/结束。
- **`GET tasks` 兼容：** `tasks` 仍返回根任务；项目 Ticket 作为 `kind='project'` 从 `tasks` 排除，只出现在新 `projects`；任务即使带 `projectTicketId` 也仍是根，旧扁平列表不丢任务。
- **`GET tasks/:id` 兼容：** `task`/`children` 不变；`TaskView` 现有 `kind: 'ticket' | 'review'` **保持不变**，只加可选 `ticketKind?: 'task' | 'subtask'`（派生层级）与 `projectTicketId`；不复用/覆盖 `kind`，避免 review 行渲染被破坏。
- **`GET overview` 兼容：** 通知只加可选 `projectTicketId`/`projectName`；不新增通知持久化。
- **项目 Ticket 不出现在旧客户端：** 旧客户端忽略 `projects`；`GET tasks` 过滤 `kind='project'`，不会把项目当任务渲染。
- **没有 KV 覆盖层：** 不写 `task-catalogue.v1`、不新增 Project 表；项目就是 Ticket，读不到项目时就是没有项目。
- **回退：** 关闭 `ux.projects.v1` 时项目投影消失，回到旧扁平任务页；Ticket 上的新字段保留但不被旧界面读取，不删数据。
### 2.5 项目协调 Session 与项目内任务受理

**项目协调 Session。** 项目创建时，主会话为项目 Ticket 建一个 `worker-<projectTicketId>` 协调 Session，绑定项目 Ticket 的 `profile`（负责 worker）。它不是任务 Assignment：没有交付物、验收和任务执行队列，只承载项目级输入（同项目新需求、建任务/派任务请求）和项目摘要。主会话识别到同一项目的新需求时，把它作为 Input 投到这个 Session；该 Session 持有项目 Mandate 的 `create-task`/`assign-worker` 能力，并在 Session 内做 scope/所有权检查。

**任务受理契约（新增；需产品/安全确认）。** `create-task` 不直接伪造 Ticket，也不让 worker 自签 Decision；它把任务草稿交给「现有 Decision 模型 + 新增受理 seam」：

1. **前置检查：** 项目 Ticket 是 active 且 accept 已写入 project Mandate（scope + `create-task`/`assign-worker` capability）；请求来自项目的协调 Session；负责 worker 的 profile 可用；请求带项目 scope、ownerProfileId（默认项目 worker）和幂等键。缺少 capability 时项目级 attention，不静默授予。
2. **生成受理请求，不是 Ticket：** 草稿包含标题、目标、owner、项目归属、预计交付；不含 Approval/验收结论。
3. **现有 Decision 模型 + 新增受理 seam：** 现有 `Decision` 需要 `evalId`/`threadKey`/`triggerIds`，而协调 Session 的草稿没有独立 Thread/Eval；实现必须新增可审计的 admission record（或直接 seam），由受理者（主会话/新增权威）按项目 Mandate 生成根任务 `decisionId` + `mandate`（scope 是项目 scope 的子集），记录 `source=project-coordination` 和项目 Ticket id；默认不新增人工点击。不能把草稿伪装成已有 Trigger，也不能让 worker 自签 Decision。
4. **任务仍是根：** 任务 Ticket 带 `projectTicketId`/`profile`，人的 review/answer/delivery/blocked/failed 语义不变；项目不接管 Approval/outbox。
5. **失败不落半成品：** 任一步检查失败返回拒绝并写项目级 attention；不创建 Ticket，不产生悬空 Decision/Mandate。
6. **assign-worker：** 只在任务尚未开始/允许改派时改 `profile`；校验目标 worker/profile 与项目 scope，不能把任务移出项目或扩大 scope。
7. **安全回退：** 如果产品/安全不接受“项目 Mandate 内自动受理”，退回普通 accept 路径：worker 只创建**受理请求**，由人/主会话确认后签发任务 Mandate；视图和权限文案不变，只是多一次确认。两种路径都必须保留审计和幂等。

这是本设计新增的授权契约，不是对现有 `Decision` 语义的静默扩展；§9 把它列为待产品/安全确认项，实现单必须给出 Decision actor、scope 收窄、重放/幂等和审计的验证。

## 3. 信息架构与交互设计

### 3.1 表面与路由

| 表面 | 当前宿主能力 | 本设计 |
| --- | --- | --- |
| 任务页（右侧栏 `sidebar.right.pane.tab`） | 可注册，宽度由宿主决定 | 默认「项目」；同一套内容在窄/宽宽度自适应 |
| 面板回退页（无右侧栏的宿主） | 插件整页渲染 | 同样默认「项目」，保留「返回主对话」 |
| 主对话 | 宿主页面 | 入口不变；项目识别、新任务、拆解、派发通过主对话 |
| 通知抽屉/浮层 | 插件自己的 frame-wide 浮层 | 按项目分组；归档项目的待办带「已归档」标记；动作指向任务页 |
| 任务详情 | 任务页内选中态 | 项目 → 任务 → 子任务，返回链接回到来源；子任务回父任务 |

任务页内部路由（tab 内状态，不新增宿主 URL）：

```
任务（默认）
├─ 项目列表
│  ├─ 未归档 / 已归档 过滤
│  ├─ 项目 A 详情
│  │  ├─ 任务 A1 详情
│  │  │  └─ 子任务 A1-a 详情
│  │  └─ 任务 A2 详情
│  └─ 新建项目（人工补建；主路径由主会话识别）
├─ 全部任务（扁平，跨项目，含已归档项目任务）
├─ 未归入项目
└─ 通知抽屉（项目 → 任务分组）
```

### 3.2 项目列表（默认页）

**首屏从上到下：**

1. **页头**：面板标签仍是 `任务`，页头标题是 `项目` + 说明「项目由主会话识别，绑定负责 worker；负责 worker 协调并拆任务，任务负责人执行。归档只影响默认列表，不影响任务和待办。」；右侧 `全部任务`、`新建项目`（人工补建；主路径在主会话）。宽面板另有 `返回主对话`；侧栏里主对话就在旁边，不重复放。
2. **未归档 / 已归档 过滤**：项目列表上方一行 `未归档 3` / `已归档 1`；默认 `未归档`，点 `已归档` 进入归档列表：列表内不编辑项目元数据，但可以打开详情、恢复、处理待办。归档入口不再放列表最底部，避免用户找不到。
3. **待你处理条**（有则显示，最多 4 条）：
   - 标题：`等你处理` + 数字徽标；右侧 `全部 N`。
   - 每条：`验收`/`回答`/`处理` 标签 + 任务标题（可点）+ 项目名（归档项目带 `已归档`）+ 时间 + 主按钮（`去验收`/`回答`/`重试`）。
   - 空态：`现在没有等你处理的事。有新结果或需要你确认时会出现在这里。`
4. **项目卡**（宽面板 2 列）：
   - 卡片头：项目名（可点）+ 状态 chip（`待你处理 2` / `有阻塞 1` / `全部完成` / `已归档`）。
   - 一句话目标：最多两行，超出省略；`title` 保留全文。
   - 负责 worker 行：头像 + `负责 worker 开发 worker · 第 2 版`；`title` 说明「项目负责 worker 负责协调与拆任务；任务负责人是实际执行者」。卡面不把项目 worker 写成任务执行人。
   - 进度：`1/4 顶层任务完成` + 细进度条；分母明确是**顶层任务**；子任务完成度在项目详情看。没有任务时不画进度条，卡头显示 `还没有任务`。
   - 待办行：`待你 验收「支付接入」 · 回答「数据迁移」`；没有时 `现在不需要你 · 负责 worker 推进中`；项目级 worker 不可用时第一行是 `修负责 worker「项目」`。
   - 阻塞行（可选）：`阻塞：等激光雷达到货；供应商预计 2 天。`
   - 页脚：`12 分钟前 · 支付接入已就绪` + 来源 chip（`对话`/`GitHub`/`飞书`）；不显示计划编号、Session id。
5. **未归入项目**：默认一条紧凑条 + `全部处理`；进入后每行可 `归入项目`。旧数据全部在这里，直到明确归入。
6. **已归档**：只通过顶部过滤进入；列表内不编辑项目元数据，但每张卡可进详情、恢复、处理待办；不占默认首屏。

**排序：**

1. 有“待你处理”的项目在前，按 `attention` 降序。
2. 其次按 `blocked` 降序。
3. 再按 `updatedAt`（最近活动时间）降序。
4. 名字只作为最后稳定排序。

**空态（没有项目）：**

```
还没有项目。
项目是一条持续的工作线，不是一次任务。告诉小助你要推进什么，
例如「帮我盯 A 系统开发」；主会话识别后会建项目并绑定负责 worker。
[去主对话]  [查看全部任务]
```

**为什么项目列表不用表格：** 项目数量少（个位数到十几个），每张卡要同时表达目标、负责 worker、进度、待办、阻塞和最近活动；表格会把这些压成列，首屏更难读。

### 3.3 项目详情

**头部：**

```
‹ 项目
A 系统开发                                  [更多]
把内部工单系统迁到新架构，12 月中旬前完成切换
负责 worker 开发 worker · 第 2 版    4 个顶层任务 · 1/4 完成    12 分钟前更新
```

- `更多`：`编辑目标`、`换负责 worker`、`归档项目`（写接口后续；只读阶段隐藏或置灰并说明）。**归档不要求任务结束、不要求没有待办**；确认框说明「任务、交付物、待办都保留；项目从默认列表移出，可在已归档查看」。
- 头部下方是**待你处理带**（0–N 条；原型 A 为 2 条），与项目列表同源；点击直达任务详情。
- 再下面是**任务树**和**最近活动**（宽面板右栏；窄面板顺序排列）。

**任务树：**

```
顶层任务 4                                  [展开全部子任务]
▾ 登录改版            进行中    任务负责人 开发 worker · 第 2 版    2 个子任务 · 1 个完成    刚刚
   ● 接口鉴权          已完成    鉴权 worker · 第 1 版    已由上级任务负责人接受
   ● 错误提示文案      等上级验收 文案 worker · 第 3 版    已向开发 worker 汇报    08:20
▸ 支付接入            待你验收  支付 worker · 第 1 版    交付已就绪
▸ 数据迁移            待你回答  数据 worker · 第 2 版    等你回答问题
已完成 1
● 权限梳理            已完成    权限 worker · 第 1 版    昨天
```

- 第一级只放根任务；review Ticket 不作为项目任务。任务行状态已经表达“待你验收/等上级验收”。
- 有子任务的行显示 chevron；默认展开“有待你处理”的根和第一个根；展开只加载 `GET tasks/:id?depth=1`；更深层在任务详情继续展开。
- 每个节点：状态 + 标题 + 任务负责人 + 子任务进度/最近汇报 + 时间；层级缩进约 20px，不使用卡片套卡片。
- 子任务状态：`已完成`、`进行中`、`等上级验收`、`被卡住（上级处理）`、`失败（上级处理）`；只有升级到人的失败/阻塞在根行显示 `需要你处理`。
- 任务详情同时显示「任务负责人」与「项目负责 worker」；项目 worker 不是任务执行者。
- 树不显示计划编号、Assignment、Session id、trace id；这些在任务详情的 E2 折叠区。

**最近活动：** 5 条以内 `时间 · 任务标题 · 一句话事件`；点击跳任务；不显示原始日志、模型名、token。

### 3.4 任务 / 子任务详情

**共同排序：**

1. 返回链接回到**来源**：`‹ 项目`、`‹ A 系统开发`、`‹ 待你处理`、`‹ 全部任务`、`‹ 未归入项目`、`‹ 已归档`；子任务回父任务。
2. 标题、状态、来源、任务负责人（子任务同时显示上级任务负责人）；根任务另显示项目负责 worker，不混为执行者。
3. **需要你做什么**（仅当人待处理）：一句结论 + 主按钮 + 次按钮 + 不处理后果。
4. **结果 / 交付物**：结果、交付物列表、验收条件；子任务交付物标明“由上级任务负责人接受”，不出现人的批准按钮。
5. **下一步 / 预计**：非待人处理时显示；不编时间。
6. **谁在做**：任务负责人 + 角色；根任务加项目负责 worker；子任务加上级任务负责人；profile 未知写“默认执行配置”，不暴露内部 id。
7. **子任务**：有子节点就显示；深层继续；叶子显示 `请负责人拆解` 的说明入口。
8. **阻塞 / 向上汇报**：阻塞原因和等待方写在顶部 note；父的判断历史用人的话写。
9. **汇报历史**：按时间倒序，最多最近若干条。
10. **来源**：对话/飞书/GitHub/邮件等 chip。
11. **执行会话**：默认折叠；`打开执行会话` + 技术详情（E2）。

**关键正确性：**

- 子任务“完成”只代表交付给父任务负责人；默认面写 `已向开发 worker 汇报`，父接受后写 `已由上级任务负责人接受`，不等于人的最终验收。
- 人的验收按钮只出现在根任务；子任务不提供 `批准`，避免绕过父审查链。
- 被阻塞的**子任务**且祖先 owner 还能处理时，不显示“待你处理”，显示 `等负责人处理`；根任务 blocked/failed 直接进“待你处理”。
- 轻量 Ticket 没有 owner/worker/子任务；显示 `轻量执行`。

### 3.5 交互、窄宽与无障碍

- **下钻/返回**：项目卡进详情；任务行进详情；返回保留来源；`Esc` 从抽屉/弹窗返回；实现需保留滚动位置。
- **选中态**：右侧栏一次一个详情；宽面板项目详情树 + 最近活动两栏；窄宽度单列。
- **键盘**：项目名/任务主体是 `<button>`；展开是独立可聚焦按钮；抽屉 `Esc` 关闭并还原焦点；确认框先聚焦主按钮，危险动作先聚焦取消。
- **响应式**：宽面板（>1180）卡两列/详情两栏；侧栏 620 单列；<620 只做 CSS 约束，未真机验证。
- **状态轮询**：沿用 `TasksViewClient` 5 秒轮询；详情按需加载；通知/待办与任务列表同源。
- **动作反馈**：成功 toast + 三处同步；失败保留条目并显示原因；审批 revision 变化提示重看。

### 3.6 规则：项目、任务、子任务怎么产生

#### 项目（`kind='project'`）

必须同时满足：

1. **主会话识别，或人明确要求。** 主会话从用户需求识别出持续工作线后，创建项目 Ticket 并绑定负责 worker；项目名不是任务标题的自动截断。人也可以在明确说“建一个项目”时创建。
2. **有一个可用的负责 worker。** 选择 profile head；空/停用不做默认回退，显示项目级 attention。
3. **至少一个任务，或明确是“还没有任务的规划项目”。** 空项目允许，但卡片显示“还没有任务”。
4. **不是单次任务、review Ticket、子 Ticket、计划编号、Workspace/Space。**

允许“把一个已有根任务提升为项目”：用任务标题作项目名、任务 Goal 作目标、任务 profile 作负责 worker，然后新建项目 Ticket 并把任务 `projectTicketId` 指向它；任务本身不改授权、不复制交付物。

**项目协调与归档路径：** 项目创建时同时建立 §2.5 的项目协调 Session；同一项目的新需求由主会话投到该 Session。归档/恢复可走项目设置，也可由主会话按用户明确指令执行：主会话按项目名解析，歧义时反问，确认后写 `archivedAt`；不自动归档，不因任务完成自动归档。

不允许：

- 按标题/计划编号/来源/工作区自动新建项目。
- 把 review Ticket 或子 Ticket 当作项目。
- 项目嵌套项目（v1）。
- 把“同一来源的多个任务”自动并成一个项目；必须主会话识别/人确认。

#### 任务（根 Ticket，`kind='task'`）

- **主路径：** 主会话识别需求 → 若属于已有项目，直接派给项目负责 worker；若是新项目，先建项目 Ticket 并绑定负责 worker，再由该 worker 建任务。
- **项目负责 worker 创建任务：** 使用 `create-task` 能力，在项目协调 Session 里提交任务草稿；按 §2.5 的受理契约，由现有 Decision 模型 + 新增受理 seam 签发任务 Mandate（scope 收窄，actor=受理者，不是 worker 自签），默认不新增人工点击，仍保留人的 attention/验收；owner 可以是项目 worker 自己，也可以是 `assign-worker` 指定的其他 worker。若产品/安全不接受自动受理，退回普通 accept：worker 只提交请求，由人/主会话确认。
- **主会话/人明确在项目上下文里提需求** 时，可把 `projectTicketId` 带进受理；项目归属不改变任务授权。
- **已有未归入任务：** 在“未归入项目”里归入；只写 `projectTicketId`，不改任务 owner/授权/交付物。
- **页面不直接造 Ticket：** 项目页的按钮只打开主对话/复制建议句；宿主没有预填输入框扩展点。
- **任务结束不结束项目**；项目由人明确归档/恢复。

#### 子任务（现有 `parentTicketId` 子 Ticket）

| 方式 | 谁发起 | 是否自动 | 结果 |
| --- | --- | --- | --- |
| 任务 owner 在运行时拆解 | 根/子 Ticket 的 owner | 是（owner 决定，不是视图） | 现有 `orchestrator_child`；子 Ticket 有独立 owner/worker，继承任务授权，向任务 owner 汇报；`projectTicketId` 继承。 |
| 人请求拆解 | 人 | 否 | 在任务详情/对话里说“请负责人拆解”；作为给 owner 的输入，由 owner 决定。 |
| 标题/计划编号派生 | 无 | **不允许** | 计划树/图只是标签，不生成 Ticket。 |
| review 自动挂载 | 现有审查流程 | 是 | review Ticket 挂被审任务，不算项目任务。 |
| subagent/Session 派生 | 执行器 | 否 | 只是执行细节，不成为任务节点。 |

**为什么层级会变多/变少：** 只有 owner 认为工作需要独立负责人、独立交付和独立汇报时才拆；没有拆的任务保持叶子。项目视图提供“请负责人拆解”的入口，但不把“拆”变成 UI 的强制步骤。

**拆分上限（沿用现有）：** 深度最多 5 层、直接子节点宽度和单根 live 子节点配额由 kernel 约束控制；视图不绕过。

## 4. 通知与待处理

### 4.1 什么事件主动打扰人

| 事件 | 主动打扰（浮层/弹窗） | 归属 | 说明 |
| --- | --- | --- | --- |
| 根任务交付就绪，待人验收 | 是，一次 | 项目 + 根 | 人的验收只在这里。 |
| 根任务提出需要人回答的问题 | 是，一次 | 项目 + 根 | 问题原文来自 `Attention.question`。 |
| 根任务失败/阻塞 | 是，一次 | 项目 + 根 | 根任务已经停下，必须人决定重试/停止/改派。 |
| 子任务失败/阻塞，且没有在世祖先 owner | 是，一次，合并到根 | 项目 + 根（附子任务名） | 不单独给子任务发第二条通知。 |
| 项目负责 worker 不可用 | 是，一次 | 项目 | 影响未来任务；不是某个任务失败。 |
| 子任务就绪，等父任务负责人验收 | **否** | 父 owner 队列 | 任务树显示「等上级验收」。 |
| 常规进度（开始/进行中/子任务接受） | **否** | 项目活动 | 只进最近活动。 |
| 根任务完成/合并结果 | **否**（建议） | 通知中心“进展”组 | 现有实现 `pop` 结果的改法是行为取舍（§9）。 |
| 项目全部完成 | **否** | 项目卡 | 可建议归档，不弹窗。 |
| 归档/恢复项目 | **否** | 项目活动 | 归档不取消任务、不隐藏待办。 |
| 归入/换负责 worker/改名 | **否** | 项目活动 | 元数据变更。 |

原则：**只在“需要人做决定/验收/补信息，且 owner 做不了”时打扰。** 根任务 blocked/failed 本身就是人的决定；只有子任务 blocked/failed 且祖先 owner 还能处理时才安静。

### 4.2 通知如何归到项目/任务

- 每条通知（`Notice`）新增可选 `projectTicketId`、`projectName`、`rootTicketId`、`childTicketId?`；由任务的 `projectTicketId` 解析，不新增通知表。
- **一个根任务至多一条待人通知**：同根 review/answer/failure 更新同一条；子任务升级合并到根，副标题写 `来自子任务：回调签名`。
- 项目卡 `待你处理 N` = 该项目下不同根任务的待人通知数 + 项目级 worker 问题（最多 1）；任务行和抽屉读同一投影，三处数字一致。
- 抽屉分组：`项目名（N）` → 通知；没有项目的任务归 `未归入项目（N）`；归档项目的待办组名带 `（已归档）`，**不被归档过滤隐藏**。项目级 worker 问题作为组第一条，不混进顶层任务数。
- 同一任务跨项目移动时，下一次轮询按新 `projectTicketId` 归组；不保留旧项目副本。
- 已读/未读仍按浏览器已读集合（现有实现），不新增服务端已读表。

### 4.3 “待处理”如何识别

沿用现有 `attentionFor`，不按状态猜：

| 条件 | 是否人的待处理 | 依据 |
| --- | --- | --- |
| 根任务 `review`（交付待人验收） | 是 | `Attention`/`review` 投影 |
| 根任务 `answer`（有 `Attention.question`） | 是 | `Ticket.attention` |
| 根任务 `delivery`（消息未送达） | 是 | `attentionFor` |
| 根任务 `blocked`/`failed` | 是 | 根任务已经停下，只有人能决定重试/停止/改派 |
| 根 `endPending` 且 owner 不可用 | 是 | `attentionFor` |
| 子任务 `review`（等父验收） | 否 | 父 owner 的队列 |
| 子任务 `blocked`/`failed` 但祖先是可用 owner | 否 | 祖先 owner 处理 |
| 子任务 `blocked`/`failed` 且无可用祖先 owner | 是，升级到根 | `attentionFor` 现有规则 |
| `working`/`queued`/`idle` | 否 | 不需要人 |
| 项目负责 worker 缺失/停用 | 项目级是 | 本设计新增，显式元数据问题 |

**解释“为什么是我”的三段式（复用现有 Notice 字段）：** `what`（发生了什么/对象/证据）、`next`（主/次动作）、`consequence`（不处理会怎样；不夸大、不编时间）。

### 4.4 具体文案与层级

| 场景 | 标题 | what | next | consequence | 主/次动作 |
| --- | --- | --- | --- | --- | --- |
| 待人验收 | `「支付接入」的交付已就绪` | `支付回调已接通，灰度 10% 验证通过；2 个文件、2 条验收条件。` | `查看并验收，或退回修改。` | `不处理会一直停在这里，负责人不会继续。` | `去验收` / `查看任务` |
| 待人回答 | `「数据迁移」需要你回答` | `历史订单要保留几年？只读查询要不要一起保留？` | `回答后负责人继续。` | `不回答，这个任务会一直停在这里。` | `回答` / `查看任务` |
| 根失败/阻塞 | `「整理迁移说明」失败了，负责人已停止` | `连续 2 次失败：没有权限读取迁移目录。` | `重试会重新开始；停止会结束这个任务。` | `不处理，任务会停在失败状态。` | `重试` / `查看任务` |
| 子任务升级 | `「A 系统开发 › 支付接入 › 回调签名」卡住了` | `子任务失败，上级任务负责人不可用。` | `查看并处理：退回重试、改派或停止。` | `子任务不会自己恢复。` | `查看并处理` |
| 子任务等父验收 | 任务树行：`等上级验收` | `已向开发 worker 汇报，等它判断。` | — | — | 不是通知 |
| 项目 worker 不可用 | `「B 桌面机器人研究」的负责 worker 不可用` | `原 worker/profile 已停用；新任务无法绑定它。` | `选择一个负责 worker，或修好配置。` | `已有任务不受影响；新任务要等你选。` | `选择负责 worker` |
| 项目全部完成 | 项目卡：`全部完成` | `4/4 个顶层任务结束。` | `可以归档项目。` | — | `归档`（可选） |
| 归档项目的待办 | 抽屉组名：`D 旧站下线（已归档）` | 同任务待办三段式 | 同任务动作 | 同任务后果 | 同任务 |
| 无待办 | `现在没有等你处理的事。` | `有新结果或需要你确认时会出现在这里。` | — | — | — |

层级：

- **项目卡**：只放计数和一句待办摘要。
- **项目详情**：待办带一行一条，显示全部待人项；更多滚动，不截断计数。
- **任务详情**：动作卡写结论/下一步/后果；交付物、验收条件、汇报历史分别承载证据。
- **通知抽屉**：项目分组 + 条目三段式；同一根重复事件合并；归档组带标记。
- **浮层**：只显示最新一条待人事件，标题 + 主按钮 + `查看全部`；原型用抽屉演示，浮层只做文案设计（§7.3）。

### 4.5 一键处理与失败

| 动作 | 现有能力 | 设计 |
| --- | --- | --- |
| 验收/批准 | `POST tickets/:id/approve`（带 revision） | 确认框展示交付摘要/验收条件；确认后结束根任务；revision 变化拒绝并提示重看。 |
| 退回 | 没有专用 HTTP 动作；现有 `Decision.kind='reopen'` | 一期填原因 + 定位到现有重开路径；新增 `POST tickets/:id/return` 后再升级；原型标注目标态。 |
| 重试 | `POST tickets/:id/retry` | 确认后新 attempt；失败保留通知并显示原因。 |
| 停止 | `POST tickets/:id/stop` | 确认；按现有规则结束任务/子任务链。 |
| 回答 | 现在打开来源线程/触发页；没有 `POST tickets/:id/answer` | 一期定位到可回答处并复制建议句；后续加 answer API 再升级。 |
| 归入项目/建项目 | 本设计新增写路径（未实现） | 建项目/归入只写 Ticket 字段；失败回滚，不乐观删除。 |
| 换项目负责 worker | 本设计新增写路径（未实现） | 只影响未来任务；已有任务不变；成功 toast 说明影响范围。 |
| 归档/恢复项目 | 本设计新增写路径（未实现） | 写 `archivedAt`；归档不取消任务、不隐藏待办；恢复回到列表。 |

**动作后反馈：** 成功 toast + 三处计数同步；任务结束时项目卡进度更新、待办少一条。失败保留条目、显示具体错误和重试入口；不把失败当成功。批量 `全部 N` 打开抽屉逐条处理；v1 不做“一键全部批准”。

### 4.6 与现有通知的关系

- 本设计的“待你处理”抽屉只承载 `attention`（人必须行动），**不是完整通知中心**。现有 `noticeItems` 的 `attention/progress/system` 分组和通知中心不删除；`progress/system` 仍在原通知中心查看，后续再按项目归组。
- 系统问题仍归 `system`，不强行归项目；影响多个项目的系统问题在原通知中心顶部单独一组。
- 任务通知动作保持现有 `view/approve/retry` 等；新增 `answer`（定位）和 `assign-project`（归入）是后续写路径。
- 现有结果通知 `pop: true` 的建议改法是行为取舍（§9），不在本单实现。原型不演示浮层，只用抽屉和首屏待办条。

## 5. 已确认的宿主能力边界

| 能力 | 结论 | 依据/取舍 |
| --- | --- | --- |
| 在右侧栏打开任务页 | **可用** | `sidebar.right.pane.tab` + `sidebarRight.openTab`；[028](028-plugin-main-page.zh.md)。 |
| 无右侧栏时用面板辅助页 | **可用** | `embedded App` + 返回条；现有回退。 |
| 打开主对话/执行会话 | **可用** | `openSession(id)`；现有。 |
| 读取任务/通知/交付物/负责人 profile | **可用（插件自己的管理 API）** | `GET tasks`、`GET tasks/:id`、`GET overview`、`GET profiles`；加法字段。 |
| 插件自己的通知浮层/抽屉 | **可用** | frame-wide overlay；现有。 |
| 插件新增项目/归入/换负责 worker 写接口 | **可用（插件 API，本单不实现）** | 写 Ticket 的 `kind`/`projectTicketId`/`profile`/`archivedAt`，不写覆盖层。 |
| 预填主对话输入框/在页面内直接造 Ticket | **不可用（当前无扩展点）** | 设计为打开主对话 + 建议句；不假装。 |
| 替换宿主导航/侧栏/工作区/设置 | **不可用** | [022](022-harness-extension-requests.zh.md)、[028](028-plugin-main-page.zh.md) §4。 |
| 宿主原生通知中心/全局未读一级入口 | **不可用** | 插件浮层/抽屉是自有 surface。 |
| 多人、成员、角色、跨设备 | **不在模型内** | 当前单用户本地；项目没有成员表。 |
| 项目嵌套/子项目 | **不做（v1）** | 用户要的是顶级项目 → 任务 → 子任务。 |
| 自动归类/LLM 建议 | **可选、默认关闭** | 只有主会话识别/人确认才写；建议不是事实。 |

**结论：** 项目视图与通知归组不需要宿主改动；真正的新任务是 Ticket 字段 + 项目 Ticket/协调 Session 创建 + 项目 worker 的 `create-task`/`assign-worker` 能力 + §2.5 的任务受理契约。设计不把写能力包装成宿主已支持，也不为了视觉隐藏宿主 chrome。

## 6. 迁移可行性：从现有数据能不能长出层级

### 6.1 真实数据结论

| 问题 | 结论 | 证据 |
| --- | --- | --- |
| 现有数据能生成项目吗？ | **不能，除非主会话/人明确建。** 没有项目字段；标题/来源/scope 都没有“项目”语义。 | 项目代码为空；真实数据无项目记录。 |
| 现有数据能生成子任务吗？ | **只有已经存在的子 Ticket。** 当前为 0；不能从计划树、subagent Session、标题缩进追溯。 | `parentTicketId` 非空 0；`delegation` 只由 owner 显式创建。 |
| 计划树/图能当项目树吗？ | **不能。** 计划标签 35 个标题/40 个 scope，0 个子 Ticket。 | `ownership.ts` 的 `planOf` 只读文本，不写数据。 |
| 子任务为什么少？ | 创建需要 owner 运行时显式 `orchestrator_child`；视图不提供拆解入口；没有项目上下文提示“这条线还要拆”。 | `orchestrator_child` 工具、现有任务页只展示一层子节点。 |
| owner 能直接显示吗？ | **多数不能。** 0 个 Ticket 有 profile 快照；历史/当前任务显示“默认执行配置”。 | 真实数据聚合；`Ticket.profile` 可选。 |

**所以迁移顺序是：先加字段并把旧 Ticket 读成任务，再由主会话/人明确建项目和绑定负责 worker，最后才让项目 worker 建任务/拆任务。** 直接上“自动生成项目/子任务”只会把猜测写进数据。

### 6.2 分阶段迁移

| 阶段 | 交付 | 数据写入 | 验收 |
| --- | --- | --- | --- |
| P0 字段与只读 | Ticket 加可选 `kind`/`projectTicketId`/`archivedAt`/`goal`；旧 Ticket 读作 task/未归入；项目列表/详情/任务树读取；没有项目时显示未归入；`kind` 只做 project/task，子任务仍看 `parentTicketId` | 无；读空项目 | 旧任务不被隐藏；旧 `GET tasks` 仍返回根任务；回退开关可回旧列表。 |
| P1 项目 Ticket 与负责 worker | 主会话/人建项目：创建 `kind='project'` Ticket，经 accept 写 project Mandate（scope + capabilities），绑定可用 profile，建立项目协调 Session；改名/目标/换负责 worker/归档/恢复 | 写项目 Ticket 的 `mandate`/`profile`/`goal`/`archivedAt` | 项目卡显示负责 worker；空项目允许；项目不执行任务、不验收；能力存在才可建任务；协调 Session 可接收同项目需求。 |
| P2 项目任务与 worker 能力 | 主会话识别同一项目的新需求，投到项目协调 Session；worker 用 `create-task` 提交草稿、`assign-worker` 指派；任务带 `projectTicketId` | 走 §2.5 的现有 Decision 模型 + 新增受理 seam 写任务 Decision/Mandate + `projectTicketId`/`profile`；不伪造 Decision | 新任务出现在项目；旧任务不改；worker 能力受 Mandate/capability/scope 约束；人仍是任务验收者；若安全不批准自动受理，退回人工 accept。 |
| P3 树/详情/归档过滤 | 项目树递归、任务/子任务详情、未归档/已归档过滤、归档项目任务仍在全部任务 | 无新增持久化 | 下钻/返回正确；归档不隐藏待办；已归档可恢复。 |
| P4 通知归组 | notice 带 `projectTicketId`；项目卡/详情/抽屉三处一致；归档项目待办带标记 | 无新增持久化 | 计数一致；子任务父审不打扰人；归档待办不被隐藏。 |
| P5 可选建议 | 主会话对“像同一项目”的建议，默认关闭，人确认才建/归入 | 只在确认后写 | 不自动建项目；可关闭/回退。 |

### 6.3 创建流程本身就是设计

上一版 §6.3 写「必须先改创建流程」，容易读成先做项目视图、创建以后再说。review 之后应说清楚：

1. **创建路径就是：主会话识别项目 → 建 `kind='project'` 的 Ticket 并绑定负责 worker + 项目协调 Session → 该 worker 在协调 Session 里创建任务/指派 worker。** 不是项目视图先造节点。
2. **P1 先让项目 Ticket 和负责 worker 可建；P2 才让 worker 建任务/指派。** 没有 P1，P2 没有项目可挂；没有 P2，项目卡只能显示空项目/未归入任务。
3. **P0 先做字段和只读**，保证旧任务不丢；不要先做自动归组/标题猜项目。
4. **视图只读**：项目页的「新建项目」是人工补建/演示；真正主路径在主会话。宿主没有预填输入框，页面不直接造 Ticket。
5. **人的验收不被项目 worker 取代**：项目 worker 创建/指派任务，但任务的 review/answer/blocked/failed 仍是人的 attention；子任务父审仍是任务 owner。

### 6.4 兼容、回退与不变量

- **不变量：** 任务仍是根授权单元，并有自己的 Mandate/Decision（由 §2.5 的现有 Decision 模型 + 新增受理 seam 签发，scope 收窄）；子 Ticket 没有 Mandate/Decision；Approval/outbox 的 `ticketId` 仍是根任务；项目 Ticket 不执行任务、不交付、不批准，但有独立的项目协调 Session；`projectTicketId` 只做归属；子任务 `parentTicketId`/`rootTicketId` 语义不变。
- **兼容：** Ticket 只加可选字段；`GET tasks` 的 `tasks` 仍是根任务（项目 Ticket 被排除）；`GET tasks/:id` 的 `task`/`children` 不变；旧客户端忽略新字段。
- **回退：** 关 `ux.projects.v1` → 项目投影消失，回旧任务页；Ticket 新字段保留、不删任务/归属；重新打开恢复。
- **损坏/空值：** `projectTicketId` 指向不存在/非项目 Ticket 时读作未归入并提示，不猜项目；项目 Ticket profile 不可用 → 项目级 attention，已有任务不动。
- **审计：** 项目创建/改名/换负责 worker/归档/恢复、任务归入/移出写现有 activity/审计；不新增通知实体，不触发 Eval。
- **旧数据迁移：** 不批量创建项目、不批量写 `projectTicketId`；旧 Ticket 默认 `kind='task'`、`projectTicketId=null`；只在新写路径写字段。

## 7. 可点击原型与同视口证据

### 7.1 原型

- 文件：[docs/prototypes/task-projects.html](prototypes/task-projects.html)（单文件，无外部依赖，离线可点）。
- 合成数据：三个未归档项目 `A 系统开发`、`B 桌面机器人研究`、`C 旅行计划`，一个已归档项目 `D 旧站下线`，加“未归入项目”；任务/worker/交付物/通知均为合成，不含真实飞书内容、账号或会话名。
- 可交互：项目卡 → 项目详情 → 任务/子任务详情；返回链接回到来源；展开/收起子任务；`全部任务`/`未归入项目`/`已归档`；通知抽屉；验收/回答/重试/归入/建项目/项目设置弹窗；`Esc` 关闭。
- 原型模式：默认右侧栏（1440×900，左栏 + 主对话 + 任务面板）；`?layout=wide` 宽面板；`?layout=narrow` 620px 单列；`?screen=project&project=a`、`?screen=task&task=a2`、`?screen=notices`、`?screen=all`、`?screen=unassigned`、`?screen=archived` 用于直接打开状态；`?modal=review&task=a2`、`?modal=create-project`、`?modal=archive-project&project=a`、`?modal=guide` 用于直接打开弹窗；`?clean=1` 隐藏原型导览按钮。
- 导览按钮（左下角）提供各屏跳转和“重置演示”；截图时用 `?clean=1`。
- 本版原型按 review 增加：项目卡/详情显示「负责 worker」；`未归档 / 已归档` 过滤；归档不再拦截未结束/待办任务，且归档有确认框；归档项目的待办仍进“待你处理”；新建/设置项目只提供可用 worker（不含默认执行配置）；新建项目文案说明「主会话识别优先，此处人工补建」。

### 7.2 同视口证据

主对照（同视口 1440×900、同主题、同语言；**Before 是当前实现的本地面板回退页，After 是合成 fixture 的宽面板原型；surface/布局不同、数据不同**）：

| 场景 | Before（当前实现，`main@46e1089`） | After（本分支设计原型） |
| --- | --- | --- |
| 任务页首屏：无项目层的任务列表 → 项目列表（1440×900，浅色，zh-CN） | [before-tasks.png](images/plugin-main-page/before-tasks.png)：当前**面板回退页**（全页），列表/任务树/计划树/图与 4 条待处理 | [after-projects-wide.png](images/task-projects/after-projects-wide.png)：宽面板项目卡 + 待你处理 + 未归档/已归档过滤 + 未归入项目 |

补充对照与单屏证据（**不是严格同一状态**，用于看布局/下钻/边界；不能替代上面的主对照）：

| 场景 | Before | After |
| --- | --- | --- |
| 右侧栏项目列表（1440×900） | [after-side-tasks.png](images/plugin-main-page/after-side-tasks.png)：当前右侧栏任务页，**该 fixture 没有任务，只用于看布局**；文件名为历史批次命名 | [after-projects-side.png](images/task-projects/after-projects-side.png)：同宽度项目列表（合成项目；含负责 worker 与归档过滤） |
| 项目详情（1440×900） | **无当前等价物**：当前没有“项目”这一层 | 侧栏：[after-project-detail-side.png](images/task-projects/after-project-detail-side.png)；宽面板：[after-project-detail-wide.png](images/task-projects/after-project-detail-wide.png) |
| 任务详情：负责人/交付/阻塞/汇报（1440×900） | [after-task-detail.png](images/plugin-main-page/after-task-detail.png)：当前实现任务详情（全宽；文件名为历史批次命名，**不作严格同 revision 基线**） | [after-task-detail-side.png](images/task-projects/after-task-detail-side.png)：侧栏任务详情（待人验收；任务负责人 + 项目负责 worker） |
| 子任务等父验收（1440×900） | 当前无“子任务详情”等价截图 | [after-child-waiting-side.png](images/task-projects/after-child-waiting-side.png)：明确写“等上级任务负责人验收，现在不需要你” |
| 全部任务扁平查找（1440×900） | [before-tasks.png](images/plugin-main-page/before-tasks.png) 的列表页 | [after-all-side.png](images/task-projects/after-all-side.png)：跨项目顶层任务 + 搜索/筛选；项目任务仍是根 |
| 通知/待处理：按项目归组（1440×900） | [before-notifications.png](images/plugin-main-page/before-notifications.png)：当前通知中心（全部/需要你/进展/系统，按任务混排） | [after-notices-side.png](images/task-projects/after-notices-side.png)：本设计的待处理抽屉（只 attention，按项目分组；归档组带标记）。**不是同一筛选状态；After 不替代现有通知中心（§4.6）** |
| 已归档过滤（1440×900） | 当前没有项目归档 | [after-archived-side.png](images/task-projects/after-archived-side.png)：`已归档` 过滤 + 归档卡 + 恢复入口；说明任务/待办仍保留 |
| 窄面板（620×900） | **无同宽当前截图**；只有 1440 的右侧栏基线 | [after-projects-narrow.png](images/task-projects/after-projects-narrow.png)：620 单列，含归档过滤 |

**验收确认弹窗：** [after-review-modal.png](images/task-projects/after-review-modal.png)（1440×900；展示交付物、验收条件、取消/确认验收；不是独立 Before/After 对照）。

**主对照的限制：** Before 是当前面板回退页（全页），After 是宽面板原型；两者不是同一 surface。原因是当前没有项目层，无法在同一 surface 截到“项目列表”的真实基线；`after-side-tasks.png` 才是右侧栏布局，但它的 fixture 是 0 任务，不能替代主对照。因此主对照只证明“首屏信息结构”的变化，不宣称同布局或像素级基线。

**截图来源与方法：**

- 主对照和通知/侧栏 Before 是仓库里当前实现的真实界面截图（本地状态，不是合成 fixture；任务名/日期来自本地数据），不是 `main@46e1089` 的逐像素基线；`after-side-tasks.png` 的 fixture 是 0 任务，只用于布局对照。任务详情 Before 是当前实现参考，文件名历史批次命名，不宣称与 `46e1089` 逐像素一致。
- After 全部来自本分支 `docs/prototypes/task-projects.html`，用 Chrome headless（CDP，DPR=1，1440×900 或 620×900，浅色，zh-CN）截取；**After 是原型，不是已实现界面**。
- 两边不是同一批任务/项目数据；主对照比较“首屏能不能回答我有哪几个项目、各自负责 worker 和待处理”，不是像素级重绘。实现 PR 仍需按同一 fixture 补像素级对照。
- 没有真实飞书内容、账号或会话名；After 的姓名/项目均为合成。

**已实际点过的交互：** 验收通过/退回、回答问题、重试、归入项目、新建空项目（负责 worker 不含默认执行配置）、全部任务搜索与状态筛选、通知抽屉分组、归档项目待办显示、归档/恢复、归档确认框、返回来源（项目列表/项目详情/全部任务/未归入/待你处理/归档项目详情）、三层子任务展开与返回、项目设置保存、`Esc` 关闭弹窗/抽屉。以上均只改内存 fixture；没有调用真实 API。归档项目的待人任务从默认「等你处理」进入后返回「已归档」的路径已实测；项目级 worker 不可用用注入数据验过项目卡/首屏/抽屉，但未截图。

### 7.3 原型限制

- 纯前端内存数据，刷新/重置回到初始；动作是演示，不调用真实 API，不写任何记录。
- 项目负责 worker 是目标态示例；真实数据当前 0 个 profile 快照，实施前要先配置 worker/profile，或显示项目级 attention；不会静默回退默认执行配置。
- 页内回答和页内退回都是目标态：当前没有 `POST tickets/:id/answer` 或 `POST tickets/:id/return`；页内回答只能打开来源线程/任务页并复制建议句，退回要走续做/重新受理。原型按钮分别写“提交回答（原型）”“确认退回（原型）”。
- 项目 Ticket 的 Mandate、§2.5 任务受理契约、项目协调 Session、worker `create-task`/`assign-worker` 的实现细节（capability/scope/所有权/幂等检查）需要实现单验证；本单只给字段/流程/权限边界，不声称已实现。
- 未做移动端真机、真实数据回放、10 秒陌生用户实测；这些留给实现/评审。
- 浮层未在原型演示；§4.4 的浮层文案是设计稿，原型用抽屉表达同一组待办。
- fixture 没有“项目负责 worker 不可用”的项目；项目级 attention 用注入数据验证过，但没有截图。
- 620px 只验证了项目列表；更窄宽度、页头动作收起、移动端键盘未验证。
- 原型演练到 3 层子任务（A 的登录改版 → 错误提示文案 → 回调签名文案）；递归代码支持 5 层，但没有为每层截图。

## 8. 验证与独立 review

### 8.1 自查

1. **项目/任务/子任务是否都是 Ticket？** 是：`Ticket.kind` 只区分 project/task，项目归属用 `projectTicketId`，子任务仍用现有 `parentTicketId`；没有 KV 覆盖层、没有 Project 表。项目是容器 Ticket，任务仍是根授权单元，子任务仍是现有 delegation 子 Ticket。`TaskView.kind` 现有 `ticket/review` 不改，层级另用派生的 `ticketKind`。
2. **负责 worker 是否清楚？** 项目卡/详情显示「负责 worker」；项目 worker 与任务负责人分开；项目 worker 不替人验收；不可用时项目级 attention；真实数据没 profile 时不假装有具名 worker。
3. **创建路径是否按 review？** 主会话识别项目 → 项目 Ticket 绑定负责 worker + 项目协调 Session → worker 在协调 Session 创建任务/指派 worker；同一项目新需求直接投给该 Session；视图不直接造 Ticket。
4. **归档是否按 review？** 未归档/已归档过滤；默认未归档；已归档可查看/恢复；归档不要求任务结束、不隐藏待办；归档项目任务仍在全部任务，待人项仍在抽屉并带标记。
5. **待处理是否正确？** 根任务 review/answer/delivery/blocked/failed 是人；子任务等父审不是；项目级 worker 问题单列；三处计数同源。
6. **是否破坏接口/数据？** Ticket 只加可选字段；旧 Ticket 默认 task/未归入；`GET tasks` 仍返回根任务，项目 Ticket 排除；子任务语义不变；回退开关可回旧列表。
7. **是否假装宿主能力？** 没有：项目页仍在右侧栏/面板；新任务/拆解走主对话；不预填输入框；不替换宿主导航/通知中心；不做多人/跨设备。

### 8.2 独立 review 与人工 review

**本轮人工 review（2026-11-14，对话，不是 GitHub review）：**

1. 方向基本正确；项目由主会话根据用户需求识别，项目有负责 worker；同一项目的新需求直接派给项目 worker；该 worker 可拆任务（自己干=负责人自己，指派他人=指定 worker）；worker 需要有创建任务和指派 worker 权限。
2. 项目有归档状态；用户明确说明或手动归档；界面优先显示未归档，也可以查看已归档。
3. 项目、任务、子任务本质上都是 Ticket，只是层级不同；Ticket 增加表示层级归属的字段即可，原有负责人、会话、状态等全部复用。

**处置（本 PR 已改）：**

- 删除 KV `task-catalogue.v1`/`Project` 实体/`ProjectPlacement` 设计；改为 Ticket `kind` + `projectTicketId` + `archivedAt`；任务仍是根授权单元。
- 项目负责 worker 从「默认 profile 绑定、只约束新任务」改为「项目 Ticket 的 profile 快照、必须可用、可创建/指派任务」；增加 `Mandate.capabilities` 的 `create-task`/`assign-worker` 边界。
- 创建路径改为「主会话识别 → 项目 Ticket 负责 worker → worker 建任务/指派」；同一项目新需求直接派项目 worker；删除「必须先改创建流程」的倒置说法，重排 P0–P5。
- 归档改为「未归档/已归档过滤；默认未归档；可归档未结束/有待办项目；任务和待办保留」；删除上一版的归档拦截。
- 原型：项目卡/详情显示负责 worker；顶部归档过滤；归档不再拦截；归档项目待办仍显示；新建项目说明主会话识别优先。
- 截图重拍：After 全部 10 张 + 新增 `after-archived-side.png`，按新文案/过滤重新截取；Before 不变。

**本轮 fresh-context review（2026-11-14，对 `de5eb25`）：** 结论 **not ready**；4 个阻断、9 个非阻断。阻断项与处置：

1. **`TaskView.kind` 冲突：** 现有 `TaskView.kind` 是 `'ticket' | 'review'`，设计却写 `kind?: 'task' | 'subtask'`，会让 review 行渲染错乱。已改为：`Ticket.kind` 只做 `'project' | 'task'`，子任务仍由 `parentTicketId` 表示；`TaskView` 现有 `kind` 不动，另加派生的 `ticketKind`/`projectTicketId`（§2.4、附录 B）。
2. **项目 goal 无存储：** 已新增可选 `Ticket.goal`（项目一句话目标）；`TaskView.goal` 仍是现有 `GoalView` 投影，不混用（§2.1、附录 A/B）。
3. **任务级 Decision/Mandate 自签：** 已删除“worker 自签”的说法，改为 §2.5 的受理契约：项目 worker 只提交草稿，由现有 Decision 模型 + 新增受理 seam 签发任务 Mandate；默认不新增人工点击，但这被明确标为需产品/安全确认的新契约，并提供“普通 accept + 人工确认”的安全回退。
4. **项目 worker 无执行上下文：** 已定义**项目协调 Session**（`worker-<projectTicketId>`，复用现有会话设施，仅协调/建任务/指派，无任务交付/验收）；主会话把同项目需求投到该 Session，能力检查在 Session 内完成（§2.5、§3.6、P1/P2）。

非阻断处置：归档待人任务的返回来源加 `已归档` 分支；`active.map(projectCard)` 不再把数组索引当 `from`；项目负责人下拉移除“默认执行配置”并在创建/保存校验；统一“负责 worker”文案和“项目 Mandate 仅用于协调”的说明；归档加确认框；§3.2 的“只读归档列表”改为“列表不编辑元数据、可详情/恢复/处理待办”；§7.2 明确 Before 是面板回退页、不与 After 同布局；`kind` 不双写 `subtask`，并补层级不变量；`Mandate.capabilities` 改为 project scope allowlist，不再声称按 action level；补主会话归档/恢复路径。原型已按 N1–N5 修改并在 CDP 重测。

**此前独立 review（保留记录）：**

- Review：[PR #86 review comment](https://github.com/touch-agent/dsh-superagent/pull/86#pullrequestreview-5903016804)（对 `4af0c72`；最初 not ready）。处置：负责人说明、根 blocked 语义、三层递归、空项目、归档返回、排序等。
- 复审：[follow-up review](https://github.com/touch-agent/dsh-superagent/pull/86#pullrequestreview-5903147567)（`43c342d`，COMMENTED，不是 approval）结论 ready for human review；非阻断计数 bug 已修。
- **Focused re-review（修复后，同一 fresh-context reviewer）：** 结论 **ready for human review**；四个阻断项全部关闭，原型 N1–N5 在 headless Chrome 复核通过（归档待人返回 `已归档`、项目卡 from 不再是索引、owner 下拉无默认、归档有确认框、无 console error）。剩余 5 个非阻断：P1 写 project Mandate capability、§0 #2 措辞、review 行不计项目任务、Decision admission seam、§8.3 主对照口径；均已按上一条修复并记录在本节/§2.5/附录 A。复审不是 approval，PR 仍由人合并。

### 8.3 已知限制

- 这是设计/原型，不是实现；项目创建/归入/换负责 worker/归档/页内回答都还没有产品代码。
- 项目 Ticket 的 Mandate、§2.5 任务受理契约（现有 Decision 模型 + 新增 admission seam）、项目协调 Session、worker `create-task`/`assign-worker` 的 scope/所有权/幂等检查都需实现单验证；本单给出契约和回退，但不声称已实现。
- 真实数据没有项目、没有子 Ticket、没有 profile 快照；P1 之前项目视图只能显示“未归入项目”。
- 项目协调 Session 是新增运行上下文：它不进入任务执行队列，但需要在实现单证明不会产生第二个执行/审批根；若宿主只能复用主 Session，实现需把项目 scope/capability 挂到主 Session，而不是悄悄让项目 Ticket 变成任务。
- 项目 Mandate 内自动受理是安全/产品取舍；默认方案与人工确认回退都必须在实现前定案，不能把 worker 自签 Decision 作为既成事实。
- 自动建议默认关闭，且永远不自动写；如果产品要求“主会话自动识别并写项目”，需要主会话评估可信信号，不能靠标题猜。
- 现有结果通知会弹浮层；本设计建议改为安静结果，属于行为取舍，需要产品确认。
- 窄宽度（<620px）只做 CSS 规划，未真机/移动端验证。
- Before/After 不是同一 fixture 或 surface；主对照是 1440×900 的面板回退页（Before）与宽面板原型（After），其余对照已在 §7.2 标明限制。

## 9. 待确认的产品取舍

1. **项目负责 worker 与任务负责人的关系？** 本设计：项目 worker 负责协调/创建/指派，任务 owner 执行并接受子任务汇报；项目 worker 不替人验收任务。若产品要项目 worker 作为所有任务的父审，需要另设层级授权，不能混用现有 `parentTicketId`。
2. **结果通知是否还弹浮层？** 本设计建议只有“需要人行动”才弹，结果进通知中心/项目卡；这会改变现有 `pop: true` 的结果通知行为。
3. **是否允许空项目？** 允许（规划用），卡面显示“还没有任务”；若产品要求至少一个任务，改创建校验即可。
4. **页内回答是否要做？** 目标态 `POST tickets/:id/answer` 写 human input；先不做就保持“打开来源 + 复制建议句”，不要伪装一键发送。
5. **项目是否自动归档？** 只建议，不自动；全部完成仍显示，直到人归档。
6. **是否支持子项目/项目嵌套？** v1 不做；`projectTicketId` 只指项目，项目不能再被归入项目。
7. **归档有未结束/待办项目时，任务是否继续执行？** 本设计：归档只影响默认列表，不停止任务、不取消待办；项目 worker 仍会收到/处理待办，待人项仍在抽屉。若产品要“归档即暂停”，需要单独定义暂停语义，不在本设计偷做。
8. **项目 Mandate 内能否自动受理任务？** 这是新的授权/安全契约（§2.5）。默认方案是项目 worker 提交草稿、现有 Decision 模型 + 新增受理 seam 签发任务 Mandate，不新增人工点击；若安全不批准，退回普通 accept（人/主会话确认）。两种路径都不能让 worker 自签 Decision，也不能扩大项目 scope。
9. **项目协调 Session 是否独立？** 本设计需要一个可寻址的协调上下文来承载同项目需求和 `create-task`/`assign-worker` 能力；实现可复用现有 `worker-<ticketId>` 设施，也可把 scope/capability 挂到主 Session。无论哪种，都必须能回答“谁在协调、能力在哪检查、为什么不产生第二个执行/审批根”。

## 附录 A：字段映射（现有 → 项目视图）

| 视图字段 | 来源 | 说明 |
| --- | --- | --- |
| `project.id/name/goal` | `Ticket`（`kind='project'`）的 `id/title/goal` | 项目就是 Ticket；`goal` 是新增的可选字段，项目卡片/详情的一句话目标；`origin` 只是来源，不当目标。 |
| `project.state` | `Ticket.archivedAt` | 有值 = archived；缺省 = active；可恢复。 |
| `project.owner` | 项目 `Ticket.profile` + profiles | 显示 worker/title + revision；空/停用 → 项目级 attention；不静默回退默认配置。 |
| `project.tasks` | `GET tasks` 根 `TaskView` where `projectTicketId=project.id && TaskView.kind !== 'review'` | 任务仍是根；子任务在 `TaskView.children`；review 行不计入项目任务。 |
| `unassigned` | 根 `TaskView` where `projectTicketId` 为空 && `kind !== 'review'` | 旧任务/未归入；review 行不计。 |
| `project.counts.attention` | 过滤后的根 `TaskView.attention` + 项目级 worker 问题 | 只计人；子等待父不计；review 行不计。 |
| `project.counts.blocked` | 过滤后的根+子 `TaskView.status === 'blocked'` | 所有阻塞，含 owner 可处理的子任务；根 blocked 同时进 `attention` 和阻塞行；review 行不计。 |
| `project.counts.done` | 过滤后的根 `ended.outcome` completed/merged，或 `status done` | 不计 dropped/stopped 为完成；review 行不计。 |
| `project.lastActivityAt` | 过滤后的根任务 `updatedAt`/activity 最新 | 只读；review 不计；不新增活动表。 |
| `task.kind` | `TaskView.kind`（现有 `'ticket' \| 'review'`） | **不改**；review 行仍靠它渲染。层级另用 `ticketKind`（派生）。 |
| `task.ticketKind` | `Ticket.parentTicketId` 派生 | `task` = 根任务；`subtask` = 子 Ticket；`Ticket.kind` 只区分 project/task。 |
| `task.projectTicketId` | `Ticket.projectTicketId` | 子任务读时从任务继承；review 从被审任务，但 `kind='review'` 只用于详情链接，不计入 `project.tasks`/counts/`unassigned`。 |
| `task.owner` | `Ticket.profile` + profiles | 任务负责人；历史 ticket 可能为空。 |
| `task.childSummary` | `TaskView.childSummary` | 子任务进度；父审/失败/阻塞分开。 |
| `task.deliverables/review` | `TaskView.deliverables/review` | 交付/验收；子任务接受不是人的验收。 |
| `task.blocker` | `TaskView.blocker` | 阻塞原因与归属。 |
| `notice.projectTicketId` | 任务 `projectTicketId` | 归组；不新增持久化；归档项目通知带 `archived` 标记。 |

## 附录 B：接口草图（加法，未实现）

```ts
// Ticket：只加可选字段，旧数据默认
interface Ticket {
  // ...existing
  kind?: 'project' | 'task'                // default task; subtask = parentTicketId, no kind='subtask'
  projectTicketId?: string                 // project containment; absent = unassigned
  archivedAt?: string                      // project only; active when absent
  goal?: string                            // project only; one-line project goal
}

interface Mandate {
  // ...existing
  capabilities?: ('create-task' | 'assign-worker')[] // project owner worker; project-scope allowlist, not action level
}

// GET tasks（保留现有字段，仅新增）
interface TaskBoardView {
  generatedAt: string
  tasks: TaskView[]             // 仍为根任务；kind='project' 不在这里
  milestones: TaskMilestone[]   // 现有
  totals: { milestones: number; tasks: number; tickets: number; open: number; attention: number }
  projects: ProjectView[]       // 新；项目 Ticket 的只读投影
  unassigned: TaskView[]        // 新：projectTicketId 为空且 kind !== 'review' 的根任务
}

interface ProjectView {
  id: string                    // Ticket.id (kind='project')
  name: string
  goal: string
  owner?: { profile: { id: string; revision: number }; title: string }
  state: 'active' | 'archived'
  counts: { tasks: number; open: number; done: number; attention: number; blocked: number; failed: number }
  lastActivityAt?: string
  tasks: TaskView[]             // 根任务，排除 review；子任务通过 GET tasks/:id 展开
}

// TaskView：只加可选字段；children 语义不变
interface TaskView {
  // ...existing
  kind: 'ticket' | 'review'      // existing; DO NOT overload
  ticketKind?: 'task' | 'subtask' // derived from parentTicketId, not persisted
  projectTicketId?: string
}

// 受理/派发请求（实现单确认，不新增 Project 实体）
// 项目：创建 kind='project' 的 Ticket，需要 project Mandate/Decision 和 ownerProfileId；同步建立项目协调 Session。项目不执行任务。
// 任务：项目 worker 在协调 Session 提交草稿，走 §2.5 的现有 Decision 模型 + 新增受理 seam 签发任务 Mandate；不在 worker 内自签 Decision。
// 安全回退：若不批准项目 Mandate 内自动受理，退回普通 accept（人/主会话确认），任务语义不变。
// worker 工具：create-task（项目内建根任务）、assign-worker（任务尚未开始时改 owner）
```

**读取：** `GET tasks` 的 `tasks` 仍返回根任务；项目 Ticket 只在 `projects`。任务带 `projectTicketId` 仍是根，旧扁平列表不丢。`GET tasks/:id` 的 `task`/`children` 不变。

**写入：** 项目创建/改名/换负责 worker/归档/恢复写项目 Ticket；任务归入/移出写 `projectTicketId`；worker `create-task`/`assign-worker` 写任务 Ticket，但受项目 Mandate/capability/scope 约束（action level 仍只管外部动作）。所有写入原子、带 revision/审计；失败不改任何 Ticket。

## 附录 C：评审问题清单

- 项目/任务/子任务是否都表现为 Ticket，只加层级字段？还有没有残留的 Project 实体/KV 覆盖层？
- 项目负责 worker 是否清楚？它和任务负责人的边界是否可见，且没有被写成所有任务的执行者？
- 主会话识别 → 项目负责 worker → 建任务/指派 worker 的路径是否完整？同一项目新需求是否直接派给项目 worker？
- 项目归档默认隐藏、已归档可查看；归档后任务和待办是否仍可见、可处理？
- 项目卡/详情/抽屉的计数是否同源？归档项目待办是否被过滤掉？
- 旧 Ticket/旧接口是否兼容？任务是否仍是根授权单元，子任务父审是否没有吞掉人的验收？
- 原型是否只画目标态、没有把项目 worker 的能力说成已实现？

## 附录 D：数据与派发层实现状态（2026-11-15）

> 状态：**P0 数据与派发层已实现；项目任务视图的面板 UI 未实现。** 本 PR 只动 kernel/dsh 的数据、投影、HTTP、工具与会话分派，不改面板组件，不写真实项目数据，不做自动迁移。

### D.1 已实现

- **Ticket 层级**：`Ticket.kind` 只取 `project` / `task`；项目是根 Ticket 容器，任务仍是带 Mandate/Decision 的根 Ticket，子任务继续用 `parentTicketId`。新增可选 `Ticket.goal`、`projectTicketId`、`archivedAt`；旧 Ticket 没有这些字段时按 `kind='task'`、无项目读取，不丢历史，也不自动归组。
- **项目受理**：`orchestrator_route` 的 `accept` 新增可选 `project: { goal, owner_profile_id, capabilities? }`；项目必须绑定可用的 owner worker Profile，不静默回退默认执行配置；项目不建 Assignment、不启动任务执行 worker，只启动协调 Session。
- **项目协调 Session**：会话 id 仍为 `worker-<projectId>`，工作目录为 `<stateDir>/projects/<projectId>`（不建 git worktree）；项目 input 持久投递，`projectInputsDelivered` 清空待投递列表后才算送达。
- **派发规则**：主会话/HTTP 调用方通过 `project_id` 指定项目；`dispatchToProject` 直接把 Trigger 投给项目协调 Session，不新建扁平任务。指定了未知、非项目或已归档目的地的，在接收消息前拒绝；未指定项目时保持原有扁平任务路径，不按标题猜项目。
- **权限**：项目 Mandate 新增 `capabilities: ('create-task' | 'assign-worker')[]`，默认两项都授予，也允许显式空数组（只走人工受理）。项目协调 Session 只有 `orchestrator_read`、`orchestrator_create_task`、`orchestrator_assign_worker` 与 Thread 工具；`create-task`/`assign-worker` 在 engine 侧再次校验 capability、项目归属与任务是否已开始，跨项目请求返回 `notProjectCoordinator`，没有跨项目提权。
- **受理 seam**：`admitProjectTask` 为每个任务签发一条 `kind='accept'` 的 Decision，`Decision.admission` 记录 `projectTicketId`、`requestedBy`、`ownerProfileId`、`idempotencyKey`；任务 Mandate 继承项目的 strength/basis/ceiling，scope 收窄为「项目 scope + 任务 scope」，不带项目 capability。重复的 `idempotencyKey` 返回同一任务。capability 为空时协调 Session 不能自动受理，普通人工 accept 仍可创建任务。
- **归档**：`archiveProject` 只写/删 `archivedAt`，幂等；项目不结束、不产生交付物，`stopTicket`/`retry` 对项目返回 `projectCannotEnd`。任务与 attention 不因归档消失；默认 `projects=active`，可用 `archived`/`all` 查看已归档，`off` 回滚为旧响应形状。
- **读取投影**：`GET tasks` 的 `tasks` 仍是根任务，项目只在 `projects`，没有项目的根任务在 `unassigned`；项目任务按 `projectTicketId` 分组，非法/失效链接留在 `unassigned` 并带 `projectBroken`；子任务仍通过 `GET tasks/:id` 展开。新增 `GET projects/:id`、`POST projects/:id/archive`、`POST projects/:id/restore`。
- **回滚**：服务端 `GET tasks?projects=off` 返回旧响应形状；客户端开关 `ux.projects.v1`（`features.ts` 的 `PROJECTS`）供后续 UI 接入，本项目未改面板。
- **测试**：`tests/projects.spec.ts`（层级、受理 seam 与幂等、allow/deny/跨项目、归档、派发、缺 owner、迁移读取）、`tests/projects-view.spec.ts`（投影、过滤、计数、坏链接、回滚形状、详情）、`tests/project-tools.spec.ts`（项目/任务工具面）、`tests/dispatch-split.spec.ts` 的项目派发用例、`tests/http.spec.ts` 的项目路由与 `projects=off`。

### D.2 与设计稿的偏差 / 尚未实现

1. **视图字段名按附录 B 对齐**：`ProjectView.name`、`TaskView.ticketKind: 'task' | 'subtask'`；项目本身不进 `TaskView`，项目详情与看板都排除 review 行。`ProjectView.owner` 复用现有 `TaskActorView`（`role: 'owner'` + `profile.id/revision`），不含设计稿的显示标题；`ProfileSnapshot` 不保存显示名，面板可另行解析。额外提供 `coordinator.sessionId`、`counts.working/review` 与 `attention`，均为只读派生字段。
2. **没有「把已有任务归入/移出项目」的写入口**。本单只实现受理时写入 `projectTicketId` 及子任务继承；存量任务保持 `unassigned`。设计附录 B 的「任务归入/移出」写路径留给后续 UI/管理动作，避免在本数据层单里引入未定义的权限与审计。
3. **没有独立 `POST tasks` 建任务路由**。协调 Session 通过 `orchestrator_create_task` 工具走 kernel 受理 seam；人工仍走既有 accept。面板 UI 未接入，因此没有新增项目页、弹窗、项目卡或归档交互。
4. **项目不建工作目录/worktree**，协调 Session 目录为 `projects/<id>`；这是与任务执行隔离的部署选择，不改任务 worker 的目录规则。
5. **`TaskView` 新增可选字段，旧客户端可忽略**；`ProjectView`/`unassigned`/`totals.projects` 在无项目或 `projects=off` 时省略，保持旧响应形状。未做数据库 schema 迁移：Ticket 以 JSON 持久化，新字段为可选。
6. **归档只改变项目读取过滤与新建任务/派发**；归档项目的历史任务仍可读取、计数和审批，协调 Session 不再自动接收新 input。
7. **项目协调需要启用 Agent Profiles 并有一个可用的 owner Profile**。Profiles 关闭或 owner 不可用时，项目仍可创建、读取和归档，但协调 Session 不启动、项目级 attention 指向 worker，`create-task`/`assign-worker` 返回 `projectWorkerUnavailable`；这是有意的非静默回退，不在项目里偷偷使用默认执行配置。
8. **受理 Decision 不新增 Eval**。`Decision.evalId` 是必填字段，受理 seam 写入确定性的 admission 键，但仓库里没有对应 Eval；区分与审计以 `Decision.admission`、`Decision.reason.code='projectAdmission'` 和项目 Mandate 为准，不把该 id 当作可回放的 Eval。
