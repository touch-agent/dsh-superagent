import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { traceId, type Assignment, type Review, type Ticket, type Trigger } from '@superagent/kernel'
import { Store } from '@superagent/dsh/app/store.ts'
import { taskBoard } from '@superagent/dsh/app/tasks.ts'
import type { ViewHost } from '@superagent/dsh/app/views/records.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-task-view-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const ticket = (fields: Partial<Ticket> & { id: string; title: string }): Ticket => ({
  decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
    actor: { source: 'conversation', id: 'local-user' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-09-22T00:00:00Z',
  updatedAt: '2026-09-22T00:00:00Z', origin: { triggerId: 'x', triggerIds: ['x'] }, ...fields })

const trigger = (id: string, source = 'conversation'): Trigger => ({ id, source, threads: [{ source, id: `thread-${id}` }],
  actor: { source: 'conversation', id: 'local-user' }, human: true, at: '2026-09-22T00:00:00Z', text: '做一下这个任务',
  meta: {} })

const review: Review = { deliverable: {
  artifact: { kind: 'document', ref: 'docs/report.md', revision: 'r7' },
  previewRef: { kind: 'text/diff', ref: 'docs/report.md', revision: 'r7' }, acceptanceCriteria: [] }, criteria: [], confirmations: [] }

const assignment = (summary: string, reviewValue?: Review): Assignment => ({ id: 'a1', state: 'ended',
  createdAt: '2026-09-22T01:00:00Z', report: { state: 'ready', summary, at: '2026-09-22T02:00:00Z',
    ...reviewValue ? { review: reviewValue } : {} } })

const host = (store: Store): ViewHost => ({ store, sources: { kind: () => undefined } as never, links: () => ({}) as never })
const seed = (store: Store, tickets: Ticket[]): void => { for (const item of tickets) store.tickets.save(item) }

it('projects tracked worker form, review ownership and a previewed delivery without inventing a worker for lightweight', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const impl = ticket({ id: 'impl', title: '修复登录（T2-03）', origin: { triggerId: 'tr-impl', triggerIds: ['tr-impl'] },
    assignments: [assignment('已交付', review)] })
  const reviewTicket = ticket({ id: 'review', title: 'review PR #8：修复登录（T2-03）',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' },
      scope: '对 PR #8（T2-03）做 review' }, origin: { triggerId: 'tr-review', triggerIds: ['tr-review'] },
    assignments: [assignment('https://github.com/touch-agent/dsh-superagent/pull/8#pullrequestreview-1')] })
  const light = ticket({ id: 'light', title: '改一句文案', form: 'lightweight', origin: { triggerId: 'tr-light', triggerIds: ['tr-light'] } })
  seed(store, [impl, reviewTicket, light])
  for (const item of [trigger('tr-impl'), trigger('tr-review', 'github'), trigger('tr-light')]) store.triggers.save(item)
  const lightTrace = traceId('tr-light')
  store.spans.record({ id: 's1', traceId: lightTrace, kind: 'action', at: '2026-09-22T00:10:00Z', ticketId: 'light', data: {} })
  store.spans.record({ id: 's2', traceId: lightTrace, kind: 'action', at: '2026-09-22T00:20:00Z', ticketId: 'light', data: {} })
  store.spans.record({ id: 's3', traceId: lightTrace, kind: 'report', at: '2026-09-22T00:30:00Z', ticketId: 'light', data: {} })

  const board = taskBoard(host(store), new Date('2026-09-22T12:00:00Z'))
  const tasks = new Map(board.tasks.map(task => [task.id, task]))
  expect(tasks.get('impl')).toMatchObject({ kind: 'ticket', form: 'tracked', status: 'review', attention: true, execution: { assignments: 1 },
    plan: { milestone: 'M2', task: 'T2-03' } })
  expect(tasks.get('impl')!.deliverables[0]).toMatchObject({ key: 'document:docs/report.md:r7', at: '2026-09-22T02:00:00Z',
    artifact: { kind: 'document', ref: 'docs/report.md', revision: 'r7' }, previewRef: { kind: 'text/diff', ref: 'docs/report.md',
      revision: 'r7' } })
  expect(tasks.get('impl')!.review).toMatchObject({ deliverables: [{ key: 'document:docs/report.md:r7' }], criteria: [], confirmations: [] })
  expect(tasks.get('review')).toMatchObject({ kind: 'review', reviewedTicketId: 'impl', form: 'tracked', deliverables: [] })
  expect(tasks.get('review')).not.toHaveProperty('review')
  expect(tasks.get('light')).toMatchObject({ kind: 'ticket', form: 'lightweight', status: 'working', execution: { assignments: 0 },
    inline: { steps: 2, traceId: lightTrace } })
  expect(tasks.get('light')).not.toHaveProperty('review')
  expect(tasks.get('light')!.deliverables).toEqual([])
})

it('omits review and deliverables when a Ticket has no previewed delivery', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const reportOnly = ticket({ id: 'plain', title: '只写报告', assignments: [assignment('没有可审的交付')] })
  seed(store, [reportOnly])
  const task = taskBoard(host(store)).tasks[0]!
  expect(task).not.toHaveProperty('review')
  expect(task.deliverables).toEqual([])
  expect(task.execution.assignments).toBe(1)
})

it('marks a live person stage as attention and carries the latest event time', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const blocked = ticket({ id: 'blocked', title: '等待决定', assignments: [{ id: 'a1', state: 'running',
    createdAt: '2026-09-22T01:00:00Z', report: { state: 'blocked', summary: '需要一个人决定', at: '2026-09-22T02:00:00Z' } }] })
  seed(store, [blocked])
  store.activity.record({ at: '2026-09-22T02:00:00Z', event: 'assignment.ended', level: 'feed', summary: 'blocked', ticket: 'blocked',
    status: 'blocked' })
  const task = taskBoard(host(store), new Date('2026-09-22T12:00:00Z')).tasks[0]!
  expect(task).toMatchObject({ status: 'blocked', attention: true, lastEventAt: '2026-09-22T02:00:00Z' })
})

it('keeps a review without a known owner as its own row and never fakes a reviewedTicketId', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const unowned = ticket({ id: 'review', title: '复核 PR #9：双父工单（T2-03）',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' },
      scope: '对 PR #9（T2-03）做复核' } })
  seed(store, [unowned])
  const task = taskBoard(host(store)).tasks[0]!
  expect(task.kind).toBe('review')
  expect(task).not.toHaveProperty('reviewedTicketId')
})
