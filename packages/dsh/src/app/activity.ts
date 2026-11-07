/** Grades domain events for the system view and the single-notification budget. */
import type { DomainEvent, Ticket } from '@superagent/kernel'
import type { Store } from './store.ts'

/**
 * How far one recorded event may reach:
 * - `quiet` is stored for audit only and never shown in the system view;
 * - `feed` is shown there, and never notifies the main Session;
 * - `notice` is delivered to the main Session unless the budget suppresses it.
 */
export type ActivityLevel = 'quiet' | 'feed' | 'notice'

/** One graded domain event, as persisted in the `activity` table. */
export interface ActivityRecord {
  /** Monotonic SQLite row id; an incremental reader asks for what came after the last one it saw. */
  seq: number
  at: string
  event: DomainEvent['type']
  level: ActivityLevel
  summary: string
  ticket?: string
  thread?: string
  data: Record<string, unknown>
  /** Why a `notice`-worthy event stayed in the feed: its Ticket's latest report or a person's own action already said it. */
  suppressed?: 'report' | 'human'
}

/** One page of the activity feed and the two cursors a reader needs. */
export interface ActivityFeed {
  items: ActivityRecord[]
  /** The highest stored sequence, for unread counts and for noticing a backlog. */
  latest: number
  /** The next `after`: the head after a first load, else the last sequence this page returned. Poll again while it is below `latest`. */
  next: number
}

/**
 * Whether a Ticket's end was already told to a person: its latest Assignment reported a terminal result (`ready` or
 * `dropped`), or the person ended it themselves. Only the latest Assignment counts: a Ticket resumed after an earlier
 * terminal report now waits for new work, so its later end is news again. Such an end is recorded in the feed but must not
 * produce a second notification.
 * @returns Why it was covered, or `undefined` when the end is news.
 */
export function endCoveredBy(ticket: Pick<Ticket, 'assignments' | 'ended'>): 'report' | 'human' | undefined {
  if (ticket.ended?.by === 'human') return 'human'
  const report = ticket.assignments.at(-1)?.report
  return report && (report.state === 'ready' || report.state === 'dropped') ? 'report' : undefined
}

/**
 * Grades one domain event for the system view. The level answers who may be disturbed, not whether the event is worth
 * keeping: every event is recorded, and a reader filters by level.
 * @param event - the Engine's event.
 * @param ticket - the ticket an event names, when it names one.
 * @returns The record without its storage sequence.
 */
export function gradeEvent(event: DomainEvent, ticket: Ticket | undefined): Omit<ActivityRecord, 'seq'> {
  const at = event.at
  const base = { at, event: event.type, data: event.data as Record<string, unknown> }
  switch (event.type) {
    case 'trigger.received':
      return { ...base, level: 'feed', summary: `Trigger ${event.data.triggerId} received` }
    case 'eval.started':
      return { ...base, level: 'quiet', thread: event.data.threadKey, summary: `Evaluation ${event.data.evalId} started` }
    case 'decision.recorded':
      return { ...base, level: 'feed', thread: event.data.threadKey, summary: `Decision ${event.data.decisionId} (${event.data.kind})` }
    case 'ticket.created':
      return { ...base, level: 'feed', ticket: event.data.ticketId, summary: `Ticket ${event.data.ticketId} created` }
    case 'ticket.resumed':
      return { ...base, level: 'feed', ticket: event.data.ticketId, summary: `Ticket ${event.data.ticketId} resumed by ${event.data.triggerId}` }
    case 'ticket.ended': {
      const { ticketId, outcome } = event.data
      const suppression = ticket ? endCoveredBy(ticket) : undefined
      return { ...base, level: suppression ? 'feed' : 'notice', ticket: ticketId, summary: `Ticket ${ticketId} ended (${event.data.reason ?? outcome})`,
        ...suppression ? { suppressed: suppression } : {} }
    }
    case 'assignment.started':
      return { ...base, level: 'quiet', ticket: event.data.ticketId, summary: `Assignment ${event.data.assignmentId} started on ${event.data.ticketId}` }
    case 'assignment.ended':
      return { ...base, level: 'quiet', ticket: event.data.ticketId, summary: `Assignment ${event.data.assignmentId} ended on ${event.data.ticketId}: ${event.data.reason}` }
    case 'thread.subscribed':
      return { ...base, level: 'quiet', ticket: event.data.ticketId, thread: event.data.threadKey, summary: `Ticket ${event.data.ticketId} subscribed to ${event.data.threadKey}` }
    case 'thread.unsubscribed':
      return { ...base, level: 'notice', ticket: event.data.ticketId, thread: event.data.threadKey,
        summary: `Ticket ${event.data.ticketId} unsubscribed from ${event.data.threadKey} (${event.data.by})` }
    case 'trigger.requeued':
      return { ...base, level: 'notice', summary: `Trigger ${event.data.triggerId} queued for a fresh assessment` }
    case 'trigger.followup':
      return { ...base, level: 'quiet', summary: `Trigger ${event.data.triggerId} left the follow-up queue` }
    case 'policy.changed':
      return { ...base, level: 'quiet', summary: `Policy changed from ${event.data.from} to ${event.data.to}` }
  }
}

/**
 * Reads one page of records. A first load (`after` 0) returns the newest page and starts the reader at the head; a later
 * load returns records after the cursor oldest first and advances to the last one, so a backlog is paged without gaps.
 */
export function activityFeed(read: Pick<Store['activity'], 'latest' | 'after' | 'recent'>, after: number, limit = 50, level?: ActivityLevel): ActivityFeed {
  const latest = read.latest()
  if (after <= 0) return { items: read.recent(limit, level), latest, next: latest }
  const items = read.after(after, limit, level)
  return { items, latest, next: items.at(-1)?.seq ?? after }
}

/** Persists graded events and answers the system view and the future realtime reader. */
export class ActivityLog {
  constructor(private readonly store: Pick<Store, 'activity' | 'tickets'>) {}

  /** Grades `event` and records it in the current transaction, returning the stored record. */
  record(event: DomainEvent): ActivityRecord {
    const ticketId = 'ticketId' in event.data ? String(event.data.ticketId) : undefined
    return this.store.activity.record(gradeEvent(event, ticketId === undefined ? undefined : this.store.tickets.get(ticketId)))
  }
}
