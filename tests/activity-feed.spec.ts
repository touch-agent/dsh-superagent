// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { ActivityFeed, ActivityRecord } from '@superagent/dsh/app/activity.ts'
import { ActivityFeedClient } from '@superagent/dsh/client/activity-feed.ts'
import type { ApiRequest } from '@superagent/dsh/app/api.ts'
import type { Call } from '@superagent/dsh/client/api.ts'

/** A minimal EventSource stand-in that records its URL and lets a test push frames. */
class FakeSource {
  static instances: FakeSource[] = []
  readonly url: string
  onopen: (() => void) | undefined
  onerror: (() => void) | undefined
  closed = false
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>()
  constructor(url: string) {
    this.url = url
    FakeSource.instances.push(this)
    queueMicrotask(() => { if (!this.closed) this.onopen?.() })
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener)
  }
  close(): void { this.closed = true }
  emit(type: string, value: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(value) } as MessageEvent<string>)
  }
}
const record = (seq: number, level: ActivityRecord['level'] = 'feed'): ActivityRecord => ({ seq, at: '2026-01-01T00:00:00Z',
  event: 'trigger.received', level, summary: `Record ${seq}` })
/** A typed caller that answers the two initial reads and any incremental poll from mutable state. */
function fakeCall(initial: ActivityRecord[], options: { noticeHead?: number; after?: ActivityRecord[] } = {}) {
  const queries: Record<string, unknown>[] = []
  const call = (async (_route: string, request?: ApiRequest<'GET activity'>): Promise<ActivityFeed> => {
    const query = request?.query ?? {}
    queries.push(query as Record<string, unknown>)
    if (query.level === 'notice') return { items: [], latest: options.noticeHead ?? 0, next: options.noticeHead ?? 0 }
    if (query.after !== undefined) {
      const items = (options.after ?? []).filter(item => item.seq > (query.after as number))
      return { items, latest: Math.max(initial[0]?.seq ?? 0, ...(options.after ?? []).map(item => item.seq)), next: items.at(-1)?.seq
        ?? (query.after as number) }
    }
    return { items: initial, latest: initial[0]?.seq ?? 0, next: initial[0]?.seq ?? 0 }
  })
  return { call: call as Call, queries }
}

afterEach(() => {
  FakeSource.instances = []
  delete (globalThis as { EventSource?: unknown }).EventSource
  localStorage.clear()
})

it('loads a first page, starts from its head, and counts unread notice records after the persisted cursor', async () => {
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeSource
  const { call } = fakeCall([record(10, 'notice'), record(9)], { noticeHead: 8 })
  const client = new ActivityFeedClient(call)
  const release = client.retain()
  await vi.waitFor(() => expect(client.getSnapshot().ready).toBe(true))
  expect(client.getSnapshot().items.map(item => item.seq)).toEqual([10, 9])
  expect(client.getSnapshot().unread).toBe(1)
  expect(FakeSource.instances[0]?.url).toContain('after=10')
  expect(FakeSource.instances[0]?.url).toContain('level=feed')
  const source = FakeSource.instances[0]!
  source.emit('activity', record(11, 'notice'))
  expect(client.getSnapshot().items[0]?.seq).toBe(11)
  expect(client.getSnapshot().unread).toBe(2)
  client.markSeen()
  expect(client.getSnapshot().unread).toBe(0)
  expect(localStorage.getItem('dsh-superagent/activity-seen')).toBe('11')
  release()
  expect(source.closed).toBe(true)
  client.dispose()
})
it('deduplicates a replayed sequence and notifies notice listeners only past the seen cursor', async () => {
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeSource
  localStorage.setItem('dsh-superagent/activity-seen', '9')
  const { call } = fakeCall([record(9)])
  const client = new ActivityFeedClient(call)
  client.retain()
  await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(1))
  const noticed: number[] = []
  const stop = client.onNotice(item => noticed.push(item.seq))
  const source = FakeSource.instances[0]!
  source.emit('activity', record(9))
  source.emit('activity', record(10, 'notice'))
  source.emit('activity', record(10, 'notice'))
  expect(client.getSnapshot().items).toHaveLength(2)
  expect(noticed).toEqual([10])
  expect(client.getSnapshot().unread).toBe(1)
  stop()
  client.dispose()
})
it('falls back to cursor polling when the stream errors, then keeps polling until disposed', async () => {
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeSource
  localStorage.setItem('dsh-superagent/activity-seen', '1')
  const { call, queries } = fakeCall([record(1)], { after: [record(2)] })
  const client = new ActivityFeedClient(call)
  client.retain()
  await vi.waitFor(() => expect(FakeSource.instances).toHaveLength(1))
  FakeSource.instances[0]!.onerror?.()
  await vi.waitFor(() => expect(client.getSnapshot().mode).toBe('polling'))
  await vi.waitFor(() => expect(client.getSnapshot().items.some(item => item.seq === 2)).toBe(true))
  expect(queries.some(query => query.after === 1)).toBe(true)
  client.dispose()
})
it('polls without EventSource, so a host that lacks the browser API still shows events', async () => {
  localStorage.setItem('dsh-superagent/activity-seen', '1')
  const { call } = fakeCall([record(1)], { after: [record(2, 'notice')] })
  const client = new ActivityFeedClient(call)
  client.retain()
  await vi.waitFor(() => expect(client.getSnapshot().items.some(item => item.seq === 2)).toBe(true))
  expect(client.getSnapshot().mode).toBe('polling')
  expect(client.getSnapshot().unread).toBe(1)
  client.dispose()
})