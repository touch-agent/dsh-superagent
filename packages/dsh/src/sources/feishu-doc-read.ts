/** Reads Feishu document comment cards and their replies, and serves a comment card as the Thread context of an assessment. */
import { z } from 'zod'
import type { Trigger } from '@superagent/kernel'
import { validItems, type Commands, type Tally } from '../infra/commands.ts'
import { docRef, docReplyText, docTime, docTriggerId, DocCommentSchema, DocReplySchema, stripDocMarkers, type DocBot, type DocComment,
  type DocReply } from './feishu-doc-trigger.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from './kind.ts'
import type { FeishuDocConfig } from './feishu-doc.ts'

/** Comment cards read per document before the source stops paging and reports that it fell behind. */
export const MAX_COMMENT_PAGES = 20
/** Replies read per comment card before the source stops paging and reports that it fell behind. */
export const MAX_REPLY_PAGES = 10
const PAGE_SIZE = 100
const CONTEXT_PAGE_SIZE = 50

const CommentsSchema = z.looseObject({
  file_token: z.string().optional(), file_type: z.string().optional(),
  items: z.array(z.unknown()).default([]), has_more: z.boolean().default(false), page_token: z.string().optional(),
})
const RepliesSchema = z.looseObject({
  file_token: z.string().optional(), file_type: z.string().optional(),
  items: z.array(z.unknown()).default([]), has_more: z.boolean().default(false), page_token: z.string().optional(),
})
export interface DocCardView { comment: DocComment; replies: DocReply[] }
export interface CommentPage { token?: string; type?: string; cards: DocCardView[]; truncated: boolean; next?: string }
export interface ReplyPage { token?: string; type?: string; replies: DocReply[]; truncated: boolean; next?: string }
interface CommentPageView { token?: string; type?: string; cards: DocCardView[]; has_more: boolean; next?: string }
interface ReplyPageView { token?: string; type?: string; replies: DocReply[]; has_more: boolean; next?: string }

const bot = (commands: Commands): DocBot => commands.deployment.feishu
  ? { botId: commands.deployment.feishu.botId, appId: commands.deployment.feishu.appId, name: commands.deployment.feishu.name }
  : { botId: '', appId: '' }

/**
 * Lists the unresolved, partial comments of one document. Whole-document comments are left out because Feishu accepts no
 * reply on them, so the Source could not answer a Ticket made from one.
 */
async function commentPage(commands: Commands, document: string, cursor: string | undefined, tally: Tally): Promise<CommentPageView> {
  const result = CommentsSchema.parse(await commands.lark(['drive', '+list-comments', '--url', document, '--comment-scope', 'partial',
    '--solved-status', 'false', '--page-size', String(PAGE_SIZE), ...cursor ? ['--page-token', cursor] : []]))
  const cards: DocCardView[] = []
  for (const comment of validItems(DocCommentSchema, result.items, tally)) {
    if (comment.is_whole) continue
    cards.push({ comment, replies: validItems(DocReplySchema, comment.reply_list?.replies ?? [], tally) })
  }
  return { token: result.file_token, type: result.file_type, cards, has_more: result.has_more,
    next: result.has_more && result.page_token ? result.page_token : undefined }
}
/** Reads the newest page of comments, for catching comments posted while an older page backlog is being read. */
export async function readCommentPage(commands: Commands, document: string,
  tally: Tally = { skipped: 0 }): Promise<Pick<CommentPage, 'token' | 'type' | 'cards' | 'next'>> {
  const page = await commentPage(commands, document, undefined, tally)
  return { token: page.token, type: page.type, cards: page.cards, next: page.next }
}
export async function readComments(commands: Commands, document: string, tally: Tally = { skipped: 0 },
  cursor?: string): Promise<CommentPage> {
  let page = cursor
  let token: string | undefined
  let type: string | undefined
  const cards: DocCardView[] = []
  const seenPages = new Set<string>()
  for (let count = 0; ; count += 1) {
    const result = await commentPage(commands, document, page, tally)
    token ??= result.token
    type ??= result.type
    cards.push(...result.cards)
    if (!result.has_more) return { ...token ? { token } : {}, ...type ? { type } : {}, cards, truncated: false }
    if (!result.next || seenPages.has(result.next)) throw new Error('Feishu comment pagination did not advance')
    if (count + 1 >= MAX_COMMENT_PAGES) return { ...token ? { token } : {}, ...type ? { type } : {}, cards, truncated: true, next: result.next }
    page = result.next
    seenPages.add(result.next)
  }
}

async function replyPage(commands: Commands, document: string, commentId: string, cursor: string | undefined, pageSize: number,
  tally: Tally): Promise<ReplyPageView> {
  const result = RepliesSchema.parse(await commands.lark(['drive', '+list-replies', '--url', document, '--comment-id', commentId,
    '--page-size', String(pageSize), ...cursor ? ['--page-token', cursor] : []]))
  return { token: result.file_token, type: result.file_type, replies: validItems(DocReplySchema, result.items, tally),
    has_more: result.has_more, next: result.has_more && result.page_token ? result.page_token : undefined }
}
/** Lists every reply of one comment card, in the order Feishu returns them. */
export async function readReplies(commands: Commands, document: string, commentId: string, tally: Tally = { skipped: 0 },
  cursor?: string): Promise<ReplyPage> {
  let page = cursor
  let token: string | undefined
  let type: string | undefined
  const replies: DocReply[] = []
  const seenPages = new Set<string>()
  for (let count = 0; ; count += 1) {
    const result = await replyPage(commands, document, commentId, page, PAGE_SIZE, tally)
    token ??= result.token
    type ??= result.type
    replies.push(...result.replies)
    if (!result.has_more) return { ...token ? { token } : {}, ...type ? { type } : {}, replies, truncated: false }
    if (!result.next || seenPages.has(result.next)) throw new Error('Feishu comment reply pagination did not advance')
    if (count + 1 >= MAX_REPLY_PAGES) return { ...token ? { token } : {}, ...type ? { type } : {}, replies, truncated: true, next: result.next }
    page = result.next
    seenPages.add(result.next)
  }
}

const contextMessage = (reply: DocReply, reader: DocBot): ContextMessage => ({
  id: docTriggerId(reply.reply_id), from: reply.user_id, at: docTime(reply.create_time), text: stripDocMarkers(docReplyText(reply, reader)),
  ...reply.user_id === reader.botId || reply.user_id === reader.appId ? { bot: true as const } : {},
})

/**
 * The Thread of a document comment is its comment card. Feishu comment replies are flat: the first reply is the comment itself
 * and every other reply answers that root, so a non-root Trigger's parent is the first reply, not the reply listed before it.
 */
export const feishuDocThreadContext: ThreadContext<FeishuDocConfig> = {
  messageId: trigger => docTriggerId(String((trigger.meta as { replyId?: unknown }).replyId ?? '')),
  async read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined): Promise<ContextPart> {
    const ref = docRef(trigger)
    if (!ref) throw new Error('The Trigger names no Feishu document comment')
    const reader = bot(commands)
    const tally: Tally = { skipped: 0 }
    if (part === 'root') {
      const page = await replyPage(commands, ref.document, ref.commentId, undefined, PAGE_SIZE, tally)
      const root = page.replies[0]
      const messages = root ? [contextMessage(root, reader)] : []
      return { messages, body: { status: messages.length ? 'root' : 'empty', document: ref.document, commentId: ref.commentId, messages } }
    }
    if (part === 'parent') {
      const page = await replyPage(commands, ref.document, ref.commentId, undefined, PAGE_SIZE, tally)
      const root = page.replies[0]
      const messages = root && docTriggerId(root.reply_id) !== feishuDocThreadContext.messageId(trigger) ? [contextMessage(root, reader)] : []
      return { messages, body: { status: messages.length ? 'parent' : 'no_parent', document: ref.document, commentId: ref.commentId, messages } }
    }
    const page = await replyPage(commands, ref.document, ref.commentId, cursor, CONTEXT_PAGE_SIZE, tally)
    const messages = page.replies.map(reply => contextMessage(reply, reader))
    const next = page.next
    return { messages, ...next ? { next } : {}, status: messages.length ? undefined : 'empty',
      body: { status: messages.length ? 'thread' : 'empty', document: ref.document, commentId: ref.commentId, messages, has_more: page.has_more, page_token: page.next } }
  },
}
