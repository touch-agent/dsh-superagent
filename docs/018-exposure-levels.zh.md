# 018 E0–E3 暴露级别与默认面清理（T5-02）

> 状态：已实现（2026-11-10）。本文把 [011 设计原则](011-design-principles.zh.md) 原则 A/B 的展示分级落成一份可逐项检查的清单：每个默认 UI 元素属于哪一层、为什么它值得当前的注意力、更深的内容从哪里进入，以及如何回退。它不新增领域概念，也不改变授权、验收或数据。

## 1. 分级

E0–E3 是**展示分级**，不是 Ticket、Mandate 或数据库字段。同一份记录可以在不同层出现；层只决定「默认给谁看、第一眼看到什么」。

| 级别 | 面 | 默认内容 | 默认打开 |
| --- | --- | --- | --- |
| E0 结果面 | 主会话结果卡、概览三区、审批行、工单行的目标区 | 目标、当前状态、需要人决定什么、结果在哪里 | 是 |
| E1 审查面 | 任务列表与选中详情、工单详情、验收与交付摘要 | 目标、负责人角色、状态、交付、验收、阻塞原因 | 任务页默认；工单详情按需 |
| E2 诊断面 | 来源/触发/评估/执行、事件栏、计划树、图、trace、健康与流量、授权与审计 | 触发、评估、Assignment、时间线、原始事件、计划编号 | 否；由人打开或由异常摘要链接进入 |
| E3 原始面 | Executor Session、逐轮对话、命令、日志、目录 | 原始记录 | 否；必须从明确入口进入 |

原则 A 的 E0 四问是「目标 / 状态 / 需决定 / 结果」，原则 B 的 E1 稳定词是「目标 / 负责人 / 状态 / 交付 / 阻塞」。两者都不含 Session 名、Assignment 编号或 worker 槽位。

## 2. 默认面清单

### 2.1 主会话与概览（E0）

| 元素 | 层 | 默认显示 | 注意力成本 | 替代/更深入口 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 概览「待我处理」 | E0 | 待回答、失败、来源异常、评估未完成，按紧急度排序 | 每个条目要求一次判断；异常才出现，不列正常工单 | 完整队列在来源/触发/执行页（E2） | [after-overview](images/exposure-levels/after-overview.png) |
| 工单行 | E0 | 标题即目标、阶段标签、来源与线程事实、一行阻塞/结果说明、回答/重试/停止 | 一行只承载一个决定或一个结果；不显示执行器 Session 按钮 | 工单详情（E1）与 Executor Session（E3，见 §2.3） | 同上 |
| 工单行「未送达」标记 | E2 | 默认不显示 | 避免把投递重试噪声带进结果面 | 执行页与来源状态（E2）仍显示 | [before-overview](images/exposure-levels/before-overview.png) 对比 |
| 审批行 | E0 | 「需要你决定」标签、动作级别、后果、过期时间；可批准/拒绝 | 每次审批占一个决定位；隐藏对象 id、revision、`mail.reply` 等内部事实 | 「技术详情」折叠（E2）与工单时间线 | [after-overview](images/exposure-levels/after-overview.png)、[before-overview](images/exposure-levels/before-overview.png) |
| 审批行「技术详情」 | E2 | 折叠；点开后显示动作 kind、来源/对象 id、revision | 默认零成本；排障/审计时一次点击 | 无；这是审计证据本身 | `dt-e0-technical` 与 `panel-overview` 用例 |
| 主会话结果卡（`ticketCard.goal`） | E0 | 目标陈述、状态、需决定、结果与验收；结果被截断时给 `ticket/<id>/result` | 只在 worker 报告时进入；进度报告不打扰 | 完整报告在 `ticket/<id>/result`（E3） | `tests/goals.spec.ts`、`docs/015` |
| 结果转述 relay（`worker_report`/`worker_attention`/`follow_up`） | E0 | 目标、状态、需决定、结果摘要与 `read` 入口；`progress` 不转述 | 每条只通知一次；不带 Assignment、worker 或 Session；`ticket_id` 只用于主会话路由，不是展示字段 | 完整报告在 `ticket/<id>/result`（E3） | `tests/goals.spec.ts`、`tests/notices.spec.ts` |
| 运行/最近区链接 | E0→E1/E2 | 「任务」「详情」两个入口 | 一次点击就能从结果面进入审查/诊断 | 任务列表（E1）与执行过滤（E2） | 概览用例 |

### 2.2 任务列表与任务详情（E1）

| 元素 | 层 | 默认显示 | 注意力成本 | 替代/更深入口 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 任务列表行 | E1 | 工单标题、阶段、审查/交付进度、负责人角色、时间 | 一行一个工单；不显示 Assignment/Session id | 选中详情（E1）与工单（E1） | [after-tasks](images/exposure-levels/after-tasks.png) |
| 选中详情目标区 | E1 | 目标、需决定（有决策时）、结果或「还没有可审交付」 | 仅在选中后出现 2–3 行，不再新增一次点击 | E0 结果卡与工单详情已有同一份 Goal；不重复轮询 | 同上；`panel-tasks` 用例 |
| 计划树 / 图 | E2 | 不默认；「列表」是默认视图，切换后才出现「计划树（E2）」「图（E2）」 | 只有明确要看计划编号/并行分支时占用注意力 | `taskView.v1=off` 回退到计划树；入口结构不改（X-09 三区保持） | [after-tasks](images/exposure-levels/after-tasks.png) |
| 工单详情 | E1 | 目标、状态、授权摘要、验收、交付、阻塞；默认面上没有「打开 Session」 | 审查时按需打开；不把执行器身份放在标题旁 | 「标识」折叠里有 Executor Session（E3） | [after-ticket](images/exposure-levels/after-ticket.png)、[before-ticket](images/exposure-levels/before-ticket.png) |
| 审计时间线 | E2 | 在工单详情内，按需阅读 | 记录完整，但需要滚动/阅读；不是结果面的默认 | 原始 Session 记录（E3） | 同上 |
| 子 Ticket | E1 | 子工单标题与父/子角色 | 支持审查链；不显示 worker 槽位 | 父工单详情 | `panel-tasks` 用例 |

### 2.3 管理面板、事件栏与 Session（E2/E3）

| 元素 | 层 | 默认显示 | 注意力成本 | 替代/更深入口 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 概览 | E0 | 三区结果面；健康与流量折叠 | 只在异常时展开 | 「详情」进入运行健康/指标（E2） | [after-overview](images/exposure-levels/after-overview.png) |
| 来源 / 触发 / 评估 / 执行 | E2 | 不自动打开；人工切换 | 排障/审计成本，不进入默认叙事 | 概览的异常摘要链接到具体页 | 设置页分组与现有用例 |
| 事件栏 | E2 | 默认关闭；标题保留未读计数 | 默认零打扰；只有人打开或显式开启信任期设置才出现 | 手动点「事件」；设置 › 显示可开启首次自动打开一次 | [after-display](images/exposure-levels/after-display.png) |
| 设置 › 显示 | E2 | 一个开关：首次收到提醒时自动打开事件栏 | 默认关闭；只有主动进设置才看到 | `events.autoOpen.v1` 可整机禁用 | 同上 |
| 计划树 / 图 | E2 | 见 §2.2 | 见 §2.2 | 见 §2.2 | 见 §2.2 |
| 审批「技术详情」 | E2 | 折叠 | 见 §2.1 | 见 §2.1 | 见 §2.1 |
| 工单「标识」 | E3 | 折叠；含 Executor Session 按钮 | 只有审查者需要确认执行器时打开 | 工单详情标题不显示 Session | [after-ticket](images/exposure-levels/after-ticket.png) |
| Executor Session / 逐轮对话 / 日志 / 目录 | E3 | 不主动出现；从「标识」或执行器空间进入 | 明确进入后的隐私与注意力成本由人承担 | 仅此入口；不做默认卡片 | `panel-overview`、`panel-tasks` 用例 |

## 3. 事件栏自动打开（C2.4）

**稳定期默认关闭。** 首次收到 `notice` 级事件不再自动把事件栏推到人面前；未读计数仍保留在标题上，人点开才读。

信任期如果需要「第一次提醒时自动打开一次」，走两个显式开关：

1. **部署开关**：`events.autoOpen.v1`（localStorage，默认可用）。设为 `off` 时，即使浏览器偏好为开，也不会自动打开。
2. **浏览器偏好**：设置 › 显示 › 「首次收到提醒时自动打开事件栏」。默认关闭；打开后只自动打开一次，之后由人控制。键为 `dsh-superagent/events-auto-open`，与未读游标一样只存在本浏览器，不入服务端 Settings schema，因此没有迁移。

行为边界：只在首次出现未读 `notice` 时打开一次；关闭后不再自动打开；`feed`/`quiet` 从不触发。回退：把偏好关掉，或把部署开关设为 `off`。

## 4. 计划树降为 E2 回退

- 任务页默认「列表」是 E1；计划树/图需要显式切换，并标注 `（E2）`。
- 计划树不再被文案描述为「任务主视图」；`tasksIntro` 明确默认列表是 E1、计划树是 E2 回退。
- `taskView.v1=off` 仍回退到计划树，保留旧入口；不改 X-09 的三区入口结构，不删树/图。
- 没有新增数据库字段或迁移；计划树的计划编号只在 E2 出现。

## 5. 验收走查

截图条件：DSH `0.2.1-rc.5`，1280×900，浅色主题，左侧宿主栏展开，同一个合成状态（合成 Ticket「修复回归」「截图工具」「整理迁移说明」、合成审批与线程，无真实飞书内容）。Before 为 `7bfebfd`（origin/main），After 为 T5-02 分支。两组截图使用同一份 API fixture、同一视口与主题。

| 检查点 | Before | After | 结论 |
| --- | --- | --- | --- |
| C1.1 主会话/结果卡/审批行的 E0 四问 | [before-overview](images/exposure-levels/before-overview.png)：审批行直接显示 `mail.reply · 发送`、`对象 飞书 om_reply_1 · rev-1` | [after-overview](images/exposure-levels/after-overview.png)：审批行给「需要你决定」、动作、后果、过期；对象 id 收进「技术详情」 | 通过：默认面只有目标/状态/需决定/结果，无 `worker-`、Assignment 或 Session id |
| C2.1 E0 不出现 Session/worker id | [before-overview](images/exposure-levels/before-overview.png)：失败工单行有「打开 Session」 | [after-overview](images/exposure-levels/after-overview.png)：该按钮消失；[after-ticket](images/exposure-levels/after-ticket.png) 标题旁也没有 | 通过：Session 只在工单「标识」折叠（E3） |
| C2.2 E1 用目标/负责人/状态/交付/阻塞 | [before-tasks](images/exposure-levels/before-tasks.png)：选中详情只有角色与选中提示 | [after-tasks](images/exposure-levels/after-tasks.png)：新增「目标 · 修复回归」「结果 · 还没有可审交付」，根/审查角色改为「负责人」「审查人」 | 通过：详情不显示内部 id，角色用稳定词；计划树/图标注 E2 |
| C2.4 事件栏默认关闭、可显式开启、可关闭 | 基线在首次提醒时自动打开（代码路径 + 旧 `client.spec`） | [after-display](images/exposure-levels/after-display.png)：设置 › 显示默认关闭；打开只一次；`events.autoOpen.v1` 可禁用 | 通过：`client.spec` 覆盖默认关闭、显式开启、部署开关关闭三条路径 |
| 设置分组可见性 | [before-settings](images/exposure-levels/before-settings.png)：来源/评估/执行/提示词/部署 | [after-settings](images/exposure-levels/after-settings.png)：多出「显示」；内容见 [after-display](images/exposure-levels/after-display.png) | 通过：设置项不是默认面，只有主动进入才出现 |

### 5.1 10 秒自查记录（非用户实验）

- **任务**：只看 `after-overview`，10 秒内回答「现在要不要我、下一步是什么、结果在哪里」。
- **参与者**：本工单的 worker（实现者自测，非独立用户）；无外部参与者。
- **时间**：2026-11-10 22:40 前后（Asia/Shanghai），一次自查；不是严格计时的用户实验。
- **结果**：自查中能在一眼内说出「审批要发送一条消息，需要批准/拒绝」和「截图工具失败，可重试或停止」，并由「任务/详情」找到结果与审计入口。卡点：审批行不显示具体消息对象，需要展开「技术详情」或进入工单；这是 E0 注意力预算与审计完整性的取舍，记录为产品缺口而非本工单失败。
- **局限**：没有真实用户参与，结论只证明默认面不含执行细节、四问可读；不能替代 C2.5 的里程碑用户走查。

## 6. 回退

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| `entry.threeZones.v1` | 开 | 关闭后回到旧入口；本次不改变三区结构 |
| `taskView.v1` | 开 | 关闭后任务页回退到计划树（E2）；列表不再出现 |
| `events.autoOpen.v1` | 开（可用） | 设为 `off` 后整机禁用事件栏自动打开 |
| 设置 › 显示偏好 | 关 | 本浏览器开启/关闭「首次提醒自动打开一次」 |

没有 schema 迁移，没有删除记录。回退只改展示，不影响 Ticket、Assignment、Approval 或事件数据。

## 7. 不在本次范围

- 不重做 X-09 三区入口结构；概览仍是入口。
- 不删除管理面板的 Trigger/Eval/Execution，也不删除计划树/图或事件记录。
- 不把执行器 Session、日志或目录放进默认面；E3 仍由明确入口进入。
- 不新增 Goal 投影或授权聚合；E0 四问继续读 [015](015-goal-projection.zh.md) 的同一份只读 Goal。
