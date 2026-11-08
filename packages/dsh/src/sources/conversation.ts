/** Built-in Source for work dispatched directly in the main conversation; its Threads are task threads. */
import { z } from 'zod'
import { isoTime, key, type SourceManifest, type Trigger } from '@superagent/kernel'
import type { SourceAdapter, SourceDefinition } from './kind.ts'

export const SOURCE = 'conversation'
/** The authenticated local user; there is no roster, so every conversation Trigger names this actor. */
export const LOCAL_USER = 'local-user'

export const conversationManifest: SourceManifest = {
  id: SOURCE,
  title: { zh: '会话', en: 'Conversation' },
  description: { zh: '在主会话里直接交代的任务。', en: 'Work dispatched directly in the main conversation.' },
  auth: { kind: 'none', fields: [] },
  fields: [],
  // No probe: the main Session itself is the Source's only dependency, and it reports its own state.
  health: [],
}

const ConfigSchema = z.object({}).strict()
export type ConversationConfig = z.infer<typeof ConfigSchema>

/** One item a split message became, as `dispatchConversation` names it: a stable key, its position and the item count. */
export interface ConversationIntent { key: string; index: number; count: number }
/** One message a person dispatched; `root` names the task thread, which is the request itself on a new task. */
export interface ConversationRequest {
  messageId: string
  text: string
  at: string
  sessionId: string
  /** The task root when this message replies in an existing task thread; absent on the request that starts one. */
  root?: string
  /** The message this one answers within its thread, when known. */
  parentId?: string
  /** The item of a split message this Trigger carries; absent when the message produced one Trigger. */
  intent?: ConversationIntent
}

/**
 * Converts a dispatched conversation message into a Trigger. On an unsplit message the trigger id is the message id, so
 * dispatching the same message twice produces the same Trigger; a split item adds its own stable key, while `meta`
 * keeps the source message id for every item. The thread id is the task root.
 */
export function conversationTrigger(request: ConversationRequest): Trigger {
  const root = request.root ?? request.messageId
  const intent = request.intent
  return { id: intent ? key(SOURCE, request.messageId, 'intent', intent.key) : key(SOURCE, request.messageId), source: SOURCE,
    threads: [{ source: SOURCE, id: root }], actor: { source: SOURCE, id: LOCAL_USER }, human: true, addressed: 'direct', at: isoTime(request.at),
    text: request.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${root}`, address: { session: request.sessionId, root, messageId: request.messageId } },
    meta: { sessionId: request.sessionId, messageId: request.messageId, sourceMessageId: request.messageId, root,
      ...(intent ? { intent: { key: intent.key, index: intent.index, count: intent.count } } : {}), ...(request.parentId ? { parentId: request.parentId } : {}) } }
}

export const conversationAdapter: SourceAdapter<ConversationConfig> = {
  schema: ConfigSchema,
  trusted: true,
  scope: () => ({ listened: true, observed: true }),
  repliesTo: trigger => trigger.source === SOURCE && typeof trigger.meta.parentId === 'string' ? key(SOURCE, trigger.meta.parentId) : undefined,
  channel: {
    send: async (host, message) => { await host.conversation.deliver(message.id, message.text); return 'sent' },
    link: () => ({ url: '', label: { zh: '会话', en: 'Conversation' } }),
  },
}

export const conversationDefinition: SourceDefinition<ConversationConfig> = { manifest: conversationManifest, adapter: conversationAdapter }
