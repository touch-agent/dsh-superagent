/** A Ticket's audit timeline: the Trigger's trace, where it went, and every Approval, read as who, on what basis, and what changed. */
import { z } from 'zod'
import { ACTION_LEVELS, traceId, type ActionCost, type ActionLevel, type ActorRef, type Approval,
  type AssignmentState, type ChannelRef, type DecisionKind, type PolicyEffect, type Reason, type ReportState, type Review,
  type Strength, type Ticket, type TicketInput, type TicketOutcome } from '@superagent/kernel'
import type { Store } from '../store.ts'
import { decisionView, snapshot, type ActorView, type Snapshot, type ViewHost } from './records.ts'
import { basisFacts, type BasisFact } from './tickets.ts'
import { markdown, preview } from './text.ts'

/** One Action as the timeline shows it: the object and revision it touched, and who acted at which level. */
export interface TimelineAction {
  kind: string
  source: string
  objectId: string
  revision: string
  level: ActionLevel
  actor: ActorView
  cost?: ActionCost
  /** Where the Action reaches when that is more specific than its object, such as a mail recipient. */
  target?: string
}
/** Who performed a step; a step the system performed names no person. */
export interface TimelineWho {
  actor?: ActorView
  system?: 'executor' | 'panel' | 'policy' | 'session' | 'human' | 'system'
}
/** The Approval that let or refused one Action, as the basis of a timeline entry. */
export interface TimelineApproval {
  id: string
  state: Approval['state']
  requestedAt: string
  expiresAt: string
  level: ActionLevel
  grantedLevel?: ActionLevel
  requestedBy?: ActorView
  decidedBy?: ActorView
  decidedAt?: string
  reason?: string
  target?: string
}
/** Where the Trigger behind an entry went: filtered, delivered to this Ticket, handed back, or taken up. */
export interface TimelineDisposition {
  filtered?: Reason
  delivered: boolean
  context?: true
  requeued?: true
  acked?: boolean
  handbacks: { ticketId: string; title: string; reason: string; at: string }[]
}
/** 凭什么: the Decision, Mandate, Policy, Approval and disposition an entry rests on. */
export interface TimelineBasis {
  strength?: Strength
  facts?: BasisFact[]
  reason?: Reason[]
  rules?: { id: string; name: string; matched: boolean; reason: string }[]
  policyVersion?: string
  decision?: { id: string; kind: DecisionKind; at: string }
  approval?: TimelineApproval
  disposition?: TimelineDisposition
}
/** 改了什么: the Action, Report, Input, assignment or Ticket end the entry records. */
export type TimelineChange =
  | { kind: 'input'; input: { kind: 'trigger' | 'text' | 'note'; preview?: string; text?: string; delivered?: boolean
    readAt?: string | null; handback?: { reason: string; at: string } } }
  | { kind: 'decision'; outcome: DecisionKind }
  | { kind: 'ticket'; id: string; title: string }
  | { kind: 'assignment'; id: string; state: AssignmentState; endedReason?: string }
  | { kind: 'action'; action: TimelineAction; ok?: boolean; error?: string }
  | { kind: 'report'; state: ReportState; summary: string; review?: Review }
  | { kind: 'end'; outcome: TicketOutcome; reason?: string }
  | { kind: 'policy'; from: string; to: string; effect?: PolicyEffect }
  | { kind: 'resume' }
  | { kind: 'reopen' }
  | { kind: 'binding'; channel: ChannelRef }
/** One step of a Ticket's audit timeline, in time order. */
export interface TimelineEntry {
  id: string
  at: string
  /** What kind of step it is; the panel names each kind. */
  kind: 'request' | 'decision' | 'create' | 'dispatch' | 'assignment' | 'action' | 'report' | 'approval' | 'input' | 'policy'
    | 'resume' | 'reopen' | 'binding' | 'end'
  /** Which record the entry was composed from. */
  source: 'trace' | 'disposition' | 'approval' | 'ticket'
  /** 谁 */
  who: TimelineWho
  /** 凭什么 */
  basis: TimelineBasis
  /** 改了什么 */
  change: TimelineChange
  /** The Trigger whose trace or disposition produced this entry. */
  trigger?: string
  /** A fact the stored records cannot supply, stated rather than guessed. */
  gap?: 'noActor' | 'noDecision' | 'noTrace'
}
/** A Ticket's whole timeline, oldest first, and the gaps that keep it from explaining every step. */
export interface TicketTimelineView {
  ticket: { id: string; title: string }
  entries: TimelineEntry[]
  gaps?: ('noDecision' | 'noTrace')[]
}

/** The `action` span data a lightweight Ticket's inline run records, validated because it is read back from JSON. */
const InlineAction = z.object({
  action: z.object({ kind: z.string(), source: z.string(), objectId: z.string(), revision: z.string(),
    level: z.enum(ACTION_LEVELS), actor: z.object({ source: z.string(), id: z.string() }),
    cost: z.union([z.object({ kind: z.literal('money'), amount: z.number(), currency: z.string() }),
      z.object({ kind: z.literal('time'), minutes: z.number() })]).optional() }),
  ok: z.boolean().optional(),
  error: z.string().optional(),
})

/** An actor with the panel's display name; the outbox writes under a system id, so name it rather than show `outbox`. */
function actorName(snapshot: Snapshot, ref: ActorRef, human = true): ActorView {
  if (ref.source === 'dsh-superagent' && ref.id === 'outbox') return { source: ref.source, id: ref.id, name: { zh: '外发通道', en: 'Outbox' } }
  return snapshot.actor(ref, human)
}
/** The disposition of one Trigger as this Ticket saw it: delivered, followed for context, handed back or taken up. */
function dispositionOf(store: Store, ticketId: string, triggerId: string, delivered: boolean): TimelineDisposition | undefined {
  const disposition = store.triggers.disposition(triggerId)
  if (!disposition) return undefined
  return {
    ...disposition.filtered ? { filtered: disposition.filtered } : {},
    delivered: delivered || disposition.fanout.includes(ticketId),
    ...disposition.context?.includes(ticketId) ? { context: true as const } : {},
    ...disposition.requeued ? { requeued: true as const } : {},
    ...disposition.acked?.includes(ticketId) ? { acked: true as const } : {},
    handbacks: (disposition.handbacks ?? []).filter(item => item.ticketId === ticketId).map(item => ({ ...item,
      title: store.tickets.get(item.ticketId)?.title ?? item.ticketId })),
  }
}
/** The approval fields of one Approval, with its request and decision actors named as the panel names them. */
function approvalOf(view: Snapshot, approval: Approval): TimelineApproval {
  return { id: approval.id, state: approval.state, requestedAt: approval.requestedAt, expiresAt: approval.expiresAt,
    level: approval.action.level, ...approval.grantedLevel ? { grantedLevel: approval.grantedLevel } : {},
    ...approval.requestedBy ? { requestedBy: actorName(view, approval.requestedBy) } : {},
    ...approval.decidedBy ? { decidedBy: actorName(view, approval.decidedBy) } : {},
    ...approval.decidedAt ? { decidedAt: approval.decidedAt } : {}, ...approval.reason ? { reason: approval.reason } : {},
    ...approval.target ? { target: approval.target } : {} }
}
/** The Action of one Approval as the timeline shows it; its actor is the caller, not the approver. */
function approvalAction(view: Snapshot, approval: Approval): TimelineAction {
  const action = approval.action
  return { kind: action.kind, source: action.source, objectId: action.objectId, revision: action.revision, level: action.level,
    actor: actorName(view, action.actor), ...action.level === 'spend' ? { cost: action.cost } : {},
    ...approval.target ? { target: approval.target } : {} }
}
/** The system that performed a step no person or agent performed. */
const system = (name: NonNullable<TimelineWho['system']>): TimelineWho => ({ system: name })
/**
 * Builds one Ticket's audit timeline from its Trigger trace, the dispositions of the Triggers that reached it, the
 * Approvals recorded for it and the Ticket itself. Oldest first, so a reader follows the work. The function only reads:
 * a Ticket timeline is never a place that changes the work it explains.
 */
export function ticketTimeline(host: ViewHost, ticketId: string): TicketTimelineView | undefined {
  const { store } = host
  const ticket = store.tickets.get(ticketId)
  if (!ticket) return undefined
  const view = snapshot(host)
  const origin = store.triggers.get(ticket.origin.triggerId)
  const disposition = origin ? store.triggers.disposition(origin.id) : undefined
  const decision = ticket.decisionId ? store.decisions.get(ticket.decisionId) : undefined
  const shown = decision ? decisionView(view, decision) : undefined
  const spans = origin ? store.spans.trace(traceId(origin.id)) : []
  // A child Ticket inherits its root's authorization and has no Mandate of its own.
  const root = ticket.parentTicketId ? store.tickets.get(ticket.rootTicketId ?? ticket.parentTicketId) : ticket
  const mandate = root?.mandate
  const policyVersion = mandate?.policyVersion ?? ''
  const mandateFacts = mandate ? basisFacts(mandate.basis, view.rule).facts : []
  const authority = (): TimelineBasis => ({ ...mandate ? { strength: mandate.strength } : {}, facts: mandateFacts,
    policyVersion })
  const entries: TimelineEntry[] = []
  // The request itself: the message the Ticket was accepted from, with where that Trigger went.
  if (origin) {
    entries.push({ id: `request:${origin.id}`, at: origin.at, kind: 'request', source: disposition ? 'disposition' : 'ticket',
      who: { actor: actorName(view, origin.actor, origin.human) },
      basis: { policyVersion: decision?.policyVersion ?? policyVersion,
        ...disposition ? { disposition: dispositionOf(store, ticket.id, origin.id, true)! } : {} },
      change: { kind: 'input', input: { kind: 'trigger', preview: preview(origin.text), delivered: true } },
      trigger: origin.id })
  }
  // The Decision that accepted the Ticket: who asked, under which strength and rules, at which Policy version.
  if (decision) {
    const decide = decision.evalId ? spans.find(span => span.kind === 'decide' && span.evalId === decision.evalId)
      : spans.find(span => span.kind === 'decide')
    entries.push({ id: `decision:${decision.id}`, at: decision.at, kind: 'decision', source: decide ? 'trace' : 'ticket',
      who: { actor: actorName(view, decision.mandate?.actor ?? origin?.actor ?? { source: 'dsh-superagent', id: 'engine' },
        (decision.mandate?.basis.via ?? 'local') !== 'bot') },
      basis: { ...authority(), strength: decision.strength, reason: decision.reason, ...shown?.rules.length ? { rules: shown.rules } : {},
        policyVersion: decision.policyVersion, decision: { id: decision.id, kind: decision.kind, at: decision.at },
        ...origin && disposition ? { disposition: dispositionOf(store, ticket.id, origin.id, true)! } : {} },
      change: { kind: 'decision', outcome: decision.kind }, ...origin ? { trigger: origin.id } : {} })
  }
  // The Ticket's creation and each Assignment start, both recorded by the Engine in the Trigger's trace.
  const create = spans.find(span => span.kind === 'attach' && span.data?.ticketId === ticket.id && span.data?.created === true)
  entries.push({ id: create?.id ?? `create:${ticket.id}`, at: create?.at ?? ticket.createdAt, kind: 'create',
    source: create ? 'trace' : 'ticket', who: decision && mandate ? { actor: actorName(view, mandate.actor, mandate.basis.via !== 'bot') } : system('executor'), basis: authority(),
    change: { kind: 'ticket', id: ticket.id, title: ticket.title } })
  for (const item of ticket.inputs) {
    const entry = inputEntry(store, view, ticket, item)
    if (entry) entries.push(entry)
  }
  for (const assignment of ticket.assignments) {
    const dispatch = spans.find(span => span.kind === 'dispatch' && span.data?.assignmentId === assignment.id)
    const at = dispatch?.at ?? assignment.startedAt ?? assignment.createdAt
    entries.push({ id: `dispatch:${assignment.id}`, at, kind: assignment.state === 'pending' ? 'assignment' : 'dispatch',
      source: dispatch ? 'trace' : 'ticket', who: system('executor'), basis: authority(),
      change: { kind: 'assignment', id: assignment.id, state: assignment.state,
        ...assignment.endedReason ? { endedReason: assignment.endedReason } : {} } })
    if (assignment.state === 'ended' && assignment.endedAt) {
      entries.push({ id: `assignment-end:${assignment.id}`, at: assignment.endedAt, kind: 'assignment', source: 'ticket',
        who: system('executor'), basis: authority(),
        change: { kind: 'assignment', id: assignment.id, state: 'ended', ...assignment.endedReason ? { endedReason: assignment.endedReason } : {} } })
    }
    if (assignment.report) {
      entries.push({ id: `report:${assignment.id}:${assignment.report.at}`, at: assignment.report.at, kind: 'report', source: 'ticket',
        who: system('executor'), basis: authority(),
        change: { kind: 'report', state: assignment.report.state, summary: markdown(assignment.report.summary),
          ...assignment.report.review ? { review: assignment.report.review } : {} } })
    }
  }
  // A lightweight Ticket's action ledger: one entry per Action its inline run performed, with ok/error.
  for (const span of spans) {
    if (span.kind !== 'action' || span.data?.ticketId !== ticket.id) continue
    const parsed = InlineAction.safeParse(span.data)
    if (!parsed.success) continue
    const action = parsed.data.action
    entries.push({ id: span.id, at: span.at, kind: 'action', source: 'trace',
      who: { actor: actorName(view, action.actor) }, basis: authority(),
      change: { kind: 'action', action: { kind: action.kind, source: action.source, objectId: action.objectId,
        revision: action.revision, level: action.level, actor: actorName(view, action.actor),
        ...action.cost ? { cost: action.cost } : {} },
        ...parsed.data.ok === undefined ? {} : { ok: parsed.data.ok }, ...parsed.data.error ? { error: parsed.data.error } : {} },
      ...origin ? { trigger: origin.id } : {} })
  }
  // The Approvals of the Ticket: one entry per record, at the decision when there is one, otherwise at the request.
  for (const approval of store.approvals.byTicket(ticket.id)) {
    const at = approval.decidedAt ?? approval.requestedAt
    const who: TimelineWho = approval.decidedBy ? { actor: actorName(view, approval.decidedBy) }
      : approval.state === 'expired' ? system('system')
        : approval.requestedBy ? { actor: actorName(view, approval.requestedBy) }
          : system('executor')
    entries.push({ id: `approval:${approval.id}`, at, kind: 'approval', source: 'approval', who,
      basis: { ...authority(), approval: approvalOf(view, approval) },
      change: { kind: 'action', action: approvalAction(view, approval) } })
  }
  if (ticket.ended) {
    const human = ticket.ended.by === 'human'
    entries.push({ id: `end:${ticket.id}:${ticket.ended.at}`, at: ticket.ended.at, kind: 'end', source: 'ticket',
      who: human ? system('human') : system('executor'), basis: authority(),
      change: { kind: 'end', outcome: ticket.ended.outcome, ...ticket.ended.reason ? { reason: ticket.ended.reason } : {} },
      ...human ? { gap: 'noActor' as const } : {} })
  }
  // JS sorts stably, so equal timestamps keep the order the records were read in.
  entries.sort((left, right) => left.at.localeCompare(right.at))
  const gaps: TicketTimelineView['gaps'] = []
  if (!decision) gaps.push('noDecision')
  if (!spans.length) gaps.push('noTrace')
  return { ticket: { id: ticket.id, title: ticket.title }, entries, ...gaps.length ? { gaps } : {} }
}

/** One Input of the Ticket as a timeline entry; a Trigger it came from also brings its disposition. */
function inputEntry(store: Store, view: Snapshot, ticket: Ticket, item: TicketInput): TimelineEntry | undefined {
  const root = ticket.parentTicketId ? store.tickets.get(ticket.rootTicketId ?? ticket.parentTicketId) : ticket
  const policyVersion = root?.mandate?.policyVersion ?? ''
  const base = { id: `input:${item.id}`, at: item.at, source: 'ticket' as const }
  switch (item.kind) {
    case 'trigger': {
      const trigger = store.triggers.get(item.triggerId)
      if (!trigger) return { ...base, kind: 'input', who: system('session'), basis: { policyVersion: policyVersion },
        change: { kind: 'input', input: { kind: 'trigger', delivered: !ticket.undelivered.includes(item.id) } }, gap: 'noTrace' as const }
      const handback = (store.triggers.disposition(item.triggerId)?.handbacks ?? []).find(handback => handback.ticketId === ticket.id)
      return { ...base, kind: 'input', source: store.triggers.disposition(item.triggerId) ? 'disposition' : 'ticket',
        who: { actor: actorName(view, trigger.actor, trigger.human) },
        basis: { policyVersion, ...store.triggers.disposition(item.triggerId)
          ? { disposition: dispositionOf(store, ticket.id, item.triggerId, !ticket.undelivered.includes(item.id)) } : {} },
        change: { kind: 'input', input: { kind: 'trigger', preview: preview(trigger.text), delivered: !ticket.undelivered.includes(item.id),
          ...item.readAt !== undefined ? { readAt: item.readAt } : {}, ...handback ? { handback: { reason: handback.reason,
            at: handback.at } } : {} } },
        trigger: item.triggerId }
    }
    case 'text':
    case 'note':
      return { ...base, kind: 'input', who: system('session'), basis: { policyVersion: policyVersion },
        change: { kind: 'input', input: { kind: item.kind, text: markdown(item.text) } } }
    case 'policy-changed':
      return { ...base, kind: 'policy', who: system('panel'), basis: { policyVersion: item.to },
        change: { kind: 'policy', from: item.from, to: item.to, ...item.effect ? { effect: item.effect } : {} } }
    case 'reopen': {
      const decision = store.decisions.get(item.decisionId)
      return { ...base, kind: 'reopen', who: decision ? { actor: actorName(view, decision.mandate?.actor ?? { source: 'dsh-superagent',
        id: 'engine' }, decision.mandate?.basis.via !== 'bot') } : system('executor'),
        basis: { policyVersion: decision?.policyVersion ?? policyVersion, ...decision ? { decision: { id: decision.id,
          kind: decision.kind, at: decision.at }, reason: decision.reason } : {} }, change: { kind: 'reopen' } }
    }
    case 'resumed': {
      const trigger = store.triggers.get(item.triggerId)
      return { ...base, kind: 'resume', who: trigger ? { actor: actorName(view, trigger.actor, trigger.human) } : system('human'),
        basis: { policyVersion: policyVersion }, change: { kind: 'resume' }, ...trigger ? { trigger: trigger.id } : {} }
    }
    case 'binding':
      return { ...base, kind: 'binding', who: system('executor'), basis: { policyVersion: policyVersion },
        change: { kind: 'binding', channel: item.channel } }
  }
}
