# 017 群组维度派生（T5-03）

> 关联：[docs/011](011-design-principles.zh.md) 原则 C（六层上下文的「群组」维度）、[docs/001](001-domain.md)（Thread/Subscription/Channel）、[docs/002](002-authorization.md)（授权边界）、[docs/003](003-execution.md)（Assignment 装配）、[docs/015](015-goal-projection.zh.md)（同样是只读投影的 Goal）、[TASK-PLAN](plan/TASK-PLAN.zh.md) T5-03、[TRACKING](plan/TRACKING.zh.md)。

## 1. 结论与边界

群组只做**上下文维度与展示**。它从 Ticket 已有的 Source Channel 地址和 Thread/Subscription 关系在读取时派生，不建表、不迁移、不写 Ticket/Thread，也不产生成员名单、Mandate、Approval、Action 或任何授权聚合。

- **不建 `Membership`/`Group` 实体**：没有 schema 变更，回退就是删除投影与路由；历史 Ticket 与来源记录不受影响。
- **不产生成员名单**：投影只有共享空间地址、可见范围（由 Source 决定）、可作为约定来源的 Thread；不列人、不列用户 ID。
- **不进入授权路径**：群组不进 Policy/Eval、Mandate、Action gate、Approval、outbox；`GET contexts/groups` 与 worker 首条 Assignment 消息里的 `context_group` 只读。删除投影不会改变任何 Ticket 的可执行性。
- **不是类别/`TaskPlacement`**：群组不写 Ticket 归属，不参与类别归纳，也不改变任务树或工作区。
- **缺席不装配**：私聊、没有共享空间的 Source、以及离开共享空间后，维度直接缺席（字段不存在），不构造空群组。

## 2. 派生规则

一个 Ticket 只投影**一个**可选群组：来源 Trigger 的 Channel 优先，其后按 `Ticket.channels` 顺序取第一个「有共享空间且仍有订阅」的 Channel。Ticket 同时绑定多个群时，本投影显示第一个；T5-04 若需要多群条目，可在装配层调用同一派生函数逐个 Channel 计算，而不必改本投影的授权语义。

一次派生最多看三类已有事实：

1. **Channel 地址**：Ticket 的来源 Trigger Channel 优先，其后是 `Ticket.channels`（含后续绑定的 Channel）。Source adapter 可选实现 `contextGroup(address, config)`，返回该地址所属共享空间的 `space`（Source 自己的词汇：飞书群 `chatId`、GitHub `owner/name`）、可选的 `label`/`url`。未实现该 hook 的 Source（如本地 conversation、飞书文档评论）没有群组。
2. **Thread/Subscription 活性**：群组只在 Ticket 仍订阅该空间中至少一个 Thread 时存在。判断以 `Thread.subscriptions` 为准（`Ticket.follows` 只是历史记录），所以退订、离开共享空间或协作线程关闭后，下一次派生就不再带出该群组；已产生的任务、交付与记录不回溯删除。
3. **群组约定来源**：该 Ticket 在该空间中仍订阅的 Thread 列表，按最近活动排序。`context_group.conventions` 就是这组只读 Thread key；它不读取、也不缓存 Thread 正文。

| Source | 共享空间 | 私聊/无群组 |
| --- | --- | --- |
| Feishu | 非 `direct` 的群 `chatId`；`threadSpace` 取聊天 Thread ID 的 `<chatId>:` 前缀 | `direct: 'true'` 的私聊；没有 `chatId` 的地址 |
| GitHub | 配置里的 `repository`（`owner/name`） | 未配置 repository；非 GitHub Channel |
| conversation | 无 | 全部私聊 |
| feishu-doc | 无（文档评论不是群组） | 全部 |

同一群聊里的不同话题 Thread 派生**同一个** `key`（`<source>:<space>`）；不同群/仓库得到不同 key。GitHub 的 PR/Issue Thread 都属于同一个 repository 空间；退订某个 PR Thread 不等于离开仓库，因此仍有其它 Thread 订阅时群组保留，全部退订后群组缺席。

## 3. 读模型

`packages/dsh/src/app/context-groups.ts` 只有派生函数，没有 Store 写入：

```ts
interface ContextGroupView {
  key: string          // '<source>:<space>'，也是展示身份，不是授权 scope
  source: string
  space: string        // 共享空间地址，Source 的词汇
  label?: string
  url?: string
  visibility: 'source' // 可见范围由 Source 决定
  conventions: string[] // 可作为约定来源的、仍订阅的 Thread
}
```

`contextGroupOf(host, ticket)` 返回可选维度；`contextGroupBoard(host)` 把所有 Ticket 的群组按 key 聚合成 `GET contexts/groups` 的只读列表（`groups[].tickets` 是任务，不是成员）。`GET contexts/groups` 返回 `generatedAt`、`groups` 与 `totals: {groups, tickets}`；没有任何写方法。可选维度同时出现在：

- `orchestrator_read ticket/<id>` 的 `context_group` 字段（worker 只能读自己的 Ticket）；
- worker 第一条 Assignment 消息的 `context_group` 字段（后续消息不重复未变化的维度）；
- T5-04 装配器可用的 `contextGroupDimension(group)` 条目。

## 4. 与 T5-04 的接口

T5-04 的装配表要求每个条目有 `key/source/scope/strength/inheritance/truncation`。本任务先提供同形状的 `ContextDimensionEntry`：

| 字段 | 群组维度取值 | 含义 |
| --- | --- | --- |
| `key` | `group:<source>:<space>` | 条目身份 |
| `source` | 来源 Source | 可读性/责任来源 |
| `scope` | `<source>:<space>` | 同群组条目同 scope |
| `strength` | `default` | 群组约定是默认层，可被任务/约束覆盖 |
| `inheritance` | `inherit` | 子 Ticket 由 T5-04 按任务继承规则处理 |
| `truncation` | `800` | 同 key 竞争时的字符上限 |

本任务不做 T5-04 的整表合并、冲突升级、fail closed 与快照；这些仍归 T5-04。子 Ticket 自身没有 Channel，因此本投影对子 Ticket 返回缺席；继承由 T5-04 的「任务 → 子 Ticket 包含继承」实现，不在本模块伪造根 Ticket 的维度。

## 5. 验收与测试

`tests/context-groups.spec.ts` 覆盖：

| 场景 | 断言 |
| --- | --- |
| 同组 / 异组 / 无组 | 同群两个话题 key 相同；不同群 key 不同；conversation 无维度；`GET contexts/groups` 聚合正确 |
| 私聊 / 群聊 | 飞书 `direct` 私聊缺席；群聊出现；缺 `direct` 标志但带群 `chatId` 视为群聊（Source 的显式标记优先） |
| 退订后失效 | Thread 订阅移除后 `contextGroupOf` 缺席、列表移除该 Ticket，Ticket 的 JSON 不变 |
| 群组不等于授权 | 投影没有成员/名单/授权字段；读取不修改 Mandate；T5-04 条目 shape 可核对 |
| 读模型与接线 | `ticketDetails` 可选字段、`GET contexts/groups` 只读、真实 Feishu/GitHub adapter hook |

C3.3 走查：本任务的「无群组」「离开群组」由上述用例证明；「无子 Ticket」「轻量 Ticket」和完整装配快照留给 T5-04。C3.4 走查：worker 仍只能通过 `orchestrator_read ticket/<自己的 id>` 读上下文，`GET contexts/groups` 只挂在主 Session/面板的 HTTP 面，不进入 worker 的 `RESOURCES` 白名单；群组不跨 Source 映射，也不把其它 Ticket 的正文带给 worker。

## 6. 回退

纯派生，删除 `context-groups.ts`、`GET contexts/groups` 路由和消息/读模型中的可选字段即回退到仅组织/用户/任务维度；没有库表需要回滚，也没有已写数据需要迁移。
