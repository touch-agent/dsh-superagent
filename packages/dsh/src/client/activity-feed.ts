/**
 * Same-origin reader for the graded activity feed: one initial page, then Server-Sent Events with a polling fallback,
 * deduplicated by sequence and shared by the right Events tab and the in-Session Status page. The unread cursor is the
 * last notice-level sequence a person saw; opening the Events tab marks the head seen and persists it per browser.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ActivityFeed, ActivityRecord } from '../app/activity.ts'
import type { Call } from './api.ts'

const STREAM_PATH = '/orchestrator/api/activity/stream'
const SEEN_KEY = 'dsh-superagent/activity-seen'
const PAGE = 50
const BACKLOG = 200
const MAX_ITEMS = 200
const POLL_MS = 5_000
const RECONNECT_MS = 15_000

/** What the UI needs from the feed at one instant. `mode` distinguishes a live stream from the polling fallback. */
export interface ActivitySnapshot {
  items: readonly ActivityRecord[]
  /** Highest sequence stored at feed level, for a backlog check. */
  latest: number
  /** Cursor to resume from. */
  next: number
  /** Unread notice-level records after the persisted cursor. */
  unread: number
  ready: boolean
  mode: 'idle' | 'loading' | 'streaming' | 'polling'
  error?: string
}

const initial = (): ActivitySnapshot => ({ items: [], latest: 0, next: 0, unread: 0, ready: false, mode: 'idle' })
const stored = (): number | undefined => {
  try {
    const value = Number.parseInt(globalThis.localStorage?.getItem(SEEN_KEY) ?? '', 10)
    return Number.isFinite(value) && value >= 0 ? value : undefined
  } catch { return undefined }
}
const persist = (value: number): void => { try { globalThis.localStorage?.setItem(SEEN_KEY, String(value)) } catch { /* a blocked storage is not a failure */ } }

/** One shared feed connection. The plugin creates it and hands it to every registered surface. */
export class ActivityFeedClient {
  private snapshot = initial()
  private readonly listeners = new Set<() => void>()
  private readonly noticeListeners = new Set<(record: ActivityRecord) => void>()
  private source: EventSource | undefined
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retained = 0
  private loading = false
  private disposed = false
  private lastSeen = 0
  constructor(private readonly call: Call) {}
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  readonly getSnapshot = (): ActivitySnapshot => this.snapshot
  /** The live stream is the preferred transport; polling takes over while it reconnects. */
  get streaming(): boolean { return this.snapshot.mode === 'streaming' }
  /** Retain the connection for one mounted surface; the last release stops its timers. */
  readonly retain = (): (() => void) => {
    if (this.disposed) return () => {}
    this.retained += 1
    if (this.retained === 1) void this.begin()
    return () => {
      this.retained -= 1
      if (this.retained === 0) this.pause()
    }
  }
  /** Subscribe to notice-level records that arrive after the persisted cursor. */
  onNotice(listener: (record: ActivityRecord) => void): () => void {
    this.noticeListeners.add(listener)
    return () => { this.noticeListeners.delete(listener) }
  }
  /** Clear the unread count and persist the current feed head as the last seen sequence. */
  markSeen(): void {
    const head = this.snapshot.items.reduce((max, item) => Math.max(max, item.seq), this.snapshot.latest)
    this.lastSeen = Math.max(this.lastSeen, head)
    persist(this.lastSeen)
    if (this.snapshot.unread !== 0) this.publish({ ...this.snapshot, unread: 0 })
  }
  /** Close the connection and stop timers; the plugin effect calls this on unload. */
  dispose(): void {
    this.disposed = true
    this.pause()
    this.listeners.clear()
    this.noticeListeners.clear()
  }
  private async begin(): Promise<void> {
    if (this.loading || this.disposed) return
    this.loading = true
    this.publish({ ...this.snapshot, mode: 'loading', error: undefined })
    try {
      const page = await this.call('GET activity', { query: { level: 'feed', limit: PAGE } })
      let seen = stored()
      if (seen === undefined) {
        try { seen = (await this.call('GET activity', { query: { level: 'notice', limit: 1 } })).latest } catch { seen = 0 }
        persist(seen)
      }
      this.lastSeen = seen
      const items = [...page.items]
      const unread = items.filter(item => item.level === 'notice' && item.seq > seen).length
      this.publish({ items, latest: page.latest, next: page.next, unread, ready: true, mode: 'idle' })
      this.openStream(page.next)
    } catch (failure) {
      this.publish({ ...this.snapshot, ready: false, mode: 'idle', error: failure instanceof Error ? failure.message : String(failure) })
      this.retryTimer = setTimeout(() => { void this.begin() }, RECONNECT_MS)
    } finally { this.loading = false }
  }
  private openStream(after: number): void {
    if (this.disposed) return
    if (typeof EventSource === 'undefined') { this.startPolling(); return }
    this.closeSource()
    try {
      const source = new EventSource(`${STREAM_PATH}?after=${after}&level=feed`)
      this.source = source
      source.onopen = () => { if (!this.disposed) this.publish({ ...this.snapshot, mode: 'streaming', error: undefined }) }
      source.addEventListener('activity', (event: MessageEvent<string>) => {
        try { this.ingest(JSON.parse(event.data) as ActivityRecord) } catch { /* a malformed frame is skipped; the stream continues */ }
      })
      source.addEventListener('ready', (event: MessageEvent<string>) => {
        try {
          const ready = JSON.parse(event.data) as { latest?: number; next?: number }
          this.publish({ ...this.snapshot, latest: Math.max(this.snapshot.latest, ready.latest ?? 0),
            next: Math.max(this.snapshot.next, ready.next ?? 0) })
        } catch { /* keep the records already read */ }
      })
      source.onerror = () => {
        if (this.disposed) return
        this.closeSource()
        this.startPolling()
        this.retryTimer = setTimeout(() => this.openStream(this.snapshot.next), RECONNECT_MS)
      }
    } catch { this.startPolling() }
  }
  private startPolling(): void {
    if (this.disposed || this.pollTimer) return
    this.publish({ ...this.snapshot, mode: 'polling' })
    const poll = async (): Promise<void> => {
      try {
        for (;;) {
          const page: ActivityFeed = await this.call('GET activity', { query: { after: this.snapshot.next, level: 'feed',
            limit: BACKLOG } })
          if (!page.items.length) {
            this.publish({ ...this.snapshot, latest: Math.max(this.snapshot.latest, page.latest), next: Math.max(this.snapshot.next,
              page.next), error: undefined })
            break
          }
          this.ingest(page.items)
          if (page.next >= page.latest) break
        }
        if (!this.disposed) this.publish({ ...this.snapshot, mode: 'polling', error: undefined })
      } catch (failure) {
        this.publish({ ...this.snapshot, error: failure instanceof Error ? failure.message : String(failure) })
      } finally {
        if (!this.disposed) this.pollTimer = setTimeout(() => { void poll() }, POLL_MS)
        else this.pollTimer = undefined
      }
    }
    void poll()
  }
  private ingest(input: ActivityRecord | ActivityRecord[]): void {
    const records = Array.isArray(input) ? input : [input]
    const fresh = records.filter(record => Number.isFinite(record.seq) && record.seq > this.snapshot.next)
    if (!fresh.length) return
    fresh.sort((left, right) => left.seq - right.seq)
    const items = [...fresh].reverse().concat(this.snapshot.items).filter((item, index, all) =>
      all.findIndex(candidate => candidate.seq === item.seq) === index).slice(0, MAX_ITEMS)
    const latest = fresh.reduce((max, item) => Math.max(max, item.seq), this.snapshot.latest)
    const next = fresh.reduce((max, item) => Math.max(max, item.seq), this.snapshot.next)
    const notices = fresh.filter(item => item.level === 'notice' && item.seq > this.lastSeen)
    this.publish({ ...this.snapshot, items, latest, next, unread: this.snapshot.unread + notices.length, ready: true })
    if (this.snapshot.ready) for (const record of notices) for (const listener of this.noticeListeners) listener(record)
  }
  private closeSource(): void {
    this.source?.close()
    this.source = undefined
  }
  private pause(): void {
    this.closeSource()
    clearTimeout(this.pollTimer)
    clearTimeout(this.retryTimer)
    this.pollTimer = undefined
    this.retryTimer = undefined
    if (this.snapshot.mode !== 'idle') this.publish({ ...this.snapshot, mode: 'idle' })
  }
  private publish(next: ActivitySnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
/** Subscribe one surface to the shared feed, retaining its connection for the component's lifetime. */
export function useActivityFeed(client: ActivityFeedClient): ActivitySnapshot {
  useEffect(() => client.retain(), [client])
  return useSyncExternalStore(client.subscribe, client.getSnapshot)
}