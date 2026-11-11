# 022 DSH 上游扩展点请求：侧栏、设置、会话列表与通知（提案）

> **状态**：提案，未实现。本文只整理可提交给 DeepSeek Harness 上游的扩展点请求，不改业务代码，也不承诺宿主会接受。
>
> **基线**：DSH `0.2.1-rc.5`；工作树 `touch-agent/dsh-superagent` @ `e0e1336`。输入是 [021 界面设计修订](021-ux-redesign.zh.md) §8 与 [018 暴露级别](018-exposure-levels.zh.md) 的默认面规则。
>
> **方法**：逐项读 021/018 的判断，再对照 DSH 安装目录的类型定义与实现，区分「叠加式做不到」「只能整体替换」「现有能力已够」。**不把插件可做的事误报成宿主缺口，也不把「必须重写整个侧栏」说成「只差一个座位」。**

---

## 0. 一页结论

021 §8.3 有 6 条「不可行/部分可行」项。按本 ticket 的覆盖范围，另补「会话元数据命名与结束态归档」一项，共 7 个请求；跨设备未读、子任务换 profile 不属于 UI 扩展层，不单列为请求。核对结果并不平均：有的确实只能靠宿主，有的已经能做，有的只是「没有顺手的座位」。

| # | 请求 | 现状能力 | 缺口性质 | 优先级 | 叠加式能否达成 |
| --- | --- | --- | --- | --- | --- |
| 1 | 侧栏顶置主 Agent 卡与区块重排 | `sidebar.panellist` 行 + `sidebar` 单座替换 | 没有可叠加的顶部席位；只能整栏重写 | P1 | 否（整体替换可，但不合理） |
| 2 | 隐藏或归档宿主自动生成的会话行 | 改名、置顶、归档、打开都会；结束态可归档 | 没有可见性规则；运行中会话不可归档 | P1 | 否（结束态归档已可） |
| 3 | 工作区列表投影或过滤 | 宿主列表、搜索、分组、行操作完整 | 没有只读投影/过滤钩子；只能整块替换 | P1（完整替换）/ P2（过滤） | 否（整块替换可） |
| 4 | 设置外壳自定义页与分组 | 自定义页、设置项已可加 | 导航是扁平列表，无分组/图标 | P2 | 页面已可；分组否 |
| 5 | 全局通知层与一级入口 | `shell.overlay` 浮层、面板行、图标内角标 | 没有宿主级未读/原生导航；跨设备未读是服务端 | P2 | 用户可见行为已可；原生集成否 |
| 6 | 主菜单项顺序与命名 | 插件面板行支持 `order`/`label` | 宿主固定项不可改名/排序/隐藏 | P1（目标四项）/ P2（接受插件行） | 否（整栏替换可） |
| 7 | 会话元数据命名与结束态归档 | 改名、归档、行前装饰、行菜单都会 | 无行尾状态位、无宿主共享元数据字段 | P2 | 已可；共享元数据否 |

**真正的阻塞点只有三类：**

1. **A 类，叠加式完全做不到**：在宿主固定项之间插入内容、隐藏/重排宿主导航项、隐藏运行中的执行会话、宿主原生未读徽标、替换设置外壳而不重写。
2. **B 类，只能整体替换**：主 Agent 大卡置顶、四项主菜单、自定义工作区列表、自定义设置外壳。DSH 的 `single` slot 允许低优先级占位者 shadow 现有占位者，所以「不做宿主改动」时理论上有路；但替换者必须重写整块区域，且原占位者声明的子座位会随它一起消失。这**不是**一个可以为了一个顶置卡而选择的方案。
3. **C 类，现有能力已够**：自定义设置页、通知浮层/抽屉、面板入口与图标内角标、会话改名/归档/置顶/打开、行菜单与行前装饰、用 `main` 面板承载任务视图。这些不应再向上游提请求，本文只给用法。

**建议提交顺序**：先提「`sidebar.top` 顶置席」与「会话可见性规则」两个小口；工作区列表座和导航覆盖是较大的组合改动，单独提；设置分组、面板行徽标、会话行尾状态位作为「有更好」；跨设备未读不放进 UI 扩展请求。

---

## 1. 核对方法与证据口径

本文的「能做/不能做」以 DSH `0.2.1-rc.5` 的实际类型和实现为准，不以 021 的转述为准。核对覆盖：

- 侧栏：`sidebar`、`sidebar.brand.mark/name`、`sidebar.panellist`、`sidebar.workspaces`、`sidebar.settings`、`sidebar.footer.action`、`sidebar.toggle.badge`。
- 布局：`main`、`shell.overlay`、`shell.bottom`、`shell.leading`、`ctx.layout.selectPanel()`。
- 工作区：`UiWorkspace`、`IWorkspaces`、`WorkspaceBrowser` 的行座位与行操作座位。
- 设置：`settings.section`、`settings.general.item`、`SettingsSectionRow`、设置外壳的导航实现。
- 会话：`SessionSummary`、`ISessions.using()`、`session.rename()`、`uiWorkspace.archiveSession()`。
- 替换语义：`single` slot 的 shadowing、`list` 的 `id + priority`、`keyed` 的 `key + priority`，以及「声明即认领」。

证据路径相对 DSH 安装目录 `@deepseek-ai/dsh/`。本机验证路径为
`/Users/steven/.nvm/versions/node/v24.16.0/lib/node_modules/@deepseek-ai/dsh/`。
`@deepseek-ai/dsh-client-ui-slots` 是同版本的依赖包；本文引用其注册语义时以包名和字段名为准。

| 证据 | 关键字段 / 行为 |
| --- | --- |
| `node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts` | `sidebar.panellist` 是 `list`，owner 只有 `size`/`active`；`sidebar.workspaces`、`sidebar.settings` 是 `single`；`sidebar.toggle.badge` 只在收起态渲染；`SidebarPanelMetadata { id, order, label }` |
| `node_modules/@deepseek-ai/dsh-client-ui-sidebar/lib/client.js` | `SidebarRoot` 的固定顺序：品牌 → New Session → `sidebar.panellist` → `sidebar.workspaces` → footer/`sidebar.settings`；`panels.filter(({ id }) => id === 'plugins' || !unpinned.includes(id))` 使 Plugins 行始终存在 |
| `node_modules/@deepseek-ai/dsh-client-ui-layout/lib/types/client/index.d.ts` | `sidebar` 是 `single`，注册即替换整列，且「the seats it declares disappear with it」；`main` 是 `keyed`；`shell.overlay` 是 `list`、frame-wide、click-through |
| `node_modules/@deepseek-ai/dsh-client-ui-layout/lib/types/client/service.d.ts` | `ctx.layout.selectPanel(id)`、`panelInfo`；可选择 `main` 面板，不能改宿主侧栏组合 |
| `node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/types/client/contract/slots.d.ts` | `sidebar.workspaces` 由 ui-sidebar 声明、ui-workspace 占用，owner 只有 `wide`/`expandSidebar`；行菜单与行操作是 `sidebar.workspaces.session.menu.item` / `sidebar.workspaces.session.row.action`；`sidebar.session.row.leading` 只在 idle 行挂载，live 状态点会替代它，归档行留空；`hover` 是悬停卡 |
| `node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/types/client/navigation.d.ts` | `UiWorkspace.openSession/startSession/archiveSession/unarchiveSession/pinSession/unpinSession`；没有过滤/投影方法 |
| `node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/types/client/service.d.ts` | `IWorkspaces.create/rename/delete/insertBefore/archiveSession/unarchiveSession/pinSession`；`WorkspaceView { workspaceId, path, title, sessionIds, createdAt, updatedAt }` |
| `node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/service.d.ts` | `SessionSummary { id, title, displayTitle, cwd, parentId, origin, running, blank, updatedAt, projectionValues }` |
| `node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/contract/session.d.ts` | `session.rename(title)`；显式标题会固定，避免自动重命名 |
| `node_modules/@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts` | `settings.section` 是 `list`，选项 `id/order/label`；`settings.general.item` 是 `list` |
| `node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/types/client/shell-contract.d.ts` | `SettingsSectionRow { id, order, label }`；没有 group/icon 字段 |
| `node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js` | 导航 `rows.map(...)` 扁平渲染；`navIcon(id)` 对 `account/models/agent-presets/plugins/archived-sessions` 硬编码，其余回退齿轮图标 |
| `node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` | `conversation.hero.options` 是 `list`，只有带 Session 时渲染；`conversation.session.header.utilities` 是 `list` |
| `node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/types/client/registry.d.ts` | `root` 注释说明：single slot 的第二个注册会 shadow 现有项，动态注册可拿到更低 priority；这也是所有 single slot 的替换语义 |
| `@deepseek-ai/dsh-client-ui-slots@0.2.1-rc.5` 的 `lib/types/index.d.ts` | `KindOptions` 的 `priority` 是 cell shadowing rank（升序、默认 0、最低者渲染；同 key/id + 同 priority 抛错）；`register` 的 `children` 声明即认领 |
| `node_modules/@deepseek-ai/dsh-client-ui-workspace/README.zh.md` | 归档行默认隐藏；subagent 来源的 Session 保持隐藏；运行中会话归档被 `workspace/session-active` 拒绝；行操作可按 `order` 追加、按 `priority` shadow |
| `packages/dsh/src/client/index.tsx` | 当前插件已用 `main`、`sidebar.panellist`（order 10）、`conversation.session.header.utilities`，并在 16px 图标内画 `dt-nav-badge` |
| `PLUGIN-PACKAGING.zh.md` §4.2 | 同一结论：`sidebar.panellist` 没有 badge 子槽，插件只能在 SVG 里画点 |

**关于「整体替换」**：`single` slot 是一个 cell，`priority` 是 cell shadowing rank（升序，默认 0，最低者渲染；同 key 同 priority 抛错）。用更低的 priority 可以 shadow 现有占位者。对 `sidebar` 来说，这会让 ui-sidebar 及其声明的 `sidebar.workspaces`、`sidebar.settings` 等子座位一起不再渲染（`ui-layout` 合同原文：the seats it declares disappear with it）。对 `sidebar.workspaces` 这类子座位，原占位者声明的行座位也不会随新占位者自动复用；新占位者要么重写，要么受「声明即认领」限制。所以「插件能不能替换整栏/整块」的答案是**能**；「替换后还能不能复用宿主的工作区/设置/面板」的答案是**不能，除非整套重写**。本文把前者记为「可」，把后者记为「不可接受的工程路径」，避免把两件事混成一句「需宿主」。

---

## 2. 逐项请求

### 2.1 侧栏顶置主 Agent 卡与区块重排

**现状能力**

- `sidebar.panellist` 可以在全局面板区加一行，支持 `id`、`order`、`label` 和自定义图标；owner props 只有 `{ size, active }`。插件可以用 16px 图标画角标。
- `sidebar.brand.mark` / `sidebar.brand.name` 是 `single`，`sidebar.footer.action` 是 `list`；它们分别只能换品牌标记/名字、在 Settings 旁加动作。
- 侧栏结构由 ui-sidebar 固定：品牌、New Session、全局面板行、工作区/会话区、Settings。插件行只能在插件行之间排序，不能到 New Session 之上，也不能改宿主行的顺序或删宿主行。
- `sidebar` 本身是 `single`。插件可以在更低 priority 上 shadow 整个 ui-sidebar，自己渲染一列；但原占位者声明的子座位随之消失，必须自己重写 New Session、工作区、Settings 和面板列表。
- 当前插件的主 Agent 入口用的是 `sidebar.panellist` 行（`MasterEntry`）加 `conversation.hero.options` 入口；没有用 `pinSession`，视觉上不是原型里的大卡。

**缺口**

没有「品牌之下、New Session 之上」的可叠加席位；没有富行（副标题、角色、状态点、40px 头像）；没有宿主导航项的隐藏/重排覆盖。一个顶置卡的需求被迫升级成「重写整栏」，这是 021 说「需宿主」的真实含义。

**建议接口**

新增一个可叠加的顶部 list 席位，先解决卡，不碰宿主导航：

```ts
// ui-sidebar 声明；SidebarRoot 在 brand 与 New Session 之间渲染
'sidebar.top': {
  kind: 'list'
  scope: 'root'
  owner: { wide: boolean }
}
```

- 条目按 `order` 排序；空列表不占高度。
- owner 只给 `wide`，卡片自己的名字、角色、状态、头像由插件渲染；宿主不解释内容。
- 可选扩展 `sidebar.panellist` 的条目元数据：`badge?: { count?: number; dot?: boolean; label: string }`，宿主在展开/收起态渲染可访问的角标。这是「面板行也能带可读角标」的小口，不是大卡。

**最小可用与后续**

- **MVP**：只加 `sidebar.top`，插件把主 Agent 卡放进去；New Session/工作区/Settings 保持原样。
- **后续**：如果产品坚持四项主菜单，再单独提 `sidebar.nav` 覆盖（见 2.6）；不要和顶置卡绑成一个请求。
- 不建议用 `sidebar` 整栏替换来实现一张卡：它会把 ui-workspace、ui-settings 一起拿走，维护成本高于收益。

**宿主影响与兼容风险**

- 新增 list 席位是低风险：不注册就不渲染，旧插件不受影响；无数据/授权变化。
- owner 只有 `wide` 的代价是：卡片不能读 `collapsed`；需要收起态精简时再扩 owner，不要在 MVP 里加。
- 若同时加 `badge` 元数据，宿主必须处理 0/99+/无文字、收起轨道和屏幕阅读器；不要只画一个视觉点。

**回退**

插件停止注册 `sidebar.top` 即回到当前布局；没有持久化状态。`badge` 缺省即不渲染。

**优先级与阻塞**

- **P1**。不是「完全做不到」：整栏替换可做；但为了一个卡重写整栏不可接受。
- 没有它，主 Agent 只能用面板行 + 图标 + hero 入口的降级形态；行为成立，视觉弱于 021 目标。

**不改宿主的降级**

`sidebar.panellist` 行（label「小助 · 主 Agent」+ 头像图标）+ `conversation.hero.options` 入口 +（可选）`pinSession` + `sidebar.session.row.leading` 标记 + 可选的 `conversation.session.header.utilities` 入口。这正是当前 `MasterEntry`/`MasterBadge` 的路径（当前插件没有用 `pinSession`，也没有 header 入口）。

**对 021 的核对**

021 §8.3 第 1 条说「需宿主新增 sidebar 席位或替换组合」——方向正确；但读者容易理解成「插件完全做不到」。应改为「无可叠加的顶部席位；整栏替换可做但会丢失宿主组合，不建议」。021 §4.6 已经写了降级形态，保留。

---

### 2.2 隐藏或归档宿主自动生成的会话行

**现状能力**

- 会话可以改名、置顶、取消置顶、归档、取消归档、打开：`ctx.uiWorkspace` 暴露 `openSession`、`archiveSession`、`unarchiveSession`、`pinSession`、`unpinSession`；`IWorkspaces` 也暴露归档/置顶。
- 归档行默认从工作区列表隐藏；运行中的 Session 归档会被 `workspace/session-active` 拒绝，返回的 `activity` 说明还有什么在跑。带 `stopActivity: true` 会先请求停止再归档，这是「停止并归档」，不是「隐藏」。
- subagent 来源的 Session 已经由 ui-workspace 隐藏；这不是本请求要解决的。
- 行前/悬停有 `sidebar.session.row.leading` / `sidebar.session.row.hover`；注意 `leading` 只在行的主状态为 idle 时挂载，有 pending interaction 或 live activity 时会被状态点替代，归档行留空；`hover` 是悬停卡内容。行菜单和行操作有 `sidebar.workspaces.session.menu.item` / `.row.action`，都是 `list`，可以按 `order` 追加、按 `priority` shadow 内置项。
- `SessionSummary` 已带 `origin`、`parentId`、`running`、`blank`、`title`、`displayTitle`、`cwd`，足够做规则判断。

**缺口**

- 没有「可见性/呈现级别」钩子。插件不能把运行中的执行会话从默认列表降为折叠区或隐藏，除非整块替换 `sidebar.workspaces`。
- 归档是「移出列表 + 全局归档集合」，不是「隐藏但仍可寻址」；对运行中会话还会被拒绝。把归档当隐藏用，会改变数据状态，且不能用于正在执行的工作。
- 没有按来源/类型/任务归组的过滤规则；搜索、计数、hover、键盘导航都是宿主内部逻辑，插件无法只改列表。

**建议接口**

新增一个**只读的呈现规则**，不改数据：

```ts
// 客户端服务，注册到 ui-workspace 或 ctx.uiWorkspace 的扩展面
ctx.uiWorkspace.registerSessionPresentationRule({
  id: 'superagent.execution-sessions',
  order?: number,
  decide(session: SessionSummary):
    | 'primary'       // 默认面，当前行为
    | 'secondary'     // 折叠/次区，仍可见、可打开
    | 'hidden'        // 仅限非运行中；仍可寻址
    | undefined       // 不表态，交给下一条规则
})
```

约束建议：

- `hidden` 只允许 `session.running === false`；运行中的会话只能用 `secondary`。这与 018「不能用隐藏掩盖正在执行的事实」一致。
- 规则按 `order` 升序取第一条有效表态；`undefined` 跳过。用户/部署级规则优先于插件默认，避免「后注册者静默覆盖」。
- 宿主在列表、计数、搜索结果、行 hover、键盘导航和深链接中统一应用；提供「显示已隐藏」入口，避免用户找不回会话。
- `hidden` 不是授权，不改变 Session 的访问控制；插件仍可通过 `openSession` 打开。

**最小可用与后续**

- **MVP**：`primary | secondary` 两档 + 对非运行中会话允许 `hidden`；先只作用于工作区列表，不改搜索分类。
- **后续**：搜索/最近区统一；宿主级「结束即归档」策略；事件钩子（session ended）让插件不必轮询 `running`。
- 如果产品只要求「归档已结束的执行会话」，**不需要新接口**：监听 `SessionSummary.running` 转为 false 后调用 `archiveSession` 即可；这是现有能力。

**宿主影响与兼容风险**

- 中风险：列表、计数、搜索、快捷键、aria 文案、深链接需要一致；规则冲突要有确定性。
- 安全边界：隐藏不是权限；运行中只允许 `secondary`，防止把正在跑的工作从视野里抹掉。
- 兼容：没有规则时完全保持现状；规则只存在客户端内存，不写 Host，不做 schema 迁移。

**回退**

取消注册即恢复全部行；`hidden` 不持久化，刷新即回到宿主默认。已经归档的会话仍走 `unarchiveSession` 恢复。

**优先级与阻塞**

- **P1**。运行中隐藏是 A 类（叠加式做不到）；结束态归档是 C 类（已可）。
- 没有它，当前降级是「归档已结束会话 + 改名 + 任务页里的『在任务中查看』链接」；运行中的会话仍会出现在宿主列表。

**不改宿主的降级**

归档已结束会话、给会话改可读标题、置顶当前主会话、在任务详情提供「在任务中查看」。不要用 CSS 或隐藏 DOM 的方式绕；那会破坏键盘、搜索和可访问性，也不解决运行中会话。

**对 021 的核对**

021 §8.3 第 3 条说「运行中的会话不能从宿主列表消失」——正确；「隐藏/过滤 API」缺失——正确。需要补一句：**已结束会话的归档已经可用**，所以「归档」不是缺口，「按规则隐藏/降级」才是。021 §8.3 第 3 条的「归档会话可恢复」应写成「已结束会话可归档并可恢复」。

---

### 2.3 工作区列表投影或过滤

**现状能力**

- 宿主列表有 Workspace 分组、搜索、分组/扁平视图、归档过滤、行菜单/行操作、目录选择、双击改名、新建会话等完整行为。
- `IWorkspaces` 可以创建、改名、删除、排序 Workspace；会话可以 `insertSessionBefore` 调整组内顺序、`pin` 置顶、`archive` 隐藏。
- `sidebar.workspaces` 是 `single`，由 ui-sidebar 声明、ui-workspace 占用；owner 只有 `wide`/`expandSidebar`。插件不能往里塞「一部分行」。

**缺口**

- 没有只读投影/过滤钩子。要做「工作区即任务视图」，要么把任务视图放进 `main`（已可），左侧宿主列表继续存在；要么整块替换 `sidebar.workspaces`，重写搜索、分组、归档过滤、行操作、目录流。
- 通过 `insertBefore`/`pin` 改变的是宿主持久顺序，不是展示投影；为了视觉分组去改用户的工作区顺序会污染数据。
- 没有「按任务/项目分组」的展示层；`WorkspaceView` 只有 `path/title/sessionIds`，没有业务分组字段。

**建议接口**

分两步，先小后大：

```ts
// 方案 A（较小，宿主重构）：把列表主体变成一个子座位，保留 shell 的头部/搜索/对话框/行操作
'sidebar.workspaces.list': {
  kind: 'single'
  scope: 'root'
  owner: {
    snapshot: WorkspaceSnapshot
    actions: Pick<IWorkspaces, 'create' | 'rename' | 'delete' | 'insertBefore' | 'archiveSession' | 'pinSession'>
    // 行身份、选中态、搜索词等仍由宿主给
  }
}
```

插件只渲染行；宿主管搜索、对话框、空态、归档恢复和可访问性。这比整块替换小，但仍需要宿主把 WorkspaceBrowser 拆开。

```ts
// 方案 B（更通用）：只读投影服务，不换渲染器
ctx.workspaceView.registerProjection({
  id: 'superagent.tasks',
  order?: number,
  project(input: {
    workspaces: readonly WorkspaceView[]
    sessions: Readonly<Record<SessionId, SessionSummary>>
    archived: ReadonlySet<SessionId>
    pinned: ReadonlySet<SessionId>
  }): {
    groups: readonly { id: string; title: string; sessionIds: readonly SessionId[] }[]
  } | undefined
})
```

- 投影只读：不改 Host registry，不改归档/置顶集合；宿主渲染仍负责行身份与操作。
- 多投影要有明确优先级和「用户选择」；不要让插件互相覆盖。
- 若产品只需要「过滤掉某些工作区/会话」，优先复用 2.2 的呈现规则，不必上投影。

**最小可用与后续**

- **MVP**：2.2 的呈现规则先解决过滤/降级；任务视图继续用 `main` 面板。
- **后续**：`sidebar.workspaces.list` 子座位；再往后才是通用投影服务。
- 不建议把「投影」做成新的全局状态源；它是读模型，不是第二套 Workspace。

**宿主影响与兼容风险**

- 高：WorkspaceBrowser 是宿主最复杂的列表之一，拆座要保留搜索、行操作、对话框、归档恢复、键盘和空态。
- 中：投影冲突、分组 id 稳定性、会话移动后的分组归属、无 workspace 的会话归属。
- 兼容：没有投影时保持宿主默认；投影不写数据，不改授权。

**回退**

停用投影/子座位即回宿主默认列表；不改 registry，因此没有数据回滚。

**优先级与阻塞**

- **P1**（「工作区完全降级为任务视图」）；单纯过滤是 **P2**。
- 没有它，任务视图可以作为 `main` 面板并设为默认，但宿主的工作区/会话列表仍在；用户仍可能被旧列表吸引。

**不改宿主的降级**

把任务面板设为 `main` 默认（`ctx.layout.selectPanel(id)`）；用现有 `pin`/`insertBefore` 只做必要排序；归档已结束会话；在任务面板提供「在任务中查看」；接受宿主列表并存。整块替换 `sidebar.workspaces` 是最后手段，不建议。

**对 021 的核对**

021 §8.3 第 4 条「工作区完全降级为任务视图」——正确，属 B 类；「插件可把任务面板设为默认，但宿主区域仍在」——正确。需要补：整块替换 `sidebar.workspaces` 技术上可做，但会失去搜索/分组/行操作，不能只写「需宿主」。

---

### 2.4 设置外壳自定义页与分组

**现状能力**

- `settings.section` 可以加独立页；选项是 `{ id, order, label }`，组件收到 `{ close }`。当前插件的「系统与运维」就是这样进的。
- `settings.general.item` 可以往「通用」页加设置行；`settings.launcher`/`trigger`/`header`/`action`/`close`/`onboarding` 也有座位。
- 设置导航由 `SettingsSectionRow { id, order, label }` 扁平排序渲染；`navIcon(id)` 只对 `account`、`models`、`agent-presets`、`plugins`、`archived-sessions` 有硬编码图标，其余是齿轮。
- `sidebar.settings` 是 `single`，由 ui-settings-general 占用；替换它会 shadow 整个设置外壳，包括触发行、弹窗和内置分区。

**缺口**

- 没有导航分组/标题；没有每个 section 的图标注册；没有隐藏/移除宿主分区的叠加方式；没有「只替换设置外壳的一部分」。
- 不能把「系统与运维」做成和其他分组并列的视觉分组；只能靠 `order` 排在一个扁平列表里。
- 整壳替换技术上可做，但会失去 account/models/plugins 等内置分区；这不是「加一个分组」的合理代价。

**建议接口**

先扩展现有 `settings.section`，不要换壳：

```ts
// 新增：分组表
'settings.group': {
  kind: 'list'
  scope: 'root'
  // options: id, order, label
}

// 扩展 settings.section 选项（宿主合并类型；缺省保持扁平）
{
  name: 'settings.section'
  id: 'ops'
  order: 30
  label: ...
  group?: string        // 指向 settings.group 的 id；缺省不分组
}
```

- 组按 `order` 排序；组内 section 再按 `order` 排序；未分组的 section 保持现有扁平位置。
- 可选 `settings.section.icon` **keyed** 座位（key = section id，组件返回图标）；缺省用现有齿轮。这样不把 React 组件塞进 options。
- 不提供「删除宿主分区」的叠加 API；如果以后要隐藏，应作为显式的用户设置/部署配置，而不是插件默认可做。

**最小可用与后续**

- **MVP**：`group` 字段 + 组标题；一个「系统与运维」分组；页面本身仍然用 `settings.section`。
- **后续**：`settings.section.icon`；组的折叠/锚点；设置搜索（更后面）。
- 不需要替换 `sidebar.settings` 外壳；当前插件只加页，已经满足「运维进设置」。

**宿主影响与兼容风险**

- 低到中：导航布局、组顺序、无组时的位置、a11y 标题层级、键盘焦点。
- 兼容：无 `group` 的旧注册仍扁平；无图标仍齿轮；不改变设置状态存储。
- 冲突：多个插件用同一个组 id 时，宿主应以 `settings.group` 的注册为准；组不存在时 section 回退为未分组，不报错。

**回退**

去掉 `group`/图标注册即回扁平列表；没有数据迁移。

**优先级与阻塞**

- **P2**。「自定义页」已经可做；分组是视觉增强，不阻塞运维页落地。
- 021 §8.3 第 6 条说「设置弹窗整体替换/删分区需宿主」——对「删分区」正确；对「加页」不成立，因为 `settings.section` 已足够。应把请求收窄为「分组/图标」。

**不改宿主的降级**

一个「系统与运维」section，内部用 tab/分段/锚点组织来源健康、触发、队列、审计、部署；当前 `SystemView` 就是这样。视觉上不是左侧分组，但行为完整。

---

### 2.5 全局通知层与一级入口

**现状能力**

- `shell.overlay` 是 frame-wide 的 `list`，在所有列之上、列滚动容器之外；条目自己决定是否接收指针事件（默认 click-through）。插件可以用它做右侧浮层、抽屉、toast，不需要宿主通知中心。
- `sidebar.panellist` 可以加一个通知面板入口；`conversation.session.header.utilities` 可以放铃铛；`sidebar.toggle.badge` 可以在收起态承载不可交互角标。
- 面板行 owner 只有 `{ size, active }`，所以当前插件把未读数字画在 16px SVG 图标里（`dt-nav-badge`）；收起态可用 `sidebar.toggle.badge`。
- 没有宿主级通知中心、未读集合、跨设备同步；`settings` 里的通知/未读是插件自己的本地状态。

**缺口**

- 没有宿主渲染的面板行徽标/未读元数据；插件要自己保证图标内数字的可读性和 a11y。
- 没有共享通知收件箱；多个插件各做一套浮层/抽屉，样式和行为会漂移。
- 跨设备未读不是 UI 扩展点：需要服务端账户状态和同步协议，不能靠 slot 解决。

**建议接口**

- **MVP（小口）**：扩展 `sidebar.panellist` 条目元数据：

```ts
{
  id: 'dsh-superagent-notifications'
  order: 30
  label: ...
  badge?: {
    count?: number      // 0/缺省不显示
    dot?: boolean       // 只显示圆点
    label: string       // 屏幕阅读器文案，例如「3 条待处理」
  }
}
```

宿主在展开行和收起轨道渲染一致的角标；`count` 超过上限用 `99+`，但 `label` 给完整语义。插件不再需要在 SVG 里挤数字。

- **可选后续**：如果出现第二个插件需要同一收件箱，再提 `ctx.notifications`（未读集合、markRead、订阅）；只有一个消费者时，插件自有 store 更简单。
- **不提交**：跨设备未读、系统级通知；那是服务端/桌面壳能力，不是 Web 客户端 slot。

**最小可用与后续**

- **MVP**：`shell.overlay` + `sidebar.panellist` + 图标内角标 + 头部入口，当前插件用右侧 Events tab、面板行图标角标和行前 `MasterBadge` 已能覆盖通知回看；overlay 是可加的浮层升级，不是必需。
- **后续**：共享通知服务；桌面系统通知（如果宿主提供）。
- 通知规则（哪些弹、哪些只进抽屉）属于产品/插件，不是宿主 slot。

**宿主影响与兼容风险**

- 低：badge 元数据是纯展示；缺省不渲染；不会改变现有点击行为。
- 中：共享通知服务要定义已读/未读的生命周期、跨标签页一致性和权限；不建议在没有第二个消费者时先做。
- 跨设备：涉及账户、隐私、冲突合并；不要混进「加一个 nav 入口」的请求。

**回退**

不传 `badge` 即回图标内绘制；停用 overlay 条目即回无浮层。没有持久化。

**优先级与阻塞**

- **P2**。用户可见的通知入口、浮层、抽屉、回看都已经能做；缺的是原生一致性和跨设备，不是「完全没有」。
- 021 §8.3 第 5 条「全局原生通知/一级导航」把三件事混在一起：原生 nav（没有）、插件通知中心（有）、跨设备（服务端）。应拆开写。

**不改宿主的降级**

面板行「通知」+ 头部入口 + 右侧 Events tab + 行前 `MasterBadge` + 图标内未读点；当前 `EventsTab`、`AttentionDot`、`MasterBadge` 即此形态；`shell.overlay` 可在需要浮层/抽屉时再加。

---

### 2.6 主菜单项顺序与命名

**现状能力**

- `sidebar.panellist` 的条目支持 `id`、`order`、`label`；`order` 只在插件面板之间排序。New Session 固定在面板列表之上，Plugins 行固定存在（`id === 'plugins'` 永不被过滤），工作区区域在面板列表之下，Settings 固定在底部。
- `sidebar.panellist.actions` 可以往「更多」菜单加动作；面板行自身有内存态的 `unpinned` 隐藏（插件重载后恢复），Plugins 行不受影响。这是用户级显示状态，不是插件改名/重排 API。
- 没有统一的宿主导航项模型，也没有 `hidden`/`label override`。

**缺口**

- 不能改宿主固定项的名称/顺序，不能隐藏 New Session、Plugins、工作区区域、Settings；不能做 021 的「任务/通知/文件/设置」四项主菜单。
- 插件面板行可以在其他插件行之间排序，但不能排到 New Session 之上；`sidebar.top` 只解决顶置卡，不解决宿主行删除。

**建议接口**

分两层：

```ts
// 方案 A（推荐，增量）：导航覆盖 list；宿主为每个固定项定义稳定 id
'sidebar.nav.override': {
  kind: 'list'
  scope: 'root'
  // options: target: 'new-session' | 'plugins' | 'workspaces' | 'settings' | panel id
  //          order?: number
  //          label?: SlotLabel
  //          hidden?: boolean
}
```

- 宿主先渲染默认导航，再应用覆盖；用户显式设置优先于插件默认；`hidden` 不能把 New Session 和 Settings 同时藏掉，至少保留一个新建/设置入口。
- 覆盖只影响显示，不改变 `startSession`/`openSettings` 等行为；键盘快捷键仍然有效。
- 这比让插件整栏替换小得多，但仍是宿主组合改动。

```ts
// 方案 B（不推荐，但存在）：注册 sidebar single，priority 更低，整栏自绘
```

- 技术上可做；代价是失去 ui-workspace/ui-settings 及其子座位，必须重写。只适合「完全自定义的产品壳」，不适合普通插件。

**最小可用与后续**

- **MVP**：不新增 API；插件面板行用 `order`/`label`；接受 New Session/工作区仍存在。
- **后续**：`sidebar.nav.override`；先只支持 label/order，再讨论 hidden。
- 如果只想要「任务、通知、文件」三个插件行，当前能力已经够；不要为了「四项」去整栏替换。

**宿主影响与兼容风险**

- 中到高：导航是产品骨架，改名/隐藏会影响可发现性、快捷键、首次使用和帮助文档；必须有用户可见的恢复路径。
- 冲突：多个插件对同一 target 覆盖时，宿主需要确定性优先级；用户配置应最高。
- 兼容：无覆盖时完全现状；不改变授权和会话行为。

**回退**

删除覆盖即回默认导航；用户设置可一键恢复；不写数据。

**优先级与阻塞**

- **P1**（如果产品坚持四项主菜单）；**P2**（接受插件行 + 宿主固定项）。
- 没有它，主 Agent/任务/文件/通知可以作为插件行出现，但「新会话/工作区」仍在；这是 021 已经写明的降级。

**不改宿主的降级**

插件行排在前面 + 隐藏「更多」里不需要的自有面板 + 用 `sidebar.top` 放主 Agent 卡 + 快捷键/hero 入口弱化 New Session。不要用 CSS 隐藏宿主行；不可访问且随宿主结构变化。

**对 021 的核对**

021 §8.3 第 2 条「移除新会话/插件行/工作区」——叠加式正确；整栏替换可做但会失去宿主组合。021 的目标四项主菜单属 B 类，不应写成「加一个 API 就行」。

---

### 2.7 会话元数据命名与结束态归档

**现状能力**

- 会话有 `title`（持久标题）和 `displayTitle`（回退到项目名/ID）；`session.rename(title)` 是显式用户标题，会固定住，避免自动重命名；UI 里双击行标题或行菜单「重命名」走同一能力。
- `archiveSession(sessionId)` 把会话放入全局归档集合，默认从工作区列表隐藏；`unarchiveSession` 恢复；运行中会话被拒绝，除非 `stopActivity: true`（停止并归档）。
- `SessionSummary` 有 `origin`、`parentId`、`running`、`blank`、`cwd`、`projectionValues`；插件可以据此在行前/悬停座位渲染状态，或在行菜单里加动作。
- 没有宿主共享的自定义元数据字段；没有行尾状态位（`sidebar.session.row.trailing` 不存在）；没有「结束即归档」的宿主策略。

**缺口**

- 不能给会话加宿主可见的角色/任务/状态元数据并跨插件共享；只能插件本地存，刷新/换设备不保证。
- 不能在行尾放状态/徽标；`leading` 只在空闲行有意义，且会被宿主状态点替代；没有通用的行尾座位。
- 没有结束事件/自动归档策略；插件可以轮询 `running` 后调用归档，但那是插件逻辑，不是宿主保证。
- 这些都不是「改名/归档做不到」；改名和归档已经是一等能力。

**建议接口**

- **MVP（小而稳）**：
  - 新增 `sidebar.session.row.trailing` list 座位（owner = 行身份），用于右对齐的状态点/角标；为空不占位。
  - 自定义元数据放插件自己的 store（SQLite/设置），以 `sessionId` 关联；展示用 trailing/leading；不要求宿主 schema。
  - 结束态归档用现有 `archiveSession`：监听 `SessionSummary.running` 转 false 后归档；明确只归档本插件负责的执行会话，避免误归档用户主会话。
- **可选后续**：
  - 如果元数据必须跨插件/跨设备共享，再提 `SessionSummary.labels?: Readonly<Record<string, string>>` 的宿主字段 + Host 持久化；这涉及 schema/迁移/隐私，优先级低于 trailing 座位。
  - 宿主级 `session.archiveOnEnd` 配置/事件；在出现第二个消费者前不必做。

**最小可用与后续**

- **MVP**：trailing 座位 + 插件本地元数据 + 现有归档。
- **后续**：共享 labels、结束事件、归档策略；仍然不改授权。
- 不要为了「显示一个角色标签」去重建 Session 实体或新增第二套身份。

**宿主影响与兼容风险**

- trailing 座位：低；空列表不渲染，旧插件无感；注意行高和窄栏溢出。
- labels：中到高；schema、迁移、同步、隐私、删除语义；不要和 UI 请求捆绑。
- 自动归档：中；必须避免把用户主动打开的会话或主会话归档；需要白名单/归属判断。

**回退**

停止注册 trailing、清空插件元数据、停止自动归档；宿主数据不受影响。已归档会话可用 `unarchiveSession` 恢复。

**优先级与阻塞**

- **P2**。改名、归档、打开、行菜单、行前装饰都已可用；缺的是共享元数据和行尾状态位，不影响主流程。
- 跨设备未读、子任务换 profile 不是 §8.3 的 UI 席位请求；前者是服务端账户/同步，后者是 016 Phase 2 的领域能力，本文不提交。

**不改宿主的降级**

用 `title` 做可读命名（例如「[任务] …」）、用 `leading` 画小状态点、用行菜单加「在任务中查看」「归档」、把业务状态放在任务页；不建第二套会话元数据。

---

## 3. 现有扩展点已足够的部分（用法）

下面这些**不需要**向上游提请求；它们是 021 的实现路径，也是评审时防止「虚报缺口」的基线。

| 需求 | 现有扩展点 | 用法 |
| --- | --- | --- |
| 任务/文件主面板 | `main` keyed + `sidebar.panellist` | 在 `main` 注册 `id` 面板；在 `sidebar.panellist` 注册同 id 的行；`ctx.layout.selectPanel(id)` 可切默认 |
| 设置里的运维页 | `settings.section` | `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'ops', order: 30, label: ... }, OpsPage))` |
| 设置项 | `settings.general.item` | 往「通用」页加行；不必新页面 |
| 右侧浮层/抽屉/toast | `shell.overlay` | list 条目自绘；默认 click-through，需要交互的条目自行接管 pointer events |
| 通知入口 | `sidebar.panellist` + `conversation.session.header.utilities` | 面板行 + 头部铃铛；未读数字画在图标内，收起态用 `sidebar.toggle.badge` |
| 打开/改名/归档/置顶会话 | `ctx.uiWorkspace` + `ctx.sessions.using` | `openSession`；`using(id, {source}, ref => ref.binding.session.rename(title))`；`archiveSession`/`unarchiveSession`/`pinSession`/`unpinSession` |
| 行菜单/行操作 | `sidebar.workspaces.session.menu.item` / `.row.action` | 按 `order` 追加；复用内置 id 并用 `priority` shadow 可替换内置项 |
| 行前/悬停装饰 | `sidebar.session.row.leading` / `.hover` | 空闲行的来源标记；有 live 活动/待交互时宿主用状态点替代，归档行不渲染；不要把它当稳定的状态位 |
| 会话空态入口 | `conversation.hero.options` | 只在有 Session 时渲染；空白 New Session 不出现，需配合 hero 其他座位或 panel 行 |
| 整栏自定义 | `sidebar` single | 更低 priority 可 shadow；会失去 ui-sidebar 声明的子座位，需整套重写；不作为常规方案 |

一个最小注册示例（与当前插件的写法一致）：

```ts
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: () => t('panel'),
  }, PanelIcon))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'ops',
    order: 30,
    label: () => t('ops'),
  }, OpsPage))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
  }, Toasts))
}
```

**能力探测**：新席位不要靠版本号猜；用 `ctx.slots.spec('sidebar.top')` 是否存在来判断宿主是否声明，缺省就跳过注册。这样同一个插件包可以同时装在新旧宿主上。

---

## 4. 对 021 §8 的逐条核对

前 6 行逐条对应 021 §8.3；第 7、8 行是 021 §8.4/其他段落提到的非 UI 扩展项，列在这里是为了说明为何不提交。

| # | 021 原判断 | 核对结论 | 需要修正的表述 |
| --- | --- | --- | --- |
| 1 | 主 Agent 大卡置顶、副标题/状态点、在「新会话」上方：需宿主新增席/替换组合 | **成立，但「做不到」要拆**。没有叠加席位；整栏替换可做，代价是重写整栏 | 改成「无叠加席位；整栏替换可但不建议」，不要写成「插件完全做不到」 |
| 2 | 移除「新会话」、固定「插件」行：需宿主组合调整 | **叠加式成立**；`sidebar` single 替换可做但丢组合；Plugins 行在 `panels.filter` 里被强制保留 | 补「整栏替换可，但会失去宿主组合」；不要笼统写「插件不能」 |
| 3 | 隐藏运行中执行会话、移除/重排工作区/会话列表：需宿主 API | **基本成立**。归档已结束会话、改名、置顶、排序已有；运行中归档被拒；叠加式隐藏/过滤没有 | 补「结束态归档已可」；把「归档」和「隐藏」分开 |
| 4 | 工作区完全降级为任务视图：需替换 workspace region | **成立**。`main` 面板可设为默认，但宿主列表仍在；整块替换 `sidebar.workspaces` 可做，代价大 | 补「整块替换可，但会失去搜索/分组/行操作」 |
| 5 | 全局原生通知/一级导航：宿主没有原生 nav/通知中心 | **过度合并**。浮层/抽屉/面板入口/图标内角标都可做；缺的是原生 nav、宿主 badge 和跨设备 | 拆成「插件通知中心已可」「原生 nav/未读缺失」「跨设备是服务端」 |
| 6 | 设置弹窗整体替换/删除宿主分区：需宿主设置外壳 | **一半成立**。加页已可（`settings.section`）；分组/图标/整壳替换才是缺口 | 把请求收窄为「分组 + 图标」，不要写「插件只加页」当缺陷 |
| 7 | 跨设备未读同步：需服务端 | **成立，但不属于 UI 扩展请求**。这是账户/服务端同步，不是 slot | 从本文/上游 UI 请求中移出，单独做产品/服务端决策 |
| 8 | 每个子任务自由换 profile：016 Phase 2 | **成立，但不属于 UI 扩展请求**。这是领域能力收紧，不是界面座位 | 留在 016 的 Phase 2，不进本文 |

补充一条 018 的约束：018 要求默认面只放 E0/E1，运行中的事实不能被隐藏掩盖。本文的呈现规则因此把运行中会话限制在 `secondary`，不允许 `hidden`；这是 2.2 的安全边界，不是宿主实现细节。

---

## 5. 优先级与提交建议

| 顺序 | 请求 | 类型 | 为什么先/后 |
| --- | --- | --- | --- |
| 1 | `sidebar.top` 顶置席 | 新增 list slot | 最小、可独立验收；直接解掉主 Agent 卡的位置问题 |
| 2 | 会话呈现规则 `primary/secondary/hidden` | 新增客户端服务 | 解决「执行会话出现在宿主列表」；有明确安全边界 |
| 3 | `sidebar.workspaces.list` 子座位 | 宿主重构 | 工作区降级为任务视图的关键；比整块替换可控 |
| 4 | `settings.group` + `settings.section.icon` | 扩展 list | 纯增强；自定义页已经可用 |
| 5 | `sidebar.panellist` badge 元数据 | 扩展 list | 小口；不做也能用图标内角标 |
| 6 | `sidebar.session.row.trailing` | 新增 list | 小口；不做也能用 leading/行菜单 |
| 7 | `sidebar.nav.override` 或 manifest 侧栏配置 | 宿主组合 | 只在产品坚持四项主菜单时提；风险最高 |
| — | 跨设备未读、子任务 profile | 非 UI 扩展 | 单独走服务端/016 Phase 2，不混入 |

**提交方式建议**：一个 umbrella issue 放本文的 7 节和验收口径，每个 P1 单独开子 issue；每个子 issue 都带「现状能力 / 缺口 / 接口草案 / MVP / 回退 / 兼容风险」。不要把一个 500 行的提案直接当 issue 正文；本文是设计记录，issue 只摘该子项。

**验收口径（对上游）**：

- 新增席位在未注册时零布局/零行为变化；旧插件包不升级也能装。
- 新 API 不写 Host 数据、不改授权；隐藏/呈现规则默认不启用。
- 同一目标的多个注册有确定性优先级；用户配置高于插件默认。
- 运行中会话不能被 `hidden` 抹掉；至少保留 `secondary` 或明确「停止并归档」。
- 设置分组缺省回退扁平；面板 badge 缺省回退无 badge。

---

## 6. 回退与兼容总表

| 请求 | 缺省/回退 | 数据影响 | 兼容风险 |
| --- | --- | --- | --- |
| `sidebar.top` | 不注册不渲染 | 无 | 低；需确认空列表不占高度 |
| 会话呈现规则 | 无规则 = 现状 | 只读；不写归档/授权 | 中；搜索/计数/键盘一致性 |
| `sidebar.workspaces.list` | 无占用 = 宿主默认 | 不写 registry | 高；行身份/操作/对话框 |
| `settings.group`/icon | 无 group = 扁平；无 icon = 齿轮 | 无 | 低；组 id 冲突回退 |
| `sidebar.panellist` badge | 无 badge = 图标内绘制 | 无 | 低；a11y/窄栏 |
| `sidebar.session.row.trailing` | 空 = 不占位 | 无 | 低；行高/溢出 |
| `sidebar.nav.override` | 无覆盖 = 默认导航 | 显示层；不改行为 | 高；可发现性/快捷键/恢复路径 |
| 跨设备未读 | 不做 | 需要服务端 | 不在本文 |

所有请求都不新增数据库 schema、不改变 Ticket/Mandate/Approval/Acceptance 语义；唯一的「数据」风险是 2.7 的可选 `labels`，本文不把它放进 MVP。

---

## 7. 未决问题（留给上游/产品）

1. **导航覆盖的归属**：应该是插件 manifest 声明，还是用户在设置里配置？本文建议「插件只给默认，用户配置最高」；否则多个插件会争同一菜单。
2. **运行中会话能不能 `hidden`**：本文建议不能，只能 `secondary`；如果上游认为可以，需要产品明确「隐藏不等于停止」的提示和恢复入口。
3. **工作区投影的冲突模型**：只允许一个投影生效，还是多个投影按 order 合并？本文倾向前者 + 用户选择，避免不可解释的列表。
4. **共享通知服务是否值得**：只有一个插件时，本地 store + overlay 足够；出现第二个消费者再提。
5. **新席位的版本策略**：当前客户端 manifest 有 `manifestVersion`；新增可选 slot 不需要改它，但宿主应提供能力探测（`ctx.slots.spec`）和 `engines.dsh` 兼容声明。
6. **可访问性**：badge、组标题、隐藏会话的恢复入口需要与现有键盘/读屏路径一起验收，不能只在视觉上成立。

---

## 8. 证据附录

### 8.1 侧栏顺序与固定项

`dsh-client-ui-sidebar/lib/client.js` 的 `SidebarRoot` 渲染顺序为：品牌行 → New Session 按钮 → `sidebar.panellist` 的 `nav` → `sidebar.workspaces` 区域 → footer/`sidebar.settings`。面板行过滤条件是：

```js
panels.filter(({ id }) => id === 'plugins' || !unpinned.includes(id))
```

因此 Plugins 行始终存在，且位于 New Session 之后；`sidebar.panellist` 的 `order` 只在插件面板之间生效。

### 8.2 面板行 owner 与徽标

`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts` 中：

```ts
'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
```

`SidebarPanelIconOwnerProps` 只有 `size` 和 `active`；`SidebarPanelMetadata` 只有 `id`、`order`、`label`。没有 badge/description/avatar 字段。`sidebar.toggle.badge` 则明确是「Non-interactive notification inside the collapsed sidebar expand button」，只在收起态。

### 8.3 single slot 的替换语义

`dsh-client-ui-layout/lib/types/client/index.d.ts` 对 `sidebar` 的注释：

> OCCUPIED by ui-sidebar's SidebarRoot ... registering here replaces the navigation column outright rather than adding to it, and the seats it declares disappear with it.

`dsh-client-ui-renderer/lib/types/client/registry.d.ts` 对 `root` 的注释进一步说明：single slot 的第二个注册会 shadow 现有项，动态注册拿到更低 priority 时会成为 winner。对 `sidebar`、`sidebar.workspaces`、`sidebar.settings` 都适用；`list`/`keyed` 则用 `id`/`key` + `priority` 逐项 shadow。

`@deepseek-ai/dsh-client-ui-slots@0.2.1-rc.5` 的 `lib/types/index.d.ts` 给出同一规则的通用定义：非 chain 的 `priority` 是 cell shadowing rank，升序、默认 0、最低者渲染；同一个 `id`/`key` 在相同 priority 上重复注册会抛错；`children` 一经声明就由该条目独占渲染权。

### 8.4 工作区与会话

`dsh-client-ui-workspace/lib/types/client/navigation.d.ts` 暴露：

```ts
openSession(target): void
archiveSession(sessionId, options?: { stopActivity?: boolean }): Promise<void>
unarchiveSession(sessionId): Promise<void>
pinSession(sessionId): Promise<void>
unpinSession(sessionId): Promise<void>
```

`dsh-api-workspace-controller/lib/types/client/service.d.ts` 的 `IWorkspaces` 还提供 `insertBefore`、`archiveSession`、`pinSession`；`WorkspaceView` 只有 `workspaceId/path/title/sessionIds/createdAt/updatedAt`，没有业务分组字段。`workspace/session-active` 是运行中归档被拒绝的错误码，`details.activity` 列出仍在运行的内容。

### 8.5 设置导航

`dsh-client-ui-settings-general/lib/client.js`：

- 导航行来自 `ctx.slots.entries('settings.section')`，映射为 `{ id, order, label }` 后 `sort((a, b) => a.order - b.order)`，然后 `rows.map(...)` 扁平渲染。
- `navIcon(id)` 对 `account`、`models`、`agent-presets`、`plugins`、`archived-sessions` 返回硬编码图标，其他 id 回退 `IconSettingsOutlineMedium`。
- 没有 group/heading 的渲染分支；`SettingsSectionRow` 也没有 group/icon 字段。

### 8.6 会话数据

`dsh-api-session-controller/lib/types/client/sessions/service.d.ts` 的 `SessionSummary` 已包含 `id`、`title`、`displayTitle`、`cwd`、`parentId`、`origin`、`formatStatus`、`running`、`retainedBy`、`blank`、`updatedAt`、`projectionValues`。`session.rename(title)` 在 `contract/session.d.ts` 中定义为「显式用户标题；pins it against automatic regeneration」。

### 8.7 当前插件的使用

`packages/dsh/src/client/index.tsx`：

- `inject = ['slots', 'locale', 'sessions', 'uiWorkspace']`；
- `sidebar.panellist` 注册 `order: 10`，`HammerIcon` 在 16px 图标内画 `dt-nav-badge`；
- `conversation.hero.options` 注册 `MasterEntry`；
- `sidebar.session.row.leading` 注册 `MasterBadge`（只在主会话行渲染）；
- `conversation.session.header.utilities` 注册的是不可见的 `EventsBridge`，没有可见铃铛；
- `main` 注册任务/管理面板；当前没有使用 `shell.overlay`，事件回看走右侧 `sidebar.right.pane.tab`；
- `openSession` 走 `ctx.uiWorkspace.openSession`。

这些是「C 类：现有能力已够」的实证，不是缺口。

### 8.8 验证命令

```sh
# 在 DSH 安装目录核对 slot 与字段
rg "sidebar\.(panellist|workspaces|settings|top)|settings\.section" \
  node_modules/@deepseek-ai/dsh-client-ui-*/lib/types/client

# 核对工作区/会话 API
rg "archiveSession|insertBefore|rename\(" \
  node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/types \
  node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/types \
  node_modules/@deepseek-ai/dsh-api-session-controller/lib/types
```

---

## 9. 结论

021 的目标形态没有错，但它把三类不同的事写在了一起：**已有能力**、**只能整体替换**、**叠加式确实缺**。本文的请求只针对第三类：

1. `sidebar.top`（顶置卡）与会话呈现规则是最小、最值得先提的两个；
2. `sidebar.workspaces.list` 和 `sidebar.nav.override` 是较大的组合改动，应单独评审；
3. 设置分组、面板行 badge、会话行尾状态位是「有更好」，不阻塞 021 Phase 1；
4. 跨设备未读、子任务换 profile 不属 UI 扩展点，不混入本请求。

在宿主给出这些座位之前，021 Phase 1 的插件内降级（面板行 + 图标角标 + `shell.overlay` + `settings.section` + `main` 任务面板 + 现有改名/归档）就是可交付形态，不应把它描述成「等宿主才能开始」。