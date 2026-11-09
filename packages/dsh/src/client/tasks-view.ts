/**
 * Shared read-only task list state: one `GET tasks` poll for the right Task tab and the status page, plus the selection the
 * Task and Events tabs share. Polling starts only while a task surface is mounted, so the tab does not pull attention by
 * itself; the selection lives for the page's lifetime and is never written back to the Store.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { TaskBoardView, TaskView } from '../app/tasks.ts'
import type { Call } from './api.ts'

const POLL_MS = 5_000

/** The task a person is looking at; Phase 1 has no subtasks, so a ticket is the only selection kind. */
export interface TaskSelection { kind: 'ticket'; id: string }

/** One instant of the shared task list. `error` with `data` means the last answer is kept and may be stale. */
export interface TasksSnapshot {
  data?: TaskBoardView
  error?: Error
  ready: boolean
  loading: boolean
  selection?: TaskSelection
}

const initial = (): TasksSnapshot => ({ ready: false, loading: false })

/** One shared list for every task surface the plugin registers. */
export class TasksViewClient {
  private snapshot = initial()
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | undefined
  private retained = 0
  private disposed = false
  constructor(private readonly call: Call) {}
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  readonly getSnapshot = (): TasksSnapshot => this.snapshot
  /** Start polling while at least one task surface is mounted; the returned disposer releases that claim. */
  readonly retain = (): (() => void) => {
    if (this.disposed) return () => {}
    this.retained += 1
    if (this.retained === 1) this.start()
    return () => {
      this.retained -= 1
      if (this.retained === 0) this.stop()
    }
  }
  /** Read the list again, keeping the last answer on failure. */
  refresh(): void {
    if (this.disposed) return
    void this.load()
  }
  /** Select one Ticket, or clear the selection with `undefined`; selecting the same Ticket keeps the same state. */
  select(selection: TaskSelection | undefined): void {
    if ((this.snapshot.selection?.id ?? null) === (selection?.id ?? null)) return
    this.publish({ ...this.snapshot, selection })
  }
  /** The Events feed's group key for a selected task: a review's events belong to the Ticket it reviews. */
  eventTaskId(id: string): string {
    return this.taskOf(id)?.reviewedTicketId ?? id
  }
  taskOf(id: string): TaskView | undefined {
    return this.snapshot.data?.tasks.find(task => task.id === id)
  }
  titleOf(id: string): string | undefined {
    return this.taskOf(id)?.title
  }
  /** Stop polling and release listeners; the plugin effect calls this on unload. */
  dispose(): void {
    this.disposed = true
    this.stop()
    this.listeners.clear()
  }
  private start(): void {
    this.refresh()
    this.timer ??= setInterval(() => { void this.load() }, POLL_MS)
  }
  private stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
  private async load(): Promise<void> {
    if (this.snapshot.loading) return
    this.publish({ ...this.snapshot, loading: true })
    try {
      const data = await this.call('GET tasks')
      this.publish({ data, ready: true, loading: false, ...this.snapshot.selection ? { selection: this.snapshot.selection } : {} })
    } catch (failure) {
      this.publish({ ...this.snapshot, error: failure instanceof Error ? failure : new Error(String(failure)), ready: true, loading: false })
    }
  }
  private publish(next: TasksSnapshot): void {
    this.snapshot = next
    for (const listener of this.listeners) listener()
  }
}

/** Subscribe one surface to the shared list, retaining its poller for the component's lifetime. */
export function useTasksView(client: TasksViewClient): TasksSnapshot {
  useEffect(() => client.retain(), [client])
  return useSyncExternalStore(client.subscribe, client.getSnapshot)
}

const noSubscribe = (): (() => void) => () => {}
/** Read the shared selection without starting a poll; an Events-only surface never fetches the task list itself. */
export function useTaskSelection(client: TasksViewClient | undefined): TaskSelection | undefined {
  return useSyncExternalStore(client?.subscribe ?? noSubscribe, () => client?.getSnapshot().selection)
}