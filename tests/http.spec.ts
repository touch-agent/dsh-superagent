import { expect, it } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '@superagent/dsh/app/http.ts'
import { PromptConflict } from '@superagent/dsh/app/prompts.ts'
import { SettingsConflict } from '@superagent/dsh/app/settings.ts'
import { ProfileConflict } from '@superagent/dsh/app/profiles.ts'
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

it('serves the Tickets board projection', async () => {
  const call = serve({
    store: { tickets: { allList: () => [], list: () => [] }, triggers: { all: () => [] }, activity: { latestByTicket: () => [] },
      spans: { byTraces: () => [] }, read: { firstTrigger: () => undefined, subscribedThreads: () => [] },
      threads: { get: () => undefined }, settings: () => SettingsSchema.parse({}) },
    sources: { kind: () => undefined },
    links: () => ({}),
  })
  const answer = await call('GET', 'tasks')
  expect(answer.status).toBe(200)
  expect(answer.body).toMatchObject({ milestones: [], tasks: [], totals: { milestones: 0, tasks: 0, tickets: 0, open: 0, attention: 0 } })
})

it('approves a review-stage Ticket through the engine as the panel actor', async () => {
  const reviews: [string, unknown, string][] = []
  const call = serve({
    store: { tickets: { get: (id: string) => ['t1', 't2', 't3', 't4'].includes(id) ? { id } : undefined } },
    engine: { reviewTicket: (id: string, by: unknown, reviewRevision: string) => {
      if (id === 't2') throw new UserError('reviewNotReady')
      if (id === 't3') throw new UserError('deliverablePreviewMissing')
      if (id === 't4') throw new UserError('reviewStale', { revision: 'rev-current' })
      reviews.push([id, by, reviewRevision])
      return { id }
    } },
  })
  expect(await call('POST', 'tickets/t1/approve', { reviewRevision: 'rev-1' })).toEqual({ status: 200,
    body: { approved: true, reviewRevision: 'rev-1' } })
  expect(reviews).toEqual([['t1', { source: 'panel', id: 'local' }, 'rev-1']])
  expect(await call('POST', 'tickets/t2/approve', { reviewRevision: 'rev-2' })).toMatchObject({ status: 400, body: { code: 'reviewNotReady' } })
  expect(await call('POST', 'tickets/t3/approve', { reviewRevision: 'rev-3' })).toMatchObject({ status: 400,
    body: { code: 'deliverablePreviewMissing' } })
  expect(await call('POST', 'tickets/t4/approve', { reviewRevision: 'rev-old' })).toMatchObject({ status: 409,
    body: { code: 'reviewStale', values: { revision: 'rev-current' } } })
  expect(await call('POST', 'tickets/missing/approve')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
})

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
  // The dispatch block is a first-class save target, not only a read-only view.
  expect(await call('PUT', 'settings/dispatch', { value: { mode: 'auto', maxTickets: 2 }, revision: 0 }))
    .toMatchObject({ status: 200, body: { saved: true } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(5)
  expect(saves[4]).toEqual(['dispatch', { mode: 'auto', maxTickets: 2 }, 0, 'panel'])
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
  // Streamed rows carry the same presentation as GET activity, not only the stored facts.
  expect(result.text).toContain('"subject":{"kind":"trigger","id":"2"}')
  expect(result.text).toContain('"status":"queued"')
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
  const call = serve({ store, outbox: { reconcile: () => {} } })
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

it('serves profile management writes and maps a revision conflict to 409', async () => {
  const writes: { method: string; args: unknown[] }[] = []
  const head = { activeRevision: 2, previousActiveRevision: 1, retiredRevisions: [], updatedBy: 'panel:local', disabled: false }
  const definition = { id: 'worker-docs', revision: 2, title: 'Docs', role: 'worker', model: { mode: 'inherit' }, tools: { mode: 'inherit' },
    prompt: { mode: 'live' } }
  const profiles = {
    config: () => ({ enabled: true, resolve: 'snapshot', telemetry: true }),
    list: () => [{ id: 'worker-docs', title: 'Docs', activeRevision: 2 }],
    detail: (id: string) => id === 'worker-docs' ? { profile: definition, head, revisions: [definition] } : undefined,
    validateDraft: (value: unknown) => value,
    save: (...args: unknown[]) => { writes.push({ method: 'save', args }); return definition },
    activate: (...args: unknown[]) => { writes.push({ method: 'activate', args }); return head },
    setEnabled: (...args: unknown[]) => { writes.push({ method: 'setEnabled', args }); return head },
    retire: (...args: unknown[]) => { writes.push({ method: 'retire', args }); return head },
    rollback: (...args: unknown[]) => { writes.push({ method: 'rollback', args }); return head },
    saveOperatorConfig: (patch: Record<string, unknown>, by: string, reason?: string) => ({ ...patch, updatedBy: by,
      ...reason ? { updatedReason: reason } : {} }),
  }
  const call = serve({ profiles })
  expect(await call('GET', 'profiles')).toMatchObject({ status: 200, body: { config: { enabled: true }, profiles: [{ id: 'worker-docs' }] } })
  expect(await call('GET', 'profiles/missing')).toMatchObject({ status: 404, body: { code: 'profileNotFound' } })
  expect(await call('POST', 'profiles', { profile: { id: 'worker-docs' }, reason: 'create' })).toMatchObject({ status: 200,
    body: { profile: { id: 'worker-docs' } } })
  expect(writes[0]).toMatchObject({ method: 'save', args: [{ id: 'worker-docs' }, 0, { by: 'panel:local', source: 'panel', reason: 'create' }] })
  expect(await call('POST', 'profiles/worker-docs/revisions', { profile: { id: 'worker-docs' }, baseRevision: 1, reason: 'rev' }))
    .toMatchObject({ status: 200 })
  expect(await call('POST', 'profiles/worker-docs/revisions', { profile: { id: 'other' }, baseRevision: 1, reason: 'rev' }))
    .toMatchObject({ status: 400 })
  expect(await call('POST', 'profiles/worker-docs/activate', { revision: 1, reason: 'activate' })).toMatchObject({ status: 200 })
  expect(writes.find(item => item.method === 'activate')?.args).toMatchObject(['worker-docs', 1, 'panel:local', false, 'activate'])
  expect(await call('POST', 'profiles/worker-docs/enabled', { enabled: false, reason: 'off' })).toMatchObject({ status: 200 })
  expect(await call('POST', 'profiles/worker-docs/retire', { revision: 1, reason: 'retire' })).toMatchObject({ status: 200 })
  expect(await call('POST', 'profiles/worker-docs/rollback', { reason: 'back' })).toMatchObject({ status: 200 })
  expect(await call('PUT', 'profiles/config', { enabled: false, resolve: 'legacy', telemetry: false, reason: 'switch' }))
    .toMatchObject({ status: 200, body: { config: { enabled: false, resolve: 'legacy', telemetry: false, updatedBy: 'panel:local',
      updatedReason: 'switch' } } })
  profiles.save = () => { throw new ProfileConflict('stale') }
  expect(await call('POST', 'profiles', { profile: { id: 'worker-docs' }, reason: 'create' }))
    .toMatchObject({ status: 409, body: { error: 'stale' } })
})

it('serves the project filter and project archive routes', async () => {
  const archived: [string, boolean, unknown][] = []
  const store = { tickets: { get: () => undefined, allList: () => [], list: () => [] }, triggers: { all: () => [] },
    activity: { latestByTicket: () => [] }, spans: { byTraces: () => [] },
    read: { firstTrigger: () => undefined, subscribedThreads: () => [] }, threads: { get: () => undefined },
    settings: () => SettingsSchema.parse({}) }
  const call = serve({ store, sources: { kind: () => undefined }, links: () => ({}),
    engine: { archiveProject: (id: string, value: boolean, by: unknown) => { archived.push([id, value, by]); return { id } } } })
  // The rollback flag restores the pre-project response shape.
  const legacy = await call('GET', 'tasks?projects=off')
  expect(legacy.status).toBe(200)
  expect(legacy.body).not.toHaveProperty('projects')
  expect(legacy.body).not.toHaveProperty('unassigned')
  expect(await call('GET', 'projects/missing')).toEqual({ status: 404, body: { error: 'Project not found' } })
  expect(await call('POST', 'projects/p1/archive')).toEqual({ status: 200, body: { archived: true } })
  expect(await call('POST', 'projects/p1/restore')).toEqual({ status: 200, body: { archived: false } })
  expect(archived).toEqual([['p1', true, { source: 'panel', id: 'local' }], ['p1', false, { source: 'panel', id: 'local' }]])
})
