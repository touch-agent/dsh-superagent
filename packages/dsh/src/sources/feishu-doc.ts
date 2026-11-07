/** The Feishu document manifest and adapter, and the Cordis plugin entry that registers and runs it. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { SourceManifest } from '@superagent/kernel'
import { feishuDocLink, sendFeishuDoc } from './feishu-doc-channel.ts'
import { refreshDocLabels, runFeishuDoc } from './feishu-doc-loops.ts'
import { feishuDocThreadContext } from './feishu-doc-read.ts'
import { docRef, docRepliesTo, SOURCE, type DocRef } from './feishu-doc-trigger.ts'
import { sourceContext } from './host.ts'
import type { Localized, SourceAdapter, SourceDefinition, SourceKind } from './kind.ts'

const FeishuDocConfigSchema = z.object({
  documents: z.array(z.object({
    url: z.url(),
    name: z.string().trim().max(80).optional(),
    listen: z.enum(['mentions', 'all']).default('mentions'),
  }).strict())
    .refine(documents => new Set(documents.map(document => document.url)).size === documents.length, 'Each document is listed once')
    .default([]),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type FeishuDocConfig = z.infer<typeof FeishuDocConfigSchema>
const explicit = { zh: '名单里的人在监听的文档评论里 @ 机器人，总是明确的请求。', en: 'Someone on the list who mentions the bot in a comment of a received document always makes an explicit request.' }
/** The document a Trigger belongs to while `config` still receives it; a document removed from the list can no longer reply. */
const scopeOf = (meta: Record<string, unknown>, config: FeishuDocConfig) =>
  config.documents.find(document => document.url === meta.document)
const feishuDocScope: NonNullable<SourceAdapter<FeishuDocConfig>['scope']> = ({ meta }, config) => {
  const document = scopeOf(meta, config)
  return document ? { listened: true, observed: document.listen === 'all', row: document.url }
    : { listened: false, reason: 'document_not_allowed' }
}

export const feishuDocManifest: SourceManifest = {
  id: SOURCE,
  title: { zh: '飞书文档', en: 'Feishu documents' },
  description: { zh: '接收机器人能看到的飞书文档评论，并跟进评论里的后续回复。机器人身份和评论权限来自飞书来源配置的机器人。', en: 'Receives Feishu document comments the bot can see and follows later replies on them. The bot identity and comment permission come from the bot configured on the Feishu Source.' },
  auth: { kind: 'none', fields: [] },
  fields: [
    { key: 'bot', type: 'fact', label: { zh: '机器人', en: 'Bot' },
      hint: { zh: '飞书文档来源使用飞书来源里配置的机器人读写评论；那里没配置时，这个来源等待配置。', en: 'This Source reads and answers comments as the bot configured on the Feishu Source; when that is not configured, this Source waits for it.' } },
    { key: 'documents', type: 'rows', label: { zh: '监听的文档', en: 'Documents' },
      hint: { zh: '每行一个飞书文档链接，并让文档把机器人加为可阅读、可评论的协作者。“仅 @”只接收 @ 机器人的评论和已有工单的评论串；“全部评论”也接收其余评论，由策略的接收表决定是否成为候选。从保存时开始接收，不读之前的评论。全文评论不能被回复，因此不接收。评论只带作者的 open_id，不区分人和其他应用；其他应用的评论按该 ID 的发言处理，所以不要把应用账号放进能发起工作的名单。', en: 'One Feishu document link per row, shared with the bot as a reader allowed to comment. "@ only" receives comments that mention the bot and comment threads that already have Tickets; "All comments" also receives the rest, and the Policy\'s admission table decides whether they become candidates. Receives from the moment it is saved, not earlier comments. Whole-document comments are not received because Feishu cannot reply on them. A comment carries only its author\'s open_id, not whether the author is another app, so another app\'s comments are treated as that id\'s messages; do not put app accounts on the list of users who may originate work.' },
      columns: [
        { key: 'url', type: 'text', label: { zh: '文档链接', en: 'Document link' }, pattern: '^https://\\S+$', refresh: { zh: '刷新文档标题', en: 'Refresh document titles' } },
        { key: 'name', type: 'text', label: { zh: '显示名', en: 'Display name' }, optional: true },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部评论', en: 'All comments' } }] },
      ] },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  ],
  health: ['feishu-doc'],
  limits: { pollSeconds: 60 },
}
export const feishuDocAdapter: SourceAdapter<FeishuDocConfig> = {
  schema: FeishuDocConfigSchema,
  refreshLabels: (host, signal) => refreshDocLabels(sourceContext(host, { kind: SOURCE, health: feishuDocManifest.health }), signal),
  scope: feishuDocScope,
  // A reply goes only to a document the Source still receives.
  channel: {
    allowed: (address, config) => config.documents.some(document => document.url === address.document),
    send: sendFeishuDoc, link: feishuDocLink,
  },
  threadContext: feishuDocThreadContext,
  repliesTo: docRepliesTo,
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^ou_[A-Za-z0-9]+$/),
      name: z.string().trim().max(100).optional() }).strict())
      .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate open_ids').default([]) }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的飞书用户', en: 'Feishu users who may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '用户 open_id', en: 'User open_id' }, pattern: 'ou_[A-Za-z0-9]+' },
        { key: 'name', type: 'text', label: { zh: '显示名', en: 'Display name' }, optional: true }] }],
    explicit,
    rows(stored) {
      const config = FeishuDocConfigSchema.partial().parse(stored)
      return (config.documents ?? []).map(document => ({
        id: document.url, label: document.name?.trim() || document.url,
        note: document.listen === 'all' ? { zh: '全部评论', en: 'All comments' } : { zh: '仅 @', en: '@ only' },
        // A document the Source does not observe takes no unaddressed comment; an off-list mention is still receivable.
        cells: { listedUnaddressed: document.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: document.listen === 'all' },
      }))
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_FEISHU_DOC', description: { zh: '当前评论所在的飞书文档链接；工单不是从飞书文档来的时为空', en: 'The Feishu document the comment belongs to; empty when the ticket did not start on a Feishu document' } },
      { key: 'DSH_SUPERAGENT_FEISHU_DOC_COMMENT', description: { zh: '当前评论的评论 ID；工单不是从飞书文档来的时为空', en: 'ID of the comment; empty when the ticket did not start on a Feishu document' } },
    ],
    values: ({ trigger }) => {
      const ref: DocRef | undefined = trigger?.source === SOURCE ? docRef(trigger) : undefined
      return { DSH_SUPERAGENT_FEISHU_DOC: ref?.document ?? '', DSH_SUPERAGENT_FEISHU_DOC_COMMENT: ref?.commentId ?? '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => {
    const bot = deployment?.feishu
    return { bot: bot ? { zh: `当前机器人 ${bot.name || bot.botId}`, en: `Current bot ${bot.name || bot.botId}` }
      : { zh: '飞书来源还没有配置机器人', en: 'The Feishu Source has no bot configured yet' } }
  },
}
export const feishuDocDefinition: SourceDefinition<FeishuDocConfig> = { manifest: feishuDocManifest, adapter: feishuDocAdapter }
/** The flat view the panel and the tests still read; T1-10 retires it with the rest of the kind protocol. */
export const feishuDocKind: SourceKind<FeishuDocConfig> = { ...feishuDocAdapter, kind: feishuDocManifest.id, title: feishuDocManifest.title,
  description: feishuDocManifest.description, fields: [...feishuDocManifest.fields], health: [...feishuDocManifest.health] }

export const name = 'dsh-superagent-feishu-doc'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.registerDefinition(feishuDocDefinition), 'feishu documents: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    const running = runFeishuDoc(sourceContext(ctx.orchestrator, { kind: SOURCE, health: feishuDocManifest.health }), controller.signal)
    return async () => { controller.abort(); await running }
  })
}