import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Assignment, Thread, Ticket } from '@superagent/kernel'
import { Store } from '@superagent/dsh/app/store.ts'
import { ownershipIndex, planOf, reviewedPr } from '@superagent/dsh/app/ownership.ts'
import { graphOf, rollupStatus, taskBoard, type TaskNode } from '@superagent/dsh/app/tasks.ts'
import type { ViewHost } from '@superagent/dsh/app/views/records.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-tasks-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const assignment = (summary: string): Assignment => ({ id: 'a1', state: 'ended', createdAt: '2026-09-22T01:00:00Z',
  report: { state: 'ready', summary, at: '2026-09-22T02:00:00Z' } })

const ticket = (fields: Partial<Ticket> & { id: string; title: string }): Ticket => ({
  decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' },
    actor: { source: 'conversation', id: 'local-user' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-09-22T00:00:00Z',
  updatedAt: '2026-09-22T00:00:00Z', origin: { triggerId: 'x', triggerIds: ['x'] }, ...fields })

const host = (store: Store): ViewHost => ({ store, sources: { kind: () => undefined } as never, links: () => ({}) as never })

const seed = (store: Store, tickets: Ticket[]): void => { for (const item of tickets) store.tickets.save(item) }

it('reads a plan id from the title before the Mandate scope, and strips it from the task name', () => {
  expect(planOf(ticket({ id: 't1', title: '修复登录（T2-03）' }))).toEqual({ milestone: 'M2', task: 'T2-03', title: '修复登录' })
  expect(planOf(ticket({ id: 't2', title: '审查 PR #8：登录', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '对 PR #8（T2-03：登录）做独立 review' } })))
    .toEqual({ milestone: 'M2', task: 'T2-03', title: '审查 PR #8：登录' })
  expect(planOf(ticket({ id: 't3', title: '没有编号' }))).toBeUndefined()
})

it('reads a review pull request from the title and attaches it to the Ticket that published it', () => {
  const impl = ticket({ id: 'impl', title: '修复登录（T2-03）',
    assignments: [assignment('Opened https://github.com/touch-agent/dsh-superagent/pull/8 for review')] })
  const review = ticket({ id: 'review', title: 'review PR #8：修复登录', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '对 PR #8（T2-03）做 review' },
  assignments: [assignment('Posted https://github.com/touch-agent/dsh-superagent/pull/8#pullrequestreview-1')] })
  expect(reviewedPr(review)).toEqual({ number: 8 })
  const index = ownershipIndex([impl, review])
  expect(index.of('review')).toMatchObject({ parent: 'impl', plan: { task: 'T2-03' }, reviews: { number: 8 } })
  expect(index.reviewsOf('impl')).toEqual([review])
  expect(index.of('impl')).not.toMatchObject({ parent: expect.anything() })
})

it('finds a pull request published by any assignment, not only the latest one', () => {
  const impl = ticket({ id: 'impl', title: '修复登录（T2-03）', assignments: [
    { id: 'a1', state: 'ended', createdAt: '2026-09-22T01:00:00Z',
      report: { state: 'ready', summary: 'https://github.com/acme/widgets/pull/7', at: '2026-09-22T02:00:00Z' } },
    { id: 'a2', state: 'ended', createdAt: '2026-09-22T03:00:00Z',
      report: { state: 'ready', summary: 'https://github.com/acme/widgets/pull/9', at: '2026-09-22T04:00:00Z' } }] })
  const review = ticket({ id: 'review', title: 'review PR #7：修复登录', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '对 PR #7（T2-03）做 review' } })
  expect(ownershipIndex([impl, review]).of('review')).toMatchObject({ parent: 'impl', reviews: { number: 7 } })
})

it('attaches a review to the only Ticket of its own task when no report published the pull request', () => {
  const impl = ticket({ id: 'impl', title: '修复登录（T2-03）' })
  const review = ticket({ id: 'review', title: '复核 PR #8：修复登录', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '对 PR #8（T2-03）做复核' } })
  expect(ownershipIndex([impl, review]).of('review')).toMatchObject({ parent: 'impl' })
})

it('refuses to guess when two Tickets published the same pull request number', () => {
  const one = ticket({ id: 'one', title: '修复登录（T2-03）', assignments: [assignment('https://github.com/acme/widgets/pull/8')] })
  const two = ticket({ id: 'two', title: '修复登录（T2-03）', assignments: [assignment('https://github.com/acme/widgets/pull/8')] })
  const review = ticket({ id: 'review', title: 'review PR #8：修复登录', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '对 PR #8（T2-03）做 review' } })
  expect(ownershipIndex([one, two, review]).of('review').parent).toBeUndefined()
})

it('rolls one failure up to its container and keeps a live review above working work', () => {
  expect(rollupStatus(['done', 'done'])).toBe('done')
  expect(rollupStatus(['done', 'blocked', 'failed'])).toBe('failed')
  expect(rollupStatus(['done', 'review', 'working'])).toBe('review')
})

const thread = (subscriptions: string[]): Thread => ({ key: 'github:8', ref: { source: 'github', id: '8' },
  createdAt: '2026-09-22T00:00:00Z', subscriptions, correlated: [], pending: [],
  meta: { label: '#8 修复登录', url: 'https://github.com/touch-agent/dsh-superagent/pull/8',
    facts: { number: { value: '#8' }, ci: { label: { zh: 'CI', en: 'CI' }, value: { zh: '通过', en: 'passed' } } } } })

it('builds milestones, tasks, Tickets, reviews and pull requests from the facts the Store holds', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const impl = ticket({ id: 'impl', title: '修复登录（T2-03）', assignments: [assignment('https://github.com/acme/widgets/pull/8')] })
  const review = ticket({ id: 'review', title: 'review PR #8：修复登录', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '对 PR #8（T2-03）做 review' } })
  const loose = ticket({ id: 'loose', title: '整理迁移说明', ended: { at: '2026-09-22T03:00:00Z', by: 'executor', outcome: 'completed' } })
  seed(store, [impl, review, loose])
  store.threads.save(thread(['impl']))
  const board = taskBoard(host(store), new Date('2026-09-22T12:00:00Z'))
  expect(board.totals).toEqual({ milestones: 2, tasks: 2, tickets: 3, open: 2 })
  const [milestone, unplanned] = board.milestones
  expect(milestone).toMatchObject({ id: 'M2', status: 'review', progress: { done: 0, total: 2 } })
  const task = milestone!.children[0]!
  expect(task).toMatchObject({ id: 'T2-03', title: '修复登录', subtitle: 'T2-03', progress: { done: 0, total: 2 } })
  const implNode = task.children[0]!
  expect(implNode.kind).toBe('ticket')
  expect(implNode.children.map(child => child.kind).sort()).toEqual(['pull', 'review'])
  expect(implNode.children.find(child => child.kind === 'pull')).toMatchObject({ id: 'github:8', title: '#8 修复登录',
    href: { url: 'https://github.com/touch-agent/dsh-superagent/pull/8' } })
  expect(implNode.children.find(child => child.kind === 'review')).toMatchObject({ id: 'review', status: 'queued' })
  expect(unplanned).toMatchObject({ id: 'unplanned', status: 'done' })
  expect((unplanned!.children[0] as TaskNode).title).toBe('整理迁移说明')
})

it('keeps a review without a known owner labelled as a review', () => {
  const review = ticket({ id: 'review', title: '复核 PR #8：修复登录（T2-03）', mandate: { strength: 'explicit', policyVersion: 'v',
    basis: { via: 'listed' }, actor: { source: 'conversation', id: 'local-user' }, scope: '对 PR #8（T2-03）做复核' } })
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  seed(store, [review])
  const board = taskBoard(host(store), new Date('2026-09-22T12:00:00Z'))
  expect(board.milestones[0]!.children[0]!.children[0]!.kind).toBe('review')
})

it('assigns parallel Tickets separate lanes and reuses a lane once a branch ended', () => {
  const branch = (id: string, start: string, end?: string): TaskNode => ({ kind: 'ticket', id, title: id, status: 'done',
    startedAt: start, ...end ? { endedAt: end } : {}, children: [] })
  const task = (id: string, branches: TaskNode[]): TaskNode => ({ kind: 'task', id, title: id, status: 'done', children: branches })
  const now = Date.parse('2026-09-23T00:00:00Z')
  const parallel = graphOf([task('T2-01', [branch('a', '2026-09-22T00:00:00Z'), branch('b', '2026-09-22T01:00:00Z')])], now)
  expect(parallel.branches.map(item => item.lane)).toEqual([0, 1])
  expect(parallel.lanes).toBe(2)
  const sequential = graphOf([task('T2-01', [branch('a', '2026-09-22T00:00:00Z', '2026-09-22T01:00:00Z'),
    branch('b', '2026-09-22T02:00:00Z', '2026-09-22T03:00:00Z')])], now)
  expect(sequential.branches.map(item => item.lane)).toEqual([0, 0])
  expect(sequential.lanes).toBe(1)
})