/** Sidebar attention count: a small, infrequent poll of the entry page's waiting list, owned by the panel icon. */
import { useEffect, useState } from 'react'
import type { Call } from './api.ts'

/**
 * The number of things waiting for a person, for the sidebar dot. It polls the same `GET overview` the panel uses, so it
 * needs no second API and cannot disagree with the page. Failures are silent: a stopped management API has no dot.
 */
export class AttentionStore {
  private value = 0
  private readonly listeners = new Set<(value: number) => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private active = false
  constructor(private readonly call: Call) {}
  get count(): number { return this.value }
  /** Subscribe to count changes; the first subscriber starts polling and the last one stops it. */
  subscribe = (listener: (value: number) => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.active) { this.active = true; void this.refresh() }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size) return
      this.active = false
      clearTimeout(this.timer)
    }
  }
  dispose(): void {
    this.active = false
    clearTimeout(this.timer)
    this.listeners.clear()
  }
  private publish(value: number): void {
    if (value === this.value) return
    this.value = value
    for (const listener of this.listeners) listener(value)
  }
  private async refresh(): Promise<void> {
    try {
      const data = await this.call('GET overview')
      this.publish(data.approvals.length + data.person.length + data.problems.length)
    } catch { /* the management API may be restarting; the next poll tries again */ }
    if (this.active) this.timer = setTimeout(() => { void this.refresh() }, 60_000)
  }
}

/** The current count, starting the store's polling while the icon is mounted. */
export function useAttention(store: AttentionStore): number {
  const [count, setCount] = useState(store.count)
  useEffect(() => {
    setCount(store.count)
    return store.subscribe(setCount)
  }, [store])
  return count
}