# TRACKING — 任务状态、PR 与验收证据

> 唯一状态源。格式与「合并即更新」约定见 [README.md](README.md)。
> 初始建表 2026-11-08：历史任务按当日仓库、PR 与计划文档中能复核的证据回填；没有完成证据的任务记为 `未开始`，发现不符时先修表。`最后更新` 是这一行最后一次改动日期。
> 2026-11-08 重评估：新增 T3-09…11、T5-01…06、X-13（均未开始）；X-12 随 PR #31 合并改为已完成；T3-05 的验收口径改为 Phase 0 剩余项。
> 2026-11-09 设计修订：T3-10/T3-11 从独立 `Subtask` 类型改为 `Ticket` 自引用（子 Ticket + 父 owner 审查链 + 根授权唯一），范围见 TASK-PLAN；实现见 PR #40。
> 2026-11-11 文档：新增 X-14 上游扩展点提案（`../022-harness-extension-requests.zh.md`），PR #61 跟踪回填。
> 2026-11-11 状态回填：逐行核对 PR merge 状态后，17 行由 `进行中` 改为 `已完成` 并补合并提交（含 rebase 后新合并的 X-02 #64、T5-08 #63）；T5-06 的 PR #56/#59 已合并，但 C4.2/C4.3/C4.5 等验收缺口仍在，保留 `进行中` 并写明卡点。
> 2026-11-13 状态回填：用 `gh pr view` 核对 #69/#70/#72/#73/#75 的 `state`/`mergedAt`/`mergeCommit`；T5-07、T5-09、X-01、X-04 改为 `已完成` 并补合并提交。T5-05 的 Phase 2 #73 已合并，但 Phase 3 生效路径仍未实现；T5-06 的 C4.2/C4.3/C4.5 与 D5 客户度量仍有缺口，这两行保留 `进行中`。

## 任务跟踪表

| 任务 | 状态 | PR | 验收证据 | 最后更新 |
| --- | --- | --- | --- | --- |
| T0-01 | 已完成 | — | `fcbae91`；schema 11→12，62 文件 / 1212 测试 | 2026-11-08 |
| T0-02 | 已完成 | — | `7f11e0d`、`ab8f6c5`；一条 trigger 的 trace 十段齐全 | 2026-11-08 |
| T0-03 | 已完成 | — | `1377989`；`tests/metrics.spec.ts` 四指标 | 2026-11-08 |
| T0-04 | 已完成 | — | `1377989`；Overview「运行健康」与中断/恢复提示 | 2026-11-08 |
| T0-05 | 已完成 | — | `894c1a5`；changesets 与包体积门；2026-11-11 按模块核对 #63/#65 的增量后重定体积基线（`index.js` 814000、总计 1668000），`pnpm check:size` 通过 | 2026-11-11 |
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
| T3-04 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/35 | PR #35 合并 `94c55be`；`tests/preview-mail.spec.ts`；四段 diff 与抄送/密送显式清单 | 2026-11-11 |
| T3-05 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/36 | PR #36 合并 `543c017`；`tests/lightweight.spec.ts`、`tests/inline-work.spec.ts`；kernel 契约（PR #29）+ Phase 0 生产 `InlineWork`、Eval/route/dispatch 的 `form`、`executor.lightweight` 回退；真实只读小活 943 ms（复测 918/928 ms），tracked 仍为默认 | 2026-11-11 |
| T3-06 | 未开始 | — | — | 2026-11-08 |
| T3-07 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/24 | `tests/panel-approval.spec.tsx`；review 必须有 preview | 2026-11-08 |
| T3-08 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/37 | PR #37 合并 `a573ee4`；`tests/ticket-timeline.spec.ts`；`tests/panel-timeline.spec.tsx`；`GET tickets/:id/timeline` 只读合成 trace、disposition 与 approval；Before/After 截图 | 2026-11-11 |
| T3-09 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/38 | `tests/tasks-view.spec.ts`、`tests/panel-tasks.spec.tsx`、`tests/client.spec.tsx`；同场景 Before/After 见 `docs/images/tasks-view/`；359px 右栏 `scrollWidth=clientWidth`；`pnpm check` 1653 测试通过 | 2026-11-09 |
| T3-10 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/40 | Phase 2a 子 Ticket 运行时、父 owner 审阅链、结束门与 schema 15；`tests/delegation*.spec.ts`、`tests/runtime-concurrency.spec.ts`、`tests/store.spec.ts`、`tests/migration.spec.ts` 通过，typecheck/build/check:size 通过；2026-11-11 文档核对：子 `approve`/`retry`/`stop` 返回 `childRequiresParent`（不是 `notAuthorizationRoot`），`accept_child` 遇 live 后代返回 `childStillOpen`，`docs/tasks-view-architecture` §6.6/§9.2、`docs/003`、`docs/006`、`docs/011` 已对齐，见 PR #59 | 2026-11-11 |
| T3-11 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/42 | `tests/review-aggregate.spec.ts`、`tests/tasks-children.spec.ts`、`tests/panel-tasks.spec.tsx`；500 根/2000 子投影 p95 ≤400ms；360px 右栏无横向滚动（359px `scrollWidth=clientWidth`）；同场景 Before/After 见 `docs/images/tasks-view/phase2b-{before,after}-tasks-360.png` 与 `phase2b-{before,after}-review.png` | 2026-11-09 |
| T3-12 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/43 | 合并 `fe9e62a`。Phase 1 空间只读投影与 E2 列表：`tests/spaces.spec.ts`、`tests/panel-spaces.spec.tsx`；E1/E2 同场景 Before/After 见 `docs/images/spaces/{before,after}-{e1-ticket,e2-execution}.png` | 2026-11-10 |
| T3-13 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/46 | 合并 #43 `fe9e62a` + #46 `54a6b28`。写租约：同 locator 第二个排队、同工单重入、prepare 失败释放、结束释放、stale/epoch 恢复；子工单接受/孤儿均释放租约，重启按深度父先子后（用例覆盖父已结束的孤儿）（`tests/spaces.spec.ts`、`tests/runtime-concurrency.spec.ts`）；跨仓只能新建兄弟子空间且无改绑入口，运行时不做仓库推断（docs/013 §3.2）；E1 无 `directory`，E2 600 行批量预热 + 15 秒缓存 p95；全量串行与 CI 通过；E1 同场景 Before/After 见 `docs/images/spaces/phase2-{before,after}-e1-directory.png` | 2026-11-10 |
| T4-01 | 未开始 | — | — | 2026-11-08 |
| T4-02 | 未开始 | — | — | 2026-11-08 |
| T4-03 | 未开始 | — | — | 2026-11-08 |
| T4-04 | 未开始 | — | — | 2026-11-08 |
| T4-05 | 未开始 | — | — | 2026-11-08 |
| T4-06 | 未开始 | — | — | 2026-11-08 |
| T5-01 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/45 | PR #45 合并 `4d3ac1c`；`packages/kernel/src/goal.ts`、`packages/dsh/src/app/goals.ts`、`GET goals`/`GET goals/:id`；`tests/goals.spec.ts` 覆盖空态、无交付、需决定、子 Ticket 等父 owner、最近一次 Assignment、同一投影、E0 无内部 id、删除不影响 Ticket；10 秒走查记录见 `../015-goal-projection.zh.md` 附录 | 2026-11-11 |
| T5-02 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/53 | PR #53 合并 `73709a4`；`docs/018-exposure-levels.zh.md`：E0–E3 逐项清单、注意力成本/替代/回退；`tests/panel-overview.spec.tsx`、`tests/panel-settings.spec.tsx`、`tests/panel-tasks.spec.tsx`、`tests/client.spec.tsx` 覆盖 E0 无 Session/未送达、审批技术折叠、显示组默认关闭、E1 目标区、事件自动打开三路径；全量 1775 测试通过；同场景 Before/After 见 `docs/images/exposure-levels/{before,after}-{overview,tasks,ticket,settings}.png`；10 秒自查记录见 018 §5.1；设计输入：界面重构修订提案（主 Agent 入口、任务视图/任务层级、通知浮层/抽屉、运维进设置，未实现）见 `../021-ux-redesign.zh.md` | 2026-11-11 |
| T5-03 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/50 | PR #50 合并 `3230e14`；`packages/dsh/src/app/context-groups.ts`；`tests/context-groups.spec.ts` 覆盖同组/异组/无组、私聊/群聊、退订后失效、无成员名单/无授权字段、T5-04 条目形状与 `GET contexts/groups`；C3.3/C3.4 走查见 `../017-context-groups.zh.md` | 2026-11-11 |
| T5-04 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/54 | PR #54 合并 `97bdb80`；`packages/dsh/src/app/context-assembly.ts`、`packages/kernel/src/context.ts`；`tests/context.spec.ts`（18 例）覆盖六维来源、缺席、约束/默认合并、同强度冲突、缺失/不可读 fail closed、子工单平铺继承、退订/离开后失效、轻量 task-only、截断与无正文快照回放；`tests/runtime.spec.ts` 新增 blocked launch 与 contentHash 去重/变更用例；`tests/runtime.spec.ts` 覆盖首条消息、Assignment 快照与 `context` trace；`docs/019-context-assembly.zh.md`；独立 review 见 PR #54 | 2026-11-11 |
| T5-05 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/73 | Phase 1 PR #55 合并 `0af96a0`、Phase 2 PR #73 合并 `1a36f96`；`scripts/evolution/core.ts` 的 `gate()`/`valueGate()` 把结论归为 `improvement`/`no-difference`/`guardrail-regression`/`insufficient-evidence` 四结局，只有未舍入主指标 ≥ MDE、区间下界 >0、p<α 且无可用护栏回退才 `recommendation=adopt`，缺失指标保持 `unknown`、货币成本不作门、`applied=false`；`tests/evolution.spec.ts` 覆盖四结局、未知成本、护栏回退、证据不足、未舍入 MDE 与小样本拒绝，`pnpm check` 通过。卡点：Phase 3 生效路径——从 `approval-queue.json` 到保存/激活 profile revision 并核对 `effective.hash` 仍只有 020 §3 的人工步骤，没有脚本化衔接与针对该路径的测试；接运行时须另走设计评审（020 §6），故保留进行中 | 2026-11-13 |
| T5-06 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/59 | PR #56 合并 `f7846fc`、PR #59 合并 `cec3c42`、PR #74 合并 `7cac21d`；`pnpm drill:replacement` 与 `tests/replacement-drill.spec.ts`、`tests/replacement-metrics.spec.ts` 覆盖基线/回放/扁平/失败/回滚，回放逐字节一致、扁平结果与通知数等价、视图只读、失败可审计、回滚恢复；C4.5 走查见 `docs/runbooks/novice-walkthrough.md` 与 `tests/novice-walkthrough.spec.tsx`，G1–G6 文案/入口由 #74 修复并由 `tests/panel-walkthrough-gaps.spec.tsx` 守住。卡点：C4.2 部分满足（D2 扁平后审计完整但非逐字节一致）、C4.3 部分满足（本检出没有类别覆盖层，删层无法实测）、C4.5 部分满足（D7 仍是 agent 走查，待独立新人复跑）、D5 客户度量（自动打开关闭率与默认面点击深度）未采集且 `GET metrics` 报 `not-collected`；补齐前保留进行中 | 2026-11-13 |
| T5-08 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/63 | PR #63 合并 `40e3393`；`packages/dsh/src/client/notifications.ts`、`notification-center.tsx`、`task-detail.tsx`、`overview.tsx`、`tasks.tsx`、`settings.tsx`、`features.ts`；`TaskView` 只读 owner/Profile/blocker/childSummary；来源健康 `pollFailure` 增加可选 `at`；`tests/panel-notifications.spec.tsx`、`tests/panel-task-hierarchy.spec.tsx`、`tests/panel-overview.spec.tsx`、`tests/panel-source.spec.tsx`、`tests/panel-panel.spec.tsx`、`tests/tasks-children.spec.ts` 覆盖通知分组/原地批准/停用来源/浮层上限与开关独立、任务层级逐层与 E2 折叠、错误聚合计数/重试/恢复/逐条回退、四个显示开关和术语；`docs/023-ux-first-batch.zh.md`（含 §5.2 十秒自查）；同场景 Before/After 与独立 review 结论见 PR #63 | 2026-11-11 |
| T5-09 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/70 | PR #70 合并 `e7bc281`；默认三入口与设置四系统页（分组/图标/说明、直接链接、带 id 详情不选标签、七入口回退）；任务详情 v2 的决定/结果/预计/人话负责人/子任务展开与 v1 回退；首次说明、空态示例与恢复；`tests/panel-ux-second-batch.spec.tsx` 覆盖默认与三项回退；同场景 Before/After 见 `docs/images/ux-second-batch/`（before `main@08a33ad`） | 2026-11-13 |
| T5-10 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/78 | 四项默认入口与默认任务页；主 Agent 卡（名字/4 预设或本地 96×96 重编码头像、状态、进入现有主会话、浏览器本地持久化）与独立回退；浮层通知计数/最近摘要/静默/键盘/抽屉/Esc 焦点返回与铃铛回退；文件页只读投影任务 deliverables、`http(s)` 直开、其他回任务与入口回退；四项模式下不注册右栏重复标签；任务页卡片与页头主会话入口只保留一个，宿主会话行/设置/文件侧栏造成的重复在 §4.3 如实标注；PR #81 修复状态页里的「打开会话」在目标就是当前 Session 时切回对话并记住该 View（`tests/view-actions.spec.ts`、`tests/client.spec.tsx`、`tests/panel-execution.spec.tsx`，Before/After 见 `docs/images/open-conversation/`）；`tests/panel-ux-third-batch.spec.tsx` 覆盖以上路径；`docs/026-ux-third-batch.zh.md` §5 按 L1–L8 列宿主限制并对应 022 请求编号；同场景 Before/After 见 `docs/images/ux-third-batch/`（before `source/main@7cac21d`）；独立 review 结论见 PR #78 review 评论 | 2026-11-13 |
| T5-07 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/75 | Phase 1 PR #51 合并 `567ac43`，Phase 1.5 PR #75 合并 `afdf423`；`packages/kernel/src/profile.ts` 的快照/解析与 `profiles.ts` 的 create/revise/activate/enabled/retire/rollback、head 审计、模型批准校验；`http.ts` 7 条 loopback 写路由；`client/profiles.tsx` 的 Settings › Agent 配置；`tests/profiles.spec.ts`、`tests/http.spec.ts`、`tests/panel-profiles.spec.tsx` 覆盖写路由、禁止字段、模型升级拒绝、内置只读、回退/停用与存量快照不变；无 schema 迁移、SettingsSchema 不变、`profiles.config` 默认关闭 | 2026-11-13 |
| X-01 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/69 | PR #69 合并 `08a33ad`；`eslint.config.mjs`（ESLint 10 + `typescript-eslint` 8，project service 类型感知）覆盖 `packages/kernel`、`packages/dsh`、`meta`、`scripts`、`tests`；`pnpm lint` 接入 `pnpm check` 与 CI；清除 131 条 finding，保留 7 处逐条理由的窄豁免；`pnpm lint` 0/0、全量 1872 测试通过 | 2026-11-13 |
| X-02 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/64 | PR #64 合并 `eee90a2`；`.dependency-cruiser.mjs`；`tests/dependency-rules.spec.ts` 的 clean/violations fixtures；`pnpm check:arch` 接入 `pnpm check` 与 CI；旧扫描器过渡一个版本；独立 review 见 PR #64 review 评论 | 2026-11-11 |
| X-03 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/44 | PR #44 合并 `1b91fd8`；`tests/e2e/golden-path.e2e.ts`；`pnpm test:e2e`；CI `e2e` workflow | 2026-11-11 |
| X-04 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/72 | PR #72 合并 `0d24be7`；42 条路由由 `api-contract.ts` 的 `ROUTES` 单一派生（类型、运行期校验、handler 表与面板 response）；`api.schema.json` 生成物由 `pnpm check:api` 防过期；`tests/api-contract.spec.ts` 覆盖契约↔handler、非法请求与生成物一致性；`pnpm check` 通过（1889 测试） | 2026-11-13 |
| X-05 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/62 | PR #62 合并 `ab0fd0a`；`tests/docs.spec.ts` 新增 `SourceManifest` 字段与 `PUBLIC_ROUTES`/Management API 表的一致性检查，缺失项会指名字段或路由与应改文件；`pnpm typecheck`、`tests/docs.spec.ts`、全量 `pnpm test`（本机 `GIT_CONFIG_GLOBAL` 环境下的 2 个既有失败去除该变量后通过）、`pnpm build`、`pnpm check:size` 通过；独立 review 见 PR #62 review 评论 | 2026-11-11 |
| X-06 | 进行中 | https://github.com/touch-agent/dsh-superagent/pull/77 | `scripts/check-domain-budget.mjs`、`pnpm check:domain` 接入 `pnpm check`；15 文件 / 313 用例；三次样本 555/470/504ms、中位数 504ms，CI 五次中位数 593–962ms（2s 上限，最慢约 2.1 倍余量）；单个用例 500ms 早期上限，临时 +1.2s 探针被按文件与用例名拦截；口径与偏差见 `docs/007-architecture.md` | 2026-11-13 |
| X-07 | 已完成 | — | `packages/dsh` 与根 meta 切包；`PLUGIN-PACKAGING.zh.md` §3 | 2026-11-08 |
| X-08 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/20 | `pnpm test:install-e2e`；临时 `DSH_HOME` 安装/卸载 | 2026-11-08 |
| X-09 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/52 | PR #52 合并 `7bfebfd`；三区入口、侧边栏注意点与 `entry.threeZones.v1` 回退 | 2026-11-11 |
| X-10 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/49 | PR #49 合并 `9a278bd`；`.github/workflows/host-matrix.yml` 显式 6 条宿主/Node/DSH 组合（含前向宿主腿）；`scripts/install-e2e.mjs` 跨平台；支持矩阵、排除项、平台限制与超时见 `../006-deployment.md`；本地 macOS 两条宿主通过，CI 6 条宿主/Node/DSH 组合通过 | 2026-11-11 |
| X-11 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/19 | `tests/dump-config.spec.ts`；六行齐全 | 2026-11-08 |
| X-12 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/31 | PR #31 合并（`19b8c3d`）；`tests/docs.spec.ts` 文档结构与跟踪表校验、计划文档迁入 `docs/plan/` | 2026-11-08 |
| X-13 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/34 | PR #34 合并 `0c43312`；`scripts/check-tracking.mjs`、`tests/tracking.spec.ts`；CI `tracking` job；`docs/plan/README.md` 的「自动校验」 | 2026-11-11 |
| X-14 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/61 | PR #61 合并 `39b8a08`；`../022-harness-extension-requests.zh.md`；DSH `0.2.1-rc.5` 类型/实现证据；`tests/docs.spec.ts` 文档索引 | 2026-11-11 |
| S-01 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/2 | `tests/activity.spec.ts`；`activity` 表与三级分级 | 2026-11-08 |
| S-02 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/2 | `tests/activity-feed.spec.ts`；`endCoveredBy` 单一通知预算 | 2026-11-08 |
| S-03 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/2 | `tests/runtime.spec.ts` 的 `<stateDir>/system` 目录断言 | 2026-11-08 |
| S-04 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | 主会话入口与 `masterId`；`../005-panel.md` | 2026-11-08 |
| S-05 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | 状态页复用完整管理页；PR #6 修正 | 2026-11-08 |
| S-06 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | 右侧事件栏；`tests/activity-feed.spec.ts` | 2026-11-08 |
| S-07 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | SSE 游标、心跳与同源校验；`tests/activity-feed.spec.ts` | 2026-11-08 |
| S-08 | 已完成 | https://github.com/touch-agent/dsh-superagent/pull/4 | 端到端与宿主守卫；`docs/images/session-entry/` | 2026-11-08 |
