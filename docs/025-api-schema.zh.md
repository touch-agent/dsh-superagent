# 025 Management API 的单一 Schema

> 状态：已落地（X-04）。本文记录管理 API 为什么用 JSON Schema 作为作者源、三处如何从它派生、生成物的入库与过期检查，以及哪些边界**没有**被 schema 化。

## 问题

管理 API 原先在 `packages/dsh/src/app/api.ts` 里同时维护三份手写真相：路由表、每条路由的请求类型、面板调用的 `Api` 映射。实际路由是 **42 条**（`docs/plan/TASK-PLAN.zh.md` 里写的 25 条已过期）。新增或修改一条路由要改多处；运行时 zod schema 与面板类型各自演化，容易漂移；面板只能“相信”手写类型，无法从校验器反推。

X-04 的目标是把请求侧收敛成一份契约，同时保持现有请求/响应形状与错误语义不变，不借机改接口或业务逻辑。

## 选型

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| OpenAPI / 完整 response JSON Schema | 不选 | 响应类型已经由各 view 与 handler 的返回类型精确给出；再写一份 response schema 会把“返回什么”复制成第二真相，且 42 条路由的维护成本翻倍 |
| zod 作为作者源，再 `z.toJSONSchema()` 导出 | 不选 | 查询参数要保留“坏值回退默认、超限 clamp、未知键丢弃”的宽松语义，zod 的严格对象模型表达不了；把 JSON Schema 变成生成物也会让运行时校验与作者源分离 |
| Ajv / TypeBox | 不选 | 会新增一个运行期依赖与 bundle 体积；仓库已有 zod 4，`z.fromJSONSchema` 可以直接编译 JSON Schema |
| 提交生成的 TS 类型文件 | 不选 | 类型可以在编译期从 schema 推导，生成 TS 只会多一份需要过期的文件；只提交一份人可读的 JSON Schema 生成物 |
| **JSON Schema 子集作为作者源** | **选用** | 一种写法同时得到编译期类型、运行期校验器、路由键与面板类型；响应侧继续由 handler 返回类型负责 |

作者源是 `packages/dsh/src/app/api-contract.ts` 里的 `ROUTES`：普通对象字面量，键为 `METHOD path`，值为 `{ params?, query?, requiredQuery?, body?, public? }`。它只使用 JSON Schema 的一个小子集（`type`、`properties`、`required`、`enum`、`minimum`/`maximum`、`minLength`、`pattern`、`additionalProperties`、`default`），另加两个仓库自定义注解：`x-dsh-clamp` 仅用于列表 `limit` 的“超限截断”而不是“非法拒绝”，`x-dsh-strict` 仅用于保留旧解析器本就会拒绝的查询字段（`GET prompts` 的 `revision`/`offset`）。

## 三处如何同源

1. **路由表**：`ROUTES` 的键类型 `RouteKey` 同时约束 `http.ts` 的 handler 表（`satisfies { [K in RouteKey]: ... }`）与面板的 `Api`。漏一条 handler、或 handler 表多一条契约外的路由，`pnpm typecheck` 直接失败。
2. **类型**：`QueryInput`/`QueryOutput`/`BodyInput` 由 `json-schema-to-ts` 的 `FromSchema` 从同一份 schema 推导；`Api[K].response` 取 `Awaited<ReturnType<RouteHandlers[K]>>`，即 handler 的真实返回类型。面板的 `ApiRequest`/`ApiResponse` 只是这层映射的投影。
3. **运行期校验**：`packages/dsh/src/app/api-parser.ts` 用 `z.fromJSONSchema` 缓存编译每个 schema，再按既有语义解析 query、路径参数与 body。请求体保持惰性读取，因此“先查工单不存在返回 404、再解析 body”的顺序不变。

面板仍然只从 `app/api.ts` 取类型与过滤器常量；`api-filters.ts` 单独存在，使浏览器半不把整份契约打进 bundle。`http.ts` 从契约取 `RouteKey`/`RouteParams`，不再手写请求 schema。

## 请求语义保持不变

- **query**：数字/布尔按旧行为强制转换；坏数字、越界值回退到默认值；`limit` 超过上限按 `x-dsh-clamp` 截断；`x-dsh-strict` 标注的字段仍以 400 拒绝；未知键丢弃；`q` 等字段保留默认空串。
- **params**：逐字段校验；`block` 的 pattern 不匹配仍是 400，错误体仍是 `{ error, issues: [{ path, message }] }`。
- **body**：JSON 解析失败仍是 400 “The request body is not JSON”；schema 不匹配仍是 400，`issues[].path` 保留字段路径；业务层 `UserError`/`SetupError` 映射不变。
- **响应**：没有新增、删除或改名任何字段。类型推导反而修正了少数面板类型低估响应字段的问题（例如 settings 保存返回 `saved`/`policy_changed`/`context_delivery`），运行时返回形状本来就是这样。
- 业务逻辑、视图函数与错误码均未改动。

## 试点与铺开

验收切片选三种形态各一条：

- `GET tickets`：列表 query 的默认值、枚举回退与 `limit` clamp；
- `GET tickets/:id`：路径参数；
- `PUT settings/:block`：路径参数 pattern + body 的严格错误。

`tests/api-contract.spec.ts` 先固定这三类的编译期类型与运行期行为，再由“每条 `ROUTES` 都能被 handler 表服务”的循环覆盖全部 42 条。实现是一次替换，但测试保留了这个最小证明。

## 生成物与 CI

- 生成物：`packages/dsh/src/app/api.schema.json`，由 `scripts/api-schema.ts` 从 `ROUTES` 渲染，按 `METHOD path` 列出 params/query/body 槽位与 `x-public` 标记；响应形状明确不写入。
- 校验：`pnpm check:api` 重新渲染并与仓库内的文件逐字节比较，过期即失败；`pnpm check` 与 CI 的 `check` job 已包含这一步。修改契约后用 `node --experimental-transform-types scripts/check-api-schema.mjs --write` 刷新。
- 只提交 JSON，不提交生成的 TS：类型在编译期从契约推导，不存在第二份需要同步的类型文件。

## 测试

`tests/api-contract.spec.ts` 覆盖：

- `keyof RouteHandlers` 与 `RouteKey` 完全相等，且每个契约路由都能被实际路由表命中、契约外的路径返回 404；
- query 的宽松语义（默认、回退、clamp、未知键）；
- 非法 body 与非法路径参数仍返回 400 + `issues`；
- 面板请求类型确实从契约推导（未知枚举、错误类型、缺失必填字段在编译期被拒绝）；
- 提交的 JSON Schema 生成物与当前契约一致。

## 边界与回退

- 不把 response 写进 schema；响应类型的唯一真相是 handler 返回类型。
- `PUT settings/:block` 的 `value` 与 prompts 的两个 body 是业务层自己校验的不透明负载，契约只固定外层信封；它们的 TypeScript 类型在契约中做类型绑定，不重写形状。
- 回退：删除 `api-contract.ts`、`api-parser.ts`、`api-filters.ts`、`api.schema.json` 与检查脚本，恢复旧 `api.ts` 的手写表即可；没有数据迁移，也没有运行时状态。
