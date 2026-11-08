/**
 * Lightweight tickets: an accept that runs inline, without an Assignment or a Session, whose action sequence is the audit
 * ledger. The tests drive the kernel through the same in-memory repositories the other domain tests use and assert what a
 * tracked ticket still does, that the inline path records its actions in the trace and its take-up in the disposition, that
 * a late callback from an earlier run cannot act on a later one, and that actions above `draft` stay with tracked work (R5).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, UserError, createAction, ticketForm, traceId } from '@superagent/kernel'
import type { ActionLevel, Assessor, Assignment, Candidate, EngineOptions, Executor, InlineExecutor, InlineStep, Outbox, Policy, Span,
  Ticket, TraceSink, Trigger } from '@superagent/kernel'
import { Store } from '@superagent/dsh/app/store.ts'
import { SqliteTraceSink } from '@superagent/dsh/app/trace.ts'

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

interface Hooks {
  inline?: boolean
  prepareTicket?: EngineOptions['prepareTicket']
  trace?: TraceSink
  maxActionLevel?: ActionLevel
  revalidate?: Policy['revalidate']
}

/** An Engine on in-memory repositories whose inline executor and trace sink collect what the Engine hands them. */
function harness({ inline = true, prepareTicket, trace: external, maxActionLevel = 'send', revalidate }: Hooks = {}) {
  const repo = new MemoryRepositories()
  const spans: Span[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) } }
  const launches: [Ticket, Assignment][] = []
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }), deliver: vi.fn(), stop: vi.fn(),
  }
  const inlineStarts: Ticket[] = []
  const runs: string[] = []
  const inlineStops: [string, string][] = []
  const inlineExecutor: InlineExecutor = {
    start: (ticket, run) => { inlineStarts.push(ticket); runs.push(run) },
    stop: (ticket, reason) => { inlineStops.push([ticket.id, reason]) },
  }
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: revalidate ?? (() => ({ ok: true })),
    mandateLimits: () => ({ maxActionLevel }), admitsInferred: () => true,
  }
  const outbox: Outbox = { send: () => {}, status: () => undefined, withdraw: () => {}, recall: () => 'recalled' }
  const trace: TraceSink = { record: span => { spans.push(span); external?.record(span) } }
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
  return { repo, engine, spans, requests, accepts: accept, launches, executor, inlineStarts, runs, inlineStops }
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
    expect(h.runs).toHaveLength(1)
    // The disposition that carried the accept still names its Decision, and the dispatch stage says how it runs.
    expect(h.repo.triggers.disposition('1')).toMatchObject({ decisionId: decision.id })
    expect(h.spans.filter(span => span.kind === 'dispatch')).toEqual([
      expect.objectContaining({ data: { ticketId: ticket.id, form: 'lightweight' } }),
    ])
  })

  it('records each action under its run, takes the request up in the disposition, and ends with the result', () => {
    const h = harness()
    const decision = h.accepts('lightweight')
    const id = decision.ticketId!
    const run = h.runs[0]!
    const steps = [step('read', 1), step('draft', 2, { action: action('draft', 'r2') })]
    for (const item of steps) h.engine.inlineAction(id, run, item)
    const finished = h.engine.inlineFinished(id, run, { outcome: 'completed', summary: 'Drafted the cell edit' })

    // One action span per step, in the order the actions ran, under the same Trigger trace, each with its own id.
    const actions = h.spans.filter(span => span.kind === 'action' && span.data?.ticketId === id)
    expect(actions.map(span => span.at)).toEqual(steps.map(item => item.at))
    expect(new Set(actions.map(span => span.id)).size).toBe(2)
    expect(actions.map(span => span.data)).toEqual([
      expect.objectContaining({ ticketId: id, action: expect.objectContaining({ kind: 'sheet.cell', level: 'read', revision: 'r1' }), ok: true }),
      expect.objectContaining({ ticketId: id, action: expect.objectContaining({ kind: 'sheet.cell', level: 'draft', revision: 'r2' }), ok: true }),
    ])
    expect(new Set(actions.map(span => span.traceId))).toEqual(new Set([traceId('1')]))
    // The report follows the actions, at or after the last one, and the disposition says the ticket took the message up.
    expect(h.spans.slice(-3).map(span => span.kind)).toEqual(['action', 'action', 'report'])
    const report = h.spans.at(-1)!
    expect(report.data).toMatchObject({ ticketId: id, state: 'completed', form: 'lightweight' })
    expect(Date.parse(report.at)).toBeGreaterThanOrEqual(Date.parse(steps.at(-1)!.at))
    expect(h.repo.triggers.disposition('1')?.acked).toEqual([id])
    expect(finished).toMatchObject({ form: 'lightweight', assignments: [], ended: { by: 'executor', outcome: 'completed', reason: 'Drafted the cell edit' } })
    expect(h.inlineStops).toEqual([])
    expect(h.launches).toEqual([])
  })

  it('keeps a repeated Action as one span per time it ran, with a failed step and its trimmed error', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    const run = h.runs[0]!
    const read = step('read', 1)
    h.engine.inlineAction(id, run, read)
    h.engine.inlineAction(id, run, { ...read, at: later(2), ok: false, error: 'x'.repeat(400) })
    h.engine.inlineFinished(id, run, { outcome: 'dropped', summary: 'Read only' })

    const actions = h.spans.filter(span => span.kind === 'action')
    expect(actions).toHaveLength(2)
    expect(actions.map(span => span.data?.ok)).toEqual([true, false])
    expect(String(actions[1]!.data?.error)).toHaveLength(300)
  })

  it('ends `dropped` when there was nothing to do, still taking the message up', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    const finished = h.engine.inlineFinished(id, h.runs[0]!, { outcome: 'dropped', summary: 'Nothing to change' })
    expect(finished.ended).toMatchObject({ by: 'executor', outcome: 'dropped', reason: 'Nothing to change' })
    expect(h.repo.triggers.disposition('1')?.acked).toEqual([id])
    expect(h.spans.filter(span => span.kind === 'action')).toEqual([])
    expect(h.spans.at(-1)).toMatchObject({ kind: 'report', data: { state: 'dropped' } })
    expect(h.inlineStops).toEqual([])
  })

  it('refuses a commit, send or spend action, which needs a tracked ticket and a worker Session (R5)', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    const run = h.runs[0]!
    expect(() => h.engine.inlineAction(id, run, step('send', 1))).toThrow(TypeError)
    const ticket = h.repo.tickets.get(id)!
    expect(ticket.ended).toBeUndefined()
    expect(ticket.form).toBe('lightweight')
    expect(h.spans.filter(span => span.kind === 'action' || span.kind === 'report')).toEqual([])
    expect(h.inlineStops).toEqual([])
  })

  it('refuses an action above the mandate ceiling, which the Policy still holds', () => {
    const h = harness({ maxActionLevel: 'read' })
    const id = h.accepts('lightweight').ticketId!
    expect(() => h.engine.inlineAction(id, h.runs[0]!, step('draft', 1))).toThrow(UserError)
    expect(h.spans.filter(span => span.kind === 'action')).toEqual([])
    expect(h.repo.tickets.get(id)!.ended).toBeUndefined()
  })

  it('refuses an action when the Policy no longer holds the mandate', () => {
    const h = harness({ revalidate: () => ({ ok: false, reason: { code: 'revoked' } }) })
    const id = h.accepts('lightweight').ticketId!
    expect(() => h.engine.inlineAction(id, h.runs[0]!, step('read', 1))).toThrow(UserError)
    expect(h.spans.filter(span => span.kind === 'action')).toEqual([])
  })

  it('refuses the lightweight form when the deployment has no inline executor, and rolls the accept back', () => {
    const h = harness({ inline: false })
    expect(() => h.accepts('lightweight')).toThrow(TypeError)
    expect(h.repo.tickets.list()).toEqual([])
    expect(h.repo.decisions.byThread('chat:t1')).toEqual([])
    expect(h.executor.start).not.toHaveBeenCalled()
  })

  it('refuses an inline result that names an Input the ticket does not own, or an end it cannot have', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    const run = h.runs[0]!
    expect(() => h.engine.inlineFinished(id, run, { outcome: 'completed', summary: 'Impossible', read: ['not-an-input'] })).toThrow(TypeError)
    expect(() => h.engine.inlineFinished(id, run, { outcome: 'merged', summary: 'Impossible' } as never)).toThrow(TypeError)
    expect(h.repo.tickets.get(id)!.ended).toBeUndefined()
    expect(h.spans.filter(span => span.kind === 'report')).toEqual([])
  })

  it('stops the inline executor when a person stops the ticket', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    h.engine.stopTicket(id, 'the person changed their mind')
    expect(h.repo.tickets.get(id)!.ended).toMatchObject({ by: 'human', outcome: 'stopped', reason: 'the person changed their mind' })
    expect(h.inlineStops).toEqual([[id, 'the person changed their mind']])
    expect(h.spans.filter(span => span.kind === 'report')).toEqual([])
  })

  it('refuses a late callback from an earlier run after a follow-up resumed the ticket', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    const first = h.runs[0]!
    h.engine.inlineFinished(id, first, { outcome: 'completed', summary: 'First action done' })
    h.engine.receive(trigger('2', { at: later(60) }))
    h.engine.evaluateDue()
    const second = h.runs[1]!
    expect(second).not.toBe(first)
    expect(h.repo.tickets.get(id)!.ended).toBeUndefined()
    expect(() => h.engine.inlineAction(id, first, step('draft', 3))).toThrow(TypeError)
    expect(() => h.engine.inlineFinished(id, first, { outcome: 'completed', summary: 'Stale' })).toThrow(TypeError)
    expect(h.repo.tickets.get(id)!.ended).toBeUndefined()
  })

  it('resumes a person\'s follow-up inline, still without an Assignment, and takes the follow-up up', () => {
    const h = harness()
    const id = h.accepts('lightweight').ticketId!
    h.engine.inlineAction(id, h.runs[0]!, step('draft', 1))
    h.engine.inlineFinished(id, h.runs[0]!, { outcome: 'completed', summary: 'First action done' })
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
    const run = h.runs[1]!
    const read = h.inlineStarts[1]!.undelivered
    h.engine.inlineAction(id, run, step('draft', 2))
    h.engine.inlineFinished(id, run, { outcome: 'completed', summary: 'Follow-up done', read })
    expect(h.repo.triggers.disposition('2')?.acked).toEqual([id])
    expect(h.repo.threads.get('chat:t1')?.pending).toEqual([])
    h.engine.evaluateDue()
    expect(h.requests).toHaveLength(1)
  })

  it('writes its ledger and report to the Store in the order they happened, keeping repeated Actions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-lightweight-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    try {
      const sink = new SqliteTraceSink(store)
      const h = harness({ trace: sink })
      const id = h.accepts('lightweight').ticketId!
      const run = h.runs[0]!
      const read = step('read', 1)
      // The same Action twice: the Store keeps both because the run and step position make each stage id unique.
      h.engine.inlineAction(id, run, read)
      h.engine.inlineAction(id, run, { ...read, at: later(2), ok: false })
      h.engine.inlineFinished(id, run, { outcome: 'completed', summary: 'Read twice' })
      const stored = sink.trace(traceId('1')).filter(span => span.data?.ticketId === id && (span.kind === 'action' || span.kind === 'report'))
      expect(stored.map(span => span.kind)).toEqual(['action', 'action', 'report'])
      expect(new Set(stored.filter(span => span.kind === 'action').map(span => span.id)).size).toBe(2)
      expect(Date.parse(stored[1]!.at)).toBeGreaterThan(Date.parse(stored[0]!.at))
      expect(Date.parse(stored[2]!.at)).toBeGreaterThanOrEqual(Date.parse(stored[1]!.at))
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
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
