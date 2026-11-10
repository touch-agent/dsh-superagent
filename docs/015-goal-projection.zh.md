# 015 Goal：主会话与任务行共用的只读目标投影

> 状态：已实现（T5-01，2026-11-10）。本文定义读模型、E0 边界与验收记录；它不是新的领域实体，也不改变授权。
> 关联：[001 领域模型](001-domain.md)、[003 执行](003-execution.md)、[009 会话任务](009-conversation-tasks.md)、[011 设计原则](011-design-principles.zh.md) §2（原则 A）与 §4（原则 C）。

## 1. 问题

E0 默认面（主会话、结果卡、任务行）只能从 Ticket 标题猜目标：标题说的是「改什么」，不一定回答「为什么做、做到哪、要不要我决定、结果在哪」。Ticket 已经有 Mandate scope、状态、Report 与 Deliverable，但这些事实分散在不同投影里；再让每个面各写一套摘要，就会得到互相矛盾的四个答案。

T5-01 的目标是把这件事收成一个**纯派生**的 `Goal`：同一张 Ticket 在主会话结果卡和任务行上得到同一个目标陈述。

## 2. 定义

`Goal` 是 Ticket 的只读投影，不是第二 Task/Ticket，也不是授权聚合：

- 没有表、没有迁移、没有写入路径；`Goal` 在请求时从已存在的 Ticket 计算。
- 不产生 Mandate、Decision、Approval 或 Action；读 `Goal` 不授予任何动作。
- 不保存目标陈述；若将来需要持久化人工改写，另走 additive migration 与独立评审。
- 删除 `GET goals`、`GET goals/:id` 或结果卡上的 `goal` 字段，Ticket 与执行都不受影响。

实现位置：`packages/kernel/src/goal.ts`（纯函数 `goalOf`），宿主读模型 `packages/dsh/src/app/goals.ts`（`goalView` / `goalBoard` / `goalDetail`）。

## 3. 派生表

| Goal 字段 | 来源 | 规则 |
| --- | --- | --- |
| `id` | `Ticket.id` | Ticket 的身份；不另造 Goal id。 |
| `statement` | `Delegation.goal` / `Mandate.scope` / `Ticket.title` | 子 Ticket 用父 owner 写的子目标；根 Ticket 用接受的 scope；都没有时用标题，不猜测。 |
| `source` | `Ticket.channels[0].source` | 来源的 Source 种类（如 `conversation`、`feishu`、`github`）。子 Ticket 没有自己的 Channel，字段缺席，不从根 Ticket 伪造来源。 |
| `state` | `ticketStage` 与 `Ticket.ended` | `queued` / `working` / `idle` / `person`（带 `action`）/ `ended`（带 `outcome` 与 `endedAt`）。 |
| `decision` | `Ticket.attention` 与 `ticketStage` | 有 worker 提问时 `kind=answer` 并带问题原文；否则按 person 阶段给出 `review` / `delivery` / `blocked` / `failed`。 |
| `results` | 最近一次带 Review 的 Report | 每条含 artifact、previewRef、交付时间与稳定 key；没有可审交付时为空数组，不伪造结果。 |
| `acceptance` | 同一份 Review | machine criteria 数与 person confirmations 数；有人接受该 revision 时带 `acceptedAt`。不含审查人身份、Assignment id 或 review revision 哈希。 |
| `read` | 宿主读模型 | `ticket/<id>`：既有 ticket card 携带同一 `goal`，避免为一个纯投影新增模型读资源。 |

`results` 只取 Ticket 自己的最近交付；已接受子 Ticket 的交付聚合仍是 E1 的 review aggregate（`GET tasks/:id`），不在 E0 的 Goal 里重复。这样主会话结果卡不需要为了画一行 E0 去读整棵子树。

## 4. E0 边界

`Goal` 刻意不包含：

- Assignment、worker 槽位、Session id、执行目录、transcript；
- Mandate 的 strength、basis、actor、maxActionLevel、policyVersion，以及 Decision id；
- Review 的 `sources`（含 Assignment id）、confirmation ref、reviewRevision；
- Approval、trace、原始日志。

因此 E0 的字段清单固定为「目标（statement/source）、状态（state）、要不要我决定（decision）、结果在哪（results/acceptance）」。任务行的 owner/worker 角色、子 Ticket、来源锚点仍属于 E1，由任务视图自己的投影提供，不塞回 Goal。

## 5. 只读端点

| 方法 | 路径 | 返回 | 说明 |
| --- | --- | --- | --- |
| `GET` | `goals` | `{ generatedAt, goals, totals }` | 根 Ticket 的 Goal，按 `updatedAt` 新到旧；`totals` 为根数、未结束数、需人决定数。 |
| `GET` | `goals/:id` | `{ goal }` | 任意 Ticket（含子 Ticket）；不存在时 404 `Goal not found`。 |

两个端点都走既有的只读 HTTP 检查链：loopback、同源、`x-orchestrator-request`；没有写方法。

## 6. 一份数据，两个面

- 主会话结果卡：`ticketCard`（结果 relay、`orchestrator_read` 的 ticket card）带 `goal`。
- 任务行：`TaskView` 带 `goal`，与结果卡使用同一个 `goalOf` / `goalView`。
- `tests/goals.spec.ts` 直接断言同一 Ticket 的 `ticketCard(ticket).goal`、`taskBoard(...).tasks[0].goal` 与 `goalView(ticket)` 全等；测试还扫描序列化结果，确认没有 Assignment/worker/Session/授权内部字段。

T5-01 只改读模型与 payload，不重排默认 UI；E0 文案与任务视图的 E1/E2 归类留给 T5-02。

## 7. 验收与回退

`tests/goals.spec.ts` 覆盖：

1. 空态：没有 Ticket 时 `goals: []`、`totals` 全 0，`GET goals/:id` 404；
2. 无交付：已结束 Ticket 的 `results` 为空、`acceptance` 缺席，不伪造 review；
3. 需决定：worker 提问、review-ready、blocked 三种 `decision` 与 `state`；
4. 任意 Ticket 的四问：working、等待回答、review-ready、已结束、lightweight；
5. 同一投影、E0 无内部 id、删除投影不影响 Ticket，以及两个 HTTP 端点。

回退：删除 `GET goals` / `GET goals/:id` 路由与 `Goal` 字段即可；没有 schema、资源或数据需要回滚。

## 附录：原则 C1.1 的 10 秒走查记录

- 时间：2026-11-10（Asia/Shanghai）。
- 参与者：独立走查 agent（与实现者不同的上下文）；**没有人类参与者**，因此这是一次读模型完整性走查，不是人类可用性研究。
- 场景：一张 tracked 根 Ticket（`修复登录（T2-03）`，scope 为修复登录回归，worker 提问「保留旧版登录接口吗？」，已有一份 `document` 交付与 preview，review 尚未接受）。
- 方法：只看 `goal` 投影（不看 Trigger/Eval/Execution/Assignment），依次回答四问；先跑 `tests/goals.spec.ts` 的「C1.1 walkthrough」用例，再让走查者只读该输出回答。
- 结果：投影生成 0.354 ms（本机一次计时）；走查者读完输出即可回答四问，远小于 10 秒。投影中不含 `worker-`、`Assignment` 或 Session id；同一用例断言 `goal.statement`、`goal.state`、`goal.decision`、`goal.results` 与 `goal.acceptance`。

| 问题 | 从 Goal 得到的答案 |
| --- | --- |
| 目标是什么？ | `statement`：修复登录回归 |
| 现在到哪？ | `state`：person / answer |
| 要不要我决定？ | `decision`：answer，问题「保留旧版登录接口吗？」 |
| 结果在哪？ | `results`：`document` / `docs/plan/report.md` revision `r7`，含 preview；`acceptance` 显示 criteria 1 / confirmations 1 |

> 实际输出由 `tests/goals.spec.ts` 的「answers the C1.1 walkthrough scenario in one projection」用例复现；本记录不把一次 agent 自测写成人类可用性结论。由于 T5-01 不改变默认 UI，本次没有截图审查可做；C1.1 的截图项留给 T5-02 的 E0 文案落地。