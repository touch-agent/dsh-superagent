import { expect, it } from 'vitest'
import type { ChannelRef, Thread, Ticket } from '@superagent/kernel'
import { contextGroupBoard, contextGroupDimension, contextGroupOf, type ContextGroupReadHost } from '@superagent/dsh/app/context-groups.ts'
import { ticketDetails, type TicketThread } from '@superagent/dsh/app/cards.ts'
import { registerHttp } from '@superagent/dsh/app/http.ts'
import type { HttpHost } from '@superagent/dsh/app/http.ts'
import { feishuKind } from '@superagent/dsh/sources/feishu.ts'
import { githubKind } from '@superagent/dsh/sources/github.ts'

const AT = '2026-11-10T00:00:00Z'

const feishuChannel = (chatId: string, messageId = 'om_1', direct = false): ChannelRef =>
  ({ source: 'feishu', thread: `feishu:${chatId}`, address: { chatId, messageId, ...direct ? { direct: 'true' } : {} } })
const githubChannel = (number = 12): ChannelRef => ({ source: 'github', thread: `github:${number}`, address: { number: String(number) } })
const conversationChannel: ChannelRef = { source: 'conversation', thread: 'conversation:root', address: {} }

const thread = (key: string, subscriptions: string[], extra: Partial<Thread> = {}): Thread => {
  const colon = key.indexOf(':')
  return { key, ref: { source: key.slice(0, colon), id: key.slice(colon + 1) }, createdAt: AT, subscriptions, correlated: [], pending: [],
    meta: {}, ...extra }
}

const ticket = (id: string, channels: ChannelRef[], follows: string[], fields: Partial<Ticket> = {}): Ticket => ({
  id, title: `Ticket ${id}`, decisionId: 'd1', channels, assignments: [], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
  origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] },
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
  follows: follows.map(thread => ({ thread, own: true })),
  ...fields,
})

/** The Source hooks as the registry exposes them: Feishu groups are chats, GitHub groups are repositories. */
const sources: ContextGroupReadHost['sources'] = {
  contextGroup: channel => {
    if (channel.source === 'feishu') {
      if (channel.address.direct === 'true' || !channel.address.chatId) return undefined
      return { source: 'feishu', space: channel.address.chatId, label: 'Team' }
    }
    if (channel.source === 'github' && channel.address.repository) return { source: 'github', space: channel.address.repository }
    return undefined
  },
  threadSpace: ref => {
    if (ref.source === 'feishu') return ref.id.split(':')[0]
    if (ref.source === 'github') return 'acme/widgets'
    return undefined
  },
}

const host = (tickets: Ticket[], threads: Thread[] = []): ContextGroupReadHost => ({
  store: {
    tickets: { allList: () => tickets },
    triggers: { get: () => undefined },
    read: { subscribedThreads: () => threads.filter(item => item.subscriptions.length > 0) },
  },
  sources,
})

it('derives the same group for one chat and different groups across chats', () => {
  const threads = [thread('feishu:oc_team:om_1', ['a']), thread('feishu:oc_team:om_2', ['b']), thread('feishu:oc_other:om_3', ['c'])]
  const a = ticket('a', [feishuChannel('oc_team', 'om_1')], ['feishu:oc_team:om_1'])
  const b = ticket('b', [feishuChannel('oc_team', 'om_2')], ['feishu:oc_team:om_2'])
  const c = ticket('c', [feishuChannel('oc_other', 'om_3')], ['feishu:oc_other:om_3'])
  const read = host([a, b, c], threads)
  expect(contextGroupOf(read, a)).toMatchObject({ key: 'feishu:oc_team', source: 'feishu', space: 'oc_team', label: 'Team', visibility: 'source',
    conventions: ['feishu:oc_team:om_1'] })
  expect(contextGroupOf(read, b)).toMatchObject({ key: 'feishu:oc_team', conventions: ['feishu:oc_team:om_2'] })
  expect(contextGroupOf(read, c)).toMatchObject({ key: 'feishu:oc_other' })
  expect(contextGroupOf(read, a)!.key).not.toBe(contextGroupOf(read, c)!.key)
  const board = contextGroupBoard(read, new Date('2026-11-10T12:00:00Z'))
  expect(board.groups).toEqual([
    expect.objectContaining({ key: 'feishu:oc_other', tickets: ['c'] }),
    expect.objectContaining({ key: 'feishu:oc_team', tickets: ['a', 'b'], conventions: ['feishu:oc_team:om_1', 'feishu:oc_team:om_2'] }),
  ])
  expect(board.totals).toEqual({ groups: 2, tickets: 3 })
})

it('is absent for a private conversation and for a direct Feishu chat, present for a group chat', () => {
  const privateTicket = ticket('private', [conversationChannel], ['conversation:root'])
  const directTicket = ticket('direct', [feishuChannel('oc_dm', 'om_9', true)], ['feishu:oc_dm:om_9'])
  const groupTicket = ticket('group', [feishuChannel('oc_team', 'om_1')], ['feishu:oc_team:om_1'])
  const read = host([privateTicket, directTicket, groupTicket], [thread('conversation:root', ['private']),
    thread('feishu:oc_dm:om_9', ['direct']), thread('feishu:oc_team:om_1', ['group'])])
  expect(contextGroupOf(read, privateTicket)).toBeUndefined()
  expect(contextGroupOf(read, directTicket)).toBeUndefined()
  expect(contextGroupOf(read, groupTicket)).toMatchObject({ key: 'feishu:oc_team' })
  expect(contextGroupBoard(read).totals).toEqual({ groups: 1, tickets: 1 })
})

it('drops the group after the Ticket leaves the shared space, without rewriting the Ticket', () => {
  const item = ticket('a', [feishuChannel('oc_team', 'om_1')], ['feishu:oc_team:om_1'])
  const subscribed = thread('feishu:oc_team:om_1', ['a'])
  expect(contextGroupOf(host([item], [subscribed]), item)).toBeDefined()
  const before = JSON.stringify(item)
  const left = thread('feishu:oc_team:om_1', [])
  expect(contextGroupOf(host([item], [left]), item)).toBeUndefined()
  expect(JSON.stringify(item)).toBe(before)
  expect(contextGroupBoard(host([item], [left])).groups).toEqual([])
})

it('carries no member list and no authorization field', () => {
  const item = ticket('a', [feishuChannel('oc_team', 'om_1')], ['feishu:oc_team:om_1'])
  const group = contextGroupOf(host([item], [thread('feishu:oc_team:om_1', ['a'])]), item)!
  expect(Object.keys(group).sort()).toEqual(['conventions', 'key', 'label', 'source', 'space', 'visibility'])
  expect(JSON.stringify(group)).not.toMatch(/member|users|mandate|actionLevel|approval|policy|permission/i)
  // Reading the projection does not change the Ticket's authorization facts.
  expect(item.mandate?.strength).toBe('explicit')
  expect(JSON.stringify(item)).not.toContain('context_group')
})

it('yields the T5-04 dimension entry without adding a group to the authorization path', () => {
  const item = ticket('a', [feishuChannel('oc_team', 'om_1')], ['feishu:oc_team:om_1'])
  const entry = contextGroupDimension(contextGroupOf(host([item], [thread('feishu:oc_team:om_1', ['a'])]), item)!)
  expect(entry).toMatchObject({ key: 'group:feishu:oc_team', source: 'feishu', scope: 'feishu:oc_team', strength: 'default',
    inheritance: 'inherit', truncation: 800 })
  expect(entry.text).toContain('feishu:oc_team:om_1')
  expect(entry).not.toHaveProperty('members')
})

it('projects the optional dimension into the ticket read model', () => {
  const item = ticket('a', [feishuChannel('oc_team', 'om_1')], ['feishu:oc_team:om_1'])
  const group = contextGroupOf(host([item], [thread('feishu:oc_team:om_1', ['a'])]), item)
  const threads: TicketThread[] = [{ thread: 'feishu:oc_team:om_1', bound: true }]
  expect(ticketDetails(item, threads, [], false, undefined, group).context_group).toEqual(group)
  expect(ticketDetails(item, threads, [], false).context_group).toBeUndefined()
})

it('serves GET contexts/groups as a read-only projection', async () => {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
    handlers.set(route.path, route.handler); return () => {} } } }
  const read = host([ticket('a', [feishuChannel('oc_team', 'om_1')], ['feishu:oc_team:om_1'])],
    [thread('feishu:oc_team:om_1', ['a'])])
  registerHttp(ctx as never, { ready: Promise.resolve(), ...read } as unknown as HttpHost)
  let status = 0, text = ''
  await handlers.get('/orchestrator')!({ method: 'GET', url: '/orchestrator/api/contexts/groups',
    headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' } }, { writeHead: (code: number) => { status = code },
    end: (data: string) => { text = data } })
  expect(status).toBe(200)
  expect(JSON.parse(text)).toMatchObject({ generatedAt: expect.any(String),
    groups: [{ key: 'feishu:oc_team', tickets: ['a'], conventions: ['feishu:oc_team:om_1'], visibility: 'source' }],
    totals: { groups: 1, tickets: 1 } })
})

it('derives Feishu group vs direct and the GitHub repository in the real Source adapters', () => {
  const feishu = feishuKind.schema.parse({ chats: [{ chatId: 'oc_team', name: 'Team', listen: 'mentions' }] })
  expect(feishuKind.contextGroup!({ chatId: 'oc_team' }, feishu)).toEqual({ space: 'oc_team', label: 'Team' })
  expect(feishuKind.contextGroup!({ chatId: 'oc_dm', direct: 'true' }, feishu)).toBeUndefined()
  expect(feishuKind.threadSpace!({ source: 'feishu', id: 'oc_team:om_1' }, feishu)).toBe('oc_team')
  const github = githubKind.schema.parse({ repository: 'acme/widgets' })
  expect(githubKind.contextGroup!({ number: '12' }, github)).toEqual({ space: 'acme/widgets', label: 'acme/widgets',
    url: 'https://github.com/acme/widgets' })
  expect(githubKind.threadSpace!({ source: 'github', id: '12' }, github)).toBe('acme/widgets')
  expect(githubKind.contextGroup!({ number: '12' }, githubKind.schema.parse({}))).toBeUndefined()
  expect(conversationChannel.source).toBe('conversation')
})
