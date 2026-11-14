# 028 插件即主页面：点开即主对话

> 状态：已实现（2026-11-14），新增 `ux.appShell.v1`，默认开启；四项既有开关保留，任一项回退都不删记录、不改授权。
> 输入：[021 界面重构提案](021-ux-redesign.zh.md) 的主 Agent、四项导航、通知和任务方向，[026 第三批](026-ux-third-batch.zh.md) 已落地的卡/导航/浮层/文件页，以及工单“插件即主页面：整屏布局放进 Superagent”的后续修正：点击 Superagent 后应直接进入主对话，任务、通知、文件、设置改为对话页头图标或浮层入口。
> 基线：`touch-agent/dsh-superagent` main `4388fa4`。本文的 After 截图来自本分支构建，Before 截图来自同一视口下的 main。

## 1. 路线修正

第一版把插件面板做成“应用外壳”：顶部主 Agent 卡，下面四个 tab，默认落在任务页。这个方向被推翻：它仍然是“插件里的另一套任务首页”，不是“点开 Superagent 就开始交代任务”。

修正后的目标是：

1. 点击 Superagent（或从设置上方的入口打开）后，看到的是**主对话**，不是任务列表。
2. 用户可以直接在主对话里交代任务、追问进展、看整体情况，或接收主 Agent 的主动汇报。
3. 任务、通知、文件、设置从主对话页头的四个图标进入；打开后是辅助页，每页都有“返回主对话”。
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

### 3.2 主对话页头的四个入口

主 Session 的页头 utilities 里注册四个图标按钮：

| 图标 | 打开 | 角标 |
| --- | --- | --- |
| 任务 | 插件面板 › 任务页 | 待你处理数量 |
| 通知 | 插件面板 › 通知页 | 有未读活动时一个小圆点 |
| 文件 | 插件面板 › 文件页 | 无；`ux.filesPage.v1` 关闭时整个按钮不出现 |
| 设置 | 插件面板 › 设置页 | 无 |

这些按钮只注册在主 Session 的页头；进入其他会话时不显示，避免污染宿主的普通对话。按钮调用 `openPanelRoute`：记住目标页、选中插件面板；面板挂载时读到的意图是“辅助页”，不是“首页”，所以不会再自动跳回主对话。

### 3.3 辅助页与返回

辅助页沿用第三批的四项导航和内容区，但顶部多一条返回条：

```
‹ 返回主对话   任务、通知、文件和设置都在主对话页头的图标里。
Superagent
任务  通知  文件  设置
...
```

- “返回主对话”先清除“辅助页”意图并切回主页面；主页面自己的桥接再调用 `openSession(masterId)`，因此不会重复打开同一个 Session。回到主对话后，下一次点 Superagent 仍从主对话开始。
- 如果插件面板已经停在某个辅助页，再点一次左侧 Superagent 行，宿主不会重新挂载同一面板；请用页内的“返回主对话”。这是当前宿主面板 API 的限制，不影响从其他页面进入 Superagent 时直接落在主对话。
- 任一辅助页被直接链接打开、刷新或从通知里跳转，面板都保留返回条；直接链接不会把首页重新抢回去。
- 关闭面板或切到宿主其他会话时，插件把意图重置为“首页”；下次点 Superagent 还是主对话，而不是上次的辅助页。

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
| `client/conversation-home.tsx` | 过渡卡（自动打开主 Session、失败重试、四个辅助页入口）；主对话页头四图标 |
| `client/panel.ts` | 首页/辅助页意图、路由记忆、`openPanelRoute` 选中面板 |
| `client/app.tsx` | 首页与辅助页分流、返回条、关闭面板时重置意图 |
| `client/index.tsx` | 注册主对话 `conversation.session.header.utilities`；`ux.appShell.v1` 开启时不注册 `conversation.hero.options` 的重复入口 |
| `client/tasks.tsx` | 保留第三批两列任务页；从页头进入时仍显示“待你处理”摘要 |
| `client/locales.ts`、`client.css` | 文案、返回条、页头图标/角标、过渡卡样式 |
| `tests/panel-ux-conversation-home.spec.tsx` | 首页自动打开、辅助页返回、任务两列、外壳与四项导航回退 |
| `tests/client.spec.tsx` | 主对话页头只注册一份四图标，非主 Session 不渲染 |

## 6. 证据

Before：main `4388fa4`，1440×900，浅色，`zh-CN`，宿主侧栏 280px。Before 是旧路线“点开 Superagent 落在任务页”。
After：本分支构建，同一视口/主题/语言。

| 场景 | Before | After |
| --- | --- | --- |
| 点开 Superagent | [before-tasks.png](images/plugin-main-page/before-tasks.png)（任务页落地） | [after-conversation.png](images/plugin-main-page/after-conversation.png)（主对话 + 页头四图标） |
| 任务页 | [before-tasks.png](images/plugin-main-page/before-tasks.png) | [after-tasks.png](images/plugin-main-page/after-tasks.png)（带返回主对话） |
| 通知页 | [before-notifications.png](images/plugin-main-page/before-notifications.png) | [after-notifications.png](images/plugin-main-page/after-notifications.png) |
| 设置页 | [before-settings.png](images/plugin-main-page/before-settings.png) | [after-settings.png](images/plugin-main-page/after-settings.png) |
| 设置·显示里的开关细节 | [before-settings-switches.png](images/plugin-main-page/before-settings-switches.png) | [after-settings-switches.png](images/plugin-main-page/after-settings-switches.png) |

截图来自真实运行中的 DSH + 本插件构建；不包含飞书私聊内容。After 的主对话是预览环境中的主 Session，仅用于展示入口位置。

## 7. 验证

- `pnpm typecheck`
- `env -u GIT_CONFIG_GLOBAL pnpm check`
- 重点：`pnpm vitest run tests/panel-ux-conversation-home.spec.tsx tests/client.spec.tsx tests/panel-ux-third-batch.spec.tsx`
- 实机：点 Superagent 自动进主对话；主对话页头出现任务/通知/文件/设置；四个入口各自打开辅助页并显示返回条；返回后回到主对话；普通会话不出现四图标；关闭 `ux.appShell.v1` 回到第三批布局。

## 8. 两个验收问题

1. **第一次用的人 10 秒内知道下一步吗？** 点开 Superagent 已经在主对话里，输入框就在眼前；需要看任务/通知时，页头四个图标是稳定入口。不需要先理解“插件”“工作区”“工单”这些词。
2. **是否假装拥有宿主能力？** 没有。主对话是宿主现有 Session，插件不伪造聊天；宿主侧栏/页头/设置可见，文档明确写为外部环境；没有隐藏宿主 chrome 后宣称整页属于插件。

## 9. 未做

- 把宿主侧栏、页头或设置替换成插件自己的版本：需要宿主扩展点，本路线不做。
- 插件内嵌宿主对话：公开 API 无此席位，不用 iframe/宿主 CSS hack。
- 移动端真机；只做了窄屏 CSS 与面板测试。
