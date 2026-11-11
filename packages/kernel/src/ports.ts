/** Ports the core depends on. Sources, policies, assessors, executors, and channels are project-specific. */
import type { Action, ActionLevel, OutboundAction, OutboundKind } from './action.ts'
import type { Approval } from './approval.ts'
import type { Assignment, ChannelRef, Decision, DecisionKind, Mandate, MandateBasis, Strength, Thread, Ticket, TicketEndBy, TicketOutcome, Trigger }
  from './model.ts'
import type { Reason } from './reasons.ts'
import type { Span } from './trace.ts'

/** Gate admission result: either inadmissible with a reason code, or admissible with strength and MandateBasis. */
export type GateResult = { admissible: false; reason: string } | { admissible: true; strength: Strength; basis: MandateBasis }

/** The action a running Ticket is about to take, as action-time revalidation sees it. */
export interface ActionRequest { level: ActionLevel }
/** Whether a Mandate still authorizes work; a refusal carries the reason a caller records with the refused action. */
export type Revalidation = { ok: true } | { ok: false; reason: Reason }

/** Whether a Source receives a Trigger; `observed` when it also receives messages not addressed to the agent, and `row` the receiving scope the Policy's admission table names, such as a chat. */
export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }
/** Source configuration as the domain sees it: listening scope per trigger or per recorded Mandate basis. */
export interface SourceScope {
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
  /** Whether `source` is a built-in local Source whose authenticated user needs no Policy roster. */
  trusted?(source: string): boolean
  /**
   * Whether `source` declares this Trigger a person writing through an account it shares with the agent, under the
   * Source's current configuration. The Source's adapter decides what evidence counts; the Policy admits such a Trigger
   * as an explicit request and re-checks this declaration before a resume or an action.
   */
  humanIdentity?(source: string, meta: Record<string, unknown>): boolean
}

/** Versioned rules; `gate` decides who may originate work. Source scope is not part of Policy. */
export interface Policy {
  version: string
  paused: boolean
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /**
   * Re-check a Mandate under this Policy at `at`, before an ended Ticket resumes and before a running Ticket takes an
   * action. Every call checks the admission basis and expiry; `action` additionally checks the action's level.
   */
  revalidate(mandate: Mandate, at: string, action?: ActionRequest): Revalidation
  /** The maximum level and the expiry a Mandate accepted at `at` receives from this Policy. */
  mandateLimits(at: string): { maxActionLevel: ActionLevel; expiresAt?: string }
  /** Whether an inferred candidate may be accepted on the rules its assessment matched: assessments accept, and each rule is enabled. */
  admitsInferred(rules: readonly string[]): boolean
  /** How long an assessor may take before an eval is recorded as unavailable. */
  evalTimeoutMs: number
}

/** What the assessor receives: bounded facts, never authority. */
export interface Candidate {
  evalId: string
  thread: Thread
  triggers: Trigger[]
  strength: Strength
  policyVersion: string
  /** Every ticket on the thread, including ended ones, for duplicate judgement. */
  tickets: Ticket[]
}

export type AssessmentOutcome =
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }
  /**
   * An accept: `rules` the assessment matched, `name` the ticket's requested short name, `note` a routing note for its
   * worker, and `form` how it runs (tracked unless the accept chooses the lightweight inline path).
   */
  | { kind: 'accept'; title: string; scope: string; reason: string | Reason; acknowledgement?: string; rules?: string[]; audit?: Record<string, unknown>;
    name?: string; note?: string; form?: 'lightweight' }
  | { kind: 'stop'; ticketId: string; reason: string | Reason; audit?: Record<string, unknown> }

/** Semantic judgement. `request` queues the assessment, idempotently per `evalId`; the outcome returns through `Engine.decide`. */
export interface Assessor {
  request(candidate: Candidate): void
  /** Called whenever an eval ends, decided or not, so the assessor drops what it kept for it. */
  release?(evalId: string): void
}

/**
 * Executes assignments; concurrency and workspace management are its own concern. The Engine calls it inside its
 * commands, so each method only queues work, which reports back through the Engine's callbacks.
 */
export interface Executor {
  /** Queue a pending assignment for launch; reports back through `Engine.assignmentStarted` or a `failed` report. */
  start(ticket: Ticket, assignment: Assignment): void
  /**
   * Queue delivery of the ticket's waiting Inputs to its running assignment; reports back through `Engine.inputsDelivered`
   * or `Engine.deliveryFailed`, and through `Engine.inputsRead` once its worker's Session takes them into a step.
   */
  deliver(ticket: Ticket, assignment: Assignment): void
  /** End an assignment's work, such as cancelling its Session's turn; called after the ticket or assignment has already ended in the domain. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void
  /**
   * Release resources tied to the Ticket itself, such as its directory lease, when the Ticket ends even if it has no open
   * Assignment; optional because an inline executor owns no workspace.
   */
  release?(ticket: Ticket): void
}

/** One Action a lightweight ticket ran, with when it ran and whether it succeeded. */
export interface InlineStep {
  action: Action
  /** When it ran, so the action ledger keeps the order the steps actually happened in. */
  at: string
  ok: boolean
  /** Why it failed, kept to a bounded length; absent when it succeeded. */
  error?: string
}

/**
 * What an inline execution ends with. A lightweight ticket runs at most `read` and `draft` actions (R5); a `commit`, `send`
 * or `spend` action needs a tracked ticket and a worker Session.
 */
export interface InlineResult {
  /** `completed` when the work is done, or `dropped` when there was nothing to do. */
  outcome: Extract<TicketOutcome, 'completed' | 'dropped'>
  /** A person-readable account of what it did, recorded as the ticket's end reason. */
  summary: string
  /**
   * The Inputs the run read, by Input id. A trigger Input's message counts as taken up, so ending the ticket does not hand it
   * back to Eval; an Input the run did not name keeps waiting. An Input that is not the ticket's own is refused.
   */
  read?: readonly string[]
}

/**
 * Runs a lightweight ticket inline: without an Assignment, a worker Session or a workspace. The Engine calls it inside its
 * commands, so it only queues the work. Each action comes back through `Engine.inlineAction` as it runs, with the run token
 * `start` was given, so the action ledger survives a run that never finishes and a late callback from an earlier run is
 * refused; the end comes through `Engine.inlineFinished`. An Input that arrives while it runs stays with the ticket and is
 * read by the next run.
 */
export interface InlineExecutor {
  /**
   * Queue `ticket` for an inline run under `run`; the ticket has no Assignment. Every callback for this run names `run`, and
   * the run is current until `inlineFinished` or the ticket's end.
   */
  start(ticket: Ticket, run: string): void
  /** Stop a queued or running inline execution, for this run or whatever it queued for the ticket. */
  stop(ticket: Ticket, reason: string): void
}

/**
 * What a caller asks the Outbox to write: the send Action that names the write, its Channel, the text and the Ticket it
 * is for. The Approval derives where it reaches from the Channel, so a caller cannot name a different destination. The
 * Action's idempotency key is the message id, so it is not supplied separately.
 */
export interface OutboundSend { action: OutboundAction; channel: ChannelRef; text: string; ticketId?: string }
/**
 * A message as a Channel adapter receives it: its id is the send Action's idempotency key. `action` is absent on a receipt
 * queued before outbound messages carried send Actions; such a receipt keeps the `kind` it was recorded with.
 */
export interface OutboundMessage { id: string; channel: ChannelRef; text: string; ticketId?: string; action?: Action; kind?: OutboundKind }
/**
 * A queued message waits (`pending`) for its undo window, went out (`sent`), was recalled inside that window
 * (`recalled`), or was dropped because its conversation can never receive it (`dropped`).
 */
export type ReplyStatus = 'pending' | 'sent' | 'recalled' | 'dropped'
/** The messages queued for Channels; the Engine queues them inside its commands, and a sender delivers them later. */
export interface Outbox {
  /** Queue a message once per send Action revision; the same revision queued before keeps its first message. */
  send(message: OutboundSend): void
  /** Whether a message was queued, and what became of it. */
  status(id: string): ReplyStatus | undefined
  /**
   * Withdraw a message that has not gone out, as a best-effort cancellation; unlike `recall`, it also stops one whose
   * retries keep failing after its undo window.
   */
  withdraw(id: string): void
  /**
   * Recall a message still waiting inside its undo window, before it is sent, and keep its receipt as `recalled`.
   * A repeated recall of a recalled message is idempotent.
   * @throws UserError when the message is unknown, already settled, or its undo window has closed.
   */
  recall(id: string): ReplyStatus
}

/** What the Engine reports after a change, by event type. */
export interface DomainEvents {
  'trigger.received': { triggerId: string; threads: string[] }
  'eval.started': { evalId: string; threadKey: string; triggerIds: string[]; strength: Strength }
  'decision.recorded': { decisionId: string; kind: DecisionKind; threadKey: string }
  'ticket.created': { ticketId: string; decisionId: string; strength: Strength }
  'ticket.resumed': { ticketId: string; triggerId: string }
  'ticket.ended': { ticketId: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  'assignment.started': { ticketId: string; assignmentId: string }
  'assignment.ended': { ticketId: string; assignmentId: string; reason: string }
  'thread.subscribed': { threadKey: string; ticketId: string }
  /** A person dropped every ticket's Subscription, or a ticket's Executor its own, for `reason`. */
  'thread.unsubscribed': { threadKey: string; ticketId: string; by: 'person' | 'executor'; reason?: string }
  'trigger.requeued': { triggerId: string }
  /** A person's follow-up that reached tickets and that an earlier version also queued for Eval left the queue. */
  'trigger.followup': { triggerId: string }
  'policy.changed': { from: string; to: string }
  /** A parent owner created a child Ticket under the same authorization root. */
  'ticket.delegated': { parentTicketId: string; ticketId: string; rootTicketId: string; attempt: number; depth: number }
  /** A child Ticket's report reached its parent owner's queue. */
  'ticket.child.reported': { parentTicketId: string; ticketId: string; attempt: number; state: import('./model.ts').ReportState }
  /** A parent owner judged a child Ticket's report. */
  'ticket.child.reviewed': { parentTicketId: string; ticketId: string; decision: import('./model.ts').ChildReportDisposition['decision'] }
  /** A pull request or followed Thread closed while child Tickets were unresolved; the end waits. */
  'ticket.end.pending': { ticketId: string; by: 'thread' | 'follows'; outcome: 'merged' | 'closed' }
  /** A child Ticket's parent or root became unavailable; a person decides it and it is never resumed silently. */
  'ticket.child.orphaned': { parentTicketId: string; ticketId: string; reason: string }
}
export type DomainEvent = { [K in keyof DomainEvents]: { type: K; at: string; data: DomainEvents[K] } }[keyof DomainEvents]

/**
 * Where the Engine reports the stages a Trigger passes, for tracing. Reporting is best effort: a sink that drops spans
 * loses the trace, never a command, and a sink must not make the Engine wait.
 */
export interface TraceSink {
  record(span: Span): void
}

/** Durable state. Every method is synchronous so `atomic` can wrap a unit of work. */
export interface Repositories {
  atomic<T>(work: () => T): T
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    disposition(id: string): import('./model.ts').TriggerDisposition | undefined
    saveDisposition(id: string, value: import('./model.ts').TriggerDisposition): void
  }
  threads: {
    get(key: string): Thread | undefined
    save(thread: Thread): void
    list(): Thread[]
    /** Threads with Triggers queued for Eval or an Eval in progress. */
    active(): Thread[]
  }
  tickets: {
    get(id: string): Ticket | undefined
    save(ticket: Ticket): void
    /** Root Tickets only, newest first: children are execution nodes, never independent work. */
    list(): Ticket[]
    /** Open root Tickets only, newest first. */
    open(): Ticket[]
    /** Root Tickets with undelivered Inputs or a pending or running Assignment, which is always the latest. */
    active(): Ticket[]
    /** Every Ticket, root and child, newest first; lifecycle queries that must not miss a child use this. */
    allList(): Ticket[]
    /** Every open Ticket, root and child, newest first. */
    allOpen(): Ticket[]
    /** Every active Ticket, root and child, newest first. */
    allActive(): Ticket[]
    /** The direct child Tickets of `ticketId`, newest first. */
    childrenOf(ticketId: string): Ticket[]
    /** Every Ticket whose `rootTicketId` is `rootTicketId`, including the root itself, newest first. */
    subtree(rootTicketId: string): Ticket[]
  }
  decisions: {
    get(id: string): Decision | undefined
    save(decision: Decision): void
    byThread(key: string): Decision[]
  }
  approvals: {
    get(id: string): Approval | undefined
    save(approval: Approval): void
    /** A Ticket's Approvals, oldest first. */
    byTicket(ticketId: string): Approval[]
    /** Approvals still waiting for a decision at `now` and not past their expiry, oldest first. */
    pending(now?: number): Approval[]
  }
}
