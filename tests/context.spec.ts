import { describe, expect, it } from 'vitest'
import type { Assignment, ChannelRef, ContextEntry, ContextSnapshot, Thread, Ticket, Trigger } from '@superagent/kernel'
import { CONTEXT_DIMENSIONS, traceId } from '@superagent/kernel'
import { assembleContext, mergeContextEntries, type ContextAssembly, type ContextAssemblyHost } from '@superagent/dsh/app/context-assembly.ts'
import { contextGroupOf, type ContextGroupReadHost, type ContextGroupView } from '@superagent/dsh/app/context-groups.ts'

const AT = '2026-11-11T00:00:00Z'
const ACTOR = { source: 'feishu', id: 'ou_alice' }
const FEISHU: ChannelRef = { source: 'feishu', thread: 'feishu:oc_team:om_1', address: { chatId: 'oc_team', messageId: 'om_1' } }
const GROUP: ContextGroupView = { key: 'feishu:oc_team', source: 'feishu', space: 'oc_team', visibility: 'source',
  conventions: ['feishu:oc_team:om_1'] }

const assignment = (id = 'a1'): Assignment => ({ id, state: 'running', createdAt: AT })

const ticket = (id: string, fields: Partial<Ticket> = {}): Ticket => ({
  id, title: 'Fix the login regression', decisionId: `d-${id}`, channels: [FEISHU], assignments: [assignment(`a-${id}`)], inputs: [], undelivered: [],
  createdAt: AT, updatedAt: AT, origin: { triggerId: `t-${id}`, triggerIds: [`t-${id}`] },
  mandate: { strength: 'explicit', policyVersion: 'policy-7', basis: { via: 'listed' }, actor: ACTOR, scope: 'Fix the login regression' },
  ...fields,
})

const childTicket = (id: string, goal: string, fields: Partial<Ticket> = {}): Ticket => ticket(id, {
  decisionId: undefined, mandate: undefined, parentTicketId: 'root', rootTicketId: 'root',
  delegation: { parentTicketId: 'root', rootTicketId: 'root', goal, requestedBy: { ticketId: 'root', sessionId: 'worker-root' },
    attempt: 1, createdAt: AT }, ...fields,
})

const trigger = (id: string, fields: Partial<Trigger> = {}): Trigger => ({
  id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_team:om_1' }], actor: ACTOR, human: true, at: AT,
  text: 'Please fix the login regression', channel: FEISHU, meta: {}, ...fields,
})

const thread = (key: string, subscriptions: string[]): Thread => {
  const colon = key.indexOf(':')
  return { key, ref: { source: key.slice(0, colon), id: key.slice(colon + 1) }, createdAt: AT, subscriptions, correlated: [], pending: [], meta: {} }
}

/** The Source hooks the group projection reads, reduced to the two spaces these tests use. */
const sources: ContextGroupReadHost['sources'] = {
  contextGroup: channel => channel.source === 'feishu' && channel.address.chatId
    ? { source: 'feishu', space: channel.address.chatId } : undefined,
  threadSpace: ref => ref.source === 'feishu' ? ref.id.split(':')[0] : undefined,
}

interface HostOptions {
  group?: (ticket: Ticket) => ContextGroupView | undefined
  policy?: () => string
  prompt?: () => number
  entries?: (ticket: Ticket) => readonly ContextEntry[]
}

/** A host over fixed tickets and triggers that records which Ticket ids the assembler actually read. */
function hostFor(tickets: Ticket[], triggers: Trigger[], options: HostOptions = {}) {
  const reads: string[] = []
  const host: ContextAssemblyHost = {
    ticket: id => { reads.push(id); return tickets.find(item => item.id === id) },
    trigger: id => triggers.find(item => item.id === id),
    group: options.group ?? (() => undefined),
    policyVersion: options.policy ?? (() => 'policy-7'),
    promptRevision: options.prompt ?? (() => 3),
    ...(options.entries ? { entries: options.entries } : {}),
  }
  return { host, reads }
}

function assembled(result: ContextAssembly) {
  if (result.state !== 'assembled') throw new Error(`expected assembled, got ${result.block.summary}`)
  return result
}

function blocked(result: ContextAssembly) {
  if (result.state !== 'blocked') throw new Error('expected a blocked assembly')
  return result
}

const entry = (values: Pick<ContextEntry, 'key' | 'dimension' | 'text'> & Partial<ContextEntry>): ContextEntry => ({
  source: `test:${values.key}`, scope: `${values.dimension}:${values.key}`, strength: 'default', inheritance: 'private',
  truncation: 500, ...values,
})

const byKey = (snapshot: ContextSnapshot) => new Map(snapshot.entries.map(item => [item.key, item]))

describe('context assembly', () => {
  it('assembles each present dimension from its own source and records the absent one', () => {
    const root = ticket('root')
    const origin = trigger('t-root')
    const { host } = hostFor([root], [origin], { group: target => target.id === 'root' ? GROUP : undefined })
    const result = assembled(assembleContext(host, root, assignment('a1'), new Date(AT)))
    const snapshot = result.snapshot

    expect(snapshot.dimensions).toEqual(['organization', 'user', 'group', 'task', 'agent'])
    expect(snapshot.absent).toEqual(['subtask'])
    expect(snapshot.assignmentId).toBe('a1')
    expect(snapshot.rootTicketId).toBe('root')
    expect(snapshot.sources).toMatchObject({ organization: 'policy:policy-7;prompt:3', user: 'trigger:t-root',
      group: 'feishu:oc_team', task: 'ticket:root', agent: 'assignment:a1' })

    const entries = new Map(result.prompt.entries.map(item => [item.key, item]))
    expect(entries.get('organization:policy')).toMatchObject({ dimension: 'organization', source: 'policy',
      scope: 'organization:policy-7', strength: 'constraint', inheritance: 'inherit' })
    expect(entries.get('organization:prompts')).toMatchObject({ scope: 'organization:prompt-3', strength: 'default' })
    expect(entries.get('user:actor')).toMatchObject({ dimension: 'user', source: 'trigger:t-root', scope: 'user:feishu:ou_alice',
      strength: 'default', inheritance: 'private' })
    expect(entries.get('group:feishu:oc_team')).toMatchObject({ dimension: 'group', source: 'feishu', scope: 'feishu:oc_team',
      strength: 'default', inheritance: 'inherit' })
    expect(entries.get('task:goal')).toMatchObject({ dimension: 'task', scope: 'task:root', strength: 'default' })
    expect(entries.get('task:mandate')).toMatchObject({ strength: 'constraint' })
    expect(entries.get('agent:role')).toMatchObject({ dimension: 'agent', source: 'worker:root', inheritance: 'private' })
    expect(entries.get('agent:profile')).toMatchObject({ source: 'profile:legacy' })

    // The snapshot names what applied and hashes it, but never copies the text the worker read.
    expect(JSON.stringify(snapshot)).not.toContain('Started by')
    expect(JSON.stringify(snapshot)).not.toContain('Root goal:')
    expect(JSON.stringify(snapshot)).not.toContain('Please fix the login regression')
    for (const item of snapshot.entries) {
      expect(item).not.toHaveProperty('text')
      expect(item.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(item.chars).toBeGreaterThan(0)
    }
  })

  it('inherits task, user and group from the root for a child, but takes the subtask from that child only', () => {
    const root = ticket('root')
    const child = childTicket('child', 'Fix only the parser branch')
    const grandchild = childTicket('grandchild', 'Fix the grandchild title', { parentTicketId: 'child' })
    grandchild.delegation!.parentTicketId = 'child'
    const origin = trigger('t-root')
    const { host, reads } = hostFor([root, child, grandchild], [origin], { group: target => target.id === 'root' ? GROUP : undefined })
    const result = assembled(assembleContext(host, grandchild, assignment('a-g'), new Date(AT)))

    expect(result.snapshot.dimensions).toEqual([...CONTEXT_DIMENSIONS])
    const entries = new Map(result.prompt.entries.map(item => [item.key, item]))
    expect(entries.get('task:goal')!.text).toBe('Root goal: Fix the login regression.')
    expect(entries.get('group:feishu:oc_team')).toBeDefined()
    expect(entries.get('subtask:goal')!.text).toBe('Child goal: Fix the grandchild title.')
    // The parent child's private process is not in a sibling or grandchild context, and the assembler read only the root.
    expect(result.prompt.entries.some(item => item.text.includes('Fix only the parser branch'))).toBe(false)
    expect(reads).toEqual(['root'])
  })

  it('leaves the user and group dimensions absent for a bot origin without a shared space', () => {
    const root = ticket('root')
    const origin = trigger('t-root', { human: false })
    const result = assembled(assembleContext(hostFor([root], [origin]).host, root, assignment('a1'), new Date(AT)))
    expect(result.snapshot.dimensions).toEqual(['organization', 'task', 'agent'])
    expect(result.snapshot.absent).toEqual(['user', 'group', 'subtask'])
    expect(result.prompt.entries.some(item => item.dimension === 'user' || item.dimension === 'group')).toBe(false)
  })

  it('assembles only the task dimension for a lightweight Ticket', () => {
    const light = ticket('light', { form: 'lightweight', assignments: [] })
    const result = assembled(assembleContext(hostFor([light], [trigger('t-light')]).host, light, undefined, new Date(AT)))
    expect(result.snapshot.dimensions).toEqual(['task'])
    expect(result.snapshot.absent).toEqual(['organization', 'user', 'group', 'subtask', 'agent'])
    expect(result.snapshot.assignmentId).toBeUndefined()
    expect(result.prompt.entries.map(item => item.dimension)).toEqual(['task', 'task', 'task'])
  })

  it('merges a constraint over a default on the same key and records the decision', () => {
    const root = ticket('root')
    const entries = [
      entry({ key: 'reply:language', dimension: 'group', source: 'group-convention', scope: 'group:feishu:oc_team',
        strength: 'default', text: 'English' }),
      entry({ key: 'reply:language', dimension: 'task', source: 'ticket-instruction', scope: 'task:root',
        strength: 'constraint', text: 'Chinese' }),
    ]
    const { host } = hostFor([root], [trigger('t-root')], { group: () => GROUP, entries: () => entries })
    const result = assembled(assembleContext(host, root, assignment('a1'), new Date(AT)))
    expect(result.prompt.entries.find(item => item.key === 'reply:language')!.text).toBe('Chinese')
    expect(result.snapshot.merges).toEqual([{ key: 'reply:language', winner: 'task:ticket-instruction',
      losers: ['group:group-convention'] }])
    expect(result.snapshot.conflicts).toEqual([])
  })

  it('compares scope only among equal-strength defaults and keeps the more specific one', () => {
    const root = ticket('root')
    const entries = [
      entry({ key: 'reply:tone', dimension: 'group', source: 'group-default', scope: 'group:feishu:oc_team', text: 'Team tone' }),
      entry({ key: 'reply:tone', dimension: 'task', source: 'task-default', scope: 'task:root', text: 'Task tone' }),
    ]
    const { host } = hostFor([root], [trigger('t-root')], { group: () => GROUP, entries: () => entries })
    const result = assembled(assembleContext(host, root, assignment('a1'), new Date(AT)))
    expect(result.prompt.entries.find(item => item.key === 'reply:tone')!.text).toBe('Task tone')
    expect(result.snapshot.merges).toEqual([{ key: 'reply:tone', winner: 'task:task-default', losers: ['group:group-default'] }])
  })

  it('fails closed on an equal-strength conflict instead of choosing a winner', () => {
    const root = ticket('root')
    const entries = [
      entry({ key: 'reply:language', dimension: 'group', source: 'group-rule', scope: 'group:feishu:oc_team',
        strength: 'constraint', text: 'English' }),
      entry({ key: 'reply:language', dimension: 'task', source: 'task-rule', scope: 'task:root', strength: 'constraint', text: 'Chinese' }),
    ]
    const { host } = hostFor([root], [trigger('t-root')], { group: () => GROUP, entries: () => entries })
    const result = blocked(assembleContext(host, root, assignment('a1'), new Date(AT)))
    expect(result.snapshot.state).toBe('blocked')
    expect(result.snapshot.conflicts).toEqual([{ key: 'reply:language', strength: 'constraint', dimensions: ['group', 'task'],
      sources: ['group:group-rule', 'task:task-rule'] }])
    expect(result.snapshot.entries.some(item => item.key === 'reply:language')).toBe(false)
    expect(result.block.question).toContain('reply:language')
    expect(result.block.question).toContain('Decide which applies')
  })

  it('fails closed when a required dimension is missing', () => {
    const root = ticket('root')
    const noAssignment = blocked(assembleContext(hostFor([root], [trigger('t-root')]).host, root, undefined, new Date(AT)))
    expect(noAssignment.snapshot.blocked?.reason).toBe('missing')
    expect(noAssignment.snapshot.blocked).toMatchObject({ reason: 'missing', dimension: 'agent' })
    // Do not claim the resolved dimensions are absent just because the last one blocked the assembly.
    expect(noAssignment.snapshot.dimensions).toEqual(['organization', 'user', 'task'])
    expect(noAssignment.snapshot.absent).toEqual(['group', 'subtask', 'agent'])

    const noMandate = ticket('root', { mandate: undefined })
    const missingTask = blocked(assembleContext(hostFor([noMandate], [trigger('t-root')]).host, noMandate, assignment('a1'), new Date(AT)))
    expect(missingTask.snapshot.blocked).toMatchObject({ reason: 'missing', dimension: 'task' })
    expect(missingTask.snapshot.dimensions).toEqual(['organization', 'user'])
    expect(missingTask.snapshot.blocked?.detail).toContain('no Mandate')

    const child = ticket('child', { decisionId: undefined, mandate: undefined, parentTicketId: 'root', rootTicketId: 'root' })
    const missingSubtask = blocked(assembleContext(hostFor([root, child], [trigger('t-root')]).host, child, assignment('a-c'), new Date(AT)))
    expect(missingSubtask.snapshot.blocked).toMatchObject({ reason: 'missing', dimension: 'subtask' })
  })

  it('fails closed when a dimension source cannot be read, rather than defaulting it', () => {
    const root = ticket('root')
    const unreadableGroup = blocked(assembleContext(hostFor([root], [trigger('t-root')], {
      group: () => { throw new Error('shared-space lookup failed') } }).host, root, assignment('a1'), new Date(AT)))
    expect(unreadableGroup.snapshot.blocked).toMatchObject({ reason: 'unreadable', dimension: 'group' })
    expect(unreadableGroup.snapshot.dimensions).toEqual(['organization', 'user'])
    expect(unreadableGroup.block.summary).toContain('shared-space lookup failed')

    const unreadablePolicy = blocked(assembleContext(hostFor([root], [trigger('t-root')], {
      policy: () => { throw new Error('policy store unavailable') } }).host, root, assignment('a1'), new Date(AT)))
    expect(unreadablePolicy.snapshot.blocked).toMatchObject({ reason: 'unreadable', dimension: 'organization' })
    expect(unreadablePolicy.snapshot.dimensions).toEqual([])
  })

  it('drops the group from the next snapshot after the Ticket leaves the shared space, without rewriting the Ticket', () => {
    let threads = [thread('feishu:oc_team:om_1', ['root'])]
    const root = ticket('root', { follows: [{ thread: 'feishu:oc_team:om_1', own: true }] })
    const origin = trigger('t-root')
    const groupReadHost: ContextGroupReadHost = {
      store: { tickets: { allList: () => [root] }, triggers: { get: () => origin },
        read: { subscribedThreads: () => threads.filter(item => item.subscriptions.length > 0) } },
      sources,
    }
    const { host } = hostFor([root], [origin], { group: target => contextGroupOf(groupReadHost, target) })
    const before = assembled(assembleContext(host, root, assignment('a1'), new Date(AT)))
    expect(before.snapshot.dimensions).toContain('group')
    threads = []
    const after = assembled(assembleContext(host, root, assignment('a2'), new Date(AT)))
    expect(after.snapshot.dimensions).not.toContain('group')
    expect(after.snapshot.absent).toContain('group')
    expect(after.snapshot.hash).not.toBe(before.snapshot.hash)
    // Leaving the space changes the next assembly, not the Ticket or the assembly that already ran.
    expect(root.channels).toEqual([FEISHU])
    expect(root.follows).toEqual([{ thread: 'feishu:oc_team:om_1', own: true }])
    expect(root.updatedAt).toBe(AT)
  })

  it('replays the same manifest for the same facts and changes the hash when a source revision moves', () => {
    const root = ticket('root')
    const secret = 'PRIVATE BODY THAT MUST NOT BE IN THE SNAPSHOT'
    const { host } = hostFor([root], [trigger('t-root')], { group: () => GROUP,
      entries: () => [entry({ key: 'user:preference', dimension: 'user', source: 'preference:1', text: secret })] })
    const first = assembled(assembleContext(host, root, assignment('a1'), new Date(AT)))
    const replay = assembled(assembleContext(host, root, assignment('a1'), new Date('2026-11-12T09:30:00Z')))
    expect(replay.snapshot.entries).toEqual(first.snapshot.entries)
    expect(replay.snapshot.assembledAt).not.toBe(first.snapshot.assembledAt)
    expect(replay.snapshot.hash).toBe(first.snapshot.hash)
    expect(JSON.stringify(first.snapshot)).not.toContain(secret)
    const moved = assembled(assembleContext(hostFor([root], [trigger('t-root')], { group: () => GROUP, policy: () => 'policy-8',
      entries: () => [entry({ key: 'user:preference', dimension: 'user', source: 'preference:1', text: secret })] }).host,
    root, assignment('a1'), new Date(AT)))
    expect(moved.snapshot.hash).not.toBe(first.snapshot.hash)
  })

  it('never adds an authorization dimension or an action level', () => {
    const root = ticket('root')
    const result = assembled(assembleContext(hostFor([root], [trigger('t-root')], { group: () => GROUP }).host, root, assignment('a1'), new Date(AT)))
    expect(result.snapshot.dimensions).toEqual(['organization', 'user', 'group', 'task', 'agent'])
    expect(result.snapshot.dimensions.every(dimension => CONTEXT_DIMENSIONS.includes(dimension))).toBe(true)
    const serialized = JSON.stringify(result.snapshot)
    expect(serialized).not.toMatch(/actionLevel|approval|admitted/i)
    expect(serialized).not.toContain('"mandate"')
    expect(result.prompt.entries.find(item => item.key === 'task:mandate')!.text).toContain('grants nothing')
  })

  it('orders entries deterministically and truncates at each entry ceiling', () => {
    const root = ticket('root')
    const long = 'x'.repeat(900)
    const { host } = hostFor([root], [trigger('t-root')], { group: () => GROUP,
      entries: () => [entry({ key: 'user:long', dimension: 'user', text: long, truncation: 40 })] })
    const result = assembled(assembleContext(host, root, assignment('a1'), new Date(AT)))
    const item = result.prompt.entries.find(value => value.key === 'user:long')!
    expect(item.text).toHaveLength(40)
    expect(item.truncated).toBe(true)
    const dimensionIndex = new Map(CONTEXT_DIMENSIONS.map((dimension, index) => [dimension, index]))
    const order = result.prompt.entries.map(value => dimensionIndex.get(value.dimension)!)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(result.snapshot.entries.find(value => value.key === 'user:long')).toMatchObject({ chars: 40, truncated: true })
  })

  it('fails closed when two equal-strength defaults disagree at the same scope rank', () => {
    const root = ticket('root')
    const entries = [
      entry({ key: 'reply:style', dimension: 'task', source: 'a', scope: 'task:root', text: 'Short' }),
      entry({ key: 'reply:style', dimension: 'task', source: 'b', scope: 'task:root', text: 'Long' }),
    ]
    const result = blocked(assembleContext(hostFor([root], [trigger('t-root')], { entries: () => entries }).host,
      root, assignment('a1'), new Date(AT)))
    expect(result.snapshot.conflicts).toEqual([{ key: 'reply:style', strength: 'default', dimensions: ['task'],
      sources: ['task:a', 'task:b'] }])
    expect(result.snapshot.blocked?.reason).toBe('conflict')
  })

  it('compares full text before truncation, so a hidden difference still conflicts', () => {
    const root = ticket('root')
    const entries = [
      entry({ key: 'reply:long', dimension: 'task', source: 'a', scope: 'task:root', strength: 'constraint',
        truncation: 20, text: `${'x'.repeat(20)}A` }),
      entry({ key: 'reply:long', dimension: 'task', source: 'b', scope: 'task:root', strength: 'constraint',
        truncation: 20, text: `${'x'.repeat(20)}B` }),
    ]
    const result = blocked(assembleContext(hostFor([root], [trigger('t-root')], { entries: () => entries }).host,
      root, assignment('a1'), new Date(AT)))
    expect(result.snapshot.conflicts[0]).toMatchObject({ key: 'reply:long', strength: 'constraint' })
    expect(result.snapshot.blocked?.reason).toBe('conflict')
  })

  it('bounds a conflict detail even when a host supplies many conflicting keys', () => {
    const root = ticket('root')
    const entries = [
      ...Array.from({ length: 12 }, (_, index): ContextEntry => entry({ key: `reply:k${index}`, dimension: 'task',
        source: 'a', scope: 'task:root', text: 'a' })),
      ...Array.from({ length: 12 }, (_, index): ContextEntry => entry({ key: `reply:k${index}`, dimension: 'task',
        source: 'b', scope: 'task:root', text: 'b' })),
    ]
    const result = blocked(assembleContext(hostFor([root], [trigger('t-root')], { entries: () => entries }).host,
      root, assignment('a1'), new Date(AT)))
    expect(result.snapshot.conflicts).toHaveLength(12)
    expect(result.snapshot.blocked!.detail.length).toBeLessThanOrEqual(300)
    expect(result.block.question.length).toBeLessThanOrEqual(500)
  })

  it('rejects a host entry whose truncation ceiling is unbounded', () => {
    const root = ticket('root')
    const result = blocked(assembleContext(hostFor([root], [trigger('t-root')], {
      entries: () => [entry({ key: 'user:huge', dimension: 'user', text: 'x', truncation: 10_000 })] }).host,
    root, assignment('a1'), new Date(AT)))
    expect(result.snapshot.blocked?.reason).toBe('unreadable')
    expect(result.snapshot.blocked?.detail).toContain('truncation outside')
  })

  it('merges keyed entries without a text copy and rejects an invalid extra entry', () => {
    const merged = mergeContextEntries([
      entry({ key: 'k', dimension: 'group', source: 'g', text: 'same' }),
      entry({ key: 'k', dimension: 'task', source: 't', text: 'same' }),
    ])
    expect(merged.entries).toHaveLength(1)
    expect(merged.conflicts).toEqual([])
    // Agreeing text does not erase the stronger strength: the constraint still supplies the entry.
    const agreeing = mergeContextEntries([
      entry({ key: 'same', dimension: 'group', source: 'g', text: 'Agreed' }),
      entry({ key: 'same', dimension: 'task', source: 't', strength: 'constraint', text: 'Agreed' }),
    ])
    expect(agreeing.entries[0]).toMatchObject({ dimension: 'task', source: 't', strength: 'constraint' })
    expect(agreeing.conflicts).toEqual([])
    const invalid = blocked(assembleContext(hostFor([ticket('root')], [trigger('t-root')], {
      entries: () => [entry({ key: 'bad', dimension: 'user', text: 'x', truncation: 0 })] }).host, ticket('root'),
    assignment('a1'), new Date(AT)))
    expect(invalid.snapshot.blocked?.reason).toBe('unreadable')

    const bot = ticket('bot-ticket', { mandate: { strength: 'explicit', policyVersion: 'policy-7', basis: { via: 'listed' },
      actor: ACTOR, scope: 'Fix the login regression' } })
    const absentUser = blocked(assembleContext(hostFor([bot], [trigger('t-bot-ticket', { human: false })], {
      entries: () => [entry({ key: 'user:preference', dimension: 'user', text: 'x' })] }).host, bot, assignment('a1'), new Date(AT)))
    expect(absentUser.snapshot.blocked?.reason).toBe('unreadable')
    expect(absentUser.snapshot.blocked?.detail).toContain('no present subject')
  })
})
