/**
 * Shared read-only task list state: one `GET tasks` poll for the right Task tab and the status page, plus the selection the
 * Task and Events tabs share. Polling starts only while a task surface is mounted, so the tab does not pull attention by
 * itself; the selection lives for the page's lifetime and is never written back to the Store.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { TaskBoardView, TaskDetailView, TaskView } from '../app/tasks.ts'
import type { Call } from './api.ts'

const POLL_MS = 5_000

/** The task a person is looking at; a child Ticket is selected the same way as its root. */
export interface TaskSelection { kind: 'ticket'; id: string; /** The root row a child is shown under; absent for a root selection. */ rootId?: string }

/** One Ticket's loaded detail, including a loading state so a selected child can render without blocking the list. */
export interface TaskDetailState {
  id: string
  data?: TaskDetailView
  error?: Error
  loading: boolean
}

/** One instant of the shared task list. `error` with `data` means the last answer is kept and may be stale. */
export interface TasksSnapshot {
  data?: TaskBoardView
  error?: Error
  ready: boolean
  loading: boolean
  selection?: TaskSelection
  detail?: TaskDetailState
  /** Bumped when any cached detail changes, so a tree with several expanded nodes re-renders. */
  detailVersion: number
}

const initial = (): TasksSnapshot => ({ ready: false, loading: false, detailVersion: 0 })

/** One shared list for every task surface the plugin registers. */
export class TasksViewClient {
  private snapshot = initial()
  private readonly listeners = new Set<() => void>()
  private readonly details = new Map<string, { data: TaskDetailView; at: number }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private retained = 0
  private disposed = false
  private detailLoading: string | undefined
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
    this.publish({ ...this.snapshot, selection, detail: selection ? this.detailState(selection.id, true) : undefined })
    if (selection) void this.loadDetail(selection.id)
  }
  /** Load one Ticket's direct children; a detail already cached is reused until the next list poll. */
  ensureDetail(id: string): void {
    const cached = this.details.get(id)
    if (cached && Date.now() - cached.at < POLL_MS) {
      if (this.snapshot.detail?.id !== id) this.publish({ ...this.snapshot, detail: this.detailState(id, false) })
      return
    }
    void this.loadDetail(id)
  }
  /** A detail loaded by the status-page tree, whether or not it is the right pane's selection. */
  detailOf(id: string): TaskDetailView | undefined {
    return this.details.get(id)?.data
  }
  /** The Events feed's group key for a selected task: a review's events belong to the Ticket it reviews. */
  eventTaskId(id: string): string {
    return this.findTask(id)?.reviewedTicketId ?? id
  }
  /** A root row, the selected Ticket, or one of its loaded children. */
  findTask(id: string): TaskView | undefined {
    const root = this.snapshot.data?.tasks.find(task => task.id === id)
    if (root) return root
    const detail = this.snapshot.detail?.data
    if (!detail) return undefined
    const found = (task: TaskView): TaskView | undefined => task.id === id ? task : task.children?.map(found).find(Boolean)
    return found(detail.task)
  }
  taskOf(id: string): TaskView | undefined {
    return this.findTask(id)
  }
  titleOf(id: string): string | undefined {
    return this.findTask(id)?.title
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
  private detailState(id: string, loading: boolean): TaskDetailState {
    const cached = this.details.get(id)
    return { id, loading, ...cached ? { data: cached.data } : {} }
  }
  private async loadDetail(id: string): Promise<void> {
    if (this.disposed || this.detailLoading === id) return
    this.detailLoading = id
    const cached = this.details.get(id)
    if (this.snapshot.detail?.id !== id || !cached) this.publish({ ...this.snapshot, detail: { id, loading: true, ...cached ? { data: cached.data } : {} } })
    try {
      const data = await this.call('GET tasks/:id', { id, query: { depth: 1 } })
      this.details.set(id, { data, at: Date.now() })
      this.publish({ ...this.snapshot, detailVersion: this.snapshot.detailVersion + 1,
        ...this.snapshot.selection?.id === id ? { detail: { id, data, loading: false } } : {} })
    } catch (failure) {
      const error = failure instanceof Error ? failure : new Error(String(failure))
      if (this.snapshot.detail?.id === id) this.publish({ ...this.snapshot, detail: { id, error, loading: false } })
    } finally {
      if (this.detailLoading === id) this.detailLoading = undefined
    }
  }
  private async load(): Promise<void> {
    if (this.snapshot.loading) return
    this.publish({ ...this.snapshot, loading: true })
    try {
      const data = await this.call('GET tasks')
      this.publish({ ...this.snapshot, data, ready: true, loading: false, error: undefined })
      // A board poll can change a selected Ticket's children or review revision; refresh that detail once, not per row.
      const selected = this.snapshot.selection?.id
      if (selected) {
        this.details.delete(selected)
        void this.loadDetail(selected)
      }
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