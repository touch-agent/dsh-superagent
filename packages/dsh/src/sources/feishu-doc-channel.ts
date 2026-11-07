/** Replies on a Feishu document comment card, with an invisible delivery mark so a retried reply is not posted twice. */
import { z } from 'zod'
import type { OutboundMessage } from '@superagent/kernel'
import { CliError } from '../infra/commands.ts'
import { docMarker, docMarkerIds, docReplyText } from './feishu-doc-trigger.ts'
import { readReplies } from './feishu-doc-read.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'

/** Document types the reply API accepts; `+inspect` reports a bitable as `bitable` and a wiki as its underlying type. */
const FILE_TYPES = new Set(['doc', 'docx', 'sheet', 'slides', 'bitable', 'base', 'file', 'apps'])
/** A deleted document (1069304/1069305/1069307), a solved comment and a whole-document comment can never receive the reply. */
const GONE_CODES = new Set([1069304, 1069305, 1069307])
const gone = (error: unknown): boolean => error instanceof CliError
  && (GONE_CODES.has(error.code ?? -1) || /solved|解决|whole|全文评论/i.test(error.message))
const InspectedSchema = z.looseObject({ token: z.string().min(1), type: z.string() })
/** Resolves the canonical token and type of a document whose Trigger was received before the comment list named them. */
async function inspect(host: Pick<SourceContext, 'commands'>, document: string): Promise<{ token: string; type: string }> {
  const inspected = InspectedSchema.parse(await host.commands.lark(['drive', '+inspect', '--url', document]))
  if (!FILE_TYPES.has(inspected.type)) throw new Error(`Feishu document ${document} is a ${inspected.type}, which has no comments`)
  return { token: inspected.token, type: inspected.type === 'base' ? 'bitable' : inspected.type }
}
/**
 * Posts one reply on a comment card.
 * Feishu has no idempotency key for comment replies, so the reply text starts with an invisible mark naming the outbound
 * message; a retried send reads the card's replies first and answers `sent` when the mark is already there. The same ID also
 * travels in the request's write-only `extra` field, so the remote call names the message; the reply list returns an object
 * there, not this string, so only the mark can be read back.
 */
export async function sendFeishuDoc(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { document, commentId, token, fileType } = message.channel.address
  if (!document || !commentId) throw new Error('The reply names no Feishu document comment')
  if ([...message.text].length > 10_000) throw new Error('A Feishu comment reply cannot exceed 10000 characters')
  try {
    const posted = await readReplies(host.commands, document, commentId)
    if (posted.replies.some(reply => docMarkerIds(docReplyText(reply)).includes(message.id))) return 'sent'
    // The reply may be past the page cap; posting then could not be checked, so leave it retryable instead of guessing.
    if (posted.truncated) throw new Error('The comment card has more replies than the pre-send read covers')
  } catch (error) {
    // A deleted comment can never take the reply. Any other read failure stays retryable, so a reply is never posted twice.
    if (gone(error)) return 'gone'
    throw error
  }
  const file = token && fileType ? { token, type: fileType } : await inspect(host, document)
  const body = JSON.stringify({ content: { elements: [{ type: 'text_run', text_run: { text: `${docMarker(message.id)}${message.text}` } }] },
    extra: message.id })
  const request = ['api', 'POST', `/open-apis/drive/v1/files/${encodeURIComponent(file.token)}/comments/${encodeURIComponent(commentId)}/replies`,
    '--params', JSON.stringify({ file_type: file.type }), '--data', body]
  try { await host.commands.lark(request) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
/** The link of a reply is the commented document; Feishu has no page link for one comment card. */
export const feishuDocLink = (address: Record<string, string>): ChannelLink =>
  ({ url: address.document ?? '', label: { zh: '飞书文档评论', en: 'Feishu document comment' } })
