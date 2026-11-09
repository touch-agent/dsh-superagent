import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, latestAssignment, type Assignment, type EngineOptions, type Policy, type Ticket } from '@superagent/kernel'

const rootActor = { source: 'chat', id: 'alice' }
const owner = { source: 'dsh-superagent', id: 'worker-root' }

function rootTicket(id = 'root'): Ticket {
  return {
    id, title: 'Root task', decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: rootActor, scope: 'root',
      maxActionLevel: 'send' },
    channels: [], assignments: [{ id: 'root-assignment', state: 'pending', createdAt: '2026-09-23T00:00:00.000Z' }], inputs: [], undelivered: [], createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z', origin: { triggerId: 'trigger-root', triggerIds: ['trigger-root'] },
    execution: { name: 'root', directory: '/work/root', assignment: 'do the root task' }, form: 'tracked',
  }
}

function harness() {
  const repo = new MemoryRepositories()
  const launches: [Ticket, Assignment][] = []
  const starts: string[] = [], stops: string[] = [], delivers: string[] = []
  const executor = {
    start: vi.fn((ticket: Ticket, assignment: Assignment) => { launches.push([ticket, assignment]); starts.push(ticket.id) }),
    deliver: vi.fn((ticket: Ticket) => { delivers.push(ticket.id) }),
    stop: vi.fn((ticket: Ticket) => { stops.push(ticket.id) }),
  }
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: false, reason: 'not human' }), revalidate: () => ({ ok: true }),
    mandateLimits: () => ({ maxActionLevel: 'send' }), admitsInferred: () => false,
  }
  const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: () => {}, release: () => {} }, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {}, recall: () => 'recalled' },
    now: () => '2026-09-23T00:00:01.000Z' } satisfies EngineOptions)
  const root = rootTicket()
  repo.tickets.save(root)
  const start = (ticketId: string) => {
    const ticket = repo.tickets.get(ticketId)!
    const assignment = latestAssignment(ticket)!
    engine.assignmentStarted(ticketId, assignment.id)
    return repo.tickets.get(ticketId)!
  }
  const delegate = (parentId: string, goal: string, extra: { replaces?: string } = {}) => {
    const child = engine.delegate(parentId, { goal, scope: `${goal} scope`, ...extra })
    return start(child.id)
  }
  return { repo, engine, root, launches, starts, stops, delivers, start, delegate }
}

describe('child ticket delegation', () => {
  it('creates tracked children under the same root without a Mandate or Decision', () => {
    const h = harness()
    const a = h.delegate('root', 'child A')
    const b = h.delegate('root', 'child B')
    expect(a.parentTicketId).toBe('root')
    expect(a.rootTicketId).toBe('root')
    expect(a.decisionId).toBeUndefined()
    expect(a.mandate).toBeUndefined()
    expect(a.form).toBe('tracked')
    expect(a.delegation).toMatchObject({ parentTicketId: 'root', rootTicketId: 'root', attempt: 1, goal: 'child A' })
    expect(a.execution?.directory).toBe('/work/root/child-1')
    expect(b.execution?.directory).toBe('/work/root/child-2')
    expect(a.assignments[0]).toMatchObject({ attempt: 1, state: 'running' })
    expect(h.starts).toEqual([a.id, b.id])
    expect(h.repo.tickets.childrenOf('root').map(child => child.id)).toHaveLength(2)
    expect(h.repo.tickets.childrenOf('root').map(child => child.id)).toEqual(expect.arrayContaining([a.id, b.id]))
    expect(h.repo.tickets.open().map(ticket => ticket.id)).toEqual(['root'])
    expect(h.repo.tickets.allOpen().map(ticket => ticket.id)).toHaveLength(3)
    expect(h.repo.tickets.allOpen().map(ticket => ticket.id)).toEqual(expect.arrayContaining(['root', a.id, b.id]))
  })

  it('sends a child ready report to its parent owner without ending or paging', () => {
    const h = harness()
    const child = h.delegate('root', 'child A')
    h.start('root')
    const input = h.engine.report(child.id, { state: 'ready', summary: 'child done', assignmentId: child.assignments[0]!.id })
    expect(input.ended).toBeUndefined()
    expect(input.attention).toBeUndefined()
    const parent = h.repo.tickets.get('root')!
    expect(parent.inputs).toContainEqual(expect.objectContaining({ kind: 'child-report', childTicketId: child.id, state: 'ready' }))
    expect(parent.undelivered).toHaveLength(1)
    expect(h.delivers).toContain('root')

    const accepted = h.engine.acceptChild('root', child.id, owner)
    expect(accepted.ended).toMatchObject({ outcome: 'completed' })
    expect(accepted.delegation?.resolution).toMatchObject({ kind: 'accepted', acceptedAttempt: 1, by: owner })
    expect(h.repo.tickets.get('root')!.ended).toBeUndefined()
  })

  it('refuses a root ready report while a direct child is unresolved', () => {
    const h = harness()
    h.delegate('root', 'child A')
    expect(() => h.engine.report('root', { state: 'ready', summary: 'root done' })).toThrow(UserError)
    try { h.engine.report('root', { state: 'ready', summary: 'root done' }) } catch (error) {
      expect((error as UserError).code).toBe('unfinishedChildTickets')
    }
    expect(h.repo.tickets.get('root')!.ended).toBeUndefined()
  })

  it('returns a child for another attempt and refuses a late report from the replaced one', () => {
    const h = harness()
    const child = h.delegate('root', 'child A')
    const old = child.assignments[0]!.id
    h.engine.report(child.id, { state: 'ready', summary: 'first try', assignmentId: old })
    const returned = h.engine.returnChild('root', child.id, owner, 'try again')
    expect(returned.delegation?.attempt).toBe(2)
    expect(returned.assignments).toHaveLength(2)
    expect(returned.assignments[0]!.state).toBe('ended')
    expect(h.stops).toContain(child.id)
    expect(() => h.engine.report(child.id, { state: 'ready', summary: 'too late', assignmentId: old })).toThrow(UserError)
    try { h.engine.report(child.id, { state: 'ready', summary: 'too late', assignmentId: old }) } catch (error) {
      expect((error as UserError).code).toBe('staleChildAttempt')
    }
  })

  it('cancels a child subtree and refuses a person acting on a child', () => {
    const h = harness()
    const child = h.delegate('root', 'child A')
    const grandchild = h.delegate(child.id, 'grandchild')
    const cancelled = h.engine.cancelChild('root', child.id, owner, 'not needed')
    expect(cancelled.ended).toMatchObject({ outcome: 'stopped' })
    expect(cancelled.delegation?.resolution).toMatchObject({ kind: 'cancelled' })
    expect(h.repo.tickets.get(grandchild.id)!.ended).toMatchObject({ outcome: 'stopped' })
    expect(() => h.engine.stopTicket(child.id)).toThrow(UserError)
    expect(() => h.engine.retryTicket(child.id)).toThrow(UserError)
    expect(() => h.engine.reviewTicket(child.id, rootActor)).toThrow(UserError)
  })

  it('enforces the direct-child width, depth and live-child quota caps', () => {
    const h = harness()
    for (let i = 0; i < 8; i++) h.delegate('root', `width ${i}`)
    try { h.engine.delegate('root', { goal: 'too wide' }) } catch (error) {
      expect((error as UserError).code).toBe('delegationWidthExceeded')
    }

    const deep = harness()
    let parent = 'root'
    for (let depth = 1; depth <= 5; depth++) parent = deep.delegate(parent, `depth ${depth}`).id
    try { deep.engine.delegate(parent, { goal: 'too deep' }) } catch (error) {
      expect((error as UserError).code).toBe('delegationDepthExceeded')
    }

    const quota = harness()
    const branches = Array.from({ length: 4 }, (_, index) => quota.delegate('root', `branch ${index}`))
    const fills = [8, 8, 7, 4]
    for (const [index, branch] of branches.entries()) for (let i = 0; i < fills[index]!; i++) quota.delegate(branch.id, `leaf ${index}-${i}`)
    quota.delegate(branches[2]!.id, 'fills the quota')
    try { quota.engine.delegate(branches[3]!.id, { goal: 'over quota' }) } catch (error) {
      expect((error as UserError).code).toBe('delegationQuotaExceeded')
    }
  })

  it('defers a thread end until the last child is resolved, then applies it', () => {
    const h = harness()
    const root = h.repo.tickets.get('root')!
    root.follows = [{ thread: 'github:1', own: true }]
    h.repo.tickets.save(root)
    const child = h.delegate('root', 'child A')
    h.start('root')
    h.engine.report('root', { state: 'progress', summary: 'delegated' })
    h.engine.threadClosed({ source: 'github', id: '1' }, 'merged', '2026-09-23T00:00:02.000Z')
    const pending = h.repo.tickets.get('root')!
    expect(pending.ended).toBeUndefined()
    expect(pending.endPending).toMatchObject({ outcome: 'merged' })
    expect(pending.inputs).toContainEqual(expect.objectContaining({ kind: 'end-gate' }))

    h.engine.report(child.id, { state: 'ready', summary: 'child done' })
    h.engine.acceptChild('root', child.id, owner)
    h.engine.report('root', { state: 'ready', summary: 'root done' })
    expect(h.repo.tickets.get('root')!.ended).toMatchObject({ outcome: 'merged' })
  })

  it('orphans a child once when its parent is gone, with a person attention on the root', () => {
    const h = harness()
    const child = h.delegate('root', 'child A')
    const parent = h.repo.tickets.get('root')!
    h.repo.tickets.save({ ...parent, ended: { at: '2026-09-23T00:00:03.000Z', by: 'executor', outcome: 'dropped' } })
    h.engine.report(child.id, { state: 'ready', summary: 'late' })
    const orphan = h.repo.tickets.get(child.id)!
    expect(orphan.delegation?.orphaned).toBeDefined()
    expect(orphan.ended).toBeUndefined()
    const attention = orphan.attention
    expect(attention?.question).toContain(child.id)
    expect(orphan.assignments[0]!.state).toBe('ended')
    expect(h.stops).toContain(child.id)
  })

  it('does not let a child act as an authorization root toward people or Threads', () => {
    const h = harness()
    const child = h.delegate('root', 'child A')
    const code = (work: () => unknown) => {
      try { work() } catch (error) { return (error as UserError).code }
      return undefined
    }
    expect(code(() => h.engine.reply({ purpose: 'result', ticketId: child.id, text: 'done' }))).toBe('notAuthorizationRoot')
    expect(code(() => h.engine.bindThread(child.id, { source: 'github', id: '8' }, true))).toBe('childRequiresParent')
    expect(code(() => h.engine.retryTicket(child.id))).toBe('childRequiresParent')
  })

  it('cancels the whole subtree when a person stops the root', () => {
    const h = harness()
    const child = h.delegate('root', 'child A')
    const grandchild = h.delegate(child.id, 'grandchild')
    h.engine.stopTicket('root')
    expect(h.repo.tickets.get('root')!.ended).toMatchObject({ outcome: 'stopped', by: 'human' })
    expect(h.repo.tickets.get(child.id)!.ended).toMatchObject({ outcome: 'stopped' })
    expect(h.repo.tickets.get(grandchild.id)!.ended).toMatchObject({ outcome: 'stopped' })
  })
})
