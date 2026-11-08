/** Reliable outbound message delivery backed by persistent receipts, an undo window, and retried reply effects. */
import { UserError, type OutboundSend, type Outbox as OutboxPort, type ReplyStatus } from '@superagent/kernel'
import type { Commands } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { ProbeAnswer } from '../sources/kind.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from './effects.ts'
import type { Store } from './store.ts'

export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly sources: Pick<SourceRegistry, 'instance' | 'channelAllowed' | 'send' | 'probe'>
  readonly commands: Commands
  paused(): boolean
  /** How long a new message stays recallable before it is sent, in milliseconds; 0 sends it at once. */
  undoWindowMs(): number
}

/**
 * Persists outbound channel messages as receipts and delivers them sequentially through `Effects` and `SourceRegistry`.
 * Implements the core `Outbox` port for `Engine` and source contexts, ensuring per-conversation ordering for each ticket until an earlier message fails repeatedly.
 * A message's `send` Action names the write: its idempotency key is the receipt id and the `reply` effect's key, so two
 * revisions of one write are two effects and a replay of one revision is one.
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
   * Record a message receipt and enqueue its delivery effect for the end of the undo window atomically, both under the
   * send Action's idempotency key. A key already recorded is ignored, so a recalled or sent revision is never queued again.
   */
  send(message: OutboundSend): void {
    if (message.action.level !== 'send' || message.action.source !== message.channel.source) {
      throw new TypeError('An outbound message must carry a send Action for its Channel\'s Source')
    }
    const id = message.action.idempotencyKey
    // Validate IM reply length here; acknowledgements are already validated when decided.
    if (message.action.kind === 'reply' && message.channel.source === 'feishu') checkedImText(message.text)
    const { store, effects } = this.host
    const now = Date.now()
    const requested = this.host.undoWindowMs()
    const windowMs = Math.max(0, Number.isFinite(requested) ? requested : 0)
    const dueAt = new Date(now + windowMs).toISOString()
    store.atomic(() => {
      if (store.receipts.add(message, { dueAt, windowMs })) effects.enqueue('reply', id, {}, now + windowMs)
    })
  }
  status(id: string): ReplyStatus | undefined { return this.host.store.receipts.get(id)?.status }
  /** Withdraw a message best-effort: a pending message is cancelled even after its window, such as one whose retries keep failing. */
  withdraw(id: string): void {
    const { store, effects } = this.host
    const at = new Date().toISOString()
    store.atomic(() => { if (store.receipts.withdraw(id, at)) effects.cancel('reply', id) })
  }
  /**
   * Recall a pending message whose undo window is still open, cancel its delivery, and keep its receipt as `recalled`.
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
    // A receipt from a version without an undo window may have been sent already; it cannot be recalled.
    if (!receipt.dueAt) throw new UserError('undoUnavailable')
    if (Date.parse(receipt.dueAt) <= now) throw new UserError('undoClosed', { at: receipt.dueAt })
    const at = new Date(now).toISOString()
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
  sent(): Promise<void> { return this.host.effects.idle('reply') }
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
      catch (error) { throw new Error(`The ${receipt.channel.source} delivery check failed, so the message is not resent: ${String(error)}`) }
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
