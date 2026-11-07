import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Assignment, DomainEvent, Ticket } from '@superagent/kernel'
import { Store } from '@superagent/dsh/app/store.ts'
import { ActivityLog, activityFeed, endCoveredBy, gradeEvent } from '@superagent/dsh/app/activity.ts'
import { eventNotice } from '@superagent/dsh/app/notices.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-activity-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** One domain event, with only the fields its grader reads. */
const event = <K extends DomainEvent['type']>(type: K, data: Extract<DomainEvent, { type: K }>['data'], at = '2026-01-01T00:00:01Z'): DomainEvent =>
  ({ type, at, data }) as DomainEvent
const report = (state: 'ready' | 'blocked' | 'dropped' | 'progress'): Assignment['report'] => ({ state, summary: 'x', at: '2026-01-01T00:00:02Z' })
const ticket = (ended: Ticket['ended'], assignments: Assignment[] = []): Ticket => ({
  id: 't1', title: 'Fix', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
    actor: { source: 'feishu', id: 'u1' }, scope: '' }, channels: [], ended, assignments, inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: 'x', triggerIds: ['x'] },
})

it('grades each domain event by who it may disturb, and keeps quiet stages out of the operator feed', () => {
  expect(gradeEvent(event('trigger.received', { triggerId: 'x', threads: [] }), undefined)).toMatchObject({ level: 'feed', summary: 'Trigger x received' })
  expect(gradeEvent(event('eval.started', { evalId: 'e1', threadKey: 'feishu:oc:om', triggerIds: ['x'], strength: 'inferred' }), undefined))
    .toMatchObject({ level: 'quiet', thread: 'feishu:oc:om' })
  expect(gradeEvent(event('assignment.started', { ticketId: 't1', assignmentId: 'a1' }), undefined)).toMatchObject({ level: 'quiet', ticket: 't1' })
  expect(gradeEvent(event('ticket.created', { ticketId: 't1', decisionId: 'd1', strength: 'explicit' }), undefined)).toMatchObject({ level: 'feed', ticket: 't1' })
  expect(gradeEvent(event('trigger.requeued', { triggerId: 'x' }), undefined)).toMatchObject({ level: 'notice' })
  expect(gradeEvent(event('thread.unsubscribed', { threadKey: 'github:1', ticketId: 't1', by: 'person' }), undefined))
    .toMatchObject({ level: 'notice', thread: 'github:1' })
  expect(gradeEvent(event('policy.changed', { from: 'a', to: 'b' }), undefined)).toMatchObject({ level: 'quiet' })
})

it('counts a ticket end as already told when its latest report was terminal or a person ended it', () => {
  expect(endCoveredBy(ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'completed' }, [{ id: 'a1', state: 'ended', createdAt: '', report: report('ready') }])))
    .toBe('report')
  expect(endCoveredBy(ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'dropped' }, [{ id: 'a1', state: 'ended', createdAt: '', report: report('dropped') }])))
    .toBe('report')
  expect(endCoveredBy(ticket({ at: '2026-01-01T00:00:03Z', by: 'human', outcome: 'stopped' }, [{ id: 'a1', state: 'ended', createdAt: '', report: report('blocked') }])))
    .toBe('human')
  // A blocked report is a request for a person; the end that follows is news, and a report after the latest one clears the coverage.
  expect(endCoveredBy(ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'closed' }, [{ id: 'a1', state: 'ended', createdAt: '', report: report('blocked') }])))
    .toBeUndefined()
  expect(endCoveredBy(ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'closed' }, [{ id: 'a1', state: 'ended', createdAt: '', report: report('ready') },
    { id: 'a2', state: 'ended', createdAt: '', report: report('blocked') }]))).toBeUndefined()
  const end = event('ticket.ended', { ticketId: 't1', by: 'executor', outcome: 'completed' })
  expect(gradeEvent(end, ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'completed' },
    [{ id: 'a1', state: 'ended', createdAt: '', report: report('ready') }]))).toMatchObject({ level: 'feed', suppressed: 'report', ticket: 't1' })
  // The same end without a terminal report is a notice.
  expect(gradeEvent(end, ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'completed' }, []))).toMatchObject({ level: 'notice' })
})

it('persists graded events with a monotonic cursor, filters by minimum level, and survives reopen', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  const log = new ActivityLog(store)
  store.tickets.save(ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'completed' },
    [{ id: 'a1', state: 'ended', createdAt: '', report: report('ready') }]))
  const first = log.record(event('trigger.received', { triggerId: 'x', threads: [] }))
  const second = log.record(event('eval.started', { evalId: 'e1', threadKey: 'feishu:oc:om', triggerIds: ['x'], strength: 'inferred' }))
  const third = log.record(event('ticket.ended', { ticketId: 't1', by: 'executor', outcome: 'completed' }))
  expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3])
  expect(third).toMatchObject({ event: 'ticket.ended', level: 'feed', suppressed: 'report', ticket: 't1' })
  // Newest first for a fresh reader; `after` resumes oldest first, and `feed` drops the quiet evaluation stage.
  expect(log.feed(0).items.map(item => item.seq)).toEqual([3, 2, 1])
  expect(log.feed(0, 50, 'feed').items.map(item => item.seq)).toEqual([3, 1])
  expect(log.feed(first.seq).items.map(item => item.seq)).toEqual([2, 3])
  expect(log.feed(0).latest).toBe(3)
  store.close()
  const reopened = new Store(path)
  expect(activityFeed(reopened.activity, 0).items.map(item => item.event)).toEqual(['ticket.ended', 'eval.started', 'trigger.received'])
  expect(reopened.activity.latest()).toBe(3)
  reopened.close()
})

it('keeps the newest 5,000 records so the feed cannot grow without limit', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (let index = 0; index < 5100; index++) store.activity.record({ at: '2026-01-01T00:00:01Z', event: 'trigger.received', level: 'feed',
    summary: `Trigger ${index} received`, data: { triggerId: String(index), threads: [] } })
  expect(store.activity.latest()).toBe(5100)
  expect(store.activity.after(0, 10_000)).toHaveLength(5000)
  expect(store.activity.after(0, 1)).toEqual([expect.objectContaining({ seq: 101 })])
  store.close()
})

it('does not send a second notice for an end its report already covered, and still sends one for an uncovered end', () => {
  const covered = ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'completed' },
    [{ id: 'a1', state: 'ended', createdAt: '', report: report('ready') }])
  expect(eventNotice(event('ticket.ended', { ticketId: 't1', by: 'executor', outcome: 'completed' }), () => covered)).toBeUndefined()
  const uncovered = ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'closed' },
    [{ id: 'a1', state: 'ended', createdAt: '', report: report('blocked') }])
  expect(eventNotice(event('ticket.ended', { ticketId: 't1', by: 'executor', outcome: 'closed' }), () => uncovered))
    .toMatchObject([expect.any(String), { ticket_ended: { ticket_id: 't1', state: 'closed' } }, 'Ticket t1 ended (closed)'])
  // An ending whose Ticket is already gone cannot be proven covered, so it stays a notice.
  expect(eventNotice(event('ticket.ended', { ticketId: 'gone', by: 'executor', outcome: 'completed' }))).toBeDefined()
})