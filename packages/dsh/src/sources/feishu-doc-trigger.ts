/** Normalizes Feishu document comment cards into domain Triggers, and keeps the invisible delivery marker that makes a retried reply idempotent. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger, type ThreadRef } from '@superagent/kernel'

export const SOURCE = 'feishu-doc'
/** One element of a comment or reply; the list API returns every field, so `type` selects the one that carries the content. */
const ElementSchema = z.looseObject({
  type: z.string(),
  text_run: z.looseObject({ text: z.string() }).optional(),
  docs_link: z.looseObject({ url: z.string() }).optional(),
  person: z.looseObject({ user_id: z.string() }).optional(),
})
export type DocElement = z.infer<typeof ElementSchema>
const TimeSchema = z.union([z.number(), z.string()])
/** One reply of a comment card; the first reply is the comment itself and the rest are replies to it. */
export const DocReplySchema = z.looseObject({
  reply_id: z.string().min(1),
  user_id: z.string(),
  create_time: TimeSchema,
  update_time: TimeSchema.optional(),
  content: z.looseObject({ elements: z.array(z.unknown()).default([]) }).optional(),
  extra: z.looseObject({ image_list: z.array(z.string()).optional() }).optional(),
})
export type DocReply = z.infer<typeof DocReplySchema>
/** One comment card: the comment, its replies, and whether more replies exist than the list returned. */
export const DocCommentSchema = z.looseObject({
  comment_id: z.string().min(1),
  user_id: z.string().optional(),
  create_time: TimeSchema.optional(),
  update_time: TimeSchema.optional(),
  is_solved: z.boolean().default(false),
  is_whole: z.boolean().default(false),
  quote: z.string().nullish(),
  has_more: z.boolean().default(false),
  reply_list: z.looseObject({ replies: z.array(z.unknown()).default([]) }).optional(),
})
export type DocComment = z.infer<typeof DocCommentSchema>
/** A document the Source receives comments from, as configured and as resolved for a reply. */
export interface DocTarget { url: string; title?: string; token?: string; type?: string }
/** The bot that reads and answers comments; its own replies are never work. */
export interface DocBot { botId: string; appId: string; name?: string }
/** The comment card a reply belongs to; `rootReplyId` names the first reply, which is the comment itself. */
export interface DocCard { commentId: string; rootReplyId?: string; quote?: string; whole?: boolean }

/** Deterministic Trigger ID for one reply; a comment list, a reply list and a re-read all name the same Trigger. */
export const docTriggerId = (replyId: string): string => key(SOURCE, replyId)
/** One comment card is one Thread; its ID is the comment ID, which Feishu keeps unique across documents. */
export const docThread = (commentId: string): ThreadRef => ({ source: SOURCE, id: commentId })
/** Reply address of a comment card: the document and comment to answer, with the file token the reply API needs when known. */
export const docChannel = (document: string, commentId: string, file: { token?: string; type?: string } = {}): ChannelRef =>
  ({ source: SOURCE, thread: `${SOURCE}:${commentId}`, address: { document, commentId,
    ...file.token ? { token: file.token } : {}, ...file.type ? { fileType: file.type } : {} } })
/**
 * Parses a Feishu comment timestamp into ISO-8601. The comments API returns epoch seconds as a number; a string of digits is
 * seconds too, a longer value is milliseconds, and anything else is read as a date.
 */
export function docTime(value: string | number): string {
  const number = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(number)) throw new Error(`Unreadable Feishu comment time: ${String(value)}`)
  return new Date(number < 1e12 ? number * 1000 : number).toISOString()
}
/** The plain text of reply elements: text runs, document links, and mentions as `@<user>`, with the bot named as the reader knows it. */
export function docElementText(elements: readonly unknown[], bot?: DocBot): string {
  return elements.flatMap(value => {
    const parsed = ElementSchema.safeParse(value)
    if (!parsed.success) return []
    const { type, text_run, docs_link, person } = parsed.data
    if (type === 'text_run') return [text_run?.text ?? '']
    if (type === 'docs_link') return [docs_link?.url ?? '']
    if (type === 'person') {
      const id = person?.user_id ?? ''
      if (!id) return []
      return [id === bot?.botId || id === bot?.appId ? `@${bot.name || 'bot'}` : `@${id}`]
    }
    return []
  }).join('').trim()
}
/** The text of one reply, with an image placeholder when the reply carries images and no text. */
export function docReplyText(reply: DocReply, bot?: DocBot): string {
  const text = docElementText(reply.content?.elements ?? [], bot)
  const images = reply.extra?.image_list?.length ? 1 : 0
  return text || (images ? '[image]' : '')
}
/** True when one of the reply's elements mentions the bot, which makes it an explicit request from an allowed sender. */
export function docAddressed(elements: readonly unknown[], bot: DocBot): boolean {
  return elements.some(value => {
    const parsed = ElementSchema.safeParse(value)
    const id = parsed.success && parsed.data.type === 'person' ? parsed.data.person?.user_id : undefined
    return id === bot.botId || id === bot.appId
  })
}
/** A comment or reply written by the bot is the agent's own write, never work. */
export const docOwnReply = (reply: DocReply, bot: DocBot): boolean => reply.user_id === bot.botId || reply.user_id === bot.appId
/** Converts one reply of a comment card into a Trigger, returning undefined for the bot's own reply. */
export function docTrigger(reply: unknown, card: DocCard, doc: DocTarget, bot: DocBot): Trigger | undefined {
  const parsed = DocReplySchema.parse(reply)
  if (docOwnReply(parsed, bot)) return undefined
  const elements = parsed.content?.elements ?? []
  const text = docReplyText(parsed, bot)
  const root = card.rootReplyId ?? parsed.reply_id
  // The card's quote is the document text the comment itself is about; a reply does not need it twice.
  const quote = parsed.reply_id === root ? card.quote?.trim() : undefined
  // A comment names its author by user_id with no sender type; only this bot is known, so another app is treated as a person.
  // The manifest hint therefore keeps app accounts off the Policy's allowed list.
  return {
    id: docTriggerId(parsed.reply_id), source: SOURCE, threads: [docThread(card.commentId)],
    actor: { source: SOURCE, id: parsed.user_id }, human: true,
    ...(docAddressed(elements, bot) ? { addressed: 'mention' as const } : {}),
    at: docTime(parsed.create_time), text: quote ? `「${quote}」\n${text}` : text,
    channel: docChannel(doc.url, card.commentId, { token: doc.token, type: doc.type }), url: doc.url,
    meta: { document: doc.url, commentId: card.commentId, replyId: parsed.reply_id, rootReplyId: root,
      ...(doc.token ? { token: doc.token } : {}), ...(doc.type ? { fileType: doc.type } : {}),
      ...(card.whole ? { whole: true } : {}) },
  }
}
/** The document and comment a Trigger belongs to, for polls and context reads. */
export interface DocRef { document: string; commentId: string }
export function docRef(trigger: Trigger): DocRef | undefined {
  const meta = trigger.meta as { document?: unknown; commentId?: unknown }
  if (trigger.source !== SOURCE || typeof meta.document !== 'string' || typeof meta.commentId !== 'string') return undefined
  return { document: meta.document, commentId: meta.commentId }
}
/** A Trigger's comment card is the Thread it belongs to. */
export const docThreadRef = (ref: DocRef): ThreadRef => docThread(ref.commentId)
/** A reply answers its comment's first reply; the first reply answers nothing on this Thread. */
export const docRepliesTo = (trigger: Trigger): string | undefined => {
  const meta = trigger.meta as { replyId?: unknown; rootReplyId?: unknown }
  return typeof meta.rootReplyId === 'string' && meta.replyId !== meta.rootReplyId ? docTriggerId(meta.rootReplyId) : undefined
}

/*
 * The comment reply API has no idempotency key, so a sent reply carries an invisible delivery mark naming its outbound
 * message; `feishu-mark.ts` encodes and reads it, and the document Source keeps the `doc*` names for its own readers.
 */
export { deliveryMark as docMarker, deliveryMarkIds as docMarkerIds, stripDeliveryMarks as stripDocMarkers } from './feishu-mark.ts'