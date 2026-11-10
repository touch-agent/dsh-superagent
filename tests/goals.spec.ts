import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { enterReview, type Assignment, type Ticket } from '@superagent/kernel'
import { registerHttp } from '@superagent/dsh/app/http.ts'
import type { HttpHost } from '@superagent/dsh/app/http.ts'
import { goalBoard, goalDetail, goalView } from '@superagent/dsh/app/goals.ts'
import { ticketCard } from '@superagent/dsh/app/cards.ts'
import { taskBoard } from '@superagent/dsh/app/tasks.ts'
import { Store } from '@superagent/dsh/app/store.ts'
import type { ViewHost } from '@superagent/dsh/app/views/records.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-goals-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const AT = '2026-09-22T00:00:00Z'
const ticket = (fields: Partial<Ticket> & { id: string; title: string }): Ticket => ({
  decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
    actor: { source: 'conversation', id: 'local-user' }, scope: '' },
  channels: [{ source: 'conversation', thread: 'conversation:local', address: {} }], assignments: [], inputs: [], undelivered: [],
  createdAt: AT, updatedAt: AT, origin: { triggerId: 'tr', triggerIds: ['tr'] }, ...fields })

const reportOf = (withReview: boolean, accepted = false): Assignment['report'] => {
  const review = withReview ? enterReview({ artifact: { kind: 'document', ref: 'docs/plan/report.md', revision: 'r7' },
    previewRef: { kind: 'text/redline', ref: 'preview-7', revision: 'r7' },
    acceptanceCriteria: [{ kind: 'rule', rule: 'pr.merged' }, { kind: 'human', reason: 'A person signs off' }] }) : undefined
  return { state: 'ready', summary: 'Prepared the report', at: '2026-09-22T02:00:00Z', ...review ? { review } : {},
    ...accepted ? { accepted: { by: { source: 'github', id: 'alice' }, at: '2026-09-22T03:00:00Z', reviewRevision: 'review-7' } } : {} }
}

const assignment = (withReview: boolean, accepted = false): Assignment => ({ id: 'assignment-1', state: 'ended',
  createdAt: '2026-09-22T01:00:00Z', report: reportOf(withReview, accepted) })

const host = (tickets: Ticket[]) => ({ store: { tickets: { allList: () => tickets, get: (id: string) => tickets.find(item => item.id === id) } } })

it('returns an explicit empty list when no Ticket exists', () => {
  const board = goalBoard(host([]), new Date('2026-09-23T12:00:00Z'))
  expect(board).toEqual({ generatedAt: '2026-09-23T12:00:00.000Z', goals: [], totals: { goals: 0, open: 0, attention: 0 } })
  expect(goalDetail(host([]), 'missing')).toBeUndefined()
})

it('describes a Ticket with no deliverable without inventing a result or a review', () => {
  const ended = ticket({ id: 't1', title: '整理迁移说明', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '整理迁移说明' },
  ended: { at: '2026-09-22T03:00:00Z', by: 'executor', outcome: 'completed' } })
  expect(goalView(ended)).toEqual({ id: 't1', statement: '整理迁移说明', source: 'conversation',
    state: { stage: 'ended', outcome: 'completed', endedAt: '2026-09-22T03:00:00Z' }, results: [], read: 'ticket/t1' })
})

it('states what a person must decide, from the question or from the person stage', () => {
  const asked = ticket({ id: 'asked', title: '修改设置页', attention: { id: 'q1', question: '保留旧接口吗？' } })
  expect(goalView(asked).decision).toEqual({ kind: 'answer', question: '保留旧接口吗？' })
  expect(goalView(asked).state).toEqual({ stage: 'person', action: 'answer' })

  const review = ticket({ id: 'ready', title: '交付报告', assignments: [assignment(true)] })
  expect(goalView(review)).toMatchObject({ state: { stage: 'person', action: 'review' }, decision: { kind: 'review' },
    results: [{ key: 'document:docs/plan/report.md:r7', artifact: { kind: 'document', ref: 'docs/plan/report.md', revision: 'r7' } }],
    acceptance: { criteria: 1, confirmations: 1 } })

  const blocked = ticket({ id: 'blocked', title: '修 CI', assignments: [{ id: 'a1', state: 'running', createdAt: AT,
    report: { state: 'blocked', summary: 'CI is red', at: AT } }] })
  expect(goalView(blocked)).toMatchObject({ state: { stage: 'person', action: 'blocked' }, decision: { kind: 'blocked' } })
})

it('derives the statement from the delegated goal, the Mandate scope, then the title', () => {
  const delegated = ticket({ id: 'child', title: '子任务标题', parentTicketId: 'root', rootTicketId: 'root',
    channels: [], delegation: { parentTicketId: 'root', rootTicketId: 'root', goal: '补齐迁移说明', attempt: 1,
      requestedBy: { ticketId: 'root', sessionId: 'worker-root' }, createdAt: AT } })
  expect(goalView(delegated).statement).toBe('补齐迁移说明')
  expect(goalView(delegated).source).toBeUndefined()
  const scoped = ticket({ id: 'root', title: '标题', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
    actor: { source: 'conversation', id: 'local-user' }, scope: '把登录回归修好' } })
  expect(goalView(scoped).statement).toBe('把登录回归修好')
  expect(goalView(ticket({ id: 'bare', title: '只有标题', mandate: undefined })).statement).toBe('只有标题')
})

it('is the same projection in the main Session card and the task row', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const item = ticket({ id: 't1', title: '修复登录（T2-03）', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '修复登录回归' },
  assignments: [assignment(true, true)] })
  store.tickets.save(item)
  const viewHost: ViewHost = { store, sources: { kind: () => undefined } as never, links: () => ({}) as never }
  const card = ticketCard(item).goal
  const row = taskBoard(viewHost, new Date('2026-09-23T00:00:00Z')).tasks[0]!.goal
  expect(row).toEqual(card)
  expect(card).toEqual(goalView(item))
  expect(card.results[0]!.artifact.ref).toBe('docs/plan/report.md')
  expect(card.acceptance).toMatchObject({ criteria: 1, confirmations: 1, acceptedAt: '2026-09-22T03:00:00Z' })
})

it('excludes Assignment, worker, Session and authorization internals from E0', () => {
  const item = ticket({ id: 't1', title: '修复登录（T2-03）', assignments: [assignment(true)],
    execution: { name: 't1', directory: '/srv/work/t1', assignment: 'work on it' } })
  const projected = JSON.stringify({ ...ticketCard(item).goal, row: goalView(item) })
  expect(projected).not.toMatch(/assignment-1|worker-|Session|sessionId|maxActionLevel|policyVersion|basis|Approval/i)
  expect(ticketCard(item).goal).not.toHaveProperty('assignments')
  expect(ticketCard(item).goal).not.toHaveProperty('mandate')
})

it('can be deleted without changing the Ticket or any write path', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const item = ticket({ id: 't1', title: '修复登录', assignments: [assignment(true)] })
  store.tickets.save(item)
  const before = JSON.stringify(store.tickets.get('t1'))
  const writes: string[] = []
  const readOnly = { store: { tickets: {
    allList: () => { writes.push('allList'); return store.tickets.allList() },
    get: (id: string) => { writes.push('get'); return store.tickets.get(id) },
  } } }
  goalBoard(readOnly)
  goalDetail(readOnly, 't1')
  expect(writes).toEqual(['allList', 'get'])
  expect(JSON.stringify(store.tickets.get('t1'))).toBe(before)
})

function serve(store: { tickets: { allList: () => Ticket[]; get: (id: string) => Ticket | undefined } }) {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>()
  const ctx = { webServer: { host: '127.0.0.1', port: 3082, register: (route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
    handlers.set(route.path, route.handler); return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), store } as unknown as HttpHost)
  return async (path: string) => {
    let status = 0, text = ''
    const req = { method: 'GET', url: `/orchestrator/api/${path}`,
      headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' } }
    await handlers.get('/orchestrator')!(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('serves GET goals and GET goals/:id as read-only endpoints', async () => {
  const tickets = [ticket({ id: 't1', title: '修复登录' }), ticket({ id: 't2', title: '子任务', parentTicketId: 't1', rootTicketId: 't1' })]
  const call = serve(host(tickets).store)
  const list = await call('goals')
  expect(list.status).toBe(200)
  expect(list.body).toMatchObject({ totals: { goals: 1, open: 1, attention: 0 } })
  expect((list.body.goals as unknown[])[0]).toMatchObject({ id: 't1', statement: '修复登录', read: 'ticket/t1' })
  expect((await call('goals/t2')).body).toMatchObject({ goal: { id: 't2', read: 'ticket/t2' } })
  expect(await call('goals/missing')).toEqual({ status: 404, body: { error: 'Goal not found' } })
})

it('answers the four E0 questions for every Ticket form', () => {
  const cases = [
    ticket({ id: 'working', title: '写迁移说明', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
      actor: { source: 'conversation', id: 'local-user' }, scope: '写迁移说明' } }),
    ticket({ id: 'waiting', title: '等确认', attention: { id: 'q', question: '保留旧接口吗？' } }),
    ticket({ id: 'ready', title: '交付报告', assignments: [assignment(true)] }),
    ticket({ id: 'done', title: '旧工单', ended: { at: AT, by: 'human', outcome: 'stopped' } }),
    ticket({ id: 'light', title: '查一句文案', form: 'lightweight' }),
  ]
  for (const item of cases) {
    const goal = goalView(item)
    expect(goal.statement).toBeTruthy()
    expect(goal.state.stage).toBeTruthy()
    expect(Array.isArray(goal.results)).toBe(true)
    expect(goal.read).toBe(`ticket/${item.id}`)
    if (goal.decision) expect(typeof goal.decision.kind).toBe('string')
  }
})

it('answers the C1.1 walkthrough scenario in one projection', () => {
  const item = ticket({ id: 'walkthrough', title: '修复登录（T2-03）', mandate: { strength: 'explicit', policyVersion: 'v1',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '修复登录回归' },
  attention: { id: 'q1', question: '保留旧版登录接口吗？' }, assignments: [assignment(true)] })
  const goal = goalView(item)
  expect(goal.statement).toBe('修复登录回归')
  expect(goal.state).toEqual({ stage: 'person', action: 'answer' })
  expect(goal.decision).toEqual({ kind: 'answer', question: '保留旧版登录接口吗？' })
  expect(goal.results[0]!.artifact.ref).toBe('docs/plan/report.md')
  expect(goal.acceptance).toMatchObject({ criteria: 1, confirmations: 1 })
})
