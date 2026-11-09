/** The authorization contract for child Tickets: they never become an authorization root or a person-facing node. */
import { describe, expect, it } from 'vitest'
import { Engine, MemoryRepositories, UserError, outboundAction, type Policy, type Ticket } from '@superagent/kernel'
import { requestActionApproval } from '@superagent/dsh/app/action-gate.ts'
import { ApprovalPolicySchema } from '@superagent/dsh/policy.ts'

const actor = { source: 'chat', id: 'alice' }
const root: Ticket = {
  id: 'root', title: 'Root', decisionId: 'd1',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor, scope: 'root', maxActionLevel: 'send' },
  channels: [], assignments: [{ id: 'root-a', state: 'running', createdAt: '2026-09-23T00:00:00.000Z' }], inputs: [], undelivered: [],
  createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z', origin: { triggerId: 't', triggerIds: ['t'] },
  execution: { name: 'root', directory: '/work/root', assignment: 'root' }, form: 'tracked',
}
const policy: Policy = {
  version: 'v1', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: false, reason: 'not human' }),
  revalidate: () => ({ ok: true }), mandateLimits: () => ({ maxActionLevel: 'send' }), admitsInferred: () => false,
}
function engine() {
  const repo = new MemoryRepositories()
  const tickets = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: () => {}, release: () => {} },
    executor: { start: () => {}, deliver: () => {}, stop: () => {} },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {}, recall: () => 'recalled' },
    now: () => '2026-09-23T00:00:01.000Z' })
  repo.tickets.save(root)
  const child = tickets.delegate('root', { goal: 'child work' })
  return { repo, engine: tickets, child }
}

describe('child Tickets are not an authorization root', () => {
  it('carries no Mandate or Decision and refuses a person-facing reply', () => {
    const h = engine()
    const child = h.repo.tickets.get(h.child.id)!
    expect(child.mandate).toBeUndefined()
    expect(child.decisionId).toBeUndefined()
    expect(() => h.engine.reply({ purpose: 'result', ticketId: child.id, text: 'done' })).toThrow(UserError)
    try { h.engine.reply({ purpose: 'result', ticketId: child.id, text: 'done' }) } catch (error) {
      expect((error as UserError).code).toBe('notAuthorizationRoot')
    }
  })

  it('refuses an external action at the gate instead of borrowing the root Mandate', () => {
    const h = engine()
    const child = h.repo.tickets.get(h.child.id)!
    const outcome = requestActionApproval(h.repo, {
      ticket: child, policy, approvalPolicy: ApprovalPolicySchema.parse({}),
      action: outboundAction({ kind: 'reply', source: 'chat', objectId: 'm1', revision: '1', actor }),
      now: () => '2026-09-23T00:00:02.000Z',
    })
    expect(outcome).toEqual({ kind: 'refused', reason: { code: 'notAuthorizationRoot' } })
  })

  it('attributes a root Approval to the root and never to a child', () => {
    const h = engine()
    const outcome = requestActionApproval(h.repo, {
      ticket: h.repo.tickets.get('root')!, policy, approvalPolicy: ApprovalPolicySchema.parse({}),
      action: outboundAction({ kind: 'reply', source: 'chat', objectId: 'm1', revision: '1', actor }),
      now: () => '2026-09-23T00:00:02.000Z',
    })
    expect(outcome.kind).toBe('pending')
    if (outcome.kind !== 'pending') throw new Error('expected a pending approval')
    expect(outcome.approval).toMatchObject({ ticketId: 'root', originTicketId: 'root' })
    expect(outcome.approval).not.toHaveProperty('requestedForTicketId')
    expect(h.repo.approvals.byTicket('root')).toHaveLength(1)
    expect(h.repo.approvals.byTicket(h.child.id)).toEqual([])
  })
})
