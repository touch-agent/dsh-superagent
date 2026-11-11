/**
 * T5-06 observation: the organization and attention figures must come from stored domain rows, not a task view, and a
 * missing browser-side sample must be `not-collected`, never a zero. The test seeds a small task tree directly in the
 * Store so each figure can be checked against a known shape.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Assignment, Delegation, Ticket } from '@superagent/kernel'
import { attentionMetrics, organizationMetrics } from '@superagent/dsh/app/replacement.ts'
import { Store } from '@superagent/dsh/app/store.ts'

const directories: string[] = []
function store(): Store {
  const directory = mkdtempSync(join(tmpdir(), 'replacement-metrics-'))
  directories.push(directory)
  return new Store(join(directory, 'orchestrator.sqlite'))
}
afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true })
})

const BY = { source: 'dsh-superagent', id: 'parent-owner' }
const at = (second: number) => new Date(Date.UTC(2026, 10, 11, 0, 0, second)).toISOString()
const assignment = (id: string, state: Assignment['state'], report?: Assignment['report']): Assignment =>
  ({ id, state, attempt: 1, ...(report ? { report } : {}) }) as unknown as Assignment
const delegation = (extra: Partial<Delegation> = {}): Delegation => ({
  parentTicketId: 'root', rootTicketId: 'root', goal: 'drill', requestedBy: { ticketId: 'root', sessionId: 's' },
  attempt: 1, createdAt: at(0), ...extra,
})
function ticket(id: string, extra: Partial<Ticket> = {}): Ticket {
  return { id, title: id, form: 'tracked', source: 'conversation', createdAt: at(0), updatedAt: at(0),
    inputs: [], undelivered: [], assignments: [], follows: [], subscriptions: [], ...extra } as unknown as Ticket
}

/** A root with one running child, one accepted child, a grandchild, and an orphaned child. */
function seed(store: Store): void {
  const childReport = (id: string) => ({ state: 'ready' as const, summary: id, at: at(1) })
  store.tickets.save(ticket('root', {
    ended: { by: 'executor', outcome: 'completed', at: at(9) }, decisionId: 'd1',
    assignments: [assignment('a-root', 'ended', { state: 'ready', summary: 'root', at: at(8) })],
  }))
  const running: Delegation = delegation({
    dispositions: [
      { childTicketId: 'c1', attempt: 1, reportAt: at(2), decision: 'returned', by: BY, at: at(5), traceId: 't1' },
      { childTicketId: 'c1', attempt: 1, reportAt: at(3), decision: 'accepted', by: BY, at: at(10), traceId: 't1' },
    ],
  })
  store.tickets.save(ticket('c1', { parentTicketId: 'root', rootTicketId: 'root', delegation: running,
    assignments: [assignment('a1', 'running')] }))
  store.tickets.save(ticket('c2', {
    parentTicketId: 'root', rootTicketId: 'root', ended: { by: 'executor', outcome: 'completed', at: at(7) },
    assignment: undefined,
    delegation: delegation({
      dispositions: [{ childTicketId: 'c2', attempt: 1, reportAt: at(1), decision: 'accepted', by: BY, at: at(20), traceId: 't2' }],
      resolution: { kind: 'accepted', by: BY, at: at(7), acceptedReportAt: at(1), acceptedAttempt: 1 },
    }),
    assignments: [assignment('a2', 'ended', childReport('c2'))],
  }))
  store.tickets.save(ticket('gc', {
    parentTicketId: 'c1', rootTicketId: 'root', ended: { by: 'executor', outcome: 'completed', at: at(6) },
    delegation: delegation({ parentTicketId: 'c1', disposition: undefined,
      dispositions: [{ childTicketId: 'gc', attempt: 1, reportAt: at(1), decision: 'accepted', by: BY, at: at(8), traceId: 't3' }],
      resolution: { kind: 'accepted', by: BY, at: at(6), acceptedReportAt: at(1), acceptedAttempt: 1 } }),
    assignments: [assignment('a3', 'ended', childReport('gc'))],
  }))
  store.tickets.save(ticket('c3', { parentTicketId: 'root', rootTicketId: 'root',
    delegation: delegation({ orphaned: { reason: 'parent unavailable', at: at(4), by: BY } }) }))
}

describe('organization metrics', () => {
  it('counts depth, active children, review waits and orphans from stored tickets', () => {
    const db = store()
    seed(db)
    const view = organizationMetrics(db)
    expect(view.tickets).toMatchObject({ roots: 1, children: 4, open: 2, openChildren: 2, maxDepth: 2, medianDepth: 1,
      depthDistribution: { '0': 1, '1': 3, '2': 1 } })
    expect(view.children).toMatchObject({ active: 1, maxActivePerRoot: 1, rootsWithActiveChildren: 1, orphaned: 1, unresolved: 2 })
    expect(view.parentReview).toMatchObject({ samples: 4, medianSeconds: 7, p90Seconds: 19 })
    db.close()
  })

  it('reports an empty Store as no samples, not a healthy zero', () => {
    const db = store()
    const view = organizationMetrics(db)
    expect(view.tickets).toMatchObject({ roots: 0, children: 0, maxDepth: 0, medianDepth: null })
    expect(view.parentReview).toEqual({ samples: 0, medianSeconds: null, p90Seconds: null })
    db.close()
  })
})

describe('attention metrics', () => {
  it('attributes a root result\'s messages and notices, and marks browser-only measures not-collected', () => {
    const db = store()
    seed(db)
    const receipts = [
      { id: 'm1', kind: 'acknowledgement', ticketId: 'root', text: 'ack', channel: { source: 'conversation', thread: 't' }, status: 'sent' },
      { id: 'm2', kind: 'reply', ticketId: 'root', text: 'result', channel: { source: 'conversation', thread: 't' }, status: 'sent' },
      { id: 'm3', kind: 'reply', ticketId: 'c1', text: 'child', channel: { source: 'conversation', thread: 't' }, status: 'sent' },
      { id: 'm4', kind: 'notice', ticketId: 'root', text: 'notice', channel: { source: 'conversation', thread: 't' }, status: 'sent' },
      { id: 'm5', kind: 'reply', text: 'untracked', channel: { source: 'conversation', thread: 't' }, status: 'sent' },
    ]
    for (const receipt of receipts) db.db.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run(receipt.id, JSON.stringify(receipt))
    for (const level of ['quiet', 'quiet', 'feed', 'feed', 'feed', 'notice', 'notice'] as const) {
      db.activity.record({ seq: 0, at: at(0), event: 'ticket.ended', level, summary: level, ticket: 'root' })
    }
    const view = attentionMetrics(db)
    expect(view.results).toBe(1)
    expect(view.notifications).toEqual({ sends: 3, perResult: 3, kinds: { acknowledgement: 1, reply: 1, notice: 1 } })
    expect(view.activity).toEqual({ quiet: 2, feed: 3, notice: 2, noticesPerResult: 2 })
    expect(view.autoOpen).toMatchObject({ samples: 0, closeRate: null, status: 'not-collected' })
    expect(view.clickDepth).toMatchObject({ samples: 0, medianClicks: null, status: 'not-collected' })
    db.close()
  })

  it('reports no ratio for an empty Store', () => {
    const db = store()
    expect(attentionMetrics(db)).toMatchObject({ results: 0,
      notifications: { sends: 0, perResult: null }, activity: { noticesPerResult: null } })
    db.close()
  })
})
