import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Engine, MemoryRepositories, type Ticket } from '@superagent/kernel'
import { dispatchConversation, explicitItems, type ConversationAgent, type DispatchInput } from '@superagent/dsh/app/conversation.ts'
import { SettingsSchema, settingsPolicy } from '@superagent/dsh/policy.ts'
import { conversationSource } from '@superagent/dsh/app/cards.ts'
import { conversationDefinition } from '@superagent/dsh/sources/conversation.ts'
import { ticketExecution } from '@superagent/dsh/executor/dsh.ts'
import { SourceRegistry } from '@superagent/dsh/sources/registry.ts'

const at = Date.parse('2026-11-08T10:00:00.000Z')
const user = (text: string, id = 'msg_1'): SessionEvent => ({ type: 'user/message', seq: 1, time: at,
  data: { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }) as unknown as SessionEvent
const agent = (text: string, id = 'msg_1'): ConversationAgent => ({ id: 'orchestrator-1', session: { snapshotEvents: () => [user(text, id)] } })

function harness(mode: 'single' | 'explicit' | 'auto' = 'single', maxTickets = 5, extra: Record<string, unknown> = {}) {
  const repo = new MemoryRepositories()
  const settings = SettingsSchema.parse({ dispatch: { mode, maxTickets }, ...extra })
  const sources = new SourceRegistry(() => settings)
  sources.registerDefinition(conversationDefinition)
  const sent: unknown[] = []
  const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(settings, sources),
    assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
    prepareTicket: (ticket, outcome) => ({ ...ticket, execution: ticketExecution(ticket, outcome, settings, '/state') }),
    outbox: { send: message => { sent.push(message) }, status: () => undefined, withdraw: vi.fn(), recall: vi.fn(() => 'recalled' as const) } })
  const dispatch = (input: DispatchInput, text = 'Fix the flaky test', id = 'msg_1') => dispatchConversation(agent(text, id),
    { engine, disposition: triggerId => repo.triggers.disposition(triggerId), ticket: ticketId => repo.tickets.get(ticketId),
      thread: key => repo.threads.get(key), config: () => settings.dispatch }, input)
  return { repo, engine, dispatch, sent, settings }
}

const openTickets = (repo: MemoryRepositories): Ticket[] => repo.tickets.open()

describe('explicit dispatch parsing', () => {
  it('reads numbered and bulleted lines, a confirmation line, and a launching phrase with an inline list', () => {
    expect(explicitItems('拆成以下任务：\n1、修复登录\n2、更新文档\n3、补充测试')).toEqual(['修复登录', '更新文档', '补充测试'])
    expect(explicitItems('确认拆单：\n- 修复登录\n- 更新文档')).toEqual(['修复登录', '更新文档'])
    expect(explicitItems('确认：修复登录、更新文档')).toEqual(['修复登录', '更新文档'])
    expect(explicitItems('开 A、B、C')).toEqual(['A', 'B', 'C'])
  })

  it('keeps prose, one item, and an over-wide inline list as no split', () => {
    expect(explicitItems('Fix the login button, please.')).toBeUndefined()
    expect(explicitItems('1、只修登录按钮')).toBeUndefined()
    expect(explicitItems(`开 ${'长'.repeat(250)}、B`)).toBeUndefined()
    expect(explicitItems('开个会，讨论 A、B')).toBeUndefined()
  })
})

describe('single dispatch mode', () => {
  it('keeps one ticket even when the main Session supplies several items', () => {
    const h = harness('single')
    const result = h.dispatch({ title: 'One change', scope: 'Do A and B.',
      items: [{ title: 'A', scope: 'Do A.' }, { title: 'B', scope: 'Do B.' }] })
    expect(result).toMatchObject({ duplicate: false, ticket: { title: 'One change' } })
    if ('refused' in result) throw new Error(result.refused)
    expect(openTickets(h.repo)).toHaveLength(1)
    expect(result.items).toBeUndefined()
    expect(result.ticket?.origin.triggerId).toBe(result.triggerId)
  })
})

describe('explicit dispatch mode', () => {
  it('starts one ticket per explicit item and makes every item addressable by the source message', () => {
    const h = harness('explicit')
    const text = '拆成以下任务：\n1、修复登录按钮\n2、更新使用文档\n3、补充回归测试'
    const result = h.dispatch({}, text)
    if ('refused' in result) throw new Error(result.refused)
    expect(result.items).toHaveLength(3)
    const tickets = openTickets(h.repo)
    expect(tickets).toHaveLength(3)
    expect(tickets.map(item => item.title).sort()).toEqual(['修复登录按钮', '更新使用文档', '补充回归测试'].sort())
    for (const [index, item] of (result.items ?? []).entries()) {
      const trigger = h.repo.triggers.get(item.triggerId)!
      expect(trigger.meta).toMatchObject({ messageId: 'msg_1', sourceMessageId: 'msg_1', intent: { index, count: 3 } })
      expect(conversationSource(trigger)).toEqual({ source_message_id: 'msg_1', intent: { index, count: 3 } })
      expect(item.triggerId).not.toBe('conversation:msg_1')
      expect(tickets.some(ticket => ticket.origin.triggerId === item.triggerId)).toBe(true)
    }
    // Every accepted ticket answers the source message.
    expect(h.sent).toHaveLength(3)
  })

  it('splits an inline confirmation list, and keeps an ambiguous message as one ticket', () => {
    const h = harness('explicit')
    const split = h.dispatch({}, '开 A、B、C')
    if ('refused' in split) throw new Error(split.refused)
    expect(split.items).toHaveLength(3)
    expect(openTickets(h.repo)).toHaveLength(3)
    const one = h.dispatch({}, 'Fix the login button, please.', 'msg_2')
    if ('refused' in one) throw new Error(one.refused)
    expect(one.items).toBeUndefined()
    expect(openTickets(h.repo)).toHaveLength(4)
  })

  it('keeps one ticket holding every item when the list is wider than maxTickets', () => {
    const h = harness('explicit', 2)
    const result = h.dispatch({}, '拆成以下任务：\n1、A 改动\n2、B 改动\n3、C 改动')
    if ('refused' in result) throw new Error(result.refused)
    expect(result.items).toBeUndefined()
    const [ticket] = openTickets(h.repo)
    expect(openTickets(h.repo)).toHaveLength(1)
    expect(ticket?.mandate.scope).toContain('A 改动')
    expect(ticket?.mandate.scope).toContain('C 改动')
  })
})

describe('auto dispatch mode', () => {
  it('takes the main Session\'s items, merges identical intents, and falls back to one ticket for a single item', () => {
    const h = harness('auto')
    const result = h.dispatch({ items: [{ title: 'Fix login', scope: 'Repair the login button.' }, { title: 'Fix login', scope: 'Repair the login button.' }] })
    if ('refused' in result) throw new Error(result.refused)
    expect(openTickets(h.repo)).toHaveLength(1)
    expect(result.items).toBeUndefined()
    const split = h.dispatch({ items: [{ title: 'Fix login', scope: 'Repair the login button.' },
      { title: 'Update docs', scope: 'Update the usage guide.' }] }, 'Fix login and update docs', 'msg_2')
    if ('refused' in split) throw new Error(split.refused)
    expect(openTickets(h.repo)).toHaveLength(3)
    expect(split.items).toHaveLength(2)
  })

  it('attaches an item that names an existing ticket while starting a ticket for the other item', () => {
    const h = harness('auto')
    const first = h.dispatch({ title: 'Existing', scope: 'Existing work.' }, 'Existing work', 'msg_1')
    if ('refused' in first) throw new Error(first.refused)
    const existing = first.ticket!
    const result = h.dispatch({ items: [{ title: 'New work', scope: 'Start the new thing.' },
      { ticketId: existing.id, scope: 'Also report status there.', note: 'Status request' }] }, 'New work; status', 'msg_2')
    if ('refused' in result) throw new Error(result.refused)
    expect(result.items).toHaveLength(2)
    expect(openTickets(h.repo)).toHaveLength(2)
    expect(h.repo.tickets.get(existing.id)!.inputs.some(input => input.kind === 'trigger' && input.note === 'Status request')).toBe(true)
    expect(result.items?.some(item => item.attached)).toBe(true)
  })

  it('re-dispatching the same message and plan creates no second set of tickets', () => {
    const h = harness('auto')
    const input: DispatchInput = { items: [{ title: 'Fix login', scope: 'Repair the login button.' },
      { title: 'Update docs', scope: 'Update the usage guide.' }] }
    const first = h.dispatch(input, 'Fix login and update docs')
    if ('refused' in first) throw new Error(first.refused)
    const ids = first.items!.map(item => item.triggerId)
    const second = h.dispatch(input, 'Fix login and update docs')
    if ('refused' in second) throw new Error(second.refused)
    expect(second.duplicate).toBe(true)
    expect(second.items?.map(item => item.triggerId)).toEqual(ids)
    expect(openTickets(h.repo)).toHaveLength(2)
  })
})
describe('dispatch fallbacks that must not lose work', () => {
  it('keeps a mixed attach and new plan when it is wider than maxTickets', () => {
    const h = harness('auto', 2)
    const first = h.dispatch({ title: 'Existing', scope: 'Existing work.' }, 'Existing work', 'msg_1')
    if ('refused' in first) throw new Error(first.refused)
    const existing = first.ticket!
    const result = h.dispatch({ items: [{ title: 'A', scope: 'Do A.' }, { title: 'B', scope: 'Do B.' },
      { title: 'C', scope: 'Do C.' }, { ticketId: existing.id, scope: 'Status update.' }] }, 'A, B, C and status', 'msg_2')
    if ('refused' in result) throw new Error(result.refused)
    expect(result.items).toHaveLength(2)
    expect(result.items?.filter(item => item.attached)).toHaveLength(1)
    expect(openTickets(h.repo)).toHaveLength(2)
    const combined = openTickets(h.repo).find(ticket => ticket.id !== existing.id)!
    expect(combined.title).toBe('A')
    expect(combined.mandate.scope).toBe('Do A.\nDo B.\nDo C.')
    expect(h.repo.tickets.get(existing.id)!.inputs.some(input => input.kind === 'trigger')).toBe(true)
  })

  it('still starts one new ticket and attaches the other at maxTickets 1', () => {
    const h = harness('auto', 1)
    const first = h.dispatch({ title: 'Existing', scope: 'Existing work.' }, 'Existing work', 'msg_1')
    if ('refused' in first) throw new Error(first.refused)
    const result = h.dispatch({ items: [{ title: 'New', scope: 'New work.' },
      { ticketId: first.ticket!.id, scope: 'Status update.' }] }, 'New work and status', 'msg_2')
    if ('refused' in result) throw new Error(result.refused)
    expect(result.items).toHaveLength(2)
    expect(openTickets(h.repo)).toHaveLength(2)
  })

  it('falls back to the explicit parser in auto mode when the main Session supplied no items', () => {
    const h = harness('auto')
    const result = h.dispatch({}, '拆成以下任务：\n1、修复登录\n2、更新文档')
    if ('refused' in result) throw new Error(result.refused)
    expect(result.items).toHaveLength(2)
    expect(openTickets(h.repo)).toHaveLength(2)
  })

  it('refuses every item of a split while the conversation Source is off', () => {
    const h = harness('explicit', 5, { sources: { conversation: { enabled: false, config: {} } } })
    const result = h.dispatch({}, '1、A\n2、B')
    expect(result).toEqual({ refused: expect.stringContaining('off') })
    expect(h.repo.tickets.open()).toHaveLength(0)
  })

  it('reports one refused attach among accepted split items without losing the others', () => {
    const h = harness('auto')
    const result = h.dispatch({ items: [{ title: 'A', scope: 'Do A.' }, { ticketId: 'missing', scope: 'Status update.' },
      { title: 'C', scope: 'Do C.' }] }, 'A, status and C', 'msg_1')
    if ('refused' in result) throw new Error(result.refused)
    expect(result.items).toHaveLength(3)
    expect(result.items?.filter(item => item.refused)).toHaveLength(1)
    expect(openTickets(h.repo)).toHaveLength(2)
  })
})

describe('a message that already reached a ticket', () => {
  it('refuses a changed mode for the same message before receiving it', () => {
    const h = harness('auto')
    const first = h.dispatch({ items: [{ title: 'A', scope: 'Do A.' }, { title: 'B', scope: 'Do B.' }] }, 'A and B', 'msg_1')
    if ('refused' in first) throw new Error(first.refused)
    ;(h.settings.dispatch as { mode: string }).mode = 'single'
    const second = h.dispatch({ title: 'C', scope: 'Do C.' }, 'C', 'msg_1')
    expect(second).toEqual({ refused: expect.stringContaining('already reached a ticket') })
    expect(openTickets(h.repo)).toHaveLength(2)
  })

  it('refuses a changed plan before receiving it, leaving the existing tickets untouched', () => {
    const h = harness('auto')
    const first = h.dispatch({ items: [{ title: 'A', scope: 'Do A.' }, { title: 'B', scope: 'Do B.' }] }, 'A and B', 'msg_1')
    if ('refused' in first) throw new Error(first.refused)
    const ticket = first.ticket!
    const before = h.repo.tickets.get(ticket.id)!.inputs.length
    const second = h.dispatch({ items: [{ title: 'C', scope: 'Do C.' }, { title: 'D', scope: 'Do D.' }] }, 'C and D', 'msg_1')
    expect(second).toEqual({ refused: expect.stringContaining('already reached a ticket') })
    expect(openTickets(h.repo)).toHaveLength(2)
    expect(h.repo.tickets.get(ticket.id)!.inputs).toHaveLength(before)
  })
})

describe('attaches stay attaches in every mode', () => {
  it('attaches an attach-only auto plan to each named ticket without starting a new one', () => {
    const h = harness('auto')
    const first = h.dispatch({ title: 'One', scope: 'First.' }, 'First', 'msg_1')
    const second = h.dispatch({ title: 'Two', scope: 'Second.' }, 'Second', 'msg_2')
    if ('refused' in first || 'refused' in second) throw new Error('setup failed')
    const result = h.dispatch({ items: [{ ticketId: first.ticket!.id, scope: 'Update one.' },
      { ticketId: second.ticket!.id, scope: 'Update two.' }] }, 'Update both', 'msg_3')
    if ('refused' in result) throw new Error(result.refused)
    expect(result.items).toHaveLength(2)
    expect(result.items?.every(item => item.attached)).toBe(true)
    expect(openTickets(h.repo)).toHaveLength(2)
    expect(h.repo.tickets.get(first.ticket!.id)!.inputs.filter(input => input.kind === 'trigger').map(input => input.triggerId))
      .toContain(result.items![0]!.triggerId)
    expect(h.repo.tickets.get(second.ticket!.id)!.inputs.filter(input => input.kind === 'trigger').map(input => input.triggerId))
      .toContain(result.items![1]!.triggerId)
  })

  it('attaches a single item in single mode instead of starting a ticket', () => {
    const h = harness('single')
    const first = h.dispatch({ title: 'One', scope: 'First.' }, 'First', 'msg_1')
    if ('refused' in first) throw new Error(first.refused)
    const result = h.dispatch({ items: [{ ticketId: first.ticket!.id, scope: 'Update one.' }] }, 'Update one', 'msg_2')
    if ('refused' in result) throw new Error(result.refused)
    expect(result.attached).toBe(true)
    expect(openTickets(h.repo)).toHaveLength(1)
  })
})

describe('explicit parsing stays conservative', () => {
  it('does not split a status question that mentions items', () => {
    expect(explicitItems('确认 A、B 都完成了吗')).toBeUndefined()
    expect(explicitItems('A、B 目前是什么状态？')).toBeUndefined()
  })

  it('keeps the whole explicit list when auto mode supplied only one item', () => {
    const h = harness('auto')
    const result = h.dispatch({ items: [{ title: 'A', scope: 'Do A.' }] }, '拆成以下任务：\n1、A\n2、B')
    if ('refused' in result) throw new Error(result.refused)
    const ticket = openTickets(h.repo)[0]!
    expect(openTickets(h.repo)).toHaveLength(1)
    expect(ticket.mandate.scope).toContain('B')
  })

  it('keeps every new item in an over-wide fallback even when the caller supplied a scope', () => {
    const h = harness('auto', 2)
    const result = h.dispatch({ title: 'Combined', scope: 'One scope only.', items: [{ title: 'A', scope: 'Do A.' },
      { title: 'B', scope: 'Do B.' }, { title: 'C', scope: 'Do C.' }] }, 'A, B and C')
    if ('refused' in result) throw new Error(result.refused)
    const ticket = openTickets(h.repo)[0]!
    expect(ticket.mandate.scope).toContain('Do C.')
  })
})

describe('whole-message attach after a split', () => {
  it('refuses before receiving so no sibling ticket gains an input', () => {
    const h = harness('auto')
    const first = h.dispatch({ items: [{ title: 'A', scope: 'Do A.' }, { title: 'B', scope: 'Do B.' }] }, 'A and B', 'msg_1')
    if ('refused' in first) throw new Error(first.refused)
    const ids = openTickets(h.repo).map(ticket => ticket.id)
    const before = ids.map(id => h.repo.tickets.get(id)!.inputs.length)
    const second = h.dispatch({ ticketId: first.ticket!.id, note: 'status' }, 'A and B', 'msg_1')
    expect(second).toEqual({ refused: expect.stringContaining('already reached a ticket') })
    expect(ids.map(id => h.repo.tickets.get(id)!.inputs.length)).toEqual(before)
    expect(openTickets(h.repo)).toHaveLength(2)
  })
})

describe('a context-only follower', () => {
  it('does not block a whole-message attach to another ticket', () => {
    const h = harness('single')
    const target = h.dispatch({ title: 'Target', scope: 'Target.' }, 'Target', 'msg_1')
    if ('refused' in target) throw new Error(target.refused)
    h.repo.threads.save({ key: 'conversation:msg_2', ref: { source: 'conversation', id: 'msg_2' },
      createdAt: new Date().toISOString(), subscriptions: [target.ticket!.id], context: [target.ticket!.id],
      correlated: [], pending: [], meta: {} })
    const result = h.dispatch({ ticketId: target.ticket!.id }, 'A message the target follows for context.', 'msg_2')
    if ('refused' in result) throw new Error(result.refused)
    expect(result.attached).toBe(true)
  })
})

describe('repeating a plan with an attach', () => {
  it('reports a repeated whole-message attach as duplicate', () => {
    const h = harness('single')
    const target = h.dispatch({ title: 'Target', scope: 'Target.' }, 'Target', 'msg_1')
    if ('refused' in target) throw new Error(target.refused)
    const first = h.dispatch({ ticketId: target.ticket!.id, note: 'status' }, 'Status?', 'msg_2')
    if ('refused' in first) throw new Error(first.refused)
    expect(first.attached).toBe(true)
    const second = h.dispatch({ ticketId: target.ticket!.id, note: 'status' }, 'Status?', 'msg_2')
    expect(second).toEqual({ triggerId: first.triggerId, duplicate: true })
    expect(openTickets(h.repo)).toHaveLength(1)
  })

  it('reports a repeated mixed plan with an attach as duplicate', () => {
    const h = harness('auto')
    const target = h.dispatch({ title: 'Target', scope: 'Target.' }, 'Target', 'msg_1')
    if ('refused' in target) throw new Error(target.refused)
    const input = { items: [{ title: 'New', scope: 'Do new.' }, { ticketId: target.ticket!.id, scope: 'Status.' }] }
    const first = h.dispatch(input, 'New and status', 'msg_2')
    if ('refused' in first) throw new Error(first.refused)
    const tickets = openTickets(h.repo).length
    const inputs = h.repo.tickets.get(target.ticket!.id)!.inputs.length
    const second = h.dispatch(input, 'New and status', 'msg_2')
    if ('refused' in second) throw new Error(second.refused)
    expect(second.duplicate).toBe(true)
    expect(openTickets(h.repo)).toHaveLength(tickets)
    expect(h.repo.tickets.get(target.ticket!.id)!.inputs).toHaveLength(inputs)
  })
})

describe('more status questions', () => {
  it('does not split a list that asks whether items are done', () => {
    expect(explicitItems('确认 A、B 完成了没有')).toBeUndefined()
    expect(explicitItems('确认 A、B 完成没')).toBeUndefined()
    expect(explicitItems('1、A 完成了没有\n2、B 完成了没有')).toBeUndefined()
  })

  it('keeps a Session item that is not in the parsed list', () => {
    const h = harness('auto')
    const result = h.dispatch({ items: [{ title: 'C', scope: 'Do C.' }] }, '拆成以下任务：\n1、A\n2、B')
    if ('refused' in result) throw new Error(result.refused)
    const scope = openTickets(h.repo)[0]!.mandate.scope
    expect(scope).toContain('A')
    expect(scope).toContain('B')
    expect(scope).toContain('Do C.')
  })
})
