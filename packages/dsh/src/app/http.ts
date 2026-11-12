/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import type { BodyInput, QueryOutput, RouteKey, RouteParams } from './api-contract.ts'
import { parseBody, parseParams, parseQuery } from './api-parser.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion, type SettingsBlock } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '@superagent/kernel'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import { metrics } from './metrics.ts'
import { decideApproval, PANEL_ACTOR } from './approvals.ts'
import type { Outbox } from './outbox.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'
import { ticketTimeline } from './views/timeline.ts'
import { triggerTrace } from './views/trace.ts'
import { activityFeed, activityLookup } from './activity.ts'
import { taskBoard, taskDetail } from './tasks.ts'
import { goalBoard, goalDetail } from './goals.ts'
import { spaceRows } from './spaces.ts'
import { contextGroupBoard } from './context-groups.ts'
import type { SpaceLeases } from './spaces.ts'
import { ProfileConflict, type Profiles } from './profiles.ts'
import { profileMetrics } from './profile-metrics.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount' | 'isLive'>
  /** Write-lease read model; E2 lists spaces and never authorizes from them. */
  readonly spaces: Pick<SpaceLeases, 'processEpoch'>
  /** Profile registry. Writes exist only on this loopback management surface, never as a worker tool. */
  readonly profiles: Pick<Profiles, 'list' | 'detail' | 'config' | 'save' | 'validateDraft' | 'activate' | 'retire' | 'rollback'
    | 'setEnabled' | 'saveOperatorConfig'>
  readonly outbox: Pick<Outbox, 'recall' | 'reconcile'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : error.code === 'reviewStale' ? 409 : 400,
    { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict || error instanceof ProfileConflict) {
    return [409, { error: error.message }]
  }
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.github.login, feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends RouteKey> {
  params: RouteParams<K>; query: QueryOutput<K>; body: (maxBytes?: number) => Promise<BodyInput<K>>
}
function routes(runtime: HttpHost) {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const profileDetail = (id: string) => {
    const detail = runtime.profiles.detail(id)
    if (!detail) throw new UserError('profileNotFound')
    return detail
  }
  const profileBy = `${PANEL_ACTOR.source}:${PANEL_ACTOR.id}`
  const promptBody = <K extends RouteKey>(input: Input<K>) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET metrics': () => metrics(store),
    'GET tasks': () => taskBoard(views(runtime)),
    'GET goals': () => goalBoard(runtime),
    'GET goals/:id': ({ params }) => {
      const goal = goalDetail(runtime, params.id)
      if (!goal) throw new RouteError(404, 'Goal not found')
      return { goal }
    },
    'GET spaces': async () => ({ generatedAt: new Date().toISOString(),
      rows: await spaceRows(store, runtime.spaces.processEpoch, id => runtime.executor.isLive(id)) }),
    'GET contexts/groups': () => contextGroupBoard(runtime),
    'GET profiles': () => ({ generatedAt: new Date().toISOString(), config: runtime.profiles.config(),
      profiles: runtime.profiles.list() }),
    'GET profiles/:id': ({ params }) => profileDetail(params.id),
    'GET profiles/:id/metrics': ({ params }) => {
      if (!runtime.profiles.config().telemetry) throw new RouteError(404, 'Profile telemetry is disabled')
      if (!runtime.profiles.detail(params.id)) throw new UserError('profileNotFound')
      return profileMetrics(runtime.store, params.id, new Date())
    },
    'POST profiles': async ({ body }) => {
      const request = await body()
      const definition = runtime.profiles.save(request.profile, 0, { by: profileBy, source: 'panel', reason: request.reason })
      return profileDetail(definition.id)
    },
    'POST profiles/:id/revisions': async ({ params, body }) => {
      const request = await body()
      const draft = runtime.profiles.validateDraft(request.profile)
      if (draft.id !== params.id) throw new RouteError(400, 'The path profile id and the draft id differ')
      runtime.profiles.save(draft, request.baseRevision, { by: profileBy, source: 'panel', reason: request.reason })
      return profileDetail(params.id)
    },
    'POST profiles/:id/activate': async ({ params, body }) => {
      const request = await body()
      runtime.profiles.activate(params.id, request.revision, profileBy, false, request.reason)
      return profileDetail(params.id)
    },
    'POST profiles/:id/enabled': async ({ params, body }) => {
      const request = await body()
      runtime.profiles.setEnabled(params.id, request.enabled, profileBy, request.reason)
      return profileDetail(params.id)
    },
    'POST profiles/:id/retire': async ({ params, body }) => {
      const request = await body()
      runtime.profiles.retire(params.id, request.revision, profileBy, request.reason)
      return profileDetail(params.id)
    },
    'POST profiles/:id/rollback': async ({ params, body }) => {
      const request = await body()
      runtime.profiles.rollback(params.id, profileBy, request.reason)
      return profileDetail(params.id)
    },
    'PUT profiles/config': async ({ body }) => {
      const request = await body()
      const { reason: _reason, ...patch } = request
      const config = runtime.profiles.saveOperatorConfig({
        ...patch,
        ...(patch.defaultProfile === '' ? { defaultProfile: undefined } : {}),
      }, profileBy, request.reason)
      return { config }
    },
    'GET tasks/:id': ({ params, query }) => {
      const detail = taskDetail(views(runtime), params.id, query.depth)
      if (!detail) throw new RouteError(404, 'Ticket not found')
      return detail
    },
    'GET activity': ({ query }) => activityFeed(store.activity, query.after, query.limit, query.level, activityLookup(store)),
    'GET search': ({ query }) => search(views(runtime), query.q, runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => threadList(views(runtime), query.filter, query.offset, query.limit),
    'GET threads/:key': ({ params, query }) => {
      const detail = threadDetail(views(runtime), params.key, query.before, query.limit, query.around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET triggers/:id/trace': ({ params }) => triggerTrace(views(runtime), params.id),
    'GET decisions': ({ query }) => {
      const since = query.window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), query.kind.split(',').filter(Boolean), query.offset, query.limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => ticketList(views(runtime), query.state, query.offset, query.limit, query.origin),
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'GET tickets/:id/timeline': ({ params }) => {
      const timeline = ticketTimeline(views(runtime), params.id)
      if (!timeline) throw new RouteError(404, 'Ticket not found')
      return timeline
    },
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST tickets/:id/approve': async ({ params, body }) => {
      const id = ticket(params.id)
      const { reviewRevision } = await body()
      runtime.engine.reviewTicket(id, PANEL_ACTOR, reviewRevision)
      return { approved: true, reviewRevision }
    },
    'POST outbox/:id/recall': ({ params }) => ({ status: runtime.outbox.recall(decoded(params.id)) }),
    'POST approvals/:id/approve': async ({ params, body }) => {
      const { level } = await body()
      const approval = decideApproval(store, params.id, 'approved', new Date().toISOString(), level)
      if (!approval) throw new RouteError(404, 'Approval not found')
      // A granted message is queued for delivery now; a lower grant settles it as dropped.
      runtime.outbox.reconcile()
      return { state: 'approved' as const, level: approval.grantedLevel ?? approval.action.level }
    },
    'POST approvals/:id/deny': ({ params }) => {
      const approval = decideApproval(store, params.id, 'denied', new Date().toISOString())
      if (!approval) throw new RouteError(404, 'Approval not found')
      runtime.outbox.reconcile()
      return { state: 'denied' as const }
    },
    'POST executor/pause': async ({ body }) => runtime.settings.pause((await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = params.block as SettingsBlock
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = await body()
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => promptsView(runtime, query.revision, query.offset),
    'PUT prompts': async input => {
      const request = await promptBody(input)
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  } satisfies { [K in RouteKey]: (input: Input<K>) => unknown }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
/** The handler table the contract types are read from; every contract route must have exactly one handler. */
export type RouteHandlers = ReturnType<typeof routes>
type AnyHandler = (input: Input<RouteKey>) => unknown
function match(table: RouteHandlers, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const raw: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) raw[part.slice(1)] = decoded(segments[index]!) })
    const key = route as RouteKey
    return { key, run: run as AnyHandler, params: parseParams(key, raw) as RouteParams<RouteKey> }
  }
  return undefined
}
const STREAM_PATH = '/orchestrator/api/activity/stream'
const STREAM_POLL_MS = 1_000
const STREAM_HEARTBEAT_MS = 15_000
const STREAM_LEVELS = ['quiet', 'feed', 'notice'] as const
type StreamLevel = typeof STREAM_LEVELS[number]
/**
 * Accepts the browser's EventSource handshake without requiring the panel's custom header: EventSource cannot set one.
 * Loopback, the request port, same-origin and Fetch-Metadata are still checked, so a foreign page cannot read the feed.
 */
function sameOriginStream(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host
  if (!host || !host.endsWith(`:${port}`)) return false
  if (!['127.0.0.1', 'localhost'].includes(host.slice(0, host.lastIndexOf(':')))) return false
  const origin = req.headers.origin
  if (origin !== undefined && origin !== `http://${host}`) return false
  const site = req.headers['sec-fetch-site']
  return site === undefined || site === 'same-origin' || site === 'none'
}
/** Writes one chunk, waiting for the socket to drain rather than buffering an unbounded stream. */
async function writeChunk(res: ServerResponse, chunk: string): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return false
  if (res.write(chunk)) return true
  await new Promise<void>(resolve => { res.once('drain', resolve); res.once('close', resolve) })
  return !res.writableEnded && !res.destroyed
}
/**
 * Streams graded activity as Server-Sent Events. `Last-Event-ID` (or `?after=`) resumes from the client's cursor; a first
 * connection without one starts at the current head, so opening the panel never replays retained history. Each record is an
 * `activity` event whose `id` is its sequence; a `ready` event reports the head and backfill cursor, and heartbeat comments
 * keep idle proxies from closing the response.
 */
async function streamActivity(ctx: Context, runtime: HttpHost, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const port = ctx.webServer.port
  if (port === undefined) { json(res, 503, { error: 'Web server is not listening' }); return }
  if (!sameOriginStream(req, port)) { json(res, 403, { error: 'Same-origin event stream required' }); return }
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const queryAfter = Number.parseInt(url.searchParams.get('after') ?? '', 10)
  const headerAfter = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10)
  const requested = Number.isFinite(headerAfter) && headerAfter >= 0 ? headerAfter : queryAfter
  const levelValue = url.searchParams.get('level')
  const level: StreamLevel = STREAM_LEVELS.includes(levelValue as StreamLevel) ? levelValue as StreamLevel : 'feed'
  const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '200', 10) || 200))
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform',
    connection: 'keep-alive', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' })
  res.flushHeaders?.()
  let closed = false
  let cursor = Number.isFinite(requested) && requested > 0 ? requested : runtime.store.activity.latest(level)
  let polling = false
  let heartbeat: NodeJS.Timeout | undefined
  let poll: NodeJS.Timeout | undefined
  const stop = () => {
    closed = true
    clearInterval(heartbeat)
    clearInterval(poll)
  }
  async function pump(): Promise<void> {
    if (closed || polling) return
    polling = true
    try {
      for (;;) {
        if (closed) return
        const latest = runtime.store.activity.latest(level)
        if (cursor > latest) cursor = latest
        const feed = activityFeed(runtime.store.activity, cursor, limit, level, activityLookup(runtime.store))
        for (const item of feed.items) {
          if (!await writeChunk(res, `id: ${item.seq}\nevent: activity\ndata: ${JSON.stringify(item)}\n\n`)) return
          cursor = item.seq
        }
        if (feed.next > cursor) cursor = feed.next
        if (feed.items.length === 0 || feed.next >= latest) return
      }
    } finally { polling = false }
  }
  res.on('close', stop)
  heartbeat = setInterval(() => { void writeChunk(res, ': heartbeat\n\n') }, STREAM_HEARTBEAT_MS)
  poll = setInterval(() => { void pump().catch(stop) }, STREAM_POLL_MS)
  heartbeat.unref?.(); poll.unref?.()
  try {
    await runtime.ready
    if (closed) return
    await writeChunk(res, `event: ready\ndata: ${JSON.stringify({ latest: runtime.store.activity.latest(level), next: cursor })}\n\n`)
    await pump()
    if (closed) return
    await writeChunk(res, `event: ready\ndata: ${JSON.stringify({ latest: runtime.store.activity.latest(level), next: cursor })}\n\n`)
  } catch { stop(); if (!res.writableEnded) res.end() }
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: STREAM_PATH, handler: (req, res) => streamActivity(ctx, runtime, req, res) }),
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      const port = ctx.webServer.port
      if (port === undefined) { json(res, 503, { error: 'Web server is not listening' }); return }
      if (!sameOrigin(req, port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = parseQuery(route.key, Object.fromEntries(url.searchParams))
        const body = (maxBytes?: number) => readBody(req, maxBytes).then(value => parseBody(route.key, value))
        json(res, 200, await route.run({ params: route.params, query, body } as never))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
