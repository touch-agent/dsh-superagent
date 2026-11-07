# SESSION-ENTRY — 主会话入口、页内系统视图与事件侧栏

> 基线：`touch-agent/dsh-superagent` @ `26cd395`（`main`）· 运行宿主 DSH `0.2.1-rc.5`
> 输入：工单「主会话是『一个进程一个体系』」①主会话/普通会话入口 ②主会话页内系统视图 + 右侧事件侧栏 ③工作目录分级
> 配套：`PLATFORM-EVOLUTION.zh.md`（为什么）、`TASK-PLAN.zh.md` §10.2（做什么）、本文（宿主能力核验与设计）
> 状态：设计已核验；S-01…S-03 已随本 PR 落地，S-04…S-08 待宿主界面任务排期

---

## 0. 结论

四类宿主扩展点**都真实存在**，但没有任何一个是「新建会话时弹一个类型选择框」：

| 需求 | 宿主能力 | 结论 |
| --- | --- | --- |
| 新建时选「主会话 / 普通会话」 | `conversation.hero.options`（list，New Session 行右侧）+ `ctx.uiWorkspace.openSession/startSession` | **可做**：选项打开既有主会话，不新建；普通会话走宿主默认新建 |
| 主会话 tab 内看整个体系 | `conversation.view`（list，会话内 tab）+ 现成管理 API/面板 | **可做**：只对主会话注册「体系」视图 |
| 右侧实时事件与工单状态 | `sidebar.right.pane.tab` + `.title` + `ctx.sidebarRight.openTab/close/toggleExpanded` | **可做**：注册「事件」tab，宿主自带关闭/展开 |
| 服务端推送 | `ctx.webServer.register`（`exact` 路由，handler 持有响应） | **可做**：SSE；首版用 5 秒轮询即可 |

不可行/受限的部分：宿主没有第一等「会话类型」弹窗；`conversation.hero.agentPreset` 是 `single` 且已被 `ui-agent-preset` 占用，不能再用它选 router preset；右侧栏是**会话级**而非全局。回退方案见 §2.6。

「一个进程一个体系」是本设计的主约束：主会话在每个进程内是单例（`masterId = orchestrator-<stateDir 的 key>`，启动时创建），
「主会话」入口必须**打开它**，而不是再建一个 router 会话。

---

## 1. 现状（读代码与运行包所得）

| 事实 | 证据 |
| --- | --- |
| 主会话启动时单例创建，工作目录为 `stateDir` | `packages/dsh/src/app/runtime.ts` 的 `sessions.ensure(masterId, …)`；`masterId` 在 `packages/dsh/src/app/sessions.ts` |
| 工单目录默认 `<stateDir>/work/<短名>`，可由设置覆盖 | `packages/dsh/src/app/execution-environment.ts`、`packages/dsh/src/executor/dsh.ts` |
| 入口是独立主面板 + 侧栏图标 + 插件配置页 | `packages/dsh/src/client/index.tsx` |
| 面板用 5 秒轮询，没有推送 | `packages/dsh/src/client/api.ts` 的 `usePoll` |
| 每个领域事件同时走「报告 relay」与「事件 notice」两条路 | `packages/dsh/src/app/assembly.ts` 的 `emit`；`packages/dsh/src/app/notices.ts` |
| 工单 `ready` 报告已经 relay，随后 `ticket.ended` 又发一条 notice | `tests/tools.spec.ts` 原先断言两条并存；本 PR 改为一条 |

---

## 2. 宿主扩展点核验（DSH `0.2.1-rc.5`）

运行包位置：`~/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`。
以下都已在该版本的类型声明与实现中确认，不是依据旧版本文档。

### 2.1 新建会话时的入口选项

- `conversation.hero.options`：`kind: 'list'`，只在 New Session 行、且已有会话时渲染；每项由插件注册一个 React 组件，可右对齐。
- `conversation.hero.agentPreset`：`kind: 'single'`，已由 `ui-agent-preset` 占用；**不能**注册第二个，否则冲突。
- `ctx.uiWorkspace.startSession(workspaceId?, options?)`：可带 `agentPreset`；`ctx.uiWorkspace.openSession(sessionId)` 打开既有会话。
- `sidebar.session.row.trailing`：会话行尾部插槽，可用于「主」标记。

**限制**：宿主没有「会话类型」对话框，也没有「把某个 preset 固定为进程唯一」的 API。因此入口做成**动作**而非**类型选择器**：选「主会话」= 打开/聚焦既有主会话；选「普通会话」= 宿主默认新建。

### 2.2 会话内 tab

- `conversation.view`：`kind: 'list'`，会话级；注册后宿主的 ViewTab 由 `{id,label}` 投影，正文由 slot entry 渲染。已有 `ui-chat`、`ui-trajectory` 两个第三方视图先例。
- 视图组件能读到当前 `sessionId`；据此只对 `masterId` 渲染体系内容，其他会话显示一句说明或不显示。

**限制**：tab 属于「会话」，不是「主面板」；不能把现有主面板原样嵌进去，需要复用它的数据/组件而不是整个入口。

### 2.3 右侧栏事件页

- `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title`：按会话注册；`ctx.sidebarRightTabs.register(definition)`。
- `ctx.sidebarRight.openTab(kind, options)`、`openTabIn`、`close/closeIn`、`toggleExpanded`、`focus`、`float`、`dock`。
- 关闭、展开、浮动都是宿主提供的交互，插件不需要自建抽屉。

**限制**：右侧栏是会话级的；不能做一个跨会话全局事件栏。事件栏跟随主会话即可满足「主会话页内看体系」。

### 2.4 推送

- `ctx.webServer.register({kind:'exact', path, handler})`；handler 直接持有 `ServerResponse`，可保持连接写 `text/event-stream`。路由匹配是 exact 先于 prefix，现有 `/orchestrator` prefix 不会截走。
- 现有的同源/回环校验在管理路由入口；SSE 路由同样需要 loopback + `Origin`/Host 校验。

**结论**：SSE 可行；首版不引入新依赖，复用轮询即可，SSE 作为 S-07 增量。

### 2.5 不可用或不应使用的能力

- 没有宿主级「会话类型」元数据或弹窗；不要把「主会话」塞进 `agentPreset`（单例槽位冲突）。
- 不要为主会话再 `startSession`：会得到第二个 router 会话，破坏单例与通知预算。
- 右侧栏不是全局的；不要为此改宿主布局。
- 宿主 alpha 类型在仓库 devDependencies（`0.2.1-alpha.2`）与运行版本（`0.2.1-rc.5`）之间可能有差异；所有 slot 名称以运行包为准，升级时用 `tests/packaging.spec.ts` 类似的守卫做核验。

### 2.6 回退方案

| 能力失效时 | 回退 |
| --- | --- |
| `conversation.hero.options` 不可用 | 侧栏会话行「主」标记 + 主面板顶部「打开主会话」按钮 |
| `conversation.view` 不可用 | 保留独立主面板；主会话页内只放一个跳转按钮 |
| `sidebar.right.pane.tab` 不可用 | 在「体系」视图内用右侧分栏自绘事件列表（仍可关闭/展开） |
| SSE 不可用 | `GET activity?after=` 5 秒轮询；断线重连后按 `after` 补拉 |
| 主会话已存在于旧工作目录 | 不强行迁移；保留原 cwd，新建的主会话才用新根（DSH 会话持久化 cwd） |

---

## 3. 设计

### 3.1 一进程一体系：目录分级

```text
<stateDir>/                       # 进程状态：库、锁、worker-bin、git 配置
  orchestrator.sqlite
  system/                         # 体系根 = 主会话工作目录
    work/                         # 默认工单根
      <ticket-short-name>/        # 每个 worker 自己的工作目录
```

- 主会话工作目录固定为 `<stateDir>/system`，启动时创建（0700）。
- 默认工单根从 `<stateDir>/work` 改为 `<stateDir>/system/work`；设置里显式填写的根仍然覆盖它。
- 已有工单的 `execution.directory` 是**记录值**，不迁移、不改写；升级后旧工单继续在原目录工作。
- 目录分级只表达「体系 → 工单」的归属，**不是安全边界**；worker 仍以操作者身份运行，设置页文案保留这一说明。

### 3.2 主会话入口

1. 启动时确保主会话存在（已有逻辑），并把它作为「体系入口」。
2. `conversation.hero.options` 注册一项「主会话」：点击 `ctx.uiWorkspace.openSession(masterId)`；若主会话尚未就绪，先显示禁用态。
3. `sidebar.session.row.trailing` 在主会话行显示「主」标记，普通会话不显示。
4. 主面板保留「打开主会话」按钮，作为宿主 slot 失效时的回退。
5. 「普通会话」不新增入口，沿用宿主 New Session；插件不干预普通会话的 preset。

### 3.3 主会话页内「体系」视图

- `conversation.view` 注册 `{id:'system', label:{zh:'体系',en:'System'}}`。
- 内容分三块：运行健康（Overview）、工单列表（复用 `GET tickets` 的紧凑行）、最近事件（`GET activity?level=feed`）。
- 只读；写操作仍然回到既有主面板/设置页，避免两套交互。
- 视图只在 `sessionId === masterId` 时渲染；其他会话显示「这是普通会话，体系视图只在主会话可用」。
- 实现上抽一个 `SystemView` 组件，主面板与页内视图共用数据 hooks，不复制业务规则。

### 3.4 右侧「事件」栏

- 注册 `sidebar.right.pane.tab`：`{id:'system-events', label:{zh:'事件',en:'Events'}}`。
- 标题插槽显示未读数（`notice` 级事件中未读的条数），打开后清零并持久化 `lastSeenSeq`。
- 首次收到 `notice` 级事件时自动打开一次；之后由用户关闭/展开，宿主记住面板状态。
- 列表按 `seq` 倒序，显示时间、级别、摘要、工单链接；点击条目打开对应工单（`openTicket` 或面板路由）。
- 加载：首屏 `GET activity?level=feed&limit=50`；轮询 `?after=<latest>&level=feed`；SSE 升级时同一协议。

### 3.5 事件分级（本 PR 已实现）

所有领域事件都入 `activity` 表，级别只决定「是否打扰人」，不决定是否记录：

| 级别 | 事件 | 行为 |
| --- | --- | --- |
| `quiet` | `eval.started`、`assignment.started/ended`、`trigger.followup`、`policy.changed` | 只入库；系统视图默认不显示 |
| `feed` | `trigger.received`、`decision.recorded`、`ticket.created`、`ticket.resumed` | 进事件栏，不通知 |
| `notice` | `trigger.requeued`、`thread.unsubscribed`；以及**未被报告覆盖**的 `ticket.ended` | 进事件栏并通知主会话 |

存储：`activity(seq, at, level, event, ticket, thread, value)`，`seq` 单调递增，作为增量游标；保留最近 5,000 条。
读取：`GET /orchestrator/api/activity?after=&limit=&level=`，返回 `{items, latest}`，倒序；`level=feed` 表示 feed 及以上，不含 quiet。

### 3.6 单一通知预算（本 PR 已实现）

现状是同一结果可能打扰两次：`reportRelay` 先发 `worker_report`（ready），`eventNotice` 再发 `ticket_ended`。
预算规则：**一个结果只通知一次**。

- `reportRelay` 是主通道：`ready` / `dropped` / `blocked` / `failed` 的报告仍然即时 relay。
- `ticket.ended` 在以下情况降级为 `feed`、不发 notice：
  - 最新报告已经是终态 `ready` 或 `dropped`（报告已经说清结果）；
  - 结束是 `by: 'human'`（人自己按的停止，不需要再被告知）。
- 其余结束仍是 `notice`：工作中被外部关闭、PR 合并/关闭、`blocked`/`failed` 之后才结束等。
- `attention` 问题不受预算影响；它是「需要人回答」，不是结果重复。
- 预算按**结果**去重，不设时间窗速率限制；如果后续仍出现噪声，再在 `ActivityLog` 上加每工单令牌桶，而不是扩大本 PR 范围。

### 3.7 与现有报告/通知的关系

```text
worker report ──► reportRelay ──► main Session（主通道，一条结果一条）
domain event ──► ActivityLog（全部入库）
                  └─ eventNotice（仅未被报告覆盖的 notice）──► main Session
```

`eventNotice` 仍然负责 `trigger.requeued`、`thread.unsubscribed`（人改订阅/重新入队）；这些不是报告能覆盖的结果。
`host.quiet()`（主会话自己发起的动作）仍然抑制 notice，但不抑制入库。

---

## 4. 任务分解

| 编号 | 内容 | 人日 | 状态 |
| --- | --- | --- | --- |
| S-01 | 事件分级 + `activity` 表（schema 13）+ `GET activity` + 测试 | 1.5 | **本 PR 完成** |
| S-02 | 单一通知预算：`endCoveredBy` 接入 `eventNotice`，更新报告相关测试 | 0.5 | **本 PR 完成** |
| S-03 | 目录分级：`systemRoot`、默认 `<stateDir>/system/work`、启动创建、设置文案/文档 | 1 | **本 PR 完成** |
| S-04 | 主会话入口：hero option + 会话行标记 + `openSession` + 回退按钮 | 2 | 待排期 |
| S-05 | 页内「体系」视图：`conversation.view`、仅主会话、复用数据 hooks | 3 | 待排期 |
| S-06 | 右侧「事件」栏：tab + 未读标题 + 轮询 + 自动打开一次 | 3 | 待排期 |
| S-07 | SSE 推送：exact 路由、`Last-Event-ID` 补拉、心跳、同源校验 | 1.5 | 待排期 |
| S-08 | 端到端与宿主版本矩阵：slot 存在性守卫、截图/演示、操作手册 | 2 | 待排期 |

**合计 14.5 人日**。S-01…S-03 与宿主界面解耦，先落地；S-04…S-08 依赖宿主 slot，按 DSH 版本做守卫。

---

## 5. 验收

1. **入口**：从 New Session 选「主会话」打开的是既有 `masterId`；连续点两次不产生第二个 router 会话；普通会话仍可正常新建。
2. **页内视图**：主会话有「体系」tab，能看到健康/工单/最近事件；普通会话没有该内容或显示说明。
3. **右侧栏**：主会话右侧出现「事件」tab，可关闭、可展开；新 `notice` 事件使未读数 +1；打开后清零。
4. **推送**：轮询模式下 5 秒内可见新事件；断线后按 `after` 补拉不漏；SSE 模式同样。
5. **目录**：新装默认主会话 cwd 为 `<stateDir>/system`，新工单目录为 `<stateDir>/system/work/<name>`；已有工单目录不变；显式根覆盖生效。
6. **通知预算**：`ready` 报告后只收到一条结果通知；`ticket_ended` 出现在事件栏；`blocked` 后外部关闭仍收到结束通知。
7. **回归**：`pnpm typecheck`、全量 `vitest`、`pnpm build`、`pnpm size` 全绿；schema 12 库可打开并升到 13。

---

## 6. 风险

| 风险 | 影响 | 回退/缓解 |
| --- | --- | --- |
| 宿主 slot 在升级后改名 | 入口/侧栏消失 | 启动守卫检测 slot 缺失，保留主面板入口并记录健康项 |
| 主会话已存在旧 cwd | 升级后目录仍是 `stateDir` | 不迁移；文档说明，新建进程或重建主会话才用新根 |
| 事件表增长 | 磁盘 | 保留 5,000 条；后续改为按天保留 |
| 通知预算误杀 | 人漏看结束 | 只抑制 `ready`/`dropped`/`human`；`blocked`/`failed` 后结束仍通知；事件栏始终有记录 |
| 两套入口并存 | 信息架构分裂 | 主面板保留为管理后台，主会话页内视图只读；S-08 统一文案与跳转 |
| 宿主版本漂移 | alpha 类型不兼容 | CI 加 slot 存在性断言；以运行包类型为准 |

---

## 7. 本 PR 落地范围

- `packages/dsh/src/app/activity.ts`：`gradeEvent`、`endCoveredBy`、`ActivityLog`、`activityFeed`。
- `packages/dsh/src/app/store.ts`：schema 13 的 `activity` 表、`Store.activity`、保留窗口。
- `packages/dsh/src/app/assembly.ts`：emit 时入库；`eventNotice` 用预算。
- `packages/dsh/src/app/http.ts`、`api.ts`：`GET activity`。
- `packages/dsh/src/app/execution-environment.ts`、`runtime.ts`：`systemRoot`、主会话 cwd、默认工单根。
- `tests/activity.spec.ts` 与报告/目录/迁移相关断言。
- 本文与 `TASK-PLAN.zh.md` §10.2、`docs/003`、`docs/006`、`docs/007`。