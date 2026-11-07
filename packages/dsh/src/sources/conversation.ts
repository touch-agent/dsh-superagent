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
  health: ['conversation'],
}

const ConfigSchema = z.object({}).strict()
export type ConversationConfig = z.infer<typeof ConfigSchema>

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
}

/**
 * Converts a dispatched conversation message into a Trigger. The trigger id is the message id, so dispatching
 * the same message twice produces the same Trigger; the thread id is the task root.
 */
export function conversationTrigger(request: ConversationRequest): Trigger {
  const root = request.root ?? request.messageId
  return { id: key(SOURCE, request.messageId), source: SOURCE, threads: [{ source: SOURCE, id: root }],
    actor: { source: SOURCE, id: LOCAL_USER }, human: true, addressed: 'direct', at: isoTime(request.at), text: request.text,
    channel: { source: SOURCE, thread: `${SOURCE}:${root}`, address: { session: request.sessionId, root, messageId: request.messageId } },
    meta: { sessionId: request.sessionId, messageId: request.messageId, root, ...(request.parentId ? { parentId: request.parentId } : {}) } }
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
