/** What the Executor and its workers report about the Assignments that run tickets. */
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import type { DeliverableInput, Review } from './deliverable.ts'
import { enterReview } from './deliverable.ts'
import { isChildTicket, latestAssignment, liveTicket, runningAssignment } from './model.ts'
import type { ActorRef, ReportState, Ticket } from './model.ts'
import { EnginePart, type EngineOptions } from './part.ts'
import type { Replies } from './replies.ts'
import { reviewAggregate } from './review.ts'
import { ticketStage } from './stage.ts'
import { automatic, type Tickets } from './tickets.ts'

/** What an Assignment reports: a worker's report, or the Executor's own (`waiting` after an idle turn, `failed` after an error). */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** Open question for a person: a string asks it, `null` clears an open one, and `undefined` keeps the current one. */
  question?: string | null
  /** The person's message whose request raised the question; routes the question to the channel where it was written. */
  askedBy?: string
  /** The person's question this report answers, which the worker thereby takes up; authorizes the main Session to send an answer reply. */
  answers?: string
  /** The reviewable deliverable a ready result produced, normalized by `enterReview`; without one a person cannot review it. */
  deliverable?: DeliverableInput
  /** The Assignment the reporting worker runs, when the caller records it: a late report from a replaced attempt is refused. */
  assignmentId?: string
}
const RECOVERY_NOTE = 'The host restarted during this ticket. Inspect the current worktree, git history and GitHub state before continuing. Do not repeat an already completed external operation. Finish the original assignment and report its status.'

/**
 * Assignments records what the Executor and its workers report about the Assignments that run tickets: one started, Inputs
 * reached it or failed to, its worker's Session took Inputs into a step, a turn of its worker ended, a host restart
 * interrupted it, and a worker's report with its question for a person. It depends on
 * Tickets to restart or end a ticket and on Replies to withdraw a question a report replaced; the Engine routes the
 * Executor's lifecycle callbacks and its workers' reports here.
 */
export class Assignments extends EnginePart {
  constructor(options: EngineOptions, private readonly tickets: Tickets, private readonly replies: Replies) { super(options) }

  /** Marks a non-ended assignment running, queues delivery of waiting undelivered inputs on an open ticket, and emits `assignment.started`. */
  started(ticketId: string, assignmentId: string): void {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find(item => item.id === assignmentId)
    if (!assignment || assignment.state === 'ended') return
    assignment.state = 'running'; assignment.startedAt ??= this.now()
    ticket.updatedAt = this.now()
    this.repo.tickets.save(ticket)
    this.stageOf(ticket, 'dispatch', { ref: assignmentId, data: { assignmentId } })
    if (liveTicket(ticket) && ticket.undelivered.length) this.options.executor.deliver(ticket, assignment)
    this.emit('assignment.started', { ticketId, assignmentId })
  }
  /**
   * Marks `inputIds` delivered on the ticket's running assignment and clears any prior `delivery` failure; ignored if no
   * longer running. Its worker reads each once its Session takes it into a step (see `read`).
   */
  delivered(ticketId: string, assignmentId: string, inputIds: string[]): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.undelivered = ticket.undelivered.filter(id => !inputIds.includes(id)); ticket.updatedAt = this.now()
    runningAssignment(ticket)!.deliveredAt = ticket.updatedAt
    for (const input of ticket.inputs) {
      if (input.kind === 'trigger' && inputIds.includes(input.id)) { input.readAt ??= null; input.deliveredTo = assignmentId }
    }
    delete ticket.delivery
    this.repo.tickets.save(ticket)
  }
  /** Records when the worker's Session of an open ticket took `inputIds` into a step, from which its model reads them. */
  read(ticketId: string, inputIds: string[]): void {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) return
    for (const input of ticket.inputs) if (input.kind === 'trigger' && inputIds.includes(input.id)) input.readAt ||= this.now()
    this.repo.tickets.save(ticket)
  }
  turnEnded(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    runningAssignment(ticket)!.idleAt = this.now()
    this.repo.tickets.save(ticket)
  }
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    const ticket = this.running(ticketId, assignmentId)
    if (!ticket) return
    ticket.delivery = { error: error.slice(0, 300), at: this.now() }
    this.repo.tickets.save(ticket)
  }
  /**
   * Handles a running assignment interrupted by a host restart: restarts it with a recovery note unless its latest report is
   * `waiting`, `ready`, `blocked`, or `failed` and no input was delivered after that report, in which case it keeps its
   * session and flushes any waiting undelivered inputs.
   */
  interrupted(ticketId: string, assignmentId: string): void {
    const ticket = this.running(ticketId, assignmentId)
    const running = ticket && runningAssignment(ticket)
    if (!ticket || !running) return
    const report = running.report
    const busy = !!running.deliveredAt && !!report && running.deliveredAt >= report.at
    const settled = !!report && ['waiting', 'ready', 'blocked', 'failed'].includes(report.state) && !busy
    if (!settled) this.tickets.restart(ticket, running, 'hostRestarted', RECOVERY_NOTE)
    else if (ticket.undelivered.length) this.options.executor.deliver(ticket, running)
  }
  /**
   * Records a worker status report on an open ticket's current assignment, updating `attention`, `answers`, held automated
   * inputs, and ending the ticket when `dropped` or when `ready` and not waiting on followed threads (`followsDone`).
   * @throws UserError for an unknown or ended ticket, an ended assignment, a question combined with a ready result or answer,
   * or a question/answer referencing a non-human or unreached trigger.
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const child = isChildTicket(ticket)
    if (child) {
      // A child owner has no person path: its attention goes to the parent owner, who decides whether a person must act.
      if (report.askedBy || report.answers) throw new UserError('notAuthorizationRoot')
      if (report.state === 'ready') {
        const unresolved = this.tickets.unresolvedChildren(ticketId)
        if (unresolved.length) throw new UserError('unfinishedChildTickets', { count: String(unresolved.length),
          tickets: unresolved.map(item => item.id).join(', ') })
      }
      const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
      if (!assignment) throw new UserError('unknownAssignment')
      if (report.assignmentId && report.assignmentId !== assignment.id) {
        throw new UserError('staleChildAttempt', { attempt: String(Math.max(1, (ticket.delegation?.attempt ?? 1) - 1)),
          current: String(ticket.delegation?.attempt ?? 1) })
      }
      if (assignment.state === 'ended') throw new UserError('assignmentEnded')
      const review: Review | undefined = report.deliverable === undefined ? undefined : enterReview(report.deliverable)
      const at = this.now()
      assignment.report = { state: report.state, summary: report.summary, at, ...(review ? { review } : {}) }
      this.stageOf(ticket, 'report', { ref: `${at}:${report.state}`, data: { state: report.state, childTicketId: ticketId } })
      if (report.state === 'ready') this.stageOf(ticket, 'delegation.report-up', { ref: `${at}:ready`,
        data: { childTicketId: ticketId, parentTicketId: ticket.parentTicketId } })
      ticket.updatedAt = at
      if (report.state === 'blocked' || report.state === 'failed') {
        ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
      }
      this.repo.tickets.save(ticket)
      // Only reports that need the parent's judgement reach it; progress and waiting stay inside the child's own turn.
      if (report.state === 'ready' || report.state === 'dropped' || report.state === 'blocked' || report.state === 'failed') {
        this.tickets.childReport(ticketId, assignment.attempt ?? 1, assignment.id,
          { state: report.state, summary: report.summary, ...(review ? { review } : {}), ...(report.question ? { humanAction: report.question } : {}) }, at)
      }
      return this.require(ticketId)
    }
    if (report.state === 'ready' && this.tickets.unresolvedChildren(ticketId).length) {
      const unresolved = this.tickets.unresolvedChildren(ticketId)
      throw new UserError('unfinishedChildTickets', { count: String(unresolved.length), tickets: unresolved.map(item => item.id).join(', ') })
    }
    if (report.question && (report.state === 'ready' || report.answers)) throw new UserError('questionWithResult')
    if (report.askedBy && !report.question) throw new UserError('askerWithoutQuestion')
    const person = (id: string, channel: boolean) => {
      const trigger = this.repo.triggers.get(id)
      return !!trigger?.human && (!channel || !!trigger.channel) && this.reaches(ticket, trigger, false)
    }
    if (report.askedBy && !person(report.askedBy, true)) throw new UserError('notAsker')
    if (report.answers && !person(report.answers, false)) throw new UserError('notAnswerable')
    const assignment = runningAssignment(ticket) ?? latestAssignment(ticket)
    if (!assignment) throw new UserError('unknownAssignment')
    // A report that names a replaced Assignment is late: returnChild has already started the child's next attempt.
    if (report.assignmentId && report.assignmentId !== assignment.id) throw new UserError('assignmentEnded')
    if (assignment.state === 'ended') throw new UserError('assignmentEnded')
    // Normalize here so a malformed deliverable never reaches the Store, and keep it with the report revision it describes.
    const review: Review | undefined = report.deliverable === undefined ? undefined : enterReview(report.deliverable)
    const at = this.now()
    const previous = ticket.attention
    const ask = (question: string) => ({ id: key('attention', ticketId, question, at), question, ...(report.askedBy ? { triggerId: report.askedBy } : {}) })
    const asked = report.question && report.question !== previous?.question ? ask(report.question) : previous
    const attention = report.question === null || report.state === 'ready' ? undefined : asked
    if (attention) ticket.attention = attention
    else delete ticket.attention
    // A replaced or cleared attention question withdraws any pending unsent reply for the previous question from the outbox.
    if (previous && previous.id !== attention?.id) this.replies.withdrawAttention(ticket, previous)
    assignment.report = { state: report.state, summary: report.summary, at, ...(review ? { review } : {}) }
    this.stageOf(ticket, 'report', { ref: `${at}:${report.state}`, data: { state: report.state } })
    ticket.updatedAt = at
    if (report.answers && !ticket.answers?.includes(report.answers)) ticket.answers = [...ticket.answers ?? [], report.answers]
    if (report.answers) this.takeUp(ticketId, report.answers)
    if (report.state === 'blocked' || report.state === 'failed') ticket.undelivered = ticket.undelivered.filter(id => !automatic(ticket.inputs.find(input => input.id === id)))
    this.repo.tickets.save(ticket)
    // A ticket that follows Threads ends with them: a ready report ends it only once followsDone holds, with that outcome.
    const ready = !ticket.follows?.length ? 'completed' : this.tickets.followsDone(ticket)?.outcome
    // A dropped report after a close the ticket deferred ends it as the close did, which its final notice tells.
    const outcome = report.state === 'dropped' ? this.tickets.followsDone(ticket)?.outcome ?? 'dropped' : report.state === 'ready' ? ready : undefined
    // A parent that delegated reports its own completed goal upward; a ticket with no children has nothing extra to report.
    const children = this.repo.tickets.childrenOf(ticket.id)
    if (report.state === 'ready' && children.length) this.stageOf(ticket, 'delegation.report-up', { ref: `${at}:ready`, at, data: { childCount: children.length } })
    // Accepted work with person confirmations waits for the final approval; a dropped or stopped ticket does not.
    const approved = outcome === 'dropped' || !outcome || !(outcome === 'completed' || outcome === 'merged' || outcome === 'closed')
      || !this.tickets.requiresReviewApproval(ticket) || this.tickets.reviewApproved(ticket)
    if (outcome && approved) this.tickets.end(ticketId, 'executor', outcome, at)
    return this.require(ticketId)
  }
  /**
   * Records a person's approval of the current review aggregate. It does not itself end open work: a pending close is
   * applied, a closed follow ends with that outcome, no follows ends completed, and open follows wait. A later report or
   * accepted child delivery changes `reviewRevision`, so an older approval no longer matches.
   * @throws UserError when the ticket is unknown or ended, is a child, is not awaiting review, has no reviewable aggregate,
   * or `reviewRevision` is not the current one.
   */
  review(ticketId: string, by: ActorRef, reviewRevision: string): Ticket {
    const ticket = this.require(ticketId)
    if (isChildTicket(ticket)) throw new UserError('childRequiresParent')
    if (!liveTicket(ticket)) throw new UserError('ticketEnded')
    const unresolved = this.tickets.unresolvedChildren(ticketId)
    if (unresolved.length) throw new UserError('unfinishedChildTickets', { count: String(unresolved.length), tickets: unresolved.map(item => item.id).join(', ') })
    const stage = ticketStage(ticket)
    if (stage.stage !== 'person' || stage.action !== 'review') throw new UserError('reviewNotReady')
    const aggregate = reviewAggregate(ticket, id => this.repo.tickets.get(id), id => this.repo.tickets.childrenOf(id))
    if (!aggregate?.deliverables.length) throw new UserError('deliverablePreviewMissing')
    if (reviewRevision !== aggregate.reviewRevision) throw new UserError('reviewStale', { revision: aggregate.reviewRevision })
    const report = latestAssignment(ticket)?.report
    if (!report) throw new UserError('reviewNotReady')
    if (report.accepted?.reviewRevision !== reviewRevision) {
      const at = this.now()
      report.accepted = { by, at, reviewRevision }
      ticket.updatedAt = at
      this.repo.tickets.save(ticket)
    }
    this.tickets.endAfterApproval(ticketId, report.accepted.at)
    return this.require(ticketId)
  }
  /** The ticket, while it is open and `assignmentId` runs it. */
  private running(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.require(ticketId)
    return liveTicket(ticket) && runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }
}
