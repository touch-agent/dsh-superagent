import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, reviewAggregate, reviewNeedsApproval, reviewApproved, UserError, latestAssignment,
  type Assignment, type EngineOptions, type Policy, type Ticket } from '@superagent/kernel'

const person = { source: 'chat', id: 'alice' }
const owner = { source: 'dsh-superagent', id: 'worker-root' }

function rootTicket(): Ticket {
  return {
    id: 'root', title: 'Root task', decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: person, scope: 'root', maxActionLevel: 'send' },
    channels: [], assignments: [{ id: 'root-assignment', state: 'pending', createdAt: '2026-09-23T00:00:00.000Z' }], inputs: [],
    undelivered: [], createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
    origin: { triggerId: 'trigger-root', triggerIds: ['trigger-root'] },
    execution: { name: 'root', directory: '/work/root', assignment: 'do the root task' }, form: 'tracked',
  }
}

function harness() {
  const repo = new MemoryRepositories()
  const executor = { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() }
  const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: false, reason: 'not human' }), revalidate: () => ({ ok: true }),
    mandateLimits: () => ({ maxActionLevel: 'send' }), admitsInferred: () => false }
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: () => {}, release: () => {} }, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {}, recall: () => 'recalled' },
    now: () => '2026-09-23T00:00:01.000Z' } satisfies EngineOptions)
  repo.tickets.save(rootTicket())
  const start = (id: string) => {
    const ticket = repo.tickets.get(id)!
    engine.assignmentStarted(id, latestAssignment(ticket)!.id)
    return repo.tickets.get(id)!
  }
  const delegate = (parent: string, goal: string) => start(engine.delegate(parent, { goal, scope: `${goal} scope` }).id)
  const aggregate = (id: string) => reviewAggregate(repo.tickets.get(id)!, value => repo.tickets.get(value),
    value => repo.tickets.childrenOf(value))
  return { repo, engine, start, delegate, aggregate }
}

const deliverable = (revision: string, criteria: { kind: 'rule'; rule: string }[] | { kind: 'human'; reason: string }[]) => ({
  artifact: { kind: 'document' as const, ref: 'docs/review.md', revision },
  previewRef: { kind: 'text/redline' as const, ref: `https://example.test/${revision}`, revision },
  acceptanceCriteria: criteria,
})

describe('review aggregate', () => {
  it('deduplicates a parent and accepted child delivery by artifact revision and keeps both person confirmations', () => {
    const h = harness()
    h.start('root')
    const child = h.delegate('root', 'child A')
    h.engine.report(child.id, { state: 'ready', summary: 'child done', deliverable: deliverable('rev-1', [
      { kind: 'human', reason: 'Check the child tone' }]) })
    h.engine.acceptChild('root', child.id, owner)
    h.engine.report('root', { state: 'ready', summary: 'root done', deliverable: deliverable('rev-1', [
      { kind: 'human', reason: 'Check the root tone' }]) })

    const aggregate = h.aggregate('root')!
    expect(aggregate.deliverables).toHaveLength(1)
    expect(aggregate.deliverables[0]).toMatchObject({ key: 'document:docs/review.md:rev-1', parentAccepted: { by: owner } })
    expect(aggregate.deliverables[0]!.sources).toHaveLength(2)
    expect(aggregate.confirmations).toHaveLength(2)
    expect(aggregate.confirmations.map(item => item.source.ticketId).sort()).toEqual([child.id, 'root'].sort())
    expect(aggregate.reviewRevision).toBe(h.aggregate('root')!.reviewRevision)
    expect(reviewNeedsApproval(h.repo.tickets.get('root')!, value => h.repo.tickets.get(value), value => h.repo.tickets.childrenOf(value))).toBe(true)
  })

  it('changes the review revision when a new accepted child adds a delivery, so an older approval is stale', () => {
    const h = harness()
    h.start('root')
    const child = h.delegate('root', 'child A')
    h.engine.report(child.id, { state: 'ready', summary: 'child done', deliverable: deliverable('rev-1', [
      { kind: 'human', reason: 'Check the child tone' }]) })
    h.engine.acceptChild('root', child.id, owner)
    h.engine.report('root', { state: 'ready', summary: 'root done', deliverable: deliverable('rev-1', [
      { kind: 'human', reason: 'Check the root tone' }]) })
    const before = h.aggregate('root')!.reviewRevision

    const second = h.delegate('root', 'child B')
    h.engine.report(second.id, { state: 'ready', summary: 'second done', deliverable: deliverable('rev-2', [
      { kind: 'human', reason: 'Check the second tone' }]) })
    h.engine.acceptChild('root', second.id, owner)
    const after = h.aggregate('root')!.reviewRevision
    expect(after).not.toBe(before)
    expect(() => h.engine.reviewTicket('root', person, before)).toThrow(new UserError('reviewStale', { revision: after }))
    expect(reviewApproved(h.repo.tickets.get('root')!, value => h.repo.tickets.get(value), value => h.repo.tickets.childrenOf(value))).toBe(false)

    const approved = h.engine.reviewTicket('root', person, after)
    expect(approved.ended).toMatchObject({ outcome: 'completed' })
    expect(latestAssignment(approved)!.report!.accepted).toMatchObject({ by: person, reviewRevision: after })
    expect(reviewApproved(approved, value => h.repo.tickets.get(value), value => h.repo.tickets.childrenOf(value))).toBe(true)
  })

  it('keeps a returned child delivery out of the aggregate until its next accepted report', () => {
    const h = harness()
    h.start('root')
    const child = h.delegate('root', 'child A')
    h.engine.report(child.id, { state: 'ready', summary: 'child done', deliverable: deliverable('rev-1', [
      { kind: 'human', reason: 'Check the child tone' }]) })
    h.engine.acceptChild('root', child.id, owner)
    const acceptedRevision = h.aggregate('root')!.reviewRevision
    h.engine.returnChild('root', child.id, owner, 'redo this')
    expect(h.aggregate('root')?.confirmations ?? []).toHaveLength(0)
    expect(h.aggregate('root')?.reviewRevision ?? '').not.toBe(acceptedRevision)
  })

  it('applies an approval to a later pull-request close instead of asking for a second approval', () => {
    const h = harness()
    h.start('root')
    h.engine.bindThread('root', { source: 'gh', id: 'pr-1' }, true)
    h.engine.report('root', { state: 'ready', summary: 'root done', deliverable: deliverable('rev-1', [
      { kind: 'human', reason: 'Check it' }]) })
    const revision = h.aggregate('root')!.reviewRevision
    const approved = h.engine.reviewTicket('root', person, revision)
    expect(approved.ended).toBeUndefined()
    h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'merged', '2026-09-23T00:00:02.000Z')
    const closed = h.repo.tickets.get('root')!
    expect(closed.ended).toMatchObject({ outcome: 'merged', at: '2026-09-23T00:00:02.000Z' })
    expect(closed.endPending).toBeUndefined()
  })

  it('does not count a parent owner acceptance as a person confirmation, so rule-only work ends without approval', () => {
    const h = harness()
    h.start('root')
    const child = h.delegate('root', 'child A')
    h.engine.report(child.id, { state: 'ready', summary: 'child done', deliverable: deliverable('rev-1', [
      { kind: 'rule', rule: 'pr.merged' }]) })
    h.engine.acceptChild('root', child.id, owner)
    const done = h.engine.report('root', { state: 'ready', summary: 'root done', deliverable: deliverable('rev-1', [
      { kind: 'rule', rule: 'pr.merged' }]) })
    expect(reviewNeedsApproval(done, value => h.repo.tickets.get(value), value => h.repo.tickets.childrenOf(value))).toBe(false)
    expect(done.ended).toMatchObject({ outcome: 'completed' })
    expect(h.aggregate('root')?.confirmations ?? []).toEqual([])
  })
})