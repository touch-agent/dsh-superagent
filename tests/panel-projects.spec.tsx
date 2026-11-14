// @vitest-environment jsdom
// The project layer: cards and order, archive filter, drill-down and breadcrumbs, owners, missing fields and fallback.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import type { TaskView } from '@superagent/dsh/app/tasks.ts'
import type { ApiResponse } from '@superagent/dsh/app/api.ts'
import { zh } from '@superagent/dsh/client/locales.ts'
import { ancestorsOf, attentionItems, projectTitle, sortedProjects, totalsOf, type ProjectBoardView, type ProjectView } from '@superagent/dsh/client/projects.ts'
import { ProjectsBoard } from '@superagent/dsh/client/projects.tsx'
import { TasksViewClient } from '@superagent/dsh/client/tasks-view.ts'
import { usePanel, mount, remount, all, click, text, at, translator } from './fixtures/panel.tsx'
import { goalFixture, server, taskBoardView } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => localStorage.clear())

const zero = (overrides: Partial<TaskView['childSummary']> = {}) => ({ total: 0, live: 0, queued: 0, working: 0, waiting: 0,
  review: 0, blocked: 0, failed: 0, orphaned: 0, accepted: 0, cancelled: 0, unresolved: 0, ...overrides })
const actor = (id: string, name: string) => ({ source: 'dsh', id, name: { zh: name, en: name } })

const profile = (id: string, title: string, activeRevision = 2): ApiResponse<'GET profiles'>['profiles'][number] => ({
  id, title, description: `${title} description`, role: 'worker', activeRevision, previousActiveRevision: undefined,
  disabled: false, retiredRevisions: [], lastBoundAt: undefined, updatedBy: 'test', contentHash: `hash-${id}`, moving: false })

function fixtures(): { board: ProjectBoardView; child: TaskView; unowned: TaskView } {
  const base = taskBoardView().tasks[0]!
  const child: TaskView = { ...base, id: 'pay-child', title: '补齐回调签名', form: 'tracked', status: 'blocked', attention: false,
    parentTicketId: 'pay-1', rootTicketId: 'pay-1', depth: 1, lastEventAt: '2026-09-24T08:00:00Z',
    owner: { role: 'owner', profile: { id: 'worker-pay', revision: 2 } }, parentOwner: { role: 'owner', profile: { id: 'worker-pay', revision: 2 } },
    delegation: { parentTicketId: 'pay-1', rootTicketId: 'pay-1', goal: '补齐回调签名', attempt: 1,
      dispositions: [{ decision: 'reopen', by: actor('worker-pay', '支付 worker'), at: '2026-09-23T10:00:00Z', reason: '签名校验不通过' }],
      resolution: { kind: 'failed', by: actor('worker-pay', '支付 worker'), at: '2026-09-24T08:00:00Z', reason: '缺少回调签名' } },
    blocker: { kind: 'blocked', detail: '缺少回调签名', at: '2026-09-24T08:00:00Z' }, childSummary: zero(), children: [],
    goal: goalFixture('pay-child', { statement: '补齐回调签名' }),
    deliverables: [{ key: 'file:docs/pay.md:r2', sources: [], at: '2026-09-24T07:00:00Z',
      artifact: { kind: 'file', ref: 'docs/pay.md', revision: 'r2' }, previewRef: { kind: 'text/diff', ref: 'diff-pay', revision: 'r2' },
      criteria: [], confirmations: [], summary: '回调签名已补' }] }
  const pay1: TaskView = { ...base, id: 'pay-1', title: '接入网关', status: 'review', attention: true, lastEventAt: '2026-09-24T09:00:00Z',
    owner: { role: 'owner', profile: { id: 'worker-pay', revision: 2 } }, childSummary: zero({ total: 1, live: 1, blocked: 1, unresolved: 1 }),
    children: [child], blocker: { kind: 'child', count: 1, detail: '1 blocked · 0 failed · 0 orphaned' },
    goal: goalFixture('pay-1', { statement: '让支付回调稳定' }) }
  const pay2: TaskView = { ...base, id: 'pay-2', title: '退款对账', form: 'tracked', status: 'blocked', attention: false,
    lastEventAt: '2026-09-23T09:00:00Z', owner: { role: 'owner', profile: { id: 'worker-pay', revision: 2 } },
    blocker: { kind: 'blocked', detail: '等待财务口径', at: '2026-09-23T09:00:00Z' }, childSummary: zero(),
    goal: goalFixture('pay-2', { statement: '核对退款流水' }) }
  const old1: TaskView = { ...base, id: 'old-1', title: '旧站迁移清单', form: 'tracked', status: 'answer', attention: true,
    lastEventAt: '2026-09-20T09:00:00Z', owner: { role: 'owner', profile: { id: 'worker-old', revision: 1 } },
    childSummary: zero(), goal: goalFixture('old-1', { statement: '确认旧站下线范围' }) }
  const unowned: TaskView = { ...base, id: 'free-1', title: '没人认领的清理', form: 'tracked', status: 'working', attention: false,
    lastEventAt: '2026-09-25T09:00:00Z', childSummary: zero(), goal: goalFixture('free-1', { statement: '清理临时文件' }) }
  const unassigned: TaskView = { ...base, id: 'free-2', title: '整理临时目录', form: 'tracked', status: 'working', attention: false,
    lastEventAt: '2026-09-25T10:00:00Z', childSummary: zero(), goal: goalFixture('free-2', { statement: '整理临时目录' }) }
  const pay: ProjectView = { id: 'p-pay', name: '支付接入', goal: '先让支付回调稳定', owner: { profile: { id: 'worker-pay', revision: 2 } },
    lastActivityAt: '2026-09-24T09:00:00Z', tasks: [pay1, pay2] }
  const old: ProjectView = { id: 'p-old', name: '旧站下线', goal: '把旧站流量切走', owner: { profile: { id: 'worker-old', revision: 1 } },
    archivedAt: '2026-09-21T00:00:00Z', lastActivityAt: '2026-09-20T09:00:00Z', tasks: [old1] }
  const unknown: ProjectView = { id: 'p-free', name: '杂项', tasks: [unowned] }
  const board: ProjectBoardView = { ...taskBoardView(), projects: [pay, old, unknown], unassigned: [unassigned],
    tasks: [pay1, pay2, old1, unowned, unassigned] }
  return { board, child, unowned }
}

const openTasks = async () => { at({ page: 'tasks' }); await mount() }
const initialise = () => {
  const built = fixtures()
  server.profiles = [profile('worker-pay', '支付 worker', 2), profile('worker-old', '旧站 worker', 1)]
  server.tasks = built.board
  return built
}
const cards = () => all('.dt-project-card')
const cardNamed = (name: string) => cards().find(card => card.textContent?.includes(name))

it('renders project cards with the contract fields and orders attention first', async () => {
  initialise()
  await openTasks()
  expect(cards()).toHaveLength(2)
  expect(cards()[0]!.textContent).toContain('支付接入')
  expect(cards()[0]!.textContent).toContain('先让支付回调稳定')
  expect(cards()[0]!.textContent).toContain(zh['projectsOwner'])
  expect(cards()[0]!.textContent).toContain('支付 worker · 第 2 版')
  expect(cards()[0]!.textContent).toContain('0/2 顶层任务完成')
  expect(cards()[0]!.textContent).toContain('待你处理 1')
  expect(cards()[0]!.textContent).toContain('有阻塞 2')
  expect(cards()[0]!.textContent).toContain('接入网关')
  expect(cards()[1]!.textContent).toContain('杂项')
  expect(all('.dt-project-pending-list > li')).toHaveLength(3)
  expect(document.querySelector('.dt-project-pending')!.textContent).toContain('去验收')
  expect(document.querySelector('.dt-project-pending')!.textContent).toContain(zh['projectsIssue.worker'])
})

it('defaults to active projects, exposes the archived count and keeps archived pending work visible', async () => {
  initialise()
  await openTasks()
  expect(cardNamed('旧站下线')).toBeUndefined()
  expect(text()).toContain('查看已归档（1）')
  const pending = document.querySelector('.dt-project-pending')!
  expect(pending.textContent).toContain('旧站下线')
  expect(pending.textContent).toContain('已归档')
  expect(pending.textContent).toContain('回答')
  await click(all('button').find(button => button.textContent?.includes('查看已归档'))!)
  expect(cardNamed('旧站下线')?.textContent).toContain('已归档')
  expect(text()).toContain('查看未归档')
  await click(all('button').find(button => button.textContent?.includes('查看未归档'))!)
  expect(cardNamed('旧站下线')).toBeUndefined()
  await click(all('button').find(button => button.textContent?.includes(zh['projectsAllTasks']))!)
  expect(text()).toContain('旧站迁移清单')
})

it('drills from project to task to child with owners, statuses, expansion and breadcrumbs', async () => {
  initialise()
  await openTasks()
  await click(cardNamed('支付接入')!.querySelector('.dt-project-name')!)
  const detail = document.querySelector('.dt-project-detail')!
  expect(detail.textContent).toContain('先让支付回调稳定')
  const roots = all('.dt-project-tree-node')
  expect(roots[0]!.textContent).toContain('接入网关')
  expect(roots[0]!.textContent).toContain(zh['projectsTaskOwner'])
  await click(roots[0]!.querySelector('.dt-task-toggle')!)
  const withChild = all('.dt-project-tree-node')
  expect(withChild).toHaveLength(3)
  const childNode = withChild.find(node => node.getAttribute('data-task-id') === 'pay-child')!
  expect(childNode.textContent).toContain(zh['projectsChildWaitingOwner'])
  expect(childNode.textContent).toContain('支付 worker · 第 2 版')
  await click(document.querySelector('[data-task-id="pay-1"] .dt-task-toggle')!)
  expect(all('.dt-project-tree-node')).toHaveLength(2)
  await click(document.querySelector('[data-task-id="pay-1"] .dt-task-toggle')!)
  const childAgain = all('.dt-project-tree-node').find(node => node.getAttribute('data-task-id') === 'pay-child')!
  await click(childAgain.querySelector('.dt-project-task-title')!)
  const task = document.querySelector('.dt-task-detail')!
  expect(task.textContent).toContain('补齐回调签名')
  expect(task.textContent).toContain(zh['projectsBackToProject'])
  const crumbs = document.querySelector('.dt-task-crumbs')!
  expect(crumbs.textContent).toContain('项目')
  expect(crumbs.textContent).toContain('接入网关')
  expect(crumbs.textContent).toContain('补齐回调签名')
  expect(task.textContent).toContain(zh['projectsProjectOwner'])
  expect(task.textContent).toContain('支付 worker · 第 2 版')
  expect(task.textContent).toContain(zh['taskHierarchyReportHistory'])
  expect(task.textContent).toContain('docs/pay.md')
  expect(task.textContent).toContain('缺少回调签名')
  await click(all('button').find(button => button.textContent?.trim() === zh['projectsBackToProject'])!)
  expect(document.querySelector('.dt-project-detail')).not.toBeNull()
})

it('shows unknown goal, unknown owner and a project-level owner issue without inventing a worker', async () => {
  initialise()
  await openTasks()
  const unknown = cardNamed('杂项')!
  expect(unknown.textContent).toContain(zh['projectsUnknownGoal'])
  expect(unknown.textContent).toContain(zh['projectsOwnerUnavailable'])
  expect(unknown.textContent).toContain(zh['projectsOwnerUnknown'])
  await click(unknown.querySelector('.dt-project-name')!)
  const detail = document.querySelector('.dt-project-detail')!
  expect(detail.textContent).toContain(zh['projectsOwnerUnavailableHint'])
  const task = all('.dt-project-tree-node')[0]!
  expect(task.getAttribute('data-owner-known')).toBeNull()
  expect(task.textContent).toContain(zh['projectsOwnerUnknown'])
})

it('shows the empty project guidance and the flat all-tasks fallback', async () => {
  server.tasks = { ...taskBoardView(), projects: [], unassigned: [], tasks: [] } as ProjectBoardView
  await openTasks()
  expect(text()).toContain(zh['projectsEmptyTitle'])
  await click(all('button').find(button => button.textContent?.trim() === zh['projectsEmptyAllTasks'])!)
  expect(document.querySelector('.dt-project-flat')).not.toBeNull()
})

it('falls back to the existing flat list when the flag is off or the host sends no project projection', async () => {
  initialise()
  localStorage.setItem('ux.projects.v1', 'off')
  await openTasks()
  expect(all('.dt-project-card')).toHaveLength(0)
  expect(all('.dt-tasks-item')).toHaveLength(5)
  localStorage.removeItem('ux.projects.v1')
  server.tasks = taskBoardView()
  await remount()
  expect(all('.dt-project-card')).toHaveLength(0)
  expect(all('.dt-tasks-item')).toHaveLength(3)
})

it('asks the same board for archived projects when the default board only carries the count', async () => {
  const built = fixtures()
  const old = built.board.projects!.find(project => project.id === 'p-old')!
  const active = built.board.projects!.filter(project => project.id !== 'p-old')
  const board: ProjectBoardView = { ...built.board, projects: active, totals: { ...built.board.totals, archivedProjects: 1 } }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const store = new TasksViewClient((async () => { throw new Error('no call expected') }) as never)
  const t = translator(zh)
  let asked = 0
  await act(async () => {
    root.render(<ProjectsBoard board={board} store={store} profiles={[]} t={t} onOpenTicket={() => {}}
      loadArchived={async () => { asked += 1; return [old] }} renderFlat={() => null} />)
  })
  expect(container.textContent).toContain('查看已归档（1）')
  expect(container.textContent).toContain('旧站迁移清单')
  expect(asked).toBe(1)
  await act(async () => {
    all('button').find(button => button.textContent?.includes('查看已归档'))!.click()
    await Promise.resolve()
  })
  expect(asked).toBe(1)
  expect(container.textContent).toContain('旧站下线')
  expect(container.textContent).toContain('已归档')
  act(() => root.unmount())
  container.remove()
})

it('guides back to the project list when a selected project disappears', async () => {
  const built = fixtures()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const store = new TasksViewClient((async () => { throw new Error('no call expected') }) as never)
  const t = translator(zh)
  const render = async (board: ProjectBoardView) => act(async () => {
    root.render(<ProjectsBoard board={board} store={store} profiles={[]} t={t} onOpenTicket={() => {}} renderFlat={() => null} />)
  })
  await render(built.board)
  await act(async () => { all('.dt-project-name').find(button => button.textContent === '支付接入')!.click() })
  expect(container.textContent).toContain(zh['projectsTaskTree'])
  await render({ ...built.board, projects: [] })
  expect(container.textContent).toContain(zh['projectsMissingTitle'])
  expect(container.textContent).toContain(zh['projectsMissingBack'])
  act(() => root.unmount())
  container.remove()
})

it('keeps the project helpers honest for missing parents and unassigned work', () => {
  const built = fixtures()
  const child = built.child
  const ancestors = ancestorsOf(built.board.projects![0]!, built.board, child, () => undefined)
  expect(ancestors.ancestors.map(task => task.id)).toEqual(['pay-1'])
  const missing = ancestorsOf(built.board.projects![0]!, built.board, { ...child, parentTicketId: 'gone' }, () => undefined)
  expect(missing.missingParent).toBe('gone')
  expect(projectTitle(sortedProjects(built.board.projects!, built.board)[0]!)).toBe('支付接入')
  expect(attentionItems(built.board.projects!, built.board)).toHaveLength(2)
  expect(totalsOf(built.board.projects![0]!, built.board.projects![0]!.tasks!).progress).toBe(0)
})
