/** The Engine's messages to Channels, each by the rule that allows it. */
import { acknowledgementAction, outboundAction, type OutboundKind } from './action.ts'
import { key } from './ids.ts'
import { UserError } from './errors.ts'
import { latestAssignment, liveTicket, ticketOutcome } from './model.ts'
import type { Attention, ChannelRef, Ticket, Trigger } from './model.ts'
import type { OutboundSend, ReplyStatus } from './ports.ts'
import { EnginePart } from './part.ts'

/**
 * A message for a Channel, by purpose: an Executor's acknowledgement of a person's request it works on, the answer to a
 * person's question once the worker reported it, the result of a ticket that is `ready`, `completed`, `merged`, or `dropped`,
 * or the ticket's current `question` for a person (`attention`). When `ticketId` is omitted, the ticket that `triggerId` reached is used.
 */
export type ReplyRequest =
  | { purpose: 'acknowledgement'; ticketId: string; triggerId: string; text: string }
  | { purpose: 'answer' | 'result' | 'attention'; ticketId?: string; triggerId?: string; question?: string; text: string }
/** A queued message: its id, whether it went out, and whether an earlier request had queued it already. */
export interface Reply { id: string; status: ReplyStatus; reused: boolean }

/**
 * Replies writes the Engine's messages to Channels through the Outbox port: an acknowledgement, the answer to a person's
 * question, a ticket's result, and its question for a person, each only when its rule allows it. A message is queued under
 * the idempotency key of its `send` Action, derived from the Channel's Source, the object written on, the message kind and
 * its content revision, so a replay of one revision is one message and another revision is another message.
 */
export class Replies extends EnginePart {
  /**
   * Queue a message for the Channel its purpose names: an acknowledgement or an answer goes where that person's message was
   * written, attention where the message that raised the question was (or to the ticket's starting conversation), and a
   * result to the conversation where the ticket started (`result` is allowed only for a ticket in `ready`, `completed`,
   * `merged`, or `dropped`). Each message is queued at most once per revision. An acknowledgement, even one already queued,
   * records that the ticket's worker took the message up.
   * @throws UserError when the ticket or trigger is unknown or the purpose's rule refuses it, such as a result of a ticket
   * that is not ready, completed, merged, or dropped.
   */
  reply(request: ReplyRequest): Reply {
    return request.purpose === 'acknowledgement' ? this.acknowledge(request) : this.answer(request)
  }
  /**
   * Queue the acknowledgement an accept carries where the message that started the ticket was written, if it has a Channel
   * and a person wrote it.
   */
  acknowledgeAccepted(ticketId: string, trigger: Trigger, text: string): void {
    if (!trigger.channel || !trigger.human) return
    // A receipt queued by an older version under the trigger's id already carries the acknowledgement.
    const action = acknowledgementAction(trigger.channel, trigger.id)
    if (this.options.outbox.status(action.idempotencyKey) !== undefined
      || this.options.outbox.status(key('ack', trigger.id)) !== undefined) return
    this.options.outbox.send({ action, channel: trigger.channel, text, ticketId })
  }
  /**
   * Withdraw a ticket's question for a person from the outbox, unless it went out already. The withdrawal derives the same
   * message id as the attention reply, so it works for any revision of that question.
   */
  withdrawAttention(ticket: Ticket, attention: Attention): void {
    const channel = this.attentionChannel(ticket, attention)
    if (!channel) return
    this.options.outbox.withdraw(outboundAction({ kind: 'reply', source: channel.source, objectId: attention.id,
      revision: 'asked' }).idempotencyKey)
    // A question queued before T2-05 kept the old id; withdrawing it too keeps the replacement silent.
    this.options.outbox.withdraw(key('attention-reply', attention.id))
  }
  private acknowledge(request: Extract<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const ticket = this.require(request.ticketId)
    if (!liveTicket(ticket)) throw new UserError('ackEnded')
    const trigger = this.repo.triggers.get(request.triggerId)
    if (!trigger) throw new UserError('unknownTrigger')
    // Context-only threads are read-only and cannot receive acknowledgements.
    if (!this.reaches(ticket, trigger, false)) throw new UserError('notReached')
    if (!trigger.channel) throw new UserError('ackNoChannel')
    const action = acknowledgementAction(trigger.channel, trigger.id)
    const message = { action, channel: trigger.channel, text: request.text, ticketId: ticket.id }
    const id = action.idempotencyKey
    // A receipt queued before T2-05 kept the trigger's id; an acknowledgement already sent then still counts.
    const legacy = key('ack', trigger.id)
    const current = this.options.outbox.status(id)
    const previous = this.options.outbox.status(legacy)
    const existing = current ?? previous
    if (!existing && !trigger.human) throw new UserError('ackNotPerson')
    // Preserve the automatic or first queued acknowledgement.
    if (!existing) this.options.outbox.send(message)
    this.takeUp(ticket.id, trigger.id)
    // Name the receipt that actually exists: a message queued by an older version keeps its old id.
    return { id: current === undefined && previous !== undefined ? legacy : id, status: current ?? previous ?? 'pending',
      reused: existing !== undefined }
  }
  private answer(request: Exclude<ReplyRequest, { purpose: 'acknowledgement' }>): Reply {
    const trigger = request.triggerId ? this.repo.triggers.get(request.triggerId) : undefined
    if (request.triggerId && !trigger) throw new UserError('unknownTrigger')
    const ticket = request.ticketId ? this.require(request.ticketId)
      : trigger ? this.repo.tickets.list().find(item => this.reaches(item, trigger)) : undefined
    if (request.purpose === 'result') {
      const outcome = ticket && ticketOutcome(ticket)
      const reported = !!ticket && liveTicket(ticket) && latestAssignment(ticket)?.report?.state === 'ready'
      const ready = outcome === 'merged' || outcome === 'completed' || outcome === 'dropped' || reported
      if (!ticket || !ready) throw new UserError('notReady')
    }
    const attention = request.purpose === 'attention' ? ticket?.attention : undefined
    // Attention replies must match the ticket's currently open question text.
    if (request.purpose === 'attention' && (!attention || attention.question !== request.question)) throw new UserError('notAttention')
    if (request.purpose === 'answer' && !trigger?.human) throw new UserError('notQuestion')
    const channel = request.purpose === 'answer' ? trigger!.channel
      : attention && ticket ? this.attentionChannel(ticket, attention) : ticket ? this.sourceChannel(ticket) : undefined
    // A message's key names its Destination too: with no Channel there is no revision to queue yet, only a refusal below.
    const message = channel && (attention
      ? this.message(channel, request.text, 'reply', attention.id, 'asked', ticket?.id)
      : this.message(channel, request.text, 'reply', trigger?.id ?? ticket?.id ?? '', key('reply-text', request.text), ticket?.id))
    const id = message?.action.idempotencyKey
    // A receipt queued before T2-05 kept the old id, derived from the object and the text.
    const legacy = attention ? key('attention-reply', attention.id) : key('reply', trigger?.id ?? ticket?.id ?? '', request.text)
    const current = id === undefined ? undefined : this.options.outbox.status(id)
    const previous = this.options.outbox.status(legacy)
    const existing = current ?? previous
    const ready = !ticket || !trigger || ticket.answers?.includes(trigger.id)
    if (request.purpose === 'answer' && !ready && !existing) throw new UserError('noAnswer')
    if (!message) throw new UserError('noChannel')
    // A legacy receipt under the old id already carries the message; queueing it under the new id would send it twice.
    if (!existing) this.options.outbox.send(message)
    if (request.purpose === 'answer' && ticket && trigger && ticket.answers?.includes(trigger.id)) {
      ticket.answers = ticket.answers.filter(item => item !== trigger.id)
      this.repo.tickets.save(ticket)
    }
    // Name the receipt that actually exists: a message queued by an older version keeps its old id.
    return { id: current === undefined && previous !== undefined ? legacy : message.action.idempotencyKey,
      status: current ?? previous ?? 'pending', reused: existing !== undefined }
  }
  /** Build one outbound message: its send Action carries the key, and the message carries the content. */
  private message(channel: ChannelRef, text: string, kind: OutboundKind, objectId: string, revision: string,
    ticketId?: string): OutboundSend {
    return { action: outboundAction({ kind, source: channel.source, objectId, revision }), channel, text,
      ...ticketId ? { ticketId } : {} }
  }
  /** The Channel an attention question goes to: the asker's, else the conversation the ticket started in. */
  private attentionChannel(ticket: Ticket, attention: Attention): ChannelRef | undefined {
    return (attention.triggerId ? this.repo.triggers.get(attention.triggerId) : undefined)?.channel ?? this.sourceChannel(ticket)
  }
  /** The conversation a ticket started in: its origin Trigger's Channel, else its first Channel. */
  private sourceChannel(ticket: Ticket): ChannelRef | undefined { return this.source(ticket)?.channel ?? ticket.channels[0] }
}
