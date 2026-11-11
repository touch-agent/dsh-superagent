# 019 六层上下文装配（T5-04）

> 关联：[docs/011](011-design-principles.zh.md) 原则 C.3/C.3.3/C.3.7、[docs/017](017-context-groups.zh.md)（群组维度）、[docs/015](015-goal-projection.zh.md)（Goal 投影）、[docs/016](016-agent-profile.zh.md)（profile 快照）、[docs/003](003-execution.md)（Assignment）、[docs/007](007-architecture.md)（模块与 trace）、[TASK-PLAN](plan/TASK-PLAN.zh.md) T5-04、[TRACKING](plan/TRACKING.zh.md)。

## 1. 结论与边界

`packages/dsh/src/app/context-assembly.ts` 在**每次 Assignment 开始**时，按存在性装配六层上下文，产出两部分：

1. **worker 首条消息里的 `context_assembly`**：条目正文、维度、来源、scope、强度、继承与截断标记；后续 Assignment 只在装配结果变化时重复。
2. **Assignment 上的只读快照**（`Assignment.context`）：条目元数据、正文摘要（`sha256` 与字符数）、来源版本、缺席维度、合并决策、冲突与整体 hash；**不含条目正文**。同一份快照的阶段摘要写入 Trigger trace 的 `context` span。

它只读已有事实，不建表、不改 schema、不写 Ticket/Thread/Policy，也不新增授权聚合：

- **不产生授权**：六层只决定「读到什么」，Mandate、Action 闸门、Approval、验收与通知预算仍各自独立。`task:mandate` 条目只带 scope 引用，并明确写出「grants nothing」。
- **不把准入/授权当维度**：维度只有 organization / user / group / task / subtask / agent 六个；admission、action level、approval、Review confirmations 都不在装配表里。
- **不建新记忆**：条目全部来自已有载体（Policy、prompts、Trigger、Source Channel/Thread、Ticket、Mandate、Delegation、Profile、Assignment）；不新增向量库、成员表或跨源身份。
- **不读别人的私有正文**：装配只读本 Ticket 与根 Ticket；子 Ticket 只拿根的任务/授权引用和自己的 delegation，不拿父/兄弟的私有过程。

回退：删除 `contextAssembly` 接线即回到 T5-03 的 `context_group` 首条消息；快照字段是可选 JSON 字段，没有迁移。装配失败时 assignment 等待人处理，不会静默退回旧 prompt。

## 2. 装配表

| 维度 | 何时存在 | 来源 | 条目与强度 | 继承 | 截断（字符） |
| --- | --- | --- | --- | --- | --- |
| organization | 总有（Policy 与 worker prompt 可读时） | `policyVersion`、当前 worker prompt revision | `organization:policy` 约束；`organization:prompts` 默认 | inherit | 360 / 280 |
| user | 根 Trigger 由人发起（`trigger.human`） | 根 Ticket 的 origin Trigger actor | `user:actor` 默认、private | private | 200 |
| group | 根 Ticket 有共享空间且仍订阅 | T5-03 `contextGroupOf` / `contextGroupDimension` | `group:<source>:<space>` 默认 | inherit | 800 |
| task | 根 Ticket 与 Mandate 存在 | 根 Ticket、Mandate、origin Trigger | `task:goal` 默认；`task:mandate` 约束（只引用 scope）；`task:origin` 默认 | inherit | 600 / 400 / 240 |
| subtask | 当前 Ticket 是 Engine delegation 创建的子 Ticket | 本 Ticket 的 `delegation` 与最近一次报告 | `subtask:goal` 约束；scope/attempt/last-report 默认、private | private | 600 / 400 / 120 / 600 |
| agent | tracked Ticket 且有 Assignment | worker 身份、Execution 目录、Profile 快照 | `agent:role`、`agent:profile` 默认、private | private | 260 / 260 |

细节：

- **organization 只带引用，不复制正文**：Policy 与 prompts 的正文已经在系统 prompt 中；装配层重复一份会分叉。条目记录当前版本，使快照可审查、可回放。
- **user 只装发起人**：群组任务不合并其他成员身份；bot/CI 发起的 Trigger 没有 user 维度，而不是伪造一个人。身份不跨 Source 映射。
- **group 沿用 T5-03 的 scope 词汇**：`contextGroupDimension` 的 scope 是 `<source>:<space>`；装配器在比较同强度默认时，scope 无已知前缀就回退到维度 rank，因此群组约定仍比组织默认具体、比任务默认宽。
- **task 是根 Ticket 的任务**：对子 Ticket 也装根的目标、Mandate scope 引用与来源；`task` 条目不包含新的验收条件，也不复制 Mandate/Decision。
- **subtask 是当前子 Ticket 自己的**：目标、scope、attempt 与最近局部报告；不包含父 owner 的对话、兄弟子 Ticket 或父的私有过程。
- **agent 是执行单元**：角色、workspace、Assignment 与 profile 生效 hash；模型/工具/工具的授权上限仍由 T5-07 的会话解析与角色上限决定，装配只记录引用。
- **轻量 Ticket** 没有 Assignment/worker，装配结果**只有 task 维度**，其余五个维度写入 `absent`；不伪造 agent 或群组。

### 2.1 子 Ticket 的继承与平铺规则

- 子 Ticket 继承根 Ticket 的 organization、user、group、task；它自己的 subtask 来自 delegation，agent 来自自己的 Assignment。
- **平铺**：任意深度的子 Ticket 都只装「根 + 自己」，不沿 parent 链叠加中间父的私有上下文；父不继承子的私有过程，兄弟之间不继承。grandchild 的装配器只读根 Ticket，不读 parent 子 Ticket（`tests/context.spec.ts` 断言读取的 Ticket id 只有根）。
- 根作为父 owner 时，它自己的装配不包含子 Ticket 的 subtask 维度；子目标只通过 delegation 摘要/报告进入父的审阅，不进入父的 prompt 上下文。
- 子 Ticket 的群组从其根派生（T5-03 对子 Ticket 显式返回缺席，装配器对根调用同一投影）；离开共享空间后下一次装配移除群组，不回溯改写子 Ticket。

## 3. 合并与冲突

每个条目有 `key`、`dimension`、`source`、`scope`、`strength`、`inheritance`、`truncation` 与 `text`。合并按 key 进行，不整层覆盖：

1. **强度先于 scope**：`constraint` 赢 `default`；`default` 之间的胜者不参与强度比较。
2. **同强度默认才比较 scope**：scope 的前缀与维度 rank 给出具体性（organization < user < group < task < subtask < agent），更具体者赢；群组的 `<source>:<space>` 无前缀时回退到 group rank。
3. **同强度且 scope 不可分序**：文本不同即冲突。约束冲突直接 `blocked`；默认冲突同样不猜，避免「按来源顺序」成为隐式规则。
4. **完全相同文本**：去重，不产生合并决策。
5. **记录的决策**：非冲突的胜者写入快照 `merges`（winner 与 losers 的 `<dimension>:<source>`，不含正文）；冲突写入 `conflicts`（key、strength、维度、来源），装配停止。

## 4. 快照、trace 与回放

`Assignment.context`（`ContextSnapshot`）字段：

| 字段 | 内容 |
| --- | --- |
| `state` | `assembled` 或 `blocked` |
| `ticketId` / `rootTicketId` / `assignmentId` | 装配对象；轻量 Ticket 没有 assignmentId |
| `dimensions` / `absent` | 生效维度与缺席维度，均按阅读顺序，缺席不生成空层 |
| `entries` | `key/dimension/source/scope/strength/inheritance/truncation/chars/digest/truncated?`；**无 text** |
| `merges` / `conflicts` | 合并胜者与冲突；`conflicts` 非空时 `state=blocked` |
| `sources` | 每个维度来源的版本/身份摘要（Policy+prompt、Trigger、group key、根 Ticket、delegation、worker/Assignment） |
| `hash` | 对上述事实字段（不含 hash 与 `assembledAt`）的 `sha256`；同一 Assignment 的事实重放同 hash，读取时刻不同也相同 |
| `contentHash` | 只覆盖维度、条目摘要、合并与冲突的 `sha256`；仅 Assignment 身份变化时不变，用于判断后续消息是否需要重复装配结果 |
| `blocked` | 失败原因 `conflict` / `missing` / `unreadable`、维度与有界 detail |

装配阶段以 `context` span 写入 Trigger trace，data 只有 `state/dimensions/absent/hash/sources/merge_keys/conflict_keys`（blocked 时再加 reason/dimension），没有任何条目正文。`tests/context.spec.ts` 断言 `JSON.stringify(snapshot)` 不含条目正文/Trigger 正文，且同事实重放 hash 不变、来源版本变化后 hash 变化。

回放：用同一 Assignment 的既有事实重新调用 `assembleContext`，比较 `snapshot.entries` 的 digest 与 `hash`。快照不保存正文，所以回放证明的是**装配决策与来源**可重建，而不是把私有正文写进审计记录。

## 5. fail closed

以下情况不装配、不猜默认、不启动 worker：

| 情况 | 结果 |
| --- | --- |
| 根 Ticket 或根 Mandate 不可读/缺失 | `blocked`，`missing`，维度 `task` |
| tracked Ticket 没有 Assignment | `blocked`，`missing`，维度 `agent` |
| 子 Ticket 没有 delegation | `blocked`，`missing`，维度 `subtask` |
| 根 origin Trigger 不可读 | `blocked`，`missing`，维度 `task` |
| Policy/prompt/group 等来源读取抛错 | `blocked`，`unreadable`，带维度与有界错误信息 |
| 同强度不可分序的条目冲突 | `blocked`，`conflict`，列出 key 与来源 |

Executor 会先记录带 `blocked` 的快照与 trace，再以 `blocked` 报告和一条 `question` 请人决定（root Ticket 形成 Attention；child Ticket 走父 owner 的报告路径）。该 Assignment 不进入 workspace prepare，也不会重试；人解决冲突/恢复来源后，新的 Assignment 重新装配。没有 `fallback` 或「静默省略该维度」的路径。

## 6. 与相邻任务的接口

| 依赖 | 接口 | 本任务如何用 |
| --- | --- | --- |
| T5-01 Goal（`docs/015`） | `goalOf` / `goalView` 的只读目标 | task/subtask 的目标文本取 `goalOf(...).statement`，与 E0 同一投影；不复制 Goal 的其余字段 |
| T5-03 群组（`docs/017`） | `contextGroupOf`、`contextGroupDimension` | group 维度直接消费；子 Ticket 用根的投影；退订后下一次装配缺席 |
| T5-07 profile（`docs/016`） | `Ticket.profile` 的不可变快照与 `effective.hash` | agent 维度只记录 profile/assignment/hash 引用；不解析模型与工具 |
| T3-10 子 Ticket | `parentTicketId`、`rootTicketId`、`delegation`、`Assignment` | subtask 维度只来自当前 delegation；根/子/孙平铺继承规则见 §2.1 |
| Assignment / Engine | `Engine.contextAssembled` 写可选快照 | 新增一个只写事实的回调；不改变 Mandate、Action、Approval、report 语义 |

## 7. 验收与测试

`tests/context.spec.ts`（14 用例）：

| 场景 | 断言 |
| --- | --- |
| 六维各自来源 | root 的 organization/user/group/task/agent 与 absent subtask；child 六维齐全；来源、scope、强度、继承与 HASH |
| 缺席 | bot origin 无 user；无私聊群组；轻量 Ticket 只有 task |
| 合并 | constraint > default；同强度默认按 scope；完全同文去重；merges 记录 winner/losers |
| 冲突 | 同强度冲突 blocked，conflicts 记录，不选胜者，question 请人裁定 |
| 缺失/不可读 | 无 Assignment/无 Mandate/无 delegation/来源抛错均 blocked，不默认 |
| 退订/离开 | 下一次装配 group 缺席、hash 变化，Ticket 不被改写 |
| 快照 | 无 text、digest/hash 可重放、来源版本变化 hash 变化 |
| 授权隔离 | 无 action level/approval/admission 维度；task mandate 只引用并声明 grants nothing |
| 截断 | 每个条目按 truncation 截断并记录 truncated/chars |
| 子工单 | 只读根，不读 parent/sibling 私有过程；根目标 + 自己的 subtask |
| 边界 | 无效条目 fail closed |

运行：`pnpm exec vitest run tests/context.spec.ts tests/runtime.spec.ts tests/trace.spec.ts`。

## 8. 已知限制

- organization 维度记录的是 Policy/prompt 版本引用，不复制正文；如果未来需要组织级自由文本，应把它做成版本化来源，而不是在装配器里硬编码。
- `ContextAssemblyHost.entries` 是给尚无内置载体的维度（个人偏好、术语表）预留的合并入口；当前 Runtime 不传值，因此生产装配只有六个内置来源。它不进入授权路径。
- 轻量 Ticket 的 inline 执行器不生成 worker prompt，所以装配器支持其「只有 task」的形态并写入快照，但 inline 路径没有注入点；这是「没有 Assignment 就没有 agent 维度」的直接结果，不是遗漏。
- 快照不含正文，回放比较 digest/hash；需要人读原文时仍走既有 `trigger/<id>`、`ticket/<id>/assignment` 等白名单资源。
- 截断目前是逐条目字符上限（表 §2 的 truncation），没有额外的全局装配预算；内置六个来源的合计远低于一条 worker 消息，宿主通过 `entries` 增加来源时须自带每项上限。
