/** The approvals queue: requested Actions still waiting for a person, with the object and consequence each one approves. */
import { ACTION_LEVELS, withinActionLevel, type ActionCost, type ActionLevel, type Approval } from '@superagent/kernel'
import type { Store } from '../store.ts'

/** One pending Approval as the panel reads it: the Ticket it belongs to, the Action it approves and the levels a person may grant. */
export interface ApprovalRow {
  id: string
  ticket: { id: string; title: string }
  action: { kind: string; source: string; objectId: string; revision: string; level: ActionLevel; cost?: ActionCost }
  requestedAt: string
  expiresAt: string
  /** The levels a person may grant, from `read` up to the requested one. */
  levels: ActionLevel[]
}

/** The Action of one Approval, without its derived idempotency key, which the view never needs. */
const actionOf = (approval: Approval): ApprovalRow['action'] => {
  const action = approval.action
  return { kind: action.kind, source: action.source, objectId: action.objectId, revision: action.revision, level: action.level,
    ...(action.level === 'spend' ? { cost: action.cost } : {}) }
}

/**
 * The Approvals still decidable at `now`, oldest request first. A request past its expiry is left out: its record is not
 * a decision yet, and it is not actionable. The list is bounded by the number of pending approvals, which stays small.
 */
export function approvalQueue(store: Pick<Store, 'approvals' | 'tickets'>, now = Date.now()): ApprovalRow[] {
  return store.approvals.pending(now).map(approval => {
    const ticket = store.tickets.get(approval.ticketId)
    return {
      id: approval.id,
      ticket: { id: approval.ticketId, title: ticket?.title ?? approval.ticketId },
      action: actionOf(approval),
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
      levels: ACTION_LEVELS.filter(level => withinActionLevel(level, approval.action.level)),
    }
  }).sort((left, right) => left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id))
}

export type ApprovalQueueView = ReturnType<typeof approvalQueue>