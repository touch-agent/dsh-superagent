/** GitHub outbound channel: posts issue/PR comments and review thread replies under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '@superagent/kernel'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks, ProbeAnswer, Withdrawal } from './kind.ts'
import { githubAddress, githubPage } from './github-trigger.ts'

const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
})
/** True when an issue is permanently deleted (410) or locked (403); 404 is retried because it can indicate temporary permission loss on a private repo. */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)

/** Where one reply belongs: the conversation's comment path, the review-thread root it answers, and the marker that names it. */
interface CommentTarget {
  path: string; rootId?: number; marker: string; mine: (comment: z.infer<typeof CommentSchema>) => boolean
  /** The review root this reply answered was deleted, so a reply posted there is no longer readable in this conversation. */
  rootMissing?: boolean
}
/** Resolves the reply target of `message`, including the review-thread root an inline reply answers. */
async function commentTarget(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<CommentTarget> {
  const { commands } = host
  const { repository, github } = commands.deployment
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing GitHub reply target')
  // Retained trigger URLs also route replies queued before thread-aware delivery.
  const address = githubAddress(message.channel.address.url ?? '', repository)
  let rootId: number | undefined
  let rootMissing = false
  if (address?.pr && address.discussion && address.number === number) {
    // Fall back to a top-level PR comment if the target inline review comment was deleted.
    const source = await commands.api(CommentSchema, `pulls/comments/${address.discussion}`)
      .catch((error: unknown) => { if (missing(error)) return undefined; throw error })
    rootMissing = source === undefined
    rootId = source ? source.in_reply_to_id ?? source.id : undefined
  }
  const path = rootId === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
  const marker = `<!-- dsh-superagent:${message.id} -->`
  return { path, ...rootId === undefined ? {} : { rootId }, ...rootMissing ? { rootMissing } : {}, marker,
    mine: comment => sameName(comment.user?.login ?? '', github.login)
      && (rootId === undefined || comment.in_reply_to_id === rootId) && (comment.body ?? '').includes(marker) }
}
/** Posts a comment or review-thread reply with an embedded HTML marker so retries do not create duplicate comments. */
export async function sendGithub(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  try {
    const target = await commentTarget(host, message)
    if ((await commands.pages(CommentSchema, target.path)).some(target.mine)) return 'sent'
    const path = target.rootId === undefined ? target.path : `${target.path}/${target.rootId}/replies`
    await commands.api(z.unknown(), path, '--method', 'POST', '-f', `body=${message.text}\n\n${target.marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** Reads whether the marked comment is already in the conversation; a read failure is `unknown`, never a resend. */
export async function probeGithub(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<ProbeAnswer> {
  try {
    const target = await commentTarget(host, message)
    if ((await host.commands.pages(CommentSchema, target.path)).some(target.mine)) return 'sent'
    // The review thread's root is gone, so a reply posted under it is not in the readable conversation: do not call it absent.
    return target.rootMissing ? 'unknown' : 'gone'
  } catch (error) {
    // A deleted or locked conversation is gone either way; anything else leaves the answer unknown.
    return gone(error) ? 'gone' : 'unknown'
  }
}
/**
 * Takes back the marked comment this message posted, for a Source whose comment can still be removed. A comment that is
 * already absent is `gone`; a refusal names why, such as a locked conversation, instead of reporting a withdrawal that
 * did not happen. A review thread whose root is gone cannot be located, so its reply is not guessed to be withdrawn.
 */
export async function withdrawGithub(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<Withdrawal> {
  const { commands } = host
  try {
    const target = await commentTarget(host, message)
    if (target.rootMissing) return { status: 'refused', reason: 'The review thread root is gone, so the reply cannot be located' }
    const comment = (await commands.pages(CommentSchema, target.path)).find(target.mine)
    if (!comment) return { status: 'gone' }
    const collection = target.path.startsWith('pulls/') ? 'pulls/comments' : 'issues/comments'
    // The delete answers 204 with no body, so use the raw path overload; the JSON overload would parse an empty body.
    await commands.api(`${collection}/${comment.id}`, '--method', 'DELETE')
    return { status: 'withdrawn' }
  } catch (error) {
    if (missing(error)) return { status: 'gone' }
    return { status: 'refused', reason: `GitHub did not withdraw the comment: ${String(error)}` }
  }
}
export function githubLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const review = !!links.repository && !!githubAddress(address.url ?? '', links.repository)?.discussion
  return { url: address.url ?? (links.repository ? githubPage(links.repository, Number(number)) : ''),
    label: review ? { zh: `GitHub #${number} 的 review 讨论`, en: `Review discussion on GitHub #${number}` }
      : { zh: `GitHub #${number}`, en: `GitHub #${number}` } }
}
