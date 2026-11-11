// @vitest-environment jsdom
// Task view Phase 1: the compact list, tracked/lightweight forms, empty and error states, and the selection Events shares.
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import type { ActivityFeed } from '@superagent/dsh/app/activity.ts'
import type { TaskBoardView, TaskView } from '@superagent/dsh/app/tasks.ts'
import type { Call } from '@superagent/dsh/client/api.ts'
import { en, zh } from '@superagent/dsh/client/locales.ts'
import { TasksTab } from '@superagent/dsh/client/tasks.tsx'
import { TasksViewClient } from '@superagent/dsh/client/tasks-view.ts'
import { EventsTab } from '@superagent/dsh/client/system.tsx'
import { ActivityFeedClient } from '@superagent/dsh/client/activity-feed.ts'
import { MasterStore } from '@superagent/dsh/client/master.ts'
import { usePanel, mount, click, all, text, at, translator } from './fixtures/panel.tsx'
import { goalFixture, server, taskBoardView } from './fixtures/panel-server.ts'

usePanel()

const openTasks = async () => { at({ page: 'tasks' }); await mount() }
const row = (titlePart: string) => all('.dt-tasks-item').find(item => item.textContent?.includes(titlePart))

const light = (): TaskView => ({ id: 'light', kind: 'ticket', title: '改一句文案', form: 'lightweight', status: 'working',
  attention: false, origin: { source: 'conversation', triggerId: 'tr-light', preview: '改一下文案', at: '2026-09-22T00:00:00Z' },
  sources: [{ source: 'conversation', label: '主会话' }], startedAt: '2026-09-22T00:00:00Z', execution: { assignments: 0 },
  goal: goalFixture('light', { statement: '改一句文案' }), deliverables: [], inline: { steps: 2, traceId: 'trace-light' } })

async function render(element: ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(element) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, root }
}

it('shows the compact task list with a parent worker for tracked Tickets and a separate reviewer row', async () => {
  await openTasks()
  expect(all('.dt-tasks-item')).toHaveLength(3)
  const parent = row('修复回归（T2-03）')!
  expect(parent.textContent).toContain(zh['tasksRole.parentWorker'])
  const review = row('review PR #42')!
  expect(review.getAttribute('data-review')).toBe('true')
  expect(review.textContent).toContain(zh['tasksRole.reviewer'])
  expect(parent.nextElementSibling).toBe(review)
  // The fixture's rows have no previewed delivery, so no delivery tag or empty review card is rendered.
  expect(all('.dt-tasks-row-meta').some(item => item.textContent?.includes(zh.tasksDeliverables.split(' ')[0]!))).toBe(false)
})

it('renders a lightweight Ticket as lightweight without inventing a worker, Session or delivery', async () => {
  const board = taskBoardView()
  server.tasks = { ...board, tasks: [...board.tasks, light()], totals: { ...board.totals, tickets: board.totals.tickets + 1, open: board.totals.open + 1 } }
  await openTasks()
  const item = row('改一句文案')!
  expect(item.getAttribute('data-form')).toBe('lightweight')
  expect(item.textContent).toContain(zh['tasksForm.lightweight'])
  expect(item.textContent).not.toContain(zh['tasksRole.parentWorker'])
  expect(item.textContent).not.toContain(zh['tasksRole.reviewer'])
  await click(item.querySelector('button')!)
  expect(item.textContent).toContain(zh.tasksLightweightNote)
  expect(item.textContent).not.toContain(zh.tasksOpenInStatus)
})

it('shows an explicit empty state when there are no Tickets', async () => {
  server.tasks = { generatedAt: '2026-09-23T12:00:00Z', milestones: [], tasks: [],
    totals: { milestones: 0, tasks: 0, tickets: 0, open: 0, attention: 0 } }
  await openTasks()
  expect(text()).toContain(zh.tasksEmpty)
  expect(all('.dt-tasks-item')).toHaveLength(0)
})

it('shows a retryable error instead of a stale empty list when the task poll fails', async () => {
  server.down = true
  await openTasks()
  expect(document.querySelector('[role=alert]')).not.toBeNull()
  expect(text()).toContain(zh.hostNotRunning)
})

it('shows a retryable error in the right Task tab when the shared poll fails', async () => {
  const failing = new TasksViewClient((async () => { throw new Error('task poll offline') }) as unknown as Call)
  const view = await render(<TasksTab t={translator(zh)} tasks={failing} onOpenStatus={() => {}}
    onOpenTask={() => {}} onOpenEvents={() => {}} />)
  expect(view.container.querySelector('.dt-tasks-error')?.textContent).toContain('task poll offline')
  expect(view.container.querySelector('.dt-tasks-error button')?.textContent).toBe(zh.retry)
  await act(async () => { failing.dispose(); view.root.unmount() })
})

it('shares one selected task with Events, narrows to the reviewed Ticket, and clears it', async () => {
  const board = taskBoardView()
  const feed: ActivityFeed = { latest: 1, next: 1, items: [{ seq: 1, at: '2026-09-23T10:00:00Z', event: 'assignment.started',
    level: 'feed', summary: 'started', ticket: 't1', task: { id: 't1', title: '修复回归（T2-03）', status: 'working' } }] }
  const call = (async (name: string) => {
    if (name === 'GET tasks') return board
    if (name === 'GET activity') return feed
    if (name === 'GET state') return { masterId: 'master', paused: false }
    throw new Error(`unexpected ${name}`)
  }) as unknown as Call
  const tasks = new TasksViewClient(call)
  const activity = new ActivityFeedClient(call)
  const master = new MasterStore(call)
  // The Events tab does not poll tasks itself; a selected task arrives with data another task surface already loaded.
  const release = tasks.retain()
  tasks.select({ kind: 'ticket', id: 'r1' })
  const view = await render(<EventsTab t={translator(zh)} activity={activity} master={master} tasks={tasks} onOpen={() => {}} />)
  const chip = view.container.querySelector('.dt-events-selection-title')
  expect(chip?.textContent).toContain('修复回归（T2-03）')
  // A review's events live under the Ticket it reviews (`t1`), so the group stays visible instead of filtering to nothing.
  expect(view.container.querySelectorAll('.dt-events-group')).toHaveLength(1)
  expect(view.container.querySelector('.dt-events-group-title')?.textContent).toContain('修复回归')
  await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-events-selection button')!.click() })
  expect(tasks.getSnapshot().selection).toBeUndefined()
  expect(tasks.eventTaskId('r1')).toBe('t1')
  expect(tasks.titleOf('r1')).toBe('review PR #42：修复回归')
  await act(async () => { release(); tasks.dispose(); activity.dispose(); master.dispose(); view.root.unmount() })
})


it('shows the E1 selected detail with the E0 goal, decision and result, and no worker or Session id', async () => {
  const board = taskBoardView()
  const root = board.tasks.find(task => task.id === 't1')!
  root.goal = goalFixture('t1', { statement: '修复登录回归', decision: { kind: 'review', reviewable: true },
    results: [{ key: 'file:docs/report.md:r7', at: '2026-09-23T00:00:00Z', artifact: { kind: 'file', ref: 'docs/report.md', revision: 'r7' },
      previewRef: { kind: 'text/diff', ref: 'fixture://r7', revision: 'r7' } }], acceptance: { criteria: 1, confirmations: 1 } })
  server.tasks = board
  await openTasks()
  const item = row('修复回归（T2-03）')!
  await click(item.querySelector('.dt-tasks-row')!)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(item.textContent).toContain(zh.tasksGoal)
  expect(item.textContent).toContain('修复登录回归')
  expect(item.textContent).toContain(zh['activityStatus.working'])
  expect(item.textContent).toContain(zh.tasksDecision)
  expect(item.textContent).toContain(zh['stage.review'])
  expect(item.textContent).toContain(zh.tasksResult)
  expect(item.textContent).toContain(`${zh['artifact.file']} · docs/report.md · r7`)
  expect(item.textContent).toContain(zh['tasksRole.parentWorker'])
  expect(item.textContent).not.toMatch(/worker-|Assignment|sessionId|assignmentId|workerId/)
  const blocked = row('整理迁移说明')!
  expect(blocked.textContent).toContain(zh['stage.blocked'])
})

it('rolls back to the plan tree with taskView.v1=off and offers no list view', async () => {
  localStorage.setItem('taskView.v1', 'off')
  await openTasks()
  const tabs = all('[role=tab]').map(item => item.textContent)
  expect(tabs).toContain(zh['tasksView.tree'])
  expect(tabs).not.toContain(zh['tasksView.list'])
  expect(document.querySelector('.dt-tasks-list')).toBeNull()
  expect(document.querySelector('.dt-task-root')).not.toBeNull()
  localStorage.removeItem('taskView.v1')
})

it('uses the same task filter vocabulary in both languages', () => {
  expect(zh.tasksFilterLabel).toBe('任务状态筛选')
  expect(en.tasksFilterLabel).toBe('Task status filter')
})
it('shows one child Ticket layer with its parent decision and the pending end of its root', async () => {
  const board = taskBoardView()
  const root = board.tasks.find(task => task.id === 't1')!
  root.childSummary = { total: 2, live: 2, queued: 0, working: 0, waiting: 1, review: 1, blocked: 0, failed: 0, orphaned: 0,
    accepted: 0, cancelled: 0, unresolved: 2 }
  root.status = 'working'
  root.pendingEnd = { by: 'follows', outcome: 'merged', at: '2026-09-23T12:00:00Z', reason: 'waiting for the child' }
  const child: TaskView = { id: 'c1', kind: 'ticket', title: '子任务：补齐迁移说明', form: 'tracked', status: 'review',
    parentTicketId: 't1', rootTicketId: 't1', depth: 1, parentOwner: { role: 'owner' }, delegation: { parentTicketId: 't1', rootTicketId: 't1',
      goal: '补齐迁移说明', attempt: 1, dispositions: [] }, origin: { source: 'conversation', triggerId: 'tr-child', preview: '', at: '2026-09-23T00:00:00Z' },
    sources: [], execution: { assignments: 1 }, goal: goalFixture('c1', { statement: '补齐迁移说明' }), deliverables: [] }
  const waiting: TaskView = { ...child, id: 'c2', title: '核对审计日志格式', status: 'idle',
    delegation: { ...child.delegation!, goal: '核对审计日志格式' } }
  root.children = [child, waiting]
  server.tasks = board
  await openTasks()
  const item = row('修复回归（T2-03）')!
  expect(item.textContent).toContain(zh.tasksPendingEnd)
  expect(item.textContent).toContain(zh.tasksChildCount.replace('{count}', '2'))
  await click(item.querySelector('.dt-tasks-row')!)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const nested = all('.dt-tasks-child')
  expect(nested).toHaveLength(2)
  expect(nested[0]!.textContent).toContain('子任务：补齐迁移说明')
  expect(nested[0]!.textContent).toContain(zh['tasksRole.child'])
  expect(nested[0]!.textContent).toContain(zh.tasksParentReview)
  await click(nested[0]!.querySelector('.dt-tasks-row')!)
  expect(nested[0]!.textContent).toContain(zh.tasksChildSelectedHint)
  await click(all('button').find(button => button.textContent?.trim() === zh['activityFilter.running'])!)
  const running = all('.dt-tasks-child')
  expect(running).toHaveLength(1)
  expect(running[0]!.textContent).toContain('核对审计日志格式')
  expect(running[0]!.textContent).not.toContain('补齐迁移说明')
})
