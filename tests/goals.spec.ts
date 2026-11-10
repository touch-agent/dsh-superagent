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
    state: { stage: 'ended', outcome: 'completed', endedAt: '2026-09-22T03:00:00Z' }, results: [] })
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
  const empty = serve(host([]).store)
  expect(await empty('goals')).toEqual({ status: 200, body: { generatedAt: expect.any(String), goals: [], totals: { goals: 0, open: 0, attention: 0 } } })
  const tickets = [ticket({ id: 't1', title: '修复登录' }), ticket({ id: 't2', title: '子任务', parentTicketId: 't1', rootTicketId: 't1' })]
  const call = serve(host(tickets).store)
  const list = await call('goals')
  expect(list.status).toBe(200)
  expect(list.body).toMatchObject({ totals: { goals: 1, open: 1, attention: 0 } })
  expect((list.body.goals as unknown[])[0]).toMatchObject({ id: 't1', statement: '修复登录' })
  expect((await call('goals/t2')).body).toMatchObject({ goal: { id: 't2', statement: '子任务' } })
  expect(await call('goals/missing')).toEqual({ status: 404, body: { error: 'Goal not found' } })
})

it('lists roots newest first and counts only their own decisions', () => {
  const older = ticket({ id: 'older', title: '旧任务', updatedAt: '2026-09-20T00:00:00Z', attention: { id: 'q', question: '保留吗？' } })
  const newer = ticket({ id: 'newer', title: '新任务', updatedAt: '2026-09-23T00:00:00Z', ended: { at: '2026-09-23T00:00:00Z', by: 'executor', outcome: 'completed' } })
  expect(goalBoard(host([older, newer]), new Date('2026-09-23T12:00:00Z'))).toMatchObject({
    goals: [{ id: 'newer' }, { id: 'older' }], totals: { goals: 2, open: 1, attention: 1 } })
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
    if (goal.decision) expect(typeof goal.decision.kind).toBe('string')
  }
})

it('projects a sparse runtime Ticket without assuming channels, a mandate scope or a goal', () => {
  const sparse = { id: 'sparse', title: '只有标题', decisionId: 'd1', assignments: [], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
    origin: { triggerId: 'tr', triggerIds: ['tr'] } } as unknown as Ticket
  expect(goalView(sparse)).toMatchObject({ id: 'sparse', statement: '只有标题', state: { stage: 'queued' }, results: [] })
  expect(goalView(sparse).source).toBeUndefined()
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

it('waits a child on its parent owner instead of claiming a person must decide', () => {
  const child = ticket({ id: 'child', title: '子任务标题', parentTicketId: 'root', rootTicketId: 'root', channels: [],
    delegation: { parentTicketId: 'root', rootTicketId: 'root', goal: '补齐迁移说明', attempt: 1, createdAt: AT,
      requestedBy: { ticketId: 'root', sessionId: 'worker-root' } },
    assignments: [assignment(true)] })
  expect(goalView(child)).toMatchObject({ state: { stage: 'waiting', action: 'review' }, results: [{ key: 'document:docs/plan/report.md:r7' }] })
  expect(goalView(child).decision).toBeUndefined()
  const blocked = ticket({ id: 'child-blocked', title: '子任务', parentTicketId: 'root', rootTicketId: 'root', channels: [],
    delegation: { parentTicketId: 'root', rootTicketId: 'root', goal: '补齐', attempt: 1, createdAt: AT,
      requestedBy: { ticketId: 'root', sessionId: 'worker-root' } },
    assignments: [{ id: 'a1', state: 'running', createdAt: AT, report: { state: 'blocked', summary: 'CI is red', at: AT } }] })
  expect(goalView(blocked).state).toEqual({ stage: 'waiting', action: 'blocked' })
  expect(goalView(blocked).decision).toBeUndefined()
})

it("ignores a returned child's earlier attempt when naming its result", () => {
  const returned = ticket({ id: 'child', title: '子任务', parentTicketId: 'root', rootTicketId: 'root', channels: [],
    delegation: { parentTicketId: 'root', rootTicketId: 'root', goal: '补齐', attempt: 2, createdAt: AT,
      requestedBy: { ticketId: 'root', sessionId: 'worker-root' } },
    assignments: [{ ...assignment(true), attempt: 1 },
      { id: 'assignment-2', state: 'pending', attempt: 2, createdAt: '2026-09-22T04:00:00Z' }] })
  expect(goalView(returned).state).toEqual({ stage: 'queued' })
  expect(goalView(returned).results).toEqual([])
  expect(goalView(returned).acceptance).toBeUndefined()
})

it('asks for a review but says when there is no reviewable delivery', () => {
  const ready = ticket({ id: 'no-deliverable', title: '交付报告', assignments: [{ id: 'a1', state: 'ended', createdAt: AT,
    report: { state: 'ready', summary: 'Says it is ready', at: '2026-09-22T02:00:00Z' } }] })
  expect(goalView(ready)).toMatchObject({ state: { stage: 'person', action: 'review' },
    decision: { kind: 'review', reviewable: false }, results: [] })
  expect(goalView(ready).acceptance).toBeUndefined()

  const reviewed = ticket({ id: 'reviewed', title: '交付报告', assignments: [assignment(true)] })
  expect(goalView(reviewed).decision).toEqual({ kind: 'review', reviewable: true })
})

it('asks nothing for an ended Ticket that still carries attention', () => {
  const ended = ticket({ id: 'ended', title: '旧工单', attention: { id: 'q', question: '还要吗？' },
    ended: { at: AT, by: 'human', outcome: 'stopped' } })
  expect(goalView(ended).state).toEqual({ stage: 'ended', outcome: 'stopped', endedAt: AT })
  expect(goalView(ended).decision).toBeUndefined()
})

it('ignores an older review after a newer non-review Assignment', () => {
  const item = ticket({ id: 'retried', title: '重试', assignments: [assignment(true),
    { id: 'assignment-2', state: 'running', createdAt: '2026-09-22T04:00:00Z',
      report: { state: 'progress', summary: 'Working again', at: '2026-09-22T04:05:00Z' } }] })
  expect(goalView(item).results).toEqual([])
  expect(goalView(item).acceptance).toBeUndefined()
})

it('exposes exactly the E0 Goal keys', () => {
  const item = ticket({ id: 'keys', title: '修复登录', attention: { id: 'q', question: '保留吗？' }, assignments: [assignment(true, true)] })
  expect(Object.keys(goalView(item)).sort()).toEqual(['acceptance', 'decision', 'id', 'results', 'source', 'state', 'statement'])
})
