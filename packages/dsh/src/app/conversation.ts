/** Turns the person's latest message into a conversation Trigger and accepts it deterministically. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { UserError, type AssessmentOutcome, type Decision, type ReceiveResult, type Ticket, type Trigger, type TriggerDisposition } from '@superagent/kernel'
import { conversationTrigger } from '../sources/conversation.ts'

/** The slice of a DSH Agent this module reads: its identity and its session log. */
export interface ConversationAgent {
  readonly id: string
  readonly session: { snapshotEvents(): readonly SessionEvent[] }
}
export interface PersonMessage { id: string; text: string; at: string }
export interface DispatchInput { title?: string; scope?: string; acknowledgement?: string; ticketId?: string; note?: string }
export interface DispatchHost {
  engine: { receive(trigger: Trigger): ReceiveResult; decide(triggerId: string, outcome: AssessmentOutcome): Decision;
    attach(ticketId: string, triggerId: string, note?: string): Ticket }
  disposition(triggerId: string): TriggerDisposition | undefined
  ticket(id: string): Ticket | undefined
}
export type DispatchResult = { triggerId: string; duplicate: boolean; attached?: boolean; ticket?: Ticket } | { refused: string }

/**
 * The latest message in the main Session must be the person's, not a notice or relay the plugin delivered; otherwise the
 * main agent has no request to dispatch and the call is refused. Only text is dispatched.
 */
export function latestPersonMessage(agent: ConversationAgent): PersonMessage | undefined {
  const last = agent.session.snapshotEvents().filter(event => event.type === 'user/message').at(-1)
  if (!last || last.type !== 'user/message' || last.data.source?.kind !== 'user') return undefined
  const text = last.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  if (!text) return undefined
  return { id: String(last.data.id), text, at: new Date(last.time).toISOString() }
}

/**
 * Records the message as a conversation Trigger and accepts it with a direct Eval, so the Decision, Mandate and audit exist
 * without a model assessment. With `ticketId` it is attached to that ticket instead, for a person's follow-up or status
 * question. A message dispatched before is not accepted again; `duplicate` says so.
 */
export function dispatchConversation(agent: ConversationAgent, host: DispatchHost, input: DispatchInput): DispatchResult {
  const message = latestPersonMessage(agent)
  if (!message) return { refused: 'The latest message is not text the person wrote, so there is no request to dispatch.' }
  if (!input.ticketId && (!input.title || !input.scope)) return { refused: 'A new dispatch needs a title and a scope; only an attach to an existing ticket omits them.' }
  const trigger = conversationTrigger({ messageId: message.id, text: message.text, at: message.at, sessionId: agent.id })
  const received = host.engine.receive(trigger)
  if (received === 'filtered') return { refused: 'The conversation Source is off, so the request was not received.' }
  if (host.disposition(trigger.id)?.decisionId) return { triggerId: trigger.id, duplicate: true }
  if (received === 'duplicate') return { triggerId: trigger.id, duplicate: true }
  try {
    if (input.ticketId) {
      const ticket = host.engine.attach(input.ticketId, trigger.id, input.note)
      return { triggerId: trigger.id, duplicate: false, attached: true, ticket }
    }
    const decision = host.engine.decide(trigger.id, { kind: 'accept', title: input.title!, scope: input.scope!, reason: 'Dispatched from the conversation',
      ...(input.acknowledgement ? { acknowledgement: input.acknowledgement } : {}) })
    return { triggerId: trigger.id, duplicate: false, ...(decision.ticketId ? { ticket: host.ticket(decision.ticketId) } : {}) }
  } catch (error) {
    if (error instanceof UserError) return { refused: error.message }
    throw error
  }
}
