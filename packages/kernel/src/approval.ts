/** Approvals: a person's explicit consent to one Action, and the state machine that keeps the record auditable. */
import { actionKey, isActionLevel, type Action } from './action.ts'
import { UserError } from './errors.ts'
import { key } from './ids.ts'
import { isoTime, type ActorRef } from './model.ts'

/** The states an Approval may hold, in the order it can first reach them from `requested`. */
export const APPROVAL_STATES = ['requested', 'approved', 'denied', 'expired', 'revoked'] as const
/** Where an Approval is: waiting for a decision, or one of the four final states. */
export type ApprovalState = typeof APPROVAL_STATES[number]

/**
 * One Approval request: the Ticket it belongs to, the exact Action and revision it approves, the moment it stops being
 * decidable, and the person who decided it. The Action is kept as requested so the approved revision and level stay
 * auditable after it runs. A Ticket may hold many Approvals; each Action holds at most one.
 */
export interface Approval {
  id: string
  ticketId: string
  action: Action
  state: ApprovalState
  requestedAt: string
  /** The moment the request stops being decidable; a decision at or after it is refused. */
  expiresAt: string
  /** Who asked for the approval, when the caller recorded it; the Action already names the actor who would act. */
  requestedBy?: ActorRef
  /** When the Approval left `requested`; an expiry records `expiresAt`, when it stopped being decidable. */
  decidedAt?: string
  /** Who approved or denied it, or revoked it before a decision; an expiry has none. */
  decidedBy?: ActorRef
  /** Why it was denied or revoked, in the caller's words. */
  reason?: string
}

/** What a caller supplies to ask for an Approval; its id is derived from the Ticket and the Action's idempotency key. */
export interface ApprovalRequest {
  ticketId: string
  action: Action
  requestedAt: string
  expiresAt: string
  requestedBy?: ActorRef
}

/** A person's decision on an Approval: who decided, when, and optionally why. */
export interface ApprovalDecision {
  by: ActorRef
  at: string
  reason?: string
}

/** A withdrawal before a decision, by whoever no longer needs the action; `by` is optional for an automatic withdrawal. */
export interface ApprovalRevocation {
  at: string
  by?: ActorRef
  reason?: string
}

/** Whether a value names one of the five Approval states. */
export const isApprovalState = (value: unknown): value is ApprovalState =>
  typeof value === 'string' && (APPROVAL_STATES as readonly string[]).includes(value)

/** The id of an Approval for one Ticket and one Action; the same pair always names the same record. */
export const approvalId = (ticketId: string, actionIdempotencyKey: string): string =>
  key('approval', ticketId, actionIdempotencyKey)

/** Refuse a value that is not a non-empty string, naming the field. */
function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${what} must be a non-empty string`)
  return value
}

/** Refuse an actor missing either part of its Source identity. */
function requireActor(value: ActorRef, what: string): ActorRef {
  if (!value || typeof value !== 'object') throw new TypeError(`${what} must be an actor`)
  requireText(value.source, `${what} source`)
  requireText(value.id, `${what} id`)
  return value
}

/** Normalize a timestamp and refuse one that cannot be parsed. */
function requireTime(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`${what} must be a timestamp`)
  const at = isoTime(value)
  if (!Number.isFinite(Date.parse(at))) throw new TypeError(`${what} must be a timestamp`)
  return at
}

/** Whether the Approval is a stored Action whose key still describes it. */
function requireAction(value: Action): Action {
  if (!value || typeof value !== 'object') throw new TypeError('An Approval must name an Action')
  if (!isActionLevel(value.level)) throw new TypeError(`Unknown action level: ${String(value.level)}`)
  requireText(value.idempotencyKey, 'The Action idempotency key')
  if (value.idempotencyKey !== actionKey(value)) throw new TypeError('The Action does not match its idempotency key')
  return value
}

/**
 * Build a requested Approval for one Action. The id is derived from the Ticket and the Action's idempotency key, so
 * asking again for the same action names the same record instead of creating a second one. The request must expire
 * after it was made.
 */
export function createApproval(input: ApprovalRequest): Approval {
  const ticketId = requireText(input.ticketId, 'The Approval ticket')
  const action = requireAction(input.action)
  const requestedAt = requireTime(input.requestedAt, 'The Approval request time')
  const expiresAt = requireTime(input.expiresAt, 'The Approval expiry')
  if (Date.parse(expiresAt) <= Date.parse(requestedAt)) throw new TypeError('An Approval must expire after it was requested')
  const requestedBy = input.requestedBy === undefined ? undefined : requireActor(input.requestedBy, 'The Approval requester')
  return { id: approvalId(ticketId, action.idempotencyKey), ticketId, action, state: 'requested', requestedAt, expiresAt,
    ...(requestedBy ? { requestedBy } : {}) }
}

/** Whether a decision time is not before the request and the Approval has not expired at it. */
function requireDecidable(approval: Approval, atValue: string): string {
  const at = requireTime(atValue, 'The Approval decision time')
  if (Date.parse(at) < Date.parse(approval.requestedAt)) throw new TypeError('An Approval cannot be decided before it was requested')
  if (Date.parse(at) >= Date.parse(approval.expiresAt)) throw new UserError('approvalExpired', { at: approval.expiresAt })
  return at
}

/** Apply an approved or denied decision to one Approval. Repeating the same decision leaves the record untouched. */
function decide(approval: Approval, state: 'approved' | 'denied', decision: ApprovalDecision): Approval {
  if (approval.state === state) return approval
  if (approval.state !== 'requested') throw new UserError('approvalDecided', { state: approval.state })
  const at = requireDecidable(approval, decision.at)
  const by = requireActor(decision.by, 'The Approval approver')
  return { ...approval, state, decidedAt: at, decidedBy: by, ...(decision.reason ? { reason: decision.reason } : {}) }
}

/** Approve the Action. Approving an already approved Approval returns it unchanged; any other final state refuses the change. */
export const approve = (approval: Approval, decision: ApprovalDecision): Approval => decide(approval, 'approved', decision)

/** Deny the Action. Denying an already denied Approval returns it unchanged; any other final state refuses the change. */
export const deny = (approval: Approval, decision: ApprovalDecision): Approval => decide(approval, 'denied', decision)

/**
 * Withdraw a request before a decision, for example when the worker no longer needs the action. Revoking an already
 * revoked Approval returns it unchanged; a decided or expired one cannot be revoked.
 */
export function revoke(approval: Approval, revocation: ApprovalRevocation): Approval {
  if (approval.state === 'revoked') return approval
  if (approval.state !== 'requested') throw new UserError('approvalDecided', { state: approval.state })
  const at = requireDecidable(approval, revocation.at)
  const by = revocation.by === undefined ? undefined : requireActor(revocation.by, 'The Approval revoker')
  return { ...approval, state: 'revoked', decidedAt: at, ...(by ? { decidedBy: by } : {}), ...(revocation.reason ? { reason: revocation.reason } : {}) }
}

/**
 * Move a requested Approval to `expired` once `at` reaches its expiry, recording the expiry time as the decision time;
 * before then it stays requested. An already expired Approval is returned unchanged; any other final state refuses the
 * change. Expiry is not a jump: a later approval attempt is refused rather than moving the record to `approved`.
 */
export function expire(approval: Approval, atValue: string): Approval {
  if (approval.state === 'expired') return approval
  if (approval.state !== 'requested') throw new UserError('approvalDecided', { state: approval.state })
  const at = requireTime(atValue, 'The Approval expiry check time')
  if (Date.parse(at) < Date.parse(approval.expiresAt)) return approval
  return { ...approval, state: 'expired', decidedAt: approval.expiresAt }
}