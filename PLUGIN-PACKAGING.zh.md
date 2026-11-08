# PLUGIN-PACKAGING — 以「一个独立插件」的形态装进 DSH

> 基线：`touch-agent/dsh-superagent` @ `0d9298c` · 宿主 DSH `^0.2.1-alpha.2`
> 配套：`PLATFORM-EVOLUTION.zh.md`（为什么）、`TASK-PLAN.zh.md`（做什么）、本文（怎么装进去）
> 状态：设计稿。标「待验证」的条目是读了宿主 CLI 与 asar 字符串后仍未实证的部分

---

## 0. 结论

**能，而且今天已经是这样了**——现有实现就是「一个 npm 包 = 一个 bundle + 4 个 Cordis 插件 + 一个浏览器半 + 2 个 agent preset」，入口是侧边栏图标 + 独立主面板 + 插件管理里的配置页。

需要加固的不是「能不能装」，而是三件事：

1. **包的切分**：现在是一个大包，kernel 已经抽出来了，但 runtime 与浏览器半、bundle 元数据还挤在同一个包；要按发布节奏拆成 3 个 + 1 个 meta 包。
2. **安装的可验证性**：`bundle.patch` 是「安装即生效」的唯一机制，但它对宿主 loader 行名的依赖没有任何测试兜底；换一个 DSH 版本就可能静默装不上。
3. **入口界面的信息架构**：现在是一个主面板 + 6 个 tab，是「管理后台」的心智；按方案 §5 的模型，人真正需要的是「待我处理 / 正在跑 / 历史」三区，其余应该退到二级。

---

## 1. 现状（实测，不是推测）

| 事实 | 证据 |
| --- | --- |
| 安装单位是 npm 包，bundle patch 声明在 manifest | `package.json` 的 `dsh.bundle.patch: ./cordis.patch.yml` |
| patch 插 6 行：主插件、GitHub 源、Feishu 源（默认 disabled）、飞书文档源（默认 disabled）、worker preset（order 90）、router preset（order 91） | `cordis.patch.yml` |
| 服务端是 4 个 Cordis 插件：主插件提供 `orchestrator` 服务（`inject` 11 个宿主服务）；三个 Source 插件 `inject ['orchestrator']` | `packages/dsh/src/index.ts`、`packages/dsh/src/sources/github.ts`、`packages/dsh/src/sources/feishu.ts`、`packages/dsh/src/sources/feishu-doc.ts` |
| 浏览器半是一个独立入口，通过 `__ModuleLoader__.load` 装配 | `lib/client.js` banner、`packages/dsh/src/client/index.tsx` |
| 入口 UI 已经占三个 slot：主面板 `main`、侧边栏图标 `sidebar.panellist`（order 10）、插件管理配置行 `plugins.row.config` | `packages/dsh/src/client/index.tsx:73-79` |
| 宿主 CLI 有一等的插件安装命令 | `dsh plugin --profile <name> add <pkg>`（转发 pnpm 到 profile 目录） |
| profile 是「有序的 bundle patch 层栈」，可 dump 出合成结果 | `dsh --help`：`--dump-config`、`--patch <path>` |

**结论**：形态是对的，缺的是「拆包 + 安装可验证 + 入口信息架构」。

---

## 2. 目标安装形态

用户视角只有三步：

```bash
# 1. 准备一个独立 profile（不影响 web profile）
dsh --from-default-profile web --profile work

# 2. 装插件（在 profile 目录里 pnpm add）
dsh plugin add dsh-superagent --profile work

# 3. 起
dsh --profile work
```

首次进面板 = Setup 引导（选 Sources、填账号、允许名单），已有实现。

**卸载 = 一条删除命令**，状态目录保留：

```bash
dsh plugin remove dsh-superagent --profile work
```

卸载后 `~/.dsh/state/superagent/orchestrator.sqlite` 仍在；重装即恢复。这是「研究原型」与「产品」都该有的语义：**数据比代码活得久**。

**唯一必须手写的配置**是 `stateDir`（绝对路径）。方案里它属于 profile 层，不归插件管——因为一个进程只能有一个状态目录，而 profile 是唯一知道「这台机器上装了几个实例」的地方。

---

## 3. 包切分：3 个包 + 1 个 meta

```
@superagent/kernel       领域库：无依赖，季度 semver
      ↑
@superagent/dsh          Cordis 宿主插件 + 浏览器半：跟宿主 alpha 走
      ↑
dsh-superagent           meta：bundle patch + 2 个 preset + locale
      ↑
（用户安装的就是它）
```

| 包 | 内容 | 依赖 | 发布节奏 | 现在的状态 |
| --- | --- | --- | --- | --- |
| `@superagent/kernel` | `packages/kernel/src/*`（engine/part/model/tickets/evals/assignments/intake/replies/stage/reasons/errors/ids/memory/ports） | 仅 `node:crypto` | 季度，破坏性变更走 major | **已存在**（提交 `3f7a158`） |
| `@superagent/dsh` | `packages/dsh/src/index.ts`（服务注册）、`packages/dsh/src/app/**`、`packages/dsh/src/client/**`、`packages/dsh/src/sources/**`、`packages/dsh/src/executor/**`、`packages/dsh/src/infra/**`，以及运行时要读的 `skills/`、`prompts/` | peer：`@deepseek-ai/dsh-*` alpha；dep：`@superagent/kernel`、`zod`、`proper-lockfile` | 双周，紧跟宿主 | **已拆出**（2026-11-07，`packages/dsh`） |
| `dsh-superagent`（meta） | `cordis.patch.yml`、`dsh.client` 段、两个 preset 的配置行、`locale/*.json`，以及四个 node 入口（`lib/index.js` 与三个 watch 入口的 re-export） | `@superagent/dsh` | 双周 | **已是仓库根包**（2026-11-07） |

**为什么 meta 不能省**：`bundle.patch` 只能由被安装的包自己声明（`dsh.bundle.patch`），preset 是「配置行」不是代码，locale 是包内资源。把这些塞进 runtime 包会让「改一个文案」也要发一次 runtime 版本。

**skills 与 prompts 随 runtime 走**：它们由 `packageRoot()` 在运行时从「正在执行的那个包」里读（`packages/dsh/src/infra/paths.ts`），放进 meta 会让运行时的根目录指向错误的位置；内容随行为变化，本来就该与 runtime 同版本。locale 留在 meta，改文案只发 meta。

**宿主 peer 依赖只声明一次**：声明在 runtime 上（它才是 `import` 的一方），由 pnpm 的 autoInstallPeers 随依赖安装；meta 不再重复这 23 行，装的是 meta、查的是 runtime 的 peer，`engines.dsh` 仍在 meta 上表达「这个 bundle 能装进哪版宿主」。

**什么时候把 `@superagent/source-kit` 单独拆出来**：出现第三个非官方 adapter 作者时。在此之前 manifest 类型与 conformance helper 放在 kernel 的 `manifest.ts` 与 `tests/conformance/` 就够——过早拆包会把「一次改两个包、跑两次 CI」变成日常。

**拆分动作已完成**（2026-11-07）：`src/`、`skills/`、`prompts/` 迁入 `packages/dsh`；根包保留 `dsh` 段与四个 exports（T1-08 又加 `feishu-doc-watch`），入口改为 `meta/*.ts` 的 re-export；tsconfig paths / vitest 插件 / tsdown resolveId 三处解析同步；`tests/layers.spec.ts` 的边界规则改为「按包名，不按相对路径」。决定 D7：**patch 行名与子路径不改**（`dsh-superagent`、`dsh-superagent/github-watch`、`dsh-superagent/feishu-watch`），所以已装 profile 不受影响。

---

## 4. 入口界面

### 4.1 已经占住的三个 slot

| slot | 用法 | 现在的样子 | 问题 |
| --- | --- | --- | --- |
| `main` | 全页面主面板（key = `dsh-superagent`） | 6 个 tab：Overview / Source / Trigger / Eval / Execution / Settings | 是「管理后台」心智，人每天要看的只有第一屏 |
| `sidebar.panellist` | 侧边栏图标（order 10） | 锤子图标 | 不知道「有没有事等我」 |
| `plugins.row.config` | 插件管理里的一行配置 | Sources / Eval / Execution / Prompts / Deployment 五组 | 与主面板 Settings 重复（栈一处即可，方案 §10.4 的债） |

### 4.2 建议的信息架构（M3 前完成）

主面板首页只留三区，其余降为二级页：

1. **待我处理**（`stage = person` 的工单）：`answer / review / blocked / failed / delivery` 五种动作，一行一条，点进去看 preview（M3 的 T3-07）。
2. **正在跑**（`working`）：工单、执行器、最近一条 trace 的当前段。
3. **最近历史**：按 `ticket.ended` 倒序，一条一行。

侧边栏图标上要能看出「有没有事」——这是 `sidebar.panellist` 是否支持角标的问题，**待验证**；若不支持，退而求其次：图标 order 提前 + 首页数字。

### 4.3 可选的三个更深入口（先不做，记下来）

| 入口 | 用途 | 前置 |
| --- | --- | --- |
| `sidebar.panellist.actions` | 侧边栏快捷动作（如「暂停派单」） | 待验证 slot 契约 |
| `conversation.*` 系列 | 在对话流里插工单卡片（点一下跳到面板） | 待验证；价值高但耦合宿主渲染 |
| `@deepseek-ai/dsh-client-ui-deliverables` | 复用宿主的交付物预览组件（M3 的 previewer） | 待验证 API；若可用能省 T3-02…04 的一半工作量 |

**取舍**：入口越深，越依赖宿主 API 的稳定性。alpha 期只做「主面板 + 侧边栏 + 配置行」三个已在用的 slot，其余等宿主 API 稳定后再加。

---

## 5. 安装、升级、卸载的边界

| 场景 | 行为 | 谁保证 |
| --- | --- | --- |
| 首次安装 | profile 加一条依赖；patch 插入 6 行；`stateDir` 由 profile 提供 | `bundle-patch.spec.ts` + `dsh --dump-config` |
| 缺 `stateDir` | 插件拒绝启动并说明原因 | `packages/dsh/src/index.ts` 的 machineOf 校验（已有） |
| 升级跨 schema | `SCHEMA_VERSION` 只增；旧库迁移或拒启 | `migration.ts`（已有，当前 11） |
| 升级跨宿主版本 | peer 依赖 + compat matrix；启动时校验必需服务是否都在 | 新增 X-10 |
| 卸载 | 插件行消失；stateDir 保留；重装恢复 | `scripts/install-e2e.mjs`（X-08，见 `docs/006-deployment.md` 的 Automated install/uninstall check） |
| 装两个实例 | 不允许：一个 stateDir 一个实例（单实例约束，方案 §11 已登记） | 由 stateDir 锁保证（`lockSync` 已有） |

**bundle patch 的隐含风险**：`insert` 行依赖宿主 loader 里的定位锚点。DSH alpha 每次升级都可能改锚点，改了就「装上了但没生效」——这是最坏的一种失败，因为没有报错。防线只有一条：`dsh --profile <tmp> --dump-config` 断言 6 行都在（X-11）。

---

## 6. 开发工作流

三种循环，按改动面选：

| 改什么 | 怎么跑 | 备注 |
| --- | --- | --- |
| kernel 或领域逻辑 | `./node_modules/.bin/vitest run` | 479 个领域测试 641ms，足够快 |
| 服务端（工具、HTTP、effects） | 真实 DSH profile + 真 stateDir | 本机 pnpm 需 `COREPACK_HOME=$PWD/.corepack`（见下） |
| 浏览器半（面板） | `pnpm run dev:web` 起宿主 web 构建，插件 client 靠 HMR | **只有这个模式下 client 改动免刷新**；否则要重新 `tsdown` 并刷新页面 |

**本机 pnpm 的真相**：pnpm 不是不存在，而是 corepack 的转发器——它要把 pnpm 解包到 `~/.cache/node/corepack`，而这个目录在 DSH 文件沙箱之外，写不进去才报 `EPERM`。把 `COREPACK_HOME` 指到工作区内即可（已实测能拉到 pnpm 11.7.0）：

```bash
COREPACK_HOME=$PWD/.corepack pnpm --version   # 11.7.0
COREPACK_HOME=$PWD/.corepack pnpm install     # store 也留在工作区内
```

`.corepack/` 与 `.pnpm-store/` 都不该进版本库。

---

## 7. 任务增补（挂到 TASK-PLAN §8 横向任务）

| ID | 任务 | 人日 | 与里程碑的关系 |
| --- | --- | --- | --- |
| X-07 | 包切分：`@superagent/dsh` + meta 包，kernel 保持不动 | 3 | M1 开始前完成，否则 M1 的 source-kit 落错包 |
| X-08 | 安装/卸载 E2E：临时 `DSH_HOME` + `dsh plugin add` + 起进程 + 面板可用 + 卸载后 stateDir 仍在 | 5 | M1 结束前 |
| X-09 | 入口首页三区（待我处理 / 正在跑 / 历史）+ 侧边栏角标（若宿主支持） | 5 | M3 前 |
| X-10 | 宿主兼容矩阵：CI 跑两个 alpha 版本，断言必需服务齐备 | 3 | 每个里程碑 |
| X-11 | `dump-config` 断言：patch 6 行齐全（防「装了没生效」） | 2 | 随 X-07 |

合计 +18 人日，M1 前需要先做 X-07、X-11（5 人日），因为它们决定后续所有代码落在哪个包里。

---

## 8. 待验证清单（不要当成已确认）

1. `sidebar.panellist` 是否支持角标/未读数——未验证。
2. `sidebar.panellist.actions` 的契约（能注册什么、作用域）——未验证。
3. `@deepseek-ai/dsh-client-ui-deliverables` 能否被第三方插件复用——未验证；若不能，T3-02…04 的工作量不变。
4. `bundle.patch` 的 `insert` 锚点在两个相邻 alpha 版本间是否稳定——需要 X-11 的实测数据。
5. `dsh plugin add` 是否会在 profile 的 patch 层里自动登记该 bundle——**已验证（X-08，2026-11-08）**：临时 `DSH_HOME` 中 `dsh plugin add "link:$PWD"` 会把包写进依赖与 `dsh.profile.bundles`，`dsh --dump-config` 合成 6 行；证据与限制见 `docs/006-deployment.md` 的 Automated install/uninstall check。