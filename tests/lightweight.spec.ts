/**
 * Lightweight tickets: an accept that runs inline, without an Assignment or a Session, whose action sequence is the audit
 * ledger. The tests drive the kernel through the same in-memory repositories the other domain tests use and assert what a
 * tracked ticket still does, that the inline path records its actions in the trace and its take-up in the disposition, and
 * that actions above `draft` stay with tracked work (R5).
 */
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, createAction, ticketForm, traceId } from '@superagent/kernel'
import type { ActionLevel, Assessor, Assignment, Candidate, EngineOptions, Executor, InlineExecutor, InlineStep, Outbox, Policy, Span,
  Ticket, TraceSink, Trigger } from '@superagent/kernel'

const member = { source: 'chat', id: 'alice' }
const at = '2026-09-23T00:00:00.000Z'
const later = (seconds: number): string => new Date(Date.parse(at) + seconds * 1000).toISOString()
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`,
    text: `message ${id}`, channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}
/** An Action of `level` on one spreadsheet cell; its idempotency key is what the action ledger names. */
function action(level: ActionLevel, revision = 'r1') {
  return createAction({ kind: 'sheet.cell', source: 'feishu', objectId: 'doc-1', revision, actor: member, level })
}
const step = (level: ActionLevel, seconds: number, overrides: Partial<InlineStep> = {}): InlineStep =>
  ({ action: action(level), at: later(seconds), ok: true, ...overrides })

interface Hooks { inline?: boolean; prepareTicket?: EngineOptions['prepareTicket'] }

/** An Engine on in-memory repositories whose inline executor and trace sink collect what the Engine hands them. */
function harness({ inline = true, prepareTicket }: Hooks = {}) {
  const repo = new MemoryRepositories()
  const spans: Span[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) } }
  const launches: [Ticket, Assignment][] = []
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }), deliver: vi.fn(), stop: vi.fn(),
  }
  const inlineStarts: Ticket[] = []
  const inlineStops: [string, string][] = []
  const inlineExecutor: InlineExecutor = { start: ticket => { inlineStarts.push(ticket) }, stop: (ticket, reason) => { inlineStops.push([ticket.id, reason]) } }
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => ({ ok: true }),
    mandateLimits: () => ({ maxActionLevel: 'send' }), admitsInferred: () => true,
  }
  const outbox: Outbox = { send: () => {}, status: () => undefined, withdraw: () => {}, recall: () => 'recalled' }
  const trace: TraceSink = { record: span => { spans.push(span) } }
  const engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor,
    ...inline ? { inline: inlineExecutor } : {}, outbox, trace, ...prepareTicket ? { prepareTicket } : {}, now: () => at })
  /** Accept the queued Trigger, choosing the lightweight form when `form` says so. */
  const accept = (form?: 'lightweight') => {
    engine.receive(trigger('1'))
    engine.evaluateDue()
    const candidate = requests.at(-1)!
    return engine.decide('1', { kind: 'accept', title: 'Draft a cell edit', scope: 'Draft one cell edit', reason: 'requested',
      acknowledgement: 'On it.', evalId: candidate.evalId, ...form ? { form } : {} })
  }
  return { repo, engine, spans, requests, accepts: accept, launches, executor, inlineStarts, inlineStops, inlineExecutor }
}

describe('a lightweight ticket', () => {
  it('is accepted without an Assignment or a worker Session, and its accept is recorded as before', () => {
    const h = harness()
    const decision = h.accepts('lightweight')
    const ticket = h.repo.tickets.get(decision.ticketId!)!

    expect(ticket).toMatchObject({ form: 'lightweight', assignments: [] })
    expect(h.launches).toEqual([])
    expect(h.executor.start).not.toHaveBeenCalled()
    expect(h.inlineStarts).toEqual([expect.objectContaining({ id: ticket.id, form: 'lightweight', assignments: [] })])
    // The disposition that carried the accept still names its Decision, and the dispatch stage says how it runs.
    expect(h.repo.triggers.disposition('1')).toMatchObject({ decisionId: decision.id })
    expect(h.spans.filter(span => span.kind === 'dispatch')).toEqual([
      expect.objectContaining({ data: { ticketId: ticket.id, form: 'lightweight' } }),
    ])
  })

  it('records each action in the trace as it runs, takes the request up in the disposition, and ends with the result', () => {
    const h = harness()
    const started = performance.now()
    const decision = h.accepts('lightweight')
    const id = decision.ticketId!
    const steps = [step('read', 1), step('draft', 2, { action: action('draft', 'r2') })]
    for (const item of steps) h.engine.inlineAction(id, item)
    const finished = h.engine.inlineFinished(id, { outcome: 'completed', summary: 'Drafted the cell edit' })
    const elapsed = performance.now() - started

    // One action span per step, in the order the actions ran, under the same Trigger trace.
    const actions = h.spans.filter(span => span.kind === 'action' && span.data?.ticketId === id)
    expect(actions.map(span => span.at)).toEqual(steps.map(item => item.at))
    expect(actions.map(span => span.data)).toEqual([
      expect.objectContaining({ ticketId: id, action: expect.objectContaining({ kind: 'sheet.cell', level: 'read', revision: 'r1' }), ok: true }),
      expect.objectContaining({ ticketId: id, action: expect.objectContaining({ kind: 'sheet.cell', level: 'draft', revision: 'r2' }), ok: true }),
    ])
    expect(new Set(actions.map(span => span.traceId))).toEqual(new Set([traceId('1')]))
    // The report follows the actions, and the disposition says the ticket took the person's message up.
    expect(h.spans.slice(-3).map(span => span.kind)).toEqual(['action', 'action', 'report'])
    expect(h.spans.at(-1)).toMatchObject({ data: { ticketId: id, state: 'completed', form: 'lightweight' } })
    expect(h.repo.triggers.disposition('1')?.acked).toEqual([id])
    expect(finished).toMatchObject({ form: 'lightweight', assignments: [], ended: { by: 'executor', outcome: 'completed', reason: 'Drafted the cell edit' } })
    expect(h.inlineStops).toEqual([[id, 'Drafted the cell edit']])
    // The inline path stays inside its ten-second budget: no Session, no launch and no preparation runs.
    expect(elapsed).toBeLessThan(10_000)
    expect(h.launches).toEqual([])
  })

  it('ends `dropped` when there was nothing to do, still taking the message up', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    const finished = h.engine.inlineFinished(id, { outcome: 'dropped', summary: 'Nothing to change' })
    expect(finished.ended).toMatchObject({ by: 'executor', outcome: 'dropped', reason: 'Nothing to change' })
    expect(h.repo.triggers.disposition('1')?.acked).toEqual([id])
    expect(h.spans.filter(span => span.kind === 'action')).toEqual([])
    expect(h.spans.at(-1)).toMatchObject({ kind: 'report', data: { state: 'dropped' } })
  })

  it('refuses a commit, send or spend action, which needs a tracked ticket and a worker Session (R5)', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    expect(() => h.engine.inlineAction(id, step('send', 1))).toThrow(TypeError)
    const ticket = h.repo.tickets.get(id)!
    expect(ticket.ended).toBeUndefined()
    expect(ticket.form).toBe('lightweight')
    expect(h.spans.filter(span => span.kind === 'action' || span.kind === 'report')).toEqual([])
    expect(h.inlineStops).toEqual([])
  })

  it('refuses the lightweight form when the deployment has no inline executor, and rolls the accept back', () => {
    const h = harness({ inline: false })
    expect(() => h.accepts('lightweight')).toThrow(TypeError)
    expect(h.repo.tickets.list()).toEqual([])
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.executor.start).not.toHaveBeenCalled()
  })

  it('refuses an inline result that names an Input the ticket does not own', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    expect(() => h.engine.inlineFinished(id, { outcome: 'completed', summary: 'Impossible', read: ['not-an-input'] })).toThrow(TypeError)
    expect(h.repo.tickets.get(id)!.ended).toBeUndefined()
    expect(h.spans.filter(span => span.kind === 'report')).toEqual([])
  })

  it('resumes a person\'s follow-up inline, still without an Assignment, and takes the follow-up up', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    h.engine.inlineAction(id, step('draft', 1))
    h.engine.inlineFinished(id, { outcome: 'completed', summary: 'First action done' })
    expect(h.inlineStarts).toHaveLength(1)

    h.engine.receive(trigger('2', { at: later(60) }))
    h.engine.evaluateDue()
    const resumed = h.repo.tickets.get(id)!
    expect(resumed.ended).toBeUndefined()
    expect(ticketForm(resumed)).toBe('lightweight')
    expect(resumed.assignments).toEqual([])
    expect(h.inlineStarts).toHaveLength(2)
    expect(h.inlineStarts[1]).toMatchObject({ id, form: 'lightweight' })
    expect(h.inlineStarts[1]!.undelivered.length).toBeGreaterThan(0)
    expect(h.spans.filter(span => span.kind === 'dispatch').length).toBe(2)

    // The resumed run read what it was handed, so the follow-up is taken up instead of going back to Eval as new work.
    const read = h.inlineStarts[1]!.undelivered
    h.engine.inlineAction(id, step('draft', 2))
    h.engine.inlineFinished(id, { outcome: 'completed', summary: 'Follow-up done', read })
    expect(h.repo.triggers.disposition('2')?.acked).toEqual([id])
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual([])
    h.engine.evaluateDue()
    expect(h.requests).toHaveLength(1)
  })
})

describe('a tracked ticket', () => {
  it('keeps its Assignment and stays the default form', () => {
    const h = harness()
    const decision = h.accepts()
    const ticket = h.repo.tickets.get(decision.ticketId!)!
    expect(ticket).toMatchObject({ form: 'tracked' })
    expect(ticket.assignments).toHaveLength(1)
    expect(h.launches).toHaveLength(1)
    expect(h.executor.start).toHaveBeenCalledOnce()
    expect(h.inlineStarts).toEqual([])
  })

  it('can be chosen through prepareTicket, so a deployment may decide the form after the accept', () => {
    const h = harness({ prepareTicket: ticket => ({ ...ticket, form: 'lightweight' }) })
    const decision = h.accepts()
    expect(h.repo.tickets.get(decision.ticketId!)?.form).toBe('lightweight')
    expect(h.inlineStarts).toHaveLength(1)
    expect(h.launches).toEqual([])
  })
})