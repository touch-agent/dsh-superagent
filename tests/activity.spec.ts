import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Assignment, Decision, DomainEvent, Thread, Ticket, Trigger } from '@superagent/kernel'
import { Store } from '@superagent/dsh/app/store.ts'
import { ActivityLog, activityFeed, activityStatusOf, endCoveredBy, gradeEvent, presentActivity, type ActivityLookup } from '@superagent/dsh/app/activity.ts'
import { eventNotice } from '@superagent/dsh/app/notices.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-activity-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** One domain event, with only the fields its grader reads. */
const event = <K extends DomainEvent['type']>(type: K, data: Extract<DomainEvent, { type: K }>['data'], at = '2026-01-01T00:00:01Z'): DomainEvent =>
  ({ type, at, data }) as DomainEvent
const report = (state: 'ready' | 'blocked' | 'failed' | 'dropped' | 'progress'): Assignment['report'] => ({ state, summary: 'x', at: '2026-01-01T00:00:02Z' })
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
  expect(gradeEvent(event('assignment.ended', { ticketId: 't1', assignmentId: 'a1', reason: 'ready' }), undefined)).toMatchObject({ level: 'quiet', ticket: 't1' })
  expect(gradeEvent(event('decision.recorded', { decisionId: 'd1', kind: 'accept', threadKey: 'feishu:oc:om' }), undefined))
    .toMatchObject({ level: 'feed', thread: 'feishu:oc:om', subject: { kind: 'decision', id: 'd1' }, detail: { decision: 'accept' } })
  expect(gradeEvent(event('ticket.created', { ticketId: 't1', decisionId: 'd1', strength: 'explicit' }), undefined))
    .toMatchObject({ level: 'feed', ticket: 't1', subject: { kind: 'ticket', id: 't1' } })
  expect(gradeEvent(event('ticket.resumed', { ticketId: 't1', triggerId: 'x' }), undefined)).toMatchObject({ level: 'feed', ticket: 't1' })
  expect(gradeEvent(event('thread.subscribed', { threadKey: 'github:1', ticketId: 't1' }), undefined)).toMatchObject({ level: 'quiet', thread: 'github:1' })
  expect(gradeEvent(event('trigger.requeued', { triggerId: 'x' }), undefined)).toMatchObject({ level: 'notice',
    subject: { kind: 'trigger', id: 'x' } })
  expect(gradeEvent(event('trigger.followup', { triggerId: 'x' }), undefined)).toMatchObject({ level: 'quiet' })
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
  // A resume starts a new Assignment; until it reports, an earlier ready report no longer covers the Ticket's next end.
  const resumed = ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'closed' },
    [{ id: 'a1', state: 'ended', createdAt: '', report: report('ready') }, { id: 'a2', state: 'running', createdAt: '' }])
  expect(endCoveredBy(resumed)).toBeUndefined()
  expect(gradeEvent(end, resumed)).toMatchObject({ level: 'notice' })
  expect(eventNotice(end, () => resumed)).toBeDefined()
})

it('persists graded events with a monotonic cursor, filters by minimum level, and survives reopen', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  const log = new ActivityLog(store)
  store.tickets.save(ticket({ at: '2026-01-01T00:00:03Z', by: 'executor', outcome: 'completed' },
    [{ id: 'a1', state: 'ended', createdAt: '', report: report('ready') }]))
  expect(store.tickets.byTrigger('x')).toMatchObject({ id: 't1' })
  expect(store.tickets.byTrigger('missing')).toBeUndefined()
  const first = log.record(event('trigger.received', { triggerId: 'x', threads: [] }))
  const second = log.record(event('eval.started', { evalId: 'e1', threadKey: 'feishu:oc:om', triggerIds: ['x'], strength: 'inferred' }))
  const third = log.record(event('ticket.ended', { ticketId: 't1', by: 'executor', outcome: 'completed' }))
  expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3])
  expect(third).toMatchObject({ event: 'ticket.ended', level: 'feed', suppressed: 'report', ticket: 't1' })
  // Newest first for a fresh reader; `after` resumes oldest first, and `feed` drops the quiet evaluation stage.
  expect(activityFeed(store.activity, 0).items.map(item => item.seq)).toEqual([3, 2, 1])
  expect(activityFeed(store.activity, 0, 50, 'feed').items.map(item => item.seq)).toEqual([3, 1])
  expect(activityFeed(store.activity, first.seq).items.map(item => item.seq)).toEqual([2, 3])
  expect(activityFeed(store.activity, 0)).toMatchObject({ latest: 3, next: 3 })
  expect(activityFeed(store.activity, first.seq)).toMatchObject({ latest: 3, next: 3 })
  store.close()
  const reopened = new Store(path)
  expect(activityFeed(reopened.activity, 0).items.map(item => item.event)).toEqual(['ticket.ended', 'eval.started', 'trigger.received'])
  expect(reopened.activity.latest()).toBe(3)
  reopened.close()
})

it('pages a backlog through `next` without skipping records, and filters to notices only', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (let index = 0; index < 5; index++) store.activity.record({ at: '2026-01-01T00:00:01Z', event: 'trigger.received', level: 'feed',
    summary: `Trigger ${index} received` })
  store.activity.record({ at: '2026-01-01T00:00:02Z', event: 'trigger.requeued', level: 'notice', summary: 'Trigger x queued' })
  const first = activityFeed(store.activity, 1, 2)
  expect(first.items.map(item => item.seq)).toEqual([2, 3])
  expect(first.next).toBe(3)
  const second = activityFeed(store.activity, first.next, 2)
  expect(second.items.map(item => item.seq)).toEqual([4, 5])
  expect(second.next).toBe(5)
  expect(activityFeed(store.activity, second.next, 2).items.map(item => item.seq)).toEqual([6])
  expect(activityFeed(store.activity, 0, 50, 'notice').items.map(item => item.event)).toEqual(['trigger.requeued'])
  store.close()
})

it('keeps the head at the requested level, so a quiet event is not a false backlog', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.activity.record({ at: '2026-01-01T00:00:01Z', event: 'trigger.received', level: 'feed', summary: 'Trigger 1 received' })
  store.activity.record({ at: '2026-01-01T00:00:02Z', event: 'eval.started', level: 'quiet', summary: 'Evaluation e started' })
  expect(activityFeed(store.activity, 0, 50, 'feed')).toMatchObject({ latest: 1, next: 1 })
  expect(activityFeed(store.activity, 1, 50, 'feed')).toMatchObject({ items: [], latest: 1, next: 1 })
  expect(activityFeed(store.activity, 0, 50, 'notice')).toMatchObject({ latest: 0, next: 0 })
  store.activity.record({ at: '2026-01-01T00:00:03Z', event: 'trigger.requeued', level: 'notice', summary: 'Trigger x queued' })
  expect(activityFeed(store.activity, 0, 50, 'notice')).toMatchObject({ latest: 3, next: 3 })
  expect(store.activity.latest()).toBe(3)
  store.close()
})

it('rolls activity back with the transaction that emitted it', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  expect(() => store.atomic(() => { store.activity.record({ at: '2026-01-01T00:00:01Z', event: 'trigger.received', level: 'feed',
    summary: 'Trigger x received' }); throw new Error('rollback') })).toThrow('rollback')
  expect(store.activity.latest()).toBe(0)
  store.close()
})

it('keeps the newest 5,000 records so the feed cannot grow without limit', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  for (let index = 0; index < 5100; index++) store.activity.record({ at: '2026-01-01T00:00:01Z', event: 'trigger.received', level: 'feed',
    summary: `Trigger ${index} received` })
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

/** The Trigger a Ticket was accepted from, its Thread and the Ticket's task, for the presentation tests. */
const origin: Trigger = { id: 'x', source: 'feishu', threads: [{ source: 'github', id: '8' }],
  actor: { source: 'feishu', id: 'u1' }, human: true, addressed: 'mention', at: '2026-01-01T00:00:00Z', text: 'Fix the events tab', meta: {} }
const parentThread: Thread = { key: 'github:8', ref: { source: 'github', id: '8' }, createdAt: '2026-01-01T00:00:00Z',
  subscriptions: ['t1'], correlated: [], pending: [], meta: { label: '#8 Events tab', facts: { number: { value: '#8' } } } }
const decision: Decision = { id: 'd1', evalId: 'e1', ticketId: 't1', kind: 'accept', strength: 'explicit', threadKey: 'github:8',
  triggerIds: ['x'], reason: [], policyVersion: 'v', at: '2026-01-01T00:00:00Z',
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'u1' }, scope: '' } }
const ownerTicket = { ...ticket(undefined), createdAt: '2026-01-01T00:00:00Z' }
const lookup: ActivityLookup = { ticket: id => id === 't1' ? ownerTicket : undefined,
  ticketForTrigger: id => id === 'x' ? ownerTicket : undefined,
  thread: key => key === 'github:8' ? parentThread : undefined, trigger: id => id === 'x' ? origin : undefined,
  decision: id => id === 'd1' ? decision : undefined, firstTrigger: () => origin }

it('presents an event with its task, origin, readable state and time since the task started', () => {
  const owner = { ...ticket({ at: '2026-01-01T00:10:00Z', by: 'executor', outcome: 'merged' }), createdAt: '2026-01-01T00:00:00Z' }
  const record = { seq: 1, ...gradeEvent(event('ticket.ended', { ticketId: 't1', by: 'executor', outcome: 'merged' }, '2026-01-01T00:10:00Z'), owner) }
  const presented = presentActivity(record, { ...lookup, ticket: () => owner })
  expect(presented.status).toBe('done')
  expect(presented.sinceStartMs).toBe(600_000)
  expect(presented.detail).toMatchObject({ outcome: 'merged' })
  expect(presented.subject).toEqual({ kind: 'ticket', id: 't1' })
  expect(presented.task).toMatchObject({ id: 't1', title: 'Fix', status: 'done',
    parent: { kind: 'thread', id: 'github:8', source: 'github', label: '#8 Events tab' } })
})

it('presents a row stored before subjects and details existed, from its Ticket, Thread and summary', () => {
  const finished = { ...ticket({ at: '2026-01-01T00:10:00Z', by: 'executor', outcome: 'merged' }), createdAt: '2026-01-01T00:00:00Z' }
  const ended = { seq: 9, at: '2026-01-01T00:10:00Z', event: 'ticket.ended' as const, level: 'notice' as const,
    summary: 'Ticket t1 ended (merged)', ticket: 't1' }
  expect(presentActivity(ended, { ...lookup, ticket: () => finished })).toMatchObject({ status: 'done',
    subject: { kind: 'ticket', id: 't1' }, detail: { outcome: 'merged' } })
  // A trigger row before the trigger id was stored still names the object and reads its preview from the summary.
  const received = { seq: 10, at: '2026-01-01T00:00:00Z', event: 'trigger.received' as const, level: 'feed' as const,
    summary: 'Trigger x received' }
  // The intake row joins the Ticket its Decision created instead of leaving a Thread group beside it.
  expect(presentActivity(received, lookup)).toMatchObject({ status: 'queued', subject: { kind: 'trigger', id: 'x' },
    thread: 'github:8', detail: { trigger: { source: 'feishu', preview: 'Fix the events tab' } },
    task: { id: 't1', title: 'Fix', status: 'queued',
      parent: { kind: 'thread', id: 'github:8', source: 'github', label: '#8 Events tab' } } })
})

it('keeps an earlier ending when its ticket was resumed and ended again', () => {
  const record = { seq: 11, ...gradeEvent(event('ticket.ended', { ticketId: 't1', by: 'executor', outcome: 'completed' }, '2026-01-01T00:10:00Z'),
    { ...ownerTicket, ended: { at: '2026-01-01T00:10:00Z', by: 'executor', outcome: 'completed' } }) }
  // The live ticket now records the later, failed end; the stored row still reads as the completed end it recorded.
  const live = { ...ownerTicket, ended: { at: '2026-01-02T00:10:00Z', by: 'executor' as const, outcome: 'closed' as const } }
  expect(presentActivity(record, { ...lookup, ticket: () => live, ticketForTrigger: undefined }))
    .toMatchObject({ status: 'done', detail: { outcome: 'completed' }, task: { status: 'failed' } })
  // A legacy row parses its own summary even when the live ticket has a different ending.
  const legacy = { seq: 12, at: '2026-01-01T00:10:00Z', event: 'ticket.ended' as const, level: 'notice' as const,
    summary: 'Ticket t1 ended (completed)', ticket: 't1' }
  expect(presentActivity(legacy, { ...lookup, ticket: () => live })).toMatchObject({ status: 'done', detail: { outcome: 'completed' } })
})

it('gives a legacy unsubscribe row its Thread subject and completes legacy trigger notices', () => {
  const unsubscribed = { seq: 13, at: '2026-01-01T00:00:00Z', event: 'thread.unsubscribed' as const, level: 'notice' as const,
    summary: 'Ticket t1 unsubscribed from github:8 (person)', ticket: 't1', thread: 'github:8' }
  expect(presentActivity(unsubscribed, lookup)).toMatchObject({ subject: { kind: 'thread', id: 'github:8', source: 'github',
    label: '#8 Events tab' }, status: 'done' })
  const requeued = { seq: 14, at: '2026-01-01T00:00:00Z', event: 'trigger.requeued' as const, level: 'notice' as const,
    summary: 'Trigger x queued for a fresh assessment' }
  expect(presentActivity(requeued, lookup)).toMatchObject({ status: 'blocked', subject: { kind: 'trigger', id: 'x' },
    thread: 'github:8', detail: { trigger: { source: 'feishu', preview: 'Fix the events tab' } }, task: { id: 't1' } })
})

it('maps every person stage to its own state', () => {
  const base = ticket(undefined)
  expect(activityStatusOf({ ...base, attention: { id: 'q', question: 'Which?' } })).toBe('answer')
  expect(activityStatusOf({ ...base, delivery: { error: 'missing worktree', at: '2026-01-01T00:00:00Z' } })).toBe('delivery')
  expect(activityStatusOf({ ...base, assignments: [{ id: 'a1', state: 'ended', createdAt: '', report: report('ready') }] })).toBe('review')
  expect(activityStatusOf({ ...base, assignments: [{ id: 'a1', state: 'ended', createdAt: '', report: report('blocked') }] })).toBe('blocked')
  expect(activityStatusOf({ ...base, assignments: [{ id: 'a1', state: 'ended', createdAt: '', report: report('failed') }] })).toBe('failed')
  expect(activityStatusOf({ ...base, assignments: [{ id: 'a1', state: 'pending', createdAt: '' }] })).toBe('queued')
  expect(activityStatusOf({ ...base, assignments: [{ id: 'a1', state: 'running', createdAt: '', startedAt: '' }] })).toBe('working')
  expect(activityStatusOf({ ...base, assignments: [{ id: 'a1', state: 'ended', createdAt: '', report: report('progress') }] })).toBe('idle')
  expect(activityStatusOf({ ...base, ended: { at: '', by: 'executor', outcome: 'completed' } })).toBe('done')
  expect(activityStatusOf({ ...base, ended: { at: '', by: 'executor', outcome: 'closed' } })).toBe('failed')
})

it('completes a feed page only when the reader provides the domain lookup', () => {
  const read = { latest: () => 1, recent: () => [{ seq: 1, at: '2026-01-01T00:00:00Z', event: 'trigger.received' as const,
    level: 'feed' as const, summary: 'Trigger x received' }], after: () => [] }
  expect(activityFeed(read, 0).items[0]?.task).toBeUndefined()
  expect(activityFeed(read, 0, 50, undefined, lookup).items[0]?.task).toMatchObject({ id: 't1' })
})
