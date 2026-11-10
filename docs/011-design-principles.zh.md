# 设计核心思路与原则：注意力、组织、进化与可替换边界

> 状态：设计原则 v1.0（2026-11-08，docs-only）。
> 适用：产品面、组织与任务设计、运行时边界。本文不改变领域契约、代码或现有 UI。
> 关联：[docs/000](000-philosophy.md)、[docs/001](001-domain.md)、[docs/003](003-execution.md)、[docs/005](005-panel.md)、[docs/007](007-architecture.md)、[docs/009](009-conversation-tasks.md)、[012-platform-evolution.zh.md](012-platform-evolution.zh.md)、[M1-KICKOFF.zh.md](plan/M1-KICKOFF.zh.md)、[SESSION-ENTRY.zh.md](plan/SESSION-ENTRY.zh.md)、[任务视图架构设计（`docs/tasks-view-architecture.zh.md`，2026-11-09 Ticket 自引用修订版）](https://github.com/touch-agent/dsh-superagent/blob/main/docs/tasks-view-architecture.zh.md)。
> 状态口径：**已采纳**＝已有实现或可执行的文档约束；**待验证**＝方向已同意，但缺实现或证据；**暂缓**＝条件不满足前明确不做。
>
> 四条原则中 A 已采纳，B/C/D 待验证；没有一条原则需要暂缓——§8 的「暂缓」只针对尚未具备条件的落地项。

## 0. 四条原则

| # | 原则 | 状态 | 一句话 | 检查点 |
| --- | --- | --- | --- | --- |
| A | **人的注意力是瓶颈** | 已采纳 | 人只关心想法与目标；界面先回答「要决定什么、能用什么」，会话与执行细节不是主角 | C1.1–C1.5 |
| B | **组织与执行默认是内部事务** | 待验证 | 单/多 agent、树、编排由系统决定；信任不足时才提供可审查的组织视图，能力提升后简化 | C2.1–C2.5 |
| C | **组织与任务需要独立的自我进化与可组合的六层上下文** | 待验证 | 观察→总结→进化→验证是独立闭环；组织/用户/群组/任务/子 Ticket/agent 六个维度按存在参与，明确作用域、继承与私有 | C3.1–C3.7 |
| D | **现有复杂组织必须可简化、可替换** | 待验证 | 现有树、层级、worker 服务于解释与观察，不是产品本质；边界可拆，观测点保留 | C4.1–C4.5 |

这四条不是口号，而是**冲突裁决器**：当两个局部设计都合理时，用它们决定谁让步。A 管「什么值得占用人」；B 管「什么不该出现在人面前」；C 管「系统和组织如何变好」；D 管「变好之后如何丢掉旧结构」。

## 1. 为什么需要这一层

现有文档的原则分布在三个高度，彼此会打架：

- [012-platform-evolution.zh.md](012-platform-evolution.zh.md) §2 的 P1–P7 是**平台机制原则**（不变量、模型不授权、先记账、可逆性分级等）。
- [docs/005](005-panel.md) 的 Principles 是**面板交互原则**（聚焦、精确、安静、诚实）。
- 任务视图提案（2026-11-09 修订版）的 10 条是**任务视图原则**（授权不变、一份数据多个看法、默认三层、子 Ticket 不是授权主体等）。

它们都成立，但回答不了四个更上层的问题：注意力花在哪、组织该不该露出来、组织如何学习、旧组织如何退休。本文补这一层，并逐条对照现有文档（§6）。

## 2. 原则 A：人的注意力是瓶颈

### A.1 原则表述

人只关注**想法与目标**：要做什么、做到哪、是否需要我决定。界面应当更易用、易懂、可掌控全局；**会话、执行树、任务编排不是主角**。

[docs/000](000-philosophy.md) 已给出总原则：「Take as little human attention as possible, and give as much value as possible.」本文把它展开成可检查的约束，而不是重复一遍。

### A.2 三条推论

1. **一个结果一条通知。** 结果已经由报告 relay 过，结束事件不再重复打扰（[SESSION-ENTRY.zh.md](plan/SESSION-ENTRY.zh.md) §3.6 已实现 `endCoveredBy`）。事件仍入库，但不等于要推送。
2. **默认安静，异常才出声。** 健康状态不占空间；需要人决定、需要人验收、无法继续，才进入默认面。
3. **渐进披露，而非隐藏。** 细节不删除记录，只是收进入口/投影：先给目标、状态、下一步；想看再展开。人不需要为了用一个结果先去读执行日志。

### A.3 对设计的硬约束

- **E0 默认面**（主会话、结果卡、审批行）只出现：目标、当前状态、需要什么、结果在哪里。不得默认出现 Session 名、Assignment、worker 槽位、trace。**E1 任务视图**可以出现子 Ticket 标题，但不显示 worker/Session 内部 id。
- **第二层**（任务详情/审查视图）回答「谁负责、交付了什么、卡在哪」，用稳定词汇，不用内部 id。
- **第三层**（管理面板的 Trigger/Eval/Execution、trace、事件栏）是排障与审计面，按需打开，不自动弹出。
- **任何新增默认 UI 元素**必须写明：它占用谁的注意力、替换掉哪一项、为什么不能按需展开。写不出来的，不加。

### A.4 落地检查点

| # | 检查点 | 验证方式 |
| --- | --- | --- |
| C1.1 | E0 默认面清单固定为「目标/状态/需决定/结果」，执行细节不在其中 | 对主会话、结果卡、审批行做一次截图审查；出现 `worker-`、`Assignment`、Session id 即失败 |
| C1.2 | 一个结果最多一条通知；事件栏保留记录但不重复提醒 | `tests/activity.spec.ts` 的 `endCoveredBy` 用例；新增「每结果通知数」指标，目标 1 |
| C1.3 | 首屏先列等人决定的事；健康态不占空间 | [docs/005](005-panel.md) 的三问与 Quiet by default；面板用例 |
| C1.4 | 新增 UI 必须写注意力成本与替代关系 | PR 检查项；无说明不合并 |
| C1.5 | 10 秒测试：不打开 Trigger/Eval/Execution，人能说出「要不要我、下一步是什么」 | 每个里程碑做一次可用性走查并留记录 |

E0 的四问由 docs/015 的 Goal 投影提供同一份只读答案；投影不是第二授权聚合。

## 3. 原则 B：组织与执行默认是系统内部事务

### B.1 原则表述

单 agent 还是多 agent、任务树多深、谁拆给谁、用哪个 Session、subagent 如何并行——这些是**系统内部事务**。产品的默认叙事是「目标 → 结果」，不是「组织架构 → 工位 → 会话」。内部选择也不是无限的：它仍受任务视图提案的深度/宽度/活跃上限（深度 5、单节点 8 个直接子 Ticket、单根 32 个活跃子 Ticket）与成本预算约束；这些是候选护栏，不是本文新增的产品承诺。

这与 [docs/001](001-domain.md) 一致：Executor、Session、目录在领域之外，Ticket 只通过 Assignment 记录「谁在执行」；[docs/009](009-conversation-tasks.md) 也规定主会话只路由与协调，不实现。原则 B 把这条边界从领域扩展到产品面。

### B.2 内部不等于不可观测

可观测性是系统属性，默认暴露是产品选择。两者必须分开：

| 级别 | 面 | 内容 | 默认 |
| --- | --- | --- | --- |
| E0 结果面 | 主会话、结果卡、任务行 | 目标、状态、需决定、结果链接 | 总是 |
| E1 审查面 | 任务详情/审查视图 | 负责人、交付物、验收条件、阻塞原因、组织摘要 | 按需；信任不足阶段可主动提供入口 |
| E2 诊断面 | 管理面板 Trigger/Eval/Execution、事件栏、trace | 触发、评估、执行、会话、槽位、原始事件 | 排障/审计时打开 |
| E3 原始面 | Session 记录、日志、目录 | 逐轮对话、命令、文件 | 明确进入，遵守隐私与脱敏 |

E0–E3 是**展示分级**，不是新的领域概念：它们不进入 Ticket、Mandate 或数据库，只决定一个面默认给谁看。

现有管理面板同时承担 E0 概览与 E2 诊断：Overview 是 E0，Trigger/Eval/Execution 是 E2。它是**信任控制台**，不是产品主界面。这解释了为什么它同时存在七个 tab 与「安静」原则——两者服务不同的人、不同的时刻。冲突不在「是否记录」，而在「是否默认推到人面前」。

### B.3 信任阶段与简化

组织视图是信任不足阶段的**证据**，不是长期产品价值：

1. **低信任/上线初期**：E1 可用，E2 给操作者；默认仍只给 E0。人可以用组织证据判断「它为什么这样做」，但不需要每次看。
2. **信任建立期**：用 E1 的验收记录、失败原因、重复率做评审；组织视图从「全量树」收敛为「异常与交付摘要」。
3. **能力稳定期**：E1 默认只显示例外（阻塞、越权、验收失败）；E2 留给工程排障。若某层组织视图连续若干里程碑无人打开，就折叠或移除入口（记录保留），而不是继续维护。

### B.4 与「可观测性优先」的取舍

[012-platform-evolution.zh.md](012-platform-evolution.zh.md) 把 M0 定为「眼睛」，这是对的：没有 trace 就无法建立信任。但**有观测**不等于**默认展示**。取舍是：

- 保留全量记录与按需读取，成本在存储与实现；
- 默认面只给结果与例外，成本是排障时要多点两下；
- 收益是人不必理解组织才能使用产品，且组织可以替换而不破坏产品叙事。

### B.5 落地检查点

| # | 检查点 | 验证方式 |
| --- | --- | --- |
| C2.1 | E0 默认面不出现 Session/Assignment/worker id；E1 任务视图可显示子 Ticket 标题，但不显示内部 id；例外仅在阻塞、越权、审查需要时出现 | 默认面截图审查 + 文案检查 |
| C2.2 | E1 用「目标/负责人/状态/交付/阻塞」稳定词汇，不用内部 id | 任务详情与审查视图走查 |
| C2.3 | 任务树默认显示 L1–L3（类别 + 根 Ticket + 一级子 Ticket）；右栏默认是列表，点开 Ticket 才显示一级子 Ticket，不默认画树；L4+ 折叠；执行单元不是任务层级；右栏不自动弹出 | 对照任务视图修订版 §2 原则 6、§4.1（层级）、§7.2（右栏列表）与 §7.3（树）；UI 用例 |
| C2.4 | 事件栏的首次自动打开保留为信任阶段的显式例外，并可关闭；进入稳定期后改为默认关闭（对 SESSION-ENTRY §3.4 的修订提案，需产品确认）；只有需要决定/结果才通知 | 设置项 + 事件分级用例；统计自动打开后的关闭率 |
| C2.5 | 每个里程碑做一次「不看组织视图也能完成任务」的走查 | 记录任务、参与者、卡点；失败即产品缺口 |

## 4. 原则 C：组织与任务需要独立的自我进化与可组合的六层上下文

### C.1 自我进化闭环

组织与任务不应只靠人改 prompt 来变好。需要一条独立于「做任务」的闭环：

| 阶段 | 输入 | 输出 | 谁做 | 约束 |
| --- | --- | --- | --- | --- |
| 观察 Observe | 决策、报告、验收结果、阻塞原因、返工、重复提问、失败与恢复 | 有证据的样本集 | 独立观察者（非当前任务 worker） | 只读；不读与改进无关的私密全文 |
| 总结 Summarize | 样本集 | 候选经验：规则、模板、组织参数、提示词片段 | 独立分析者 | 每条带证据、置信度、适用范围；低置信只记录 |
| 进化 Evolve | 候选经验 | **提案**：改 prompt/技能/非授权阈值/组织模板/新类别或合并/拆分类别（已有类别的展示归属见 C.2） | 独立角色或人 | 默认只提案；版本化；可回滚；不直接改授权与代码 |
| 验证 Verify | 提案 | 采用/拒绝/再观察 | 人 + 前后对比指标 | 先小范围；有护栏；失败回滚；记录原因 |

关键在**独立**：执行任务的 worker 不能顺手改写自己的组织或策略。进化循环有自己的授权边界、审计链与节奏；它观察多个任务，而不是在单个任务里边做边改。否则一次坏总结会立刻污染所有后续工作，且无法区分「任务失败」与「规则失败」。

### C.2 进化什么、不进化什么

| 可进化（提案 + 验证） | 不可由循环自行进化 |
| --- | --- |
| 提示词与技能的组织方式、措辞、示例 | 授权、账本、验收等不变量（PLATFORM §2 的 P1–P3 与 ADR-05） |
| 非授权阈值：超时、重试、并发、置信度、批量大小 | 领域概念本身（Source/Trigger/Ticket/Mandate…） |
| 组织模板：默认层级、委派深度/宽度、父子审阅规则 | 跨源身份映射（[docs/001](001-domain.md) 已拒绝） |
| 任务分类与模板：新类别、合并/拆分、拆解套路、验收清单模板（只提案，不改验收门）；已有类别的归属是可撤销的展示覆盖层，可按阈值自动应用并审计，可关闭 | 直接改生产代码或数据库 schema |
| 观察指标与告警阈值 | 自动把提案应用到生产 |

「不进化」不是保守，而是把**学习**与**授权**分开：学习可以快，授权必须慢且可审计。准入、动作级别、审批与验收门属于授权/验收不变量，只能经设置与人工批准变更，不能由进化循环自动改；验收清单模板可提案，但不能改活动验收条件。

注意：任务视图的**类别归属不是 C.1 的进化提案**。它只写可撤销的显示覆盖层，不改变授权、验收条件或上下文装配；已有类别的自动归属可按阈值自动应用、带 `history`、可关闭，但新类别、合并、拆分与验收模板仍只提案、不自动应用（任务视图修订版 §5.5）。

### C.3 可组合的六层上下文

六层不是一条从组织到 agent 的顺序链，而是**六个可组合的上下文维度**。维度只在主体存在时参与装配：没有群组就没有群组维度，没有子 Ticket 就没有子节点维度；不存在「空层」，也不按列表顺序继承。

| 维度 | 何时存在 | 内容 | 被谁继承/适用 | 私有边界 | 现有载体 |
| --- | --- | --- | --- | --- | --- |
| 组织 | 工作处于某个组织/工作区，且有组织级原则、策略或交付要求时 | 原则、策略、交付要求、术语、来源约定 | 该组织下的全部任务与 agent，作为约束或默认 | 组织内部；不因组合而外泄到外部 Channel | Policy、prompts；本文/README 是设计依据 |
| 用户 | 有明确的发起人或操作者身份时 | 身份、称呼/个人偏好、可发起工作的策略事实 | 由该用户发起或操作的任务 | 不跨用户；不跨 Source 映射；群组任务只装发起人/当前操作者，不合并其他成员私有上下文 | Policy 的 per-Source 名单、Trigger actor |
| 群组 | 任务从群/频道/仓库/项目等共享空间发起，或被显式带入某个群组协作时；共享空间由 Source 的 Channel 地址（群/频道/仓库/项目等）与现有 Thread/Subscription 关系表示 | 该共享空间的约定、成员可见的上下文与历史 | 从该群组发起或共享给该群组的任务 | 可见范围以 Source 为准；上下文 Thread 供读取，不授予权限；不派生成员名单 | Source 的 Channel 地址、Thread、Subscription |
| 任务 | 根 Ticket 存在时 | 目标、Mandate scope、来源、验收条件、交付物 | 该根 Ticket 的 Assignment、子 Ticket、agent | 任务及其审查者 | Ticket、Mandate、Deliverable、Inputs |
| 子 Ticket | 根 Ticket 实际通过 Engine delegation 拆出子 Ticket 时（2026-11-09 修订） | 子目标、scope、局部结果、失败原因 | 该子 Ticket 的 owner/worker 与其 subagent | 默认只回父 owner，不直接找人；子 Ticket 无 Mandate/Decision，不是授权主体 | `Ticket`（`parentTicketId`/`rootTicketId`/`delegation`）、Assignment、`report` |
| agent | 有 agent 执行单元时 | 角色、工具、工作目录；模型/preset 由宿主决定，会话历史属于该 agent 自身 | 该 agent 的 subagent（工具与权限受父约束；不继承对话历史） | 该 Session/执行环境；不构成授权 | DSH Session、preset、Execution 变量 |

**授权不变量不受影响（任务树从 `Subtask` 改为 `Ticket` 自引用时）**：这只是一次执行/读模型的组织方式调整，不是授权模型变化。① 只有 Eval 创建授权根 Ticket；`docs/001` 的「只有 Eval 创建 Ticket」在任务树语境下按「只有 Eval 创建授权根 Ticket」解释，Engine 的 `delegate_ticket` 只创建带 `parentTicketId`/`rootTicketId` 的非授权子 Ticket，不能创建授权根。② 子 Ticket 没有自己的 `Mandate`/`Decision`，**不是授权主体**；它继承根 Ticket 的授权与 `maxActionLevel`，动作闸门、`Approval.ticketId` 与 outbox 的 `ticketId` 仍只认根 Ticket。③ 子 Ticket 不能创建授权根 Ticket、不能直接找人、不能提级、不能外发，也不订阅渠道/线程；复用 Ticket 生命周期字段时 channels/answers 保持空、follows/attention 缺省，undelivered 只承载内部 child-report/end-gate；父 owner 的 `accept_child` 只接受工作交付，不等于人的验收，也不写人的 `Review.confirmations`。④ 子 Ticket 需要独立授权/独立来源/独立动作级别时，必须由人/来源经 Eval 新建根 Ticket，不能靠改 `parentTicketId` 或复制 Mandate 绕过。契约测试见任务视图修订版 §9.2；独立 review 必须核对这一条并写出结论。

**组合规则**：

1. **按存在过滤，不按顺序继承。** 装配时先取「主体存在」的维度；缺席的维度不贡献任何条目，也不生成空占位。六层的列举顺序只是阅读顺序，不是优先级。
2. **条目级合并，不整层覆盖。** 每个上下文条目在装配表里带 `key`、来源维度、作用域（scope；不是 Mandate scope）与强度（约束/默认；不是 Mandate 的 explicit/inferred 强度）（这些是装配概念，不是现有 schema）；每个维度只声明它拥有的 key（例如称呼/个人偏好归用户，仓库/频道约定归群组，目标与验收归任务）。组合时**上下文强度先于上下文 scope**：约束 > 默认；同为默认才比较 scope，取更具体者；同为约束且冲突则停止装配并请人裁定。
3. **具体性只用于同强度默认之间。** 例如「本子 Ticket」比「本根 Ticket」具体，「本 Ticket 的显式说明」比「本群组的默认」具体；但称呼/个人偏好归用户、仓库约定归群组，二者通常不争同一个 key。约束之间的冲突不按 scope 或维度顺序猜，直接升级。
4. **继承沿作用域与包含关系，不沿列表顺序。** 组织/用户/群组在其作用域内的任务继承其条目（例如群组任务继承群组约定）；任务 → 子 Ticket 是包含继承：子 Ticket 不能超出根 Mandate 的授权，验收以根 Ticket 为准；父任务不继承子 Ticket 的私有过程；兄弟子 Ticket 之间不继承私有过程，只通过父 owner 汇总。继承只发生在维度存在时；任何维度都不能获得不属于其作用域的私有内容。
5. **缺席即不存在。** 没有群组就没有群组约定；不能从用户身份推断一个群组，也不能用组织默认伪造群组上下文。群组是 Source 的 Channel 地址与现有 Thread/Subscription 关系的上下文视图，不是 Membership 实体；私聊线程没有共享空间地址时群组维度缺席；任务后来进入群组协作时，群组维度才加入，且不追溯改变此前的私有上下文；离开共享空间后群组维度移除，不把群组内容带入后续私聊，也不反向删除已产生的任务记录。
6. **组合不产生授权。** 读到什么不等于能做什么；权限只来自 Mandate 与 Action 闸门。Mandate/Action 不在上下文中，装配只带指向它们的引用；上下文不能替代授权检查，任何维度的条目都不能扩大 action level。
7. **私有默认不上升，上升需显式提升。** 子 Ticket 问题先回父 owner；用户/群组私有内容不因任务完成变成组织记忆；局部经验要成为组织规则，必须走 C.1 的提案、验证与人工批准。
8. **来源隔离。** 一个 Source 的身份、证据、原文留在该 Source；不建全局身份（[docs/001](001-domain.md)）。
9. **最小必要。** 只装当前任务需要的维度与条目；截断时优先保留任务目标、验收条件与当前输入，最后才牺牲历史细节。
10. **任务类别不是群组维度。** 群组只由 Source 的 Channel 地址与 Thread/Subscription 派生；2026-11-09 修订版的 `TaskCategory`/`TaskPlacement` 是任务视图的展示覆盖层，不产生成员关系、不进入上下文装配、不授予权限。两者可以并存，但不能互相推导。

**装配过程**：

- 装配者是宿主侧 prompt 装配层，不是 worker；worker 只收到只读的上下文快照。
- 在 Assignment 或轻量执行序列开始时生成快照；同一 Assignment 或轻量执行序列内不静默改写；Policy 变化或 Ticket 的 stop/resume 按现有送达机制处理，需要时重新装配并生成新快照。
- 快照包含条目与 manifest（维度、来源、scope、强度、版本或等价标识）以及缺席维度清单，写入 trace 供审查。
- 约束冲突、必需维度缺席或来源不可读时 fail closed，生成一条待人工决定的 Attention 或报告给主会话；不猜测、不静默降级。
- 轻量 Ticket 可以只有任务维度，没有 Assignment/agent；装配按实际存在的载体进行，不伪造执行维度。

例：私聊发起的 Ticket 没有群组维度，装配结果只有组织/用户/任务/agent；同一个 Ticket 被带入群组协作后，群组维度才出现，群组约定按 key 作为附加默认/约束参与，不把此前的私聊内容自动广播给群组。

### C.4 与 DSH Session/context 的关系

DSH 是宿主，不是组织模型。二者的对应关系必须说清，否则「六层」会被误读成一条组织链，把组织语义塞进 session metadata：

| 概念 | 属于 | 生命周期 | 说明 |
| --- | --- | --- | --- |
| 主 Session | DSH 执行容器 + 路由器 | 进程内单例 | 负责评估、派发、回答；不是组织维度，也不持有授权 |
| worker Session | DSH 执行容器 | 一个 Ticket 的多次 Assignment 共享 | 执行任务；上下文来自 Assignment 与 `orchestrator_read` 的白名单资源 |
| 子 Ticket owner/worker Session | DSH 执行容器 | 一个子 Ticket 的一个 attempt；`return_child` 递增 attempt 后换新 Assignment/Session（2026-11-09 修订） | 执行子 Ticket；上下文来自根 Ticket + 子目标，不继承父对话历史；是普通 `worker-<childTicketId>` 的 Assignment，不是第二种执行实体 |
| subagent Session | DSH 执行容器 | 一个执行步骤 | 执行细节，不是任务维度；其工具随 Ticket 结束而失效 |
| Ticket/Mandate/Assignment | 领域（kernel） | 持久 | 目标、授权、谁在执行；子 Ticket 仍是 Ticket，只是通过 `parentTicketId` 挂在根下，**没有自己的 Mandate/Decision**，不是第二授权主体 |
| 组织/用户/群组上下文 | 领域事实 + prompts + Source 记录 | 版本化（prompts/policy）或持久（领域事实、Source 记录） | 由宿主侧 prompt 装配层按存在的维度注入；worker 仍只读自己的 Ticket 与白名单资源 |
| Session 对话历史 | DSH | 会话内 | 是 agent 维度私有上下文，不是组织记忆 |

实现上，[docs/007](007-architecture.md) 已经给了雏形：kernel 零宿主依赖；worker 只读自己的 Ticket；读资源有分页与字符上限；评估上下文有 Thread 窗口与 ticket cards。原则 C 要求把这些「临时规则」收敛成一张**上下文装配表**：每个进入 prompt 的条目都标明维度、来源、作用域、强度、是否可继承、截断优先级。第一版可以只是文档与装配层整理，不必新增 schema。注入路径与授权路径必须分开：组织/用户/群组维度由宿主侧 prompt 装配层在生成 Assignment prompt 时注入；群组/用户原文的读取仍受 Source 白名单与分页限制；Mandate/Action 闸门独立检查「能做什么」。

### C.5 与「不做通用长期记忆」的边界

[012-platform-evolution.zh.md](012-platform-evolution.zh.md) §1.3 N5 明确「不做通用长期记忆——记忆是 Source 的属性」。原则 C 不推翻它：

- 六层上下文是**装配策略**，读的是已有事实（Ticket、Thread、Policy、Source 原文），不是新建一个跨源记忆库。
- 需要跨任务保留的经验，落成**版本化的 prompt/策略/模板提案**，有证据、有批准、可回滚；不是向量库里的隐式记忆。
- 组织维度不是「记住一切」，而是「记住被验证过的规则」。这既满足进化，也避免隐私与漂移。

### C.6 落地检查点

| # | 检查点 | 验证方式 |
| --- | --- | --- |
| C3.1 | 写出进化闭环的运行规格：样本、提案格式、批准人、应用方式、回滚 | 文档评审；先离线跑一轮，不改生产 |
| C3.2 | 进化角色与执行角色分离；提案有独立审计链 | 提案记录含来源任务、证据、批准、版本 |
| C3.3 | 上下文装配表落地：每个条目有维度、来源、作用域、强度、继承/私有、截断优先级；缺席维度不装配 | 装配层单测/快照；覆盖「无群组」「无子 Ticket」「离开群组」「轻量 Ticket」用例；prompt 走查 |
| C3.4 | 隔离可验证：worker 读不到别的 Ticket；子 Ticket 只回父 owner；不跨 Source 映射 | 现有 `orchestrator_read` 白名单与 `tests/` 断言；补子 Ticket 用例 |
| C3.5 | 不建通用记忆服务；经验只以版本化提案存在 | 设计评审 + 代码搜索（无新记忆存储） |
| C3.6 | 进化有前后指标：验收率、返工率、阻塞原因、审阅时长、每结果通知数 | 里程碑对比；无基线不采纳 |
| C3.7 | 装配有明确装配者、时机、只读快照与升级面；约束冲突、必需维度缺席或来源不可读时 fail closed | 装配层单测/快照；trace 审查；冲突注入用例 |

## 5. 原则 D：现有复杂组织必须可简化、可替换

### D.1 原则表述

当前已有的里程碑树、计划任务、worker/Assignment/Session 层级，以及 2026-11-09 修订版提议的类别、子 Ticket 与父 owner 链，主要**服务于解释与观察**：它们让「为什么这样做、谁做的、做到哪」可被审查；其中子 Ticket 也承担执行编排。它们不是产品本质，也不该成为新的授权层。设计必须能应对其中任何一层被简化、折叠或替换。

这条原则不是「现在就删」，而是「现在就不要把产品焊死在上面」。

### D.2 可替换边界

| 边界 | 可替换 | 不可替换/不可绕过 | 观测点 |
| --- | --- | --- | --- |
| 授权边界 | Eval、Ticket、Mandate、Action、Approval 的实现细节 | 「只有 Eval 创建 Ticket」「模型不授权」「动作闸门」 | Decision、Mandate、Action、Approval 记录 |
| 执行边界 | Executor、Assignment、Session、subagent、组织树、目录布局 | Ticket 仍通过 Assignment 记录执行；子 Ticket 有自己的 Assignment/worker（`worker-<childTicketId>`）与 `report`，但**不另开 Mandate/授权根**；结束条件仍由 Ticket 定义，父 owner 审查 | Assignment 状态、worker 槽位、报告、目录 |
| 任务视图边界 | 现有 Tasks/Events 计划视图；2026-11-09 修订版的 TaskView、类别覆盖层、看板/树/图 | 视图只读；归属不进入 Ticket；类别删除不丢任务；类别不等于群组上下文 | `GET tasks` 投影、ownership 派生 |
| 上下文边界 | prompt 装配、Session 历史、Source 读取实现 | Mandate/验收/授权不从上下文推导；kernel 不依赖宿主 | 上下文装配表、读资源、trace |
| 呈现边界 | 主会话、面板、右栏、结果卡 | 默认面只给结果与例外；通知预算 | 事件分级、通知计数、可用性走查 |
| 进化边界 | 提案、实验、策略/提示词/模板版本 | 不变量与领域概念不进化；不自动应用进化提案（已有类别的展示归属是可撤销例外，见 C.2） | 提案记录、版本历史、回滚记录 |

一句话：**授权语义不可替换（实现细节可换），组织与呈现层尽量可替换；二者之间用 Ticket/Assignment/Projection 三个窄接口隔开。**

观测点状态：Decision/Mandate/Action/Approval、Assignment/worker/报告、`GET tasks`/ownership、事件分级/通知计数是现有数据；层级深度、父审阅时长、孤儿子 Ticket 数依赖任务视图修订版的子 Ticket 数据，自动打开关闭率与替换证据需要新建采集，未落地前只作为检查点。

### D.3 观测点

替换前必须能看见「替换有没有改变结果」。现有观测点：

- （现有）`span` 的 trace 阶段（ingest…report）与 `activity` 的 quiet/feed/notice 分级；
- （现有）五个健康数字：判断耗时、重复发送、重启恢复、判定吞吐、审批等待；
- （现有）验收与返工：`Assignment.report.review`、`Review.confirmations`、review 结果；
- （现有）执行事实：Assignment 状态、worker 槽位、阻塞/失败原因、目录与分支。

原则 D 要求再补三类「组织观测」（均待建）：

1. **组织成本**（依赖任务视图修订版的子 Ticket 数据）：层级深度、活跃子 Ticket 数、父审阅时长、孤儿子 Ticket 数；
2. **注意力成本**（需新增采集）：每结果通知数、自动打开后关闭率、默认面点击深度；
3. **替换证据**（需演练采集）：同一个任务在「有组织视图/无组织视图」「有子 Ticket/扁平执行」下的结果、审计、通知是否等价。

### D.4 简化/替换路径

1. **先只读**：组织视图只读，不写 Ticket；任务视图修订版的类别/归属若落地，作为可一键恢复的覆盖层。
2. **再折叠**：树视图默认显示 L1–L3，右栏默认列表；L4+ 与执行细节按需；右栏不自动打开。
3. **再隐藏**：用 feature flag 或设置关闭某一层；保留 E2 诊断入口。
4. **最后移除**：连续若干里程碑无使用、且替换演练等价，才移除 UI 入口与投影；Ticket/Assignment/事件记录保留，可从记录重建。
5. **任何一步都不改授权与结束条件**；若必须改，说明这不是「简化组织」，而是领域变更，走独立设计。

### D.5 落地检查点

| # | 检查点 | 验证方式 |
| --- | --- | --- |
| C4.1 | 授权/执行/视图/上下文/呈现/进化六类边界在文档与测试中各就各位 | 对照 [docs/007](007-architecture.md) 依赖规则、`tests/kernel-boundary.spec.ts`、`tests/layers.spec.ts` |
| C4.2 | 做一次替换演练：同一任务隐藏任务视图/压平组织，结果与审计等价 | 记录任务、前后结果、通知数、验收 |
| C4.3 | 删除类别覆盖层不影响 Ticket；移除子 Ticket 委派后 Ticket/Assignment 仍可解释 | 迁移/回滚演练；投影只读断言 |
| C4.4 | 观测点不依赖被替换的 UI | trace/activity/metrics 独立读取；无 UI 也能取证 |
| C4.5 | 新人能在不看组织视图的情况下完成一次任务 | 可用性走查；失败记录为产品缺口 |

## 6. 逐条对照现有文档

### 6.1 对照表

| 文档 | 现有主张 | 关系 | 冲突/空白 | 取舍与原因 |
| --- | --- | --- | --- | --- |
| [docs/000](000-philosophy.md) | 注意力最小、价值最大；少概念、少设置、面板只显示需要人的事 | 支持 A；B/C/D 未展开 | 有总原则，缺组织与进化的具体约束 | 保留原文，本文作为展开；不重复改写 000 |
| [docs/001](001-domain.md) | 只有 Eval 创建 Ticket；Executor/Session 在领域外；拒绝跨源身份 | 支持 B、D | 子 Ticket 提案复用 Ticket，不新增新的实体类型；执行仍落在 Assignment/worker；需防止它变成第二授权层 | 接受「执行树」持久化，但授权仍只在根 Ticket/Mandate；`docs/001` 的「只有 Eval 创建 Ticket」按「只有 Eval 创建授权根 Ticket」解释；Engine delegation 创建的子 Ticket 不是授权主体，继承根授权与 `maxActionLevel`，不另开 |
| [docs/003](003-execution.md) | 一进程一体系；tracked 有 worker/Session/目录；subagent 是执行细节；目录不是安全边界；`reviewTicket` 只接受最新 Report，`approve` 不按 revision 令牌 | 支持 C 的六层上下文与 D 的执行边界 | 细节面向操作者，容易被误读为产品默认面；任务视图提案的 `ReviewAggregate`/`reviewRevision` 尚不存在 | 保留为操作文档；产品默认面按 B 的 E0/E1 分层；不把目录当组织/权限；6.6 的「按 revision 确认」只能作为提案，不能当作当前不变量 |
| [docs/005](005-panel.md) | 七 tab 管理面板；聚焦、安静、诚实；Tasks 是计划树 | 支持 A；与 B 部分冲突 | 默认面板暴露 Trigger/Eval/Execution；Tasks 树把计划编号当层级 | 面板定位为 E2 信任控制台，不是产品主界面；默认面按 E0；计划树在任务视图里降为标签/回退 |
| [docs/007](007-architecture.md) | kernel 零宿主依赖；依赖规则；worker 只读自己的 Ticket；读资源分页与上限 | 支持 C、D | 上下文规则分散在装配、prompt、读资源中，没有统一装配表 | 收敛成 C.3 的装配表；不改代码；用测试固定隔离 |
| [docs/009](009-conversation-tasks.md) | 对话可派活但 chat 不是 Trigger；主会话只协调；Ticket 仍是任务聚合，拒绝第二套 Task 实体 | 支持 A、B | 隐式派活会让每句话变成工作；状态问答与任务边界易混；任务视图修订版的子 Ticket 是 Ticket 自引用，不是第二 Task 聚合 | 保持显式 dispatch；默认面只给确认与结果；A 约束「不确认不派活」的文案；子 Ticket 仍由根 Ticket 授权，不是授权主体；类别只是展示覆盖层 |
| [012-platform-evolution.zh.md](012-platform-evolution.zh.md) | P1–P7 机制原则；M0 观测；N5 不做通用长期记忆；§5.3 的 WorkItem/Authority/Acceptance 与 lightweight 仍是目标模型 | 支持 A/D；与 C 有张力 | 目标模型与当前 kernel 的 Ticket/Mandate/Assignment/Review 不同；lightweight 的 kernel 契约（#29）已接上生产 `InlineWork` 与 Eval/route/dispatch 的 `form`，但能力只限一次只读仓库查文件；ADR-05 的外部 Acceptance 尚未实现 | P1–P7 继续管机制；本文管产品/组织；C.5 明确六层是装配不是记忆库；§8 单独记录这些实现边界，不把目标模型写成现状 |
| 任务视图提案（`docs/tasks-view-architecture.zh.md`，2026-11-09 修订版） | 10 条视图原则；类别→根 Ticket→子 Ticket；全页树默认 L1–L3、右栏默认列表；每个 tracked Ticket 节点有自己的 owner/worker，lightweight 叶子无 owner/worker；子 Ticket 先回父 owner，父 owner 审查后逐层上报 | 支持 B/C/D 的大部分 | 执行细节/内部 id 可能抢注意力；子 Ticket 易被误当授权主体；父审阅链可能成为瓶颈；归纳无验证闭环；右栏与树的默认值不同 | 接受树默认 L1–L3 与父 owner 审查链；右栏默认列表；执行单元放详情、L4+ 折叠、右栏不自动开；E1 不显示内部 id；子 Ticket 无 Mandate/Decision、不是授权主体；类别是可删覆盖层；新类别/合并/拆分类别先进提案/未归类，已有类别归属可按阈值自动应用并审计 |
| [M1-KICKOFF.zh.md](plan/M1-KICKOFF.zh.md) | M1 排期、决策、交接、PR ≤ 400 行 | 无直接冲突 | 不讲产品/组织原则；排期可能挤掉进化闭环 | 不要求 M1 改；C 的闭环可先离线/文档化，不等 M1；本文控制 diff 规模 |
| [SESSION-ENTRY.zh.md](plan/SESSION-ENTRY.zh.md) | 事件分级、单一通知预算、主会话状态页（§3.3）、事件栏首次自动打开（§3.4） | 支持 A；与 B 部分冲突 | 事件栏首次自动打开是明确决策，但会把 E2 推到默认面；状态页仅主会话且复用完整面板是已定案，不是冲突 | 保留 §3.3 与通知预算；自动打开作为信任期例外并可关闭，稳定期默认关闭——这是修订提案，需产品确认；不删事件记录 |

### 6.2 关键冲突与裁决

1. **面板暴露执行细节 vs A/B。** 裁决：面板是 E2，不是默认面；E0 只给结果与例外；E1 审查视图按需。保留全量记录，删除「默认推送」。
2. **任务视图的组织/执行细节 vs B/D。** 裁决：接受树视图默认 L1–L3、右栏默认列表与父子审阅（与「默认关心 2–3 级」一致），但执行单元（Assignment/subagent）放详情、不入层级；L4+ 折叠；右栏不自动打开；E1 不显示 worker/Session 内部 id；类别覆盖层可删，删了不丢 Ticket；子 Ticket 无 Mandate/Decision，不是授权主体。
3. **六层上下文 vs N5 不做通用记忆。** 裁决：上下文维度是**读取与装配规则**，数据仍来自 Ticket/Thread/Policy/Source；跨任务经验只以版本化提案存在，不建隐式记忆库。
4. **自我进化 vs「模型只判断、不授权」。** 裁决：进化可以提案改 prompt/策略/模板，但不能改授权代码；策略变更仍走设置/人工批准；worker 不能给自己扩权。
5. **可观测性优先 vs 注意力预算。** 裁决：记录优先，展示分级；trace 永远保留，默认面只给需要人的信息。
6. **M1 排期 vs 进化闭环。** 裁决：不阻塞 M1；先做离线观察与提案模板，等有数据再接运行时。

## 7. 原则冲突时的裁决顺序

当四条原则给出不同答案，按以下顺序让步（越靠前越硬）：

1. **安全与授权不变量**：授权、账本、验收、来源隔离不可绕过。
2. **A 注意力**：任何默认面都要先证明「人现在必须看到它」。
3. **D 可替换性**：不能为了短期展示把产品焊死在可替换的组织层上。
4. **B 内化**：默认隐藏组织与执行；审查期按 E1/E2 提供证据。
5. **C 自我进化**：可以提案，但不能违反 1–4；不能自动应用。

两个典型裁决：

- 「把组织树放到主会话右侧，帮助人信任」→ A 先问：人现在要决定什么？如果只是「想看看」，放 E1/E2，按需打开；如果组织异常导致人必须决定，给一条异常摘要 + 入口，不给整棵树。
- 「让父 worker 自动接受子交付，减少人的审阅」→ 1 先问：验收条件是否仍由人确认？可以自动接受低风险子交付，但最终验收仍由人确认；`Review.confirmations` 只保存需要人判定的验收项，不能替代验收动作；否则违反验收不变量。**当前实现边界**：今天的 `reviewTicket(ticketId, by)` 只对带 preview 的 review-stage Report 记录接受者/时间，接受的是最新 Report，没有 `reviewRevision` 参数；任务视图修订版的 `ReviewAggregate`/`reviewRevision`/`409 reviewStale` 仍是提案。没有确认项的 Ticket 仍按现有 ready/PR 关闭路径结束，PLATFORM ADR-05 的外部 Acceptance 还是目标而非现状。因此「按 revision 确认」只能在 6.6 落地后作为不变量，不能写成当前已实现的行为。

## 8. 状态、落地顺序与暂缓项

| 原则 | 状态 | 已有证据 | 下一步 | 暂缓 |
| --- | --- | --- | --- | --- |
| A 注意力 | 已采纳 | docs/000、docs/005、SESSION-ENTRY 的通知预算与事件分级；审批队列（#7/#10/#18）已进入面板 | 把 C1.1–C1.5 加进 UI/PR 检查；统计每结果通知数 | 暂不新增注意力仪表盘 |
| B 组织内化 | 待验证 | docs/001 的 Executor 在领域外；docs/009 主会话只协调 | 定义 E0–E3；默认面清理；事件栏自动打开作为信任期例外并可关闭；任务树默认 L1–L3、右栏列表 | 暂不删除管理面板/事件记录 |
| C 自我进化 + 六层上下文 | 待验证 | docs/007 的读资源/隔离；任务视图修订版的父 owner 审查链（提案） | 写闭环规格；做上下文装配表；离线跑一轮提案；补隔离用例 | 暂缓自动应用**进化**提案、通用记忆、本文自行新增领域实体 |
| D 可替换边界 | 待验证 | kernel-boundary/layers 测试；Executor 端口；现有 Tasks/Events 计划视图是读模型；子 Ticket/类别仍是任务视图修订版提案 | 做一次替换演练；补组织观测指标；任务视图修订版落地后验证类别/子 Ticket 可移除 | 暂缓移除现有任务树，等信任与使用数据 |

**当前实现边界（2026-11-09，校正状态表）**：

- **lightweight（#29 + T3-05 Phase 0）**：kernel 契约（`TicketForm`、`ticketForm()`、`InlineExecutor` 端口与测试）已接上生产 `InlineWork`：`assembly.ts` 注入 `inline`，Eval、`orchestrator_route` 与 `orchestrator_dispatch` 可写 `form: lightweight`，`executor.lightweight` 默认开启、设为 false 即回退 tracked。能力仍只限一次只读仓库查文件（最多 4 个路径），不建 Assignment/worker Session/workspace，不 commit/send/spend；端到端测试与 <10s 实测见 `docs/plan/TASK-PLAN.zh.md` 的 T3-05 行。任务视图修订版的 lightweight 行仍是前向兼容。
- **审批（#7/#10/#18）**：Approval 对象/状态机、出站动作生产方与面板待批队列已合入并被测试覆盖；这加强了 A/B 的现有证据，但不改变 C/D 的待验证状态，也不把 PLATFORM 的目标 Authority 模型写成现状。
- **任务树（2026-11-09 修订版）**：`TaskCategory`、`TaskPlacement`、子 Ticket 的 `parentTicketId`/`rootTicketId`/`delegation`、`ReviewAggregate` 都没有 schema/代码；任务页仍是计划树读模型。本文对任务视图修订版的「接受」是设计层接受，不是实现批准；运行时（T3-10 Phase 2a）仍需独立落地与验收。

落地顺序建议：**先 A（不改代码就能检查）→ 再 B（默认面与暴露分级）→ 再 D（替换演练，验证边界）→ 最后 C（有数据后再闭环）**。C 最后不是不重要，而是没有 A/B/D 的观测与边界，进化会变成拍脑袋。

## 9. 不做什么

- 不新增顶层 `Task` 或 `Organization` 授权聚合；任务仍是 Ticket（+ 执行树）。也不新增 `Membership` 或 `Group` 领域实体：群组只是 Source 的 Channel 地址与现有 Thread/Subscription 的上下文视图。本文自身不新增领域实体；任务视图修订版的 `TaskCategory`（覆盖层）与子 Ticket 自引用（复用 Ticket，不新增实体）是其独立提案，需按该文档的迁移/回滚与本文 C/D 检查单独评审，不因本文批准而自动实施。
- 不让 worker/进化循环自动改授权、账本、验收或生产代码。
- 不建通用长期记忆服务；不把 Session 历史当组织记忆。
- 不默认展示 Session、Assignment、子 Ticket 内部字段、worker id、trace。
- 不把当前任务树/类别/子 Ticket 当成最终形态；它们是可替换的观察层。
- 本文不改代码、schema、UI；落地检查点由后续独立变更完成。

## 10. 参考

- 原则与领域：[docs/000](000-philosophy.md)、[docs/001](001-domain.md)、[docs/003](003-execution.md)、[docs/005](005-panel.md)、[docs/007](007-architecture.md)、[docs/009](009-conversation-tasks.md)
- 演进与计划：[012-platform-evolution.zh.md](012-platform-evolution.zh.md)、[M1-KICKOFF.zh.md](plan/M1-KICKOFF.zh.md)、[TASK-PLAN.zh.md](plan/TASK-PLAN.zh.md)
- 入口与事件：[SESSION-ENTRY.zh.md](plan/SESSION-ENTRY.zh.md)
- 任务视图提案：[`docs/tasks-view-architecture.zh.md`](https://github.com/touch-agent/dsh-superagent/blob/main/docs/tasks-view-architecture.zh.md)（2026-11-09 Ticket 自引用修订版；PR #26 为历史稿）
- 代码入口：`packages/kernel/src/engine.ts`、`packages/kernel/src/model.ts`、`packages/dsh/src/app/tasks.ts`、`packages/dsh/src/app/ownership.ts`、`packages/dsh/src/app/activity.ts`、`packages/dsh/src/executor/dsh.ts`
- 契约测试：`tests/docs.spec.ts`、`tests/kernel-boundary.spec.ts`、`tests/layers.spec.ts`、`tests/activity.spec.ts`、`tests/tasks.spec.ts`