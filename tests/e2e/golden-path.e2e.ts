/**
 * X-03: one golden path from a GitHub Issue to accepted, merged work, through the Runtime a deployment uses.
 *
 * The host is local: `startRuntime` supplies the DSH services, the GitHub CLI is a function of this file, and the Issue
 * arrives through the Source's own trigger builder. No network, credential or real GitHub/Feishu account participates.
 *
 * The path: an Issue from an allowed account mentions the agent → the Eval admits an explicit Mandate and the main Session
 * routes an accept → the root worker delegates two child Tickets → one child's work is returned and redone, both are
 * accepted by the parent owner → the root reports a PR, a delivery with a person confirmation → the panel approves the
 * aggregate revision → a person merges the PR → the Ticket ends `merged` with the approval still describing it.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { latestAssignment, reviewAggregate, reviewApproved, type AcceptanceCriterionInput, type Ticket } from '@superagent/kernel'
import { Commands } from '@superagent/dsh/infra/commands.ts'
import { githubKind } from '@superagent/dsh/sources/github.ts'
import { observePull, pullOf, type Pull } from '@superagent/dsh/sources/github-pull.ts'
import { issueTrigger } from '@superagent/dsh/sources/github-trigger.ts'
import { startRuntime, type Host } from '../fixtures/host.ts'

const AGENT = 'agent-bot'
const REPOSITORY = 'acme/widgets'
const ISSUE_NUMBER = 101
const PULL_NUMBER = 42
const PULL_URL = `https://github.com/${REPOSITORY}/pull/${PULL_NUMBER}`

/** The Issue a person opened, as the GitHub Source's own trigger builder reads it. */
const issue = issueTrigger({
  number: ISSUE_NUMBER,
  title: 'The empty state gives no next step',
  body: `@${AGENT} The empty state only says “No data”. Say what the person can do next.`,
  user: { login: 'alice', type: 'User' },
  created_at: '2026-11-10T05:00:00.000Z',
  html_url: `https://github.com/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
}, AGENT)

const deliverable = (ref: string, revision: string, previewKind: 'text/diff' | 'text/redline',
  criteria: AcceptanceCriterionInput[]) => ({ artifact: { kind: 'file' as const, ref, revision },
  previewRef: { kind: previewKind, ref: `fixture://${revision}`, revision }, acceptanceCriteria: criteria })

let host: Host

beforeEach(async () => {
  host = await startRuntime()
  // The fixture's GitHub CLI answers what the path under test reads: the ticket's PR, GitHub's comment lists (empty) and
  // comment creation. Everything else keeps the fixture repository answer, so setup and the source health checks still run.
  vi.mocked(Commands.prototype.gh).mockImplementation(async (args: string[]) => {
    const path = args[1] ?? ''
    if (path.endsWith(`/pulls/${PULL_NUMBER}`)) return pull('open')
    if (args.includes('--paginate')) return [[]]
    if (args.includes('--method')) return {}
    return { default_branch: 'main', permissions: { push: true } }
  })
})

afterEach(async () => { await host.stop() })

/** A pull request by the agent account from the root Ticket's branch, as `readPull` and `observePull` read it. */
function pull(state: 'open' | 'closed', mergedAt = ''): Pull {
  const root = ticket('root')
  return { number: PULL_NUMBER, state, merged: !!mergedAt, merged_at: mergedAt || null, closed_at: mergedAt || null,
    html_url: PULL_URL, user: { login: AGENT, type: 'User' },
    head: { sha: mergedAt ? 'merged-head' : 'open-head', ref: `agent/${root.execution!.name}`, repo: { full_name: REPOSITORY } } }
}

/** The one root Ticket, or the Ticket with `id`; the test names what it expects when neither exists. */
function ticket(id: 'root' | string): Ticket {
  const value = id === 'root' ? host.runtime.store.tickets.list()[0] : host.runtime.store.tickets.get(id)
  if (!value) throw new Error(`Ticket ${id} is missing`)
  return value
}

const children = (parentId: string) => host.runtime.store.tickets.childrenOf(parentId)
const aggregateOf = (id: string) => reviewAggregate(ticket(id), value => host.runtime.store.tickets.get(value),
  value => host.runtime.store.tickets.childrenOf(value))
const approved = (id: string) => reviewApproved(ticket(id), value => host.runtime.store.tickets.get(value),
  value => host.runtime.store.tickets.childrenOf(value))

/** Run one worker tool and let the Runtime settle the effects it queued, such as a child launch. */
async function run(sessionId: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await host.runTool(sessionId, name, args) as Record<string, unknown>
  await host.runtime.idle()
  return result
}

it('takes an Issue through authorization, child delegation and parent review, delivery, human approval and a merge', async () => {
  // 1. The Source receives the Issue. The Eval holds it, and the main Session is asked to route it as an explicit request.
  host.runtime.receive(issue)
  await host.runtime.idle()
  expect(host.relays(host.runtime.masterId)).toContainEqual(expect.objectContaining({ kind: 'candidate', trigger_id: issue.id,
    strength: 'explicit' }))

  // 2. Authorization: the accept creates the root under an explicit Mandate from the Issue's author, not from the agent.
  const accepted = await host.route({ kind: 'accept', trigger_id: issue.id, title: 'Give the empty state a next step',
    worktree_name: 'fix-empty-state', acknowledgement: 'On it: giving the empty state a next step.' })
  await host.runtime.idle()
  const root = ticket('root')
  const parentSession = `worker-${root.id}`
  expect(accepted).toMatchObject({ decision: 'accept', ticket: { ticket_id: root.id } })
  expect(root).toMatchObject({ id: (accepted.ticket as { ticket_id: string }).ticket_id, form: 'tracked',
    mandate: { strength: 'explicit', actor: { source: 'github', id: 'alice' }, basis: expect.objectContaining({ via: 'addressed' }) },
    origin: { triggerId: issue.id }, assignments: [expect.objectContaining({ state: 'running' })] })
  expect(host.runtime.store.decisions.byThread(`github:${ISSUE_NUMBER}`)).toEqual([expect.objectContaining({ kind: 'accept',
    ticketId: root.id, triggerIds: [issue.id] })])
  expect(host.runtime.store.threads.get(`github:${ISSUE_NUMBER}`)?.subscriptions).toContain(root.id)
  expect(host.agents.has(parentSession)).toBe(true)
  // The branch and checkout are the execution the accept fixed; the worker, not the main Session, owns the work.
  expect(root.execution?.name).toMatch(/^fix-empty-state-/)
  expect(root.execution?.directory).toContain(`system/work/${root.execution!.name}`)

  // 3. Child Tickets: the parent owner delegates two, each with its own worker, and neither gets a Mandate or Decision.
  const first = await run(parentSession, 'orchestrator_child', { operation: 'delegate', goal: 'Rewrite the empty-state copy',
    assignment: 'Rewrite the copy and cover it with a test.' })
  const second = await run(parentSession, 'orchestrator_child', { operation: 'delegate', goal: 'Add the next-step action',
    assignment: 'Add the action the copy names.' })
  const childA = ticket(String(first.ticket_id))
  const childB = ticket(String(second.ticket_id))
  expect(children(root.id).map(child => child.id).sort()).toEqual([childA.id, childB.id].sort())
  for (const child of [childA, childB]) {
    expect(child).toMatchObject({ parentTicketId: root.id, rootTicketId: root.id, form: 'tracked', channels: [] })
    expect(child.decisionId).toBeUndefined()
    expect(child.mandate).toBeUndefined()
    expect(child.follows).toBeUndefined()
    expect(child.attention).toBeUndefined()
    expect(child.delegation).toMatchObject({ parentTicketId: root.id, rootTicketId: root.id, attempt: 1 })
    expect(child.execution?.directory).not.toBe(root.execution?.directory)
    expect(host.agents.has(`worker-${child.id}`)).toBe(true)
  }
  // The parent cannot claim its goal is ready while a child is unresolved, and the tree keeps both children out of the root list.
  await expect(host.runTool(parentSession, 'orchestrator_report', { state: 'ready', summary: 'the root is done' }))
    .rejects.toMatchObject({ code: 'unfinishedChildTickets' })
  expect(host.runtime.store.tickets.list().map(value => value.id)).toEqual([root.id])
  // A child is not an authorization subject: the panel cannot approve it, even with a revision.
  const childApproval = await host.api('POST', `tickets/${childA.id}/approve`, { reviewRevision: 'any' })
  expect(childApproval).toMatchObject({ status: 400, body: { code: 'childRequiresParent' } })

  // 4. Parent review: one child report is returned and redone; both are then accepted by the parent owner, not by a person.
  await run(`worker-${childA.id}`, 'orchestrator_report', { state: 'ready', summary: 'Copy rewritten',
    deliverable: deliverable('docs/empty-state.md', 'copy-a1', 'text/diff',
      [{ kind: 'human', who: { source: 'github', id: 'alice' }, reason: 'Read the child copy' }]) })
  await run(`worker-${childB.id}`, 'orchestrator_report', { state: 'ready', summary: 'Action added',
    deliverable: deliverable('src/empty-state.ts', 'action-b1', 'text/diff',
      [{ kind: 'rule', rule: 'artifact.unchanged', window: 24 }]) })
  const returned = await run(parentSession, 'orchestrator_child', { operation: 'return', child_ticket_id: childB.id,
    reason: 'The action is not the one the copy names; redo it.' })
  expect(returned).toMatchObject({ returned: true, ticket_id: childB.id })
  expect(ticket(childB.id)).toMatchObject({ delegation: expect.objectContaining({ attempt: 2 }) })
  expect(ticket(childB.id).delegation?.resolution).toBeUndefined()
  // A returned child's earlier delivery leaves the parent's review aggregate until the next attempt is accepted.
  expect(aggregateOf(root.id)?.deliverables ?? []).toHaveLength(0)
  await run(`worker-${childB.id}`, 'orchestrator_report', { state: 'ready', summary: 'Action corrected',
    deliverable: deliverable('src/empty-state.ts', 'action-b2', 'text/diff',
      [{ kind: 'rule', rule: 'artifact.unchanged', window: 24 }]) })
  const acceptedChildA = await run(parentSession, 'orchestrator_child', { operation: 'accept', child_ticket_id: childA.id })
  expect(aggregateOf(root.id)?.deliverables).toHaveLength(1)
  const acceptedChildB = await run(parentSession, 'orchestrator_child', { operation: 'accept', child_ticket_id: childB.id })
  expect(aggregateOf(root.id)?.deliverables).toHaveLength(2)
  expect([acceptedChildA, acceptedChildB].map(result => result.accepted)).toEqual([true, true])
  for (const child of [childA, childB]) {
    const ended = ticket(child.id)
    expect(ended).toMatchObject({ ended: expect.objectContaining({ outcome: 'completed', by: 'executor' }),
      delegation: { resolution: { kind: 'accepted', acceptedAttempt: expect.any(Number),
        by: { source: 'dsh-superagent', id: `worker-${root.id}` } } } })
    expect(latestAssignment(ended)!.report).toMatchObject({ state: 'ready', review: expect.objectContaining({ confirmations: expect.any(Array) }) })
  }

  // 5. Delivery: the root reports its PR (binding the branch), then one reviewable delivery. The PR is open, so it waits.
  await run(parentSession, 'orchestrator_report', { state: 'progress', summary: 'PR open', pr_number: PULL_NUMBER })
  const withPull = ticket(root.id)
  expect(pullOf(withPull)).toBe(PULL_NUMBER)
  expect(withPull.follows).toContainEqual(expect.objectContaining({ thread: `github:${PULL_NUMBER}`, own: true }))
  // The root delivers the child's copy at the revision the parent merged, plus its own review of the whole result; the
  // aggregate deduplicates the shared artifact instead of showing it twice.
  await run(parentSession, 'orchestrator_report', { state: 'ready', summary: 'Ready for the final read',
    deliverable: deliverable('docs/empty-state.md', 'copy-a1', 'text/redline',
      [{ kind: 'human', who: { source: 'github', id: 'alice' }, reason: 'Read the final copy and the action together' }]) })
  const delivered = ticket(root.id)
  expect(delivered.ended).toBeUndefined()
  expect(delivered.assignments.at(-1)).toMatchObject({ report: { state: 'ready' } })

  // 6. The task tree and the parent review are one projection: two accepted children, two deliverable rows (the shared
  //    copy is one row with two sources) and the child's person confirmation beside the root's. The parent's acceptance is
  //    not a person's confirmation.
  const board = await host.api('GET', 'tasks')
  expect(board.status).toBe(200)
  const row = (board.body.tasks as { id: string; childSummary: Record<string, number> }[]).find(task => task.id === root.id)!
  expect(row.childSummary).toMatchObject({ total: 2, accepted: 2, unresolved: 0 })
  const detail = await host.api('GET', `tasks/${root.id}?depth=1`)
  const task = detail.body.task as { children: { id: string; owner: { role: string }; worker: { role: string };
    delegation: { parentTicketId: string } }[]; review: { reviewRevision: string; deliverables: unknown[]; confirmations: unknown[]; accepted?: unknown } }
  expect(task.children.map(child => child.id).sort()).toEqual([childA.id, childB.id].sort())
  for (const child of task.children) {
    expect(child.owner).toMatchObject({ role: 'owner' })
    expect(child.worker).toMatchObject({ role: 'worker' })
    expect(child.delegation.parentTicketId).toBe(root.id)
  }
  const before = aggregateOf(root.id)!
  expect(before.deliverables).toHaveLength(2)
  expect(before.deliverables.find(item => item.key === 'file:docs/empty-state.md:copy-a1')!.sources.map(source => source.ticketId)
    .sort()).toEqual([childA.id, root.id].sort())
  expect(before.confirmations).toHaveLength(2)
  expect(before.criteria).toEqual([{ kind: 'rule', rule: 'artifact.unchanged', window: 24 }])
  expect(task.review).toMatchObject({ reviewRevision: before.reviewRevision, deliverables: expect.any(Array),
    confirmations: expect.any(Array) })
  expect(task.review.accepted).toBeUndefined()
  expect(approved(root.id)).toBe(false)

  // 7. A person approves exactly this revision from the panel. An older revision is refused, so a stale approval cannot
  //    cover the later aggregate; approval covers the child confirmations too, but the open PR means the Ticket waits,
  //    because accepting a review is not merging the work.
  const stale = await host.api('POST', `tickets/${root.id}/approve`, { reviewRevision: `${before.reviewRevision}-stale` })
  expect(stale).toMatchObject({ status: 409, body: { code: 'reviewStale' } })
  const approval = await host.api('POST', `tickets/${root.id}/approve`, { reviewRevision: before.reviewRevision })
  expect(approval).toEqual({ status: 200, body: { approved: true, reviewRevision: before.reviewRevision } })
  expect(approved(root.id)).toBe(true)
  expect(ticket(root.id).ended).toBeUndefined()
  expect(latestAssignment(ticket(root.id))!.report!.accepted).toMatchObject({ by: { source: 'panel', id: 'local' },
    reviewRevision: before.reviewRevision })

  // 8. A person merges the PR outside this system; the Source observes it. That is the ending fact, and the Ticket keeps the
  //    approval that covers the delivered revision.
  const mergedAt = new Date().toISOString()
  await observePull(host.runtime.context(githubKind), pull('closed', mergedAt))
  const merged = ticket(root.id)
  expect(merged.ended).toEqual({ at: mergedAt, by: 'executor', outcome: 'merged' })
  expect(approved(root.id)).toBe(true)
  expect(aggregateOf(root.id)!.reviewRevision).toBe(before.reviewRevision)
  expect(children(root.id).map(child => child.ended?.outcome)).toEqual(['completed', 'completed'])
  // The tree now reads the root as done and still shows the accepted review, not a second confirmation or a live task.
  const after = await host.api('GET', `tasks/${root.id}?depth=1`)
  expect((after.body.task as { status: string; terminal?: string; review: { accepted?: { reviewRevision: string } } }).status).toBe('done')
  expect((after.body.task as { review: { accepted?: { reviewRevision: string } } }).review.accepted).toMatchObject({
    reviewRevision: before.reviewRevision })
})