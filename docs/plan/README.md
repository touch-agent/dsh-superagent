# 计划文档

本目录存放执行层：里程碑与任务定义、带日期的启动/设计记录，以及唯一的任务状态表。
文档按「定义」和「状态」分工，避免同一事实写两遍后漂移。

| 文档 | 角色 | 更新方式 |
| --- | --- | --- |
| [TASK-PLAN.zh.md](TASK-PLAN.zh.md) | 里程碑、任务分解、排序原则、验收口径与完成定义。 | 任务定义变化时更新；带日期的进度段落是快照。 |
| [M1-KICKOFF.zh.md](M1-KICKOFF.zh.md) | M1 启动条件、决策、排期与交接，2026-11-07 的记录。 | 历史记录，不追改；新决策写进 TASK-PLAN 或新的决策记录。 |
| [SESSION-ENTRY.zh.md](SESSION-ENTRY.zh.md) | M1.6 主会话入口、状态页与事件栏的设计、宿主核验与任务分解。 | 设计变化时更新。 |
| [TRACKING.zh.md](TRACKING.zh.md) | 每个任务的状态、PR、验收证据与最后更新，唯一状态源。 | **合并即更新**；每次状态变化只改对应行。 |
| [TRACKING-EXEMPTIONS.json](TRACKING-EXEMPTIONS.json) | 过渡期的显式豁免清单。 | 只在条件满足前保留；每条都要能复核，条件消失即删除。 |

## 任务跟踪格式

`TRACKING.zh.md` 的每一行固定五个字段：

| 字段 | 取值 |
| --- | --- |
| 任务 | `T0-01` 形式的任务编号，与 `TASK-PLAN.zh.md` 中的编号一一对应。 |
| 状态 | `未开始` / `进行中` / `已完成` / `已暂停` / `已取消`。 |
| PR | 形如 `https://github.com/touch-agent/dsh-superagent/pull/<n>` 的链接；没有 PR 时写 `—`（直接提交或历史任务）。 |
| 验收证据 | 能复核的测试文件、命令、演练或文档；未开始时写 `—`。 |
| 最后更新 | `YYYY-MM-DD`，这一行最近一次状态/证据变化的日期。 |

### 状态语义

`未开始` 不填 PR 和验收证据（都写 `—`）。`进行中` 必须有 PR；确实还没有 PR 时，必须在 `TRACKING-EXEMPTIONS.json` 里给出带原因、规则为 `in-progress-without-pr` 的豁免。`已完成` 必须有验收证据；PR 已填写时，CI 查询到的 PR 必须是 merged。`已暂停` / `已取消` 仍要求合法日期和合法 PR 链接，但不要求 merged。

PR 只接受 `https://github.com/touch-agent/dsh-superagent/pull/<n>`；其他形式（包括 issue 链接、短链、fork 链接）都算漂移。

## 合并即更新

- 一个 PR 改变某任务的状态时，在**同一个 PR** 里更新该任务的行；直接提交完成的任务由最后那次提交更新行。
- PR 打开期间状态是 `进行中`，PR 字段指向该 PR。合并是写 `已完成` 的必要条件，不是充分条件：只有验收证据满足任务定义的验收口径时才写 `已完成`；PR 已合并但验收还有缺口，仍记 `进行中` 并在验收证据里写明缺口。不预填、不提前宣布完成。
- `最后更新` 写这次改动的日期；验收证据写这次实际跑过的检查，不复制旧证据。
- 任务完成依赖本次 PR 合并时（如 X-12），PR 打开期间仍记 `进行中` 并填 PR；合并后由紧接着的一次直接提交或后续 PR 改为 `已完成`，验收证据写合并提交或 PR。
- 开始一个新任务前先读状态表；如果行与仓库事实不符，先修正行再继续。
- 状态只写在 `TRACKING.zh.md`。README 的里程碑表是摘要，计划文档里带日期的「进度」段落是快照，都不作为当前状态依据。

## 自动校验

`scripts/check-tracking.mjs` 检查「定义 ↔ 状态 ↔ PR」三者一致：计划任务集与跟踪表行集、五个字段、状态取值、验收证据、日期、PR 链接格式与存在性、`已完成` 的 merge 状态。它只报告差异，不改表。

```sh
pnpm check:tracking
# 查询 PR 存在性与 merge 状态（本地用 gh 的 token）
GH_TOKEN=$(gh auth token) node scripts/check-tracking.mjs --check-prs
```

`pnpm check` 已包含 `check:tracking`（离线）；CI 的 `tracking` job 额外传 `--check-prs`，所以坏链接或「已完成指向 open PR」会让 CI 变红。`GITHUB_TOKEN` / `GH_TOKEN` 缺失时 `--check-prs` 直接失败，不静默跳过；不带该参数时不访问网络，只做格式与语义检查。

### 显式豁免

`TRACKING-EXEMPTIONS.json` 是唯一的豁免清单；没有文件等同于没有豁免。只有两类问题可豁免：`in-progress-without-pr`（进行中但还没有 PR）与 `completed-pr-not-merged`（已完成的 PR 尚未 merged）。格式、缺行、坏日期、坏链接等结构问题不可豁免。

```json
{
  "exemptions": [
    { "task": "T1-01", "rule": "in-progress-without-pr", "reason": "直接提交期间没有 PR" }
  ]
}
```

每条豁免必须写任务、规则和非空原因；任务必须在计划里，规则必须是上面两种之一。没有被触发的豁免会被判为 stale 并报错，避免清单长期积累。豁免只是过渡，条件满足后应删除。

`tests/docs.spec.ts` 继续固定表格形状（每个 TASK-PLAN 任务恰好一行、字段与格式）；`tests/tracking.spec.ts` 覆盖新检查的拒绝与豁免路径。

```sh
./node_modules/.bin/vitest run tests/docs.spec.ts tests/tracking.spec.ts
```
