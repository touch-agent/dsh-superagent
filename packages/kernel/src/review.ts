/**
 * The root Ticket's review surface: the deliveries of the root and of every child Ticket its parent accepted, deduplicated
 * by artifact revision, with one fingerprint that a person approves. It is a read-only projection over reports that
 * already exist; it stores nothing and grants nothing.
 */
import { key } from './ids.ts'
import type { Artifact, HumanCriterion, PreviewRef, Review, RuleCriterion } from './deliverable.ts'
import { currentChildReport, latestAssignment, type ActorRef, type Assignment, type Ticket } from './model.ts'

/** Where one reviewed delivery came from: one Assignment of one Ticket in the root's tree. */
export interface ReviewSource { kind: 'ticket'; ticketId: string; assignmentId: string }

/** One person-confirmation of one source, with a stable ref a review can bind its approval to. */
export interface ReviewConfirmationView {
  /** `ticket:<ticketId>:<assignmentId>:<index>`, stable while that report is current. */
  ref: string
  source: ReviewSource
  criterion: HumanCriterion
}

/** One delivered artifact revision, after the root and accepted children producing the same revision were merged. */
export interface DeliverableSummary {
  /** `<artifact.kind>:<artifact.ref>:<artifact.revision>`, the key the aggregate deduplicates by. */
  key: string
  /** Every Ticket/Assignment that delivered this revision; at least one. */
  sources: ReviewSource[]
  /** The latest report time among the sources. */
  at: string
  artifact: Artifact
  previewRef: PreviewRef
  criteria: RuleCriterion[]
  confirmations: HumanCriterion[]
  /** The child deliverable was accepted by its parent owner; that is not a person's confirmation. */
  parentAccepted?: { by: ActorRef; at: string }
}

/** The review a person approves for one root Ticket. */
export interface ReviewAggregate {
  /** The Ticket the aggregate was built for; the root Ticket for a final approval. */
  ticketId: string
  /** SHA-256 over the sorted sources, their report times, artifacts and criteria; any change returns another value. */
  reviewRevision: string
  deliverables: DeliverableSummary[]
  criteria: RuleCriterion[]
  confirmations: ReviewConfirmationView[]
}

interface ReviewEntry {
  ticket: Ticket
  assignment: Assignment
  report: NonNullable<Assignment['report']>
  review: Review
}

/** One report's review, when its latest Assignment carried one. */
function entryOf(ticket: Ticket): ReviewEntry | undefined {
  const assignment = latestAssignment(ticket)
  const report = assignment?.report
  return assignment && report?.review?.deliverable?.previewRef ? { ticket, assignment, report, review: report.review } : undefined
}

/** Whether the parent owner accepted the child's current report, and that acceptance still describes it. */
function acceptedByParent(child: Ticket, parentId: string): boolean {
  const delegation = child.delegation
  const resolution = delegation?.resolution
  if (!delegation || delegation.parentTicketId !== parentId || resolution?.kind !== 'accepted') return false
  if (!child.ended || child.ended.outcome !== 'completed') return false
  const report = currentChildReport(child)
  return !!report && resolution.acceptedReportAt === report.at && resolution.acceptedAttempt === delegation.attempt && !!report.review
}

/**
 * The deliveries of `ticket` and of the children it accepted, recursively. A child enters only while its parent accepted
 * its current attempt; a returned, cancelled or failed child is excluded, and a deeper child must itself have been
 * accepted by its parent.
 */
function collect(ticket: Ticket, get: (id: string) => Ticket | undefined, children: (id: string) => Ticket[],
  seen = new Set<string>()): ReviewEntry[] {
  if (seen.has(ticket.id)) return []
  seen.add(ticket.id)
  const own = entryOf(ticket)
  const entries: ReviewEntry[] = own ? [own] : []
  for (const child of children(ticket.id)) {
    if (!acceptedByParent(child, ticket.id)) continue
    entries.push(...collect(child, get, children, seen))
  }
  return entries
}

/** The artifact key a review deduplicates by. */
export const deliverableKey = (artifact: Pick<Artifact, 'kind' | 'ref' | 'revision'>): string =>
  `${artifact.kind}:${artifact.ref}:${artifact.revision}`

const criterionKey = (criterion: RuleCriterion): string => JSON.stringify(criterion)

/** Merge the criteria of every source without letting the same machine rule appear twice. */
function mergeCriteria(entries: readonly ReviewEntry[]): RuleCriterion[] {
  const criteria = new Map<string, RuleCriterion>()
  for (const entry of entries) for (const criterion of entry.review.criteria) criteria.set(criterionKey(criterion), criterion)
  return [...criteria.values()]
}

/** The revision fingerprint: any source, attempt, report time, revision, criterion or confirmation changes it. */
function revisionOf(entries: readonly ReviewEntry[]): string {
  const rows = entries.map(entry => ({
    ticketId: entry.ticket.id,
    assignmentId: entry.assignment.id,
    attempt: entry.assignment.attempt ?? 1,
    reportAt: entry.report.at,
    artifact: deliverableKey(entry.review.deliverable.artifact),
    preview: `${entry.review.deliverable.previewRef.kind}:${entry.review.deliverable.previewRef.ref}:${entry.review.deliverable.previewRef.revision}`,
    criteria: entry.review.criteria,
    confirmations: entry.review.confirmations,
  })).sort((left, right) => `${left.ticketId}:${left.assignmentId}`.localeCompare(`${right.ticketId}:${right.assignmentId}`))
  return key('review', JSON.stringify(rows))
}

/**
 * Build the review aggregate for a Ticket from its latest report and the reports of the children it accepted. Returns
 * `undefined` when nothing was delivered: a Ticket without a reviewable result has no review to approve.
 */
export function reviewAggregate(ticket: Ticket, get: (id: string) => Ticket | undefined,
  children: (id: string) => Ticket[] = () => []): ReviewAggregate | undefined {
  const entries = collect(ticket, get, children)
  if (!entries.length) return undefined
  const deliverables = new Map<string, DeliverableSummary>()
  for (const entry of entries) {
    const review = entry.review
    const artifact = review.deliverable.artifact
    const id = deliverableKey(artifact)
    const source: ReviewSource = { kind: 'ticket', ticketId: entry.ticket.id, assignmentId: entry.assignment.id }
    const acceptance = entry.ticket === ticket ? undefined : entry.ticket.delegation?.resolution
    const parentAccepted = acceptance?.kind === 'accepted' ? { by: acceptance.by, at: acceptance.at } : undefined
    const existing = deliverables.get(id)
    if (!existing) {
      deliverables.set(id, { key: id, sources: [source], at: entry.report.at, artifact, previewRef: review.deliverable.previewRef,
        criteria: [...review.criteria], confirmations: [...review.confirmations], ...parentAccepted ? { parentAccepted } : {} })
      continue
    }
    if (!existing.sources.some(item => item.ticketId === source.ticketId && item.assignmentId === source.assignmentId))
      existing.sources.push(source)
    if (entry.report.at > existing.at) existing.at = entry.report.at
    for (const criterion of review.criteria)
      if (!existing.criteria.some(item => criterionKey(item) === criterionKey(criterion))) existing.criteria.push(criterion)
    for (const confirmation of review.confirmations)
      if (!existing.confirmations.some(item => JSON.stringify(item) === JSON.stringify(confirmation))) existing.confirmations.push(confirmation)
    if (parentAccepted) existing.parentAccepted ??= parentAccepted
  }
  const confirmations = entries.flatMap(entry => entry.review.confirmations.map((criterion, index) => ({
    ref: `ticket:${entry.ticket.id}:${entry.assignment.id}:${index}`,
    source: { kind: 'ticket' as const, ticketId: entry.ticket.id, assignmentId: entry.assignment.id },
    criterion,
  })))
  return { ticketId: ticket.id, reviewRevision: revisionOf(entries), deliverables: [...deliverables.values()],
    criteria: mergeCriteria(entries), confirmations }
}

/** Whether the Ticket's current aggregate contains confirmations that need a person's final approval. */
export function reviewNeedsApproval(ticket: Ticket, get: (id: string) => Ticket | undefined,
  children: (id: string) => Ticket[] = () => []): boolean {
  return (reviewAggregate(ticket, get, children)?.confirmations.length ?? 0) > 0
}

/** The review revision the latest report accepted, when it is a final root approval. */
export function acceptedReviewRevision(ticket: Ticket): string | undefined {
  return latestAssignment(ticket)?.report?.accepted?.reviewRevision
}

/** Whether the latest report accepted exactly the current aggregate revision. */
export function reviewApproved(ticket: Ticket, get: (id: string) => Ticket | undefined,
  children: (id: string) => Ticket[] = () => []): boolean {
  const aggregate = reviewAggregate(ticket, get, children)
  return !!aggregate && acceptedReviewRevision(ticket) === aggregate.reviewRevision
}