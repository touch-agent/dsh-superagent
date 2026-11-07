/** Feishu document Source loops: polls new comment replies per configured document and follows subscribed comment cards. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey, type Thread, type Trigger } from '@superagent/kernel'
import { validItems, type Tally } from '../infra/commands.ts'
import type { FeishuBot } from '../deployment.ts'
import { readComments, readReplies } from './feishu-doc-read.ts'
import { docRef, docThreadRef, docTime, docTrigger, SOURCE, type DocCard, type DocComment, type DocRef, type DocTarget, type DocReply }
  from './feishu-doc-trigger.ts'
import { health, type SourceContext } from './host.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause, pollFailure, pollThreads as pollEach } from './poll.ts'
import type { FeishuDocConfig } from './feishu-doc.ts'

const HEALTH = 'feishu-doc'
export const runFeishuDoc = (ctx: SourceContext, signal: AbortSignal): Promise<unknown> =>
  Promise.allSettled([watch(ctx, signal)])
const enabled = (ctx: SourceContext): FeishuDocConfig | undefined => ctx.config<FeishuDocConfig>(SOURCE)
const bot = (ctx: SourceContext): FeishuBot => {
  const resolved = ctx.deployment.feishu
  if (!resolved) throw new Error('The Feishu document Source has no working bot CLI')
  return resolved
}
function available(ctx: SourceContext): boolean {
  if (ctx.configured() && ctx.deployment.feishu) return true
  const waiting = health('paused', ctx.configured() ? 'feishuCliUnset' : 'setupPending')
  ctx.report(HEALTH, ctx.problem ? { state: 'paused', detail: ctx.problem.detail } : waiting)
  return false
}
const labels = (ctx: SourceContext): Record<string, string> => ctx.state.get(KV.sources.labels(SOURCE)) ?? {}
const InspectedSchema = z.looseObject({ title: z.string().nullish(), token: z.string().nullish(), type: z.string().nullish() })
/** Reads a document's title, which names its Threads; a read failure keeps the configured name or the link. */
async function title(commands: SourceContext['commands'], document: string, fallback?: string): Promise<string> {
  try {
    const inspected = InspectedSchema.parse(await commands.lark(['drive', '+inspect', '--url', document]))
    return fallback?.trim() || inspected.title?.trim() || document
  } catch { return fallback?.trim() || document }
}
/** Rereads the display title of every configured document; the panel's refresh and the first poll of a new document use it. */
export async function refreshDocLabels(ctx: SourceContext, signal?: AbortSignal): Promise<Record<string, string>> {
  const config = enabled(ctx)
  if (!config) return {}
  const commands = ctx.commands.withSignal(signal)
  const names: Record<string, string> = {}
  for (const doc of config.documents) {
    if (signal?.aborted) break
    names[doc.url] = await title(commands, doc.url, doc.name)
  }
  ctx.state.set(KV.sources.labels(SOURCE), names)
  return names
}
/** Runs the polling loop while the Source is enabled; disabling it stops polling within five seconds. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the bot; until then nothing is polled.
  if (!available(ctx)) return
  let failures = 0
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report(HEALTH, health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const running = new AbortController()
    const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)
    const stop = () => running.abort()
    signal.addEventListener('abort', stop, { once: true })
    try {
      const problems = await pollRound(ctx, config, running.signal)
      if (problems.length) {
        failures += 1
        const failed = pollFailure(failures, config.failuresBeforeError, problems.join('\n'))
        if (failed) ctx.report(HEALTH, failed)
      } else failures = 0
    } catch (error) {
      if (!running.signal.aborted) {
        failures += 1
        const failed = pollFailure(failures, config.failuresBeforeError, error)
        if (failed) ctx.report(HEALTH, failed)
      }
    } finally { clearInterval(check); signal.removeEventListener('abort', stop) }
    await pause(Math.max(30, config.pollSeconds) * 1000, signal)
  }
}
/** One polling round: new replies of every document, then the subscribed comment cards whose replies the live API cannot deliver. */
export async function pollRound(ctx: SourceContext, config: FeishuDocConfig, signal?: AbortSignal): Promise<string[]> {
  if (!enabled(ctx)) return []
  const started = new Date().toISOString()
  const tally: Tally = { skipped: 0 }
  const known = { ...labels(ctx) }
  const problems: string[] = []
  for (const doc of config.documents) {
    if (signal?.aborted) return problems
    // A new document has no stored title yet; one read per round names it and its Threads.
    if (!known[doc.url]) {
      known[doc.url] = await title(ctx.commands, doc.url, doc.name)
      ctx.state.set(KV.sources.labels(SOURCE), known)
    }
    const cursor = KV.feishuDoc.since(doc.url)
    const since = ctx.state.get(cursor)
    // The Source reads from the moment the document is saved; earlier comments are not work.
    if (since === undefined) { ctx.state.set(cursor, started); continue }
    try {
      const page = await readComments(ctx.commands.withSignal(signal), doc.url, tally)
      const target: DocTarget = { url: doc.url, title: known[doc.url], token: page.token, type: page.type }
      // A truncated page or reply list means replies exist that this round did not see; hold the cursor so none is skipped.
      let complete = !page.truncated
      for (const card of page.cards) {
        if (signal?.aborted) return problems
        const replies = card.comment.has_more
          ? await readReplies(ctx.commands.withSignal(signal), doc.url, card.comment.comment_id, tally)
          : undefined
        if (replies?.truncated) complete = false
        await ingest(ctx, target, card.comment, replies?.replies ?? card.replies, since)
      }
      if (!complete) problems.push(`${target.title}: more comments or replies than the source can page through; the cursor is held so none is skipped`)
      else if (!signal?.aborted) ctx.state.set(cursor, cursorAt(started))
    } catch (error) {
      if (!signal?.aborted) problems.push(`${known[doc.url] ?? doc.url}: ${String(error)}`)
    }
  }
  await pollThreads(ctx, signal, tally, known, problems)
  if (signal?.aborted) return problems
  const skipped = tally.skipped ? `; ${tally.skipped} unreadable items skipped` : ''
  if (!problems.length) ctx.report(HEALTH, { state: 'ready', detail: `Configured documents polled for new comment replies${skipped}`, at: new Date().toISOString() })
  return problems
}
/** Polls the subscribed comment cards, which the comment list cannot follow after their first page. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, tally: Tally = { skipped: 0 },
  known: Record<string, string> = labels(ctx), problems: string[] = []): Promise<string[]> {
  await pollEach(ctx, SOURCE, () => !!signal?.aborted, thread => pollThread(ctx, thread, signal, known, tally, problems))
  return problems
}
/** Turns the replies of one comment card into Triggers, oldest first, skipping the bot's own replies and anything before `since`. */
async function ingest(ctx: SourceContext, target: DocTarget, comment: DocComment, replies: readonly DocReply[], since: string): Promise<void> {
  const reader = bot(ctx)
  const card: DocCard = { commentId: comment.comment_id, rootReplyId: replies[0]?.reply_id,
    quote: comment.quote ?? undefined, whole: comment.is_whole }
  for (const reply of replies) {
    if (Date.parse(docTime(reply.create_time)) < Date.parse(since)) continue
    const trigger = docTrigger(reply, card, target, reader)
    if (trigger) await receive(ctx, trigger, target)
  }
}
async function receive(ctx: SourceContext, trigger: Trigger, target: DocTarget): Promise<void> {
  await ctx.receive(trigger)
  const ref = docRef(trigger)
  if (!ref) return
  const name = target.title || ref.document
  const thread = threadKey(docThreadRef(ref))
  ctx.threads.patch(thread, { document: ref.document, commentId: ref.commentId })
  ctx.threads.describe(thread, { label: name, url: ref.document, facts: { document: { value: name } } })
}
/** Resolves the comment card a subscribed Thread follows, from its meta or its newest Trigger. */
function threadRef(ctx: SourceContext, thread: Thread): DocRef | undefined {
  const meta = thread.meta as { document?: unknown; commentId?: unknown }
  if (typeof meta.document === 'string' && typeof meta.commentId === 'string') return { document: meta.document, commentId: meta.commentId }
  const trigger = ctx.triggers.latest(thread.key)
  return trigger ? docRef(trigger) : undefined
}
/**
 * Polls one subscribed comment card for replies the Source missed, marking the replies present at subscription as seen so the
 * Thread's older context is not ingested as new work.
 */
async function pollThread(ctx: SourceContext, thread: Thread, signal: AbortSignal | undefined, known: Record<string, string>, tally: Tally,
  problems: string[]): Promise<void> {
  if (!enabled(ctx)) return
  const ref = threadRef(ctx, thread)
  if (!ref) throw new Error('A subscribed Feishu document Thread has no comment to poll')
  const commands = ctx.commands.withSignal(signal)
  const checkpoint = KV.feishuDoc.seen(thread.key)
  const seen = new Set(ctx.state.get(checkpoint) ?? [])
  const initialized = ctx.state.get(KV.feishuDoc.initialized(thread.key))
  const since = Date.parse(thread.createdAt)
  const page = await readReplies(commands, ref.document, ref.commentId, tally)
  if (page.truncated) problems.push(`${known[ref.document] ?? ref.document}: more replies on comment ${ref.commentId} than the source can page through; the unread ones stay pending`)
  const target: DocTarget = { url: ref.document, title: known[ref.document], token: page.token, type: page.type }
  const card: DocCard = { commentId: ref.commentId, rootReplyId: page.replies[0]?.reply_id }
  for (const reply of page.replies) {
    if (signal?.aborted) return
    if (seen.has(reply.reply_id)) continue
    const trigger = docTrigger(reply, card, target, bot(ctx))
    if (trigger && (initialized || Date.parse(trigger.at) >= since)) await receive(ctx, trigger, target)
    seen.add(reply.reply_id)
  }
  ctx.state.set(checkpoint, [...seen])
  ctx.state.set(KV.feishuDoc.initialized(thread.key), true)
}