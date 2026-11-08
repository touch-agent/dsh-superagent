/** Reliable outbound message delivery backed by persistent receipts, an undo window, an approval gate, and retried reply effects. */
import { expire, revoke, UserError, withinActionLevel, type Approval, type ChannelRef, type OutboundSend, type Outbox as OutboxPort, type Policy,
  type ReplyStatus } from '@superagent/kernel'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { ProbeAnswer } from '../sources/kind.ts'
import type { ApprovalPolicy } from '../policy.ts'
import { requestActionApproval } from './action-gate.ts'
import { PANEL_ACTOR } from './approvals.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { DropReason, Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts' | 'approvals' | 'tickets'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send' | 'probe' | 'trusted'>
  readonly commands: Commands
  /** The Policy in force, for the action-time revalidation every external send goes through. */
  policy(): Policy
  /** The Policy's auto-approval rules, which may decide a gate request without a person. */
  approvalPolicy(): ApprovalPolicy
  paused(): boolean
  /** How long a new message stays recallable before it is sent, in milliseconds; 0 sends it at once. */
  undoWindowMs(): number
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * A message's `send` Action names the write: its idempotency key is the receipt id and the `reply` effect's key, so two
 * revisions of one write are two effects and a replay of one revision is one.
 * Every external Ticket message passes the action gate before it is queued: the Ticket's Mandate is revalidated at the
 * `send` level, and an Approval must be granted before its `reply` effect is queued. A grant the Policy's whitelist makes
 * itself queues the effect at once; a request left for a person holds the receipt until `reconcile` sees the decision.
 * The built-in conversation Source is the operator's own local UI, not an external effect, so it stays direct.
 * A message waits out the Policy's undo window before its `reply` effect falls due; recalling it inside that window keeps
 * its receipt as `recalled` and cancels the effect, so it is never sent. Messages also wait while processing is paused or
 * their source is unavailable, and settle as dropped when the target conversation is ignored or gone.
 */
export class Outbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    // The reply effect's limit is about concurrency and pause, not the undo window: a row is not due until its window ends.
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [5000, 300_000] })
  }
  /**
   * Record a message receipt and, once its gate allows it, enqueue its delivery effect for the end of the undo window.
   * A gate refusal is recorded on the receipt as its drop reason, so the panel and the Source's dropped list say why the
   * write never happened and a caller can prepare a new revision. Everything is written in one transaction under the
   * send Action's idempotency key; a key already recorded is ignored, so a recalled or sent revision is never queued again.
   */
  send(message: OutboundSend): void {
    if (message.action.level !== 'send' || message.action.source !== message.channel.source) {
      throw new TypeError('An outbound message must carry a send Action for its Channel\'s Source')
    }
    const id = message.action.idempotencyKey
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.action.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects, sources } = this.host
    const now = Date.now()
    const requested = this.host.undoWindowMs()
    const windowMs = Math.max(0, Number.isFinite(requested) ? requested : 0)
    const dueAt = new Date(now + windowMs).toISOString()
    store.atomic(() => {
      const ticket = message.ticketId === undefined ? undefined : store.tickets.get(message.ticketId)
      // A message no Ticket owns is a system write, and a ticket that no longer exists cannot authorize one.
      if (message.ticketId !== undefined && !ticket) {
        if (store.receipts.add(message, { dueAt, windowMs })) {
          store.receipts.settle({ ...message, id }, 'ticketMissing', { at: new Date(now).toISOString() })
        }
        return
      }
      let held: Approval | undefined
      // The built-in conversation Source is local: the operator's own UI, not an external effect, so it needs no gate.
      if (ticket && !sources.trusted(message.channel.source)) {
        const outcome = requestActionApproval(store, { ticket, action: message.action, target: message.target ?? destinationOf(message.channel),
          policy: this.host.policy(), approvalPolicy: this.host.approvalPolicy(), requestedBy: message.action.actor,
          now: () => new Date(now).toISOString() })
        if (!outcome.ok) {
          if (store.receipts.add(message, { dueAt, windowMs })) {
            store.receipts.settle({ ...message, id }, dropReason(outcome.reason.code), { at: new Date(now).toISOString(), values: outcome.reason.values })
          }
          return
        }
        // A requested Approval holds the message; an automatic grant is audit-only and may run at once.
        if (outcome.approval.state === 'requested') held = outcome.approval
      }
      if (!store.receipts.add(message, { dueAt, windowMs }, held?.id)) return
      if (!held) effects.enqueue('reply', id, {}, now + windowMs)
    })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  /**
   * Reconcile held messages with their Approvals: an approval releases the receipt and queues its effect, a denial, expiry,
   * revocation or a lower grant settles it as dropped, and a request past its expiry is recorded before it is dropped.
   * It runs on every pass and before `sent`, so a panel decision needs no separate wiring.
   */
  reconcile(now: Date = new Date()): void {
    const { store, effects } = this.host
    const at = now.toISOString()
    for (const receipt of store.receipts.waiting()) {
      if (!receipt.approvalId || receipt.approvalReleasedAt) continue
      // A held receipt always carries the send Action that named it.
      if (!receipt.action) { store.atomic(() => { store.receipts.settle(receipt, 'approvalMissing', { at }) }); continue }
      const approval = store.approvals.get(receipt.approvalId)
      if (!approval) { store.atomic(() => { store.receipts.settle(receipt, 'approvalMissing', { at }) }); continue }
      if (approval.state === 'requested') {
        if (Date.parse(at) < Date.parse(approval.expiresAt)) continue
        store.atomic(() => {
          store.approvals.save(expire(approval, at))
          store.receipts.settle(receipt, 'approvalExpired', { at, values: { at: approval.expiresAt } })
        })
        continue
      }
      const granted = approval.grantedLevel ?? approval.action.level
      if (approval.state === 'approved' && withinActionLevel(receipt.action.level, granted)) {
        const due = receipt.dueAt === undefined ? now.getTime() : Math.max(now.getTime(), Date.parse(receipt.dueAt) || 0)
        store.atomic(() => {
          if (store.receipts.release(receipt.id, at)) effects.enqueue('reply', receipt.id, {}, due)
        })
        continue
      }
      const reason: DropReason = approval.state === 'approved' ? 'approvalLevelInsufficient'
        : approval.state === 'denied' ? 'approvalDenied' : approval.state === 'revoked' ? 'approvalRevoked' : 'approvalExpired'
      store.atomic(() => { store.receipts.settle(receipt, reason, { at }) })
    }
  }
  /** Withdraw a message best-effort: a pending message is cancelled even after its window, such as one whose retries keep failing. */
  withdraw(id: string): void {
    const { store, effects } = this.host
    const at = new Date().toISOString()
    const receipt = store.receipts.get(id)
    const approval = receipt?.approvalId === undefined ? undefined : store.approvals.get(receipt.approvalId)
    store.atomic(() => {
      if (!store.receipts.withdraw(id, at)) return
      effects.cancel('reply', id)
      // A request no longer needed must leave the panel queue too; an already decided Approval stays for the audit.
      if (approval?.state === 'requested') store.approvals.save(revoke(approval, { at, by: PANEL_ACTOR, reason: 'The message was withdrawn before its decision' }))
    })
  }
  /**
   * Recall a pending message whose undo window is still open, cancel its delivery, and keep its receipt as `recalled`.
   * A message still waiting for an Approval is not sent, so it can be recalled at any time and its request is revoked.
   * A repeated recall of a recalled message is idempotent. Recalling a sent or dropped message, or one whose window has
   * closed, throws a `UserError` with the reason.
   */
  recall(id: string): ReplyStatus {
    const { store, effects } = this.host
    const receipt = store.receipts.get(id)
    if (!receipt) throw new UserError('unknownReply')
    if (receipt.status === 'recalled') return 'recalled'
    if (receipt.status !== 'pending') throw new UserError('replySettled', { status: receipt.status })
    const now = Date.now()
    const at = new Date(now).toISOString()
    // A receipt held for an Approval has not been sent and can still be withdrawn, even past its original window.
    if (receipt.approvalId !== undefined && receipt.approvalReleasedAt === undefined) {
      const approval = store.approvals.get(receipt.approvalId)
      let recalled = false
      store.atomic(() => {
        recalled = store.receipts.withdraw(id, at)
        if (!recalled) return
        effects.cancel('reply', id)
        if (approval?.state === 'requested') store.approvals.save(revoke(approval, { at, by: PANEL_ACTOR, reason: 'The message was recalled before its decision' }))
      })
      if (recalled) return 'recalled'
    }
    // A receipt from a version without an undo window may have been sent already; it cannot be recalled.
    if (!receipt.dueAt) throw new UserError('undoUnavailable')
    if (Date.parse(receipt.dueAt) <= now) throw new UserError('undoClosed', { at: receipt.dueAt })
    let recalled = false
    store.atomic(() => {
      recalled = store.receipts.recall(id, at)
      if (recalled) effects.cancel('reply', id)
    })
    if (recalled) return 'recalled'
    // The receipt changed between the check and the update, such as a send that had already settled.
    const current = store.receipts.get(id)
    if (current?.status === 'recalled') return 'recalled'
    if (current) throw new UserError('replySettled', { status: current.status })
    throw new UserError('undoClosed', { at: receipt.dueAt })
  }
  sent(): Promise<void> {
    this.reconcile()
    return this.host.effects.idle('reply')
  }
  private async deliver(id: string): Promise<void> {
    const { store, sources, commands } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    if (!sources.instance(receipt.channel.source)?.enabled) throw new Later('The Source is off or not installed')
    // Hold later messages for the same ticket and conversation behind an earlier pending message until it exceeds the failure threshold.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    if (!sources.channelAllowed(receipt.channel)) { store.receipts.settle(receipt, 'channelIgnored'); return }
    // An earlier attempt may have reached the remote service before it failed or the process stopped: ask first, and
    // never resend what cannot be ruled out. A Source without a probe keeps the previous retry behavior.
    if (receipt.attemptedAt) {
      let answer: ProbeAnswer | undefined
      try { answer = await sources.probe(receipt, commands) }
      catch (error) { throw new Error(`The ${receipt.channel.source} delivery check failed, so the message is not resent: ${String(error)}`, { cause: error }) }
      if (answer === 'sent') { store.receipts.settle(receipt, 'sent'); return }
      if (answer === 'unknown') throw new Error(`The ${receipt.channel.source} Source cannot tell whether the message was sent; it is kept pending and not resent`)
      // `gone` (or a Source without a probe) means it is not there, so sending it again is safe; a recall during the
      // probe still keeps it unsent.
      if (store.receipts.get(id)?.status !== 'pending') return
    }
    store.receipts.attempt(id, new Date().toISOString())
    // A permanently unreachable target (such as a recalled message or deleted Issue) settles as `channelGone` so its receipt prevents retries.
    const result = await sources.send(receipt, commands)
    if (result === 'waiting') throw new Later('The Source is not installed')
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}

/** The destination a Channel writes to, recorded on the Approval for policy matching and audit. */
function destinationOf(channel: ChannelRef): string {
  return channel.address.url ?? channel.address.chatId ?? channel.address.document ?? channel.thread
}

/** The receipt's drop reason for a gate refusal; every refusal code the gate returns names a drop reason. */
function dropReason(code: string): DropReason {
  return code as DropReason
}
