// @vitest-environment jsdom
// UX batch 1's task hierarchy: one level at a time, human words first, internal ids only in the E2 disclosure.
import { afterEach, expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import type { TaskBoardView, TaskView } from '@superagent/dsh/app/tasks.ts'
import { usePanel, mount, all, click, text } from './fixtures/panel.tsx'
import { server, taskBoardView } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => localStorage.clear())

function hierarchy(): TaskBoardView {
  const board = taskBoardView()
  const child: TaskView = { id: 't1-child', kind: 'ticket', title: '补迁移说明', form: 'tracked', status: 'blocked', attention: true,
    parentTicketId: 't1', rootTicketId: 't1', depth: 1,
    origin: { source: 'conversation', triggerId: 'tr9', preview: '补迁移说明', at: '2026-09-23T00:00:00Z' },
    sources: [{ source: 'conversation', label: '主会话' }], execution: { assignments: 1 },
    owner: { role: 'owner', profile: { id: 'worker-plan', revision: 3 } },
    parentOwner: { role: 'owner', profile: { id: 'worker-plan', revision: 2 } },
    delegation: { parentTicketId: 't1', rootTicketId: 't1', goal: '写迁移说明', attempt: 1, dispositions: [],
      resolution: { kind: 'failed', by: { source: 'dsh', id: 'worker-plan' }, at: '2026-09-23T01:00:00Z', reason: '缺少迁移目标' } },
    goal: { id: 't1-child', statement: '写迁移说明', state: { stage: 'waiting', action: 'blocked' }, results: [] },
    deliverables: [], blocker: { kind: 'blocked', detail: '缺少迁移目标' },
    childSummary: { total: 0, live: 0, queued: 0, working: 0, waiting: 1, review: 0, blocked: 1, failed: 0, orphaned: 0,
      accepted: 0, cancelled: 0, unresolved: 0 } }
  const root: TaskView = { ...board.tasks[0]!, owner: { role: 'owner', profile: { id: 'worker-plan', revision: 2 } },
    worker: { role: 'worker', sessionId: 'worker-t1' },
    deliverables: [{ key: 'file:docs/migration.md:r1', sources: [], at: '2026-09-23T02:00:00Z',
      artifact: { kind: 'file', ref: 'docs/migration.md', revision: 'r1' },
      previewRef: { kind: 'text/diff', ref: 'diff-1', revision: 'r1' }, criteria: [], confirmations: [] }],
    blocker: { kind: 'child', count: 1, detail: '1 blocked · 0 failed · 0 orphaned' },
    childSummary: { total: 1, live: 1, queued: 0, working: 0, waiting: 1, review: 0, blocked: 1, failed: 0, orphaned: 0,
      accepted: 0, cancelled: 0, unresolved: 0 }, children: [child] }
  return { ...board, totals: { ...board.totals, tickets: 1 }, tasks: [root] }
}

it('opens one task level from the list and shows goal, owner, children, deliverables, blocker, reporting and session', async () => {
  server.tasks = hierarchy()
  await mount()
  await click(zh['tab.tasks'])
  await click(all('.dt-tasks-row')[0]!)
  await click(zh.taskHierarchyOpen)
  const detail = document.querySelector<HTMLElement>('.dt-task-detail')!
  expect(detail.querySelector('.dt-task-detail-title')?.textContent).toBe('修复回归（T2-03）')
  expect(detail.textContent).toContain(zh.taskHierarchyGoal)
  expect(detail.textContent).toContain('worker-plan · 第 2 版')
  expect(detail.textContent).toContain('补迁移说明')
  expect(detail.textContent).toContain(zh.taskHierarchyReportedFailed)
  expect(detail.textContent).toContain('缺少迁移目标')
  expect(detail.textContent).toContain(zh.taskHierarchyDeliverables)
  expect(detail.textContent).toContain('docs/migration.md · r1')
  expect(detail.textContent).toContain(zh.taskHierarchyBlockers)
  expect(detail.textContent).toContain('1 个子任务')
  expect(detail.textContent).toContain(zh.taskHierarchyOpenSession)
  // The default hierarchy shows no internal Session or Ticket identifiers; the E2 fold is closed until asked.
  expect(detail.textContent).not.toMatch(/session_|ticket_|worker-t1/)
  expect(detail.querySelector<HTMLDetailsElement>('.dt-e0-technical')?.open).toBe(false)
  await click(detail.querySelector<HTMLElement>('.dt-e0-technical summary')!)
  expect(detail.querySelector('.dt-e0-technical')?.textContent).toContain('t1')
  await click(zh.taskHierarchyOpenSession)
  expect(server.opened).toEqual(['worker-t1'])
})

it('keeps the compact selected-row goal when ux.taskHierarchy.v1 is off', async () => {
  localStorage.setItem('ux.taskHierarchy.v1', 'off')
  server.tasks = hierarchy()
  await mount()
  await click(zh['tab.tasks'])
  await click(all('.dt-tasks-row')[0]!)
  expect(all('button').some(button => button.textContent === zh.taskHierarchyOpen)).toBe(false)
  expect(text()).toContain(zh.tasksGoal)
  expect(text()).toContain(zh.tasksSelectedHint)
})