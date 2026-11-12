# 020 进化闭环：离线观察与只提案

> 状态：T5-05 的**离线实现**已落地（Phase 1 观察/提案 + Phase 2 价值门）；只读现有遥测，不接生产写入，不自动选择 profile，不自动应用提案。
> 关联：[011 设计原则](011-design-principles.zh.md) §4 C.1/C.2/C.6、[016 AgentProfile](016-agent-profile.zh.md) §4 与 §4.5、[任务计划](plan/TASK-PLAN.zh.md) T5-05、[TRACKING](plan/TRACKING.zh.md)。
> 代码：`scripts/evolution/core.ts`（`gate()` 为 Phase 1 回归门，`valueGate()`/`valueGateOf()` 为 Phase 2 价值门）、`scripts/evolution/export.mjs`、`scripts/evolution/run.mjs`；测试：`tests/evolution.spec.ts`。

## 1. 结论先行

T5-05 要的是一条**独立于执行 worker** 的「观察 → 总结 → 进化 → 验证」闭环，而不是在工单里边做边改。本条实现把它收在离线脚本里：

- **观察**：从既有 SQLite Store 只读导出最近结束的工单，冻结 profile 按 `effective.hash`、moving profile 按 run `effective.hash` 与任务族聚合；没有 profile 快照的工单单列 `legacy`。`moving` 组不进入因果比较；`worker-default@1` 若为 moving，只作描述性基线。
- **总结**：生成带样本引用、置信度、适用范围和缺口的诊断；低置信、无基线、无样本只记录，不提案。
- **进化**：把候选经验写成版本化提案文档，包含 `baseRevision`、`proposedRevision`、字段 diff、证据、风险、回退条件与人审队列。
- **验证**：提案必须带预登记的评测集/holdout、主指标、MDE、α、power、样本量、分配方式、护栏和停止规则；没有回放证据只能停在「证据不足」。
- **价值门（Phase 2）**：在 Phase 1 回归门之上把结论归为四结局——`improvement`、`no-difference`、`guardrail-regression`、`insufficient-evidence`；只有同时满足「显著改善」与「无护栏回退」才标为建议采纳（`recommendation=adopt`），其余一律 `do-not-adopt` 并给原因。指标覆盖成功率、返工、review 发现、延迟和成本；宿主未提供的数据保持 `unknown`，不按 0 计。
- **只提案**：`core.ts` 不 import `node:fs`、Store、Profiles 或任何写入 API；CLI 只把报告和队列写到操作者指定的目录。人工批准后用现有 profile 面板/registry 创建 revision 并激活，回退指针指回 `baseRevision`。

## 2. 运行规格

### 2.1 输入

四个只读 JSON 输入，均为严格字段白名单；未知字段直接拒绝，避免样本/评测集私密全文混入。候选假设、diff 描述和停止规则是分析者写入的提案文本，会进入报告，需按内部信息审阅。

| 文件 | schema | 内容 |
| --- | --- | --- |
| 样本集 | `evolution.samples.v1` | 脱敏工单样本：哈希引用、profile 坐标、任务族、成功/返工/失败码、review 接受、延迟、token 可得或 `null`、环境指纹 |
| 评测集 | `evolution.evalset.v1` | 版本化 manifest：holdout 条目、replay 模式（`dry`/`sandbox`/`human`）、评分方式、环境指纹、隐私与副作用声明；条目可带 `observationRef`（与样本相同的哈希引用）用于污染检查 |
| 候选经验 | `evolution.intents.v1` | 人工/分析者给出的候选 diff、基线坐标、假设与预登记实验参数 |
| 回放证据 | `evolution.eval-results.v1` | 基线/候选配置摘要、环境、配对回放或随机分配的逐条结果；没有则只能得到「证据不足」 |

样本集里没有标题、摘要、prompt、review 正文、消息文本或账号；`id` 只接受短的不透明引用。评测集必须声明 `containsPrivate=false`、无外部写、无 push/send/merge。

### 2.2 观察与聚合

`scripts/evolution/export.mjs` 以 `readOnly: true` 打开 `<stateDir>/orchestrator.sqlite`，读取最近 `--limit N` 条已结束工单；工单 id 变成 SHA-256 前缀，`endedReason` 只在符合短 reason code 时保留。导出器不写数据库、不调用模型、不读 profile 注册表。

聚合规则与 [016 §4.2](016-agent-profile.zh.md) 对齐：

- 分组键：`有效配置 | 任务族 | form`。冻结配置按 `effective.hash`；moving 按 Session 记录 run `effective.hash` 分组；legacy 单列；`moving` 标 `comparable=false`。
- 根工单成功率分母是「已绑定、已结束的根工单」；`dropped`/`stopped` 不进分母，`closed` 计为未成功；censor 单列。
- 子工单成功率按 `delegation.resolution.kind=accepted`，不按 ended outcome；lightweight 单列，均不并入根成功率。
- 返工按 assignment 退回、父 owner `return`、ready 后 `resumed` 计算；新 Assignment 尝试和 `reviewRevision` 变化暂未纳入，运维重试不当作返工。
- review 只记录 `reviewed` / `accepted` / `unaccepted` 与评论可得性；未接受不等于被拒绝。PR 评论在 Phase 1 不可得，保留 `unknown`。
- 延迟同时给出 dispatch→ready 与 ready→end 的 p50/p90，审阅时长不会被丢掉。
- token 只有全部 tracked 样本都可得时才给合计，否则 `unknown`；货币成本恒为 `unknown`，**不进入任何门**；每结果通知数只在样本提供时可用，否则 `unknown`。
- 小样本不做分析期抑制；`n<5` 只是展示层隐私措施，诊断报告 `n` 和区间。

### 2.3 总结与降级

诊断对每个候选 profile 组挑选同任务族、同 form、同环境指纹的基线；基线优先级是 `worker-default@1` → `legacy` → 其他显式 profile。legacy 与 `worker-default@1` 永远不混在同一对照组。若 `worker-default@1` 是 moving，只作描述性基线（`notComparable`，不生成因果提案）；因果提案要求冻结基线。

置信度：

| 置信度 | 条件 | 行为 |
| --- | --- | --- |
| `low` | 任一组根样本 <10、环境不一致、moving、无基线或无成功样本 | 只写入诊断，不生成提案 |
| `medium` | 两组均 ≥10、方向为正、可比 | 可进入提案，但评测门仍须通过 |
| `high` | 两组均 ≥30，且差值 95% 区间下界 >0 | 可进入提案，仍不自动采纳 |

结论和 `withheld` 会明确写出 `noSamples`（结论）、`noSuccessSample`、`lowConfidence`、`noBaseline`、`notComparable`、`baselineMismatch` 等原因；没有候选 diff 时结论是 `noCandidateExperience`，不是「没有收益」。

### 2.4 提案格式

提案是一个文档，不是 `Decision.audit`，也不是运行配置。字段：

- `hypothesis`：一句话可证伪假设；
- `evidence`：候选/基线 `effective.hash`、任务族、样本量、成功率、返工/阻塞、窗口、最多 8 个不透明样本引用；
- `confidence` 与 `scope`：只写具体任务族/角色，不写「所有任务」；
- `baseRevision` / `proposedRevision` / `diff`：diff 只允许 `title`、`description`、`model`、`tools`、`prompt`、`evalBaseline`；`maxActionLevel`、`approval`、`permissionPreset`、`mandateMinutes`、`sources`、`roles`、`credentials`、revision 生命周期字段全部拒绝；`prompt.mode=live`、`model.mode=inherit`、`tools.mode=inherit` 等 moving diff 同样拒绝；
- `expected`：主指标、基线/候选率、绝对差、MDE、按 MDE 算出的每组样本量；
- `experiment`：评测集/holdout、分配、α/power、护栏、停止规则；
- `risks`：漂移、选择偏差、评测污染、权限误读；
- `rollback`：回到 `baseRevision` 的条件与操作；运行中工单保持绑定快照，不受 active 指针回退影响；
- `gate`、`valueGate`、`approval`、`applied=false`、`liveConfigChange=false`、`decidedBy=null`。

### 2.5 验证门

`gate()` 的顺序与判定：

1. **预登记完整性**：评测集 id/revision 与 intent 一致；holdout 非空；holdout 的 `id` 或 `observationRef` 与观察样本哈希引用不相交；观察环境、回放环境和 manifest 的环境指纹一致；回放证据的 baseline/candidate 摘要等于提案的基线/候选 `effectiveHash`；停止样本量不得小于按 MDE 算出的所需样本量。
2. **样本量**：`n` 按基线率、MDE、α、power 的两比例公式计算；不足直接 `insufficient(sampleSize)`，不因区间看起来好就淘汰样本量规则；达到所需样本后仍须达到预登记的 `stopping.afterSamples`，否则 `insufficient(stoppingNotReached)`（单次预登记读取，不做 early look）。
3. **护栏**：返工率、阻塞/失败率、p90 dispatch→ready、review 拒绝率不得比基线恶化超过预登记阈值；p90 不可得时 `insufficient(guardrailUnknown)`；token 可得时按预登记的相对增长阈值护栏，货币成本不可得时**不设成本门**。
4. **主指标**：配对回放用 McNemar 精确检验 + 配对差的 1−α 区间；随机分配用两比例 z 检验 + 差值区间；区间水平取预登记 α（默认 0.05，即 95%），不是固定 95%。
   - `pass`：差值 ≥ MDE、1−α 区间下界 >0，且双侧 p < 预登记 α；
   - `no-difference`：达到预登记样本且区间上界 < MDE（可明确写「没有可测差异」）；
   - `reject`：区间整体为负，或护栏恶化；
   - `insufficient`：样本不足、区间跨 MDE、holdout 污染、环境不一致或没有证据。

没有 `pass` 的提案只能是 `pending-evidence` 或 `not-adopted`；审批队列只收 `ready-for-human-approval`，且只是文档。

### 2.6 价值门（Phase 2）

Phase 1 的 `gate()` 继续负责预登记、样本量、停止点、α/MDE、holdout 与统计/护栏判定。Phase 2 新增的 `valueGateOf(plan, gateResult)` 只**分类**这个结果，不重算、不放宽 Phase 1 规则；`valueGate(plan, evidence, evalSet, observationIds, environments)` 是「跑 Phase 1 门再分类」的便捷入口。每个提案带 `valueGate`，报告带同序的 `valueGates`。

**四结局**（`outcome`，互斥）：

| 结局 | 条件 | `recommendation` |
| --- | --- | --- |
| `improvement` | 未舍入的主指标差值 ≥ 预登记 MDE、1−α 区间下界 >0、双侧 p < 预登记 α，且所有可用护栏未回退 | `adopt`（建议采纳） |
| `no-difference` | 达到预登记样本与停止点，但区间上界 < MDE；或主指标区间整体为负（`primaryRegression`） | `do-not-adopt` |
| `guardrail-regression` | 任一可用护栏超过预登记阈值（返工、阻塞/失败、p90、review 拒绝、token 增长） | `do-not-adopt` |
| `insufficient-evidence` | 缺证据、样本/停止点不足、holdout 污染或不匹配、环境/配置不一致、p90 护栏未知、区间跨 MDE | `do-not-adopt`（先补证据） |

`no-difference` 表示「没有达到 MDE 的改善」；主指标显著变差时用 `reasons=[primaryRegression, noDifference]` 单独标出，不伪装成「没有差异」。`insufficient-evidence` 的 `reasons` 沿用 Phase 1 的稳定原因码（`sampleSize`、`stoppingNotReached`、`guardrailUnknown`、`holdoutOverlap` 等），不以 0 或「无差异」代替。

**指标覆盖**（`valueGate.metrics`，每项带 `state=available|unknown` 与 `verdict`）：

| 指标 | 来源 | 缺失时 |
| --- | --- | --- |
| 成功率 | 主指标：根工单成功率差值、区间、p 值 | 无样本则 `unknown`，不能当 0 |
| 返工 | 护栏 `reworkRate` | `unknown`，不通过也不失败 |
| review 发现 | 护栏 `reviewRejectionRate`；PR 评论仍不可得 | `unknown`，不把「未接受」当「被拒绝」 |
| 延迟 | 护栏 p90 dispatch→ready | `unknown` 时 Phase 1 门直接 `insufficient` |
| 成本 | token/run 护栏（相对增长阈值）；货币成本无定价表 | token 缺失时 `cost.state=unknown`、数值为 `null`；`monetaryCost` 恒为 `unknown`，**不作为门**，不写「成本更低」 |

**不制造假改善**：

- 比较使用精确存储值，不在比较前四舍五入；显示层可以把 9.95pp 写成 10.0pp，但 `9.95pp < 10pp` 仍不能通过 MDE。`criteria.unroundedComparison` 明确记录这一点。
- 小样本的「100% vs 0%」不会因为 p 值小就采纳：必须先达到按基线率/MDE/α/power 算出的每组样本量与预登记停止点。`insufficient-evidence` 是正确结论，不是「无差异」。
- 只读一个预登记主指标；不做 early look，不用事后分层或改阈值制造显著性。
- 若 p90 未知、但已达到样本量且其他护栏已经回退，Phase 1 保留可用统计量，价值门仍判 `guardrail-regression` 并点名回退的指标，而不是把已知回退埋进「证据不足」。
- 结论仍只是文档：`applied=false`、`liveConfigChange=false`、`decidedBy=null`；`valueGate` 不写 profile、不改生效配置或权限字段。

## 3. 人工批准、生成新版本与回退

1. 人读 `report.json` 与 `approval-queue.json`；队列只是指针，不是写入接口。
2. 批准后看候选 revision 是否已存在：已存在则激活它；不存在则把同一 diff 保存为 registry 分配的下一个 revision。`proposedRevision` 是**观察到**的候选标签，不是新 revision 的编号。保存后必须核对 registry 计算的 `effective.hash` 等于提案的 `evidence.candidate.effectiveHash`；不等则停止并重做提案。
3. 激活只绑定**新工单**；运行中工单保留绑定快照。
4. 护栏触发或主指标低于 MDE 时，把 active 指针指回 `baseRevision`；已绑定工单不受影响。现有 `tests/profiles.spec.ts` 已覆盖「回退后已绑定工单不变」。
5. 新 revision 的 `provenance` 由人工保存路径写入，`by` 是人；模型/CLI 不能填 `decidedBy`。

**没有自动应用路径**：`core.ts` 无文件/存储/profile 写入；`run.mjs` 只写 `report.json` 和 `approval-queue.json`；`applied` 恒为 `false`。这不是靠文档承诺，而是由测试读取模块导出与源码 import 断言。

## 4. 首轮试点（运行证据，不是价值证据）

2026-11-11 在本机 Store 上以最近 10 条已结束工单跑通流程：

```sh
node scripts/evolution/export.mjs --db "$DSH_HOME/orchestrator.sqlite" \
  --out /tmp/evolution/samples.json --limit 10 --at 2026-11-11T05:30:00.000Z
node scripts/evolution/run.mjs --samples /tmp/evolution/samples.json \
  --out /tmp/evolution/report
```

结果：10 条样本全部是 `legacy`、root、`conversation/tracked`；根成功率 10/10；返工 4/10；review 4 条有审阅、接受 0/10；token 仅 1/10 可得（合计 `unknown`）；没有 profile 组、没有候选 diff，结论为 `insufficient-evidence` / `noCandidateExperience`。

这轮只验证流程可跑、字段可复核、无写入；**不**说明任何 profile 更好，也不足以做价值判断。按 T5-05，只有 10 条「跑通样本」，不是收益证据。

## 5. 与检查点、两道门的对应

| 检查点 | 对应实现 |
| --- | --- |
| C3.1 运行规格：样本、提案格式、批准人、应用方式、回滚 | 本文 §2–§3；`parseSampleSet`/`parseIntents`/`parseEvalSet`；approval queue 文档 |
| C3.2 进化角色与执行角色分离；提案独立审计链 | 离线脚本不依赖 worker Session；样本引用、证据、confidence、approval、revision 均在提案里 |
| C3.5 不建通用记忆服务；经验只以版本化提案存在 | 无新表、无新 Store、无记忆服务；提案是 JSON 文档，不写生产配置 |
| C3.6 进化有前后指标 | 根/子/lightweight 成功率、返工、阻塞/失败原因、review 接受、dispatch→ready 与 ready→end 延迟；token 可得/unknown，通知数未提供时 unknown；无基线不采纳 |
| [016 §4.1](016-agent-profile.zh.md) 独立、只提案、人审 | `core.ts` 无写路径；`applied=false`；批准人字段恒为 `null` |
| [016 §4.2](016-agent-profile.zh.md) 观察口径 | 根/子/lightweight 分开；censor、closed、fallback、moving 单列；`n<5` 仅展示抑制 |
| [016 §4.3](016-agent-profile.zh.md) 总结与提案字段 | 假设、证据、置信度、范围、预期、风险、回退；低置信不提案 |
| [016 §4.4](016-agent-profile.zh.md) 评测集与回归门 | holdout、环境指纹、MDE/α/power/样本量、分配、护栏、停止规则；允许「不采纳」 |
| [016 §4.5](016-agent-profile.zh.md) Phase 1/Phase 2 两门 | Phase 1 证明可观测性；Phase 2 价值门要求回放证据；`valueGate` 以四结局区分证据不足、无差异、改善与护栏回退，没有对照就停在 Phase 1 |

## 6. 边界与后续

- **回放证据由外部 harness 提供**：本任务不调用模型、不起 Session、不 push/send/merge；`eval-results.json` 是离线结果。真实价值实验仍需按 016 §4.4 运行 holdout。
- **PR 评论、货币成本不可得**：保留 `unknown`，不用单价估算，也不把成本写成门。价值门的 `cost` 指标在 token 不可得时是 `unknown`，货币成本恒为 `unknown`。
- **没有 UI、没有 selector、没有生产写入**：T5-05 只交付离线流程；`valueGate` 只分类证据，不写 profile、不改生效配置或权限字段。后续接运行时必须另走设计/评审，不能把脚本扩成自动应用。
- **试点数据不提交**：导出文件可能含内部引用，默认只留在本机；仓库测试使用合成 fixture，CLI 可对任意脱敏导出重放。
- **review 的「未接受」不是「被拒绝」**：观察里只有 `Report.accepted` 的事实；拒绝率只在回放 harness 明确给出 `reviewRejected` 时才作为护栏。
- **仍缺的观察口径**：新 Assignment 尝试、`reviewRevision` 变化与每结果通知数尚未从 Store 可靠提取，相关字段保持 `unknown`，不写成 0；holdout 污染检查依赖 manifest 的 `observationRef`，没有该引用时只能检查条目 `id`；任务族当前取 `Source/form`，不是独立的任务分类字段。
- **提案文本不是脱敏证据**：假设、diff 描述和停止规则由分析者提供并进入报告，可能含内部信息；样本与评测集本身仍走字段白名单，不接收自由文本。

## 7. 独立 review 清单（对照 C 与 016 两门）

review 应逐项挑战：

1. **只提案是否真无写路径**：`core.ts` 是否 import `node:fs`/Store/Profiles；导出函数是否有 apply/write/save/activate；CLI 是否只写 out 目录；`applied`/`decidedBy` 是否恒为假/空。
2. **门是否先预登记再判断**：holdout 是否与观察集分离；环境指纹是否一致；样本量是否按基线率和 MDE 算；停止规则是否早于所需样本；护栏是否可被「主指标好看」覆盖；是否有成本门。
3. **无样本/低置信是否正确降级**：是否返回 `insufficient-evidence` 而不是 0 或「无差异」；`no-difference` 是否只在达到样本且区间上界低于 MDE 时出现。
4. **基线是否分开**：legacy 与 `worker-default@1` 是否可能混组；moving 是否进入因果比较；子/轻量是否混入根成功率。
5. **隐私**：样本/评测集是否拒绝未知字段和自由文本；证据是否只有不透明引用与聚合；提案文本是否被清楚标注为分析者提供；token/成本是否保持 `unknown`。
6. **提案身份**：新 revision 是保存还是激活；registry 计算出的 `effective.hash` 是否与证据一致；moving diff 是否被拒绝。
7. **回退**：提案是否带 `baseRevision`、回退条件与 `preservesBoundTickets=true`；已绑定工单是否不受 active 指针变化影响。
8. **改善是否被四舍五入或小样本偶然驱动**：MDE 比较是否用未舍入值；`9.95pp` 是否会被显示成 `10.0pp` 后误判为通过；小样本的 100% vs 0% 是否仍被 `sampleSize`/`stoppingNotReached` 拦下；是否只读一次预登记主指标、没有 early look。
9. **四结局与建议是否互斥可复核**：`improvement`/`no-difference`/`guardrail-regression`/`insufficient-evidence` 是否只取一个；`recommendation=adopt` 是否只出现在 `improvement`；`no-difference` 与 `insufficient-evidence` 是否没有被混成「没有收益」；cost 缺失是否保持 `unknown` 而不是 0。