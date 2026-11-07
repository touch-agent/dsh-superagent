/** The Feishu document adapter's conformance fixture: comment replies, scope decisions and Channel sends. */
import type { Commands } from '@superagent/dsh/infra/commands.ts'
import { CliError } from '@superagent/dsh/infra/commands.ts'
import { feishuDocAdapter, feishuDocDefinition, type FeishuDocConfig } from '@superagent/dsh/sources/feishu-doc.ts'
import { docTrigger } from '@superagent/dsh/sources/feishu-doc-trigger.ts'
import { cursorAt } from '@superagent/dsh/sources/poll.ts'
import { testDeployment } from '../fixtures/deployment.ts'
import type { ConformanceSubject, SendHost } from './suite.ts'

const MEMBER = 'ou_alice'
const BOT = 'ou_bot'
const APP = 'cli_bot'
const DOC = 'https://example.feishu.cn/docx/DOC1'
const OTHER = 'https://example.feishu.cn/docx/DOC2'
const LATEST = '2026-11-07T12:00:00.000Z'
const AT = 1794009600
const bot = { botId: BOT, appId: APP, name: 'Widgets Bot' }
const doc = { url: DOC, token: 'DOC1', type: 'docx', title: 'Handbook' }
const card = { commentId: 'c1', rootReplyId: 'r1', quote: 'the margin' }
const text = (value: string) => ({ type: 'text_run', text_run: { text: value } })
const mention = (id: string) => ({ type: 'person', person: { user_id: id } })
const reply = (id: string, user: string, elements: unknown[], at = AT) =>
  ({ reply_id: id, user_id: user, create_time: at, content: { elements } })

const config = feishuDocAdapter.schema.parse({ documents: [
  { url: DOC, name: 'Handbook', listen: 'mentions' },
  { url: OTHER, listen: 'all' },
] })
const closed = feishuDocAdapter.schema.parse({ documents: [] })

/** A `Commands` stub that answers every read and write the Channel makes, recording the arguments it received. */
function host(answer: (args: string[]) => unknown): SendHost {
  const calls: string[] = []
  const commands = { deployment: testDeployment(),
    lark: async (args: string[]) => { calls.push(args.join(' ')); return answer(args) } } as unknown as Commands
  return { commands, calls }
}
const listed = { items: [], has_more: false }
const answer = (args: string[]) => args[0] === 'api' ? {} : args[1] === '+inspect' ? { token: 'DOC1', type: 'docx' } : listed
const address = { document: DOC, commentId: 'c1', token: 'DOC1', fileType: 'docx' }
const outbound = (id: string, channel: Record<string, string> = address) => ({ id, channel: { source: 'feishu-doc', thread: 'feishu-doc:c1', address: channel },
  text: 'The margin is fixed', kind: 'reply' as const })

export function feishuDocConformance(): ConformanceSubject<FeishuDocConfig> {
  return {
    config,
    definition: feishuDocDefinition,
    events: [
      // A comment and its re-read through the reply list name one Trigger.
      { name: 'a reply that mentions the bot', trigger: () => docTrigger(reply('r2', MEMBER, [mention(BOT), text(' please fix the margin')]), card, doc, bot),
        replay: () => docTrigger(reply('r2', MEMBER, [mention(BOT), text(' please fix the margin')]), { commentId: 'c1' }, doc, bot) },
      { name: 'a later reply that does not mention the bot', trigger: () => docTrigger(reply('r3', MEMBER, [text('With the numbers?')]), card, doc, bot) },
      // The bot's own reply is never work.
      { name: 'the bot\'s own reply', ignored: true, trigger: () => docTrigger(reply('r4', BOT, [text('Done')]), card, doc, bot) },
    ],
    scope: [
      { name: 'a listed document that receives mentions only', config, meta: { document: DOC }, expected: { listened: true, observed: false, row: DOC } },
      { name: 'a listed document that receives every comment', config, meta: { document: OTHER }, expected: { listened: true, observed: true, row: OTHER } },
      { name: 'a document removed from the list', config: closed, meta: { document: DOC }, expected: { listened: false, reason: 'document_not_allowed' } },
    ],
    sends: [
      // The reply carries the outbound message ID in its request data, and the invisible mark names it in the text.
      { name: 'a reply on a comment card', message: outbound('reply-1'), outcome: 'sent', host: () => host(answer) },
      // A Trigger received before the comment list named the document token resolves it through `+inspect`.
      { name: 'a reply to a comment whose document token is unknown', message: outbound('reply-2', { document: DOC, commentId: 'c1' }),
        outcome: 'sent', host: () => host(answer) },
      // A deleted document can never take the reply; the Outbox drops the message instead of retrying forever.
      { name: 'a deleted document', message: outbound('reply-3'), outcome: 'gone',
        host: () => host(args => { if (args[0] === 'api') throw new CliError('docs had been deleted', 1069304); return answer(args) }) },
      // Any other failure may succeed later; the Channel must leave it to the Outbox's retry.
      { name: 'a rate-limited reply', message: outbound('reply-4'), outcome: 'throw',
        host: () => host(args => { if (args[0] === 'api') throw new CliError('Rate limited', 99991400); return answer(args) }) },
    ],
    // Comment polling reads from the round's start; `cursorAt` steps it back for late writes.
    cursor: { from: LATEST, next: () => cursorAt(LATEST) },
  }
}