/**
 * The action gate: the runtime's producer of Approval requests for irreversible actions. Every caller that is about to
 * commit, send or spend first revalidates the Ticket's Mandate at the action's level and then asks for an Approval, so
 * the Policy decides routine targets itself and a person decides the rest before any external effect happens.
 */
import { UserError, withinActionLevel, type Action, type ActorRef, type Approval, type Policy, type Reason, type Repositories, type Ticket } from '@superagent/kernel'
import { requestApproval } from './approvals.ts'
import type { ApprovalPolicy } from '../policy.ts'

/** How long a gate request stays decidable; a request past it is recorded as expired and the caller prepares a new revision. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000

/** The action levels an Approval guards: the ones that write a shared workspace, leave the system or cost money. */
export const CONSEQUENTIAL_LEVELS = ['commit', 'send', 'spend'] as const

/** What the gate needs to judge one Action: the Ticket that authorizes it, the Action itself and the Policy in force. */
export interface ActionApprovalRequest {
  ticket: Ticket
  action: Action
  /** Where the Action reaches, when the caller knows a place more specific than its object. */
  target?: string
  policy: Policy
  approvalPolicy: ApprovalPolicy
  /** The actor that asked for the approval; the Action already names who would act. */
  requestedBy?: ActorRef
  /** The moment the request and any automatic decision share; production uses the real clock. */
  now?: () => string
}

/** The gate's answer: an Approval whose state says whether it may run now, or the refusal reason to record instead. */
export type ActionApprovalOutcome =
  | { ok: true; approval: Approval }
  | { ok: false; reason: Reason }

/**
 * Revalidate one consequential Action against its Ticket's Mandate and request the Approval it needs. A Mandate refusal
 * returns its reason and creates nothing; the Policy's auto-approval whitelist may decide the request at once, and any
 * other request stays `requested` for a person. A target mismatch or an expired request is a refusal a caller records
 * and retries under a new Action revision, never a silent grant.
 */
export function requestActionApproval(store: Pick<Repositories, 'atomic' | 'approvals'>, request: ActionApprovalRequest): ActionApprovalOutcome {
  if (!(CONSEQUENTIAL_LEVELS as readonly string[]).includes(request.action.level)) {
    throw new TypeError('The action gate guards commit, send and spend actions only')
  }
  const now = request.now ?? (() => new Date().toISOString())
  const at = now()
  const revalidation = request.policy.revalidate(request.ticket.mandate, at, { level: request.action.level })
  if (!revalidation.ok) return { ok: false, reason: revalidation.reason }
  try {
    const approval = requestApproval(store, {
      ticketId: request.ticket.id,
      action: request.action,
      expiresAt: new Date(Date.parse(at) + APPROVAL_TTL_MS).toISOString(),
      ...request.target === undefined ? {} : { target: request.target },
      ...request.requestedBy === undefined ? {} : { requestedBy: request.requestedBy },
    }, request.approvalPolicy, now)
    // A repeated request returns the first record whatever its state: a decided one must not be treated as a fresh grant.
    if (approval.state === 'denied') return { ok: false, reason: { code: 'approvalDenied' } }
    if (approval.state === 'revoked') return { ok: false, reason: { code: 'approvalRevoked' } }
    if (approval.state === 'approved' && !withinActionLevel(request.action.level, approval.grantedLevel ?? approval.action.level)) {
      return { ok: false, reason: { code: 'approvalLevelInsufficient', values: { level: request.action.level } } }
    }
    return { ok: true, approval }
  } catch (error) {
    if (!(error instanceof UserError)) throw error
    if (error.code === 'approvalTargetMismatch') {
      return { ok: false, reason: { code: 'approvalTargetMismatch', values: { target: request.target ?? '' } } }
    }
    if (error.code === 'approvalExpired') return { ok: false, reason: { code: 'approvalExpired', values: error.values } }
    throw error
  }
}