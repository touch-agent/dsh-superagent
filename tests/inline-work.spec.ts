/**
 * The runtime's inline executor, against a real Engine: it reads the repository files a message names, records one
 * `read` Action per file in the Trigger's trace, and ends the ticket with the content. The tests also pin which tokens
 * count as repository paths, so a URL, a version or a directory is never read as a file, and what a run that names no file
 * or whose read fails records.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, traceId, type AssessmentOutcome, type Assessor, type Assignment, type Candidate,
  type Executor, type InlineExecutor, type Policy, type Span, type Ticket, type TraceSink, type Trigger } from '@superagent/kernel'
import { Store } from '@superagent/dsh/app/store.ts'
import { SqliteTraceSink } from '@superagent/dsh/app/trace.ts'
import { InlineWork, repositoryPaths } from '@superagent/dsh/executor/inline.ts'

const at = '2026-11-09T00:00:00.000Z'
const member = { source: 'chat', id: 'alice' }
const OUTCOME: Extract<AssessmentOutcome, { kind: 'accept' }> = { kind: 'accept', title: 'Look up a document', scope: 'Read it and report',
  reason: 'requested', acknowledgement: 'On it.', rules: ['copy'], audit: { matches: [], rule_assessments: [], direction: 'requested' } }
function trigger(text: string, id = '1'): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at, text,
    channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {} }
}

interface Hooks {
  text?: string
  read?: (path: string, signal: AbortSignal) => Promise<string>
  now?: () => string
  store?: Store
  trace?: TraceSink
}

/** A real Engine, the inline executor under test, and the read the test controls. */
function harness({ text = 'Read `docs/003-execution.md` and tell me what it says.', read = async () => 'The execution rules.', now = () => at,
  store: external, trace: externalTrace }: Hooks = {}) {
  const repo = external ?? new MemoryRepositories()
  const spans: Span[] = []
  const trace: TraceSink = { record: span => { spans.push(span); externalTrace?.record(span) } }
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) } }
  const launches: [Ticket, Assignment][] = []
  const executor: Executor = { start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }), deliver: vi.fn(), stop: vi.fn() }
  let engine!: Engine
  const work = new InlineWork({ store: { triggers: repo.triggers }, get engine() { return engine }, read, now })
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => ({ ok: true }),
    mandateLimits: () => ({ maxActionLevel: 'send' }),
    admitsInferred: () => true,
  }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {}, recall: () => 'recalled' as const }
  engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: false }) }, policy: () => policy, assessor, executor,
    inline: work, outbox, trace, now })
  const accept = (form: 'lightweight' = 'lightweight') => {
    engine.receive(trigger(text))
    engine.evaluateDue()
    return engine.decide('1', { ...OUTCOME, form, evalId: requests.at(-1)!.evalId })
  }
  return { repo, engine, work, spans, requests, launches, executor, accept }
}

describe('repositoryPaths', () => {
  it('finds repository files and ignores URLs, versions, e-mail addresses, directories and dependencies', () => {
    expect(repositoryPaths('读一下 `docs/003-execution.md`，然后告诉我。')).toEqual(['docs/003-execution.md'])
    expect(repositoryPaths('look at packages/kernel/src/tickets.ts and packages/kernel/src/engine.ts')).toEqual([
      'packages/kernel/src/tickets.ts', 'packages/kernel/src/engine.ts'])
    expect(repositoryPaths('in src/index.ts, README.md and AGENTS.md')).toEqual(['src/index.ts', 'README.md', 'AGENTS.md'])
    expect(repositoryPaths('https://github.com/touch-agent/dsh-superagent/blob/main/docs/003-execution.md')).toEqual([])
    expect(repositoryPaths('version v0.1.0 and 2026-11-09')).toEqual([])
    expect(repositoryPaths('mail a@b.com, see github.com and `node_modules/x/y.js`')).toEqual([])
    expect(repositoryPaths('see `docs/` and `touch-agent/dsh-superagent`')).toEqual([])
  })
  it('keeps every path in order and without repeats', () => {
    const text = '`docs/a.md` `docs/b.md` `docs/c.md` `docs/d.md` `docs/e.md` `docs/a.md`'
    expect(repositoryPaths(text)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md', 'docs/e.md'])
  })
})

describe('InlineWork', () => {
  it('reads the named file, records its read in the trace, and ends the ticket with the content and no Assignment', async () => {
    const h = harness({ read: async () => '# Execution\n\nThe tracked path.' })
    const decision = h.accept()
    const ticketId = decision.ticketId!
    await h.work.idle()

    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket).toMatchObject({ form: 'lightweight', assignments: [] })
    expect(ticket.execution).toBeUndefined()
    expect(h.launches).toEqual([])
    expect(h.executor.start).not.toHaveBeenCalled()
    const actions = h.spans.filter(span => span.kind === 'action')
    expect(actions).toHaveLength(1)
    expect(actions[0]!.traceId).toBe(traceId('1'))
    expect(actions[0]!.data).toMatchObject({ ticketId, ok: true,
      action: { kind: 'repository.read', level: 'read', source: 'github', objectId: 'docs/003-execution.md', actor: { source: 'dsh-superagent', id: 'inline' } } })
    expect(actions[0]!.data?.action).toMatchObject({ revision: expect.stringMatching(/^[0-9a-f]{12}$/) })
    const report = h.spans.find(span => span.kind === 'report')!
    expect(report.data).toMatchObject({ ticketId, state: 'completed', form: 'lightweight' })
    expect(h.repo.triggers.disposition('1')?.acked).toEqual([ticketId])
    expect(ticket.ended).toMatchObject({ by: 'executor', outcome: 'completed' })
    expect(ticket.ended?.reason).toContain('# Execution')
    expect(ticket.ended?.reason).toContain('The tracked path.')
  })

  it('reads the file a resumed ticket\'s follow-up names and takes that message up', async () => {
    const h = harness({ text: 'Read `docs/a.md`.', read: async path => path.endsWith('a.md') ? 'A' : 'B' })
    const ticketId = h.accept().ticketId!
    await h.work.idle()
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'completed' })
    const followup = trigger('Now read `docs/b.md`.', '2')
    expect(h.engine.receive(followup)).not.toBe('filtered')
    await h.work.idle()

    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.ended).toMatchObject({ outcome: 'completed' })
    expect(ticket.ended?.reason).toContain('B')
    expect(ticket.inputs.find(input => input.kind === 'trigger')!.readAt).toBeDefined()
    expect(h.repo.triggers.disposition('2')?.acked).toEqual([ticketId])
    // The resumed run reads only the follow-up's file, not the origin file again.
    expect(h.spans.filter(span => span.kind === 'action').map(span => span.data?.action))
      .toEqual([expect.objectContaining({ objectId: 'docs/a.md' }), expect.objectContaining({ objectId: 'docs/b.md' })])
  })

  it('drops a follow-up that names no file instead of re-reading the origin, leaving it unread for Eval', async () => {
    const h = harness({ read: async () => 'A' })
    const ticketId = h.accept().ticketId!
    await h.work.idle()
    const followup = trigger('Summarize it for me.', '3')
    expect(h.engine.receive(followup)).not.toBe('filtered')
    await h.work.idle()

    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.ended).toMatchObject({ outcome: 'dropped', reason: expect.stringContaining('follow-up names no repository file') })
    expect(ticket.inputs.find(input => input.kind === 'trigger')!.readAt).toBeUndefined()
    expect(h.spans.filter(span => span.kind === 'action')).toHaveLength(1)
  })

  it('ends dropped, with a failed read action, when the named file cannot be read', async () => {
    const h = harness({ read: async () => { throw new Error('Not Found') } })
    const ticketId = h.accept().ticketId!
    await h.work.idle()

    const action = h.spans.find(span => span.kind === 'action')!
    expect(action.data).toMatchObject({ ticketId, ok: false, error: 'Not Found',
      action: { objectId: 'docs/003-execution.md', revision: 'unreadable' } })
    expect(h.spans.find(span => span.kind === 'report')!.data).toMatchObject({ state: 'dropped' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'dropped' })
  })

  it('ends dropped without an action when the request names no repository file', async () => {
    const h = harness({ text: 'Tell me how the release went.' })
    const ticketId = h.accept().ticketId!
    await h.work.idle()

    expect(h.spans.filter(span => span.kind === 'action')).toEqual([])
    const report = h.spans.find(span => span.kind === 'report')!
    expect(report.data).toMatchObject({ state: 'dropped' })
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'dropped', reason: expect.stringContaining('names no repository file') })
  })

  it('drops a request that names more repository files than one inline run may read', async () => {
    const h = harness({ text: '`docs/a.md` `docs/b.md` `docs/c.md` `docs/d.md` `docs/e.md`' })
    const ticketId = h.accept().ticketId!
    await h.work.idle()
    expect(h.spans.filter(span => span.kind === 'action')).toEqual([])
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: 'dropped', reason: expect.stringContaining('reads at most 4') })
  })

  it('stops a run before it records anything when the host aborts it', async () => {
    const h = harness({ read: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return 'late' } })
    const ticketId = h.accept().ticketId!
    h.work.stop(h.repo.tickets.get(ticketId)!, 'The person ended the ticket.')
    await h.work.idle()

    expect(h.spans.filter(span => span.kind === 'action' || span.kind === 'report')).toEqual([])
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined()
  })

  it('persists the same action and report through the SQLite trace sink and the Store', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-inline-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    try {
      const sink = new SqliteTraceSink(store)
      const h = harness({ store, trace: sink })
      const ticketId = h.accept().ticketId!
      await h.work.idle()

      expect(sink.trace(traceId('1')).map(span => span.kind)).toEqual(expect.arrayContaining(['action', 'report']))
      expect(store.tickets.get(ticketId)).toMatchObject({ form: 'lightweight', assignments: [], ended: { outcome: 'completed' } })
      expect(store.spans.trace(traceId('1')).find(span => span.kind === 'report')?.data).toMatchObject({ form: 'lightweight' })
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})