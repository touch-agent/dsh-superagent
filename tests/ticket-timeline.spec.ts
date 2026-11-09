/** The Ticket audit timeline: trace, disposition and approval composed into who / on what basis / what changed. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { approve, createAction, createApproval, spanId, traceId, type ChannelRef, type Decision, type Ticket, type Trigger } from '@superagent/kernel'
import { registerHttp } from '@superagent/dsh/app/http.ts'
import { Store } from '@superagent/dsh/app/store.ts'
import { ticketTimeline } from '@superagent/dsh/app/views/timeline.ts'
import { SettingsSchema } from '@superagent/dsh/policy.ts'
import { SourceRegistry } from '@superagent/dsh/sources/registry.ts'
import { feishuKind } from '@superagent/dsh/sources/feishu.ts'
import { feishuLink } from '@superagent/dsh/sources/feishu-channel.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-ticket-timeline-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
  store.saveSettings(settings)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }],
  sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] } } } })
const sources = new SourceRegistry(() => settings)
sources.register(feishuKind)
const host = () => ({ store, sources, links: (channel: ChannelRef) => feishuLink(channel.address, {}) })
const alice = { source: 'feishu', id: 'ou_alice' }
const trigger = (id: string, at: string, text = 'Please fix the copy'): Trigger => ({ id, source: 'feishu',
  threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor: alice, human: true, at, text, meta: {} })
const mandate = { strength: 'explicit' as const, policyVersion: 'policy-v1', basis: { via: 'addressed' as const,
  addressed: 'mention' as const, sender: 'ou_alice' }, actor: alice, scope: 'fix the copy' }
const decision = (id: string, ticketId: string, at: string): Decision => ({ id, evalId: 'e1', threadKey: 'feishu:oc_1:om_root',
  triggerIds: ['tr1'], policyVersion: 'policy-v1', at, kind: 'accept', reason: [{ code: 'said', values: { text: 'please fix it' } }],
  strength: 'explicit', ticketId, mandate, audit: { rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'the copy is wrong' }] } })
const ticket = (fields: Partial<Ticket> = {}): Ticket => ({ id: 't1', title: 'Fix the copy', decisionId: 'd1', mandate, form: 'tracked',
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-11-08T00:00:11.000Z', updatedAt: '2026-11-08T00:00:11.000Z',
  origin: { triggerId: 'tr1', triggerIds: ['tr1'] }, ...fields })

/** The three spans a tracked Ticket's Engine records in the Trigger's trace: decide, attach and dispatch. */
function traceSpans() {
  const trace = traceId('tr1')
  store.spans.record({ id: spanId(trace, 'decide'), traceId: trace, kind: 'decide', at: '2026-11-08T00:00:10.000Z', evalId: 'e1',
    data: { kind: 'accept' } })
  store.spans.record({ id: spanId(trace, 'attach', 't1'), traceId: trace, kind: 'attach', at: '2026-11-08T00:00:11.000Z',
    data: { ticketId: 't1', created: true } })
  store.spans.record({ id: spanId(trace, 'dispatch', 'a1'), traceId: trace, kind: 'dispatch', at: '2026-11-08T00:00:20.000Z',
    data: { ticketId: 't1', assignmentId: 'a1' } })
}

it('reads a tracked Ticket as request, decision, creation, dispatch, inputs, reports and the Approval that let an Action', () => {
  store.triggers.save(trigger('tr1', '2026-11-08T00:00:00.000Z'))
  store.triggers.saveDisposition('tr1', { fanout: ['t1'], decisionId: 'd1', at: '2026-11-08T00:00:10.000Z' })
  store.triggers.save(trigger('tr2', '2026-11-08T00:01:00.000Z', 'Also the title'))
  store.triggers.saveDisposition('tr2', { fanout: ['t1'], acked: ['t1'], at: '2026-11-08T00:01:00.000Z' })
  store.decisions.save(decision('d1', 't1', '2026-11-08T00:00:10.000Z'))
  traceSpans()
  store.tickets.save(ticket({ assignments: [{ id: 'a1', state: 'running', createdAt: '2026-11-08T00:00:12.000Z',
    startedAt: '2026-11-08T00:00:20.000Z', report: { state: 'progress', summary: '**working** on it',
      at: '2026-11-08T00:00:30.000Z' } }],
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'tr2', at: '2026-11-08T00:01:00.000Z' }] }))
  const action = createAction({ source: 'feishu', objectId: 'om_1', kind: 'mail.reply', revision: 'rev-2', actor: alice, level: 'send' })
  store.approvals.save(approve(createApproval({ ticketId: 't1', action, requestedAt: '2026-11-08T00:02:00.000Z',
    expiresAt: '2030-11-08T00:02:00.000Z' }), { by: { source: 'panel', id: 'local' }, at: '2026-11-08T00:03:00.000Z',
      reason: 'the wording is fine' }))
  const timeline = ticketTimeline(host(), 't1')!
  expect(timeline.entries.map(entry => entry.kind)).toEqual(['request', 'decision', 'create', 'dispatch', 'report', 'input', 'approval'])
  expect(timeline.gaps).toBeUndefined()
  // Each step keeps the record it came from: the Trigger's trace, its disposition, the Approval and the Ticket.
  expect(timeline.entries.map(entry => entry.source)).toEqual(['disposition', 'trace', 'trace', 'trace', 'ticket', 'disposition',
    'approval'])
  expect(timeline.entries.map(entry => entry.who.actor?.name ?? entry.who.system)).toEqual([{ zh: 'Alice', en: 'Alice' }, { zh: 'Alice',
    en: 'Alice' }, { zh: 'Alice', en: 'Alice' }, 'executor', 'executor', { zh: 'Alice', en: 'Alice' }, { zh: '管理页', en: 'Panel' }])
  const [, accepted, , dispatched, reported, followup, approval] = timeline.entries
  expect(accepted!.basis).toMatchObject({ strength: 'explicit', policyVersion: 'policy-v1',
    rules: [{ id: 'copy', name: 'Copy fixes', matched: true, reason: 'the copy is wrong' }],
    decision: { id: 'd1', kind: 'accept' }, disposition: { delivered: true } })
  expect(accepted!.change).toEqual({ kind: 'decision', outcome: 'accept' })
  expect(dispatched!.change).toEqual({ kind: 'assignment', id: 'a1', state: 'running' })
  expect(reported!.change).toEqual({ kind: 'report', state: 'progress', summary: '**working** on it' })
  expect(followup!.basis.disposition).toMatchObject({ delivered: true, acked: true, handbacks: [] })
  expect(followup!.change).toEqual({ kind: 'input', input: { kind: 'trigger', preview: 'Also the title', delivered: true } })
  // The Approval names the Action it let, the person who decided it, and the level it granted.
  expect(approval!.basis.approval).toMatchObject({ state: 'approved', level: 'send',
    decidedBy: { source: 'panel', id: 'local' }, reason: 'the wording is fine' })
  expect(approval!.change).toMatchObject({ kind: 'action', action: { kind: 'mail.reply', objectId: 'om_1', revision: 'rev-2', level: 'send' } })
})

it('reads a lightweight Ticket\'s inline action ledger, keeping a failure and its error', () => {
  store.triggers.save(trigger('tr1', '2026-11-08T00:00:00.000Z'))
  store.decisions.save(decision('d1', 't1', '2026-11-08T00:00:10.000Z'))
  const trace = traceId('tr1')
  store.spans.record({ id: spanId(trace, 'dispatch', 'inline'), traceId: trace, kind: 'dispatch', at: '2026-11-08T00:00:11.000Z',
    data: { ticketId: 't1', form: 'lightweight' } })
  const inline = createAction({ kind: 'doc.edit', source: 'feishu', objectId: 'doc_1', revision: 'rev-3', level: 'draft', actor: alice })
  store.spans.record({ id: spanId(trace, 'action', 'run-1:1'), traceId: trace, kind: 'action', at: '2026-11-08T00:00:12.000Z',
    data: { ticketId: 't1', action: inline, ok: false, error: 'the document is locked' } })
  // A follow-up Trigger gets its own trace; its action still belongs to this Ticket.
  store.triggers.save(trigger('tr2', '2026-11-08T00:00:13.000Z', 'Also fix the title'))
  const followup = createAction({ kind: 'doc.edit', source: 'feishu', objectId: 'doc_2', revision: 'rev-4', level: 'draft', actor: alice })
  store.spans.record({ id: spanId(traceId('tr2'), 'action', 'run-2:1'), traceId: traceId('tr2'), kind: 'action',
    at: '2026-11-08T00:00:14.000Z', data: { ticketId: 't1', action: followup, ok: true } })
  store.tickets.save(ticket({ form: 'lightweight', createdAt: '2026-11-08T00:00:11.000Z',
    inputs: [{ id: 'i2', kind: 'trigger', triggerId: 'tr2', at: '2026-11-08T00:00:13.000Z' }] }))
  store.approvals.save(approve(createApproval({ ticketId: 't1', action: inline, requestedAt: '2026-11-08T00:00:10.000Z',
    expiresAt: '2030-11-08T00:00:10.000Z' }), { by: { source: 'panel', id: 'local' }, at: '2026-11-08T00:00:11.000Z' }))
  const actions = ticketTimeline(host(), 't1')!.entries.filter(entry => entry.kind === 'action')
  expect(actions.map(entry => entry.change.kind === 'action' ? entry.change.action.objectId : '')).toEqual(['doc_1', 'doc_2'])
  const action = actions[0]!
  expect(action).toMatchObject({ source: 'trace', trigger: 'tr1',
    who: { actor: { source: 'feishu', id: 'ou_alice', name: { zh: 'Alice', en: 'Alice' } } },
    basis: { strength: 'explicit', policyVersion: 'policy-v1', approval: { state: 'approved', level: 'draft' } },
    change: { kind: 'action', ok: false, error: 'the document is locked', action: { kind: 'doc.edit', objectId: 'doc_1',
      revision: 'rev-3', level: 'draft' } } })
})

it('answers every step with who, basis and change, and states the gaps when the decision or trace is missing', () => {
  store.tickets.save(ticket({ decisionId: 'missing', ended: { at: '2026-11-08T00:05:00.000Z', by: 'human', outcome: 'stopped' },
    inputs: [{ id: 'i1', kind: 'policy-changed', at: '2026-11-08T00:02:00.000Z', from: 'policy-v1', to: 'policy-v2' }] }))
  const timeline = ticketTimeline(host(), 't1')!
  expect(timeline.gaps).toEqual(['noDecision', 'noTrace'])
  expect(timeline.entries.map(entry => entry.kind)).toEqual(['create', 'policy', 'end'])
  for (const entry of timeline.entries) {
    expect(entry.who.actor ?? entry.who.system).toBeDefined()
    expect(Object.keys(entry.basis).length).toBeGreaterThan(0)
    expect(entry.change.kind).toBeTruthy()
  }
  // The person who ended it is not recorded, and the entry says so instead of guessing.
  expect(timeline.entries.at(-1)).toMatchObject({ kind: 'end', who: { system: 'human' }, gap: 'noActor',
    change: { kind: 'end', outcome: 'stopped' } })
})

it('only reads the records it explains', () => {
  store.triggers.save(trigger('tr1', '2026-11-08T00:00:00.000Z'))
  store.decisions.save(decision('d1', 't1', '2026-11-08T00:00:10.000Z'))
  traceSpans()
  store.tickets.save(ticket())
  const writes = [vi.spyOn(store.tickets, 'save'), vi.spyOn(store.decisions, 'save'), vi.spyOn(store.approvals, 'save'),
    vi.spyOn(store.triggers, 'saveDisposition'), vi.spyOn(store.spans, 'record')]
  expect(ticketTimeline(host(), 't1')?.entries.length).toBeGreaterThan(0)
  expect(writes.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0])
})

it('serves the timeline through the management API and refuses an unknown Ticket', async () => {
  store.triggers.save(trigger('tr1', '2026-11-08T00:00:00.000Z'))
  store.decisions.save(decision('d1', 't1', '2026-11-08T00:00:10.000Z'))
  traceSpans()
  store.tickets.save(ticket())
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { kind: string; path: string
      handler: (req: unknown, res: unknown) => Promise<void> }) => { handlers.set(`${route.kind}:${route.path}`, route.handler) } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), store, sources, links: () => (channel: ChannelRef) => feishuLink(channel.address,
    {}) } as never)
  const call = async (path: string) => {
    let status = 0, text = ''
    await handlers.get('prefix:/orchestrator')!({ method: 'GET', url: `/orchestrator/api/${path}`,
      headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() {} },
    { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  expect(await call('tickets/t1/timeline')).toMatchObject({ status: 200, body: { ticket: { id: 't1', title: 'Fix the copy' } } })
  expect(await call('tickets/missing/timeline')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
})
