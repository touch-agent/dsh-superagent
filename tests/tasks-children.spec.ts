import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Assignment, ProfileSnapshot, Ticket } from '@superagent/kernel'
import { Store } from '@superagent/dsh/app/store.ts'
import { taskBoard, taskDetail } from '@superagent/dsh/app/tasks.ts'
import type { ViewHost } from '@superagent/dsh/app/views/records.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-task-tree-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const host = (store: Store): ViewHost => ({ store, sources: { kind: () => undefined } as never, links: () => ({}) as never })
const at = '2026-09-22T00:00:00Z'
const docsProfile: ProfileSnapshot = {
  id: 'docs-owner', revision: 2, hash: 'sha256:docs', role: 'worker',
  selection: { by: 'code', source: 'builtin', reason: 'test', moving: false, valid: true }, model: { mode: 'inherit' },
  tools: [], toolsMode: 'inherit', prompt: { mode: 'live', revision: 2, hash: 'sha256:prompt' },
  effective: { promptRevision: 2, promptHash: 'sha256:prompt', toolsHash: 'sha256:tools',
    model: { provider: 'host-default', model: 'host-default' }, dshVersion: 'test', policyVersion: 'v', skillsHash: 'sha256:skills',
    hash: 'sha256:effective' },
  boundAt: at, reason: 'test',
}
const assignment = (id: string, report?: Assignment['report']): Assignment => ({ id, state: report ? 'running' : 'ended', createdAt: at,
  ...report ? {} : { startedAt: at }, ...report ? { startedAt: at, report } : {} })
const tracked = (id: string, fields: Partial<Ticket> = {}): Ticket => ({
  id, title: id, decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
    actor: { source: 'conversation', id: 'local-user' }, scope: '' }, channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: at, updatedAt: at, origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] }, form: 'tracked', ...fields })
const child = (id: string, fields: Partial<Ticket> = {}): Ticket => tracked(id, {
  parentTicketId: 'root1', rootTicketId: 'root1', delegation: { parentTicketId: 'root1', rootTicketId: 'root1', goal: `goal ${id}`,
    requestedBy: { ticketId: 'root1', sessionId: 's1' }, attempt: 1, createdAt: at, dispositions: [] }, ...fields })
const seed = (store: Store, tickets: Ticket[]) => { for (const item of tickets) store.tickets.save(item) }

it('keeps the board to roots with child counts and loads direct children only on detail', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const root = tracked('root1', { profile: docsProfile,
    assignments: [assignment('ra', { state: 'progress', summary: 'working', at })] })
  const waiting = child('c1', { assignments: [assignment('c1a', { state: 'waiting', summary: 'waiting on parent', at })] })
  const dropped = child('c2', { ended: { at, by: 'executor', outcome: 'dropped' }, assignments: [assignment('c2a')] })
  const cancelled = child('c4', { ended: { at, by: 'executor', outcome: 'stopped' },
    delegation: { ...child('x').delegation!, resolution: { kind: 'cancelled', by: { source: 'dsh-superagent', id: 'owner' }, at } },
    assignments: [assignment('c4a')] })
  const orphan = child('c3', { delegation: { ...child('x').delegation!, orphaned: { reason: 'parent gone', at } },
    assignments: [assignment('c3a')] })
  seed(store, [root, waiting, dropped, cancelled, orphan])

  const board = taskBoard(host(store), new Date('2026-09-22T12:00:00Z'))
  expect(board.tasks.map(task => task.id)).toEqual(['root1'])
  expect(board.totals).toMatchObject({ tickets: 1, children: 4 })
  expect(board.tasks[0]!.childSummary).toMatchObject({ total: 4, live: 2, waiting: 1, cancelled: 1, orphaned: 1 })
  expect(board.tasks[0]!.children).toBeUndefined()
  expect(board.tasks[0]!.owner).toEqual({ role: 'owner', profile: { id: 'docs-owner', revision: 2 } })
  expect(board.tasks[0]!.blocker).toMatchObject({ kind: 'child', count: 2 })

  const detail = taskDetail(host(store), 'root1', 1, new Date('2026-09-22T12:00:00Z'))!
  expect(detail.children.map(item => item.id).sort()).toEqual(['c1', 'c2', 'c3', 'c4'])
  expect(detail.task.children?.map(item => item.id).sort()).toEqual(['c1', 'c2', 'c3', 'c4'])
  const byId = new Map(detail.children.map(item => [item.id, item]))
  expect(byId.get('c1')).toMatchObject({ status: 'idle', depth: 1, parentTicketId: 'root1', parentOwner: { role: 'owner' } })
  expect(byId.get('c2')).toMatchObject({ terminal: 'dropped', status: 'done' })
  expect(byId.get('c4')).toMatchObject({ terminal: 'stopped', status: 'done', delegation: { resolution: { kind: 'cancelled' } } })
  expect(byId.get('c3')).toMatchObject({ status: 'blocked', delegation: { orphaned: { reason: 'parent gone' } },
    parentOwner: { role: 'owner', profile: { id: 'docs-owner', revision: 2 } }, blocker: { kind: 'orphaned' } })
})

it('gives a person attention for a failed child only when no living ancestor owner can decide it', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const failedReport: Assignment['report'] = { state: 'failed', summary: 'boom', at }
  const available = tracked('root-live', { assignments: [assignment('ra', { state: 'progress', summary: 'working', at })] })
  const liveChild = tracked('live-child', { parentTicketId: 'root-live', rootTicketId: 'root-live', assignments: [assignment('ca', failedReport)],
    delegation: { parentTicketId: 'root-live', rootTicketId: 'root-live', goal: 'child', requestedBy: { ticketId: 'root-live', sessionId: 's' },
      attempt: 1, createdAt: at, dispositions: [] } })
  const unavailable = tracked('root-ended', { assignments: [assignment('re')] })
  const failedChild = tracked('failed-child', { parentTicketId: 'root-ended', rootTicketId: 'root-ended',
    assignments: [assignment('ce', failedReport)], delegation: { parentTicketId: 'root-ended', rootTicketId: 'root-ended', goal: 'child',
      requestedBy: { ticketId: 'root-ended', sessionId: 's' }, attempt: 1, createdAt: at, dispositions: [] } })
  seed(store, [available, liveChild, unavailable, failedChild])

  const board = taskBoard(host(store), new Date('2026-09-22T12:00:00Z'))
  const byId = new Map(board.tasks.map(task => [task.id, task]))
  expect(byId.get('root-live')!.attention).toBeUndefined()
  expect(byId.get('root-live')!.status).toBe('blocked')
  expect(byId.get('root-ended')!.attention).toBe(true)
  expect(byId.get('root-ended')!.status).toBe('blocked')
  expect(board.totals.attention).toBe(1)
})

it('projects 500 roots and 2000 children within the p95 budget without a per-row Ticket query', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const roots: Ticket[] = [], children: Ticket[] = []
  for (let index = 0; index < 500; index++) {
    const id = `root-${index}`
    roots.push(tracked(id, { assignments: [assignment(`${id}-a`, { state: 'progress', summary: 'working', at })] }))
    for (let childIndex = 0; childIndex < 4; childIndex++) children.push(tracked(`${id}-c${childIndex}`, {
      parentTicketId: id, rootTicketId: id, assignments: [assignment(`${id}-c${childIndex}-a`, { state: 'waiting', summary: 'waiting', at })],
      delegation: { parentTicketId: id, rootTicketId: id, goal: 'child', requestedBy: { ticketId: id, sessionId: 's' }, attempt: 1,
        createdAt: at, dispositions: [] } }))
  }
  seed(store, [...roots, ...children])
  const list = vi.spyOn(store.tickets, 'allList')
  const perRow = vi.spyOn(store.tickets, 'childrenOf')
  const view = host(store)
  // Warm the connection and the process, then measure 25 projections; the interpolated 95th percentile is less sensitive
  // to one scheduler hiccup than the maximum of a short run.
  taskBoard(view, new Date('2026-09-22T12:00:00Z'))
  const durations: number[] = []
  for (let run = 0; run < 25; run++) {
    const started = performance.now()
    const board = taskBoard(view, new Date('2026-09-22T12:00:00Z'))
    durations.push(performance.now() - started)
    expect(board.tasks).toHaveLength(500)
    expect(board.totals.children).toBe(2000)
  }
  durations.sort((left, right) => left - right)
  const rank = 0.95 * (durations.length - 1)
  const low = Math.floor(rank), high = Math.ceil(rank)
  const p95 = durations[low]! + (durations[high]! - durations[low]!) * (rank - low)
  expect(p95, `p95 ${p95.toFixed(1)}ms`).toBeLessThanOrEqual(400)
  expect(list).toHaveBeenCalledTimes(26)
  expect(perRow).not.toHaveBeenCalled()
})