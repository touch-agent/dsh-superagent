import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Engine, MemoryRepositories, type Decision, type Ticket, type Trigger, type TriggerDisposition } from '@superagent/kernel'
import { dispatchConversation, latestPersonMessage, worktreeName, type ConversationAgent } from '@superagent/dsh/app/conversation.ts'
import { SettingsSchema, settingsPolicy } from '@superagent/dsh/policy.ts'
import { conversationDefinition } from '@superagent/dsh/sources/conversation.ts'
import { ticketExecution } from '@superagent/dsh/executor/dsh.ts'
import { mainTools, type MainToolsHost } from '@superagent/dsh/app/tools/main.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SourceRegistry } from '@superagent/dsh/sources/registry.ts'

const at = Date.parse('2026-11-07T10:00:00.000Z')
const user = (text: string, source: string = 'user', id = 'msg_1'): SessionEvent => ({ type: 'user/message', seq: 1, time: at,
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: source } } }) as unknown as SessionEvent
const agent = (...events: SessionEvent[]): ConversationAgent => ({ id: 'orchestrator-1', session: { snapshotEvents: () => events } })
const ticket = { id: 'ticket-1' } as Ticket

function host(received: 'stored' | 'duplicate' | 'filtered' = 'stored', disposition?: TriggerDisposition) {
  return { engine: { receive: vi.fn((_trigger: Trigger) => received), decide: vi.fn((_id: string, _outcome: unknown) => ({ ticketId: 'ticket-1' } as Decision)),
    attach: vi.fn((_ticketId: string, _triggerId: string, _note?: string) => ticket) },
    disposition: vi.fn(() => disposition), ticket: vi.fn(() => ticket) }
}

describe('conversation dispatch', () => {
  it('dispatches the person\'s latest message as a task and accepts it with a direct decision', () => {
    const target = host()
    const result = dispatchConversation(agent(user('Fix the flaky test')), target, { title: 'Fix the flaky test', scope: 'Make the test stable.',
      acknowledgement: 'I will fix the flaky test.' })
    expect(result).toMatchObject({ duplicate: false, ticket })
    const trigger = target.engine.receive.mock.calls[0]![0]
    expect(trigger).toMatchObject({ source: 'conversation', text: 'Fix the flaky test', threads: [{ source: 'conversation', id: 'msg_1' }],
      channel: { source: 'conversation', thread: 'conversation:msg_1' }, actor: { source: 'conversation', id: 'local-user' } })
    expect(target.engine.decide).toHaveBeenCalledWith(trigger.id, { kind: 'accept', title: 'Fix the flaky test', scope: 'Make the test stable.',
      name: 'fix-the-flaky-test', reason: 'Dispatched from the conversation', acknowledgement: 'I will fix the flaky test.' })
  })

  it('accepts an explicit worktree name over the title-derived one', () => {
    const target = host()
    dispatchConversation(agent(user('Fix it')), target, { title: 'Fix it', scope: 'Fix it.', name: 'fix-it' })
    expect(target.engine.decide.mock.calls[0]![1]).toMatchObject({ name: 'fix-it' })
  })

  it('derives a valid English worktree name from the title, and a generic one for a Chinese title', () => {
    expect(worktreeName('Create LIVE-TEST.md at repo root')).toBe('create-live-test-md')
    expect(worktreeName('在仓库根目录创建文件')).toBe('conversation')
    expect(worktreeName('Fix the flaky test')).toBe('fix-the-flaky-test')
  })

  it('attaches a follow-up or status question to an existing ticket instead of accepting it', () => {
    const target = host()
    const result = dispatchConversation(agent(user('How is it going?')), target, { ticketId: 'ticket-1', note: 'Status question' })
    expect(result).toMatchObject({ duplicate: false, attached: true, ticket })
    const trigger = target.engine.receive.mock.calls[0]![0]
    expect(target.engine.attach).toHaveBeenCalledWith('ticket-1', trigger.id, 'Status question')
    expect(target.engine.decide).not.toHaveBeenCalled()
  })

  it('passes a lightweight form to the accept only when the item asks for it', () => {
    const target = host()
    dispatchConversation(agent(user('Read `docs/003-execution.md`')), target, { title: 'Read a document', scope: 'Read docs/003-execution.md.', form: 'lightweight' })
    expect(target.engine.decide).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ form: 'lightweight' }))
    expect(target.engine.decide.mock.calls[0]![1]).not.toHaveProperty('form', 'tracked')
  })

  it('refuses new work without a title and scope', () => {
    const target = host()
    expect(dispatchConversation(agent(user('Fix it')), target, {})).toEqual({ refused: expect.stringContaining('title') })
    expect(target.engine.receive).not.toHaveBeenCalled()
  })

  it('does not accept a message twice', () => {
    const target = host('duplicate', { decisionId: 'decision-1' } as TriggerDisposition)
    expect(dispatchConversation(agent(user('Fix it')), target, { title: 'Fix', scope: 'Fix it' })).toMatchObject({ duplicate: true, triggerId: expect.any(String) })
    expect(target.engine.decide).not.toHaveBeenCalled()
  })

  it('refuses when the conversation Source is off', () => {
    const target = host('filtered')
    expect(dispatchConversation(agent(user('Fix it')), target, { title: 'Fix', scope: 'Fix it' })).toEqual({ refused: expect.stringContaining('off') })
    expect(target.engine.decide).not.toHaveBeenCalled()
  })

  it('refuses when the latest message came from the agent or has no text', () => {
    expect(latestPersonMessage(agent(user('A notice', 'dsh-superagent')))).toBeUndefined()
    expect(dispatchConversation(agent(user('A notice', 'dsh-superagent')), host(), { title: 'Fix', scope: 'Fix it' })).toEqual({ refused: expect.any(String) })
    expect(latestPersonMessage(agent({ type: 'user/message', seq: 1, time: at,
      data: { id: 'm', role: 'user', content: [], source: { kind: 'user' } } } as unknown as SessionEvent))).toBeUndefined()
  })

  it('reads only the latest message, so an older request cannot be dispatched later', () => {
    expect(latestPersonMessage(agent(user('Older', 'user', 'm1'), user('Newer', 'user', 'm2')))).toMatchObject({ id: 'm2', text: 'Newer' })
  })
})

describe('conversation dispatch through the Engine', () => {
  it('creates one ticket with a local mandate, and a second dispatch creates none', () => {
    const repo = new MemoryRepositories()
    let settings = SettingsSchema.parse({})
    const sources = new SourceRegistry(() => settings)
    sources.registerDefinition(conversationDefinition)
    const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
      assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      prepareTicket: (ticket, outcome) => ({ ...ticket, execution: ticketExecution(ticket, outcome, settings, '/state') }),
      outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn(), recall: vi.fn(() => 'recalled' as const) } })
    const dispatch = (input: { title: string; scope: string }) => dispatchConversation(agent(user('Fix the flaky test')), {
      engine, disposition: id => repo.triggers.disposition(id), ticket: id => repo.tickets.get(id) }, input)
    const first = dispatch({ title: 'Fix the flaky test', scope: 'Make the test stable.' })
    expect(first).toMatchObject({ duplicate: false })
    if ('refused' in first) throw new Error(first.refused)
    expect(repo.tickets.open()).toHaveLength(1)
    expect(first.ticket?.mandate).toMatchObject({ strength: 'explicit', basis: { source: 'conversation', via: 'local' } })
    expect(first.ticket?.execution?.name).toBe('fix-the-flaky-test-' + first.ticket!.id.slice(0, 12))
    expect(first.ticket?.channels).toContainEqual({ source: 'conversation', thread: 'conversation:msg_1',
      address: { session: 'orchestrator-1', root: 'msg_1', messageId: 'msg_1' } })
    expect(dispatch({ title: 'Fix again', scope: 'Another ticket.' })).toMatchObject({ duplicate: true })
    expect(repo.tickets.open()).toHaveLength(1)
  })

  it('refuses while the conversation Source is off', () => {
    const repo = new MemoryRepositories()
    const settings = SettingsSchema.parse({ sources: { conversation: { enabled: false, config: {} } } })
    const sources = new SourceRegistry(() => settings)
    sources.registerDefinition(conversationDefinition)
    const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
      assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn(), recall: vi.fn(() => 'recalled' as const) } })
    const result = dispatchConversation(agent(user('Fix the flaky test')), { engine, disposition: id => repo.triggers.disposition(id),
      ticket: id => repo.tickets.get(id) }, { title: 'Fix', scope: 'Fix it.' })
    expect(result).toEqual({ refused: expect.stringContaining('off') })
    expect(repo.tickets.open()).toHaveLength(0)
  })
})

describe('conversation attach through the Engine', () => {
  it('adds the follow-up to the existing ticket rather than opening a second one', () => {
    const repo = new MemoryRepositories()
    const settings = SettingsSchema.parse({})
    const sources = new SourceRegistry(() => settings)
    sources.registerDefinition(conversationDefinition)
    const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
      assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn(), recall: vi.fn(() => 'recalled' as const) } })
    const first = dispatchConversation(agent(user('Fix the flaky test')), { engine, disposition: id => repo.triggers.disposition(id),
      ticket: id => repo.tickets.get(id) }, { title: 'Fix', scope: 'Fix it.' })
    if ('refused' in first || !first.ticket) throw new Error('the first dispatch did not create a ticket')
    const followUp = dispatchConversation(agent(user('How is it going?', 'user', 'msg_2')), { engine, disposition: id => repo.triggers.disposition(id),
      ticket: id => repo.tickets.get(id) }, { ticketId: first.ticket.id, note: 'Status question' })
    expect(followUp).toMatchObject({ attached: true, ticket: expect.objectContaining({ id: first.ticket.id }) })
    expect(repo.tickets.open()).toHaveLength(1)
    expect(repo.tickets.get(first.ticket.id)?.inputs.some(input => input.kind === 'trigger' && input.triggerId === (followUp as { triggerId: string }).triggerId)).toBe(true)
  })
})


describe('the ticket bind tool', () => {
  it('binds a live ticket to a trigger\'s Source thread and Channel, and repeats idempotently', async () => {
    const repo = new MemoryRepositories()
    const settings = SettingsSchema.parse({})
    const sources = new SourceRegistry(() => settings)
    sources.registerDefinition(conversationDefinition)
    const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
      assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      prepareTicket: (ticket, outcome) => ({ ...ticket, execution: ticketExecution(ticket, outcome, settings, '/state') }),
      outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn(), recall: vi.fn(() => 'recalled' as const) } })
    const first = dispatchConversation(agent(user('Fix the flaky test')), { engine, disposition: id => repo.triggers.disposition(id),
      ticket: id => repo.tickets.get(id) }, { title: 'Fix', scope: 'Fix it.' })
    if ('refused' in first || !first.ticket) throw new Error('the dispatch did not create a ticket')
    const anchor: Trigger = { id: 'anchor-1', source: 'conversation', threads: [{ source: 'conversation', id: 'root-2' }],
      actor: { source: 'conversation', id: 'local-user' }, human: true, at: '2026-11-07T10:01:00.000Z', text: 'main',
      channel: { source: 'conversation', thread: 'conversation:root-2', address: { session: 'orchestrator-1', root: 'root-2', messageId: 'msg-2' } },
      meta: {} }
    repo.triggers.save(anchor)
    const requestPass = vi.fn()
    const host = { engine: { bindChannel: (id: string, channel: Parameters<typeof engine.bindChannel>[1]) => engine.bindChannel(id, channel) },
      store: repo, sources, requestPass, quietly: <T>(run: () => T) => run(), resources: {}, sessions: {}, settings: {},
      context: {}, prompts: {}, assessor: {} } as unknown as MainToolsHost
    const call = mainTools(host, {} as Agent).find(item => item.name === 'orchestrator_ticket_bind')!
    const args = call.schema.parse({ ticket_id: first.ticket.id, trigger_id: anchor.id })
    expect(await call.execute(args as never, new AbortController().signal)).toMatchObject({ bound: true })
    expect(repo.tickets.get(first.ticket.id)).toMatchObject({ channels: [first.ticket.channels[0], anchor.channel] })
    expect(repo.tickets.get(first.ticket.id)).not.toHaveProperty('follows')
    expect(repo.threads.get('conversation:root-2')!.subscriptions).toEqual([first.ticket.id])
    expect(repo.tickets.get(first.ticket.id)!.inputs.filter(input => input.kind === 'binding')).toHaveLength(1)
    expect(await call.execute(args as never, new AbortController().signal)).toMatchObject({ duplicate: true })
    expect(repo.tickets.get(first.ticket.id)!.inputs.filter(input => input.kind === 'binding')).toHaveLength(1)
    expect(requestPass).toHaveBeenCalled()
  })
})

describe('the dispatch tool', () => {
  it('maps the wire ticket_id into the dispatch request', async () => {
    const dispatch = vi.fn(() => ({ triggerId: 'tr_1', duplicate: false, attached: true }))
    const host = { dispatch, requestPass: vi.fn(), quietly: <T>(run: () => T) => run(), resources: {}, sessions: {}, settings: {},
      store: {}, context: {}, prompts: {}, assessor: {}, engine: {} } as unknown as MainToolsHost
    const call = mainTools(host, {} as Agent).find(item => item.name === 'orchestrator_dispatch')!
    const args = call.schema.parse({ ticket_id: 'ticket-1', note: 'status' })
    await call.execute(args as never, new AbortController().signal)
    expect(dispatch).toHaveBeenCalledWith({}, { title: undefined, scope: undefined, acknowledgement: undefined,
      ticketId: 'ticket-1', note: 'status' })
  })

  it('maps the wire items into the dispatch request and reports every item result', async () => {
    const dispatch = vi.fn((_agent: unknown, _input: unknown) => ({ triggerId: 'tr_1', duplicate: false,
      items: [{ triggerId: 'tr_a', title: 'A', ticketId: 'ticket-1' }, { triggerId: 'tr_b', title: 'B', attached: true, ticketId: 'ticket-2' }] }))
    const host = { dispatch, requestPass: vi.fn(), quietly: <T>(run: () => T) => run(), resources: {}, sessions: {}, settings: {},
      store: {}, context: {}, prompts: {}, assessor: {}, engine: {} } as unknown as MainToolsHost
    const call = mainTools(host, {} as Agent).find(item => item.name === 'orchestrator_dispatch')!
    const args = call.schema.parse({ items: [{ title: 'A', scope: 'Do A.', worktree_name: 'do-a' },
      { ticket_id: 'ticket-2', scope: 'Add to ticket two.', note: 'follow-up' }] })
    expect(await call.execute(args as never, new AbortController().signal)).toMatchObject({ trigger_id: 'tr_1', decision: 'accept',
      items: [{ triggerId: 'tr_a', ticketId: 'ticket-1' }, { triggerId: 'tr_b', attached: true }] })
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ items: [{ title: 'A', scope: 'Do A.', name: 'do-a' },
      { ticketId: 'ticket-2', scope: 'Add to ticket two.', note: 'follow-up' }] })
    expect(() => call.schema.parse({ items: [{}] })).toThrow()
  })
})
