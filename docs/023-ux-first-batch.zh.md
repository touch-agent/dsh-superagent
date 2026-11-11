# 023 UI 第一批：任务层级页与通知层

> 状态：已实现（2026-11-11），默认开启、逐项可回退。
> 输入：[021 界面重构提案](021-ux-redesign.zh.md) 的任务层级、通知浮层/抽屉、错误聚合、术语与 Feature Flags 五条；本文记录第一批落地边界，不把提案当成已全部实现。
> 级别：E0/E1 默认面为主，E2/E3 只从明确入口展开；不删除任何 E2/E3 记录。

## 1. 这一批做了什么

| # | 提案条目 | 落地 |
| --- | --- | --- |
| ① | 任务层级页 | 任务列表仍是入口；选中后可打开任务详情，显示目标、负责人（含 Profile 版本）、子任务层级、每层产出物、阻断与向上汇报，并能进入对应执行会话 |
| ② | 通知层 | 右侧浮层最多 3 张卡片、8 秒自动收起、悬停暂停；铃铛打开全量抽屉，按“需要你 / 进展 / 系统”分组；每条给出“发生了什么 / 你可以做什么 / 不理会的后果”，批准、拒绝、重试、停用来源、查看等可原地操作 |
| ③ | 错误聚合 | 来源异常、任务失败/阻断与其他系统问题折成一条；显示重试次数与最近时间，提供重试与停用来源入口；上游恢复后该条自然消失 |
| ④ | 术语 | 默认任务/概览/通知面使用“任务、执行会话、产出物、负责人、被卡住/未完成”等词；`worker-`、`ticket_`、`session_`、Assignment、Disposition 等只在 E2/E3 折叠区出现 |
| ⑤ | Feature Flags | 任务层级、通知抽屉、通知浮层、错误聚合各自独立开关；关闭后回到原有紧凑任务详情、Events 页与逐条问题列表，记录不删 |

## 2. 数据与边界

### 2.1 任务层级页

- 数据仍来自 `GET tasks` 与 `GET tasks/:id?depth=1`；本批只给 `TaskView` 增加只读字段：`owner.profile`、`parentOwner.profile`、`blocker`、`childSummary`，以及每层已有的 `deliverables` 与 `delegation.resolution`。
- 根任务是 L2，计划里程碑是 L2 上的分组；其子 Ticket 是 L3。详情每次只展开一层，子层按需请求，第四层及更深保持折叠，避免一次拉整棵树。
- 每层显示：目标、负责人/Profile 版本、产出物、阻断原因、向上汇报状态（等待上级 / 已汇报 / 汇报未通过 / 已退回）、最近时间；根层还有执行会话入口。
- “上级负责人接受”不等于“人工验收”：前者是 Ticket 父子契约，后者仍走 Approval；详情里明确写出这条区别。
- 会话入口只在根任务出现，使用现有 `openSession`；不新建 Session，也不把 Session id 放到 E0/E1。

### 2.2 通知层

- 通知是 `GET overview` 的**客户端投影**（`packages/dsh/src/client/notifications.ts`），不是新的服务端实体：没有 `notifications` 表，没有第二份状态。上游记录消失，下一次轮询后通知即消失。
- 投影来源：Approval → 需要你；`person` 中待回答/待审阅/待交付 → 需要你；`recent` 中新结束的任务 → 进展；`problems` 与 `person` 中失败/阻断的任务 → 系统（一条聚合）。
- 浮层只弹 `pop` 的新通知，最多三张；8 秒自动关闭，鼠标悬停或键盘焦点进入时暂停；卡片容器是 `aria-live="polite"` 状态区，关闭后队列依次补位。首次加载会把既有通知记为已见，避免刷新时把旧活弹一遍。
- 抽屉保留全量；筛选“全部 / 需要你 / 进展 / 系统”，分组显示未读数，未读行有圆点，可“全部标为已读”。已读游标存在浏览器 `localStorage`，最多 500 个 id，不写 Store。
- 每条通知固定三问：`title` + `what`（发生了什么）、`next`（你可以做什么）、`consequence`（不理会的后果）。按钮直接调用已有管理 API；没有新增权限。
- “停用来源”走 `GET settings` + `PUT settings/:block`，与设置页同一写路径；写前有确认，来源不存在时提示并保持原状。读取失败或写入失败只在通知层报错，不伪造成功。

### 2.3 错误聚合

- 一条聚合行的计数包含：来源健康错误、失败/阻断任务、其他系统问题；详情列表保留每一条原始人类可读描述与任务 note，技术错误文本不替代人类句子。
- 重试次数取来源连续轮询失败数、未送达回复尝试数的最大值；最近时间取来源健康 `at`、任务 `updatedAt`、Eval 线程时间的最大值。来源健康记录因此新增可选 `at`（`packages/dsh/src/sources/poll.ts`），旧记录没有该字段时仍可显示。
- 操作：重试第一个可重试任务（确认后 `POST tickets/:id/retry`）、停用第一个异常来源（确认后设置写）、查看问题（回概览）、以及 Eval 未完成时的重新判断/忽略。
- 自动消失是投影的自然结果：恢复后 `problems` / `person` 不再包含该条，聚合行与浮层卡片一起消失；没有“删除问题”的写路径。

## 3. 术语

默认任务、概览与通知面按 [021 §5](021-ux-redesign.zh.md#5-术语) 改写，主要是：

| 之前 | 默认面 |
| --- | --- |
| Ticket / 工单 | 任务 |
| Thread / 工单会话 | 来源会话 |
| Trigger / 触发 | 消息 / 请求 |
| Eval / 评估 | 判断 |
| Execution / 执行 | 进行中 |
| Assignment / Worker Session | 执行过程 / 执行会话 |
| Deliverable | 产出物 / 结果 |
| Approval | 待你确认 |
| Source | 来自哪里 |
| Events | 通知 |
| blocked / failed | 被卡住 / 未完成 |

内部标识只在需求明确时出现：任务详情底的“技术详情（E2）”折叠任务标识与执行次数；来源/触发/评估/执行页仍保留其运维字段。默认面不再以 `worker-`、`session_`、`ticket_` 或 Assignment/Disposition 作为说明词。

## 4. Feature Flags 与回退

| 开关 | 默认 | 关闭后的行为 |
| --- | --- | --- |
| `ux.taskHierarchy.v1` | 开 | 任务列表保留，选中行回到原紧凑详情；不请求任务详情 |
| `ux.notifyDrawer.v1` | 开 | 不显示铃铛与抽屉，右侧 Events 页仍保留全部记录 |
| `ux.notifyOverlay.v1` | 开 | 不弹浮层，抽屉与未读计数仍工作 |
| `ux.errorAggregate.v1` | 开 | 概览逐条显示问题与失败任务，原重试/停用入口不变 |

浏览器偏好另有两个本地键：`dsh-superagent/notify-auto-dismiss`（`off` 关闭浮层自动收起）与 `dsh-superagent/notify-read`（已读游标）。设置 → 显示提供这些开关；偏好只影响本浏览器，不改服务端配置。

关闭任一项都不迁移、不删除记录，也不需要重启；刷新后生效，与现有 `ux.*` / `entry.*` 开关一致。

## 5. 验证

- `pnpm typecheck`
- `pnpm vitest run tests/panel-tasks.spec.tsx tests/panel-overview.spec.tsx tests/panel-notifications.spec.tsx tests/panel-task-hierarchy.spec.tsx`
- `pnpm check`（tracking、全量测试、build、bundle size）
- 新增/更新的面板测试覆盖：任务层级逐层打开与 E2 折叠、通知未读/抽屉分组/原地批准/停用来源、浮层三张上限与关闭开关、错误聚合的重试次数/最近时间/恢复消失/原列表回退、显示设置里的四个开关。
- 同场景 Before/After 截图（1440×900、light、同一 fixture）见 PR 描述；Before 取当前 main，After 取本 PR 构建。截图对任务标题、账号与来源内容做了脱敏，不使用私有飞书内容。

### 5.1 视觉证据

同场景、1440×900 视口、light、zh-CN、同一合成 fixture；截图只保留 Superagent 面板（1075×900），左侧 DSH 会话栏与真实工作区标题不入镜。fixture 的负责人/子任务是为展示层级而合成，不代表真实继承链。Before 取 `main@e0e1336`（之后 `39b8a08` 只改文档），After 取本 PR 构建。截图中的任务标题、负责人、来源和账号均为脱敏 fixture。

| 场景 | Before | After |
| --- | --- | --- |
| 任务列表选中同一任务 | [before-tasks.png](images/ux-first-batch/before-tasks.png) | [after-tasks-list.png](images/ux-first-batch/after-tasks-list.png) |
| 任务层级详情（上半） | 同上：紧凑选中行，无层级按钮 | [after-tasks.png](images/ux-first-batch/after-tasks.png) |
| 任务层级详情（下半：阻断/汇报/会话） | — | [after-tasks-bottom.png](images/ux-first-batch/after-tasks-bottom.png) |
| 概览：问题折叠成一条 | [before-overview.png](images/ux-first-batch/before-overview.png) | [after-overview.png](images/ux-first-batch/after-overview.png) |
| 聚合展开后的逐条明细 | 同上：原本逐条显示 | [after-error.png](images/ux-first-batch/after-error.png) |
| 右侧浮层（3 张、10px 间距） | 同上：无铃铛/浮层 | [after-cards.png](images/ux-first-batch/after-cards.png) |
| 通知抽屉（需要你/进展/系统） | 同上：只有右侧 Events 页 | [after-notices.png](images/ux-first-batch/after-notices.png) |
| 设置 → 显示：四个回退开关 | [before-settings.png](images/ux-first-batch/before-settings.png) | [after-settings.png](images/ux-first-batch/after-settings.png)、[after-settings-bottom.png](images/ux-first-batch/after-settings-bottom.png) |

### 5.2 十秒自查

对一个从未用过本面板的人，默认面应能回答：

1. 我现在要做什么？——概览“待我处理”与铃铛未读数给出数量和第一条。
2. 这个任务是谁的、做到哪了？——任务行 → 任务层级 → 目标/负责人/子任务/产出物。
3. 出了问题怎么办？——聚合行给出“重试 / 停用来源 / 查看原因”，并说明不处理的后果。
4. 我不想看浮层怎么办？——设置 → 显示可关浮层/抽屉，记录仍在 Events。

走查结论与缺口见 PR 的独立 review 评论；本批没有把提案里的“主 Agent 入口、四菜单、群组、上下文装配”一并实现。

## 6. 已知限制

- 通知仍由客户端从 `overview` 派生，没有服务端已读/推送；多浏览器之间已读状态不共享。
- 浮层上限 3、8 秒收起与 10px 间距是固定值，未做用户可调；只提供自动收起开关。
- 错误聚合的重试只直接给第一个可重试任务；其余失败任务从详情进入，避免一排危险按钮。
- 任务详情按需加载一层，深层需要逐层打开；这是为了不把整棵树放进一次响应。
- 来源健康 `at` 只在新轮询失败时写入；历史健康记录没有时间时，聚合行会退化为可用字段中的最新时间。
- 本批不改变 Approval、Mandate、Dispatch 或 Store schema；E2/E3 记录与设置写入路径不变。
- 新增客户端界面使 `packages/dsh/lib/client.js` 从约 562 KB 预算增到 646.4 KB；本次把该文件预算调到 650 KB、总预算调到 1.665 MB，仍按 `pnpm check:size` 守门。