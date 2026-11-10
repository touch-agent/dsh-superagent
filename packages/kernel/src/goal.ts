/**
 * The Goal of a Ticket: a read-only projection that answers, in E0 words, what the work is for, where it stands, whether a
 * person must decide something, and where its result is. It is derived from facts the Ticket already stores and grants
 * nothing: no Goal is persisted, no Goal can authorize an action, and removing the projection leaves every Ticket intact.
 */
import type { Artifact, PreviewRef } from './deliverable.ts'
import { deliverableKey } from './review.ts'
import { latestReport, type Ticket, type TicketOutcome } from './model.ts'
import { ticketStage } from './stage.ts'

/** One delivered revision, named by the artifact and the preview a person reviews it by. */
export interface GoalResult {
  /** `<artifact.kind>:<artifact.ref>:<artifact.revision>`, stable for one delivered revision. */
  key: string
  /** When the report that delivered this revision was written. */
  at: string
  artifact: Artifact
  previewRef: PreviewRef
}

/** The state words E0 uses for a Ticket; the same facts `ticketStage` classifies. */
export interface GoalState {
  /** `person` means a person must act; `ended` is terminal. */
  stage: 'queued' | 'working' | 'idle' | 'person' | 'ended'
  /** The person's action while `stage` is `person`; absent otherwise. */
  action?: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed'
  /** How the Ticket ended, while `stage` is `ended`. */
  outcome?: TicketOutcome
  endedAt?: string
}

/** What a person must decide before the work can move on. It asks for a decision; it is not an authorization. */
export interface GoalDecision {
  /** Answering the worker's question, reviewing the delivery, fixing a delivery failure, or recovering blocked/failed work. */
  kind: 'answer' | 'review' | 'delivery' | 'blocked' | 'failed'
  /** The worker's question, when it asked one; a review or delivery decision carries no question of its own. */
  question?: string
}

/** How many conditions the delivered revision carries, and whether a person accepted it; no reviewer identity or Assignment id. */
export interface GoalAcceptance {
  /** Machine-checkable conditions; they do not wait for a person. */
  criteria: number
  /** Conditions a person must confirm. */
  confirmations: number
  /** When a person accepted this delivered revision; absent while the acceptance is still pending. */
  acceptedAt?: string
}

/**
 * One Ticket's E0 goal. `statement` is the accepted scope (a child's delegated goal) and falls back to the Ticket title;
 * `source` is the Source kind recorded by the Ticket's Channel and is absent on a child Ticket, which has none of its own.
 * The projection deliberately carries no Assignment, worker or Session id, no Mandate basis or action level, and no
 * Approval: reading a Goal never grants an action.
 */
export interface Goal {
  id: string
  statement: string
  /** The Source kind the Ticket was accepted from; a child Ticket records no Channel and inherits its root's source. */
  source?: string
  state: GoalState
  /** Present only while a person must act. */
  decision?: GoalDecision
  /** Deliveries recorded by the latest report that carried a review; empty when nothing reviewable was delivered. */
  results: GoalResult[]
  /** The acceptance summary of the latest delivered revision; absent when nothing was delivered. */
  acceptance?: GoalAcceptance
}

/** The state fields of a Ticket, mapped from the stage rules in docs/003. */
function stateOf(ticket: Ticket): GoalState {
  const stage = ticketStage(ticket)
  if (stage.stage === 'ended') {
    return { stage: 'ended', ...ticket.ended?.outcome ? { outcome: ticket.ended.outcome } : {},
      ...ticket.ended?.at ? { endedAt: ticket.ended.at } : {} }
  }
  if (stage.stage === 'person') return { stage: 'person', action: stage.action }
  if (stage.stage === 'working') return { stage: stage.action === 'queued' ? 'queued' : 'working' }
  return { stage: 'idle' }
}

/** The one decision a person owes, if any: the worker's question wins, then the person stage the stage rules name. */
function decisionOf(ticket: Ticket): GoalDecision | undefined {
  if (ticket.attention) return { kind: 'answer', question: ticket.attention.question }
  const stage = ticketStage(ticket)
  if (stage.stage !== 'person') return undefined
  return { kind: stage.action }
}

/** The statement a child carries, its delegated goal, or the accepted scope of a root; the title is the honest fallback. */
function statementOf(ticket: Ticket): string {
  return ticket.delegation?.goal.trim() || ticket.mandate?.scope.trim() || ticket.title
}

/** Project one Ticket's Goal. Pure: it reads the Ticket and writes nothing, so removing it cannot change the Ticket. */
export function goalOf(ticket: Ticket): Goal {
  const delivered = ticket.assignments.findLast(assignment => assignment.report?.review)?.report
  const review = delivered?.review
  const decision = decisionOf(ticket)
  const source = ticket.channels[0]?.source
  return {
    id: ticket.id,
    statement: statementOf(ticket),
    ...source ? { source } : {},
    state: stateOf(ticket),
    ...decision ? { decision } : {},
    results: delivered && review ? [{ key: deliverableKey(review.deliverable.artifact), at: delivered.at, artifact: review.deliverable.artifact,
      previewRef: review.deliverable.previewRef }] : [],
    ...delivered && review ? { acceptance: { criteria: review.criteria.length, confirmations: review.confirmations.length,
      ...delivered.accepted?.at ? { acceptedAt: delivered.accepted.at } : {} } } : {},
  }
}