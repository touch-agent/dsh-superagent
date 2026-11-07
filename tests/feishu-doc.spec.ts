/** The Feishu document Source's own behavior: comment text and times, Trigger ids, reads, context and the idempotent reply. */
import { describe, expect, it, vi } from 'vitest'
import type { Commands } from '@superagent/dsh/infra/commands.ts'
import { CliError } from '@superagent/dsh/infra/commands.ts'
import type { SourceContext } from '@superagent/dsh/sources/host.ts'
import { KV } from '@superagent/dsh/kv.ts'
import { feishuDocAdapter } from '@superagent/dsh/sources/feishu-doc.ts'
import { sendFeishuDoc } from '@superagent/dsh/sources/feishu-doc-channel.ts'
import { feishuDocThreadContext, readComments, readReplies } from '@superagent/dsh/sources/feishu-doc-read.ts'
import { docAddressed, docElementText, docMarker, docMarkerIds, docRepliesTo, docReplyText, docTime, docTrigger, docTriggerId, stripDocMarkers,
  type DocBot } from '@superagent/dsh/sources/feishu-doc-trigger.ts'
import { refreshDocLabels } from '@superagent/dsh/sources/feishu-doc-loops.ts'
import { testDeployment } from './fixtures/deployment.ts'

const MEMBER = 'ou_alice'
const BOT: DocBot = { botId: 'ou_bot', appId: 'cli_bot', name: 'Widgets Bot' }
const DOC = 'https://example.feishu.cn/docx/DOC1'
const AT = 1794009600
const text = (value: string) => ({ type: 'text_run', text_run: { text: value } })
const mention = (id: string) => ({ type: 'person', person: { user_id: id } })
const reply = (id: string, user: string, elements: unknown[], at = AT) =>
  ({ reply_id: id, user_id: user, create_time: at, content: { elements } })
const card = { commentId: 'c1', rootReplyId: 'r1', quote: 'the margin' }
const document = { url: DOC, token: 'DOC1', type: 'docx', title: 'Handbook' }
const noDocuments = feishuDocAdapter.schema.parse({})
/** A `Commands` stub whose `lark` answers by call order and records every argument list. */
function stub(answers: unknown[]): { commands: Commands; calls: string[][] } {
  const calls: string[][] = []
  const commands = { deployment: testDeployment(), withSignal: () => commands, lark: vi.fn(async (args: string[]) => {
    calls.push(args)
    const answer = answers.shift()
    if (answer instanceof Error) throw answer
    return typeof answer === 'function' ? (answer as (args: string[]) => unknown)(args) : answer ?? {}
  }) } as unknown as Commands
  return { commands, calls }
}

it('reads seconds, millisecond values and ISO strings as comment times, and refuses an unreadable one', () => {
  expect(docTime(AT)).toBe('2026-11-07T00:00:00.000Z')
  expect(docTime(String(AT))).toBe('2026-11-07T00:00:00.000Z')
  expect(docTime('2026-11-07T00:00:00Z')).toBe('2026-11-07T00:00:00.000Z')
  expect(docTime(AT * 1000)).toBe('2026-11-07T00:00:00.000Z')
  expect(() => docTime('not a time')).toThrow('Unreadable Feishu comment time')
})

it('flattens reply elements into the text a person sees, names the bot, and drops the invisible delivery mark', () => {
  expect(docElementText([text(' please '), { type: 'docs_link', docs_link: { url: 'https://example.feishu.cn/docx/D' } }, mention(BOT.botId), mention(MEMBER)], BOT))
    .toBe('please https://example.feishu.cn/docx/D@Widgets Bot@ou_alice')
  expect(docAddressed([text('hi'), mention(BOT.botId)], BOT)).toBe(true)
  expect(docAddressed([text('hi'), mention(MEMBER)], BOT)).toBe(false)
  const marked = `${docMarker('reply-1')}hello`
  expect([...docMarker('reply-1')].every(char => '\u200b\u200c\u200d'.includes(char))).toBe(true)
  expect(docMarkerIds(marked)).toEqual(['reply-1'])
  expect(stripDocMarkers(marked)).toBe('hello')
  expect(docMarkerIds('plain text with \u200d no pair')).toEqual([])
  expect(docReplyText({ reply_id: 'r1', user_id: MEMBER, create_time: AT, extra: 'opaque' })).toBe('')
  expect(docReplyText({ reply_id: 'r1', user_id: MEMBER, create_time: AT, extra: { image_list: ['k'] } })).toBe('[image]')
})

it('derives one Trigger per reply: its card is the Thread, a mention is explicit, and the bot\'s own reply is never work', () => {
  const trigger = docTrigger(reply('r2', MEMBER, [mention(BOT.botId), text(' please fix the margin')]), card, document, BOT)!
  expect(trigger).toMatchObject({ id: docTriggerId('r2'), source: 'feishu-doc', threads: [{ source: 'feishu-doc', id: 'c1' }],
    actor: { source: 'feishu-doc', id: MEMBER }, human: true, addressed: 'mention', at: '2026-11-07T00:00:00.000Z', url: DOC,
    text: '@Widgets Bot please fix the margin' })
  expect(trigger.channel).toEqual({ source: 'feishu-doc', thread: 'feishu-doc:c1',
    address: { document: DOC, commentId: 'c1', token: 'DOC1', fileType: 'docx' } })
  expect(docRepliesTo(trigger)).toBe(docTriggerId('r1'))
  const root = docTrigger(reply('r1', MEMBER, [text('the margin is wrong')]), { ...card, rootReplyId: 'r1' }, document, BOT)!
  expect(root.text).toBe('「the margin」\nthe margin is wrong')
  expect(docRepliesTo(root)).toBeUndefined()
  const later = docTrigger(reply('r3', MEMBER, [text('With numbers?')]), card, document, BOT)!
  expect(later.addressed).toBeUndefined()
  expect(later.text).toBe('With numbers?')
  expect(docTrigger(reply('r4', BOT.botId, [text('Done')]), card, document, BOT)).toBeUndefined()
  expect(docTrigger(reply('r5', BOT.appId, [text('Done')]), card, document, BOT)).toBeUndefined()
})

it('lists unresolved comments, leaves out whole-document comments and pages through the comment list', async () => {
  const whole = { comment_id: 'c0', is_whole: true, reply_list: { replies: [reply('r0', MEMBER, [text('whole')])] } }
  const first = { comment_id: 'c1', is_solved: false, is_whole: false, has_more: false, reply_list: { replies: [reply('r1', MEMBER, [text('one')])] } }
  const partial = { comment_id: 'c2', has_more: true, reply_list: { replies: [reply('r9', MEMBER, [text('partial')])] } }
  const { commands, calls } = stub([{ file_token: 'DOC1', file_type: 'docx', items: [whole, first, partial], has_more: true, page_token: 'p2' },
    { file_token: 'DOC1', file_type: 'docx', items: [{ ...first, comment_id: 'c3' }], has_more: false }])
  const page = await readComments(commands, DOC)
  expect(page.token).toBe('DOC1')
  expect(page.type).toBe('docx')
  expect(page.truncated).toBe(false)
  expect(page.cards.map(item => item.comment.comment_id)).toEqual(['c1', 'c2', 'c3'])
  expect(page.cards[0]!.replies.map(item => item.reply_id)).toEqual(['r1'])
  expect(calls[1]).toEqual(expect.arrayContaining(['--page-token', 'p2']))
  expect(calls[0]).toEqual(expect.arrayContaining(['--comment-scope', 'partial', '--solved-status', 'false']))
})

it('lists every reply of a comment across pages', async () => {
  const { commands, calls } = stub([{ items: [reply('r1', MEMBER, [text('root')])], has_more: true, page_token: 'p2' },
    { items: [reply('r2', MEMBER, [text('second')])], has_more: false }])
  const page = await readReplies(commands, DOC, 'c1')
  expect(page.replies.map(item => item.reply_id)).toEqual(['r1', 'r2'])
  expect(page.truncated).toBe(false)
  expect(calls[1]).toEqual(expect.arrayContaining(['--comment-id', 'c1', '--page-token', 'p2']))
})

it('reads the comment itself, the card around the Trigger, and the reply before it as Thread context', async () => {
  const trigger = docTrigger(reply('r2', MEMBER, [text('second')]), card, document, BOT)!
  const answers = { items: [reply('r1', MEMBER, [text('root')]), reply('r2', MEMBER, [text('second')]), reply('r3', BOT.botId, [text('answered')])],
    has_more: false }
  const root = await feishuDocThreadContext.read(stub([answers]).commands, trigger, 'root', undefined, noDocuments)
  expect(root.messages.map(item => item.id)).toEqual([docTriggerId('r1')])
  expect(root.body).toMatchObject({ document: DOC, commentId: 'c1' })
  const parentTrigger = docTrigger(reply('r3', MEMBER, [text('again')]), card, document, BOT)!
  const parent = await feishuDocThreadContext.read(stub([answers]).commands, parentTrigger, 'parent', undefined, noDocuments)
  expect(parent.messages.map(item => item.id)).toEqual([docTriggerId('r2')])
  const page = await feishuDocThreadContext.read(stub([{ ...answers, has_more: true, page_token: 'p2' }]).commands, trigger, 'thread', undefined, noDocuments)
  expect(page.messages.map(item => item.from)).toEqual([MEMBER, MEMBER, BOT.botId])
  expect(page.messages[2]!.bot).toBe(true)
  expect(page.next).toBe('p2')
  const next = await feishuDocThreadContext.read(stub([{ items: [reply('r4', MEMBER, [text('new')])], has_more: false }]).commands, trigger, 'thread', 'p2', noDocuments)
  expect(next.messages.map(item => item.id)).toEqual([docTriggerId('r4')])
  expect(next.next).toBeUndefined()
})

describe('replying on a comment card', () => {
  const message = (id: string, extra: Record<string, string> = { token: 'DOC1', fileType: 'docx' }) =>
    ({ id, channel: { source: 'feishu-doc', thread: 'feishu-doc:c1', address: { document: DOC, commentId: 'c1', ...extra } },
      text: 'Fixed', kind: 'reply' as const })
  it('posts once, names the outbound message in the request, and recognises its own earlier reply', async () => {
    const { commands, calls } = stub([{ items: [], has_more: false }, {}])
    expect(await sendFeishuDoc({ commands }, message('reply-1'))).toBe('sent')
    expect(calls[1]).toEqual(expect.arrayContaining(['api', 'POST', '/open-apis/drive/v1/files/DOC1/comments/c1/replies', '--params', '{"file_type":"docx"}']))
    const data = calls[1]![calls[1]!.indexOf('--data') + 1]!
    expect(JSON.parse(data).extra).toBe('reply-1')
    expect(docMarkerIds(JSON.parse(data).content.elements[0].text_run.text)).toEqual(['reply-1'])
    const posted = { items: [reply('r1', BOT.botId, [text(`${docMarker('reply-1')}Fixed`)])], has_more: false }
    const again = stub([posted])
    expect(await sendFeishuDoc({ commands: again.commands }, message('reply-1'))).toBe('sent')
    expect(again.calls).toHaveLength(1)
    // A reply list may return `extra` as a string; the outbound ID there also proves the reply was posted.
    const extra = { items: [{ ...reply('r2', BOT.botId, [text('Fixed')]), extra: 'reply-1' }], has_more: false }
    const third = stub([extra])
    expect(await sendFeishuDoc({ commands: third.commands }, message('reply-1'))).toBe('sent')
    expect(third.calls).toHaveLength(1)
  })
  it('resolves a document token through +inspect when the Trigger predates it', async () => {
    const { commands, calls } = stub([{ items: [], has_more: false }, { token: 'DOC9', type: 'docx' }])
    expect(await sendFeishuDoc({ commands }, message('reply-2', {}))).toBe('sent')
    expect(calls[1]).toEqual(expect.arrayContaining(['drive', '+inspect', '--url', DOC]))
    expect(calls[2]).toEqual(expect.arrayContaining(['/open-apis/drive/v1/files/DOC9/comments/c1/replies']))
  })
  it('answers gone for a deleted document or a solved comment, and leaves other failures to the retry', async () => {
    expect(await sendFeishuDoc({ commands: stub([{ items: [], has_more: false }, new CliError('docs had been deleted', 1069304)]).commands },
      message('reply-3'))).toBe('gone')
    expect(await sendFeishuDoc({ commands: stub([new CliError('该评论已被解决，无法回复', 1069303)]).commands }, message('reply-4'))).toBe('gone')
    await expect(sendFeishuDoc({ commands: stub([{ items: [], has_more: false }, new CliError('Rate limited', 99991400)]).commands },
      message('reply-5'))).rejects.toThrow('Rate limited')
    // A failed pre-check must not fall through to posting, which could double an already sent reply.
    await expect(sendFeishuDoc({ commands: stub([new CliError('Rate limited', 99991400)]).commands }, message('reply-6')))
      .rejects.toThrow('Rate limited')
  })
})

it('rereads configured document titles, keeping a configured display name', async () => {
  const config = feishuDocAdapter.schema.parse({ documents: [{ url: DOC, listen: 'mentions' }, { url: 'https://example.feishu.cn/docx/DOC2', name: 'Renamed' }] })
  const state = new Map<string, unknown>()
  const { commands } = stub([{ token: 'DOC1', type: 'docx', title: 'Handbook' }, { token: 'DOC2', type: 'docx', title: 'Ignored' }])
  const ctx = { config: () => config, commands, state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { state.set(key, value) } } }
  const labels = await refreshDocLabels(ctx as unknown as SourceContext)
  expect(labels).toEqual({ [DOC]: 'Handbook', 'https://example.feishu.cn/docx/DOC2': 'Renamed' })
  expect(state.get(KV.sources.labels('feishu-doc'))).toEqual(labels)
})

it('declares the document and comment of a Trigger as environment variables', () => {
  const values = feishuDocAdapter.environment!.values({ deployment: testDeployment(), config: noDocuments,
    trigger: docTrigger(reply('r2', MEMBER, [text('hi')]), card, document, BOT) })
  expect(values).toEqual({ DSH_SUPERAGENT_FEISHU_DOC: DOC, DSH_SUPERAGENT_FEISHU_DOC_COMMENT: 'c1' })
  expect(feishuDocAdapter.environment!.values({ deployment: testDeployment(), config: noDocuments }))
    .toEqual({ DSH_SUPERAGENT_FEISHU_DOC: '', DSH_SUPERAGENT_FEISHU_DOC_COMMENT: '' })
})