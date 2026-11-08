import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '@superagent/dsh/app/http.ts'
import { PromptConflict } from '@superagent/dsh/app/prompts.ts'
import { SettingsConflict } from '@superagent/dsh/app/settings.ts'
import type { HttpHost } from '@superagent/dsh/app/http.ts'
import { SettingsSchema } from '@superagent/dsh/policy.ts'
import { SetupError } from '@superagent/dsh/setup.ts'
import { createAction, createApproval, UserError, type Approval } from '@superagent/kernel'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server, exposing each route so an event-stream test can drive it directly. */
function mount(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') {
  const handlers = new Map<string, Handler>()
  const ctx = { webServer: { host, port: 3082, register: (route: { kind: string; path: string; handler: Handler }) => {
    handlers.set(`${route.kind}:${route.path}`, route.handler); return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  const call = async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handlers.get(`prefix:/orchestrator`)!(req, { writeHead: (code: number) => { status = code }, end: (data: string) => {
      text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  return { call, handlers }
}
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1') { return mount(runtime, host).call }
/** A response that records SSE chunks; the handler owns the connection and returns once its initial backfill is written. */
async function stream(handler: Handler, url: string, headers: Headers = {}) {
  const chunks: string[] = []
  let status = 0, headersSent: Record<string, unknown> = {}
  const listeners = new Map<string, (() => void)[]>()
  const res = {
    writableEnded: false, destroyed: false,
    writeHead: (code: number, values: Record<string, unknown> = {}) => { status = code; headersSent = values },
    flushHeaders: () => {},
    write: (chunk: string) => { chunks.push(chunk); return true },
    end: () => { res.writableEnded = true },
    on: (event: string, listener: () => void) => { listeners.set(event, [...listeners.get(event) ?? [], listener]); return res },
    once: (event: string, listener: () => void) => { listeners.set(event, [...listeners.get(event) ?? [], listener]); return res },
  }
  await handler({ method: 'GET', url, headers: { host: '127.0.0.1:3082', ...headers } }, res)
  return { status, headers: headersSent, text: chunks.join('') }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('recalls a pending message through the API and maps its refusals', async () => {
  const recalled: string[] = []
  const call = serve({ outbox: { recall: (id: string) => {
    if (id === 'missing') throw new UserError('unknownReply')
    if (id === 'late') throw new UserError('undoClosed', { at: '2026-11-08T05:00:00.000Z' })
    recalled.push(id); return 'recalled'
  } } })
  expect(await call('POST', 'outbox/a%2Fb/recall')).toEqual({ status: 200, body: { status: 'recalled' } })
  expect(recalled).toEqual(['a/b'])
  expect(await call('POST', 'outbox/missing/recall')).toMatchObject({ status: 404, body: { code: 'unknownReply' } })
  expect(await call('POST', 'outbox/late/recall')).toMatchObject({ status: 400, body: { code: 'undoClosed',
    values: { at: '2026-11-08T05:00:00.000Z' } } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('serves the activity feed by cursor and minimum level, defaulting or clamping a bad page', async () => {
  const seen: unknown[] = []
  const item = { seq: 4, at: '', event: 'trigger.received', level: 'feed', summary: 'Trigger x received' }
  const presented = { ...item, subject: { kind: 'trigger', id: 'x' }, status: 'queued' }
  const call = serve({ store: { activity: {
    latest: (level?: string) => level === 'feed' ? 4 : 7,
    recent: (limit: number, level?: string) => { seen.push({ after: 0, limit, level }); return [item] },
    after: (after: number, limit: number, level?: string) => { seen.push({ after, limit, level }); return [] },
  } } })
  expect(await call('GET', 'activity?after=3&limit=20&level=feed')).toEqual({ status: 200, body: { items: [], latest: 4, next: 3 } })
  // Once the cursor reaches the feed head, a quiet event behind it does not invent a backlog.
  expect(await call('GET', 'activity?after=4&level=feed')).toEqual({ status: 200, body: { items: [], latest: 4, next: 4 } })
  // A first load starts at the head, even when its page is smaller than the feed.
  expect(await call('GET', 'activity')).toEqual({ status: 200, body: { items: [presented], latest: 7, next: 7 } })
  expect(seen).toEqual([{ after: 3, limit: 20, level: 'feed' }, { after: 4, limit: 50, level: 'feed' }, { after: 0, limit: 50, level: undefined }])
  expect(await call('GET', 'activity?limit=500')).toMatchObject({ status: 200 })
  expect(await call('GET', 'activity?after=x&level=loud')).toMatchObject({ status: 200 })
  expect(seen.slice(-2)).toEqual([{ after: 0, limit: 200, level: undefined }, { after: 0, limit: 50, level: undefined }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

/** One graded record in the fake activity table. */
const activityRecord = (seq: number, level: 'quiet' | 'feed' | 'notice' = 'feed') => ({ seq, at: '2026-01-01T00:00:00Z',
  event: 'trigger.received' as const, level, summary: `Trigger ${seq} received` })
const atLevel = (item: ReturnType<typeof activityRecord>, level?: string) => level === 'quiet' ? item.level === 'quiet'
  : level === 'notice' ? item.level === 'notice' : level === 'feed' ? item.level !== 'quiet' : true
/** The read side `activityFeed` consumes, filtered the way `Store.activity` narrows a level. */
const activityTable = (items: ReturnType<typeof activityRecord>[]) => ({
  latest: (level?: string) => items.filter(item => atLevel(item, level)).at(-1)?.seq ?? 0,
  after: (after: number, limit: number, level?: string) => items.filter(item => item.seq > after && atLevel(item, level))
    .slice(0, limit),
  recent: (limit: number, level?: string) => items.filter(item => atLevel(item, level)).slice(-limit).reverse(),
})
const streamHandler = () => mount({ store: { activity: activityTable([activityRecord(1), activityRecord(2), activityRecord(3)]) } })
  .handlers.get('exact:/orchestrator/api/activity/stream')!

it('streams activity after a cursor with sequence ids and a ready head', async () => {
  const result = await stream(streamHandler(), '/orchestrator/api/activity/stream?after=1')
  expect(result.status).toBe(200)
  expect(result.headers['content-type']).toContain('text/event-stream')
  expect(result.text).not.toContain('id: 1\n')
  expect(result.text).toContain('id: 2\nevent: activity\ndata: {"seq":2')
  expect(result.text).toContain('id: 3\nevent: activity')
  expect(result.text.match(/event: ready/g)).toHaveLength(2)
})
it('lets Last-Event-ID supersede the connection URL cursor, so a reconnect does not replay', async () => {
  const result = await stream(streamHandler(), '/orchestrator/api/activity/stream?after=1', { 'last-event-id': '2' })
  expect(result.text).not.toContain('id: 2\n')
  expect(result.text).toContain('id: 3\nevent: activity')
})
it('starts a fresh stream at the current head instead of replaying retained history', async () => {
  const result = await stream(streamHandler(), '/orchestrator/api/activity/stream')
  expect(result.text).not.toContain('event: activity')
  expect(result.text).toContain('event: ready')
})
it('leaves quiet records out of the feed stream', async () => {
  const { handlers } = mount({ store: { activity: activityTable([activityRecord(1, 'quiet'), activityRecord(2, 'feed'),
    activityRecord(3, 'notice')]) } })
  const result = await stream(handlers.get('exact:/orchestrator/api/activity/stream')!, '/orchestrator/api/activity/stream?after=1')
  expect(result.text).toContain('id: 2\n')
  expect(result.text).toContain('id: 3\n')
  expect(result.text).not.toContain('"seq":1')
})
it('refuses a foreign origin or a non-loopback host on the event stream', async () => {
  const handler = streamHandler()
  const foreign = await stream(handler, '/orchestrator/api/activity/stream', { origin: 'https://evil.example' })
  expect(foreign.status).toBe(403)
  const crossSite = await stream(handler, '/orchestrator/api/activity/stream', { 'sec-fetch-site': 'cross-site' })
  expect(crossSite.status).toBe(403)
  const otherHost = await stream(handler, '/orchestrator/api/activity/stream', { host: '192.168.1.5:3082' })
  expect(otherHost.status).toBe(403)
})
it('records an approval decision from the panel, at the requested or a lower level, and refuses a higher one', async () => {
  const now = Date.now()
  const requested = (objectId: string): Approval => createApproval({ ticketId: 't1',
    action: createAction({ source: 'feishu', objectId, kind: 'mail.reply', revision: 'rev-1',
      actor: { source: 'feishu', id: 'ou_bot' }, level: 'send' }),
    requestedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() })
  const lower = requested('om_1'), asAsked = requested('om_2'), refused = requested('om_3'), denied = requested('om_4')
  const rows = new Map([lower, asAsked, refused, denied].map(row => [row.id, row]))
  const store = { approvals: { get: (id: string) => rows.get(id), save: (row: Approval) => { rows.set(row.id, row) } },
    atomic: <T>(work: () => T): T => work() }
  const call = serve({ store })
  const path = (approval: Approval, action: string): string => `approvals/${approval.id}/${action}`

  expect(await call('POST', path(lower, 'approve'), { level: 'draft' }))
    .toEqual({ status: 200, body: { state: 'approved', level: 'draft' } })
  expect(rows.get(lower.id)).toMatchObject({ state: 'approved', grantedLevel: 'draft', decidedBy: { source: 'panel', id: 'local' } })
  expect(await call('POST', path(asAsked, 'approve'), {}))
    .toEqual({ status: 200, body: { state: 'approved', level: 'send' } })
  expect(rows.get(asAsked.id)).not.toHaveProperty('grantedLevel')
  expect(await call('POST', path(denied, 'deny'))).toEqual({ status: 200, body: { state: 'denied' } })
  expect(rows.get(denied.id)).toMatchObject({ state: 'denied', decidedBy: { source: 'panel', id: 'local' } })
  expect(await call('POST', path(refused, 'approve'), { level: 'spend' })).toMatchObject({ status: 400,
    body: { code: 'approvalLevelExceeded', values: { level: 'spend', max: 'send' } } })
  expect(rows.get(refused.id)).toMatchObject({ state: 'requested' })
  expect(await call('POST', 'approvals/missing/approve', {})).toMatchObject({ status: 404 })
  expect(await call('POST', 'approvals/missing/deny')).toMatchObject({ status: 404 })
  // A decided Approval is no longer changed by a later request.
  expect(await call('POST', path(lower, 'deny'))).toMatchObject({ status: 400, body: { code: 'approvalDecided' } })
  expect(rows.get(lower.id)).toMatchObject({ state: 'approved', grantedLevel: 'draft' })
})
