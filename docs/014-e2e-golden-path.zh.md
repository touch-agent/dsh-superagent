# 014 — E2E golden path：从 Issue 到已接受的合并

> 对应 [TASK-PLAN](plan/TASK-PLAN.zh.md) 的 X-03。入口 `pnpm test:e2e`，CI 工作流 `.github/workflows/e2e.yml`。
> 用例只有一条故事：`tests/e2e/golden-path.e2e.ts`。

## 1. 这条路径证明什么

这条用例从部署真正使用的 `Runtime` 出发，走完「源事件 → 评估/接受 → 工单 → 子工单与父审阅 → 交付 → 人工合并 → 人工批准（应用 pending end）」。
它断言的是契约，而不是内部实现：关键阶段的状态能在面板或任务树看到；父 owner 的 `child-report` 输入是内部队列。

| 阶段 | 用例断言 | 契约来源 |
| --- | --- | --- |
| 触发 | Source 的 `issueTrigger` 产生一条来自允许账号、@ 智能体的显式请求；主会话收到候选 | 源适配器、Eval 准入 |
| 授权 | `orchestrator_route` 接受后，根 Ticket 有 `explicit` Mandate，requester 是 Issue 作者而不是智能体；Decision 记录 trigger 批次 | Mandate、Action 等级、审计 |
| 工单 | 根 Ticket 是 `tracked`，有 worker Session、工作目录与分支名；Thread 订阅到根 Ticket | Ticket 生命周期、执行环境 |
| 子工单 | 父 owner 通过 `orchestrator_child` 建两个子 Ticket：同 root、各自 owner/worker、无自己的 Mandate/Decision；子 Ticket 不进入根列表，也不能被面板直接批准 | 任务树 Phase 2a |
| 父审阅 | 子交付作为 `child-report` 进入父输入；父 owner 接受两个子交付后退回其中一个已接受交付重做，退回的交付退出聚合且 `reviewRevision` 变化；重做后再次接受；父在子未结束时 `ready` 被 `unfinishedChildTickets` 拒绝 | 父 owner 审查链、结束门 |
| 交付与 PR | 父报告 PR 号后，PR 按分支末段绑定到根 Ticket；报告 `ready` 时 PR 仍开着，Ticket 不结束 | PR 绑定、follow/结束语义 |
| 父审阅投影 | 根与已接受子的交付按 `kind:ref:revision` 去重；子 Ticket 的 `HumanCriterion` 进入根的 review；父接受不等于人的确认 | T3-11 `TaskReviewView`、`reviewAggregate` |
| 人工批准 | PR 先合并时只记 `endPending`/`end-gate`，不静默结束；面板用当前 `reviewRevision` 批准后应用 pending end；旧 revision 会 409 | Approval 之外的人审门 |
| 人工合并 | Source 观察到 PR merged 后先记 pending end；人工批准当前 revision 后 Ticket 以 `merged` 结束，批准仍覆盖同一交付 revision；任务树显示终态 | 结束门、Thread 关闭 |

「分支」在这里不是另建一个 Git 仓库来验证：接受时固定的 `execution.name` 同时是工作目录名和 PR 分支末段，
`claimPull` 用 `ticketBranch` 校验它。真正创建 worktree、跑 `git`、开 PR 和点合并的是执行器和人；本用例用本地
fixture 替换了这些外部副作用。

## 2. 怎么跑

```sh
pnpm test:e2e
```

它不进入 `pnpm check`：`pnpm check` 保持领域测试的秒级反馈和构建门，E2E 是独立的质量门。CI 在每次 PR 与 `main`
上跑 `e2e` 工作流，与 `check`、`changesets` 并列。需要 Node 24 与已安装的 workspace 依赖，不需要 `dsh` 全局安装。

## 3. fake host 与边界

- **宿主**：`tests/fixtures/host.ts` 的 `startRuntime` 提供 DSH 的 agent、Session、subagent、job、web server 等服务，
  启动真实的 `Runtime`、SQLite `Store`、`Engine`、执行器与面板 HTTP 路由。
- **源**：Issue 由 `issueTrigger` 从一条本地 fixture 构造，PR 由 `observePull` 送入；GitHub CLI 的读取与写入在用例里
  以函数替换，返回本地的 PR、空评论列表与成功响应。没有网络、token 或真实账号。
- **人**：面板批准走真实的 `POST tickets/:id/approve` 路由；「人工合并」是外部事实，由 Source 的观察函数送入，
  而不是用例自己调用 `engine` 改状态。
- **模型回合**：执行器与它注册的工具是真实的，但 worker 的模型回合不由用例驱动；用例直接调用这些工具并推进
  Runtime 的队列，所以覆盖的是工具之后的契约，不是模型是否选择了正确的工具。
- **不覆盖**：真实 DSH 宿主版本矩阵（X-10）、`dsh plugin add` 安装/卸载（X-08）、真实 GitHub/Feishu 凭据与网络、
  实际 Git 命令与 PR 页面、浏览器里的面板渲染。这些分别由 X-08、X-10、T3-11 的测试和人工验收承担。
- **不覆盖 lightweight**：轻量工单有自己的内联动作账本与测试；这条 golden path 只走契约要求更完整的 tracked 路径。

## 4. 稳定性

- 用例**不重试**。真实失败必须红；没有「重跑一次就好了」的分支。CI 也不配置 retry。
- 时间、Issue/PR 号、分支名与 fixture 内容都由用例固定；唯一的运行时依赖是临时目录和本机 Node。
- 超时 30s 只用于给慢 CI 留余量，不是等待外部状态；正常执行约 1–2s。
- 如果失败只发生在某台机器上，先区分环境问题与契约回归；只有确认是外部抖动才在 CI 层处理，不能靠重试掩盖。

## 5. 维护

- 一条故事、一个 spec 文件。新增阶段时优先在现有故事里加断言，不要复制成第二条「差不多」的 E2E。
- 断言面向用户可见状态与领域返回值（Decision、Mandate、子 Ticket、review revision、ending），不要断言日志、
  内部调用次数或完整对象快照；这样重构仍能通过，真正的契约变化才会红。
- 契约变化时同步更新本文件、`TASK-PLAN` 的 §14 与 `TRACKING.zh.md` 的 X-03 行；改动后至少跑
  `pnpm typecheck && pnpm test && pnpm test:e2e`。