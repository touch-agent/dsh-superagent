# 工作区盘点与清理手册（2026-11-13 快照）

> **状态：只读盘点。** 本文件只记录事实、清单与安全删除方法；本次没有删除或移动任何目录。
> 范围：本机 superagent 部署（stateDir `~/.dsh/state/superagent`）的工单执行目录与 Git worktree。
> 复核时间：2026-11-13 17:11–17:35（Asia/Shanghai）。当时磁盘已用 99%，仅余 18 GiB。

## 0. 结论

| 结论 | 数量 | 占用 |
| --- | --- | --- |
| **可删**：工单已结束、PR 已合并或检出停在 workcenter main、树干净、无可丢提交 | **78** | **6.09 GiB** |
| **保留**：工单进行中 / PR 仍 open / 未合并，以及不能按目录直接删的基线克隆 | **13** | 1.28 GiB |
| **有风险**：有未提交改动、未推送提交或归属不明 | **14** | 0.88 GiB |
| 合计 | 105 | 8.24 GiB |

- 另有 **18 个「工作区」面板条目指向已不存在的目录**（不是磁盘目录，见附录 A）；它们让侧栏看起来比实际更糟。
- 建议先执行 §6 的 `APPLY=0` 校验（78/78 已通过），再逐项真正删除；**只删 worktree，保留 `agent/*` 分支**。
- 删除目录不会自动删除面板条目；两者要成对清理，否则侧栏会多出新的死条目（见 §7 R4）。

## 1. 工作区在哪里、目录是怎么来的

### 1.1 三个根与基线仓库

| 缩写 | 实际路径 | 内容 | 当前角色 |
| --- | --- | --- | --- |
| **S** | `/Users/steven/.dsh/state/superagent/system/work` | 66 个工单 worktree | 当前执行根（`executor.directory` 为空时的默认值） |
| **W** | `/Users/steven/.dsh/state/superagent/work` | 19 个旧工单 worktree | 早期执行根，仍被旧克隆使用 |
| **R** | `/Users/steven/src` | 17 个 `dsh-superagent-*`（6 个旧基线克隆 + 11 个工单 worktree）+ `workcenter` | 早期“每工单一克隆”的遗留 |
| **T** | `/private/tmp` | 2 个基线 worktree（`profile-before`、`ux-batch1-before`） | 截图/对比用临时检出 |

`workcenter` 本身（`/Users/steven/src/workcenter`，31M）是当前所有 S worktree 的公共 Git 仓库：`origin` 指向 `touch-agent/workcenter`，`source` 指向 `touch-agent/dsh-superagent`。**它不是工单目录，不能删**；删了会把 66 个 worktree 的注册信息和对象库一起破坏。

8 个旧基线克隆（`/Users/steven/src/dsh-superagent-*`、`W/dsh-superagent-tickets-phase-a-*`、`W/dsh-superagent-warm-session-*`）合计约 1.0 GiB。它们各自还挂着 worktree（有的直接嵌在 S 的目录里面），不能按普通目录直接删，详见 §4.2。

### 1.2 当前工单目录的生成规则

当前部署的设置（settings 第 15 版）把执行根留在默认值，prepare 命令是：

```sh
git -C /Users/steven/src/workcenter fetch --no-tags \
  "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" \
  "${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" \
  && git -C /Users/steven/src/workcenter worktree add \
  -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" \
  "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"
```

也就是说：

1. 从被观察仓库取工单的 PR head（或默认分支 head）到 `refs/dsh-superagent/<ticket>`；
2. 在 `workcenter` 里新建分支 `agent/<ticket-name>`，worktree 落到 `$DSH_SUPERAGENT_DIR`，也就是 S 下的同名目录；
3. **结束时不删 worktree、不删分支**——这是目录累积的直接原因（docs/013 的 Phase 3 回收尚未实现）。

### 1.3 三代目录与“0M 空检出”

| 代 | 大致时间 | 根 | 基线仓库 | 说明 |
| --- | --- | --- | --- | --- |
| W 代 | 11-08 至 11-09 | W | `/Users/steven/projects/open-git/dsh-superagent` | 早期 worktree，内容完整 |
| R 代 | 11-08 至 11-11 | R | 多个 `/Users/steven/src/dsh-superagent-*` 克隆 | 克隆里再挂 worktree，结构最深 |
| S 代 | 11-08 至今 | S | `/Users/steven/src/workcenter` | 当前做法，worktree 数最多 |

S 下有 **44 个工单目录的 HEAD 停在 workcenter 的 `main`（520fabf）**，没有工单提交。除 3 个内嵌 worktree 的父目录（§5.1）外，其余 41 个的自身检出只有 0—7M（多数为 0M）。它们是 Source 还指向 `touch-agent/workcenter` 时 prepare 的产物：fetch 到的是 workcenter 的 main，不是 dsh-superagent 的代码；真实工单工作在 W/R 代目录或远端分支里。因此这些目录**不含可丢的工单代码**，但其中几个留有未跟踪的 PR 笔记，见 §5.3。

## 2. 总览

### 2.1 分类汇总

| 类别 | 目录数 | 占用 | 说明 |
| --- | --- | --- | --- |
| 可删 | 78 | 6.09 GiB | 已核验干净、已合并/已结束 |
| 保留 | 13 | 1.28 GiB | 4 个进行中/未合并 + 9 个基线克隆 |
| 有风险 | 14 | 0.88 GiB | 未提交、未推送或归属不明 |
| 合计 | 105 | 8.24 GiB | |

### 2.2 按根分布

| 根 | 目录数 | 占用 | 可删 | 保留 | 有风险 | 基线克隆 |
| --- | --- | --- | --- | --- | --- | --- |
| S `system/work` | 66 | 3.30 GiB | 53 | 4 | 9 | 0 |
| W `superagent/work` | 19 | 2.48 GiB | 17 | 0 | 0 | 2 |
| R `src` | 18 | 2.30 GiB | 8 | 0 | 3 | 7 |
| T `/private/tmp` | 2 | 0.17 GiB | 0 | 0 | 2 | 0 |

### 2.3 最大的十个目录

| 大小 | 目录 | 类别 | 说明 |
| --- | --- | --- | --- |
| 667M | `W/dsh-superagent-dump-config-x-49bfca376b55` | 可删 | 含 641M `node_modules` |
| 197M | `S/ui-0414d2f9f297` | 可删 | PR #70 |
| 183M | `S/a-agent-aed9602e1262` | 可删 | PR #78 |
| 183M | `S/domain-test-budget-dea1c866287b` | 可删 | PR #77 |
| 183M | `S/walkthrough-gaps-dc173a1ad619` | 可删 | PR #74 |
| 182M | `S/profile-admin-a10ccf1a6d24` | 可删 | PR #75 |
| 181M | `S/git-integration-research-2ed9a679f032` | 保留 | PR #71 关闭未合并 |
| 181M | `S/evolution-value-gate-72d79538e43e` | 可删 | PR #73 |
| 181M | `S/api-schema-b2d60135667b` | 可删 | PR #72 |
| 180M | `S/x-lint-ci-1ce4d84db770` | 可删 | PR #69 |

### 2.4 口径

- **大小**：`du -sk`（含 `node_modules`、`.artifacts` 等未跟踪产物）；只算该目录，不含共享的 `.git` 对象库。
- **最后活动**：目录的 mtime（目录项最后一次增删），不是最后一次提交时间。0M 空检出的 mtime 是创建/最后一次改动时间。
- **PR 状态**：2026-11-13 从 GitHub `touch-agent/dsh-superagent`（78 个 PR）和 `touch-agent/workcenter`（6 个 PR）读取的 `state/mergedAt`。
- **已合入 main**：本地 HEAD 是 dsh-superagent 远端 main `f2aef7f` 的祖先，或是 workcenter main `520fabf` 的祖先（表格记“是（WC）”，表示该目录停在 workcenter main、没有工单内容）。PR 用 squash 合并时看不出祖先关系，按 PR 的 `merged` 状态认定，表格记“是（squash）”。
- **未推送**：本地有、远端对应 `agent/*` 分支没有的提交数；`0` 表示没有未推送提交。对已合并但远端分支已删的，按 PR merged 且 HEAD 已入 main 视为 0。

## 3. 可删清单（78 个，6.09 GiB）

> 全部满足：工单已结束；PR 已合并，或没有 PR 但检出停在 workcenter main（`workspace-8b0236b7d49f`，无工单内容）；`git status` 干净（无已跟踪改动、无未跟踪文件）；无未推送提交；不是基线克隆；不包含嵌套 worktree。
> §6 的 `APPLY=0` 校验对这 78 个路径逐个跑过，结果 78/78 通过。

### 3.1 大目录（≥10M，40 个，6.06 GiB）

> §3 两张表的分支列都是本地分支 `agent/<工单名>`；`git worktree remove` 不会删除它。

| ☐ | 目录 | 工单（状态） | PR | 分支 | 已合入 main | git | 未推送 | 最后活动 | 大小 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ☐ | `W/dsh-superagent-dump-config-x-49bfca376b55` | `dump-config-x-49bfca376b55`（已完成） | #19 已合并 | `agent/dump-config-x-49bfca376b55` | 是 | 干净 | 0 | 11-08 18:29 | 667M |
| ☐ | `S/ui-0414d2f9f297` | `ui-0414d2f9f297`（已合并） | #70 已合并 | `agent/ui-0414d2f9f297` | 是 | 干净 | 0 | 11-12 13:50 | 197M |
| ☐ | `S/a-agent-aed9602e1262` | `a-agent-aed9602e1262`（已合并） | #78 已合并 | `agent/a-agent-aed9602e1262` | 是 | 干净 | 0 | 11-13 14:38 | 183M |
| ☐ | `S/domain-test-budget-dea1c866287b` | `domain-test-budget-dea1c866287b`（已合并） | #77 已合并 | `agent/domain-test-budget-dea1c866287b` | 是 | 干净 | 0 | 11-13 13:29 | 183M |
| ☐ | `S/walkthrough-gaps-dc173a1ad619` | `walkthrough-gaps-dc173a1ad619`（已合并） | #74 已合并 | `agent/walkthrough-gaps-dc173a1ad619` | 是 | 干净 | 0 | 11-13 10:25 | 183M |
| ☐ | `S/profile-admin-a10ccf1a6d24` | `profile-admin-a10ccf1a6d24`（已合并） | #75 已合并 | `agent/profile-admin-a10ccf1a6d24` | 是 | 干净 | 0 | 11-12 22:39 | 182M |
| ☐ | `S/evolution-value-gate-72d79538e43e` | `evolution-value-gate-72d79538e43e`（已合并） | #73 已合并 | `agent/evolution-value-gate-72d79538e43e` | 是 | 干净 | 0 | 11-12 22:28 | 181M |
| ☐ | `S/api-schema-b2d60135667b` | `api-schema-b2d60135667b`（已合并） | #72 已合并 | `agent/api-schema-b2d60135667b` | 是 | 干净 | 0 | 11-12 21:32 | 181M |
| ☐ | `S/x-lint-ci-1ce4d84db770` | `x-lint-ci-1ce4d84db770`（已合并） | #69 已合并 | `agent/x-lint-ci-1ce4d84db770` | 是 | 干净 | 0 | 11-12 09:22 | 180M |
| ☐ | `W/dsh-superagent-install-e2e-x-17c24e2e8720` | `install-e2e-x-17c24e2e8720`（已完成） | #20 已合并 | `agent/install-e2e-x-17c24e2e8720` | 是 | 干净 | 0 | 11-08 18:43 | 160M |
| ☐ | `S/panel-10d7c1067e5b` | `panel-10d7c1067e5b`（已合并） | #68 已合并 | `agent/panel-10d7c1067e5b` | 是 | 干净 | 0 | 11-11 22:43 | 157M |
| ☐ | `S/build-kb-1b1c01a598bd` | `build-kb-1b1c01a598bd`（已合并） | #67 已合并 | `agent/build-kb-1b1c01a598bd` | 是 | 干净 | 0 | 11-11 22:26 | 157M |
| ☐ | `S/tracking-backfill-b887cd1feee6` | `tracking-backfill-b887cd1feee6`（已合并） | #66 已合并 | `agent/tracking-backfill-b887cd1feee6` | 是 | 干净 | 0 | 11-11 21:56 | 156M |
| ☐ | `S/depcruise-rules-386156cbcee4` | `depcruise-rules-386156cbcee4`（已合并） | #64 已合并 | `agent/depcruise-rules-386156cbcee4` | 是 | 干净 | 0 | 11-11 21:07 | 156M |
| ☐ | `S/ui-6103e3b8b26f` | `ui-6103e3b8b26f`（已合并） | #63 已合并 | `agent/ui-6103e3b8b26f` | 是 | 干净 | 0 | 11-11 21:06 | 150M |
| ☐ | `S/docs-code-check-870e5b4cb449` | `docs-code-check-870e5b4cb449`（已合并） | #62 已合并 | `agent/docs-code-check-870e5b4cb449` | 是 | 干净 | 0 | 11-11 20:55 | 148M |
| ☐ | `S/docs-f8467d048ac6` | `docs-f8467d048ac6`（已合并） | #61 已合并 | `agent/docs-f8467d048ac6` | 是 | 干净 | 0 | 11-11 20:31 | 146M |
| ☐ | `S/docs-4278b3bed607` | `docs-4278b3bed607`（已合并） | #58 已合并 | `agent/docs-4278b3bed607` | 是 | 干净 | 0 | 11-11 17:52 | 146M |
| ☐ | `W/dsh-superagent-docs-c4-98f7fc9c3bd4` | `docs-c4-98f7fc9c3bd4`（已合并） | #59 已合并 | `agent/docs-c4-98f7fc9c3bd4` | 是 | 干净 | 0 | 11-11 17:56 | 143M |
| ☐ | `R/dsh-superagent-replacement-t5` | `replacement-t5-13f2c82bb682`（已完成） | #56 已合并 | `agent/replacement-t5-13f2c82bb682` | 是 | 干净 | 0 | 11-11 17:14 | 143M |
| ☐ | `R/dsh-superagent-sources-github-d986f4ccbd36` | `sources-github-d986f4ccbd36`（已完成） | #57 已合并 | `agent/sources-github-d986f4ccbd36` | 是 | 干净 | 0 | 11-11 17:25 | 143M |
| ☐ | `R/dsh-superagent-context-t5` | `context-t5-512c2187ae61`（已完成） | #54 已合并 | `agent/context-t5-512c2187ae61` | 是 | 干净 | 0 | 11-11 10:55 | 143M |
| ☐ | `R/dsh-superagent-agent-profile-phase1` | `agent-profile-phase1-b168f6150aaa`（已完成） | #51 已合并 | `agent/agent-profile-phase1-b168f6150aaa` | 是 | 干净 | 0 | 11-10 20:30 | 141M |
| ☐ | `R/dsh-superagent-group-derivation` | `group-derivation-84888ce75866`（已完成） | #50 已合并 | `agent/group-derivation-84888ce75866` | 是（squash） | 干净 | 0 | 11-10 18:50 | 141M |
| ☐ | `R/dsh-superagent-host-matrix` | `host-matrix-64d9e1d5d790`（已完成） | #49 已合并 | `agent/host-matrix-64d9e1d5d790` | 是（squash） | 干净 | 0 | 11-10 19:50 | 141M |
| ☐ | `R/dsh-superagent-spaces-t3-8a6e2595a397` | `spaces-t3-8a6e2595a397`（已完成） | #43 已合并 | `agent/spaces-t3-8a6e2595a397` | 是 | 干净 | 0 | 11-10 12:03 | 141M |
| ☐ | `W/dsh-superagent-workspace-84b6e789923d` | `workspace-84b6e789923d`（已完成） | #41 已合并 | `agent/workspace-84b6e789923d` | 是 | 干净 | 0 | 11-10 09:57 | 140M |
| ☐ | `W/dsh-superagent-lightweight-t3-phase-1e0a7afe10dd` | `lightweight-t3-phase-1e0a7afe10dd`（已完成） | #36 已合并 | `agent/lightweight-t3-phase-1e0a7afe10dd` | 是 | 干净 | 0 | 11-09 12:06 | 137M |
| ☐ | `R/dsh-superagent-x13-aeb4ad04ad4c` | `tracking-x-aeb4ad04ad4c`（已完成） | #34 已合并 | `agent/tracking-x-aeb4ad04ad4c` | 是 | 干净 | 0 | 11-09 00:19 | 137M |
| ☐ | `W/dsh-superagent-lightweight-t3-69f670b1014a` | `lightweight-t3-69f670b1014a`（已完成） | #29 已合并 | `agent/lightweight-t3-69f670b1014a` | 是 | 干净 | 0 | 11-08 21:03 | 137M |
| ☐ | `W/dsh-superagent-source-guide-4c15e7dd85ff` | `source-guide-4c15e7dd85ff`（已完成） | #25 已合并 | `agent/source-guide-4c15e7dd85ff` | 是 | 干净 | 0 | 11-08 20:46 | 137M |
| ☐ | `W/dsh-superagent-readme-d04c47d813c4` | `readme-d04c47d813c4`（已完成） | #28 已合并 | `agent/readme-d04c47d813c4` | 是 | 干净 | 0 | 11-08 20:26 | 137M |
| ☐ | `W/dsh-superagent-sheet-previewer-t3-86aab0aa05e1` | `sheet-previewer-t3-86aab0aa05e1`（已完成） | #23 已合并 | `agent/sheet-previewer-t3-86aab0aa05e1` | 是 | 干净 | 0 | 11-08 19:49 | 136M |
| ☐ | `W/dsh-superagent-doc-previewer-redline-t3-1cb26c18f524` | `doc-previewer-redline-t3-1cb26c18f524`（已完成） | #22 已合并 | `agent/doc-previewer-redline-t3-1cb26c18f524` | 是 | 干净 | 0 | 11-08 19:37 | 136M |
| ☐ | `W/dsh-superagent-deliverable-t3-2e0c899cc86e` | `deliverable-t3-2e0c899cc86e`（已完成） | #21 已合并 | `agent/deliverable-t3-2e0c899cc86e` | 是 | 干净 | 0 | 11-08 18:59 | 136M |
| ☐ | `W/dsh-superagent-src-0ede8ca6b133` | `approval-0ede8ca6b133`（已完成） | #18 已合并 | `agent/approval-0ede8ca6b133` | 是 | 干净 | 0 | 11-08 18:13 | 136M |
| ☐ | `W/dsh-superagent-src-9a4fab740ade` | `approval-t2-9a4fab740ade`（已完成） | #16 已合并 | `agent/approval-t2-9a4fab740ade` | 是 | 干净 | 0 | 11-08 17:33 | 136M |
| ☐ | `S/tracking-backfill-fb563c12afb5` | `tracking-backfill-fb563c12afb5`（已合并） | #76 已合并 | `agent/tracking-backfill-fb563c12afb5` | 是 | 干净 | 0 | 11-13 13:29 | 23M |
| ☐ | `S/ux-agent-955add1f2430` | `ux-agent-955add1f2430`（已合并） | #60 已合并 | `agent/ux-agent-955add1f2430` | 是 | 干净 | 0 | 11-11 19:55 | 18M |
| ☐ | `W/dsh-superagent-evolve-t5-e3970a0d873a` | `evolve-t5-e3970a0d873a`（已完成） | #55 已合并 | `agent/evolve-t5-e3970a0d873a` | 是 | 干净 | 0 | 11-11 13:34 | 14M |

### 3.2 小目录与 0M 空检出（<10M，38 个，0.03 GiB）

| ☐ | 目录 | 工单（状态） | PR | 分支 | 已合入 main | git | 未推送 | 最后活动 | 大小 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ☐ | `W/dsh-superagent-review-preview-t3-d8d27125b0f8` | `review-preview-t3-d8d27125b0f8`（已完成） | #24 已合并 | `agent/review-preview-t3-d8d27125b0f8` | 是 | 干净 | 0 | 11-08 19:53 | 8M |
| ☐ | `W/dsh-superagent-chaos-t2-t2-d9f55ef5bf1b` | `chaos-t2-t2-d9f55ef5bf1b`（已完成） | #17 已合并 | `agent/chaos-t2-t2-d9f55ef5bf1b` | 是 | 干净 | 0 | 11-08 18:03 | 7M |
| ☐ | `W/dsh-superagent-tasks-65cb3e4622dc` | `tasks-65cb3e4622dc`（已完成） | #26 已合并 | `agent/tasks-65cb3e4622dc` | 是 | 干净 | 0 | 11-08 21:14 | 7M |
| ☐ | `S/agent-profile-phase1-b168f6150aaa` | `agent-profile-phase1-b168f6150aaa`（已完成） | #51 已合并 | `agent/agent-profile-phase1-b168f6150aaa` | 是（WC） | 干净 | 0 | 11-10 18:39 | <1M |
| ☐ | `S/chaos-t2-t2-d9f55ef5bf1b` | `chaos-t2-t2-d9f55ef5bf1b`（已完成） | #17 已合并 | `agent/chaos-t2-t2-d9f55ef5bf1b` | 是（WC） | 干净 | 0 | 11-08 17:54 | <1M |
| ☐ | `S/context-t5-512c2187ae61` | `context-t5-512c2187ae61`（已完成） | #54 已合并 | `agent/context-t5-512c2187ae61` | 是（WC） | 干净 | 0 | 11-11 10:34 | <1M |
| ☐ | `S/dispatch-86e4f13ae132` | `dispatch-86e4f13ae132`（已完成） | #27 已合并 | `agent/dispatch-86e4f13ae132` | 是（WC） | 干净 | 0 | 11-08 20:00 | <1M |
| ☐ | `S/doc-previewer-redline-t3-1cb26c18f524` | `doc-previewer-redline-t3-1cb26c18f524`（已完成） | #22 已合并 | `agent/doc-previewer-redline-t3-1cb26c18f524` | 是（WC） | 干净 | 0 | 11-08 19:19 | <1M |
| ☐ | `S/docs-c4-98f7fc9c3bd4` | `docs-c4-98f7fc9c3bd4`（已合并） | #59 已合并 | `agent/docs-c4-98f7fc9c3bd4` | 是（WC） | 干净 | 0 | 11-11 17:41 | <1M |
| ☐ | `S/docs-e56519d94b0d` | `docs-e56519d94b0d`（已完成） | #31 已合并 | `agent/docs-e56519d94b0d` | 是（WC） | 干净 | 0 | 11-08 22:37 | <1M |
| ☐ | `S/dump-config-x-49bfca376b55` | `dump-config-x-49bfca376b55`（已完成） | #19 已合并 | `agent/dump-config-x-49bfca376b55` | 是（WC） | 干净 | 0 | 11-08 18:23 | <1M |
| ☐ | `S/evolve-t5-e3970a0d873a` | `evolve-t5-e3970a0d873a`（已完成） | #55 已合并 | `agent/evolve-t5-e3970a0d873a` | 是（WC） | 干净 | 0 | 11-11 13:03 | <1M |
| ☐ | `S/exposure-e0-e3-t5-aa8388381440` | `exposure-e0-e3-t5-aa8388381440`（已完成） | #53 已合并 | `agent/exposure-e0-e3-t5-aa8388381440` | 是（WC） | 干净 | 0 | 11-10 22:22 | <1M |
| ☐ | `S/goals-t5-c8c43c8c222a` | `goals-t5-c8c43c8c222a`（已完成） | #45 已合并 | `agent/goals-t5-c8c43c8c222a` | 是（WC） | 干净 | 0 | 11-10 13:51 | <1M |
| ☐ | `S/group-derivation-84888ce75866` | `group-derivation-84888ce75866`（已完成） | #50 已合并 | `agent/group-derivation-84888ce75866` | 是（WC） | 干净 | 0 | 11-10 18:39 | <1M |
| ☐ | `S/host-matrix-64d9e1d5d790` | `host-matrix-64d9e1d5d790`（已完成） | #49 已合并 | `agent/host-matrix-64d9e1d5d790` | 是（WC） | 干净 | 0 | 11-10 18:39 | <1M |
| ☐ | `S/install-e2e-x-17c24e2e8720` | `install-e2e-x-17c24e2e8720`（已完成） | #20 已合并 | `agent/install-e2e-x-17c24e2e8720` | 是（WC） | 干净 | 0 | 11-08 18:22 | <1M |
| ☐ | `S/lightweight-t3-phase-1e0a7afe10dd` | `lightweight-t3-phase-1e0a7afe10dd`（已完成） | #36 已合并 | `agent/lightweight-t3-phase-1e0a7afe10dd` | 是（WC） | 干净 | 0 | 11-09 00:07 | <1M |
| ☐ | `S/plan-2f5008b52db2` | `plan-2f5008b52db2`（已完成） | #33 已合并 | `agent/plan-2f5008b52db2` | 是（WC） | 干净 | 0 | 11-08 23:18 | <1M |
| ☐ | `S/readme-d04c47d813c4` | `readme-d04c47d813c4`（已完成） | #28 已合并 | `agent/readme-d04c47d813c4` | 是（WC） | 干净 | 0 | 11-08 20:08 | <1M |
| ☐ | `S/replacement-t5-13f2c82bb682` | `replacement-t5-13f2c82bb682`（已完成） | #56 已合并 | `agent/replacement-t5-13f2c82bb682` | 是（WC） | 干净 | 0 | 11-11 16:56 | <1M |
| ☐ | `S/review-10d4739b9c2e` | `review-10d4739b9c2e`（已完成） | #32 已合并 | `agent/review-10d4739b9c2e` | 是（WC） | 干净 | 0 | 11-08 22:49 | <1M |
| ☐ | `S/review-preview-t3-d8d27125b0f8` | `review-preview-t3-d8d27125b0f8`（已完成） | #24 已合并 | `agent/review-preview-t3-d8d27125b0f8` | 是（WC） | 干净 | 0 | 11-08 19:19 | <1M |
| ☐ | `S/sheet-previewer-t3-86aab0aa05e1` | `sheet-previewer-t3-86aab0aa05e1`（已完成） | #23 已合并 | `agent/sheet-previewer-t3-86aab0aa05e1` | 是（WC） | 干净 | 0 | 11-08 19:26 | <1M |
| ☐ | `S/source-guide-4c15e7dd85ff` | `source-guide-4c15e7dd85ff`（已完成） | #25 已合并 | `agent/source-guide-4c15e7dd85ff` | 是（WC） | 干净 | 0 | 11-08 19:53 | <1M |
| ☐ | `S/sources-github-d986f4ccbd36` | `sources-github-d986f4ccbd36`（已完成） | #57 已合并 | `agent/sources-github-d986f4ccbd36` | 是（WC） | 干净 | 0 | 11-11 17:14 | <1M |
| ☐ | `S/spaces-phase-t3-09c6e56b31c9` | `spaces-phase-t3-09c6e56b31c9`（已完成） | #46 已合并<br>#48 已合并 | `agent/spaces-phase-t3-09c6e56b31c9` | 是（WC） | 干净 | 0 | 11-10 13:51 | <1M |
| ☐ | `S/spaces-t3-8a6e2595a397` | `spaces-t3-8a6e2595a397`（已完成） | #43 已合并 | `agent/spaces-t3-8a6e2595a397` | 是（WC） | 干净 | 0 | 11-10 11:41 | <1M |
| ☐ | `S/superagent-5eb57f42c15d` | `superagent-5eb57f42c15d`（已完成） | #30 已合并 | `agent/superagent-5eb57f42c15d` | 是（WC） | 干净 | 0 | 11-08 22:13 | <1M |
| ☐ | `S/tasks-65cb3e4622dc` | `tasks-65cb3e4622dc`（已完成） | #26 已合并 | `agent/tasks-65cb3e4622dc` | 是（WC） | 干净 | 0 | 11-08 20:07 | <1M |
| ☐ | `S/tasks-phase-b-t3-6cb15a26850c` | `tasks-phase-b-t3-6cb15a26850c`（已完成） | #42 已合并 | `agent/tasks-phase-b-t3-6cb15a26850c` | 是（WC） | 干净 | 0 | 11-09 19:04 | <1M |
| ☐ | `S/tasks-view-phase1-26459a1cd162` | `tasks-view-phase1-26459a1cd162`（已完成） | #38 已合并 | `agent/tasks-view-phase1-26459a1cd162` | 是（WC） | 干净 | 0 | 11-09 12:11 | <1M |
| ☐ | `S/tickets-phase-a-t3-ca0c762da260` | `tickets-phase-a-t3-ca0c762da260`（已完成） | #40 已合并 | `agent/tickets-phase-a-t3-ca0c762da260` | 是（WC） | 干净 | 0 | 11-09 15:43 | <1M |
| ☐ | `S/timeline-t3-a7426f4ca37a` | `timeline-t3-a7426f4ca37a`（已完成） | #37 已合并 | `agent/timeline-t3-a7426f4ca37a` | 是（WC） | 干净 | 0 | 11-09 12:11 | <1M |
| ☐ | `S/tracking-x-aeb4ad04ad4c` | `tracking-x-aeb4ad04ad4c`（已完成） | #34 已合并 | `agent/tracking-x-aeb4ad04ad4c` | 是（WC） | 干净 | 0 | 11-09 00:07 | <1M |
| ☐ | `S/workspace-84b6e789923d` | `workspace-84b6e789923d`（已完成） | #41 已合并 | `agent/workspace-84b6e789923d` | 是（WC） | 干净 | 0 | 11-09 19:17 | <1M |
| ☐ | `S/workspace-8b0236b7d49f` | `workspace-8b0236b7d49f`（已完成） | — | `agent/workspace-8b0236b7d49f` | 是（WC） | 干净 | 0 | 11-10 09:58 | <1M |
| ☐ | `S/x-f13cb47c27fb` | `x-f13cb47c27fb`（已完成） | #52 已合并 | `agent/x-f13cb47c27fb` | 是（WC） | 干净 | 0 | 11-10 21:04 | <1M |

## 4. 保留（13 个）

§4.1 的四个工单目录，本地分支同样是 `agent/<工单名>`（例如 `agent/conversation-f21d793d9eb8`）；§4.2 的基线克隆单独列出当前分支。

### 4.1 工单目录（4 个）

| 目录 | 工单（状态） | PR | 保留原因 | 大小 |
| --- | --- | --- | --- | --- |
| `S/conversation-f21d793d9eb8` | `conversation-f21d793d9eb8`（进行中） | — | 当前工单的执行目录，租约 active | 23M |
| `S/warm-session-t3-889c520beafd` | `warm-session-t3-889c520beafd`（进行中） | — | 工单未结束；0M 空检出，11-08 后无活动，可人工决定是否结束工单 | 0 |
| `S/ux-superagent-cd48ecae58aa` | `ux-superagent-cd48ecae58aa`（已结束） | #6 open | workcenter PR #6 仍 open | 3M |
| `S/git-integration-research-2ed9a679f032` | `git-integration-research-2ed9a679f032`（已关闭） | #71 已关闭 | PR 关闭未合并；分支已推送但未并入 main，研究内容可能仍要 | 181M |

### 4.2 基线克隆（9 个，不能按目录直接删）

这些 `.git` 是**目录**而不是文件，说明它们是完整克隆（主 worktree），不是 `git worktree remove` 能处理的链接 worktree。删它们会带走本地分支，并使挂在它们下面的 worktree 失去对象库；必须先把子 worktree 迁走/删掉。

| 基线克隆 | 当前分支 | 对应工单 | 宿主 worktree | git | 未推送 | 大小 | 处置 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `R/workcenter` | `main` | —（公共仓库） | 69（S 的 66 个 + 2 个 T + 自身） | 干净 | 0 | 31M | **不能删**；当前部署的 Git 公共仓库 |
| `W/dsh-superagent-tickets-phase-a-…` | `agent/tickets-phase-a-…` | PR #40 已合并 | 1（自身） | 干净 | 0 | 148M | 工单已合并；第二阶段可整体删，本地分支会一并消失 |
| `W/dsh-superagent-warm-session-…` | `agent/warm-session-…` | 工单进行中 | 1（自身） | 干净 | 0 | 11M | 保留 |
| `R/dsh-superagent-goals` | `agent/goals-…` | PR #45 已合并 | 3（自身 + 2 个 Gen B） | 干净 | **2** | 153M | 先处理 §5.2 的 agent-profile worktree；删除克隆前确认这 2 个本地提交 |
| `R/dsh-superagent-t3-11` | `agent/tasks-phase-b-…` | PR #42 已合并 | 6（自身 + 4 个 Gen B + 1 个 T） | 干净 | 0 | 153M | 先处理 §5.2 的 spaces-phase/timeline |
| `R/dsh-superagent-review` | `agent/review-…` | PR #32 已合并 | 7（自身 + 2 个内嵌 + 2 个 Gen B + 2 个 T） | 干净 | 0 | 148M | 先处理 §5.1 的内嵌 worktree |
| `R/dsh-superagent-t3-09` | `agent/tasks-view-phase1-…` | PR #38 已合并 | 2（自身 + 1 个 T） | 干净 | 0 | 149M | 先处理 T 基线 |
| `R/dsh-superagent-exposure-e0-e3` | `agent/exposure-…` | PR #53 已合并 | 2（自身 + 1 个 T） | 干净 | —（无上游） | 153M | 先处理 T 基线 |
| `R/dsh-superagent-x-f13cb47c27fb` | `agent/x-f13cb47c27fb` | PR #52 已合并 | 1（自身） | 干净 | —（无上游） | 149M | 第二阶段可整体删 |

`git status` 全部干净。`R/dsh-superagent-goals` 的 `agent/goals-…` 分支有 2 个未推送提交（`43d046b feat(goals): add the read-only Goal projection`、`bfe0c30 fix(goals): make reviewability and child queues explicit`），对应 PR #45 已合并，但分支本身没有推到远端；删除该克隆前要确认。`exposure`/`x-f13` 没有配置上游，无法用 `@{u}` 比较，但对应 PR 已合并。

（第二阶段的“整体删”指在确认无子 worktree、无未推送提交后，直接删整个克隆目录；本地 `agent/*` 分支会随之消失，但远端分支仍在。**本次不建议执行。**）

## 5. 有风险（14 个，0.88 GiB）

§5 中工单目录的本地分支同样是 `agent/<工单名>`；§5.4 的两个目录是 detached HEAD，没有工单分支。

### 5.1 内嵌 worktree（3 个，父目录本身是 0M 空检出）

三个 S 目录里各嵌了一个真正的 dsh-superagent worktree（`dsh-superagent/`）。它们是旧 R 代留下的嵌套布局，登记在别的基线仓库里；直接 `git worktree remove` 父目录会失败或留下孤儿注册。

| 父目录 | 内嵌 worktree | 工单 / PR | 内嵌树状态 | 处置 |
| --- | --- | --- | --- | --- |
| `S/golden-path-2b7da2fe4033` | `…/golden-path-2b7da2fe4033/dsh-superagent`（140M） | golden-path / #44 已合并 | 干净 | 先移除内嵌 worktree，再归档父目录的 3 个笔记，最后删父目录 |
| `S/tasks-ticket-e73879310201` | `…/tasks-ticket-e73879310201/dsh-superagent`（137M） | tasks-ticket / #39 已合并 | 干净 | 先移除内嵌 worktree，再删父目录 |
| `S/mail-previewer-t3-7e9ac88dd786` | `…/mail-previewer-t3-7e9ac88dd786/dsh-superagent`（8M） | mail-previewer / #35 已合并 | 仅未跟踪 `node_modules` | 先清内嵌的 `node_modules`（或确认可强制）再移除，最后删父目录 |

具体命令（确认后再执行）：

```sh
# 内嵌 worktree 的宿主仓库不同，先查归属
git -C <内嵌路径> worktree list --porcelain | head -1
# 干净的内嵌树：从它自己的基线仓库移除
git -C <基线仓库> worktree remove <内嵌路径>
# 最后从 workcenter 移除父目录
git -C /Users/steven/src/workcenter worktree remove <父目录>
```

### 5.2 有真实未合并改动（3 个，**不要删**）

| 目录 | 未提交 / 未推送 | 工单 / PR | 处置 |
| --- | --- | --- | --- |
| `R/dsh-superagent-agent-profile-46c1d4581797` | 5 个已跟踪改动（README、docs/README、删除 `docs/agent-profile.zh.md`、TASK-PLAN、TRACKING）+ 1 个未推送提交 `941d9ee` | agent-profile / #47 已合并 | 先 `git diff`/`git log` 人工判断；需要则存 patch，否则删目录 |
| `R/dsh-superagent-spaces-phase-t3-09c6e56b31c9` | 7 个已跟踪改动（含 `tests/spaces.spec.ts` +51、`tests/runtime-concurrency.spec.ts`） | spaces-phase / #46、#48 已合并 | 同上；这些测试改动可能没进 PR |
| `R/dsh-superagent-timeline-t3` | 1 个未推送提交 `2066921 fix(timeline): answer the independent review findings` | timeline / #37 已合并 | 先确认该 review 修复是否已进 #37；否则保留或另开 PR |

### 5.3 仅未跟踪笔记 / 依赖（6 个，低风险）

| 目录 | 未跟踪内容 | 工单 / PR | 处置 |
| --- | --- | --- | --- |
| `S/approval-0ede8ca6b133` | `PR-BODY.md`、`REVIEW.md` | approval / #18 已合并 | 归档笔记后删 |
| `S/approval-t2-9a4fab740ade` | `PR-BODY-T2-08.md`、`REVIEW-COMMENT-T2-08.md` | approval-t2 / #16 已合并 | 归档笔记后删 |
| `S/deliverable-t3-2e0c899cc86e` | `PR-BODY.md`、`REVIEW.md` | deliverable-t3 / #21 已合并 | 归档笔记后删 |
| `S/lightweight-t3-69f670b1014a` | `pr-body.md`、`review.md` | lightweight-t3 / #29 已合并 | 归档笔记后删 |
| `S/agent-profile-46c1d4581797` | `node_modules/` | agent-profile / #47 已合并 | 直接删（依赖可重装） |
| `S/human-identity-f6f08c7e3668` | `.pr-body.md` | human-identity / #65 已合并 | 归档笔记后删 |

这些目录的工单工作已经在合并的 PR 里；风险只是“删之前有没有人还要这些笔记”。确认后可并入 §3 一起删。

### 5.4 归属不明（2 个，T）

| 目录 | 状态 | 说明 |
| --- | --- | --- |
| `T/profile-before` | detached HEAD `0d24be7`，干净，21M | 某个 before/after 截图基线，不在面板工作区列表；无工单可对应 |
| `T/ux-batch1-before` | detached HEAD `e0e1336`，干净，148M | 同上 |

两者是 workcenter 的 detached worktree，不是工单目录。确认不再需要截图基线后，可按 §6 的方式用 `git -C /Users/steven/src/workcenter worktree remove <路径>` 删除；本次按“无法确定归属”记为风险。

## 6. 安全删除形式

`git worktree remove` 在 Git 2.54 没有 `--dry-run`（只有 `-f/--force`）。因此用下面的脚本：**默认只打印 WOULD remove**，设 `APPLY=1` 才真正删；每步都校验“在预期前缀内、是链接 worktree、树干净、无未推送”。

```sh
#!/usr/bin/env bash
# 默认 dry-run；APPLY=1 才执行。只移除 worktree，不删分支。
set -u
APPLY=${APPLY:-0}
DSH_MAIN=f2aef7f5eb191412a000d4d08780ac07696bb6c6   # touch-agent/dsh-superagent main
WC_MAIN=520fabf38c7b7bb6dd62c642ac1379a1a2883538    # workcenter main

paths=(
  "/Users/steven/.dsh/state/superagent/system/work/a-agent-aed9602e1262"
  "/Users/steven/.dsh/state/superagent/system/work/agent-profile-phase1-b168f6150aaa"
  "/Users/steven/.dsh/state/superagent/system/work/api-schema-b2d60135667b"
  "/Users/steven/.dsh/state/superagent/system/work/build-kb-1b1c01a598bd"
  "/Users/steven/.dsh/state/superagent/system/work/chaos-t2-t2-d9f55ef5bf1b"
  "/Users/steven/.dsh/state/superagent/system/work/context-t5-512c2187ae61"
  "/Users/steven/.dsh/state/superagent/system/work/depcruise-rules-386156cbcee4"
  "/Users/steven/.dsh/state/superagent/system/work/dispatch-86e4f13ae132"
  "/Users/steven/.dsh/state/superagent/system/work/doc-previewer-redline-t3-1cb26c18f524"
  "/Users/steven/.dsh/state/superagent/system/work/docs-4278b3bed607"
  "/Users/steven/.dsh/state/superagent/system/work/docs-c4-98f7fc9c3bd4"
  "/Users/steven/.dsh/state/superagent/system/work/docs-code-check-870e5b4cb449"
  "/Users/steven/.dsh/state/superagent/system/work/docs-e56519d94b0d"
  "/Users/steven/.dsh/state/superagent/system/work/docs-f8467d048ac6"
  "/Users/steven/.dsh/state/superagent/system/work/domain-test-budget-dea1c866287b"
  "/Users/steven/.dsh/state/superagent/system/work/dump-config-x-49bfca376b55"
  "/Users/steven/.dsh/state/superagent/system/work/evolution-value-gate-72d79538e43e"
  "/Users/steven/.dsh/state/superagent/system/work/evolve-t5-e3970a0d873a"
  "/Users/steven/.dsh/state/superagent/system/work/exposure-e0-e3-t5-aa8388381440"
  "/Users/steven/.dsh/state/superagent/system/work/goals-t5-c8c43c8c222a"
  "/Users/steven/.dsh/state/superagent/system/work/group-derivation-84888ce75866"
  "/Users/steven/.dsh/state/superagent/system/work/host-matrix-64d9e1d5d790"
  "/Users/steven/.dsh/state/superagent/system/work/install-e2e-x-17c24e2e8720"
  "/Users/steven/.dsh/state/superagent/system/work/lightweight-t3-phase-1e0a7afe10dd"
  "/Users/steven/.dsh/state/superagent/system/work/panel-10d7c1067e5b"
  "/Users/steven/.dsh/state/superagent/system/work/plan-2f5008b52db2"
  "/Users/steven/.dsh/state/superagent/system/work/profile-admin-a10ccf1a6d24"
  "/Users/steven/.dsh/state/superagent/system/work/readme-d04c47d813c4"
  "/Users/steven/.dsh/state/superagent/system/work/replacement-t5-13f2c82bb682"
  "/Users/steven/.dsh/state/superagent/system/work/review-10d4739b9c2e"
  "/Users/steven/.dsh/state/superagent/system/work/review-preview-t3-d8d27125b0f8"
  "/Users/steven/.dsh/state/superagent/system/work/sheet-previewer-t3-86aab0aa05e1"
  "/Users/steven/.dsh/state/superagent/system/work/source-guide-4c15e7dd85ff"
  "/Users/steven/.dsh/state/superagent/system/work/sources-github-d986f4ccbd36"
  "/Users/steven/.dsh/state/superagent/system/work/spaces-phase-t3-09c6e56b31c9"
  "/Users/steven/.dsh/state/superagent/system/work/spaces-t3-8a6e2595a397"
  "/Users/steven/.dsh/state/superagent/system/work/superagent-5eb57f42c15d"
  "/Users/steven/.dsh/state/superagent/system/work/tasks-65cb3e4622dc"
  "/Users/steven/.dsh/state/superagent/system/work/tasks-phase-b-t3-6cb15a26850c"
  "/Users/steven/.dsh/state/superagent/system/work/tasks-view-phase1-26459a1cd162"
  "/Users/steven/.dsh/state/superagent/system/work/tickets-phase-a-t3-ca0c762da260"
  "/Users/steven/.dsh/state/superagent/system/work/timeline-t3-a7426f4ca37a"
  "/Users/steven/.dsh/state/superagent/system/work/tracking-backfill-b887cd1feee6"
  "/Users/steven/.dsh/state/superagent/system/work/tracking-backfill-fb563c12afb5"
  "/Users/steven/.dsh/state/superagent/system/work/tracking-x-aeb4ad04ad4c"
  "/Users/steven/.dsh/state/superagent/system/work/ui-0414d2f9f297"
  "/Users/steven/.dsh/state/superagent/system/work/ui-6103e3b8b26f"
  "/Users/steven/.dsh/state/superagent/system/work/ux-agent-955add1f2430"
  "/Users/steven/.dsh/state/superagent/system/work/walkthrough-gaps-dc173a1ad619"
  "/Users/steven/.dsh/state/superagent/system/work/workspace-84b6e789923d"
  "/Users/steven/.dsh/state/superagent/system/work/workspace-8b0236b7d49f"
  "/Users/steven/.dsh/state/superagent/system/work/x-f13cb47c27fb"
  "/Users/steven/.dsh/state/superagent/system/work/x-lint-ci-1ce4d84db770"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-chaos-t2-t2-d9f55ef5bf1b"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-deliverable-t3-2e0c899cc86e"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-doc-previewer-redline-t3-1cb26c18f524"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-docs-c4-98f7fc9c3bd4"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-dump-config-x-49bfca376b55"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-evolve-t5-e3970a0d873a"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-install-e2e-x-17c24e2e8720"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-lightweight-t3-69f670b1014a"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-lightweight-t3-phase-1e0a7afe10dd"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-readme-d04c47d813c4"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-review-preview-t3-d8d27125b0f8"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-sheet-previewer-t3-86aab0aa05e1"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-source-guide-4c15e7dd85ff"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-src-0ede8ca6b133"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-src-9a4fab740ade"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-tasks-65cb3e4622dc"
  "/Users/steven/.dsh/state/superagent/work/dsh-superagent-workspace-84b6e789923d"
  "/Users/steven/src/dsh-superagent-agent-profile-phase1"
  "/Users/steven/src/dsh-superagent-context-t5"
  "/Users/steven/src/dsh-superagent-group-derivation"
  "/Users/steven/src/dsh-superagent-host-matrix"
  "/Users/steven/src/dsh-superagent-replacement-t5"
  "/Users/steven/src/dsh-superagent-sources-github-d986f4ccbd36"
  "/Users/steven/src/dsh-superagent-spaces-t3-8a6e2595a397"
  "/Users/steven/src/dsh-superagent-x13-aeb4ad04ad4c"
)

for path in "${paths[@]}"; do
  case "$path" in
    /Users/steven/.dsh/state/superagent/system/work/*|/Users/steven/.dsh/state/superagent/work/*|/Users/steven/src/*) ;;
    *) echo "SKIP outside roots: $path"; continue ;;
  esac
  [ -d "$path" ] || { echo "SKIP missing: $path"; continue; }
  base=$(git -C "$path" worktree list --porcelain 2>/dev/null | awk 'NR==1{sub(/^worktree /,"");print}')
  [ -n "$base" ] || { echo "SKIP not git: $path"; continue; }
  [ "$base" != "$path" ] || { echo "SKIP main clone: $path"; continue; }
  [ -z "$(GIT_OPTIONAL_LOCKS=0 git -C "$path" status --porcelain)" ] || { echo "SKIP dirty: $path"; continue; }
  ok=0
  up=$(GIT_OPTIONAL_LOCKS=0 git -C "$path" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || true)
  if [ -n "$up" ] && [ "$up" != "@{upstream}" ]; then
    [ "$(GIT_OPTIONAL_LOCKS=0 git -C "$path" rev-list --count "$up..HEAD")" = 0 ] && ok=1
  fi
  GIT_OPTIONAL_LOCKS=0 git -C "$path" merge-base --is-ancestor HEAD "$DSH_MAIN" 2>/dev/null && ok=1
  GIT_OPTIONAL_LOCKS=0 git -C "$path" merge-base --is-ancestor HEAD "$WC_MAIN" 2>/dev/null && ok=1
  [ "$ok" = 1 ] || { echo "SKIP unpushed-or-unmerged: $path"; continue; }
  if [ "$APPLY" = 1 ]; then
    git -C "$base" worktree remove "$path" && echo "removed $path (branch kept, base $base)"
  else
    echo "WOULD remove $path (base $base, branch kept)"
  fi
done
```

使用顺序：

```sh
# 1) 先空跑，确认 78 行 WOULD remove、没有 SKIP
bash workspace-cleanup.sh

# 2) 逐批执行；建议先删 0M 空检出和 W 代大目录，观察面板
APPLY=1 bash workspace-cleanup.sh

# 3) 只清理已失效的 admin 注册（不碰工作目录）；覆盖 §4.2 的全部基线仓库
for repo in \
  /Users/steven/src/workcenter \
  /Users/steven/projects/open-git/dsh-superagent \
  /Users/steven/src/dsh-superagent-goals \
  /Users/steven/src/dsh-superagent-t3-11 \
  /Users/steven/src/dsh-superagent-review \
  /Users/steven/src/dsh-superagent-t3-09 \
  /Users/steven/src/dsh-superagent-exposure-e0-e3 \
  /Users/steven/src/dsh-superagent-x-f13cb47c27fb; do
  git -C "$repo" worktree prune
done
```

安全边界：

- **不要**用 `rm -rf` 删 worktree；会留下 `.git/worktrees/*` 注册和 `git worktree list` 的坏路径。
- **不要**加 `-f`；脏树/未跟踪文件被拒绝正是保护。
- `git worktree remove` 不动 `refs/heads/agent/*`；分支保留，可随时 `worktree add` 回来。
- 删除后到面板/宿主工作区里移除同名条目；本脚本只动 Git 和目录（见 §7 R4）。
- 若要清理 `agent/*` 分支，另做一步 `git branch -d`（只用 `-d`，让 Git 再检查合并状态）。

## 7. 后续治理建议

**R1 自动回收（对应 docs/013 Phase 3）。** 在工单结束（merged/closed）后加一个保留窗（建议 7 天），定时执行：对 `git worktree list` 里的工单目录检查树干净、无未推送、PR 已合并，满足则 `worktree remove`，不满足则报告并保留。本手册的 §6 脚本就是现成的原型。

**R2 收敛基线仓库。** 现在有三代基线（W 的 projects 克隆、R 的 6 个克隆、R/workcenter），互相嵌套。建议只保留一个专用的 dsh-superagent 基线（裸仓库或单一工作克隆），所有 worktree 从它派生；停止“每工单再克隆一份”和“worktree 里再嵌 worktree”。这一步做完，这批基线克隆（约 1.0 GiB）才能安全退场。

**R3 给 prepare 加基线断言。** S 下 44 个停在 workcenter main 的目录是 fetch 错仓库/错 ref 的产物。prepare 成功后应断言分支起点是 `refs/dsh-superagent/<ticket>`（而不是 workcenter main），失败就回滚 `worktree add`；同时在工单记录里保存基线仓库与 base commit，便于盘点。

**R4 删除目录时同步注销面板工作区。** 当前面板列表和磁盘目录是两套事实：18 个条目已经指向不存在的目录。建议在 `worktree remove` 后由系统删除对应宿主 workspace 条目（或在面板提供显式“移除工作区”），否则每清一个目录就多一个死条目。

**R5 在工单记录里保存 PR 编号。** 本次只能靠 `agent/<name>` 分支名反查 PR。若 Ticket 记录直接保存 PR number/state，盘点与回收都不必再依赖分支命名。

**R6 只读/研究类工单不建可写 worktree。** git-integration 这类研究工单没有代码交付，却占 181M。轻量工单或只读任务可以共用 scratch 目录，或明确标记“无空间”。

## 附录 A 面板中指向已删除目录的条目（18 个）

这些条目在宿主工作区存储（`~/.dsh/storages/workspace.json`）里，但磁盘目录已不存在。它们不是本次的删除对象（没有目录可删），需要在面板/宿主工作区里移除。

| 路径 | 标题 |
| --- | --- |
| `/Users/steven/.dsh/state/superagent/system/work/maxactionlevel-revalidate-t2-de4dbc917ba6` | maxactionlevel-revalidate-t2-de4dbc917ba6 |
| `/Users/steven/.dsh/state/superagent/system/work/source-manifest-t1-dfb3e2f48672` | source-manifest-t1-dfb3e2f48672 |
| `/Users/steven/.dsh/state/superagent/system/work/review-pr-maxactionlevel-revalid-6426fdf3fb7e` | review-pr-maxactionlevel-revalid-6426fdf3fb7e |
| `/Users/steven/.dsh/state/superagent/system/work/pr-round-findings-bd847399f6e9` | pr-round-findings-bd847399f6e9 |
| `/Users/steven/.dsh/state/superagent/system/work/events-8c580d5093a3` | events-8c580d5093a3 |
| `/Users/steven/.dsh/state/superagent/system/work/approvals-pending-f56d37bcd08a` | approvals-pending-f56d37bcd08a |
| `/Users/steven/.dsh/state/superagent/system/work/review-pr-400be2163fff` | review-pr-400be2163fff |
| `/Users/steven/.dsh/state/superagent/system/work/outbox-undo-t2-335a8688a78c` | outbox-undo-t2-335a8688a78c |
| `/Users/steven/.dsh/state/superagent/system/work/pr-round-2ee0a791780b` | pr-round-2ee0a791780b |
| `/Users/steven/.dsh/state/superagent/system/work/idempotency-t2-a46026a164ef` | idempotency-t2-a46026a164ef |
| `/Users/steven/.dsh/state/superagent/system/work/tasks-368b89f31050` | tasks-368b89f31050 |
| `/Users/steven/.dsh/state/superagent/system/work/source-probe-t2-4e220f91d3d8` | source-probe-t2-4e220f91d3d8 |
| `/Users/steven/.dsh/state/superagent/work/dsh-superagent-task-plan-802eef152735` | dsh-superagent-task-plan-802eef152735 |
| `/Users/steven/.dsh/state/superagent/work/superagent-257a69fe66ea` | superagent-257a69fe66ea |
| `/Users/steven/.dsh/state/superagent/work/feishu-doc-source-19c5ba457d4a` | feishu-doc-source-19c5ba457d4a |
| `/Users/steven/.dsh/state/superagent/work/superagent-ui-tab-sse-5b90f4b78c76` | superagent-ui-tab-sse-5b90f4b78c76 |
| `/Users/steven/.dsh/state/superagent/work/action-t2-1d4f5564d367` | action-t2-1d4f5564d367 |
| `/Users/steven/.dsh/state/superagent/work/approval-t2-4259c10d07bd` | approval-t2-4259c10d07bd |

## 附录 B 复核方法与限制

**实际只读命令**（均在 2026-11-13 执行，未删除/移动目录）：

- `git worktree list --porcelain`（每个基线仓库一次），核对注册路径与分支；
- `git status --porcelain`（`GIT_OPTIONAL_LOCKS=0`，避免刷新索引）；
- `git rev-list --count <upstream>..HEAD`、`git merge-base --is-ancestor HEAD <main>`；
- `git ls-remote --heads <remote> 'refs/heads/agent/*'`（dsh-superagent 76 个、workcenter 3 个分支）；
- `gh pr list --state all --limit 300`（dsh-superagent 78 个、workcenter 6 个 PR）；
- `du -sk <dir>` 统计占用；`stat` 读目录 mtime。

**分类标准**（按本次要求从严）：

- **可删** = 工单已结束 + PR 已合并 + `git status` 干净 + 无未推送提交 + 不是基线/嵌套 + 不是当前租约；
- **保留** = 工单进行中、PR 仍 open、PR 关闭未合并，或结构性不能直接删的基线克隆；
- **有风险** = 任一未提交改动（含未跟踪文件）、未推送提交、嵌套 worktree、归属不明。未跟踪笔记也算风险，即使内容只是 PR 正文。

**限制**：

- 大小含 `node_modules`、`.artifacts`、`.corepack` 等可重建产物；删后需要时用 `pnpm install` 重装。
- “最后活动”是目录 mtime，不等于最后提交时间；0M 空检出的 mtime 是创建/改动时间。
- PR 状态是 2026-11-13 的快照；之后新合并的 PR 不改变本表的历史判断。
- 对 78 个可删路径都额外核对了“本地 HEAD = 远端分支 head，或 HEAD 已在 main 中”；`APPLY=0` 校验 78/78 通过。`git worktree prune --dry-run` 在当时没有可清理的失效注册。
- 没有检查被 Git 忽略的文件是否含不可重建的数据（如 `.artifacts` 里的测试输出）；删除前若要保留测试证据，先自行归档。
