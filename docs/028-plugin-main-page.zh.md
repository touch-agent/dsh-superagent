# 028 插件即主页面：点开即主对话

> 状态：已实现（2026-11-14），新增 `ux.appShell.v1`，默认开启；同日后续修正把四个页头入口改为宿主右侧栏独立页，主对话保持可见；再修正去掉侧栏页里重复的返回与分栏按钮。四项既有开关保留，任一项回退都不删记录、不改授权。
> 输入：[021 界面重构提案](021-ux-redesign.zh.md) 的主 Agent、四项导航、通知和任务方向，[026 第三批](026-ux-third-batch.zh.md) 已落地的卡/导航/浮层/文件页，以及工单“插件即主页面：整屏布局放进 Superagent”的后续修正：点击 Superagent 后应直接进入主对话；任务、通知、文件、设置从页头图标打开，并在右侧栏/浮窗显示，不再把主对话替换成状态页。
> 基线：`touch-agent/dsh-superagent` main `4388fa4`。本文的 After 截图来自本分支构建，Before 截图来自同一视口下的 main。

## 1. 路线修正

第一版把插件面板做成“应用外壳”：顶部主 Agent 卡，下面四个 tab，默认落在任务页。这个方向被推翻：它仍然是“插件里的另一套任务首页”，不是“点开 Superagent 就开始交代任务”。

修正后的目标是：

1. 点击 Superagent（或从设置上方的入口打开）后，看到的是**主对话**，不是任务列表。
2. 用户可以直接在主对话里交代任务、追问进展、看整体情况，或接收主 Agent 的主动汇报。
3. 任务、通知、文件、设置从主对话页头的四个图标进入，在宿主右侧栏的独立页里显示；主对话始终留在内容区。
4. 不改 DSH 上游、不改宿主 shell；宿主侧栏、工作区列表和宿主设置入口继续存在。

因此，**主对话是页面，插件面板只是进入它的桥和四个辅助页的容器**。插件不再自绘一套对话界面，也不把任务页伪装成首页。

## 2. 为什么不是插件内自绘对话

公开的 DSH 插件扩展点没有“把宿主 Conversation 嵌进插件面板”的席位。可选做法只有：

| 方案 | 问题 |
| --- | --- |
| 在插件面板里 iframe 宿主对话 | 同源可以绕，但会复制一套导航/焦点/快捷键，且宿主升级即碎；不做 |
| 用宿主 CSS 隐藏侧栏/页头，假装“只有 Superagent” | 改的是宿主 shell，违反“不改 shell”，也不稳定 |
| 让插件面板自己实现聊天 UI + 会话存储 | 第二套对话系统，重复宿主能力，偏离“复用主 Agent” |
| **打开宿主的现有主 Session（本路线）** | 主对话本身是宿主的；插件只负责入口和四个辅助页；宿主 chrome 仍可见，但这是公开扩展点能做到的最接近形态 |

因此“整个页面都变成 Superagent 的页面”在本路线中的准确含义是：**内容区变成主对话；插件不再用任务页占据内容区**。宿主左侧的插件/工作区列表、宿主页头和宿主设置入口不在插件控制范围内，文档不把它们写成已替换。

## 3. 交互

### 3.1 打开即主对话

- `ux.appShell.v1` 开启且 `ux.navFour.v1` 开启时，插件 `main` 面板挂载后立即调用 `openSession(state.masterId)`，打开**现有**主 Session；不新建 Session、不复制历史。
- 面板自身渲染一张很轻的过渡卡（“正在打开主对话”），成功后宿主切到主对话，卡消失。
- 如果主 Session 不在会话列表（归档、删除、状态目录换了），卡上说明原因，给出“重新打开主对话”和四个辅助页入口；不把错误变成空白。
- 自动打开每个主 Session 只尝试一次，避免重渲染时反复抢导航。

### 3.2 主对话页头的四个入口（右侧栏）

主 Session 的页头 utilities 里注册四个图标按钮：

| 图标 | 打开 | 角标 |
| --- | --- | --- |
| 任务 | 宿主右侧栏 › 任务页 | 待你处理数量 |
| 通知 | 宿主右侧栏 › 通知页 | 有未读活动时一个小圆点 |
| 文件 | 宿主右侧栏 › 文件页 | 无；`ux.filesPage.v1` 关闭时整个按钮不出现 |
| 设置 | 宿主右侧栏 › 设置页（显示组） | 无 |

按钮调用 `ctx.sidebarRight.openTab(kind)`，由宿主在右侧栏打开一个独立 tab。右侧栏可以停靠、拖宽、浮成独立窗口或关闭；这些行为由宿主负责，主对话内容列始终保留。插件页里隐藏宿主的“分栏”按钮：再开一列会把同一组辅助页重复展开，和“一页只承载一组辅助页”的交互冲突。插件不再调用 `openPanelRoute` 把主面板切到辅助页。

每个 tab 的内容是一个 embedded `App`，固定从该页开始：

- tab 内点任务详情、通知动作、文件所属任务或设置分组，只改这个 tab 自己的路由；主对话、页头和其他 tab 都不跳转。
- 进入嵌套页后只保留页面自己的返回（任务详情、Ticket 页的返回条）；侧栏外壳不再额外渲染“返回”，避免同一位置出现两个。关闭 tab 由宿主负责。
- 不同 tab 可以并排或浮动；未挂载的 tab 重新打开时回到该页初始路由，不恢复上次嵌套页。
- 右下浮动通知入口优先复用已挂载的抽屉；主对话里没有抽屉宿主时打开通知侧栏页，同样不切走主面板。

宿主没有右侧栏扩展点时，按钮退回插件面板的辅助页，并保留 3.3 的返回条；这是兼容回退，不是主路径。

### 3.3 辅助页、返回和持久化

- 四图标只注册在主 Session 的页头；进入其他会话时整个组不渲染，避免污染宿主的普通对话。
- 右侧栏 tab 没有插件面板的页头、搜索和四项导航，只有当前页内容；宿主 tab 已经提供标题、关闭、全屏、收起和浮动控件，插件页隐藏分栏按钮。
- 面板里的辅助页仍保留给没有右侧栏的宿主和直接链接：顶部有“‹ 返回主对话”，下面沿用四项导航。主路径不再经过它。
- 打开/关闭右侧栏 tab 不改变主面板当前页；再次点 Superagent 仍从主对话开始。
- 浏览器刷新回到主对话；右侧栏布局由宿主保存，但 tab 内容从初始页重新挂载，不恢复嵌套页。辅助页不是可收藏的 URL。

### 3.4 回退

- `ux.appShell.v1` 关闭：完全回到 026/第三批的“页头 + 居中列 + 任务页卡片”，不注册主对话页头四图标，也不自动跳主对话。
- `ux.navFour.v1` 关闭：`ux.appShell.v1` 随之失效，回到三入口布局。
- `ux.masterCard.v1` 关闭：只影响回退后的任务页卡片；主对话路线不依赖卡片。
- `ux.filesPage.v1` 关闭：文件按钮和文件页入口消失，其余三个入口保留。
- 所有开关只改客户端可见性；不删任务、通知、文件、审批或会话记录。

## 4. 与宿主边界

本路线**没有**做以下事情，也不把它们留成“待完成”：

- 删除或重排宿主的新会话、插件、工作区、会话行。
- 用插件页面替换宿主 workspace region，或让插件成为宿主默认主视图。
- 替换宿主页头、宿主设置弹窗、宿主原生通知中心。
- 隐藏宿主侧栏后宣称“用户只看见 Superagent”。
- 跨设备同步主 Agent 名字/头像。

这些都需要改宿主或上游；本路线明确只改插件，宿主 chrome 继续存在。

## 5. 代码落点

| 文件 | 作用 |
| --- | --- |
| `client/conversation-home.tsx` | 过渡卡（自动打开主 Session、失败重试）；主对话页头四图标，点击交给右侧栏 |
| `client/auxiliary.ts` | 四个辅助页的类型、初始路由和 tab id |
| `client/side-tabs.tsx` | 右侧栏 tab 的 embedded `App` 内容 |
| `client/panel.ts` | 首页/辅助页意图、路由记忆、`openPanelRoute` 选中面板（仅面板回退） |
| `client/app.tsx` | 首页与辅助页分流、侧栏模式（无面板页头/导航、返回交给页面自身）、关闭面板时重置意图 |
| `client/index.tsx` | 注册主对话四图标、四个 `sidebar.right.pane.tab` 类型与正文、`sidebarRight.openTab` 打开路径；`ux.appShell.v1` 开启时不注册 `conversation.hero.options` 的重复入口 |
| `client/tasks.tsx` | 保留第三批两列任务页；侧栏窄宽度下由 CSS 压成单列 |
| `client/global-notice.tsx` | 浮动通知入口优先开右侧栏通知页，没有侧栏时回退面板 |
| `client/locales.ts`、`client.css` | 文案、页头图标/角标、侧栏页与返回条、过渡卡样式 |
| `tests/panel-ux-conversation-home.spec.tsx` | 首页自动打开、辅助页返回、任务两列、外壳与四项导航回退 |
| `tests/client.spec.tsx` | 页头四图标打开四个右侧栏 kind；只注册一份四图标；非主 Session 不渲染；侧栏页无面板页头/搜索；下钻后不出现重复返回 |

## 6. 证据

两张证据表。第一张是“点开即主对话”的原始路线；第二张是同日后续修正“辅助页进右侧栏”。

**原始路线** Before：main `4388fa4`；After：本分支。

| 场景 | Before | After |
| --- | --- | --- |
| 点开 Superagent | [before-tasks.png](images/plugin-main-page/before-tasks.png)（任务页落地） | [after-conversation.png](images/plugin-main-page/after-conversation.png)（主对话 + 页头四图标） |
| 面板辅助页（回退路径） | [before-tasks.png](images/plugin-main-page/before-tasks.png) | [after-tasks.png](images/plugin-main-page/after-tasks.png)（带返回主对话） |
| 通知抽屉（任务页上） | [before-notifications.png](images/plugin-main-page/before-notifications.png) | [after-notifications-drawer.png](images/plugin-main-page/after-notifications-drawer.png)（同一浮层仍保留） |
| 设置页 | [before-settings.png](images/plugin-main-page/before-settings.png) | [after-settings.png](images/plugin-main-page/after-settings.png) |
| 设置·显示里的开关细节 | [before-settings-switches.png](images/plugin-main-page/before-settings-switches.png) | [after-settings-switches.png](images/plugin-main-page/after-settings-switches.png) |

**后续修正：点页头图标不再替换主对话** Before：`bbbe36e`（PR #83 合并点，点图标落到整页辅助页）；After：本分支（同一视口下的主对话 + 右侧栏页）。

| 场景 | Before `bbbe36e` | After 本分支 |
| --- | --- | --- |
| 任务 | [before-side-tasks.png](images/plugin-main-page/before-side-tasks.png) | [after-side-tasks.png](images/plugin-main-page/after-side-tasks.png) |
| 通知 | [before-side-notifications.png](images/plugin-main-page/before-side-notifications.png) | [after-side-notifications.png](images/plugin-main-page/after-side-notifications.png) |
| 文件 | [before-side-files.png](images/plugin-main-page/before-side-files.png) | [after-side-files.png](images/plugin-main-page/after-side-files.png) |
| 设置 | [before-side-settings.png](images/plugin-main-page/before-side-settings.png) | [after-side-settings.png](images/plugin-main-page/after-side-settings.png) |

**后续修正：去掉重复的返回与分栏入口** Before：`46e1089`（PR #84 合并点，侧栏页下钻后同时出现外壳“返回”和页面返回，右上角保留宿主“分栏”按钮）；After：本分支（同一视口、同一合成任务页）。

| 场景 | Before `46e1089` | After 本分支 |
| --- | --- | --- |
| 侧栏任务页下钻到 Ticket | [before-duplicate-actions.png](images/plugin-main-page/before-duplicate-actions.png)（两个“返回” + 分栏按钮） | [after-duplicate-actions.png](images/plugin-main-page/after-duplicate-actions.png)（只剩页面自己的“任务”返回，分栏按钮隐藏） |

截图来自真实运行中的 DSH + 本插件构建；Before/After 使用同一个合成任务“示例项目：整理上线清单”，不包含飞书私聊内容。After 的主对话是预览环境中的主 Session，仅用于展示入口位置。

## 7. 验证

- `pnpm typecheck`
- `env -u GIT_CONFIG_GLOBAL pnpm check`
- 重点：`pnpm vitest run tests/panel-ux-conversation-home.spec.tsx tests/client.spec.tsx tests/panel-ux-third-batch.spec.tsx`
- 实机：点 Superagent 自动进主对话；主对话页头出现任务/通知/文件/设置；四个入口各自在右侧栏打开独立页，主对话仍可见；在侧栏任务页进入详情后只在该 tab 内返回；普通会话不出现四图标；关闭 `ux.appShell.v1` 回到第三批布局。

## 8. 两个验收问题

1. **第一次用的人 10 秒内知道下一步吗？** 点开 Superagent 已经在主对话里，输入框就在眼前；需要看任务/通知时，页头四个图标是稳定入口。不需要先理解“插件”“工作区”“工单”这些词。
2. **是否假装拥有宿主能力？** 没有。主对话是宿主现有 Session，插件不伪造聊天；宿主侧栏/页头/设置可见，文档明确写为外部环境；没有隐藏宿主 chrome 后宣称整页属于插件。

## 9. 未做

- 把宿主侧栏、页头或设置替换成插件自己的版本：需要宿主扩展点，本路线不做。
- 插件内嵌宿主对话：公开 API 无此席位，不用 iframe/宿主 CSS hack。
- 移动端真机；只做了窄屏 CSS、右侧栏窄宽度 CSS 与面板测试。
