/** Feishu outbound channel: posts threaded bot replies and constructs chat deep links. */
import { z } from 'zod'
import type { OutboundMessage } from '@superagent/kernel'
import { CliError, validItems } from '../infra/commands.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, ProbeAnswer, Withdrawal } from './kind.ts'
import { feishuTriggerId } from './feishu-trigger.ts'
import { deliveryMark, deliveryMarkIds } from './feishu-mark.ts'

/** Feishu or Lark AppLink that opens a chat; used when the message's own link was not delivered with the event. */
export const feishuChatLink = (brand: 'feishu' | 'lark', chatId: string): string =>
  `https://applink.${brand === 'lark' ? 'larksuite.com' : 'feishu.cn'}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`
/**
 * True when Feishu permanently rejects a reply because the target message was recalled, withdrawn, or not found.
 * Only a Feishu response carrying one of these error codes means the target message is gone; timeouts or crashes do not.
 */
const gone = (error: unknown): boolean => error instanceof CliError && error.code !== undefined && (error.code === 230011
  || /withdrawn/i.test(error.message) || (Math.floor(error.code / 100) === 2300 && /not found/i.test(error.message)))
/** Replies in the topic of the target message; Feishu keeps at most one reply per idempotency key (the outgoing message's `message.id`). */
export async function sendFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const messageId = message.channel.address.messageId
  if (!messageId) throw new Error('Missing Feishu reply target')
  const text = checkedImText(message.text)
  // The reply API returns no readable idempotency key, so the message carries an invisible mark naming it; a retry reads
  // that mark back instead of trusting its text. Feishu also deduplicates the reply by `--idempotency-key`.
  const reply = ['im', '+messages-reply', '--message-id', messageId, '--markdown', `${text}${deliveryMark(message.id)}`,
    '--reply-in-thread', '--idempotency-key', message.id]
  try { await host.commands.lark(reply) }
  catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
  return 'sent'
}
const ThreadMessageSchema = z.object({ content: z.string().optional(), deleted: z.boolean().optional(),
  sender: z.object({ id: z.string(), sender_type: z.string() }).optional() })
/** Text without delivery marks, so a reply whose mark a client stripped can still be compared. */
const plain = (content: string | undefined): string => readable(content).replaceAll(/[\u200b\u200c\u200d]/g, '').trim()
// A page without `has_more` cannot be known to be complete, so it fails this schema and the probe answers `unknown`.
const ThreadPageSchema = z.object({ messages: z.array(z.unknown()), has_more: z.boolean() })
/** Readable text of a rendered message: the `text` fields of a JSON body, or the body itself when it is not JSON. */
function readable(content: string | undefined): string {
  if (!content) return ''
  try {
    const texts: string[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return }
      if (!value || typeof value !== 'object') return
      for (const [key, item] of Object.entries(value)) {
        if (key === 'text' && typeof item === 'string') texts.push(item)
        else walk(item)
      }
    }
    walk(JSON.parse(content) as unknown)
    return texts.join('\n')
  } catch { return content }
}
/**
 * Looks for this message's delivery mark in the topic's message list. lark-cli resolves a message ID to its thread, so
 * the target message itself names the thread a reply-in-thread wrote to. A page that may hide older replies cannot rule
 * the message out; an unreadable page is `unknown`, never a resend.
 */
export async function probeFeishu(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<ProbeAnswer> {
  const messageId = message.channel.address.messageId
  if (!messageId) return 'unknown'
  try {
    const result = ThreadPageSchema.parse(await host.commands.lark(['im', '+threads-messages-list', '--thread', messageId,
      '--order', 'desc', '--page-size', '50', '--no-reactions']))
    const messages = validItems(ThreadMessageSchema, result.messages)
    const marks = (item: (typeof messages)[number]) => deliveryMarkIds(readable(item.content))
    // The mark names this outbound message, so another app's or an earlier reply's text cannot stand in for it.
    if (messages.some(item => !item.deleted && marks(item).includes(message.id))) return 'sent'
    // Our own unmarked reply with the same text may be this message with its mark stripped: do not call it absent.
    const botId = host.commands.deployment.feishu?.botId
    const text = checkedImText(message.text).trim()
    if (messages.some(item => !item.deleted && marks(item).length === 0 && plain(item.content) === text
      && (!botId || item.sender?.id === botId))) return 'unknown'
    return result.has_more ? 'unknown' : 'gone'
  } catch (error) {
    return gone(error) ? 'gone' : 'unknown'
  }
}
/**
 * Feishu can recall a bot message with `im messages delete`, but lark-cli marks that call a high-risk write that needs a
 * person's explicit confirmation (`--yes`). The Outbox must not pass that flag on its own, so a sent message is refused
 * with the reason instead of being recalled silently; the drill records the refusal.
 */
export async function withdrawFeishu(_host: Pick<SourceContext, 'commands'>, _message: OutboundMessage): Promise<Withdrawal> {
  return { status: 'refused', reason: 'Recalling a Feishu message is a high-risk write that needs a person\'s confirmation' }
}
/** Fallback chat link on the bot's brand; the message's own deep link on its Trigger is preferred when available. */
export const feishuLink = (address: Record<string, string>, links: ChannelLinks): ChannelLink => ({
  url: feishuChatLink(links.feishu?.brand ?? 'feishu', address.chatId ?? ''), label: { zh: '飞书消息', en: 'Feishu message' },
  ...address.messageId ? { triggerId: feishuTriggerId(address.messageId) } : {},
})
