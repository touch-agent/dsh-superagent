# TRACKING — 任务状态、PR 与验收证据

> 唯一状态源。格式与「合并即更新」约定见 [README.md](README.md)。
> 初始建表 2026-11-08：历史任务按当日仓库、PR 与计划文档中能复核的证据回填；没有完成证据的任务记为 `未开始`，发现不符时先修表。`最后更新` 是这一行最后一次改动日期。
> 2026-11-08 重评估：新增 T3-09…11、T5-01…06、X-13（均未开始）；X-12 随 PR #31 合并改为已完成；T3-05 的验收口径改为 Phase 0 剩余项。
> 2026-11-09 设计修订：T3-10/T3-11 从独立 `Subtask` 类型改为 `Ticket` 自引用（子 Ticket + 父 owner 审查链 + 根授权唯一），范围见 TASK-PLAN；实现见 PR #40。

## 任务跟踪表

| 任务 | 状态 | PR | 验收证据 | 最后更新 |
| --- | --- | --- | --- | --- |
| T0-01 | 已完成 | — | `fcbae91`；schema 11→12，62 文件 / 1212 测试 | 2026-11-08 |
| T0-02 | 已完成 | — | `7f11e0d`、`ab8f6c5`；一条 trigger 的 trace 十段齐全 | 2026-11-08 |
| T0-03 | 已完成 | — | `1377989`；`tests/metrics.spec.ts` 四指标 | 2026-11-08 |
| T0-04 | 已完成 | — | `1377989`；Overview「运行健康」与中断/恢复提示 | 2026-11-08 |
| T0-05 | 已完成 | — | `894c1a5`；changesets 与包体积门 | 2026-11-08 |
| T0-06 | 已完成 | — | `492e668`、`a3809b1`；`../runbooks/why-not-sent.md` 与三次查找演练 | 2026-11-08 |
| T1-01 | 已完成 | — | `packages/kernel/src/manifest.ts`；`tests/manifest.spec.ts` | 2026-11-08 |
| T1-02 | 已完成 | — | `packages/dsh/src/sources/manifest-form.ts`；`tests/manifest-form.spec.ts` | 2026-11-08 |
| T1-03 | 已完成 | — | `packages/dsh/src/sources/registry.ts`；`tests/registry.spec.ts` | 2026-11-08 |
| T1-04 | 已完成 | — | GitHub manifest 与 adapter；`tests/conformance/github.spec.ts` | 2026-11-08 |
| T1-05 | 已完成 | — | Feishu manifest 与 adapter；`tests/conformance/feishu.spec.ts` | 2026-11-08 |
| T1-06 | 已完成 | — | `tests/conformance/suite.ts`、`suite.spec.ts`（PR #1 关闭后由 main 上的提交承接） | 2026-11-08 |
| T1-07 | 未开始 | — | — | 2026-11-08 |
| T1-08 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/3 | `tests/conformance/feishu-doc.spec.ts`；飞书文档 Source | 2026-11-08 |
| T1-09 | 未开始 | — | — | 2026-11-08 |
| T1-10 | 未开始 | — | — | 2026-11-08 |
| T1-11 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/9 | `tests/panel-source.spec.tsx`；设置页由 manifest 驱动 | 2026-11-08 |
| T1-12 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/25 | `../010-adding-a-source.md`；`tests/docs.spec.ts` | 2026-11-08 |
| T1-13 | 已完成 | — | `tests/conversation.spec.ts`；`../009-conversation-tasks.md` 的 T1-13 进度 | 2026-11-08 |
| T1-14 | 已完成 | — | `tests/dispatch.spec.ts`、`tests/dispatch-split.spec.ts` | 2026-11-08 |
| T1-15 | 已完成 | — | `tests/conversation.spec.ts`；任务线程回执 | 2026-11-08 |
| T1-16 | 已完成 | — | `tests/panel-source.spec.tsx`；`../009-conversation-tasks.md` 的会话来源区块 | 2026-11-08 |
| T1-17 | 已完成 | — | `tests/dispatch.spec.ts`；PR Channel 自动绑定 | 2026-11-08 |
| T2-01 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/5 | `tests/action.spec.ts`；五级 Action | 2026-11-08 |
| T2-02 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/7 | `tests/approval.spec.ts`；Approval 状态机 | 2026-11-08 |
| T2-03 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/8 | `tests/approval-policy.spec.ts`；`maxActionLevel` 记入 Mandate | 2026-11-08 |
| T2-04 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/12 | `tests/outbox.spec.ts`；撤销窗口与 `recalled` | 2026-11-08 |
| T2-05 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/13 | `tests/outbox.spec.ts`；发送幂等键 | 2026-11-08 |
| T2-06 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/14 | `tests/sources.spec.ts`；probe 先于重试 | 2026-11-08 |
| T2-07 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/10 | `tests/panel-approval.spec.tsx`；待批准队列 | 2026-11-08 |
| T2-08 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/16 | `tests/approval-policy.spec.ts`；白名单与工作时段自动批 | 2026-11-08 |
| T2-09 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/17 | `tests/chaos.spec.ts`；100 轮断电注入 | 2026-11-08 |
| T2-10 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/17 | `pnpm drill:withdraw`；撤退演练 | 2026-11-08 |
| T3-01 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/21 | `tests/deliverable.spec.ts`；Deliverable 与 review 门 | 2026-11-08 |
| T3-02 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/22 | `tests/preview-doc.spec.ts`；doc redline | 2026-11-08 |
| T3-03 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/23 | `tests/preview-sheet.spec.ts`；sheet 公式与值分列 | 2026-11-08 |
| T3-04 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/35 | `tests/preview-mail.spec.ts`；四段 diff 与抄送/密送显式清单 | 2026-11-09 |
| T3-05 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/36 | `tests/lightweight.spec.ts`、`tests/inline-work.spec.ts`；kernel 契约（PR #29）+ Phase 0 生产 `InlineWork`、Eval/route/dispatch 的 `form`、`executor.lightweight` 回退；真实只读小活 943 ms（复测 918/928 ms），tracked 仍为默认；待 PR #36 合并后改为已完成 | 2026-11-09 |
| T3-06 | 未开始 | — | — | 2026-11-08 |
| T3-07 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/24 | `tests/panel-approval.spec.tsx`；review 必须有 preview | 2026-11-08 |
| T3-08 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/37 | `tests/ticket-timeline.spec.ts`；`tests/panel-timeline.spec.tsx`；`GET tickets/:id/timeline` 只读合成 trace、disposition 与 approval；Before/After 截图 | 2026-11-09 |
| T3-09 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/38 | `tests/tasks-view.spec.ts`、`tests/panel-tasks.spec.tsx`、`tests/client.spec.tsx`；同场景 Before/After 见 `docs/images/tasks-view/`；359px 右栏 `scrollWidth=clientWidth`；`pnpm check` 1653 测试通过 | 2026-11-09 |
| T3-10 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/40 | Phase 2a 子 Ticket 运行时、父 owner 审阅链、结束门与 schema 15；`tests/delegation*.spec.ts`、`tests/runtime-concurrency.spec.ts`、`tests/store.spec.ts`、`tests/migration.spec.ts` 通过，typecheck/build/check:size 通过 | 2026-11-09 |
| T3-11 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/42 | `tests/review-aggregate.spec.ts`、`tests/tasks-children.spec.ts`、`tests/panel-tasks.spec.tsx`；500 根/2000 子投影 p95 ≤400ms；360px 右栏无横向滚动（359px `scrollWidth=clientWidth`）；同场景 Before/After 见 `docs/images/tasks-view/phase2b-{before,after}-tasks-360.png` 与 `phase2b-{before,after}-review.png` | 2026-11-09 |
| T3-12 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/43 | 合并 `fe9e62a`。Phase 1 空间只读投影与 E2 列表：`tests/spaces.spec.ts`、`tests/panel-spaces.spec.tsx`；E1/E2 同场景 Before/After 见 `docs/images/spaces/{before,after}-{e1-ticket,e2-execution}.png` | 2026-11-10 |
| T3-13 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/46 | 合并 #43 `fe9e62a` + #46 `54a6b28`。写租约：同 locator 第二个排队、同工单重入、prepare 失败释放、结束释放、stale/epoch 恢复；子工单接受/孤儿均释放租约，重启按深度父先子后（用例覆盖父已结束的孤儿）（`tests/spaces.spec.ts`、`tests/runtime-concurrency.spec.ts`）；跨仓只能新建兄弟子空间且无改绑入口，运行时不做仓库推断（docs/013 §3.2）；E1 无 `directory`，E2 600 行批量预热 + 15 秒缓存 p95；全量串行与 CI 通过；E1 同场景 Before/After 见 `docs/images/spaces/phase2-{before,after}-e1-directory.png` | 2026-11-10 |
| T4-01 | 未开始 | — | — | 2026-11-08 |
| T4-02 | 未开始 | — | — | 2026-11-08 |
| T4-03 | 未开始 | — | — | 2026-11-08 |
| T4-04 | 未开始 | — | — | 2026-11-08 |
| T4-05 | 未开始 | — | — | 2026-11-08 |
| T4-06 | 未开始 | — | — | 2026-11-08 |
| T5-01 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/45 | `packages/kernel/src/goal.ts`、`packages/dsh/src/app/goals.ts`、`GET goals`/`GET goals/:id`；`tests/goals.spec.ts` 覆盖空态、无交付、需决定、子 Ticket 等父 owner、最近一次 Assignment、同一投影、E0 无内部 id、删除不影响 Ticket；10 秒走查记录见 `../015-goal-projection.zh.md` 附录 | 2026-11-10 |
| T5-02 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/53 | `docs/018-exposure-levels.zh.md`：E0–E3 逐项清单、注意力成本/替代/回退；`tests/panel-overview.spec.tsx`、`tests/panel-settings.spec.tsx`、`tests/panel-tasks.spec.tsx`、`tests/client.spec.tsx` 覆盖 E0 无 Session/未送达、审批技术折叠、显示组默认关闭、E1 目标区、事件自动打开三路径；全量 1775 测试通过；同场景 Before/After 见 `docs/images/exposure-levels/{before,after}-{overview,tasks,ticket,settings}.png`；10 秒自查记录见 018 §5.1 | 2026-11-10 |
| T5-03 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/50 | `packages/dsh/src/app/context-groups.ts`；`tests/context-groups.spec.ts` 覆盖同组/异组/无组、私聊/群聊、退订后失效、无成员名单/无授权字段、T5-04 条目形状与 `GET contexts/groups`；C3.3/C3.4 走查见 `../017-context-groups.zh.md` | 2026-11-10 |
| T5-04 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/54 | `packages/dsh/src/app/context-assembly.ts`、`packages/kernel/src/context.ts`；`tests/context.spec.ts`（18 例）覆盖六维来源、缺席、约束/默认合并、同强度冲突、缺失/不可读 fail closed、子工单平铺继承、退订/离开后失效、轻量 task-only、截断与无正文快照回放；`tests/runtime.spec.ts` 新增 blocked launch 与 contentHash 去重/变更用例；`tests/runtime.spec.ts` 覆盖首条消息、Assignment 快照与 `context` trace；`docs/019-context-assembly.zh.md`；独立 review 见 PR #54，待人合并 | 2026-11-11 |
| T5-05 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/55 | `scripts/evolution/core.ts`、`export.mjs`、`run.mjs`；`tests/evolution.spec.ts` 覆盖聚合、低置信/无基线降级、隐私白名单、禁止授权字段、gate pass/reject/insufficient/no-difference、样本量、holdout 覆盖/污染、环境指纹、回放配置摘要、moving、exporter 脱敏、回滚、无写入路径与 CLI 重放；`docs/020-evolution-loop.zh.md`；独立 review 见 PR #55 | 2026-11-11 |
| T5-06 | 未开始 | — | — | 2026-11-08 |
| T5-07 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/51 | `packages/kernel/src/profile.ts`、`packages/dsh/src/app/profiles.ts`、`packages/dsh/src/app/profile-metrics.ts`、`packages/dsh/src/app/work-tools.ts`；Ticket 顶层快照与子 Ticket 复制、Session 模型/prompt/工具解析、`dispatch` span、`GET profiles`/`:id`/`:id/metrics`；`tests/profiles.spec.ts` 与 `tests/core-engine.spec.ts` 覆盖注册表、回滚、禁止字段、fallback、工具收紧、pinned 非合规、聚合与 accept 不变；无 schema 迁移、SettingsSchema 不变、`profiles.config` 默认关闭 | 2026-11-10 |
| X-01 | 未开始 | — | — | 2026-11-08 |
| X-02 | 未开始 | — | — | 2026-11-08 |
| X-03 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/44 | `tests/e2e/golden-path.e2e.ts`；`pnpm test:e2e`；CI `e2e` workflow | 2026-11-10 |
| X-04 | 未开始 | — | — | 2026-11-08 |
| X-05 | 未开始 | — | — | 2026-11-08 |
| X-06 | 未开始 | — | — | 2026-11-08 |
| X-07 | 已完成 | — | `packages/dsh` 与根 meta 切包；`PLUGIN-PACKAGING.zh.md` §3 | 2026-11-08 |
| X-08 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/20 | `pnpm test:install-e2e`；临时 `DSH_HOME` 安装/卸载 | 2026-11-08 |
| X-09 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/52 | 三区入口、侧边栏注意点与 `entry.threeZones.v1` 回退；PR #52 待评审合并 | 2026-11-10 |
| X-10 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/49 | `.github/workflows/host-matrix.yml` 显式 6 条宿主/Node/DSH 组合（含前向宿主腿）；`scripts/install-e2e.mjs` 跨平台；支持矩阵、排除项、平台限制与超时见 `../006-deployment.md`；本地 macOS 两条宿主通过，PR CI 运行中 | 2026-11-10 |
| X-11 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/19 | `tests/dump-config.spec.ts`；六行齐全 | 2026-11-08 |
| X-12 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/31 | PR #31 合并（`19b8c3d`）；`tests/docs.spec.ts` 文档结构与跟踪表校验、计划文档迁入 `docs/plan/` | 2026-11-08 |
| X-13 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/34 | `scripts/check-tracking.mjs`、`tests/tracking.spec.ts`；CI `tracking` job；`docs/plan/README.md` 的「自动校验」 | 2026-11-09 |
| S-01 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/2 | `tests/activity.spec.ts`；`activity` 表与三级分级 | 2026-11-08 |
| S-02 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/2 | `tests/activity-feed.spec.ts`；`endCoveredBy` 单一通知预算 | 2026-11-08 |
| S-03 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/2 | `tests/runtime.spec.ts` 的 `<stateDir>/system` 目录断言 | 2026-11-08 |
| S-04 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | 主会话入口与 `masterId`；`../005-panel.md` | 2026-11-08 |
| S-05 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | 状态页复用完整管理页；PR #6 修正 | 2026-11-08 |
| S-06 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | 右侧事件栏；`tests/activity-feed.spec.ts` | 2026-11-08 |
| S-07 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | SSE 游标、心跳与同源校验；`tests/activity-feed.spec.ts` | 2026-11-08 |
| S-08 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | 端到端与宿主守卫；`docs/images/session-entry/` | 2026-11-08 |
