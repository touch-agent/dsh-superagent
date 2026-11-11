/** Executor Session tools for reading ticket context, acknowledging requests, managing threads, handing back out-of-scope triggers, and reporting status. */
import { z } from 'zod'
import { ARTIFACT_KINDS, PREVIEW_KINDS, liveTicket, runningAssignment, type EngineForExecutor, type Ticket } from '@superagent/kernel'
import { CliError } from '../../infra/commands.ts'
import { IM_WORDS } from '../../infra/text.ts'
import { claimPull, readGithubThread, readPull } from '../../sources/github-pull.ts'
import type { SourceContext } from '../../sources/host.ts'
import { readResource, type ResourceHost } from '../resources.ts'
import type { Store } from '../store.ts'
import { reportRelay, threadFollowedNotice } from '../notices.ts'
import type { Sessions } from '../sessions.ts'
import { AcknowledgementSchema, readTool, tool, type Tool } from './tool.ts'

/** One criterion as a worker declares it; `enterReview` keeps only the parts the kernel can judge and reasons about the rest. */
const CriterionSchema = z.object({
  kind: z.enum(['rule', 'human']),
  rule: z.string().optional(),
  who: z.object({ source: z.string().min(1), id: z.string().min(1) }).optional(),
  window: z.number().positive().optional(),
  reason: z.string().min(1).optional(),
}).strict()
/** The artifact and preview of one revision; `enterReview` refuses a preview of another revision. */
const DeliverableSchema = z.object({
  artifact: z.object({ kind: z.enum(ARTIFACT_KINDS), ref: z.string().min(1), revision: z.string().min(1) }).strict(),
  previewRef: z.object({ kind: z.enum(PREVIEW_KINDS), ref: z.string().min(1), revision: z.string().min(1) }).strict(),
  acceptanceCriteria: z.array(CriterionSchema).optional(),
}).strict()

export interface ExecutorToolsHost {
  readonly engine: Pick<EngineForExecutor, 'report' | 'reply' | 'markUnrelated' | 'handback' | 'followForContext'
    | 'delegate' | 'acceptChild' | 'returnChild' | 'cancelChild' | 'childDecision'>
  readonly store: Pick<Store, 'tickets' | 'replyStatus' | 'atomic'>
  readonly sessions: Pick<Sessions, 'relay' | 'notify'>
  readonly resources: ResourceHost
  /** GitHub Source context whose pull-request rules govern claiming a reported PR. */
  readonly github: SourceContext
  sendReplies(): Promise<void>
}

/**
 * Refuses a GitHub Thread the Source cannot poll. It reads only its configured repository, so a Thread from another
 * repository would fail every poll for as long as the Ticket follows it; its comments can never reach the Ticket.
 */
async function followableGithubThread(host: ExecutorToolsHost, source: string, id: string, signal: AbortSignal): Promise<void> {
  if (source !== 'github' || id.startsWith('ci:')) return
  const number = Number(id)
  if (!Number.isInteger(number) || number <= 0) throw new Error('A GitHub thread key names an Issue or PR number, such as github:<number>')
  // Setup resolves the repository; before that the Source polls nothing, and the follow can be stored like any other.
  if (!host.github.configured()) return
  try { await readGithubThread(host.github, number, signal) }
  catch (error) {
    if (!(error instanceof CliError) || error.code !== 404) throw error
    throw new Error(`GitHub thread github:${number} is not in ${host.github.deployment.repository}; the GitHub Source only reads its configured repository, so its comments there would never reach this ticket`)
  }
}

export function executorTools(host: ExecutorToolsHost, ticket: Ticket): Tool[] {
  const ticketId = ticket.id
  // A parent owner is this ticket's worker; the domain records that worker as the reviewer in every disposition.
  const actor = { source: 'dsh-superagent', id: `worker-${ticketId}` }
  return [
    readTool('Read one page of a resource of this ticket that the resource parameter lists. Follow next_offset, and next_resource where a page names one.',
      true, (resource, offset, limit, signal) => readResource(host.resources, resource, offset, limit, ticketId, signal)),
    tool({
      name: 'orchestrator_ack',
      description: 'Acknowledge one original human request before substantial work, as the replies section says; it posts as a reply to that message. While the Policy undo window is open it stays queued and returns pending.',
      schema: z.object({
        trigger_id: z.string(),
        text: AcknowledgementSchema.describe(`At most ${IM_WORDS} words; Markdown is supported.`),
      }).strict(),
      execute: async args => {
        const reply = host.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: args.trigger_id, text: args.text })
        if (reply.status !== 'sent') await host.sendReplies()
        return { trigger_id: args.trigger_id, acknowledgement: host.store.replyStatus(reply.id)!, reused: reply.reused }
      },
    }),
    tool({
      name: 'orchestrator_thread_unrelated',
      description: 'Stop following an attached thread that is not about this ticket, as the work section says; its own threads cannot be dropped.',
      schema: z.object({
        thread: z.string().min(1).describe('The thread key, which trigger/<id> of one of its messages shows as thread, such as feishu:<chat>:<root> or github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('One sentence on why the thread is not about this ticket.'),
      }).strict(),
      execute: async args => { host.engine.markUnrelated(ticketId, args.thread, args.reason); return { removed: true, thread: args.thread } },
    }),
    tool({
      name: 'orchestrator_thread_follow',
      description: 'Follow a related thread, such as an Issue or another PR, for context only. A GitHub Thread must be an Issue or PR in the Source\'s configured repository.',
      schema: z.object({
        thread: z.string().describe('Thread key, such as github:<number>.'),
        reason: z.string().trim().min(1).max(300).describe('How it relates, in one sentence.'),
      }).strict(),
      execute: async (args, signal) => {
        const at = args.thread.indexOf(':')
        if (at < 1 || at === args.thread.length - 1) throw new Error('A thread key is <source>:<id>, such as github:<number>')
        const ref = { source: args.thread.slice(0, at), id: args.thread.slice(at + 1) }
        await followableGithubThread(host, ref.source, ref.id, signal)
        return host.store.atomic(() => {
          const followed = host.engine.followForContext(ticketId, ref)
          if (followed) host.sessions.notify(...threadFollowedNotice(ticketId, args.thread, args.reason))
          return { followed, thread: args.thread }
        })
      },
    }),
    tool({
      name: 'orchestrator_trigger_handback',
      description: 'Hand back a message that asks for work beyond this ticket or for another one, for a fresh assessment; once per message. queued is false while another ticket still decides it, and for a message that was never this ticket\'s to decide, such as a bot\'s, which is assessed without it.',
      schema: z.object({
        trigger_id: z.string().min(1),
        reason: z.string().trim().min(1).max(300).describe('One sentence on what it asks for beyond this ticket.'),
      }).strict(),
      execute: async args => ({ trigger_id: args.trigger_id, queued: host.engine.handback(ticketId, args.trigger_id, args.reason) }),
    }),
    tool({
      name: 'orchestrator_report',
      description: 'Report progress, ready, blocked, failed or dropped, as the work and handoff sections say.',
      schema: z.object({
        state: z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped']),
        summary: z.string().min(1),
        human_action: z.string().trim().min(1).max(1000).nullish().describe('One concrete question for a person, also with state=progress; omit to keep the pending one, null to clear it.'),
        question_for_trigger_id: z.string().optional().describe('With human_action: the human message that raised the question, which is asked where that person wrote.'),
        pr_number: z.number().int().positive().nullish().describe(`The ticket's PR: its source PR, or one by ${host.github.deployment.github.login} from a branch named after this ticket (DSH_SUPERAGENT_NAME).`),
        reply_to_trigger_id: z.string().optional().describe('The explicit human question this report answers; never for ordinary progress.'),
        deliverable: DeliverableSchema.nullish().describe('A ready result: artifact and previewRef of the same revision; approval needs it.'),
      }).strict(),
      execute: async (args, signal) => {
        const current = host.store.tickets.get(ticketId)
        if (!current || !liveTicket(current)) throw new Error('Ticket ended (PR was closed or work finished); do not resume it')
        const pull = args.pr_number != null ? await readPull(host.github, args.pr_number, signal) : undefined
        // Claim the PR, record the report, and queue the relay atomically so a rejected PR claim or invalid report leaves no partial state, and a recorded report always reaches the main Session.
        return host.store.atomic(() => {
          const refused = pull && claimPull(host.github, ticketId, pull)
          if (refused) throw new Error(refused)
          const report = { state: args.state, summary: args.summary, ...(args.human_action !== undefined ? { question: args.human_action } : {}),
            ...(args.question_for_trigger_id ? { askedBy: args.question_for_trigger_id } : {}),
            ...(args.reply_to_trigger_id ? { answers: args.reply_to_trigger_id } : {}),
            ...(args.deliverable ? { deliverable: args.deliverable } : {}) }
          const assignment = runningAssignment(current)
          const updated = host.engine.report(ticketId, { ...report, ...(assignment ? { assignmentId: assignment.id } : {}) })
          // A child reports to its parent owner; only a root reaches the main Session.
          const relay = updated.parentTicketId ? undefined : reportRelay(updated, report)
          if (relay) host.sessions.relay(relay.id, relay.text)
          const notification = relay ? 'orchestrator' : 'internal_only'
          return { reported: true, notification, ...(updated.attention ? { attention: updated.attention } : {}) }
        })
      },
    }),
    tool({
      name: 'orchestrator_child',
      description: 'Delegate a child Ticket, or accept, return or cancel one; a child inherits the root Mandate and reports to you.',
      schema: z.object({
        operation: z.enum(['delegate', 'accept', 'return', 'cancel', 'self-work', 'escalated', 'reassigned']),
        child_ticket_id: z.string().optional(),
        goal: z.string().trim().min(1).max(2000).optional(),
        assignment: z.string().trim().min(1).max(2000).optional(),
        reason: z.string().trim().min(1).max(500).optional(),
        replacement_ticket_id: z.string().optional(),
        failed: z.boolean().optional(),
      }).strict(),
      execute: async args => {
        const child = () => args.child_ticket_id ?? (() => { throw new Error('child_ticket_id is required') })()
        switch (args.operation) {
          case 'delegate': {
            if (!args.goal) throw new Error('goal is required to delegate')
            const created = host.engine.delegate(ticketId, { goal: args.goal, ...(args.assignment ? { assignment: args.assignment } : {}) })
            return { delegated: true, ticket_id: created.id, parent_ticket_id: ticketId, root_ticket_id: created.rootTicketId,
              attempt: created.delegation?.attempt }
          }
          case 'accept': {
            const accepted = host.engine.acceptChild(ticketId, child(), actor)
            return { accepted: true, ticket_id: accepted.id, state: 'completed', resolution: accepted.delegation?.resolution?.kind }
          }
          case 'return':
            if (!args.reason) throw new Error('reason is required to return')
            return { returned: true, ticket_id: host.engine.returnChild(ticketId, child(), actor, args.reason).id }
          case 'cancel':
            if (!args.reason) throw new Error('reason is required to cancel')
            return { cancelled: !args.failed, failed: !!args.failed, ticket_id: host.engine.cancelChild(ticketId, child(), actor, args.reason, args.failed ? 'failed' : 'cancelled').id }
          default: {
            if (!args.reason) throw new Error('reason is required to record a child decision')
            const disposition = host.engine.childDecision(ticketId, child(), actor, args.operation, args.reason, args.replacement_ticket_id)
            return { recorded: true, decision: disposition.decision, at: disposition.at, trace_id: disposition.traceId }
          }
        }
      },
    }),
  ]
}
