/** The approval commands: request one, decide it under the Policy's auto-approval whitelist, or record a person's decision. */
import { approvalId, approve, createApproval, deny, expire, UserError, type ActionLevel, type ActorRef, type Approval,
  type ApprovalRequest, type Repositories } from '@superagent/kernel'
import { isDomainName, type ApprovalPolicy, type WorkHours } from '../policy.ts'
import type { Store } from './store.ts'

/** The person at the local management panel: the operator has no Source identity, so the audit names the panel. */
export const PANEL_ACTOR = { source: 'panel', id: 'local' } as const

/**
 * The decision actor of an Approval the Policy decided instead of a person. It is deliberately not a Source or the
 * panel: an audit reader can tell an automatic grant from a human one.
 */
export const AUTO_APPROVAL_ACTOR: ActorRef = { source: 'policy', id: 'auto-approval' }

/** The decision actor of a request the runtime cancels because the message it held is no longer needed. */
export const ENGINE_ACTOR: ActorRef = { source: 'engine', id: 'outbox' }

/** What a caller supplies to request one Approval; the request time is the moment `requestApproval` is called. */
export type ApprovalRequestInput = Omit<ApprovalRequest, 'requestedAt'>

/** Whether the Policy decides this Approval itself: a match names the reason it records, a refusal what a person must decide. */
export type AutoApprovalVerdict =
  | { approved: true; reason: string }
  | { approved: false; reason: string }

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * The domain a target names, lower-cased: the part after `@` of one address, the host of a URL, or the target itself when
 * it is already a domain. A multi-recipient, display-name, or mailto target with a query names no single domain, so it
 * never matches; an opaque target such as a message id names none either.
 */
export function approvalTargetDomain(target: string | undefined): string | undefined {
  if (!target) return undefined
  const value = target.trim()
  // One address or URL only: a list could hide an external recipient behind a whitelisted one.
  if (!value || /[,;<>]/.test(value) || /\s/.test(value)) return undefined
  if (/^mailto:/i.test(value)) {
    const address = value.slice('mailto:'.length)
    // A query can carry cc and bcc recipients, which this parser does not judge.
    if (!address || /[?#]/.test(address)) return undefined
    return approvalTargetDomain(address)
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '')
      return isDomainName(host) ? host : undefined
    } catch {
      return undefined
    }
  }
  const at = value.indexOf('@')
  if (at !== value.lastIndexOf('@')) return undefined
  const domain = (at >= 0 ? value.slice(at + 1) : value).toLowerCase().replace(/\.$/, '')
  return isDomainName(domain) ? domain : undefined
}

/** The local weekday and minute of the day at `at` in `timeZone`, which is what a working-hours window compares. */
function localClock(at: string, timeZone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at))
  const part = (type: string): string => parts.find(item => item.type === type)?.value ?? ''
  return { day: DAY_NAMES.indexOf(part('weekday') as typeof DAY_NAMES[number]), minute: Number(part('hour')) % 24 * 60 + Number(part('minute')) }
}

/** The minutes since midnight of a `HH:MM` time. */
const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))

/** Whether `at` falls on one of the window's days and inside its start (inclusive) and end (exclusive). */
export function withinWorkingHours(hours: WorkHours, at: string): boolean {
  const clock = localClock(at, hours.timeZone)
  return hours.days.includes(clock.day) && clock.minute >= minutesOf(hours.start) && clock.minute < minutesOf(hours.end)
}

/** A window as audit text, such as `Mon,Tue,Wed,Thu,Fri 09:00-18:00 Asia/Shanghai`. */
const windowText = (hours: WorkHours): string =>
  `${hours.days.map(day => DAY_NAMES[day]!).join(',')} ${hours.start}-${hours.end} ${hours.timeZone}`

/**
 * Decide whether the Policy's internal-domain whitelist may approve this Action at the moment it was requested.
 * The Source's own rule replaces the tenant rule. A spend Action is never automatic, and a target whose domain is not on
 * the rule, or a moment outside its working hours, stays for a person. An empty whitelist therefore approves nothing.
 */
export function evaluateAutoApproval(policy: ApprovalPolicy, approval: Pick<Approval, 'action' | 'target' | 'requestedAt'>): AutoApprovalVerdict {
  const { action } = approval
  if (action.level === 'spend') return { approved: false, reason: 'a spend action always needs a person' }
  const own = policy.sources[action.source]
  const rule = own ?? policy.tenant
  const scope = own ? `${action.source}'s` : 'the tenant'
  if (!rule) return { approved: false, reason: `${scope} rule has no auto-approval for this source` }
  if (!rule.domains.length) return { approved: false, reason: `${scope} auto-approval allows no domain` }
  if (!approval.target) return { approved: false, reason: `${scope} auto-approval needs a target domain` }
  const domain = approvalTargetDomain(approval.target)
  if (!domain) return { approved: false, reason: `${scope} auto-approval cannot read one domain from the target` }
  const allowed = rule.domains.find(item => domain === item || domain.endsWith(`.${item}`))
  if (!allowed) return { approved: false, reason: `${domain} is not on ${scope} internal-domain whitelist` }
  if (rule.hours && !withinWorkingHours(rule.hours, approval.requestedAt)) {
    return { approved: false, reason: `${domain} is outside ${scope} window ${windowText(rule.hours)}` }
  }
  const when = rule.hours ? ` within ${windowText(rule.hours)}` : rule.always === true ? ' at any time' : ''
  return { approved: true, reason: `${domain} is on ${scope} internal-domain whitelist${when}` }
}

/**
 * Record one Approval request, then let the Policy decide it when the whitelist matches; an automatic approval is saved
 * as a normal `approved` record with `AUTO_APPROVAL_ACTOR` and its reason, never skipped. `now` is a clock seam: the
 * request and an automatic decision share its one moment, and production uses the real clock. An existing record is
 * returned unchanged only when it has the same target; a different target, or an expired request, is refused, so no
 * grant for one destination can authorize another.
 */
export function requestApproval(store: Pick<Repositories, 'atomic' | 'approvals'>, request: ApprovalRequestInput, policy: ApprovalPolicy,
  now: () => string = () => new Date().toISOString()): Approval {
  const at = now()
  if (request.target !== undefined && !request.target.trim()) throw new TypeError('The Approval target must be a non-empty string')
  const target = request.target === undefined ? undefined : request.target.trim()
  const id = approvalId(request.ticketId, request.action.idempotencyKey)
  // An expiry is saved before the refusal is thrown, so it must not share a transaction that the throw rolls back.
  const result = store.atomic((): { approval?: Approval; expiredAt?: string } => {
    const existing = store.approvals.get(id)
    if (existing) {
      if ((existing.target ?? '') !== (target ?? '')) throw new UserError('approvalTargetMismatch')
      if (existing.state === 'expired') return { expiredAt: existing.expiresAt }
      if (existing.state === 'requested' && Date.parse(at) >= Date.parse(existing.expiresAt)) {
        store.approvals.save(expire(existing, at))
        return { expiredAt: existing.expiresAt }
      }
      return { approval: existing }
    }
    const requested = createApproval({ ...request, target, requestedAt: at })
    const verdict = evaluateAutoApproval(policy, requested)
    const approval = verdict.approved
      ? approve(requested, { by: AUTO_APPROVAL_ACTOR, at, reason: `Auto-approved by policy: ${verdict.reason}.` })
      : requested
    store.approvals.save(approval)
    return { approval }
  })
  if (result.expiredAt) throw new UserError('approvalExpired', { at: result.expiredAt })
  return result.approval!
}

/**
 * Decide one requested Approval at `at`, optionally granting a lower Action level, and save it in one transaction.
 * Returns the stored record, or `undefined` when no Approval has that id; a decided, expired or invalid request is
 * refused by the kernel state machine.
 */
export function decideApproval(store: Store, id: string, state: 'approved' | 'denied', at: string,
  level?: ActionLevel): Approval | undefined {
  return store.atomic(() => {
    const approval = store.approvals.get(id)
    if (!approval) return undefined
    const decision = { by: PANEL_ACTOR, at, ...(level === undefined ? {} : { level }) }
    const next = state === 'approved' ? approve(approval, decision) : deny(approval, decision)
    store.approvals.save(next)
    return next
  })
}
