/** The stages the Engine records for a Trigger: which ones run, in what order, and what each one says. */
import { describe, expect, it } from 'vitest'
import { Engine, MemoryRepositories, SPAN_KINDS, traceId, type Span, type SpanKind } from '@superagent/kernel'
import type { EngineOptions, Executor, Policy, Span as SpanType, TraceSink, Trigger } from '@superagent/kernel'

const member = { source: 'chat', id: 'alice' }
const at = '2026-11-07T10:00:00.000Z'
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at, text: `message ${id}`,
    channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides }
}
/** An Engine on in-memory repositories whose stages are collected by `spans`, with a gate and a scope a test can replace. */
function harness({ gate, scope, spans, now }: { gate?: Policy['gate']; scope?: EngineOptions['scope']; spans: SpanType[]
  now?: () => string }) {
  const repo = new MemoryRepositories()
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: gate ?? (() => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } })),
    revalidate: () => ({ ok: true }),
    mandateLimits: () => ({ maxActionLevel: 'send' }),
    admitsInferred: () => true,
  }
  const executor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} }
  const trace: TraceSink = { record: span => { spans.push(span) } }
  const engine = new Engine({ repo, policy: () => policy, scope: scope ?? { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: () => {} }, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {}, recall: () => 'recalled' as const }, trace,
    now: now ?? (() => at) })
  return { engine, repo }
}
/** The stages recorded so far, in the order they were recorded. */
const kinds = (spans: SpanType[]): SpanKind[] => spans.map(span => span.kind)

describe('the stages of one Trigger', () => {
  const once = (engine: Engine): void => { engine.receive(trigger('1')); engine.evaluateDue() }
  const cases: Array<{ what: string; gate?: Policy['gate']; scope?: EngineOptions['scope']; run?: (engine: Engine, spans: SpanType[]) => void; stages: SpanKind[] }> = [
    { what: 'takes a person\'s message in, deduplicates, queues it, gates it and admits it',
      stages: ['ingest', 'dedupe', 'enqueue', 'gate', 'admission'] },
    { what: 'stops after deduplication when the Source hands the same Trigger in twice',
      // The first arrival is the one with work to do; the second is the duplicate the trace is about.
      run: (engine, spans) => { engine.receive(trigger('1')); engine.evaluateDue(); spans.length = 0; engine.receive(trigger('1')) },
      stages: ['ingest', 'dedupe'] },
    { what: 'stops after deduplication when the Source does not listen to the Thread',
      scope: { scope: () => ({ listened: false, reason: 'chat not allowed' }) }, stages: ['ingest', 'dedupe'] },
    { what: 'stops after the gate refuses the Trigger, which the Eval records as an ignore',
      gate: () => ({ admissible: false, reason: 'no_mention' }), stages: ['ingest', 'dedupe', 'enqueue', 'gate', 'decide'] },
  ]
  for (const { what, gate, scope, run, stages } of cases) {
    it(what, () => {
      const spans: SpanType[] = []
      const { engine } = harness({ spans, ...gate ? { gate } : {}, ...scope ? { scope } : {} })
      ;(run ?? once)(engine, spans)
      expect(kinds(spans)).toEqual(stages)
      // One Trigger, one trace: every stage hangs off the trace id its Trigger derives.
      expect(new Set(spans.map(span => span.traceId))).toEqual(new Set([traceId('1')]))
      // The stage ids are the trace's, so a reader can ask for one stage without scanning.
      for (const stage of spans) {
        expect(stage.at).toBe(at)
        expect(stage.threadKey).toBe('chat:t1')
        expect(SPAN_KINDS).toContain(stage.kind)
      }
    })
  }

  it('says what the gate and the admission decided, and which Eval the admission started', () => {
    const spans: SpanType[] = []
    const { engine, repo } = harness({ spans })
    engine.receive(trigger('1'))
    engine.evaluateDue()
    const byKind = (kind: SpanKind): Span => spans.find(span => span.kind === kind)!
    expect(byKind('ingest').data).toBeUndefined()
    expect(byKind('dedupe').data).toEqual({ duplicate: false })
    expect(byKind('gate').data).toEqual({ admitted: true, strength: 'explicit', via: 'listed' })
    // The Eval the admission started is named on the span, so the trace leads to the Decision.
    const evaluating = repo.threads.active().find(thread => thread.evaluating)!.evaluating!
    expect(byKind('admission')).toMatchObject({ evalId: evaluating.id, data: { strength: 'explicit', via: 'listed' } })
  })

  it('records the reason the gate refused a Trigger', () => {
    const spans: SpanType[] = []
    const { engine } = harness({ spans, gate: () => ({ admissible: false, reason: 'not_a_member' }) })
    engine.receive(trigger('1'))
    engine.evaluateDue()
    expect(spans.find(span => span.kind === 'gate')!.data).toEqual({ admitted: false, reason: 'not_a_member' })
  })

  it('follows an accepted Trigger from the gate to the first report, in one trace', () => {
    const spans: SpanType[] = []
    const { engine, repo } = harness({ spans })
    engine.receive(trigger('1'))
    engine.evaluateDue()
    // The candidate reached the assessor's Session, which then accepted it.
    const evaluating = engine.candidate('1')!.evalId
    engine.candidateDelivered(evaluating)
    const decision = engine.decide('1', { kind: 'accept', title: 'Fix the login bug', scope: 'the login page', reason: 'asked for it' })
    const ticketId = decision.ticketId!
    const assignmentId = repo.tickets.get(ticketId)!.assignments[0]!.id
    engine.assignmentStarted(ticketId, assignmentId)
    engine.report(ticketId, { state: 'ready', summary: 'Opened a pull request' })
    expect(kinds(spans)).toEqual(['ingest', 'dedupe', 'enqueue', 'gate', 'admission', 'assess', 'decide', 'attach', 'dispatch', 'report'])
    const byKind = (kind: SpanKind): Span => spans.find(span => span.kind === kind)!
    expect(byKind('assess').evalId).toBe(evaluating)
    expect(byKind('decide').data).toEqual({ kind: 'accept' })
    expect(byKind('attach').data).toEqual({ ticketId, created: true })
    expect(byKind('dispatch').data).toEqual({ ticketId, assignmentId, profile: 'legacy' })
    expect(byKind('report').data).toEqual({ ticketId, state: 'ready' })
    // Every stage of the journey stays in the Trigger's one trace, after the Decision included.
    expect(new Set(spans.map(span => span.traceId))).toEqual(new Set([traceId('1')]))
  })

  it('keeps one row per happening for stages that happen more than once', () => {
    const spans: SpanType[] = []
    let tick = 0
    const { engine, repo } = harness({ spans, now: () => new Date(Date.parse(at) + tick++ * 1000).toISOString() })
    engine.receive(trigger('1'))
    engine.evaluateDue()
    const decision = engine.decide('1', { kind: 'accept', title: 'Fix the login bug', scope: 'the login page', reason: 'asked for it' })
    const ticketId = decision.ticketId!
    const first = repo.tickets.get(ticketId)!.assignments[0]!.id
    engine.assignmentStarted(ticketId, first)
    engine.report(ticketId, { state: 'waiting', summary: 'Waiting for review' })
    engine.report(ticketId, { state: 'ready', summary: 'Review passed' })
    // Two reports are two happenings, each with its own row, not one overwritten.
    const reports = spans.filter(span => span.kind === 'report')
    expect(reports.map(span => span.data?.state)).toEqual(['waiting', 'ready'])
    expect(new Set(reports.map(span => span.id)).size).toBe(2)
  })

  it('records no trace at all when no sink is configured, so tracing stays optional', () => {
    const repo = new MemoryRepositories()
    const policy: Policy = { version: 'v1', paused: false, evalTimeoutMs: 60_000,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => ({ ok: true }),
      mandateLimits: () => ({ maxActionLevel: 'send' }), admitsInferred: () => true }
    const engine = new Engine({ repo, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
      assessor: { request: () => {} }, executor: { start: () => {}, deliver: () => {}, stop: () => {} },
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {}, recall: () => 'recalled' as const }, now: () => at })
    engine.receive(trigger('1'))
    engine.evaluateDue()
    // The Trigger still went to an Eval: only the trace is missing.
    expect(repo.threads.active().some(thread => thread.evaluating)).toBe(true)
  })
})