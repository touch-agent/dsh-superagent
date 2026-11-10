/** Domain model of a proactive agent: the concepts and their invariants, independent of any source, policy, or executor. */
import type { ActionLevel } from './action.ts'
import type { Review } from './deliverable.ts'
import type { Reason } from './reasons.ts'

/** Actor identity in the source's own vocabulary; Policy decides which actors may originate work on that Source. */
export interface ActorRef { source: string; id: string }
/** Thread identity; the rule that derives `id` from a native event belongs to the source. */
export interface ThreadRef { source: string; id: string }
/** Write-only address on a thread; the address format belongs to the source. */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** Stable key of a thread across the whole domain. */
export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`
/** The Thread a Channel names: its `thread` is a thread key, or a bare id of the Channel's own Source. */
export const channelThread = (channel: ChannelRef): ThreadRef => {
  const colon = channel.thread.indexOf(':')
  return colon < 0 ? { source: channel.source, id: channel.thread }
    : { source: channel.thread.slice(0, colon), id: channel.thread.slice(colon + 1) }
}
/**
 * Normalizes valid timestamps to `Date#toISOString` form so stored timestamps compare lexicographically in memory and SQL;
 * values that do not parse as a timestamp are returned unchanged.
 */
export function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

/** One immutable event produced by a source. `text` and `meta` are untrusted external data. */
export interface Trigger {
  id: string
  source: string
  /** Every thread the trigger belongs to; the first (`threads[0]`) is the primary thread that hosts its evaluation. */
  threads: ThreadRef[]
  actor: ActorRef
  /** Source-declared: the event was written by a person rather than a bot, CI, or this agent. */
  human: boolean
  /** Source-declared: the sender addressed the agent, by mentioning it or in a direct message to it. */
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  /** Source-native details for adapters; the core never interprets them. */
  meta: Record<string, unknown>
}

/** Where a trigger went after intake; it grants nothing, but decides who decides a person's follow-up (see `followupOwners`). */
export interface TriggerDisposition {
  /** Rejected by the source scope filter before entering the domain, for the Source's reason. */
  filtered?: Reason
  evalId?: string
  decisionId?: string
  /**
   * The tickets it reached, by subscription fan-out or attached by the main Session; a ticket that ended or could not resume
   * without its worker taking it up no longer counts.
   */
  fanout: string[]
  /** The tickets of `fanout` it reached only on a Thread their Executor follows for context, which makes it none of theirs. */
  context?: string[]
  /** A person, or the main Session for a message no ticket decides, sent it to Eval again; a hand-back does not set it. */
  requeued?: true
  /** The tickets whose Executor handed it back as beyond the ticket, each once, with why; it goes to Eval once none decides it. */
  handbacks?: { ticketId: string; reason: string; at: string }[]
  /** The tickets whose Executor acknowledged it or answered it, taking it up as within the ticket. */
  acked?: string[]
  at: string
}
/** What deciding a follow-up's owners reads: the stored tickets, Threads and dispositions, as the Store and the core keep them. */
export interface FollowupRecords {
  tickets: { get(id: string): Ticket | undefined }
  threads: { get(key: string): Thread | undefined }
  triggers: { disposition(id: string): TriggerDisposition | undefined }
}
/**
 * The tickets whose worker decides a person's follow-up: those it reached on their own Threads that can still decide it
 * and did not hand it back. A ticket can while it is live, also once a person dropped its Subscription to the Thread, and
 * while it is ended, not by a person, with the Trigger waiting to resume it. None once a person sent it to Eval, or while
 * an Eval holds it, which an earlier version may have queued. While a ticket owns it, the message goes to no Eval, and the
 * main Session may only stop the work on it.
 */
export function followupOwners(trigger: Pick<Trigger, 'id' | 'human' | 'threads'>, records: FollowupRecords): string[] {
  if (!trigger.human) return []
  const disposition = records.triggers.disposition(trigger.id)
  if (!disposition || disposition.requeued) return []
  // The disposition alone rules most messages out, so a Thread or a ticket is read only for one that may have an owner.
  const returned = new Set(disposition.handbacks?.map(item => item.ticketId))
  const reached = disposition.fanout.filter(id => !returned.has(id) && !disposition.context?.includes(id))
  if (!reached.length || records.threads.get(threadKey(trigger.threads[0]!))?.evaluating?.triggerIds.includes(trigger.id)) return []
  return reached.filter(id => {
    const ticket = records.tickets.get(id)
    return !!ticket && (liveTicket(ticket) || (ticket.ended?.by !== 'human'
      && ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === trigger.id && ticket.undelivered.includes(input.id))))
  })
}
/**
 * Whether a Decision settled what a person's message asks for: a stop on it, taken or refused, decides only that ticket's
 * work, routing it to a ticket leaves it to that ticket's worker, and an unavailable one decided nothing.
 */
export const settled = (decision: Pick<Decision, 'kind' | 'reason'>): boolean => !['stop', 'unavailable'].includes(decision.kind)
  && !decision.reason.some(reason => ['stopNotExplicit', 'stopUnknown', 'routed'].includes(reason.code))

export type Strength = 'explicit' | 'inferred'
/** The cells of a receiving scope's row in the admission table, by whether the sender is listed and addresses the agent. */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
/**
 * Whether proactive candidates are assessed and accepted (`auto`), still assessed so Decisions record what they would accept
 * (`would_accept`) without accepting (`observe`), or not admitted (`off`).
 */
export type AcceptMode = 'off' | 'observe' | 'auto'
/** Where a Mandate's Trigger was received: its Source, its receiving scope as the Source recorded it, and its admission row. */
interface Received { source?: string; scope?: Record<string, unknown>; row?: string }
/**
 * How the gate admitted the Trigger a Mandate came from, which `revalidate` re-checks (see `docs/002`):
 * - `addressed`: a sender on the Source's list addressed the agent;
 * - `followup`: a message on a Thread that has tickets;
 * - `admission`: the cell of the receiving scope's admission row; `observation` when it made an inferred candidate under
 *   an accept mode;
 * - `listed`: accepted before Mandates recorded their basis, from a sender who must still be on the list; `authority` is
 *   what an earlier version recorded instead.
 * - `local`: a built-in local Source (the conversation) whose authenticated user is explicit by definition and has no roster.
 * `sender` names the allowed sender at acceptance time, and `rules` the rules an assessment matched.
 */
export type MandateBasis = Received & { sender?: string; rules?: string[] } & (
  | { via: 'addressed'; addressed: 'mention' | 'direct' }
  | { via: 'followup'; authority?: string }
  | { via: 'admission'; cell: AdmissionCell; addressed?: 'mention' | 'direct'; observation?: { mode: AcceptMode } }
  | { via: 'listed'; addressed?: 'mention' | 'direct'; observation?: { mode?: AcceptMode }; authority?: string }
  /** A message of a bot on its Source's bot list: an inferred candidate at most, never an explicit request or a stop. */
  | { via: 'bot'; addressed?: 'mention' | 'direct'; observation: { mode: AcceptMode } }
  /** A built-in local Source's authenticated user; explicit without a roster. */
  | { via: 'local'; addressed?: 'mention' | 'direct' }
)

/** Immutable authorization produced by an accept decision; execution is bounded by it and it never changes. */
export interface Mandate {
  strength: Strength
  policyVersion: string
  /** How the gate admitted it, for re-validation and audit. */
  basis: MandateBasis
  actor: ActorRef
  scope: string
  /**
   * The highest action level this authorization permits. A Mandate accepted before the action gate has none, and the
   * Policy's current maximum applies until it is re-accepted; a recorded ceiling is never widened by a later Policy.
   */
  maxActionLevel?: ActionLevel
  /** When this authorization stops permitting actions; absent when it has no time limit. */
  expiresAt?: string
}

/** Active trigger evaluation on a thread; at most one exists per thread. */
export interface Evaluation {
  id: string
  threadKey: string
  triggerIds: string[]
  /** The admissible Trigger that gave the batch its strength, which a ticket the Eval starts takes as its origin. */
  primary?: string
  strength: Strength
  /** Actor and gate basis of the strongest admissible trigger; they seed the mandate on accept. */
  actor: ActorRef
  basis: MandateBasis
  policyVersion: string
  startedAt: string
  /** Timestamp when the candidate reached the assessor's Session; it cannot expire before, and its deadline counts from then. */
  delivered?: string
  /** Expiration timestamp, counted from delivery (or from start until delivered); a processing pause shifts it forward by the pause duration. */
  deadline: string
  /** Timestamp when processing pause began; resuming shifts `deadline` forward by the pause duration; cleared on resume. */
  pausedAt?: string
}

/** Thread aggregate: consistency boundary of eval, holder of subscriptions and decision history. */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  /** Time of the newest trigger on the thread. */
  lastAt?: string
  /** Tickets subscribed to this thread; live ones receive every trigger as context through fan-out. */
  subscriptions: string[]
  /**
   * The subscribed tickets whose Executor follows the thread for read-only context, such as an Issue or another pull request
   * it found: its messages reach them, but grant nothing, and a person's message there resumes none of them that ended.
   */
  context?: string[]
  /** Keys of threads that shared a trigger with this one; context only. */
  correlated: string[]
  /** Triggers waiting for the next eval (debounce buffer). */
  pending: string[]
  evaluating?: Evaluation
  /** How many Evals of its queued Triggers expired in a row, each of which queued them again; a Decision clears it. */
  expired?: number
  /**
   * Source-native attributes needed by channels or readers (for example a Feishu thread id). Its Source may also describe
   * the thread for people: `label`, a display name, and `facts`, a {@link ThreadFacts} map.
   */
  meta: Record<string, unknown>
}
/** Text in both interface languages, or the same text in both. */
export type Text = string | { zh: string; en: string }
/** One fact a Source states about its thread, such as an issue number or a CI result; `problem` marks one that needs a person. */
export interface ThreadFact { label?: Text; value: Text; problem?: true }
/** A thread's facts by id, ordered for display; each writer owns its fact ids. */
export type ThreadFacts = Record<string, ThreadFact>

export type DecisionKind = 'ignore' | 'accept' | 'reopen' | 'stop' | 'unavailable'
/** Outcome of one eval, recorded on the thread. */
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  /** Why, by code: one reason, or one for each Trigger of the batch it concerns. */
  reason: Reason[]
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  /** Assessor-supplied audit data (rule assessments, direction, evidence). */
  audit?: Record<string, unknown>
  /** A person dismissed the problem an unavailable Decision shows. */
  dismissed?: true
}

export type AssignmentState = 'pending' | 'running' | 'ended'
/**
 * What an Assignment reports: work is in progress (`progress`), its worker waits for a Trigger (`waiting`), a result is
 * ready (`ready`), a person must act to unblock or recover it (`blocked` or `failed`), or nothing is left to do (`dropped`).
 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
/** Binding between a ticket and one executor instance. */
export interface Assignment {
  id: string
  state: AssignmentState
  /** For a child ticket, the delegation attempt this Assignment belongs to; absent means attempt 1. */
  attempt?: number
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  /** The worker's latest report, with the reviewable deliverable it carried and a person's acceptance of that revision. */
  report?: { state: ReportState; summary: string; at: string; review?: Review; accepted?: { by: ActorRef; at: string; reviewRevision?: string } }
  /** When Inputs last reached the worker; one at or after `report.at` means the worker has been busy with Inputs since that report. */
  deliveredAt?: string
  /**
   * When a turn of its worker last ended with nothing left to run for it and nothing waiting for it: what its Session took
   * into a step before, the worker read.
   */
  idleAt?: string
}

export type TicketInput =
  /** A Trigger on one of its Threads, or attached to it; `human` when a person wrote it. */
  | { id: string; kind: 'trigger'; triggerId: string; at: string; note?: string; human?: true
    /** It reached the ticket only on a Thread its Executor follows for context. */
    context?: true
    /**
     * When the worker's Session took the message that carried it into a step, from which its model reads it; `null` while
     * it waits in the Session. One delivered before reads were recorded has none, and counts as read from `deliveredAt`.
     */
    readAt?: string | null
    /** The Assignment it was last delivered to. */
    deliveredTo?: string
    /** When an earlier version handed it to the worker. */
    deliveredAt?: string }
  /** The Policy changed in a way that bears on the ticket, as `effect` says; Inputs written before effects have none. */
  | { id: string; kind: 'policy-changed'; from: string; to: string; at: string; effect?: PolicyEffect }
  /** A Decision reopened the ticket; written before ended tickets resumed on their own. */
  | { id: string; kind: 'reopen'; decisionId: string; at: string }
  /** A human's message on one of its Threads resumed the ended ticket under its unchanged Mandate. */
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  | { id: string; kind: 'text'; text: string; at: string }
  /** A fact the main Session gave the ticket from other work: context, which asks for nothing and grants nothing. */
  | { id: string; kind: 'note'; text: string; at: string }
  /** An external Channel the ticket gained, recorded for audit; it asks for nothing and grants nothing. */
  | { id: string; kind: 'binding'; channel: ChannelRef; at: string }
  /** A child ticket's report, which reaches only its parent owner; it is not a Trigger and never asks a person directly. */
  | { id: string; kind: 'child-report'; childTicketId: string; attempt: number; assignmentId: string; reportAt: string
    state: ReportState; summary: string; review?: Review; humanAction?: string; at: string; deliveredAt?: string; readAt?: string }
  /** A pull request or followed thread closed while child tickets are unresolved; the parent owner must apply it. */
  | { id: string; kind: 'end-gate'; pending: PendingEnd; at: string; deliveredAt?: string; readAt?: string }

/**
 * How a Policy change bears on a ticket: the rules it was accepted under that changed, with their instruction now, or no
 * longer apply; `proactive: false` once inferred work is no longer accepted, as when the accept mode leaves `auto`; and
 * `requesterAllowed: false` once the sender it is for, `requester`, a person or a bot, may no longer start work there.
 */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'changed' | 'disabled'; instruction?: string }[]
  proactive?: false
  requesterAllowed?: false
  requester?: ActorRef
}

export type TicketEndBy = 'executor' | 'human'
/** How a ticket ended: with its result, with its pull request merged or closed unmerged, with nothing to do, or stopped by a person. */
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
/**
 * How a ticket runs. A tracked ticket goes to an Executor through Assignments and worker Sessions, and its trace records
 * what happened to each Assignment. A lightweight ticket is one small action sequence that runs inline, without an
 * Assignment or a Session, and its trace records each action.
 */
export type TicketForm = 'tracked' | 'lightweight'
/** A question for a person; `triggerId` is the human message that raised it, whose conversation it goes back to. */
export interface Attention { id: string; question: string; triggerId?: string }
/** How a tracked ticket's pull request or followed thread closed while child tickets are still unresolved. */
export interface PendingEnd {
  by: 'thread' | 'follows'
  outcome: 'merged' | 'closed'
  at: string
  reason?: string
  ref?: string
}
/** One judgement a parent owner recorded about a child ticket's report. */
export interface ChildReportDisposition {
  reportId?: string
  childTicketId: string
  attempt: number
  assignmentId?: string
  reportAt?: string
  decision: 'accepted' | 'returned' | 'reassigned' | 'self-work' | 'escalated' | 'cancelled' | 'failed'
  by: ActorRef
  at: string
  reason?: string
  traceId: string
  replacementTicketId?: string
}
/**
 * A child ticket's delegation record: the parent owner's goal and scope, the attempt whose report alone counts, the
 * parent's judgements, and the terminal resolution that must pair with the child ticket's end.
 */
export interface Delegation {
  parentTicketId: string
  rootTicketId: string
  /** The child's goal; the parent owner writes it and the child owner cannot change it. */
  goal: string
  /** An execution hint, not authorization; it cannot widen the root mandate's action level. */
  scope?: string
  requestedBy: { ticketId: string; sessionId: string }
  /** 1-based; `return_child` increments it and invalidates the previous attempt. */
  attempt: number
  createdAt: string
  startedAt?: string
  endedAt?: string
  reportCount?: number
  lastReportAt?: string
  lastDisposition?: ChildReportDisposition
  /** Append-only history of the parent owner's judgements. */
  dispositions?: ChildReportDisposition[]
  /** The parent or root is unavailable; the child waits for the nearest living ancestor or a person. */
  orphaned?: { reason: string; at: string; by?: ActorRef }
  /** Terminal judgement; `accepted` must pair with a completed end, `cancelled` with stopped, `failed` with dropped. */
  resolution?: {
    kind: 'accepted' | 'cancelled' | 'failed'
    by: ActorRef
    at: string
    acceptedReportAt?: string
    acceptedAttempt?: number
    reason?: string
    traceId?: string
  }
  merge?: { at: string; by: ActorRef; into?: string; childRevisions: string[]; conflicts: string[]; resolution: 'merged' | 'escalated' | 'none'; reason?: string }
  workspace?: { kind: 'worktree' | 'branch' | 'directory'; ref: string }
}
/** Ticket aggregate: an authorized work item with its assignments, channels, thread bindings, and inputs. */
export interface Ticket {
  id: string
  title: string
  /** The accept Decision that authorized a root ticket; absent on a child ticket, which has no Decision of its own. */
  decisionId?: string
  /** A root ticket's authorization; absent on a child ticket, which inherits its root's mandate. */
  mandate?: Mandate
  /**
   * How it runs. A ticket created before forms existed has none and is tracked. A lightweight ticket has no Assignment and
   * runs its actions inline (see `InlineExecutor`); a tracked ticket gets an Assignment and a worker Session.
   */
  form?: TicketForm
  /** The Channels of the messages it was accepted from, which its replies go to. */
  channels: ChannelRef[]
  /** When, by whom, and how the ticket ended, with a person's or the host's reason beyond the outcome; an open ticket has none. */
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  /** Open question for a person; cleared by the executor or when the ticket ends. */
  attention?: Attention
  assignments: Assignment[]
  inputs: TicketInput[]
  /** Inputs not yet handed to a running assignment. */
  undelivered: string[]
  /**
   * Threads a Source made the ticket follow, such as its pull requests': a `ready` report ends the ticket only once
   * `followsDone` holds; the close that makes it hold ends the ticket with that outcome unless its work has not finished (see
   * `Tickets.unfinished`), and then its next `ready` or `dropped` report ends it.
   */
  follows?: Follow[]
  /** People's questions the worker answered, whose answers the main Session may send. */
  answers?: string[]
  createdAt: string
  updatedAt: string
  /** The Triggers it was accepted from: the one that started it, and the batch its Eval held. */
  origin: { triggerId: string; triggerIds: string[] }
  /** What its Executor chose: its short name, directory and assignment text. */
  execution?: Execution
  /** The latest failed delivery of an Input to its worker, until a delivery succeeds. */
  delivery?: { error: string; at: string }
  /** A child ticket's parent; absent on a root ticket. It never changes after creation. */
  parentTicketId?: string
  /** The authorization root: absent on a root ticket (it is its own root), required on a child. */
  rootTicketId?: string
  /** The parent owner's delegation and judgements; present on a child ticket only. */
  delegation?: Delegation
  /**
   * A pull request or followed thread closed while child tickets were unresolved; the ticket stays live until its parent
   * owner applies the pending end. It never coexists with `ended`.
   */
  endPending?: PendingEnd
}
/** A root ticket: the only node that carries authorization (a Decision and a Mandate). */
export type RootTicket = Ticket & { parentTicketId?: never; rootTicketId?: never; delegation?: never; decisionId: string; mandate: Mandate }
/** A child ticket: an execution node under a root, with no Decision or Mandate of its own. */
export type ChildTicket = Ticket & { parentTicketId: string; rootTicketId: string; delegation: Delegation; decisionId?: never; mandate?: never }
/** Whether `ticket` is a child ticket. */
export const isChildTicket = (ticket: Pick<Ticket, 'parentTicketId'>): boolean => ticket.parentTicketId !== undefined
/** The authorization root's id: a root ticket's own id, or a child's `rootTicketId`. */
export const rootTicketIdOf = (ticket: Pick<Ticket, 'id' | 'rootTicketId'>): string => ticket.rootTicketId ?? ticket.id
/** The authorization root, when it exists, resolved through `get`. */
export function rootTicketOf(ticket: Pick<Ticket, 'id' | 'rootTicketId'>, get: (id: string) => Ticket | undefined): Ticket | undefined {
  return get(rootTicketIdOf(ticket))
}
/**
 * The mandate every action gate, Approval and outbox writes under: the root's, never a child's. A child never stores one,
 * and a dangling root is a corruption, not a reason to borrow the child's own fields.
 */
export function rootMandateOf(ticket: Pick<Ticket, 'id' | 'rootTicketId'>, get: (id: string) => Ticket | undefined): Mandate | undefined {
  return rootTicketOf(ticket, get)?.mandate
}
/** The depth of a ticket below its root: a root is 0, a direct child 1, and so on. */
export function depthOf(ticket: Pick<Ticket, 'id' | 'parentTicketId' | 'rootTicketId'>, get: (id: string) => Ticket | undefined): number {
  let depth = 0, cursor: Ticket | undefined = ticket as Ticket, seen = new Set<string>()
  while (cursor?.parentTicketId !== undefined && depth < 64) {
    if (seen.has(cursor.id)) return Number.POSITIVE_INFINITY
    seen.add(cursor.id)
    cursor = get(cursor.parentTicketId)
    depth += 1
  }
  return depth
}
/** Whether a child's `rootTicketId` agrees with its parent's root (or the parent itself when the parent is a root). */
export function rootConsistent(child: Pick<Ticket, 'parentTicketId' | 'rootTicketId'>, parent: Ticket | undefined): boolean {
  if (!child.parentTicketId || !parent || parent.id !== child.parentTicketId) return false
  return child.rootTicketId === (parent.rootTicketId ?? parent.id)
}
/**
 * Whether a child ticket is unresolved: still live, and without a current terminal delegation resolution. A resolution
 * without an end, an end without a resolution, or a resolution whose accepted report is stale counts as unresolved
 * (or corrupt), so a parent never ends silently over it.
 */
export function childUnresolved(child: Ticket): boolean {
  if (!isChildTicket(child)) return false
  if (!liveTicket(child)) return false
  const resolution = child.delegation?.resolution
  if (!resolution) return true
  if (resolution.kind !== 'accepted') return false
  const report = currentChildReport(child)
  return !report || resolution.acceptedReportAt !== report.at || resolution.acceptedAttempt !== child.delegation?.attempt
}
/** The latest report of the child ticket's current delegation attempt, ignoring reports from an earlier attempt. */
export function currentChildReport(child: Ticket): Assignment['report'] {
  const attempt = child.delegation?.attempt ?? 1
  return child.assignments.findLast(assignment => assignment.report && (assignment.attempt ?? 1) === attempt)?.report
}
/** Whether a terminal resolution pairs with the child ticket's end as one valid state. */
export function childResolutionValid(child: Ticket): boolean {
  if (!isChildTicket(child) || !child.ended) return false
  const resolution = child.delegation?.resolution
  if (!resolution) return false
  if (resolution.kind === 'accepted') return child.ended.outcome === 'completed' && childUnresolvedResolutionValid(child)
  if (resolution.kind === 'cancelled') return child.ended.outcome === 'stopped'
  return child.ended.outcome === 'dropped'
}
function childUnresolvedResolutionValid(child: Ticket): boolean {
  const resolution = child.delegation!.resolution!
  const report = currentChildReport(child)
  return !!report && resolution.acceptedReportAt === report.at && resolution.acceptedAttempt === child.delegation?.attempt
}
/**
 * A Thread a ticket follows, by its key: `own` when the ticket opened it, such as its own pull request, and when and how it
 * closed. `followsDone` holds once no Thread of its own is open, or, when the ticket has no `own` Thread, once every followed
 * Thread closed; the ticket then ends unless its work has not finished (see `Tickets.unfinished`).
 */
export interface Follow { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }
export interface Execution { name: string; directory: string; assignment: string }

/** Whether a ticket is open: it has not ended. */
export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended
/** How a ticket runs; a ticket recorded before forms existed runs tracked. */
export const ticketForm = (ticket: Pick<Ticket, 'form'>): TicketForm => ticket.form ?? 'tracked'
/** How a ticket ended. */
export const ticketOutcome = (ticket: Pick<Ticket, 'ended'>): TicketOutcome | undefined => ticket.ended?.outcome
export const runningAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.find(assignment => assignment.state === 'running')
/**
 * Whether a Trigger reached a ticket: it started the ticket, came to it as an Input, or is on a Thread the ticket subscribes
 * to; with `context` false, not a Thread the ticket follows only for context, where its worker may read but not write.
 */
export function reached(ticket: Ticket, trigger: Trigger, thread: (key: string) => Thread | undefined, context = true): boolean {
  if (ticket.origin.triggerId === trigger.id) return true
  const input = ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === trigger.id)
  return trigger.threads.some(ref => {
    const current = thread(threadKey(ref))
    return current?.subscriptions.includes(ticket.id) === true && (context || !current.context?.includes(ticket.id))
  }) || (input && (context || !trigger.threads.every(ref => thread(threadKey(ref))?.context?.includes(ticket.id))))
}
export const latestAssignment = (ticket: Ticket): Assignment | undefined => ticket.assignments.at(-1)
/** The latest report any of a ticket's Assignments made, which is what the ticket last said. */
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Assignment['report'] => ticket.assignments.findLast(assignment => assignment.report)?.report
/**
 * Until when a ticket's worker had a turn to read what reached it: its latest report, but a progress report when `progress`
 * is false, or the end of its latest turn, whichever is later.
 */
export function readUntil(ticket: Pick<Ticket, 'assignments'>, progress = true): string {
  const report = ticket.assignments.findLast(assignment => assignment.report && (progress || assignment.report.state !== 'progress'))?.report
  return [report?.at ?? '', ...ticket.assignments.map(assignment => assignment.idleAt ?? '')].reduce((a, b) => a > b ? a : b)
}
/**
 * Whether a ticket waits for a person: its latest Assignment reported blocked or failed, and no person's message reached it
 * since. A later report that is neither, a person's message, or a retry, which starts a new Assignment, lifts it.
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  return !ticket.inputs.some(input => input.kind === 'trigger' && input.human && !input.context && input.at > report.at)
}
