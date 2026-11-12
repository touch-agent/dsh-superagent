// @vitest-environment jsdom
// UX batch 2: operations pages inside Settings, the deeper task detail, and the first-use/empty state.
import { afterEach, expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import type { TaskBoardView, TaskView } from '@superagent/dsh/app/tasks.ts'
import { usePanel, mount, all, click, text, tab } from './fixtures/panel.tsx'
import { server, taskBoardView } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => localStorage.clear())
/** The batch-2 defaults: no opt-out keys, unlike the batch-1 specs the harness pins. */
function defaults() {
  for (const flag of ['ux.opsInSettings.v1', 'ux.taskDetail.v2', 'ux.firstUse.v1']) localStorage.removeItem(flag)
}

function hierarchy(): TaskBoardView {
  const board = taskBoardView()
  const child: TaskView = { id: 't1-child', kind: 'ticket', title: '补迁移说明', form: 'tracked', status: 'blocked', attention: true,
    parentTicketId: 't1', rootTicketId: 't1', depth: 1,
    origin: { source: 'conversation', triggerId: 'tr9', preview: '补迁移说明', at: '2026-09-23T00:00:00Z' },
    sources: [{ source: 'conversation', label: '主会话' }], execution: { assignments: 1 },
    owner: { role: 'owner', profile: { id: 'worker-plan', revision: 3 } },
    delegation: { parentTicketId: 't1', rootTicketId: 't1', goal: '写迁移说明', attempt: 1, dispositions: [],
      resolution: { kind: 'failed', by: { source: 'dsh', id: 'worker-plan' }, at: '2026-09-23T01:00:00Z', reason: '缺少迁移目标' } },
    goal: { id: 't1-child', statement: '写迁移说明', state: { stage: 'waiting', action: 'blocked' }, results: [] },
    deliverables: [{ key: 't1-child:d1', sources: [], at: '2026-09-23T01:00:00Z', summary: '迁移说明已补',
      artifact: { kind: 'file', ref: 'https://github.com/acme/widgets/pull/42', revision: 'r1' },
      previewRef: { kind: 'text/diff', ref: 'https://github.com/acme/widgets/pull/42/files', revision: 'r1' },
      criteria: [], confirmations: [] }],
    blocker: { kind: 'blocked', detail: '缺少迁移目标' },
    childSummary: { total: 0, live: 0, queued: 0, working: 0, waiting: 1, review: 0, blocked: 1, failed: 0, orphaned: 0,
      accepted: 0, cancelled: 0, unresolved: 0 } }
  const root: TaskView = { ...board.tasks[0]!, status: 'review', attention: true, durationMs: 7_200_000,
    owner: { role: 'owner', profile: { id: 'worker-plan', revision: 2 } }, worker: { role: 'worker', sessionId: 'worker-t1' },
    goal: { id: 't1', statement: '修复回归', state: { stage: 'person', action: 'review' }, decision: { kind: 'review' },
      results: [] },
    review: { reviewRevision: 'r1', deliverables: [], criteria: [], confirmations: [], summary: '已修好登录回归，等验收。' },
    deliverables: [{ key: 'file:docs/migration.md:r1', sources: [], at: '2026-09-23T02:00:00Z',
      artifact: { kind: 'file', ref: 'https://github.com/acme/widgets/pull/42', revision: 'r1' },
      previewRef: { kind: 'text/diff', ref: 'https://github.com/acme/widgets/pull/42/files', revision: 'r1' }, criteria: [],
      confirmations: [] }],
    blocker: { kind: 'child', count: 1, detail: '1 blocked · 0 failed · 0 orphaned' },
    childSummary: { total: 1, live: 1, queued: 0, working: 0, waiting: 1, review: 0, blocked: 1, failed: 0, orphaned: 0,
      accepted: 0, cancelled: 0, unresolved: 0 }, children: [child] }
  return { ...board, totals: { ...board.totals, tickets: 1 }, tasks: [root] }
}

it('keeps only Overview, Tasks and Settings as first-level entries by default', async () => {
  defaults()
  await mount()
  expect(all('[role="tab"]').map(item => item.textContent)).toEqual(['概览', '任务', '设置'])
  // The landing page carries the three lines before the person has to find the task page.
  expect(text()).toContain(zh.firstUseCanDo)
})

it('opens the operations surfaces as Settings pages with grouped nav, icons and one-line descriptions', async () => {
  defaults()
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'source' }, stack: [] }))
  await mount()
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(all('.dt-settings-nav-title').map(item => item.textContent)).toEqual(['来源与任务', '界面与偏好', '系统'])
  expect(all('.dt-settings-link').map(item => item.textContent)).toEqual(['来源', '触发', '评估', '执行', '显示', '提示词', '部署'])
  expect(all('.dt-settings-link').every(item => item.querySelector('svg') !== null)).toBe(true)
  expect(text()).toContain(zh['settingsDescription.source'])
  // The operations list and its configuration share one page; the status list is the same read model as before.
  expect(text()).toContain(zh.statusTitle)
  expect(text()).toContain(zh.settingsOpsBoundary)

})

it('opens triggers as a Settings page and keeps the source list as a direct deep link', async () => {
  defaults()
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'trigger' }, stack: [] }))
  await mount()
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe('触发')
  expect(text()).toContain(zh['settingsDescription.trigger'])
  expect(text()).toContain(zh.statusTitle)
})

it('keeps eval and execution deep links landing on their Settings page', async () => {
  defaults()
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'eval' }, stack: [] }))
  await mount()
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe('评估')
  expect(text()).toContain(zh['settingsDescription.eval'])

})

it('opens the execution queue as a Settings page', async () => {
  defaults()
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'execution' }, stack: [] }))
  await mount()
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe('执行')
  expect(text()).toContain(zh['settingsDescription.execution'])
})

it('keeps a task detail deep link without selecting a tab', async () => {
  defaults()
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'execution', id: 't1' }, stack: [] }))
  await mount()
  expect(all('[role="tab"]').map(item => item.textContent)).toEqual(['概览', '任务', '设置'])
  expect(all('[role="tab"]').some(item => item.getAttribute('aria-selected') === 'true')).toBe(false)
  expect(document.querySelector('main[role="tabpanel"]')?.getAttribute('aria-label')).toBe('执行')
})

it('restores the seven first-level entries and the old settings list when ux.opsInSettings.v1 is off', async () => {
  defaults()
  localStorage.setItem('ux.opsInSettings.v1', 'off')
  await mount()
  expect(all('[role="tab"]').map(item => item.textContent)).toEqual(['概览', '任务', '来源', '触发', '评估', '执行', '设置'])
  await click(zh['tab.settings'])
  expect(all('.dt-settings-link').map(item => item.textContent)).toEqual(['来源', '评估', '执行', '显示', '提示词', '部署'])
  await click(zh['tab.source'])
  expect(text()).toContain(zh.statusTitle)
  expect(document.querySelector('.dt-settings')).toBeNull()
})

it('answers decision, result, next step with timing, owner and each child report in the deeper detail', async () => {
  defaults()
  localStorage.setItem('ux.opsInSettings.v1', 'off')
  server.tasks = hierarchy()
  server.profiles = [{ id: 'worker-plan', title: '迁移文案负责人', description: '负责修改迁移与登录文案', role: 'worker', lastBoundAt: undefined,
    activeRevision: 2, retiredRevisions: [], updatedBy: 'panel', contentHash: 'hash', moving: false }]
  await mount()
  await click(zh['tab.tasks'])
  await click(all('.dt-tasks-row')[0]!)
  await click(zh.taskHierarchyOpen)
  const detail = document.querySelector<HTMLElement>('.dt-task-detail')!
  expect(detail.textContent).toContain(zh.taskDetailDecision)
  expect(detail.textContent).toContain(zh.taskHierarchyNextReview)
  expect(detail.textContent).toContain(zh.taskDetailDone)
  expect(detail.textContent).toContain('已修好登录回归，等验收。')
  expect(detail.textContent).toContain(zh.taskDetailOpenDeliverable)
  expect(detail.querySelector('a[href="https://github.com/acme/widgets/pull/42/files"]')).not.toBeNull()
  expect(detail.textContent).toContain(zh.taskDetailNextEstimate)
  expect(detail.textContent).toContain(zh.taskDetailEstimateWaiting)
  expect(detail.textContent).toContain(zh.taskDetailOwner)
  expect(detail.textContent).toContain('迁移文案负责人 · 第 2 版')
  expect(detail.textContent).toContain('负责修改迁移与登录文案')
  // The profile and Session ids stay out of the default detail.
  expect(detail.textContent).not.toContain('worker-plan')
  expect(detail.textContent).not.toContain('worker-t1')
  // Each child report opens on its own, including the goal, the upstream decision and its reason.
  const report = detail.querySelector<HTMLDetailsElement>('.dt-task-child-report')!
  expect(report.open).toBe(false)
  await click(report.querySelector<HTMLElement>('summary')!)
  expect(report.textContent).toContain(zh.taskDetailChildGoal)
  expect(report.textContent).toContain('写迁移说明')
  expect(report.textContent).toContain('缺少迁移目标')
  expect(report.querySelector('a')?.textContent).toBe(zh.taskDetailOpenDeliverable)
})

it('shows the three first-use lines once and clickable starting points when there is no task', async () => {
  defaults()
  localStorage.setItem('ux.opsInSettings.v1', 'off')
  server.tasks = { ...taskBoardView(), tasks: [], totals: { milestones: 0, tasks: 0, tickets: 0, open: 0, attention: 0 } }
  await mount()
  await click(zh['tab.tasks'])
  expect(text()).toContain(zh.firstUseCanDo)
  expect(text()).toContain(zh.firstUseNeeds)
  expect(text()).toContain(zh.firstUseStart)
  await click(zh.firstUseDismiss)
  expect(text()).not.toContain(zh.firstUseCanDo)
  expect(localStorage.getItem('dsh-superagent/first-use-dismissed')).toBe('on')
  // The examples remain after the notes are dismissed, because the empty list still needs a way to start.
  const empty = document.querySelector('.dt-first-use-empty')
  expect(empty?.textContent).toContain(zh.firstUseExamples)
  expect(all('.dt-first-use-empty button')).toHaveLength(2)
  // Settings › Display can show the notes again without changing the feature flag.
  await click(zh['tab.settings'])
  await click('显示')
  await click(zh.firstUseRestore)
  expect(localStorage.getItem('dsh-superagent/first-use-dismissed')).toBeNull()
  await click(zh['tab.tasks'])
  expect(text()).toContain(zh.firstUseCanDo)
})
