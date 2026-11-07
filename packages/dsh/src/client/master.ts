/** Shared read-only main-Session identity, so the entry, row marker, System view and Events tab agree on `masterId`. */
import { useEffect, useSyncExternalStore } from 'react'
import type { Call } from './api.ts'

/** The host facts those surfaces need; absent until the first `GET state` answers. */
export interface MasterSnapshot {
  masterId?: string
  paused: boolean
  ready: boolean
  error?: string
}
/**
 * Polls `GET state` on behalf of every mounted surface, retaining one timer for the whole plugin rather than one per
 * component. A missing answer is not fatal: the entry stays disabled and the main panel's own fallback button still works.
 */
export class MasterStore {
  private snapshot: MasterSnapshot = { paused: false, ready: false }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private retained = 0
  private loading = false
  private disposed = false
  constructor(private readonly call: Call) {}
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  readonly getSnapshot = (): MasterSnapshot => this.snapshot
  /** Start polling while at least one surface is mounted; the returned disposer releases that claim. */
  readonly retain = (): (() => void) => {
    if (this.disposed) return () => {}
    this.retained += 1
    if (this.retained === 1) this.start()
    return () => {
      this.retained -= 1
      if (this.retained === 0) this.stop()
    }
  }
  /** Stop polling and release listeners; the plugin effect calls this on unload. */
  dispose(): void {
    this.disposed = true
    this.stop()
    this.listeners.clear()
  }
  private start(): void {
    void this.load()
    this.timer ??= setInterval(() => { void this.load() }, 10_000)
  }
  private stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
  private async load(): Promise<void> {
    if (this.loading) return
    this.loading = true
    try {
      const state = await this.call('GET state')
      this.publish({ masterId: state.masterId, paused: state.paused, ready: true })
    } catch (failure) {
      this.publish({ ...this.snapshot, ready: this.snapshot.ready, error: failure instanceof Error ? failure.message : String(failure) })
    } finally { this.loading = false }
  }
  private publish(next: MasterSnapshot): void {
    const previous = this.snapshot
    if (previous.masterId === next.masterId && previous.paused === next.paused && previous.ready === next.ready
      && previous.error === next.error) return
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}
/** Subscribe one component to the shared store, retaining its poller for the component's lifetime. */
export function useMaster(store: MasterStore): MasterSnapshot {
  useEffect(() => store.retain(), [store])
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}