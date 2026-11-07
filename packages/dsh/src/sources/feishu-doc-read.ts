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
export interface CommentPage { token?: string; type?: string; cards: DocCardView[]; truncated: boolean }
export interface ReplyPage { token?: string; type?: string; replies: DocReply[]; truncated: boolean }

const bot = (commands: Commands): DocBot => commands.deployment.feishu
  ? { botId: commands.deployment.feishu.botId, appId: commands.deployment.feishu.appId, name: commands.deployment.feishu.name }
  : { botId: '', appId: '' }

/**
 * Lists the unresolved, partial comments of one document. Whole-document comments are left out because Feishu accepts no
 * reply on them, so the Source could not answer a Ticket made from one.
 */
export async function readComments(commands: Commands, document: string, tally: Tally = { skipped: 0 }): Promise<CommentPage> {
  let page: string | undefined
  let token: string | undefined
  let type: string | undefined
  const cards: DocCardView[] = []
  const pages = new Set<string>()
  for (let count = 0; ; count += 1) {
    if (count >= MAX_COMMENT_PAGES) return { ...token ? { token } : {}, ...type ? { type } : {}, cards, truncated: true }
    const result = CommentsSchema.parse(await commands.lark(['drive', '+list-comments', '--url', document, '--comment-scope', 'partial',
      '--solved-status', 'false', '--page-size', String(PAGE_SIZE), ...page ? ['--page-token', page] : []]))
    token ??= result.file_token
    type ??= result.file_type
    for (const comment of validItems(DocCommentSchema, result.items, tally)) {
      if (comment.is_whole) continue
      cards.push({ comment, replies: validItems(DocReplySchema, comment.reply_list?.replies ?? [], tally) })
    }
    if (!result.has_more) break
    if (!result.page_token || pages.has(result.page_token)) throw new Error('Feishu comment pagination did not advance')
    page = result.page_token
    pages.add(page)
  }
  return { ...token ? { token } : {}, ...type ? { type } : {}, cards, truncated: false }
}

/** Lists every reply of one comment card, in the order Feishu returns them. */
export async function readReplies(commands: Commands, document: string, commentId: string,
  tally: Tally = { skipped: 0 }): Promise<ReplyPage> {
  let page: string | undefined
  let token: string | undefined
  let type: string | undefined
  const replies: DocReply[] = []
  const pages = new Set<string>()
  for (let count = 0; ; count += 1) {
    if (count >= MAX_REPLY_PAGES) return { ...token ? { token } : {}, ...type ? { type } : {}, replies, truncated: true }
    const result = RepliesSchema.parse(await commands.lark(['drive', '+list-replies', '--url', document, '--comment-id', commentId,
      '--page-size', String(PAGE_SIZE), ...page ? ['--page-token', page] : []]))
    token ??= result.file_token
    type ??= result.file_type
    replies.push(...validItems(DocReplySchema, result.items, tally))
    if (!result.has_more) return { ...token ? { token } : {}, ...type ? { type } : {}, replies, truncated: false }
    if (!result.page_token || pages.has(result.page_token)) throw new Error('Feishu comment reply pagination did not advance')
    page = result.page_token
    pages.add(page)
  }
}

/** One page of a comment card's replies, used as the Thread page of an assessment. */
async function replyPage(commands: Commands, document: string, commentId: string, cursor?: string, pageSize = CONTEXT_PAGE_SIZE) {
  return RepliesSchema.parse(await commands.lark(['drive', '+list-replies', '--url', document, '--comment-id', commentId,
    '--page-size', String(pageSize), ...cursor ? ['--page-token', cursor] : []]))
}
const contextMessage = (reply: DocReply, reader: DocBot): ContextMessage => ({
  id: docTriggerId(reply.reply_id), from: reply.user_id, at: docTime(reply.create_time), text: stripDocMarkers(docReplyText(reply, reader)),
  ...reply.user_id === reader.botId || reply.user_id === reader.appId ? { bot: true as const } : {},
})

/**
 * The Thread of a document comment is its comment card; assessments read the card's replies around the Trigger. Feishu lists the
 * first reply (the comment itself) first; a parent is the reply before the Trigger's in that order.
 */
export const feishuDocThreadContext: ThreadContext<FeishuDocConfig> = {
  messageId: trigger => docTriggerId(String((trigger.meta as { replyId?: unknown }).replyId ?? '')),
  async read(commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined): Promise<ContextPart> {
    const ref = docRef(trigger)
    if (!ref) throw new Error('The Trigger names no Feishu document comment')
    const reader = bot(commands)
    if (part === 'root') {
      const page = await replyPage(commands, ref.document, ref.commentId)
      const root = page.items.map(item => DocReplySchema.safeParse(item)).find(parsed => parsed.success)?.data
      const messages = root ? [contextMessage(root, reader)] : []
      return { messages, body: { status: messages.length ? 'root' : 'empty', document: ref.document, commentId: ref.commentId, messages } }
    }
    if (part === 'parent') {
      const page = await replyPage(commands, ref.document, ref.commentId, undefined, PAGE_SIZE)
      const all = page.items.flatMap(item => { const parsed = DocReplySchema.safeParse(item); return parsed.success ? [parsed.data] : [] })
      const index = all.findIndex(reply => docTriggerId(reply.reply_id) === feishuDocThreadContext.messageId(trigger))
      const parent = index > 0 ? all[index - 1] : undefined
      const messages = parent ? [contextMessage(parent, reader)] : []
      return { messages, body: { status: messages.length ? 'parent' : 'no_parent', document: ref.document, commentId: ref.commentId, messages } }
    }
    const page = await replyPage(commands, ref.document, ref.commentId, cursor)
    const messages = page.items.flatMap(item => { const parsed = DocReplySchema.safeParse(item); return parsed.success ? [contextMessage(parsed.data, reader)] : [] })
    const next = page.has_more && page.page_token ? page.page_token : undefined
    return { messages, ...next ? { next } : {}, status: messages.length ? undefined : 'empty',
      body: { status: messages.length ? 'thread' : 'empty', document: ref.document, commentId: ref.commentId, messages, has_more: page.has_more, page_token: page.page_token } }
  },
}