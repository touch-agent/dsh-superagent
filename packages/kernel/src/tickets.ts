/** Tickets: their lifecycle from an accept to their end, their Subscriptions and their Inputs. */
import { acknowledgementAction, withinActionLevel } from './action.ts'
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { channelThread, childResolutionValid, childUnresolved, currentChildReport, depthOf, isChildTicket, latestAssignment, latestReport,
  liveTicket, readUntil, rootConsistent, rootTicketIdOf, runningAssignment, settled, threadKey, ticketForm, waitsForPerson } from './model.ts'
import type { ActorRef, Assignment, ChannelRef, ChildReportDisposition, Delegation, Evaluation, Follow, Mandate, PendingEnd, PolicyEffect,
  ReportState, ThreadRef, Ticket, TicketEndBy, TicketInput, TicketOutcome, Trigger, TriggerDisposition } from './model.ts'
import type { AssessmentOutcome, InlineResult, InlineStep } from './ports.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { canRetry } from './stage.ts'
import { acceptedReviewRevision, reviewAggregate } from './review.ts'

const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b)
/** Whether an Input is a message no person wrote, such as CI's, a bot's, or the main Session's note. */
export const automatic = (input: TicketInput | undefined): boolean => input?.kind === 'note' || (input?.kind === 'trigger' && !input.human)
/**
 * Whether a ticket's worker read a Trigger Input before `until`, its latest report or turn end: its Session took the message
 * into a step before then. One delivered before reads were recorded counts as read once it reached the worker by then.
 */
const readBefore = (input: Extract<TicketInput, { kind: 'trigger' }>, until: string): boolean => input.readAt === undefined
  ? (input.deliveredAt && input.deliveredAt > input.at ? input.deliveredAt : input.at) <= until : !!input.readAt && input.readAt < until
const STATUS_REQUEST = 'Report the current ticket status with orchestrator_report. This is a status-only request: do not resume implementation or perform external actions.'

/** The execution root: the directory holding the root Ticket's own directory. A child goes beside it, not inside its parent. */
function childSiblingRoot(root: Ticket, parent: Ticket): string {
  const base = root.execution?.directory
  const cut = base?.lastIndexOf('/') ?? -1
  if (base && cut >= 0) return base.slice(0, cut)
  const fallback = parent.execution?.directory ?? ''
  const parentCut = fallback.lastIndexOf('/')
  return parentCut >= 0 ? fallback.slice(0, parentCut) : fallback
}

/**
 * Manages each ticket's lifecycle: creates the ticket for an accept decision with its Mandate, Subscriptions, and first
 * Assignment, binds and attaches Threads, adds Inputs, resumes, retries, restarts, and ends tickets, and drops Subscriptions.
 * Coordinates with Replies for the acknowledgement an accept carries, with Executor to start, deliver to, and stop assignments,
 * and with the inline executor to run a lightweight ticket's action sequence and record it in the ticket's trace.
 * Intake, Evals, Assignments, and Engine delegate ticket and subscription mutations here.
 */
export class Tickets extends EnginePart {
  /** The inline run each lightweight ticket is on, so a late callback from an earlier run is refused and its steps get unique refs. */
  private readonly inlineRuns = new Map<string, { run: string; startedAt: string; lastAt: string; steps: number }>()
  private inlineSeq = 0
  constructor(options: EngineOptions, private readonly replies: Replies) { super(options) }

  /**
   * Create the ticket an accept decided, under `mandate`, with the Channels and Threads of the Eval's Triggers, its first
   * Assignment, and the acknowledgement the accept carries, and queue its launch. Its origin is the admissible Trigger that
   * gave the Eval its strength, or the Eval's last Trigger for an Eval recorded before `primary` existed. A lightweight
   * accept gets no Assignment: its actions run inline instead.
   * @throws TypeError when the accept chose the lightweight form but no inline executor is configured.
   */
  create(id: string, decisionId: string, mandate: Mandate, evaluation: Pick<Evaluation, 'triggerIds' | 'primary'>,
    outcome: Extract<AssessmentOutcome, { kind: 'accept' }>, at: string): void {
    const { triggerIds } = evaluation
    // Fall back to the last trigger for Evals recorded before `primary` existed.
    const primary = this.repo.triggers.get(evaluation.primary ?? triggerIds.at(-1)!)
    const origin = { triggerId: primary?.id ?? triggerIds[0]!, triggerIds }
    let ticket: Ticket = { id, title: outcome.title, decisionId, mandate, form: outcome.form ?? 'tracked', channels: [], assignments: [],
      inputs: [], undelivered: [], createdAt: at, updatedAt: at, origin }
    for (const triggerId of triggerIds) {
      const channel = this.repo.triggers.get(triggerId)?.channel
      if (channel && !ticket.channels.some(item => sameChannel(item, channel))) ticket.channels.push(channel)
    }
    ticket = this.options.prepareTicket?.(ticket, outcome) ?? ticket
    const lightweight = ticketForm(ticket) === 'lightweight'
    // A lightweight ticket cannot wait for a Session that never starts, so the deployment must provide the inline path.
    if (lightweight && !this.options.inline) throw new TypeError('A lightweight Ticket needs an inline executor')
    const assignment = lightweight ? undefined : this.newAssignment(ticket)
    this.repo.tickets.save(ticket)
    for (const triggerId of triggerIds) for (const ref of this.repo.triggers.get(triggerId)?.threads ?? []) this.subscribe(id, ref)
    if (outcome.acknowledgement && primary) this.replies.acknowledgeAccepted(id, primary, outcome.acknowledgement)
    const created = this.require(id)
    const from = primary ?? this.repo.triggers.get(created.origin.triggerId)
    if (from) this.stage(from, 'attach', { ref: id, data: { ticketId: id, created: true } })
    if (lightweight) this.startInline(created, { ref: 'inline' })
    else this.options.executor.start(created, assignment!)
    this.emit('ticket.created', { ticketId: id, decisionId, strength: mandate.strength })
  }
  /** The default caps on a task tree: depth below the root, direct children of one node, and live children of one root. */
  static readonly MAX_DEPTH = 5
  static readonly MAX_DIRECT_CHILDREN = 8
  static readonly MAX_ROOT_CHILDREN = 32

  /**
   * Create a child ticket under `parentId` in the same authorization root, and start its own tracked worker.
   * The child has no Decision or Mandate of its own: every action gate resolves the root's. The parent owner may create it
   * only while the parent and root are live, the parent is tracked, the root is consistent, and the depth, width and live
   * quota limits hold; `parentTicketId` never changes afterwards.
   * @throws UserError when the parent or root is unavailable, the request would exceed a limit, or the parent is lightweight.
   */
  delegate(parentId: string, request: { goal: string; scope?: string; title?: string; name?: string; assignment?: string; replaces?: string },
    at = this.now()): Ticket {
    const parent = this.require(parentId)
    const sessionId = `worker-${parentId}`
    if (!liveTicket(parent)) throw new UserError('parentUnavailable', { parent: parentId })
    if (ticketForm(parent) === 'lightweight') throw new UserError('lightweightCannotDelegate')
    const rootId = rootTicketIdOf(parent)
    const root = this.repo.tickets.get(rootId)
    if (!root || !liveTicket(root)) throw new UserError('parentUnavailable', { parent: parentId })
    if (isChildTicket(parent) && !rootConsistent(parent, this.repo.tickets.get(parent.parentTicketId!))) {
      throw new UserError('rootInconsistent')
    }
    const depth = depthOf(parent, id => this.repo.tickets.get(id)) + 1
    if (depth > Tickets.MAX_DEPTH) throw new UserError('delegationDepthExceeded', { max: String(Tickets.MAX_DEPTH), depth: String(depth) })
    const siblings = this.repo.tickets.childrenOf(parentId)
    const liveSiblings = siblings.filter(child => !child.ended || !childResolutionValid(child))
    if (liveSiblings.length >= Tickets.MAX_DIRECT_CHILDREN) {
      throw new UserError('delegationWidthExceeded', { max: String(Tickets.MAX_DIRECT_CHILDREN), count: String(liveSiblings.length) })
    }
    const live = this.repo.tickets.subtree(rootId).filter(ticket => ticket.id !== rootId && (childUnresolved(ticket) || !childResolutionValid(ticket)))
    if (live.length >= Tickets.MAX_ROOT_CHILDREN) {
      throw new UserError('delegationQuotaExceeded', { max: String(Tickets.MAX_ROOT_CHILDREN), count: String(live.length) })
    }
    // A replacement's creation and its predecessor's reassignment happen in the caller's transaction.
    const id = key('ticket', parentId, 'child', String(siblings.length + 1), at)
    if (this.repo.tickets.get(id)) throw new UserError('delegationCycle')
    const goal = request.goal.trim()
    if (!goal) throw new TypeError('A child Ticket needs a goal')
    const title = (request.title ?? goal.split('\n')[0] ?? goal).slice(0, 200)
    const parentExecution = parent.execution
    const childName = `${parentExecution?.name ?? ''}-child-${siblings.length + 1}`
    const childExecution = parentExecution
      ? { name: childName,
          directory: this.options.childSibling?.()
            ? `${childSiblingRoot(root, parent)}/${childName}`
            : `${parentExecution.directory}/child-${siblings.length + 1}`,
          assignment: [goal, request.scope ? `Scope: ${request.scope}` : ''].filter(Boolean).join('\n') }
      : request.name ? { name: request.name, directory: request.name, assignment: [goal, request.scope ? `Scope: ${request.scope}` : ''].filter(Boolean).join('\n') } : undefined
    const delegation: Delegation = { parentTicketId: parentId, rootTicketId: rootId, goal,
      ...(request.scope?.trim() ? { scope: request.scope.trim() } : {}), requestedBy: { ticketId: parentId, sessionId }, attempt: 1, createdAt: at }
    const child: Ticket = { id, title, form: 'tracked', channels: [], assignments: [], inputs: [], undelivered: [],
      createdAt: at, updatedAt: at, origin: { ...parent.origin }, parentTicketId: parentId, rootTicketId: rootId, delegation,
      ...(childExecution ? { execution: childExecution } : {}) }
    if (request.assignment) child.execution = { ...(childExecution ?? { name: request.name ?? id, directory: request.name ?? id }), assignment: request.assignment }
    const assignment = this.newAssignment(child, 1)
    this.repo.tickets.save(child)
    this.options.executor.start(child, assignment)
    this.stageOf(parent, 'delegation.delegate', { ref: id, at, data: { parentTicketId: parentId, childTicketId: id, attempt: 1, depth } })
    this.stageOf(child, 'dispatch', { ref: assignment.id, at, data: { parentTicketId: parentId, rootTicketId: rootId, attempt: 1 } })
    this.emit('ticket.delegated', { parentTicketId: parentId, ticketId: id, rootTicketId: rootId, attempt: 1, depth })
    if (request.replaces) this.childDecision(parentId, request.replaces, { source: 'dsh-superagent', id: 'parent-owner' }, 'reassigned',
      `Replaced by ${id}`, id, at)
    return this.require(id)
  }
  /**
   * Record a child ticket's report in its parent owner's Inputs and wake the parent, without ending the child. The child's
   * own `ready`/`dropped` reports are reports, not ends: only its parent owner or an ancestor's stop ends it.
   * @throws UserError for a stale attempt or assignment, or a child already judged terminally.
   */
  childReport(childId: string, attempt: number, assignmentId: string, report: { state: ReportState; summary: string; review?: unknown
    humanAction?: string }, at = this.now()): Ticket {
    const child = this.require(childId)
    if (!child.parentTicketId) throw new UserError('notChildTicket')
    const parent = this.repo.tickets.get(child.parentTicketId)
    const delegation = child.delegation
    if (!parent || !delegation) throw new UserError('parentUnavailable', { parent: child.parentTicketId })
    if (!liveTicket(parent)) {
      this.orphanChild(child, 'parent-ended')
      return this.require(childId)
    }
    if (delegation.resolution) throw new UserError('childClosed')
    if (attempt !== delegation.attempt || latestAssignment(child)?.id !== assignmentId) {
      throw new UserError('staleChildAttempt', { attempt: String(attempt), current: String(delegation.attempt) })
    }
    const previous = delegation.lastReportAt
    if (previous && report.state === 'ready' && Date.parse(at) < Date.parse(previous)) throw new UserError('staleChildAttempt',
      { attempt: String(attempt), current: String(delegation.attempt) })
    delegation.reportCount = (delegation.reportCount ?? 0) + 1
    delegation.lastReportAt = at
    child.updatedAt = at
    // One pending report per child: replace what the parent has not read yet rather than queueing a backlog.
    const inputId = key('input', parent.id, 'child-report', childId, String(delegation.attempt), at)
    const replaced = parent.inputs.filter(input => input.kind === 'child-report' && input.childTicketId === childId && !input.readAt)
    parent.inputs = parent.inputs.filter(input => !replaced.includes(input))
    parent.undelivered = parent.undelivered.filter(id => !replaced.some(input => input.id === id))
    const input: TicketInput = { id: inputId, kind: 'child-report', childTicketId: childId, attempt: delegation.attempt, assignmentId,
      reportAt: at, state: report.state, summary: report.summary, ...(report.review ? { review: report.review as never } : {}),
      ...(report.humanAction ? { humanAction: report.humanAction } : {}), at }
    this.addInput(parent, input)
    this.repo.tickets.save(child)
    // A new child report invalidates the root's review acceptance: the aggregate it approved no longer describes the tree.
    this.invalidateRootReview(child)
    this.stageOf(parent, 'delegation.report', { ref: inputId, at, data: { childTicketId: childId, attempt: delegation.attempt, state: report.state } })
    this.emit('ticket.child.reported', { parentTicketId: parent.id, ticketId: childId, attempt: delegation.attempt, state: report.state })
    return this.require(childId)
  }
  /** Mark a child whose parent cannot receive its work as orphaned, for the nearest living ancestor or a person to decide. */
  orphan(childId: string, reason: string): void {
    const child = this.require(childId)
    if (!isChildTicket(child)) throw new UserError('notChildTicket')
    this.orphanChild(child, reason)
  }
  /** Mark a child whose parent cannot receive its work as orphaned, for the nearest living ancestor or a person to decide. */
  orphanChild(child: Ticket, reason: string): void {
    if (!child.delegation || child.delegation.orphaned) return
    const at = this.now()
    child.delegation.orphaned = { reason, at }
    // An orphaned child must not keep working: its parent can no longer receive or judge the result.
    const stopping = child.assignments.filter(assignment => assignment.state !== 'ended')
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at; assignment.endedReason = 'orphaned' }
    child.undelivered = []
    child.updatedAt = at
    this.repo.tickets.save(child)
    for (const assignment of stopping) this.options.executor.stop(child, assignment, 'orphaned')
    // An orphaned child no longer writes; its space must not stay held as if it could.
    this.options.executor.release?.(child)
    // The nearest live node carries the one attention; a child never pages anyone itself and is not resumed silently.
    const root = this.repo.tickets.get(rootTicketIdOf(child))
    const carrier = root && liveTicket(root) ? root : child
    carrier.attention = { id: key('attention', carrier.id, 'orphan', child.id), question:
      `Child ticket ${child.id} (${child.title}) is orphaned: ${reason}. Decide whether to retry the parent, cancel the child, or take over the work.`,
      triggerId: carrier.origin.triggerId }
    carrier.updatedAt = at
    this.repo.tickets.save(carrier)
    this.emit('ticket.child.orphaned', { parentTicketId: child.parentTicketId!, ticketId: child.id, reason })
  }
  /**
   * The parent owner accepts a child ticket's current ready report: the child ends completed, its resolution pairs with the
   * end, and its own descendants must already be resolved. The acceptance is the parent's, not a person's Review confirmation.
   * @throws UserError when the parent or child is unavailable, the child has unresolved descendants, or its latest report is
   * not a ready result.
   */
  acceptChild(parentId: string, childId: string, by: ActorRef, merge?: { into?: string; childRevisions?: string[]; conflicts?: string[]
    resolution?: 'merged' | 'escalated' | 'none'; reason?: string }, at = this.now()): Ticket {
    const { parent, child } = this.childPair(parentId, childId)
    if (!liveTicket(parent)) throw new UserError('parentUnavailable', { parent: parentId })
    const delegation = child.delegation!
    if (child.ended || delegation.resolution) throw new UserError('childClosed')
    const unresolved = this.unresolvedChildren(child.id)
    if (unresolved.length) throw new UserError('childStillOpen', { tickets: unresolved.map(item => item.id).join(', ') })
    const report = currentChildReport(child)
    if (!report || report.state !== 'ready') throw new UserError('reviewNotReady')
    const disposition = this.dispose(parent, child, 'accepted', by, at, 'accepted-by-parent')
    delegation.resolution = { kind: 'accepted', by, at, acceptedReportAt: report.at, acceptedAttempt: delegation.attempt,
      traceId: disposition.traceId }
    delegation.merge = { at, by, childRevisions: merge?.childRevisions ?? (report.review ? [report.review.deliverable.artifact.revision] : []),
      conflicts: merge?.conflicts ?? [], resolution: merge?.resolution ?? 'none', ...(merge?.into ? { into: merge.into } : {}),
      ...(merge?.reason ? { reason: merge.reason } : {}) }
    this.finishChild(child, 'completed', at, 'accepted-by-parent')
    this.stageOf(parent, 'delegation.review', { ref: disposition.traceId, at, data: { childTicketId: childId, decision: 'accepted',
      attempt: delegation.attempt } })
    this.emit('ticket.child.reviewed', { parentTicketId: parentId, ticketId: childId, decision: 'accepted' })
    return this.require(childId)
  }
  /**
   * Reopen a child ticket for another attempt: the old Assignment is ended, `attempt` increments so its late reports are
   * refused, the accepted/merge state is cleared, and a new worker Assignment is queued. A root that already has a person's
   * review acceptance cannot be rewound this way.
   * @throws UserError when the parent or child is unavailable, the child is terminally judged, or the root is already approved.
   */
  returnChild(parentId: string, childId: string, by: ActorRef, reason: string, at = this.now()): Ticket {
    const { parent, child } = this.childPair(parentId, childId)
    if (!liveTicket(parent)) throw new UserError('parentUnavailable', { parent: parentId })
    const delegation = child.delegation!
    // An accepted child may be reopened until the root's aggregate gets a person's review acceptance; any other
    // terminal resolution (cancel/fail) stays closed.
    const accepted = delegation.resolution?.kind === 'accepted' && child.ended?.outcome === 'completed'
    if ((child.ended || delegation.resolution) && !accepted) throw new UserError('childClosed')
    const root = this.repo.tickets.get(rootTicketIdOf(child))
    if (root?.assignments.some(assignment => assignment.report?.accepted)) throw new UserError('childClosed')
    const previous = latestAssignment(child)
    delete delegation.orphaned
    delete child.attention
    // Record the judgement against the attempt and report it judges, before the next attempt begins.
    const disposition = this.dispose(parent, child, 'returned', by, at, reason)
    delegation.attempt += 1
    delete delegation.resolution
    delete delegation.merge
    delete delegation.endedAt
    // A returned child is open work again, not an ended-without-resolution state.
    delete child.ended
    child.updatedAt = at
    if (previous && previous.state !== 'ended') this.endAssignment(child, previous, 'returned')
    const assignment = this.newAssignment(child, delegation.attempt)
    this.repo.tickets.save(child)
    if (previous) this.options.executor.stop(child, previous, 'returned')
    this.options.executor.start(child, assignment)
    this.stageOf(parent, 'delegation.review', { ref: disposition.traceId, at, data: { childTicketId: childId, decision: 'returned',
      attempt: delegation.attempt } })
    this.emit('ticket.child.reviewed', { parentTicketId: parentId, ticketId: childId, decision: 'returned' })
    return this.require(childId)
  }
  /**
   * Cancel a child ticket and its whole subtree; `failed` ends the child as dropped after a failure the parent will not
   * retry. Each descendant records a cancelled resolution, and no end gate can block an explicit cancellation.
   */
  cancelChild(parentId: string, childId: string, by: ActorRef, reason: string, kind: 'cancelled' | 'failed' = 'cancelled',
    at = this.now()): Ticket {
    const { parent, child } = this.childPair(parentId, childId)
    if (!liveTicket(parent)) throw new UserError('parentUnavailable', { parent: parentId })
    if (child.ended || child.delegation!.resolution) throw new UserError('childClosed')
    this.cancelTree(child, by, kind, at, reason)
    this.stageOf(parent, 'delegation.review', { ref: key('disposition', childId, kind, at), at, data: { childTicketId: childId,
      decision: kind, attempt: child.delegation?.attempt } })
    this.emit('ticket.child.reviewed', { parentTicketId: parentId, ticketId: childId, decision: kind })
    return this.require(childId)
  }
  /** Record a parent owner's non-terminal judgement about a child: self-work, an escalation, or a reassignment. */
  childDecision(parentId: string, childId: string, by: ActorRef, decision: 'self-work' | 'escalated' | 'reassigned', reason: string,
    replacementTicketId?: string, at = this.now()): ChildReportDisposition {
    const { parent, child } = this.childPair(parentId, childId)
    if (!liveTicket(parent)) throw new UserError('parentUnavailable', { parent: parentId })
    if (child.ended || child.delegation!.resolution) throw new UserError('childClosed')
    const disposition = this.dispose(parent, child, decision, by, at, reason, replacementTicketId)
    this.stageOf(parent, decision === 'self-work' ? 'delegation.self-work' : 'delegation.review', { ref: disposition.traceId, at,
      data: { childTicketId: childId, decision, ...(replacementTicketId ? { replacementTicketId } : {}) } })
    this.emit('ticket.child.reviewed', { parentTicketId: parentId, ticketId: childId, decision })
    return disposition
  }
  /** The live root tickets' direct children that still wait for their parent's judgement, including corrupt end pairs. */
  unresolvedChildren(ticketId: string): Ticket[] {
    return this.repo.tickets.childrenOf(ticketId).filter(child => !child.ended || !childResolutionValid(child))
  }
  /** Refuse a human or main-Session command aimed at a child node: its parent owner decides those. */
  private assertRoot(ticket: Ticket): void {
    if (isChildTicket(ticket)) throw new UserError('childRequiresParent')
  }
  /** The root, parent and child of a delegation, refusing a link that is not exactly the child's parent. */
  private childPair(parentId: string, childId: string): { parent: Ticket; child: Ticket } {
    const parent = this.require(parentId)
    const child = this.require(childId)
    if (!isChildTicket(child) || child.parentTicketId !== parentId) throw new UserError('unknownChildTicket')
    const rootId = rootTicketIdOf(parent)
    if (child.rootTicketId !== rootId) throw new UserError('rootInconsistent')
    if (!this.repo.tickets.get(rootId)) throw new UserError('parentUnavailable', { parent: parentId })
    return { parent, child }
  }
  /** Append a judgement to the child's delegation and return it. */
  private dispose(parent: Ticket, child: Ticket, decision: ChildReportDisposition['decision'], by: ActorRef, at: string,
    reason?: string, replacementTicketId?: string): ChildReportDisposition {
    const delegation = child.delegation!
    const report = currentChildReport(child)
    const assignment = latestAssignment(child)
    const reportId = report && delegation.lastReportAt ? key('child-report', child.id, String(delegation.attempt), delegation.lastReportAt) : undefined
    const disposition: ChildReportDisposition = { childTicketId: child.id, attempt: delegation.attempt, decision, by, at,
      traceId: key('disposition', child.id, String(delegation.attempt), at, decision),
      ...(reportId ? { reportId } : {}), ...(assignment ? { assignmentId: assignment.id } : {}),
      ...(report ? { reportAt: report.at } : {}), ...(reason ? { reason } : {}), ...(replacementTicketId ? { replacementTicketId } : {}) }
    delegation.dispositions = [...delegation.dispositions ?? [], disposition]
    delegation.lastDisposition = disposition
    child.updatedAt = at
    this.repo.tickets.save(child)
    return disposition
  }
  /** End a child ticket without the root end gate; its resolution must already have been written. */
  private finishChild(child: Ticket, outcome: Extract<TicketOutcome, 'completed' | 'stopped' | 'dropped'>, at: string, reason: string): void {
    const stopping = child.assignments.filter(assignment => assignment.state !== 'ended')
    child.ended = { at, by: 'executor', outcome, reason }
    child.undelivered = []
    child.updatedAt = at
    delete child.attention
    delete child.delivery
    delete child.endPending
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at; assignment.endedReason = reason }
    if (child.delegation) child.delegation.endedAt = at
    this.repo.tickets.save(child)
    this.emit('ticket.ended', { ticketId: child.id, by: 'executor', outcome, reason })
    for (const assignment of stopping) this.options.executor.stop(child, assignment, reason)
    this.options.executor.release?.(child)
    this.stageOf(child, 'report', { ref: `${at}:${outcome}`, at, data: { outcome, reason, childTicketId: child.id } })
  }
  /** Cancel a child subtree depth first, so no descendant is left live under an ended parent. */
  private cancelTree(child: Ticket, by: ActorRef, kind: 'cancelled' | 'failed', at: string, reason: string): void {
    for (const descendant of this.repo.tickets.childrenOf(child.id)) {
      if (!descendant.ended) this.cancelTree(descendant, by, 'cancelled', at, 'parent-cancelled')
    }
    if (!liveTicket(child)) return
    const delegation = child.delegation!
    if (kind === 'failed') delegation.resolution = { kind: 'failed', by, at, reason, traceId: key('disposition', child.id, 'failed', at) }
    else delegation.resolution = { kind: 'cancelled', by, at, reason, traceId: key('disposition', child.id, 'cancelled', at) }
    this.dispose(this.repo.tickets.get(child.parentTicketId!) ?? child, child, kind, by, at, reason)
    this.finishChild(child, kind === 'failed' ? 'dropped' : 'stopped', at, kind === 'failed' ? 'child-failed' : reason)
  }
  /** Cancel every live descendant of a root or parent that ends by a person's stop or a `dropped` report. */
  private cancelSubtree(parent: Ticket, by: TicketEndBy, reason: string): void {
    const actor: ActorRef = { source: 'dsh-superagent', id: 'engine' }
    const at = this.now()
    for (const child of this.repo.tickets.childrenOf(parent.id)) {
      if (!liveTicket(child)) continue
      this.cancelTree(child, actor, 'cancelled', at, by === 'human' ? 'parent-stopped' : 'parent-dropped')
    }
    void reason
  }
  /** Clear the root's person acceptance when a child report makes the review aggregate stale. */
  private invalidateRootReview(child: Ticket): void {
    const root = this.repo.tickets.get(rootTicketIdOf(child))
    if (!root) return
    let changed = false
    for (const assignment of root.assignments) if (assignment.report?.accepted) { delete assignment.report.accepted; changed = true }
    if (changed) { root.updatedAt = this.now(); this.repo.tickets.save(root) }
  }
  /**
   * Start an inline run of `ticket`, record its dispatch stage and hand the host its run token. The token names every
   * callback of this run, so a callback left over from an earlier run is refused instead of acting on this one.
   */
  private startInline(ticket: Ticket, dispatch: { ref: string; data?: Record<string, unknown> }): void {
    const run = key('inline', ticket.id, String(++this.inlineSeq))
    const startedAt = this.now()
    this.inlineRuns.set(ticket.id, { run, startedAt, lastAt: startedAt, steps: 0 })
    this.stageOf(ticket, 'dispatch', { ref: dispatch.ref, data: { form: 'lightweight', ...dispatch.data } })
    this.options.inline!.start(ticket, run)
  }
  /**
   * Record one Action a lightweight ticket's inline run performed, as it runs: an `action` stage under the Trigger's trace,
   * naming the Action's kind, source, object, revision and level. The run token and the step's position make the stage id
   * unique, so a repeated Action is still one row per time it ran. A step above `draft` is refused, as that level needs a
   * tracked ticket and a worker Session (R5), and the Mandate is revalidated at the Action's level.
   * @throws UserError when the ticket has ended or its Mandate no longer allows the Action.
   * @throws TypeError when the run is not the ticket's current one, the ticket is not lightweight, has an Assignment, the
   * step's time is invalid or before the run, or the step is above `draft`.
   */
  inlineAction(ticketId: string, run: string, step: InlineStep): void {
    const ticket = this.require(ticketId)
    const state = this.inlineRuns.get(ticketId)
    if (state?.run !== run) throw new TypeError('The inline run is no longer current')
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (ticketForm(ticket) !== 'lightweight') throw new TypeError('Only a lightweight Ticket records inline actions')
    if (ticket.assignments.length) throw new TypeError('A lightweight Ticket runs without an Assignment')
    if (typeof step.at !== 'string' || !Number.isFinite(Date.parse(step.at)) || Date.parse(step.at) < Date.parse(state.startedAt)) {
      throw new TypeError('An inline action needs a valid time at or after its run started')
    }
    if (!withinActionLevel(step.action.level, 'draft')) throw new TypeError(`A lightweight Ticket cannot record a ${step.action.level} action`)
    const mandate = ticket.mandate
    if (!mandate || !this.policy().revalidate(mandate, step.at, { level: step.action.level }).ok
      || (mandate.maxActionLevel !== undefined && !withinActionLevel(step.action.level, mandate.maxActionLevel))) {
      throw new UserError('mandateRevoked')
    }
    state.steps += 1
    state.lastAt = state.lastAt > step.at ? state.lastAt : step.at
    this.stageOf(ticket, 'action', { at: step.at, ref: `${run}:${state.steps}`, data: {
      action: { kind: step.action.kind, source: step.action.source, objectId: step.action.objectId, revision: step.action.revision,
        level: step.action.level, actor: step.action.actor }, ok: step.ok, ...step.error === undefined ? {} : { error: step.error.slice(0, 300) } } })
  }
  /**
   * Record that a lightweight ticket's inline run ended and end it: the trigger Inputs it read are taken up in their
   * dispositions, the person's original message is taken up, and a `report` stage names the outcome. Its actions are
   * already recorded by `inlineAction`, and the report is dated no earlier than the last of them.
   * @throws UserError when the ticket has ended.
   * @throws TypeError when the run is not the ticket's current one, the ticket is not lightweight, has an Assignment, names
   * an Input that is not its own, or carries an outcome or summary that is not a result.
   */
  inlineFinished(ticketId: string, run: string, result: InlineResult): Ticket {
    const ticket = this.require(ticketId)
    const state = this.inlineRuns.get(ticketId)
    if (state?.run !== run) throw new TypeError('The inline run is no longer current')
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (ticketForm(ticket) !== 'lightweight') throw new TypeError('Only a lightweight Ticket finishes inline')
    if (ticket.assignments.length) throw new TypeError('A lightweight Ticket runs without an Assignment')
    if (result.outcome !== 'completed' && result.outcome !== 'dropped') throw new TypeError('A lightweight Ticket ends completed or dropped')
    if (typeof result.summary !== 'string' || (result.read !== undefined && !Array.isArray(result.read))) {
      throw new TypeError('An inline result needs a summary and, when given, a list of Input ids')
    }
    const read = (result.read ?? []).map(id => {
      const input = ticket.inputs.find(item => item.id === id)
      if (!input) throw new TypeError('A lightweight Ticket can only read its own Inputs')
      return input
    })
    const at = this.now()
    const reportAt = at > state.lastAt ? at : state.lastAt
    for (const input of read) if (input.kind === 'trigger') input.readAt ??= reportAt
    ticket.undelivered = ticket.undelivered.filter(id => !read.some(input => input.id === id))
    // A run that read a person's later message did that message too, so its disposition says so rather than handing it back.
    for (const input of read) if (input.kind === 'trigger') this.takeUp(ticket.id, input.triggerId)
    // The ticket did the person's original message, so its disposition says it was taken up rather than left for Eval again.
    this.takeUp(ticket.id, ticket.origin.triggerId)
    this.repo.tickets.save(ticket)
    this.stageOf(ticket, 'report', { at: reportAt, ref: `${run}:report`, data: { state: result.outcome, form: 'lightweight' } })
    this.end(ticketId, 'executor', result.outcome, reportAt, result.summary)
    return this.require(ticketId)
  }
  /**
   * Subscribes an open ticket to `thread` and records it in `ticket.follows` (`own` when opened by the ticket).
   * @throws UserError when the ticket is unknown or has ended.
   */
  bind(ticketId: string, thread: ThreadRef, own: boolean): Ticket {
    this.assertRoot(this.require(ticketId))
    if (!liveTicket(this.require(ticketId))) throw new UserError('ticketEnded')
    this.subscribe(ticketId, thread)
    const ticket = this.require(ticketId)
    const followed = threadKey(thread)
    const follow = ticket.follows?.find(item => item.thread === followed)
    // Re-binding a thread reopens it if previously closed; `own` remains true once set.
    if (follow) { follow.own ||= own; delete follow.closed } else ticket.follows = [...ticket.follows ?? [], { thread: followed, own }]
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    return ticket
  }
  /**
   * Adds a Channel to an open ticket, subscribing it to the Channel's Thread so later events reach it, and records the binding
   * as an Input for audit. It does not make the Thread a state point; `bind` does that. The caller checks that the Source is
   * enabled and that the address may receive replies; repeating a binding changes nothing.
   * @throws UserError when the ticket is unknown or has ended, or the Channel's Thread belongs to another Source.
   */
  bindChannel(ticketId: string, channel: ChannelRef): Ticket {
    const ticket = this.require(ticketId)
    this.assertRoot(ticket)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const thread = channelThread(channel)
    if (thread.source !== channel.source || !thread.id) throw new UserError('channelThreadMismatch')
    this.subscribe(ticketId, thread)
    if (!ticket.channels.some(item => sameChannel(item, channel))) {
      const at = this.now()
      ticket.channels.push(channel)
      ticket.inputs.push({ id: key('input', ticketId, 'binding', channel.source, channel.thread, at), kind: 'binding', channel, at })
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
    }
    return ticket
  }
  /**
   * Record that a Thread open tickets follow closed, and end each one done with its Threads (see `followsDone`), unless its
   * work has not finished (see `unfinished`); such work ends the ticket once it reports ready.
   */
  threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void {
    const closed = threadKey(thread)
    for (const ticket of this.repo.tickets.open()) {
      const follow = ticket.follows?.find(item => item.thread === closed && !item.closed)
      if (!follow) continue
      follow.closed = { at, outcome }
      this.repo.tickets.save(ticket)
      const done = this.followsDone(ticket)
      if (!done || this.unfinished(ticket, at)) continue
      // A thread closing is a pending end while child tickets are unresolved or person confirmations are still unapproved;
      // the parent owner or the final approval applies it afterwards.
      const pending: PendingEnd = { by: 'thread', outcome: done.outcome, at: done.at, ref: closed }
      if (this.unresolvedChildren(ticket.id).length || (this.requiresReviewApproval(ticket) && !this.reviewApproved(ticket))) {
        ticket.endPending = pending
        this.repo.tickets.save(ticket)
        this.addInput(ticket, { id: key('input', ticket.id, 'end-gate', done.at), kind: 'end-gate', pending, at: this.now() })
        this.emit('ticket.end.pending', { ticketId: ticket.id, by: 'thread', outcome: done.outcome })
        continue
      }
      // Work resumed after the close and finished ends now.
      const resumed = Date.parse(latestAssignment(ticket)?.createdAt ?? '') > Date.parse(at)
      this.end(ticket.id, 'executor', done.outcome, resumed ? this.now() : done.at)
    }
  }
  /**
   * How a ticket that follows Threads is done with them: once no Thread it opened (`own`) is still open, or, when it opened none,
   * once every one it follows closed. It ends as the latest close among those Threads did; undefined while it is not done.
   */
  followsDone(ticket: Ticket): Follow['closed'] {
    const follows = ticket.follows ?? []
    const own = follows.filter(item => item.own)
    const counted = own.length ? own : follows
    if (!counted.length || counted.some(item => !item.closed)) return undefined
    return counted.map(item => item.closed!).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
  }
  /** The root's current review aggregate, read through the Store's children index rather than one query per node. */
  private aggregateOf(ticket: Ticket): ReturnType<typeof reviewAggregate> {
    return reviewAggregate(ticket, id => this.repo.tickets.get(id), id => this.repo.tickets.childrenOf(id))
  }
  /** Whether the root still carries person confirmations that need a final approval before accepted work can end. */
  requiresReviewApproval(ticket: Ticket): boolean {
    return (this.aggregateOf(ticket)?.confirmations.length ?? 0) > 0
  }
  /** Whether a person accepted exactly the current aggregate revision. */
  reviewApproved(ticket: Ticket): boolean {
    const aggregate = this.aggregateOf(ticket)
    return !!aggregate && acceptedReviewRevision(ticket) === aggregate.reviewRevision
  }
  /**
   * Apply a person's final approval to the Ticket's end after the approval was recorded. A pending close (a PR or Thread
   * that closed first) keeps its outcome; otherwise a closed follow ends with that outcome, a Ticket with no follows ends
   * completed, and one whose follows are still open waits. Approval itself does not end open work.
   */
  endAfterApproval(ticketId: string, at = this.now()): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    if (ticket.endPending) { this.end(ticketId, 'executor', ticket.endPending.outcome, ticket.endPending.at, ticket.endPending.reason); return }
    const done = this.followsDone(ticket)
    if (done) { this.end(ticketId, 'executor', done.outcome, done.at); return }
    if (!(ticket.follows ?? []).length) this.end(ticketId, 'executor', 'completed', at)
  }
  /**
   * The Trigger to attach to a ticket, once the ticket may take it.
   * @throws UserError when the trigger or ticket is unknown, a ticket's worker still decides the trigger, a person stopped the ticket, or an ended ticket's Mandate no longer revalidates.
   */
  attachable(ticketId: string, triggerId: string): Trigger {
    const trigger = this.repo.triggers.get(triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // A follow-up that reached a ticket goes elsewhere only once the workers that decide it hand it back.
    this.leftToWorkers(trigger)
    const current = this.require(ticketId)
    this.assertRoot(current)
    if (current.ended?.by === 'human') throw new UserError('ticketStopped')
    const mandate = this.repo.tickets.get(rootTicketIdOf(current))?.mandate
    if (!liveTicket(current) && (!mandate || !this.policy().revalidate(mandate, this.now()).ok)) throw new UserError('mandateRevoked')
    return trigger
  }
  /**
   * Subscribe a ticket to an attached Trigger's Threads and add the Trigger as an Input, with its note. The ticket's worker
   * then decides it, as it decides a message that reached the ticket on its own Thread; a worker that does not hold the
   * message as its ticket's takes it as a new Input, which wakes an ended ticket as any attached message does.
   */
  attach(ticketId: string, trigger: Trigger, note?: string): void {
    this.assertRoot(this.require(ticketId))
    for (const ref of trigger.threads) this.subscribe(ticketId, ref)
    // A person's sending it to Eval, which routed it here, is over, and so is the ticket's reading it for context only.
    const current: TriggerDisposition = this.repo.triggers.disposition(trigger.id) ?? { fanout: [], at: this.now() }
    const { context, requeued, ...disposition } = current
    const followed = context?.filter(id => id !== ticketId)
    this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: [...new Set([...disposition.fanout, ticketId])],
      ...followed?.length ? { context: followed } : {} })
    const ticket = this.require(ticketId)
    const id = key('input', ticketId, 'trigger', trigger.id)
    const existing = ticket.inputs.find(input => input.id === id)
    const at = this.now()
    const input = (inputId: string): TicketInput => ({ id: inputId, kind: 'trigger', triggerId: trigger.id, at, ...(note ? { note } : {}),
      ...trigger.human ? { human: true } : {} })
    if (existing?.kind !== 'trigger') this.addInput(ticket, input(id))
    else if (note && ticket.undelivered.includes(id)) { existing.note = note; ticket.updatedAt = at; this.repo.tickets.save(ticket) }
    // A person sent it to Eval, or the ticket let it go before its worker took it up, read it for context only, or ended after
    // its worker had it, so the worker gets it again.
    else if (requeued || !current.fanout.includes(ticketId) || context?.includes(ticketId) || !liveTicket(ticket)) {
      this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'attached', at)))
    }
    // The worker has the message already, so the note comes with it again.
    else if (note) this.addInput(ticket, input(key('input', ticketId, 'trigger', trigger.id, 'note', note)))
    this.stage(trigger, 'attach', { ref: ticketId, data: { ticketId, created: false } })
  }
  /**
   * Ask a running worker whose latest report is `waiting` for a status report; leaves any other ticket alone.
   * @returns whether the status request input was queued.
   * @throws UserError when the ticket is unknown.
   */
  requestStatus(ticketId: string): boolean {
    const ticket = this.require(ticketId)
    this.assertRoot(ticket)
    if (!liveTicket(ticket) || runningAssignment(ticket)?.report?.state !== 'waiting') return false
    this.addInput(ticket, { id: `status:${ticketId}:${ticket.updatedAt}`, kind: 'text', text: STATUS_REQUEST, at: this.now() })
    return true
  }
  /**
   * Stops a ticket on behalf of a human, ending any active assignments.
   * @throws UserError when the ticket is unknown.
   */
  stop(ticketId: string, reason?: string): Ticket {
    this.assertRoot(this.require(ticketId))
    this.end(ticketId, 'human', 'stopped', this.now(), reason)
    return this.require(ticketId)
  }
  /**
   * Ends the stalled assignment of a retryable open ticket (`failed`, `blocked`, or failed input delivery) and starts a new one.
   * @throws UserError when the ticket is unknown or not retryable.
   */
  retry(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    this.assertRoot(ticket)
    const latest = latestAssignment(ticket)
    if (!canRetry(ticket) || !latest) throw new UserError('notRetryable')
    this.endAssignment(ticket, latest, 'retried')
    this.requeueUntaken(ticket, latest)
    const assignment = this.newAssignment(ticket)
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.options.executor.stop(ticket, latest, 'retried')
    this.options.executor.start(ticket, assignment)
    return ticket
  }
  /**
   * Drops a ticket's Subscription to a Thread its worker found unrelated, and hands back, with `reason`, the person's messages there that the ticket decides.
   * @throws UserError when the ticket is unknown, or `thread` is an origin thread, a bound `follows` thread, or not subscribed.
   */
  markUnrelated(ticketId: string, thread: string, reason: string): void {
    const ticket = this.require(ticketId)
    this.assertRoot(ticket)
    if (this.source(ticket)?.threads.some(ref => threadKey(ref) === thread)) throw new UserError('sourceThread')
    if (ticket.follows?.some(item => item.thread === thread)) throw new UserError('followedThread')
    if (!this.repo.threads.get(thread)?.subscriptions.includes(ticketId)) throw new UserError('notFollowing')
    this.dropSubscriptions(thread, 'executor', ticketId, reason)
    // Its worker found the Thread is not its ticket's: it hands back, with its reason, the person's messages there it decides.
    for (const trigger of this.triggersOf(ticket)) {
      if (trigger.threads.some(ref => threadKey(ref) === thread) && this.owners(trigger).includes(ticketId)) this.handBack(ticketId, trigger, reason)
    }
  }
  /**
   * Tell each open ticket a Policy change bears on how it does, oldest first, so their deliveries queue in the order they
   * were accepted; the others are left alone.
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    const at = this.now()
    // Iterate tickets oldest first so deliveries queue in acceptance order.
    for (const ticket of this.repo.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const effect = effects.get(ticket.id)
      // Include `at` in the input key so repeated transitions between the same policy versions still record a new input.
      if (effect) this.addInput(ticket, { id: key('input', ticket.id, 'policy', from, to, at), kind: 'policy-changed', from, to, at, effect })
    }
  }
  /**
   * Drop a Thread's Subscriptions, every ticket's or only `ticketId`'s, and say so; false when none dropped. A ticket that
   * followed the Thread follows it no more, so its close no longer ends the ticket. Each ticket keeps deciding the messages
   * it received from the Thread.
   */
  dropSubscriptions(thread: string, by: 'person' | 'executor', ticketId?: string, reason?: string): boolean {
    const current = this.repo.threads.get(thread)
    const tickets = current?.subscriptions.filter(id => ticketId === undefined || id === ticketId) ?? []
    if (!current || !tickets.length) return false
    current.subscriptions = current.subscriptions.filter(id => !tickets.includes(id))
    this.repo.threads.save(current)
    for (const id of tickets) {
      const ticket = this.repo.tickets.get(id)
      if (!ticket?.follows?.some(item => item.thread === thread)) continue
      const { follows: before, ...rest } = ticket
      const follows = before.filter(item => item.thread !== thread)
      this.repo.tickets.save(follows.length ? { ...rest, follows } : rest)
    }
    for (const id of tickets) this.emit('thread.unsubscribed', { threadKey: current.key, ticketId: id, by, ...(reason ? { reason } : {}) })
    return true
  }
  /**
   * Add an Input once (idempotently) and ask the Executor to deliver it, or to launch again a pending Assignment whose launch
   * failed once no person is waited for: a Policy change alone does not launch it again.
   */
  addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some(existing => existing.id === input.id)) return
    ticket.inputs.push(input); ticket.updatedAt = this.now()
    // Hold back automated inputs while the worker is waiting on a person.
    const held = liveTicket(ticket) && automatic(input) && waitsForPerson(ticket)
    if (!held) ticket.undelivered.push(input.id)
    this.repo.tickets.save(ticket)
    if (!liveTicket(ticket) || held) return
    const running = runningAssignment(ticket), latest = latestAssignment(ticket)
    if (running) this.options.executor.deliver(ticket, running)
    else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.options.executor.start(ticket, latest)
  }
  /**
   * Resume an ended ticket under its unchanged Mandate when a person's message on one of its Threads waits for it: no Eval
   * and no Decision, since nothing new is authorized. One whose Mandate the current Policy no longer holds stays ended and
   * takes nothing (see `refuse`). While processing is paused the message waits, and the first pass after the pause resumes
   * the ticket under the Policy then. Reads the ticket afresh, so it is idempotent and leaves an already-resumed ticket alone.
   * A lightweight ticket runs inline again, with the person's message waiting for its next run.
   */
  wake(ticketId: string): void {
    const ticket = this.repo.tickets.get(ticketId)
    if (!ticket || isChildTicket(ticket) || liveTicket(ticket) || ticket.ended?.by === 'human' || !ticket.undelivered.length) return
    const policy = this.policy()
    if (policy.paused) return
    const at = this.now()
    if (!ticket.mandate || !policy.revalidate(ticket.mandate, at).ok) { this.refuse(ticket); return }
    // Only a human's message resumes an ended ticket; bot/CI triggers wait alongside inputs from before the ticket ended.
    const first = ticket.undelivered.map(id => ticket.inputs.find(input => input.id === id)).find(input => input?.kind === 'trigger' && input.human)
    if (first?.kind !== 'trigger') return
    const lightweight = ticketForm(ticket) === 'lightweight'
    if (lightweight && !this.options.inline) { this.refuse(ticket); return }
    delete ticket.ended; ticket.updatedAt = at
    const assignment = lightweight ? undefined : this.newAssignment(ticket)
    // Prepend the resumed marker so it is delivered ahead of the waiting messages.
    const resumed: TicketInput = { id: key('input', ticket.id, 'resumed', first.triggerId), kind: 'resumed', triggerId: first.triggerId, at }
    ticket.inputs.push(resumed); ticket.undelivered.unshift(resumed.id)
    this.repo.tickets.save(ticket)
    if (lightweight) this.startInline(ticket, { ref: `inline:${resumed.id}`, data: { resumed: true } })
    else this.options.executor.start(ticket, assignment!)
    this.emit('ticket.resumed', { ticketId, triggerId: first.triggerId })
  }
  /** The Triggers of a ticket's trigger Inputs, or of those of them whose Input ids are `ids`. */
  private triggersOf(ticket: Ticket, ids?: readonly string[]): Trigger[] {
    return ticket.inputs.flatMap(input => input.kind === 'trigger' && (!ids || ids.includes(input.id))
      ? this.repo.triggers.get(input.triggerId) ?? [] : [])
  }
  /**
   * Whether a ticket's worker took a person's message up, by acknowledging or answering it. A message acknowledged before
   * acknowledgements were recorded on it has only the acknowledgement's message in the outbox.
   */
  private takenUp(ticket: Ticket, trigger: Trigger): boolean {
    const acked = this.repo.triggers.disposition(trigger.id)?.acked
    if (acked) return acked.includes(ticket.id)
    // A receipt queued before T2-05 kept the trigger's id; neither key alone covers every stored acknowledgement.
    return !!trigger.channel && (this.options.outbox.status(acknowledgementAction(trigger.channel, trigger.id).idempotencyKey) !== undefined
      || this.options.outbox.status(key('ack', trigger.id)) !== undefined)
  }
  /** The person's messages among a ticket's Inputs `ids` that it decides and its worker did not take up. */
  private untaken(ticket: Ticket, ids: readonly string[]): Trigger[] {
    return this.triggersOf(ticket, ids).filter(trigger => this.owners(trigger).includes(ticket.id) && !this.takenUp(ticket, trigger))
  }
  /**
   * A ticket that ended, or cannot resume, lets go of the messages its worker never received, `waiting`, and of the person's
   * messages it decided but may not have taken up, `left`: it no longer counts as having reached them, and each of `left`
   * that no other ticket decides goes to Eval, as a person's message that reached no ticket does, unless a ticket took it
   * up, a Decision settled it, or it is the message a stop ended this ticket on.
   */
  private letGo(ticketId: string, waiting: readonly Trigger[], left: readonly Trigger[]): void {
    for (const trigger of [...waiting, ...left]) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      if (disposition?.fanout.includes(ticketId)) {
        this.repo.triggers.saveDisposition(trigger.id, { ...disposition, fanout: disposition.fanout.filter(id => id !== ticketId) })
      }
    }
    for (const trigger of left) {
      const disposition = this.repo.triggers.disposition(trigger.id)
      const decision = disposition?.decisionId ? this.repo.decisions.get(disposition.decisionId) : undefined
      // The main Session that stopped this ticket on the message decides the rest of it itself, unless a ticket handed it back.
      const stopped = decision?.kind === 'stop' && decision.ticketId === ticketId && !disposition?.handbacks?.length
      const decided = !!decision && (settled(decision) || stopped)
      if (!this.owners(trigger).length && !disposition?.acked?.length && !decided) this.queueForEval(trigger)
    }
  }
  /** An ended ticket that cannot resume takes none of the messages that waited for it (see `letGo`). */
  private refuse(ticket: Ticket): void {
    const waiting = this.triggersOf(ticket, ticket.undelivered), left = this.untaken(ticket, ticket.undelivered)
    ticket.undelivered = []
    this.repo.tickets.save(ticket)
    this.letGo(ticket.id, waiting, left)
  }
  /** Replace a ticket's running Assignment with a new one that receives `note` first, and queue it for launch. */
  restart(ticket: Ticket, running: Assignment, reason: string, note: string): void {
    this.endAssignment(ticket, running, reason)
    this.requeueUntaken(ticket, running)
    const assignment = this.newAssignment(ticket)
    const at = this.now()
    const input: TicketInput = { id: key('input', ticket.id, 'restart', assignment.id), kind: 'text', text: note, at }
    ticket.inputs.push(input); ticket.undelivered.push(input.id); ticket.updatedAt = at
    this.repo.tickets.save(ticket)
    this.options.executor.start(ticket, assignment)
  }
  /**
   * Put back, ahead of what waits, the Trigger Inputs delivered to `replaced` that no step of its worker took: a cancel may
   * have dropped them, or a step that claimed them was cut off, and the new Assignment's launch takes a copy still waiting
   * in the Session out, so its delivery is the only one. An earlier end let go of what earlier Assignments left.
   */
  private requeueUntaken(ticket: Ticket, replaced: Assignment): void {
    const untaken = ticket.inputs.filter(input => input.kind === 'trigger' && input.readAt === null && input.deliveredTo === replaced.id
      && !ticket.undelivered.includes(input.id))
    ticket.undelivered.unshift(...untaken.map(input => input.id))
  }
  /**
   * End a ticket with its outcome. `at` records when the ending fact happened, such as a PR merge, and `reason` says
   * why in words, by default the outcome. The ticket lets go (see `letGo`) of the messages its worker never received, and of
   * the person's messages it decides that its worker did not read before its latest report or turn end, the report that
   * ends the ticket included (see `readBefore`), and neither acknowledged, answered nor handed back: one may have come while
   * the worker wrote the report that ends the ticket, or after its turn ended, and either way it can no longer hand it back.
   */
  end(ticketId: string, by: TicketEndBy, outcome: TicketOutcome, at = this.now(), reason?: string): void {
    const ticket = this.require(ticketId)
    this.assertRoot(ticket)
    if (!liveTicket(ticket)) return
    // Completed/merged/closed work waits for every child ticket's parent judgement; a dropped or stopped ticket cancels its subtree.
    const unresolved = this.unresolvedChildren(ticket.id)
    if (unresolved.length && (outcome === 'completed' || outcome === 'merged' || outcome === 'closed')) {
      throw new UserError('unfinishedChildTickets', { count: String(unresolved.length), tickets: unresolved.map(item => item.id).join(', ') })
    }
    // A delivery with person confirmations cannot end as accepted work until a person approved its current revision.
    const aggregate = this.aggregateOf(ticket)
    if (aggregate?.confirmations.length && (outcome === 'completed' || outcome === 'merged' || outcome === 'closed')
      && acceptedReviewRevision(ticket) !== aggregate.reviewRevision) {
      throw new UserError('reviewNotApproved', { revision: aggregate.reviewRevision })
    }
    if (outcome === 'dropped' || by === 'human') this.cancelSubtree(ticket, by, reason ?? outcome)
    // A close that waited for child tickets is applied now that the parent owner disposed of them.
    if (ticket.endPending && (outcome === 'completed' || outcome === 'merged' || outcome === 'closed')) {
      outcome = ticket.endPending.outcome
      reason ??= ticket.endPending.reason
      at = ticket.endPending.at
    }
    delete ticket.endPending
    const stopping = ticket.assignments.filter(assignment => assignment.state !== 'ended')
    const why = reason && reason !== outcome ? { reason } : {}
    const until = readUntil(ticket)
    const waiting = this.triggersOf(ticket, ticket.undelivered)
    const left = this.untaken(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger'
      && (!readBefore(input, until) || ticket.undelivered.includes(input.id)) ? [input.id] : []))
    // An end dated earlier, such as a PR's merge, does not move the ticket's last change back.
    ticket.ended = { at, by, outcome, ...why }; ticket.undelivered = []; ticket.updatedAt = this.now()
    delete ticket.attention; delete ticket.delivery
    // The Assignments the end stops end with it; the ticket's end says why.
    for (const assignment of stopping) { assignment.state = 'ended'; assignment.endedAt = at }
    this.repo.tickets.save(ticket)
    this.letGo(ticketId, waiting, left)
    this.emit('ticket.ended', { ticketId, by, outcome, ...why })
    // Stop the Assignments first, then release ticket-scoped resources even when every Assignment had already ended.
    for (const assignment of stopping) this.options.executor.stop(ticket, assignment, reason ?? outcome)
    this.options.executor.release?.(ticket)
    // A lightweight ticket's run has no Assignment; only a person's stop cancels it, since a normal finish already ended it.
    if (ticketForm(ticket) === 'lightweight') {
      if (by === 'human') this.options.inline?.stop(ticket, reason ?? outcome)
      this.inlineRuns.delete(ticketId)
    }
  }
  /**
   * Whether a ticket's work has not finished at a close at `at`: its worker took up a person's message the ticket decides and
   * has not reported other than progress, or ended a turn, since its Session took that message into a step, or work resumed
   * after the close, whose Assignment started after it, has no ready report or Input arrived after that report; a Policy
   * change asks for no work.
   */
  private unfinished(ticket: Ticket, at: string): boolean {
    const until = readUntil(ticket, false)
    const taken = this.triggersOf(ticket, ticket.inputs.flatMap(input => input.kind === 'trigger' && !readBefore(input, until) ? [input.id] : []))
      .some(trigger => this.owners(trigger).includes(ticket.id) && this.takenUp(ticket, trigger))
    const latest = latestAssignment(ticket)
    if (taken || !(Date.parse(latest?.createdAt ?? '') > Date.parse(at))) return taken
    const report = latest?.report
    const later = ticket.inputs.some(input => input.kind !== 'policy-changed' && input.kind !== 'binding'
      && Date.parse(input.at) > Date.parse(report?.at ?? ''))
    return report?.state !== 'ready' || ticket.undelivered.length > 0 || later
  }
  /** Add a pending Assignment; a failed delivery to the one before it no longer concerns the ticket. */
  private newAssignment(ticket: Ticket, attempt?: number): Assignment {
    const assignment: Assignment = { id: key('assignment', ticket.id, String(ticket.assignments.length)), state: 'pending', createdAt: this.now(),
      ...(attempt !== undefined ? { attempt } : {}) }
    ticket.assignments.push(assignment)
    delete ticket.delivery
    return assignment
  }
  private endAssignment(ticket: Ticket, assignment: Assignment, reason: string): void {
    assignment.state = 'ended'; assignment.endedAt = this.now(); assignment.endedReason = reason
    this.emit('assignment.ended', { ticketId: ticket.id, assignmentId: assignment.id, reason })
  }
  /**
   * Give an open ticket's Executor a fact as a note Input, such as what another ticket found; it grants nothing (see `TicketInput`).
   * @throws UserError when the ticket is unknown or has ended.
   */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.require(ticketId)
    this.assertRoot(ticket)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const at = this.now()
    this.addInput(ticket, { id: key('input', ticketId, 'note', at, text), kind: 'note', text, at })
    return this.require(ticketId)
  }
  /**
   * Subscribe an open ticket to a Thread its Executor found related, for context: see `Thread.context`.
   * @returns false when the ticket follows the Thread already.
   * @throws UserError when the ticket is unknown or has ended.
   */
  followForContext(ticketId: string, ref: ThreadRef): boolean {
    const ticket = this.require(ticketId)
    this.assertRoot(ticket)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    if (this.thread(ref).subscriptions.includes(ticketId)) return false
    this.subscribe(ticketId, ref)
    const thread = this.thread(ref)
    thread.context = [...thread.context ?? [], ticketId]
    this.repo.threads.save(thread)
    return true
  }
  /** Subscribe a ticket to a Thread; later Triggers on it reach the ticket as Inputs, as the ticket's own once it was for context. */
  private subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.thread(ref)
    if (!thread.subscriptions.includes(ticketId)) { thread.subscriptions.push(ticketId); this.emit('thread.subscribed', { threadKey: thread.key, ticketId }) }
    if (thread.context?.includes(ticketId)) thread.context = thread.context.filter(id => id !== ticketId)
    this.repo.threads.save(thread)
  }
}
