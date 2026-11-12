# 024 UI 第二批：系统页收进设置、任务详情加详与首次说明

> 状态：已实现（2026-11-12），默认开启、逐项可回退。
> 输入：[021 界面重构提案](021-ux-redesign.zh.md) 的「运维进设置、任务详情、首次使用、术语、Feature Flags」五条，以及 [023 第一批](023-ux-first-batch.zh.md) 已落地的任务层级、通知层与错误聚合。
> 边界：只用插件已暴露的扩展点；不新增宿主设置分组或弹窗能力，不删除 E2/E3 记录，不改 Approval、Mandate、Dispatch 或 Store schema。

## 1. 这一批做了什么

| # | 提案条目 | 落地 |
| --- | --- | --- |
| ① | 系统页收进设置 | 默认面只保留「概览 / 任务 / 设置」；来源、触发、评估、执行成为设置里的四个独立页，带分组、图标和每页一句话说明。原有 `source`、`trigger`、`eval`、`execution` 路由保留，告警、通知和任务里的直接链接仍能落到同一记录；列表路由打开设置页，带 id 的详情路由仍显示详情且不选中一级标签 |
| ② | 任务详情加详 | 详情依次回答「需要你决定什么（没有就写不需要你做什么）/ 做了什么（结果摘要 + 产出物链接）/ 下一步与预计 / 谁在做（负责人的人话描述）」；子任务汇报逐条展开，显示交给它的目标、上级判断、理由、时间与自己的产出物链接；内部 id 仍只在 E2 |
| ③ | 空态与首次使用 | 首次打开面板（概览或任务页）显示三行说明「你能让它做什么 / 它需要你做什么 / 从哪开始」，读过一次收起；没有任务时给两个可点击入口：打开主会话、连接来源 |
| ④ | 术语 | 任务、概览、通知、详情继续使用「任务、结果、产出物、负责人、执行会话、被卡住」等词；运维设置页保留其既有运维名称；`worker-`、`ticket_`、`session_` 与 Assignment 等只在 E2/E3 |
| ⑤ | Feature Flags | 收编、任务详情加详、首次说明各自独立开关；关闭后回到 023 的七标签默认面、第一批任务详情和纯文字空态，记录不删 |

## 2. 设计与边界

### 2.1 设置里的系统页

- 设置仍是插件面板内的页面（`SettingsPage`），不是宿主的设置弹窗。DSH 当前没有给插件提供设置分组/设置弹窗座位（见 [022](022-harness-extension-requests.zh.md) 的设置分组一项），因此「设置弹窗」在只用插件扩展点的前提下落成插件自己的「设置」一级页；宿主升级后可以把同一组页面挂进宿主设置。
- 设置导航按「来源与任务 / 界面与偏好 / 系统」分组；每个条目有图标，选中项高亮。页面标题下是一句话说明。
- 来源、评估、执行页把「状态」放在上、「配置」放在下，二者仍读同一份管理 API；触发页只有状态与筛选。
- 来源、触发、评估、执行的既有路由与查询参数保留：`?filter=`、`?window=`、`?from=` 仍原样传给状态视图；`execution/:id` 与 `trigger/:id` 不打开设置列表，仍显示任务/线程详情。
- 列表路由在收编开启时选中「设置」；带 id 的详情路由不选中任何一级标签，标签栏仍只有三项。
- 关闭 `ux.opsInSettings.v1` 后恢复七个一级入口；设置导航回到第一批的六项（不含触发），来源/评估/执行页也不再嵌入状态视图。

### 2.2 任务详情

- 详情仍是 `GET tasks` / `GET tasks/:id?depth=1` 的客户端投影，不新增服务端字段或第二个聚合。
- 顺序按人的问题排列：决定 → 做了什么 → 下一步与预计 → 目标 → 谁在做 → 子任务 → 阻断 → 向上汇报 → 执行会话 → E2。
- 「需要你决定」只来自 `goal.decision`：回答、验收、补交付、恢复被卡住/未完成。没有决定时写「不需要你做什么」，并说明有事会再找；不把子任务等待上级判断误写成人要处理。
- 「做了什么」优先用当前 review 的摘要，其次用最近一份产出物的摘要；产出物有 `http(s)` 地址时直接打开，否则提供「查看完整记录」进入任务页。没有结果时写还没有可看的结果，不伪造完成语。
- 「预计」只写记录能支持的事：等你处理、已结束、还在跑且没有可靠完成时间；不编造剩余时间，也不把记录的创建时长当成执行耗时。
- 「谁在做」用 `GET profiles` 的 `title` / `description` 和 Ticket 绑定的 revision 说人话；找不到或没有绑定 Profile 时退回「默认执行配置」，不显示 `worker-*` id。子任务另有上级负责人。
- 子任务汇报用原生 `details` 逐条展开，显示交给它的目标、上级判断、理由、时间；默认折叠，避免把列表拉长。
- 关闭 `ux.taskDetail.v2` 后回到 023 的任务层级详情（包含 Profile id 与产出物文本）。

### 2.3 首次使用与空态

- 三行说明只在浏览器第一次打开面板时出现（概览与任务页共用同一条已读记录）；点「知道了」后收起并写入 `dsh-superagent/first-use-dismissed`，不写服务端。设置 › 显示提供「再显示一次首次说明」，只删这个浏览器键。
- 没有任务时，「打开主会话」调用已有的 `openSession`；主会话不存在时退回来源设置；「连接来源」进入设置 › 来源。两个入口都不创建任务、不授予权限。
- 关闭 `ux.firstUse.v1` 后不显示三行说明与示例按钮，空列表回到一句「还没有任务」。

## 3. 术语

默认任务/概览/通知/详情面按 [021 §5](021-ux-redesign.zh.md#5-术语) 使用人话；设置里的运维页保留「来源、触发、评估、执行」这些运维名称，与 023 的边界一致。内部标识只出现在 E2/E3：

| 默认面 | 不出现 |
| --- | --- |
| 负责人 · 迁移文案负责人 · 第 2 版 | `worker-plan`、Profile id |
| 执行会话 | `session_*`、Session id |
| 任务标识 / 所属根任务 / 执行次数（E2 内） | `ticket_*`、Assignment id |

## 4. Feature Flags 与回退

| 开关 | 默认 | 关闭后的行为 |
| --- | --- | --- |
| `ux.opsInSettings.v1` | 开 | 恢复七个一级入口与六项设置导航；系统页状态视图回到独立页 |
| `ux.taskDetail.v2` | 开 | 任务详情回到 023 的层级视图；不请求 Profile 列表 |
| `ux.firstUse.v1` | 开 | 不显示三行说明与空态示例，空列表只显示一句提示 |

浏览器偏好另有 `dsh-superagent/first-use-dismissed`。三项都只改客户端可见性；刷新后生效，不迁移、不删除记录，也不需要重启。

## 5. 验证

- `pnpm typecheck`
- `pnpm vitest run tests/panel-ux-second-batch.spec.tsx tests/panel-overview.spec.tsx tests/panel-settings.spec.tsx tests/panel-task-hierarchy.spec.tsx tests/panel-tasks.spec.tsx tests/panel-execution.spec.tsx tests/panel-eval.spec.tsx tests/panel-source.spec.tsx`
- `pnpm check`（tracking、arch、lint、全量测试、build、bundle size）；新增客户端界面使 `packages/dsh/lib/client.js` 从 650 KB 预算增到 686 KB，本次把该文件预算调到 700 KB、总预算调到 1.72 MB，仍由 `pnpm check:size` 守门
- 新增/更新的面板测试覆盖：默认只留三个一级入口；四个系统页的分组/图标/说明与直接链接；七个入口回退；带 id 的详情不选中标签；任务详情的决定、结果、链接、预计、人话负责人、子任务汇报与子任务详情不出现内部 id；任务详情 v2 回退时不请求 Profile 列表；首次说明只出现一次、示例入口、从设置恢复说明，以及关闭 `ux.firstUse.v1` 后回到纯文字空态。

### 5.1 视觉证据

同场景、同视口、light、zh-CN、同一合成 fixture；截图只截 Superagent 面板，不含真实工作区标题、账号或私有飞书内容。fixture 里的「迁移文案负责人」「补迁移说明」是为展示而合成，不代表真实继承链。Before 取 `main@08a33ad`，After 取本分支构建；正式场景为 1440×900，任务详情与设置长图为同一对比内同视口（1440×1800 / 1440×2400）。

| 场景 | Before（main@08a33ad） | After（本分支） |
| --- | --- | --- |
| 概览：一级入口从七个收成三个，首次说明落在默认面 | [before-overview.png](images/ux-second-batch/before-overview.png) | [after-overview.png](images/ux-second-batch/after-overview.png) |
| 来源：从独立页变成设置页（状态 + 配置 + 一句说明） | [before-source.png](images/ux-second-batch/before-source.png) | [after-source.png](images/ux-second-batch/after-source.png) |
| 设置：分组、图标、每页说明与触发页 | [before-settings.png](images/ux-second-batch/before-settings.png) | [after-settings.png](images/ux-second-batch/after-settings.png) |
| 设置长图：三个新开关（收编/详情/首次说明） | [before-settings-flags.png](images/ux-second-batch/before-settings-flags.png) | [after-settings-flags.png](images/ux-second-batch/after-settings-flags.png) |
| 同一任务详情：决定、结果、预计、负责人、子任务汇报 | [before-detail.png](images/ux-second-batch/before-detail.png) | [after-detail.png](images/ux-second-batch/after-detail.png) |
| 无任务：三行说明与可点击示例 | [before-empty.png](images/ux-second-batch/before-empty.png) | [after-empty.png](images/ux-second-batch/after-empty.png) |

### 5.2 十秒自查

对一个没用过本面板的人，默认面应能回答：

1. 我现在要做什么？——概览「待我处理」给出数量与第一条；没有任务时三行说明直接说能做什么、要你什么、从哪开始。
2. 这个任务现在要我做决定吗？——详情第一块写「需要你决定」或「不需要你做什么」，并给处理入口。
3. 它做完了什么、下一步是什么？——「做了什么」给摘要和产出物链接，「下一步 / 预计」说明在等谁或没有可靠时间。
4. 是谁在做？——「谁在做」给负责人名字、描述和版本，不出现内部 id。
5. 系统页去哪了？——设置里按组找到来源/触发/评估/执行；从告警或通知的链接仍能直接落到记录。

走查结论与缺口见 PR 的独立 review 评论。

## 6. 已知限制

- 「设置弹窗」是插件自己的设置页，不是宿主设置弹窗：DSH 尚未给插件设置分组座位（022）。宿主提供后可以把同样四个页面挂进去。
- 负责人描述来自 Profile 注册表；Profile 的标题/描述若仍是英文，界面会原样显示，不在客户端翻译用户数据。找不到 Profile 时只显示「默认执行配置」。
- 「预计」没有服务端 ETA；只显示等人、已结束或没有可靠完成时间，不估算剩余时间，也不展示会被误读为执行耗时的记录年龄。
- 产出物只有 `http(s)` 地址能直接打开；仓库内相对路径只能进任务页看完整记录。
- 收编开关需要刷新后生效，导航在渲染时读取浏览器偏好；这与现有 `ux.*` 开关一致。
- 首次说明的「已读」只存在本浏览器；换浏览器会再显示一次，这是浏览器偏好而不是验收状态。
