/** The Feishu adapter's conformance fixture: live events, history and topic read paths, scope decisions and Channel sends. */
import type { Commands } from '@superagent/dsh/infra/commands.ts'
import { CliError } from '@superagent/dsh/infra/commands.ts'
import { feishuAdapter, feishuDefinition, type FeishuConfig } from '@superagent/dsh/sources/feishu.ts'
import { feishuTrigger, historyEvent } from '@superagent/dsh/sources/feishu-trigger.ts'
import { cursorAt } from '@superagent/dsh/sources/poll.ts'
import { deliveryMark } from '@superagent/dsh/sources/feishu-mark.ts'
import { testDeployment } from '../fixtures/deployment.ts'
import type { ConformanceSubject, SendHost } from './suite.ts'

const MEMBER = 'ou_alice'
const BOT = 'ou_bot'
const APP = 'cli_bot'
const CHAT = 'oc_team'
const LATEST = '2026-11-07T12:00:00.000Z'

/** One message as the live event consumer prints it, and the same message as the history API returns it. */
const live = { message_id: 'om_2', chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
  content: '@bot please fix the margin', create_time: '1757376000000', mentions: [{ id: BOT }],
  root_id: 'om_1', parent_id: 'om_1', thread_id: 'omt_1', message_app_link: 'https://applink.feishu.cn/client/message/open?message_id=om_2' }
const archived = { message_id: 'om_2', chat_id: CHAT, create_time: '1757376000000',
  sender: { id: MEMBER, sender_type: 'user' }, body: { content: '{"text":"@bot please fix the margin"}' },
  mentions: [{ id: BOT }], root_id: 'om_1', parent_id: 'om_1', thread_id: 'omt_1',
  message_app_link: 'https://applink.feishu.cn/client/message/open?message_id=om_2' }

/** A configuration that receives the listed chat, and one that receives nothing outside the listed chat. */
const config = feishuAdapter.schema.parse({ cli: 'lark',
  chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_all', listen: 'all' }],
  directMessages: true, otherChats: 'mentions' })
const closed = feishuAdapter.schema.parse({ cli: 'lark', chats: [{ chatId: 'oc_team', listen: 'mentions' }],
  directMessages: false, otherChats: 'none' })

/** A fresh `Commands` stub; `calls` keeps the lark-cli arguments so the suite can find the outbound id. */
function host(answer: () => unknown): SendHost {
  const calls: string[] = []
  const deployment = testDeployment()
  const commands = {
    deployment,
    lark: async (args: string[]) => { calls.push(args.join(' ')); return answer() },
  } as unknown as Commands
  return { commands, calls }
}

const reply = { id: 'reply-2', channel: { source: 'feishu', thread: 'feishu:oc_team:om_1',
  address: { chatId: CHAT, messageId: 'om_2' } }, text: 'Fixed in the next release', kind: 'reply' as const }

export function feishuConformance(): ConformanceSubject<FeishuConfig> {
  return {
    config,
    definition: feishuDefinition,
    events: [
      // A live event and a history item are two read paths for one message; both must name the same Trigger.
      { name: 'a live group message', trigger: () => feishuTrigger(live, BOT, APP),
        replay: () => feishuTrigger(historyEvent(archived, CHAT, false), BOT, APP) },
      { name: 'a later reply in the same topic',
        trigger: () => feishuTrigger({ ...live, message_id: 'om_3', parent_id: 'om_2',
          content: 'With the numbers?', mentions: [] }, BOT, APP),
        replay: () => feishuTrigger(historyEvent({ ...archived, message_id: 'om_3', parent_id: 'om_2',
          body: { content: '{"text":"With the numbers?"}' }, mentions: [] }, CHAT, false), BOT, APP) },
      // The bot's own message is never work.
      { name: 'the bot\'s own message', ignored: true, trigger: () => feishuTrigger({ ...live, message_id: 'om_4',
        sender_id: BOT, sender_type: 'bot', mentions: [] }, BOT, APP) },
    ],
    scope: [
      { name: 'a listed chat that receives mentions only', config, meta: { chatId: 'oc_team', direct: false },
        expected: { listened: true, observed: false, row: 'oc_team' } },
      { name: 'a listed chat that receives every message', config, meta: { chatId: 'oc_all', direct: false },
        expected: { listened: true, observed: true, row: 'oc_all' } },
      { name: 'an unlisted chat while other chats mention the bot', config, meta: { chatId: 'oc_other', direct: false },
        expected: { listened: true, observed: false, row: 'other' } },
      { name: 'a direct message while direct messages are received', config, meta: { chatId: 'oc_dm', direct: true },
        expected: { listened: true, observed: false, row: 'direct' } },
      { name: 'an unlisted chat while other chats are closed', config: closed, meta: { chatId: 'oc_other', direct: false },
        expected: { listened: false, reason: 'chat_not_allowed' } },
      { name: 'a direct message while direct messages are off', config: closed, meta: { chatId: 'oc_dm', direct: true },
        expected: { listened: false, reason: 'direct_messages_not_allowed' } },
    ],
    sends: [
      { name: 'a reply in a live topic', message: reply, outcome: 'sent', host: () => host(() => ({})) },
      // A withdrawn message can never receive the reply; the Outbox drops it instead of retrying forever.
      { name: 'a withdrawn message', message: { ...reply, id: 'reply-3' }, outcome: 'gone',
        host: () => host(() => { throw new CliError('The message was withdrawn', 230011) }) },
      // Any other failure may succeed later; the Channel must leave it to the Outbox's retry.
      { name: 'a rate-limited reply', message: { ...reply, id: 'reply-4' }, outcome: 'throw',
        host: () => host(() => { throw new CliError('Rate limited', 99991400) }) },
    ],
    // Chat history is read from the round's start; `cursorAt` steps it back for late writes.
    cursor: { from: LATEST, next: () => cursorAt(LATEST) },
    // A retry looks for this message's invisible delivery mark in the topic; an unreadable topic has no answer to trust.
    probes: [
      { name: 'a reply already in the topic', key: 'reply-2', answer: 'sent' },
      // A rich-text reply carries its text in a JSON body, which the probe reads as written.
      { name: 'a reply whose content is a JSON body', key: 'reply-6', answer: 'sent' },
      { name: 'a reply not in the topic', key: 'reply-9', answer: 'gone' },
      // Text alone is not evidence: another message's mark, or the same text without one, cannot settle this message.
      { name: 'the same text under another message mark', key: 'reply-5', answer: 'gone' },
      { name: 'the same text from an older unmarked reply', key: 'reply-7', answer: 'gone' },
      // A page that may hide older replies cannot rule the message out, and neither can a page without `has_more`.
      { name: 'a topic with older replies not read', key: 'reply-8', answer: 'unknown' },
      { name: 'a topic page without has_more', key: 'reply-10', answer: 'unknown' },
      { name: 'a topic it cannot read', key: 'reply-4', answer: 'unknown' },
    ],
    probe: key => {
      const page = key === 'reply-2'
        ? () => ({ messages: [{ content: `${deliveryMark('reply-2')}${reply.text}`, msg_type: 'text' }], has_more: false })
        : key === 'reply-6'
          ? () => ({ messages: [{ content: JSON.stringify({ text: `${deliveryMark('reply-6')}${reply.text}` }), msg_type: 'post' }], has_more: false })
          : key === 'reply-5'
          ? () => ({ messages: [{ content: `${deliveryMark('reply-5-other')}${reply.text}`, msg_type: 'text' }], has_more: false })
          : key === 'reply-7'
          ? () => ({ messages: [{ content: reply.text, msg_type: 'text' }], has_more: false })
          : key === 'reply-8' ? () => ({ messages: [], has_more: true })
          : key === 'reply-10' ? () => ({ messages: [] })
          : key === 'reply-4' ? () => { throw new CliError('Rate limited', 99991400) } : () => ({ messages: [], has_more: false })
      return feishuDefinition.adapter.channel!.probe!({ commands: host(page).commands }, { ...reply, id: key })
    },
  }
}