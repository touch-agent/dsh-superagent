/** Grades domain events for the system view and the single-notification budget, and presents each one for the Events tab. */
import { latestAssignment, threadKey, ticketStage, type Decision, type DomainEvent, type Localized, type Thread, type Ticket,
  type TicketOutcome, type Trigger } from '@superagent/kernel'
import { ownershipIndex, type OwnershipIndex } from './ownership.ts'
import { preview } from './views/text.ts'

/**
 * How far one recorded event may reach:
 * - `quiet` is stored for audit only and never shown in the system view;
 * - `feed` is shown there, and never notifies the main Session;
 * - `notice` is delivered to the main Session unless the budget suppresses it.
 */
export type ActivityLevel = 'quiet' | 'feed' | 'notice'

/** How the work an event belongs to stands, in the words a person acts on. */
export type ActivityStatus = 'queued' | 'working' | 'idle' | 'review' | 'answer' | 'delivery' | 'blocked' | 'failed' | 'done'

/** What an event is about: a Ticket, Thread, Trigger, Decision or the Policy, with enough to label and open it. */
export interface ActivitySubject {
  kind: 'ticket' | 'thread' | 'trigger' | 'decision' | 'policy'
  /** The Ticket id, Thread key, Trigger id, Decision id or Policy version. */
  id: string
  /** The Source that owns a Thread or Trigger, such as `github` or `feishu`. */
  source?: string
  /** A short name the Source gives the object, such as `#8` or a chat name; the panel localizes a `Localized` one. */
  label?: Localized | string
}

/** The task an event belongs to, and the Thread it was accepted from. */
export interface ActivityTask {
  /** The Ticket id, or the Thread key for work no Ticket owns yet. */
  id: string
  /** The Ticket's title, or the Thread's name for work no Ticket owns yet. */
  title: string
  /** How the task stands when the feed is read. */
  status: ActivityStatus
  /** The Ticket's originating Thread, such as the pull request or conversation it was accepted from. */
  parent?: ActivitySubject
}

/** Immutable event facts the Events tab turns into its title in the interface language. */
export interface ActivityDetail {
  outcome?: TicketOutcome
  decision?: Decision['kind']
  reason?: string
  trigger?: { source?: string; preview?: string }
}

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
  /** Why a `notice`-worthy event stayed in the feed: its Ticket's latest Assignment reported the outcome, or a person ended it. */
  suppressed?: 'report' | 'human'
  /** The object the event is about, graded with the event; an older row derives it when the feed is read. */
  subject?: ActivitySubject
  /** Immutable facts of the event, graded with it; an older row derives what it can when the feed is read. */
  detail?: ActivityDetail & { childTicketId?: string }
  /** The task the event belongs to and its current state, resolved by the feed reader. */
  task?: ActivityTask
  /** The state this event itself recorded, which can trail the task's current state. */
  status?: ActivityStatus
  /** Milliseconds from the task's start to this event, when the event belongs to a Ticket. */
  sinceStartMs?: number
}

/** One page of the activity feed and the two cursors a reader needs. */
export interface ActivityFeed {
  items: ActivityRecord[]
  /** The highest sequence at the requested level, for unread counts and for noticing a backlog. */
  latest: number
  /** The next `after`: the head after a first load, else the last sequence this page returned. Poll again while it is below `latest`. */
  next: number
}

/** The activity persistence an `ActivityLog` needs; `Store` implements it. */
interface ActivityStore {
  activity: { record: (record: Omit<ActivityRecord, 'seq'>) => ActivityRecord }
  tickets: { get: (id: string) => Ticket | undefined }
  triggers: { get: (id: string) => Trigger | undefined }
}

/** The read side `activityFeed` needs; `Store.activity` implements it. */
interface ActivityRead {
  latest: (level?: ActivityLevel) => number
  after: (after: number, limit: number, level?: ActivityLevel) => ActivityRecord[]
  recent: (limit: number, level?: ActivityLevel) => ActivityRecord[]
}

/** The domain reads a feed page resolves names, states and jump targets through; `Store` implements them. */
export interface ActivityLookup {
  ticket: (id: string) => Ticket | undefined
  /** The Ticket a Trigger created, so an intake row joins the task its Decision went on to make. */
  ticketForTrigger?: (id: string) => Ticket | undefined
  thread: (key: string) => Thread | undefined
  trigger: (id: string) => Trigger | undefined
  decision: (id: string) => Decision | undefined
  firstTrigger: (key: string) => Trigger | undefined
  /** One request's Ticket placement, shared with the Tickets board; omitted by partial test doubles. */
  ownership?: OwnershipIndex
}

/** The Store reads behind an `ActivityLookup`; optional chaining keeps a partial test double from failing a read. */
export interface ActivityStoreReads {
  tickets: { get: (id: string) => Ticket | undefined; list?: () => Ticket[]; byTrigger?: (id: string) => Ticket | undefined }
  threads: { get: (key: string) => Thread | undefined }
  triggers: { get: (id: string) => Trigger | undefined }
  decisions: { get: (id: string) => Decision | undefined }
  read: { firstTrigger: (key: string) => Trigger | undefined }
}
/** Bind an `ActivityLookup` to a Store, so every feed page can name its objects without the routes passing four readers. */
export function activityLookup(store: ActivityStoreReads): ActivityLookup {
  return { ticket: id => store.tickets?.get(id), ticketForTrigger: id => store.tickets?.byTrigger?.(id),
    thread: key => store.threads?.get(key), trigger: id => store.triggers?.get(id),
    decision: id => store.decisions?.get(id), firstTrigger: key => store.read?.firstTrigger(key),
    ...store?.tickets?.list ? { ownership: ownershipIndex(store.tickets.list()) } : {} }
}

/**
 * Whether a Ticket's end was already told to a person: its latest Assignment reported a terminal result (`ready` or
 * `dropped`), or the person ended it themselves. Only the latest Assignment counts: a Ticket resumed after an earlier
 * terminal report now waits for new work, so its later end is news again. Such an end is recorded in the feed but must not
 * produce a second notification.
 * @returns Why it was covered, or `undefined` when the end is news.
 */
export function endCoveredBy(ticket: Ticket): 'report' | 'human' | undefined {
  if (ticket.ended?.by === 'human') return 'human'
  const report = latestAssignment(ticket)?.report
  return report && (report.state === 'ready' || report.state === 'dropped') ? 'report' : undefined
}

/** The state an ending leaves behind: an unmerged close or a stop is a failure, every other outcome is done. */
function endedStatus(outcome: TicketOutcome | undefined): ActivityStatus {
  return outcome === 'closed' || outcome === 'stopped' ? 'failed' : 'done'
}

/** The state a Ticket is in: ended Tickets are done unless their outcome is a failure, and a person's turn maps to its action. */
export function activityStatusOf(ticket: Ticket): ActivityStatus {
  const stage = ticketStage(ticket)
  switch (stage.stage) {
    case 'ended':
      return endedStatus(ticket.ended?.outcome)
    case 'person':
      return stage.action
    case 'working':
      return stage.action === 'queued' ? 'queued' : 'working'
    case 'idle':
      return 'idle'
  }
}

/** The state an event itself recorded, which for most events is the state of the work it started or resumed. */
function statusOf(event: ActivityRecord['event'], decision: Decision | undefined, ticket: Ticket | undefined): ActivityStatus {
  switch (event) {
    case 'trigger.received': return 'queued'
    case 'eval.started': return 'working'
    case 'decision.recorded': return decision?.kind === 'unavailable' ? 'blocked'
      : decision?.kind === 'ignore' || decision?.kind === 'stop' ? 'done' : 'queued'
    case 'ticket.created': return 'queued'
    case 'ticket.resumed': return 'working'
    case 'ticket.ended': return ticket ? activityStatusOf(ticket) : 'done'
    case 'assignment.started': return 'working'
    case 'assignment.ended': return 'working'
    case 'thread.subscribed': return 'working'
    case 'thread.unsubscribed': return 'done'
    case 'trigger.requeued': return 'blocked'
    case 'trigger.followup': return 'done'
    case 'policy.changed': return 'done'
    case 'ticket.delegated': return 'working'
    case 'ticket.child.reported': case 'ticket.child.reviewed': return ticket ? activityStatusOf(ticket) : 'working'
    case 'ticket.end.pending': return 'working'
    case 'ticket.child.orphaned': return 'blocked'
    case 'project.task.admitted': case 'project.worker.changed': return 'queued'
    case 'project.archived': return 'idle'
  }
}

/** The object a graded event names; a reader fills a Thread's Source and label from the Thread itself. */
function subjectOf(event: DomainEvent): ActivitySubject | undefined {
  switch (event.type) {
    case 'trigger.received': return { kind: 'trigger', id: event.data.triggerId }
    case 'eval.started': return { kind: 'thread', id: event.data.threadKey }
    case 'decision.recorded': return { kind: 'decision', id: event.data.decisionId }
    case 'ticket.created': case 'ticket.resumed': case 'ticket.ended': case 'assignment.started': case 'assignment.ended':
      return { kind: 'ticket', id: event.data.ticketId }
    case 'thread.subscribed': case 'thread.unsubscribed': return { kind: 'thread', id: event.data.threadKey }
    case 'trigger.requeued': case 'trigger.followup': return { kind: 'trigger', id: event.data.triggerId }
    case 'policy.changed': return { kind: 'policy', id: event.data.to }
    case 'ticket.delegated': return { kind: 'ticket', id: event.data.ticketId }
    case 'ticket.child.reported': case 'ticket.child.reviewed': return { kind: 'ticket', id: event.data.ticketId }
    case 'ticket.end.pending': return { kind: 'ticket', id: event.data.ticketId }
    case 'ticket.child.orphaned': return { kind: 'ticket', id: event.data.ticketId }
    case 'project.task.admitted': case 'project.worker.changed': return { kind: 'ticket', id: event.data.ticketId }
    case 'project.archived': return { kind: 'ticket', id: event.data.projectId }
  }
}

/** A Trigger's Thread and preview, when the grader could read it. */
function triggerDetail(trigger: Trigger | undefined): Pick<ActivityRecord, 'thread' | 'detail'> {
  if (!trigger) return {}
  const home = trigger.threads[0]
  const text = preview(trigger.text, 120)
  return { ...home ? { thread: threadKey(home) } : {}, detail: { trigger: { source: trigger.source, ...text ? { preview: text } : {} } } }
}

/**
 * Grades one domain event for the system view. The level answers who may be disturbed, not whether the event is worth
 * keeping: every event is recorded, and a reader filters by level.
 * @param event - the Engine's event.
 * @param ticket - the ticket an event names, when it names one.
 * @param trigger - the Trigger an event names, when the grader resolved it.
 * @returns The record without its storage sequence.
 */
export function gradeEvent(event: DomainEvent, ticket: Ticket | undefined, trigger?: Trigger): Omit<ActivityRecord, 'seq'> {
  const at = event.at
  const subject = subjectOf(event)
  // A child's events aggregate to its authorization root; the child id stays in the detail for the tree view.
  const childTicketId = ticket?.parentTicketId
  const childId = childTicketId ? ticket?.id : undefined
  const rootTicketId = childTicketId ? ticket?.rootTicketId ?? ticket?.id : undefined
  const taskTicket = (id: string) => rootTicketId ?? id
  const base = { at, event: event.type, ...subject ? { subject } : {}, ...childId ? { detail: { childTicketId: childId } } : {} }
  switch (event.type) {
    case 'trigger.received':
      return { ...base, level: 'feed', summary: `Trigger ${event.data.triggerId} received`, ...triggerDetail(trigger),
        ...!trigger && event.data.threads[0] ? { thread: event.data.threads[0] } : {} }
    case 'eval.started':
      return { ...base, level: 'quiet', thread: event.data.threadKey, summary: `Evaluation ${event.data.evalId} started` }
    case 'decision.recorded':
      return { ...base, level: 'feed', thread: event.data.threadKey, summary: `Decision ${event.data.decisionId} (${event.data.kind})`,
        detail: { decision: event.data.kind } }
    case 'ticket.created':
      return { ...base, level: 'feed', ticket: event.data.ticketId, summary: `Ticket ${event.data.ticketId} created` }
    case 'ticket.resumed':
      return { ...base, level: 'feed', ticket: event.data.ticketId, summary: `Ticket ${event.data.ticketId} resumed by ${event.data.triggerId}` }
    case 'ticket.ended': {
      const { ticketId, outcome, reason } = event.data
      const suppression = ticket ? endCoveredBy(ticket) : undefined
      // A child ticket's end is a parent-owner event, never a person's notification; only root ends reach the budget.
      const level = childTicketId ? 'quiet' : suppression ? 'feed' : 'notice'
      return { ...base, level, ticket: taskTicket(ticketId), summary: `Ticket ${ticketId} ended (${reason ?? outcome})`,
        detail: { childTicketId: childId, outcome, ...reason ? { reason } : {} }, ...suppression ? { suppressed: suppression } : {} }
    }
    case 'assignment.started':
      return { ...base, level: 'quiet', ticket: event.data.ticketId, summary: `Assignment ${event.data.assignmentId} started on ${event.data.ticketId}` }
    case 'assignment.ended':
      return { ...base, level: 'quiet', ticket: event.data.ticketId, summary: `Assignment ${event.data.assignmentId} ended on ${event.data.ticketId}: ${event.data.reason}`,
        detail: { reason: event.data.reason } }
    case 'thread.subscribed':
      return { ...base, level: 'quiet', ticket: event.data.ticketId, thread: event.data.threadKey, summary: `Ticket ${event.data.ticketId} subscribed to ${event.data.threadKey}` }
    case 'thread.unsubscribed':
      return { ...base, level: 'notice', ticket: event.data.ticketId, thread: event.data.threadKey,
        summary: `Ticket ${event.data.ticketId} unsubscribed from ${event.data.threadKey} (${event.data.by})` }
    case 'trigger.requeued':
      return { ...base, level: 'notice', summary: `Trigger ${event.data.triggerId} queued for a fresh assessment`, ...triggerDetail(trigger) }
    case 'trigger.followup':
      return { ...base, level: 'quiet', summary: `Trigger ${event.data.triggerId} left the follow-up queue`, ...triggerDetail(trigger) }
    case 'policy.changed':
      return { ...base, level: 'quiet', summary: `Policy changed from ${event.data.from} to ${event.data.to}` }
    case 'ticket.delegated':
      return { ...base, level: 'feed', ticket: taskTicket(event.data.parentTicketId), summary: `Child Ticket ${event.data.ticketId} delegated by ${event.data.parentTicketId}`,
        detail: { childTicketId: event.data.ticketId } }
    case 'ticket.child.reported':
      return { ...base, level: 'quiet', ticket: taskTicket(event.data.parentTicketId), summary: `Child Ticket ${event.data.ticketId} reported ${event.data.state}`,
        detail: { childTicketId: event.data.ticketId } }
    case 'ticket.child.reviewed':
      return { ...base, level: 'quiet', ticket: taskTicket(event.data.parentTicketId), summary: `Child Ticket ${event.data.ticketId} ${event.data.decision} by its parent owner`,
        detail: { childTicketId: event.data.ticketId } }
    case 'ticket.end.pending':
      return { ...base, level: 'feed', ticket: event.data.ticketId, summary: `Ticket ${event.data.ticketId} waits to end (${event.data.outcome})` }
    case 'ticket.child.orphaned':
      return { ...base, level: 'notice', ticket: taskTicket(event.data.parentTicketId), summary: `Child Ticket ${event.data.ticketId} orphaned: ${event.data.reason}`,
        detail: { childTicketId: event.data.ticketId, reason: event.data.reason } }
    case 'project.task.admitted':
      return { ...base, level: 'feed', ticket: event.data.ticketId, summary: `Project ${event.data.projectId} admitted Ticket ${event.data.ticketId}` }
    case 'project.worker.changed':
      return { ...base, level: 'quiet', ticket: event.data.ticketId, summary: `Project ${event.data.projectId} assigned Ticket ${event.data.ticketId} to ${event.data.profileId}` }
    case 'project.archived':
      return { ...base, level: 'feed', ticket: event.data.projectId, summary: `Project ${event.data.projectId} ${event.data.archived ? 'archived' : 'restored'}` }
  }
}

/** A fact's text, which a Source may write in one language or in both. */
function factText(value: unknown): Localized | string | undefined {
  if (typeof value === 'string') return value || undefined
  if (value && typeof value === 'object') {
    const local = value as Record<string, unknown>
    if (typeof local.zh === 'string' && typeof local.en === 'string') return { zh: local.zh, en: local.en }
  }
  return undefined
}

/** One named fact of a Thread, such as a pull request's `#8` or a chat's name. */
function threadFact(thread: Thread, id: string): Localized | string | undefined {
  const facts = thread.meta.facts as Record<string, unknown> | undefined
  const fact = facts?.[id]
  return fact && typeof fact === 'object' ? factText((fact as Record<string, unknown>).value) : undefined
}

/** A short badge name for a Thread: its number, published label, chat name, first message or key. */
function threadLabel(thread: Thread, lookup: ActivityLookup): Localized | string | undefined {
  const named = typeof thread.meta.label === 'string' ? preview(thread.meta.label, 60) : ''
  if (named) return named
  const number = threadFact(thread, 'number')
  if (number) return number
  const chat = threadFact(thread, 'chat')
  if (chat) return chat
  const first = lookup.firstTrigger(thread.key)
  const text = first ? preview(first.text, 60) : ''
  if (text) return text
  return /^\d+$/.test(thread.ref.id) ? `#${thread.ref.id}` : undefined
}

/** A Thread's title for a task no Ticket owns yet. */
function threadTitle(thread: Thread, lookup: ActivityLookup): string {
  const named = typeof thread.meta.label === 'string' ? preview(thread.meta.label, 120) : ''
  if (named) return named
  const first = lookup.firstTrigger(thread.key)
  const text = first ? preview(first.text, 120) : ''
  return text || thread.key
}

/** A Thread as a jump target and badge. */
function threadSubject(thread: Thread, lookup: ActivityLookup): ActivitySubject {
  const label = threadLabel(thread, lookup)
  return { kind: 'thread', id: thread.key, source: thread.ref.source, ...label ? { label } : {} }
}

/** The Thread a Ticket was accepted from, which gives its events their place in the task chain. */
function parentOf(ticket: Ticket, lookup: ActivityLookup): ActivitySubject | undefined {
  const home = ticket.origin.triggerId ? lookup.trigger(ticket.origin.triggerId)?.threads[0] : undefined
  if (!home) return undefined
  const thread = lookup.thread(threadKey(home))
  return thread ? threadSubject(thread, lookup) : { kind: 'thread', id: threadKey(home), source: home.source }
}

/** The Thread a stored Thread subject names, with the Source facts a reader needs for its badge. */
function namedSubject(subject: ActivitySubject, thread: Thread | undefined, lookup: ActivityLookup): ActivitySubject {
  return subject.kind === 'thread' && thread ? threadSubject(thread, lookup) : subject
}

/** The Trigger id a summary written before grading names, for intake and follow-up rows. */
function legacyTriggerId(record: ActivityRecord): string | undefined {
  return /^Trigger (\S+) (?:received|queued for a fresh assessment|left the follow-up queue)$/.exec(record.summary)?.[1]
}

/** A row stored before subjects were graded: name the object its summary or its Ticket names. */
function inferredSubject(record: ActivityRecord, owner: Ticket | undefined, thread: Thread | undefined, lookup: ActivityLookup): ActivitySubject | undefined {
  if (record.subject) return namedSubject(record.subject, thread, lookup)
  const decision = /^Decision (\S+) \(/.exec(record.summary)?.[1]
  if (record.event === 'decision.recorded' && decision) return { kind: 'decision', id: decision }
  // A follow row's object is the Thread even though the row also names the owning Ticket.
  if ((record.event === 'thread.subscribed' || record.event === 'thread.unsubscribed') && thread) return threadSubject(thread, lookup)
  const trigger = legacyTriggerId(record)
  if (record.event.startsWith('trigger.') && trigger) return { kind: 'trigger', id: trigger }
  if (record.ticket) return { kind: 'ticket', id: record.ticket }
  if (owner) return { kind: 'ticket', id: owner.id }
  return thread ? threadSubject(thread, lookup) : undefined
}

/** An Assignment end reason stored before details were graded, from its one-line summary. */
function inferredReason(record: ActivityRecord): string | undefined {
  return /^Assignment \S+ ended on \S+: (.+)$/.exec(record.summary)?.[1]
}

const OUTCOMES = new Set<TicketOutcome>(['completed', 'merged', 'closed', 'dropped', 'stopped'])

/** The ending a legacy summary names: an outcome, a reason, or neither when it does not parse. */
function legacyEnd(record: ActivityRecord): { outcome?: TicketOutcome; reason?: string } {
  const value = /^Ticket \S+ ended \((.+)\)$/.exec(record.summary)?.[1]
  if (!value) return {}
  return (OUTCOMES as Set<string>).has(value) ? { outcome: value as TicketOutcome } : { reason: value }
}

/**
 * The ending a row records. A graded row keeps its stored facts even after the Ticket was resumed and ended again; a legacy
 * row recovers what its summary names, and only an unparseable one falls back to the Ticket as it stands now.
 */
function endedFacts(record: ActivityRecord, ticket: Ticket | undefined): ActivityDetail | undefined {
  if (record.event !== 'ticket.ended') return undefined
  if (record.detail?.outcome) return { outcome: record.detail.outcome, ...record.detail.reason ? { reason: record.detail.reason } : {} }
  const legacy = record.detail ? {} : legacyEnd(record)
  // Only a person's stop records words as the reason, so a legacy summary naming a reason carries the stopped outcome.
  if (legacy.reason) return { outcome: 'stopped', reason: legacy.reason }
  const current = record.detail || legacy.outcome ? undefined : ticket?.ended
  const outcome = record.detail?.outcome ?? legacy.outcome ?? current?.outcome
  const reason = record.detail?.reason ?? current?.reason
  return outcome || reason ? { ...outcome ? { outcome } : {}, ...reason ? { reason } : {} } : undefined
}

/**
 * Completes one stored record for the Events tab: the object badge, the owning task and its originating Thread, how the
 * work stood at this event and now, the event's facts, and how long after the task's start it happened. Every field is
 * optional so a row written before this presentation existed still reads: its Ticket, Thread and summary name it instead.
 */
export function presentActivity(record: ActivityRecord, lookup: ActivityLookup): ActivityRecord {
  const subjectRef = record.subject
  const triggerId = subjectRef?.kind === 'trigger' ? subjectRef.id : !record.subject ? legacyTriggerId(record) : undefined
  const trigger = triggerId ? lookup.trigger(triggerId) : undefined
  const legacyDecision = !record.subject && record.event === 'decision.recorded'
    ? /^Decision (\S+) \(/.exec(record.summary)?.[1] : undefined
  const decisionId = subjectRef?.kind === 'decision' ? subjectRef.id : legacyDecision
  const decision = decisionId ? lookup.decision(decisionId) : undefined
  // An accepted Trigger's intake row joins the Ticket the Decision created, so one task stays one group.
  const originTicket = triggerId ? lookup.ticketForTrigger?.(triggerId) : undefined
  const ticketId = record.ticket ?? (subjectRef?.kind === 'ticket' ? subjectRef.id : undefined) ?? decision?.ticketId ?? originTicket?.id
  const ticket = (ticketId ? lookup.ticket(ticketId) : undefined) ?? originTicket
  const home = record.thread ?? (subjectRef?.kind === 'thread' ? subjectRef.id : undefined)
    ?? (trigger?.threads[0] ? threadKey(trigger.threads[0]) : undefined)
  const thread = home ? lookup.thread(home) : undefined
  const subject = inferredSubject(record, ticket, thread, lookup)

  // A review Ticket's events belong to the Ticket whose pull request it reviews, so both views tell one task story.
  const owner = ticket ? lookup.ownership?.owner(ticket) ?? ticket : undefined
  const parent = owner ? parentOf(owner, lookup) : undefined
  const task: ActivityTask | undefined = owner
    ? { id: owner.id, title: owner.title, status: activityStatusOf(owner), ...parent ? { parent } : {} }
    : thread ? { id: thread.key, title: threadTitle(thread, lookup), status: statusOf(record.event, decision, undefined) } : undefined

  const ended = endedFacts(record, ticket)
  const triggerPreview = trigger ? preview(trigger.text, 120) : undefined
  const detail: ActivityDetail = {
    ...record.detail,
    ...ended && !record.detail?.outcome ? ended : {},
    ...record.event === 'decision.recorded' && decision ? { decision: decision.kind } : {},
    ...record.event === 'assignment.ended' && !record.detail?.reason && inferredReason(record)
      ? { reason: inferredReason(record) } : {},
    ...record.event.startsWith('trigger.') && trigger
      ? { trigger: { source: trigger.source, ...triggerPreview ? { preview: triggerPreview } : {} } } : {},
  }
  const started = owner ? Date.parse(owner.createdAt) : Number.NaN
  const at = Date.parse(record.at)
  const sinceStartMs = Number.isFinite(started) && Number.isFinite(at) && at - started >= 60_000 ? at - started : undefined
  return { ...record, ...subject ? { subject } : {}, ...task ? { task } : {}, ...home && !record.thread ? { thread: home } : {},
    status: record.event === 'ticket.ended' ? endedStatus(ended?.outcome) : statusOf(record.event, decision, ticket),
    ...Object.keys(detail).length ? { detail } : {}, ...sinceStartMs ? { sinceStartMs } : {} }
}

/**
 * Reads one page of records at `level`. A first load (`after` 0) returns the newest page and starts the reader at the
 * matching head; a later load returns records after the cursor oldest first and advances to the last one, so a backlog is
 * paged without gaps. `latest` is the matching head, never a quiet event hidden by the filter. With `lookup`, every record
 * is completed for the Events tab.
 */
export function activityFeed(read: ActivityRead, after: number, limit = 50, level?: ActivityLevel, lookup?: ActivityLookup): ActivityFeed {
  const latest = read.latest(level)
  const page = after <= 0
    ? { items: read.recent(limit, level), latest, next: latest }
    : (() => { const items = read.after(after, limit, level); return { items, latest, next: items.at(-1)?.seq ?? after } })()
  return lookup ? { ...page, items: page.items.map(item => presentActivity(item, lookup)) } : page
}

/** Persists graded events for the system view and the notification budget. */
export class ActivityLog {
  constructor(private readonly store: ActivityStore) {}

  /** Grades `event` and records it in the current transaction, returning the stored record. */
  record(event: DomainEvent): ActivityRecord {
    const ticketId = 'ticketId' in event.data ? String(event.data.ticketId)
      : 'parentTicketId' in event.data ? String(event.data.parentTicketId) : undefined
    const ticket = ticketId === undefined ? undefined : this.store.tickets.get(ticketId)
    const triggerId = event.type.startsWith('trigger.') && 'triggerId' in event.data ? String(event.data.triggerId) : undefined
    return this.store.activity.record(gradeEvent(event, ticket, triggerId === undefined ? undefined : this.store.triggers.get(triggerId)))
  }
}
