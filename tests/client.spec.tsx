// @vitest-environment jsdom
import { act, useState, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError, caller, usePoll } from '@superagent/dsh/client/api.ts'
import { apply } from '@superagent/dsh/client/index.tsx'
import type { ActivityRecord } from '@superagent/dsh/app/activity.ts'
import { zh } from '@superagent/dsh/client/locales.ts'
import { PANEL_NAVIGATE } from '@superagent/dsh/client/panel.ts'
import { activityTitle, matchesActivityFilter } from '@superagent/dsh/client/system.tsx'
import { SettingsSchema } from '@superagent/dsh/policy.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Entry = { options: { name: string; id?: string; key?: string; order?: number; locale?: string; label?: () => string }; component: ComponentType<Record<string, unknown>> }
const t = ((key: keyof typeof zh, values: Record<string, string | number> = {}) => (zh[key] ?? key)
  .replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ''))) as never
function fixture(listed: string[]) {
  const entries: Entry[] = []
  const dictionaries: Record<string, unknown> = {}
  const opened: string[] = []
  const tabs: unknown[] = []
  const ctx = {
    slots: { inject: (_name: string, register: () => void) => register(), register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: (ns: string, value: unknown) => { dictionaries[ns] = value; return () => {} }, bind: () => t },
    effect: (effect: () => unknown) => { effect() },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: Object.fromEntries(listed.map(id => [id, {}])) }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn() },
    // Omit the config form service so Deployment renders read-only; the right sidebar is available.
    get: (name: string) => name === 'sidebarRight' ? { openTab: (kind: string) => opened.push(kind) }
      : name === 'sidebarRightTabs' ? { register: (definition: unknown) => { tabs.push(definition); return () => {} } } : undefined,
  }
  apply(ctx as never)
  const entry = (name: string) => entries.find(item => item.options.name === name)!
  return { ctx, entries, dictionaries, opened, tabs, main: entry('main'), nav: entry('sidebar.panellist') }
}
async function render(entry: Entry, props: Record<string, unknown>) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<entry.component {...props} />) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return { container, dispose: () => { act(() => { root.unmount() }); container.remove() } }
}
const openMaster = async (container: HTMLElement) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === zh.openMaster)!
  await act(async () => { button.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const feedItem = { seq: 1, at: '2026-01-01T00:00:00Z', event: 'ticket.ended' as const, level: 'notice' as const,
  summary: 'Ticket t1 ended', ticket: 't1' }
const board = { generatedAt: '2026-09-23T12:00:00Z', totals: { milestones: 1, tasks: 1, tickets: 1, open: 1, attention: 0 },
  tasks: [], milestones: [
  { kind: 'milestone', id: 'M2', title: 'M2', status: 'review', progress: { done: 0, total: 2 }, durationMs: 86_400_000,
    startedAt: '2026-09-22T00:00:00Z', children: [
      { kind: 'task', id: 'T2-03', title: '修复登录', subtitle: 'T2-03', status: 'review', progress: { done: 0, total: 2 },
        durationMs: 86_400_000, startedAt: '2026-09-22T00:00:00Z', plan: { milestone: 'M2', task: 'T2-03' }, children: [
          { kind: 'ticket', id: 't1', title: '修复登录（T2-03）', status: 'working', progress: { done: 0, total: 1 },
            durationMs: 86_400_000, startedAt: '2026-09-22T00:00:00Z', href: { page: 'execution', id: 't1' }, children: [
              { kind: 'pull', id: 'github:42', title: '#42 Fix login', subtitle: 'github', status: 'idle',
                href: { url: 'https://github.com/acme/widgets/pull/42' }, facts: { number: { value: '#42' } }, children: [] },
              { kind: 'review', id: 'r1', title: 'review PR #42：修复登录', status: 'review', durationMs: 7_200_000,
                startedAt: '2026-09-22T02:00:00Z', href: { page: 'execution', id: 'r1' }, children: [] }] }] }],
    graph: { start: '2026-09-22T00:00:00Z', end: '2026-09-23T12:00:00Z', lanes: 1, branches: [
      { id: 't1', title: '修复登录（T2-03）', task: 'T2-03', start: '2026-09-22T00:00:00Z', status: 'working', lane: 0 }] } }] }
const serve = (activity: ActivityRecord[] = [feedItem]) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
  const path = new URL(url, 'http://127.0.0.1').pathname.replace('/orchestrator/api/', '')
  if (path === 'tasks') return Response.json(board)
  if (path === 'overview') return Response.json({ approvals: [], problems: [], person: [], executor: { running: 0, queued: 0, maxWorkers: 3, idle: 0 }, flow: { triggers: 0, filtered: 0, judged: 0, accepted: 0, evaluating: 0 }, metrics: { window: { since: '', hours: 24 }, ttfa: { samples: 0, medianSeconds: null, p90Seconds: null }, duplicates: { sends: 0, repeated: 0 }, recovery: { interrupted: 0, recovered: 0, medianSeconds: null }, throughput: { decisions: 0, perHour: 0 }, approval: { samples: 0, medianSeconds: null, p90Seconds: null } }, policyVersion: 'v' })
  if (path === 'tickets') return Response.json({ items: [], total: 0, offset: 0, limit: 20 })
  if (path === 'activity') {
    const level = new URL(url, 'http://127.0.0.1').searchParams.get('level')
    if (level === 'notice') return Response.json({ items: [], latest: 0, next: 0 })
    return Response.json({ items: activity, latest: activity[0]?.seq ?? 0, next: activity[0]?.seq ?? 0 })
  }
  if (path === 'state') return Response.json({ masterId: 'master', settings: SettingsSchema.parse({}), revisions: { policy: 0, eval: 0, executor: 0 }, sources: [], policy_version: 'v', health: {}, outgoing: [], load: { running: 0, queued: 0 },
    setup: { machine: { stateDir: '/srv/state', worktreeRoot: '/srv/state/worktrees', blockedCommands: [], promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 }, problem: null, feishuProblem: null, accounts: null } })
  return Response.json({ error: 'unavailable' }, { status: 503 })
}))
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })

it('registers a localized main panel, sidebar entry and Plugin Manager row page, and no settings section', () => {
  const { entries, dictionaries, main, nav } = fixture([])
  expect(entries.map(entry => entry.options.name)).toEqual(['main', 'sidebar.panellist', 'conversation.hero.options',
    'sidebar.session.row.leading', 'conversation.view', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title',
    'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'conversation.session.header.utilities', 'plugins.row.config'])
  expect(entries[10]!.options).toMatchObject({ key: 'dsh-superagent#dsh-superagent', locale: 'dshSuperagent' })
  expect(Object.keys(dictionaries)).toEqual(['dshSuperagent'])
  expect(main.options).toMatchObject({ key: 'dsh-superagent', locale: 'dshSuperagent' })
  expect(nav.options).toMatchObject({ id: 'dsh-superagent', order: 10, locale: 'dshSuperagent' })
  expect(nav.options.label?.()).toBe('Superagent')
})


it('rolls the Task tab and its Events task scope back when taskView.v1 is off', () => {
  localStorage.setItem('taskView.v1', 'off')
  const { entries, tabs } = fixture([])
  expect(entries.map(entry => entry.options.name)).toEqual(['main', 'sidebar.panellist', 'conversation.hero.options',
    'sidebar.session.row.leading', 'conversation.view', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title',
    'conversation.session.header.utilities', 'plugins.row.config'])
  expect(tabs).toHaveLength(1)
})

it('opens a listed Session through the workspace from the main panel', async () => {
  serve()
  const { ctx, main } = fixture(['master'])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose()
})

it('reports a Session missing from the catalog in the interface language', async () => {
  serve()
  const { ctx, main } = fixture([])
  const view = await render(main, { t })
  await openMaster(view.container)
  expect(ctx.uiWorkspace.openSession).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain(zh.sessionNotListed)
  view.dispose()
})

it('polls one request at a time, keeps the data while new dependencies load, and polls less while hidden', async () => {
  vi.useFakeTimers()
  const calls: { limit: number; done: (value: string[]) => void }[] = []
  let shown: { data?: string[]; limit: number } = { limit: 0 }
  let setLimit = (_limit: number) => {}
  function Harness() {
    const [limit, update] = useState(1)
    setLimit = update
    const { data } = usePoll(() => new Promise<string[]>(done => { calls.push({ limit, done }) }), [limit], 1000)
    shown = { ...data ? { data } : {}, limit }
    return null
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => { root.render(<Harness />) })
  expect(calls).toHaveLength(1)
  // A slow response holds the next poll back instead of overlapping.
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(1)
  await act(async () => { calls[0]!.done(['a']) })
  expect(shown.data).toEqual(['a'])
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(calls).toHaveLength(2)
  await act(async () => { setLimit(2) })
  expect(shown).toEqual({ data: ['a'], limit: 2 })
  await act(async () => { calls[2]!.done(['a', 'b']) })
  expect(shown.data).toEqual(['a', 'b'])
  // A late response to the superseded request must not replace the newer result.
  await act(async () => { calls[1]!.done(['stale']) })
  expect(shown.data).toEqual(['a', 'b'])
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  await act(async () => { calls[3]!.done(['a', 'b']) })
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(calls).toHaveLength(4)
  hidden.mockRestore()
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(calls).toHaveLength(5)
  act(() => { root.unmount() })
  vi.useRealTimers()
})

it('tells a dsh-superagent that does not answer from a record it does not have, and words each failure by what failed', async () => {
  const messages = { offline: 'offline', notRunning: 'not running', serverError: (status: number) => `server ${status}`,
    requestFailed: (status: number) => `request ${status}`, setup: () => 'setup', user: ({ code }: { code: string }) => `user ${code}` }
  const call = caller(() => messages)
  const failure = async (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', vi.fn(answer))
    const error = await call('GET tickets/:id', { id: 't1' }).then(() => undefined, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ApiError)
    const { message, status, missing, details } = error as ApiError
    return { message, status, missing, unreachable: !!details.unreachable }
  }
  expect(await failure(async () => { throw new TypeError('Failed to fetch') })).toEqual({ message: 'offline', status: 0, missing: false,
    unreachable: true })
  // DSH's web server answers an empty 404 while dsh-superagent's routes are unregistered.
  expect(await failure(async () => new Response(null, { status: 404 }))).toEqual({ message: 'not running', status: 404, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response(null, { status: 502 }))).toEqual({ message: 'server 502', status: 502, missing: false,
    unreachable: true })
  expect(await failure(async () => new Response('<html>Bad request</html>', { status: 400 }))).toEqual({ message: 'request 400',
    status: 400, missing: false, unreachable: false })
  expect(await failure(async () => Response.json({ error: 'Unknown ticket', code: 'unknownTicket' }, { status: 404 }))).toEqual({
    message: 'user unknownTicket', status: 404, missing: true, unreachable: false })
})

it('opens the existing main Session from the New Session option, not a new one', async () => {
  serve()
  const { ctx, entries } = fixture(['master'])
  const view = await render(entries.find(entry => entry.options.name === 'conversation.hero.options')!, { t })
  const button = [...view.container.querySelectorAll('button')].find(item => item.textContent === zh.masterSession)!
  expect(button.hasAttribute('disabled')).toBe(false)
  await act(async () => { button.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(ctx.uiWorkspace.openSession).toHaveBeenCalledExactlyOnceWith('master')
  view.dispose()
})
it('marks the main Session row and leaves every other row unmarked', async () => {
  serve()
  const { entries } = fixture([])
  const badge = entries.find(entry => entry.options.name === 'sidebar.session.row.leading')!
  const master = await render(badge, { sessionId: 'master', t })
  expect(master.container.querySelector('.dt-master-badge')?.textContent).toBe(zh.masterBadge)
  master.dispose()
  const other = await render(badge, { sessionId: 'other', t })
  expect(other.container.querySelector('.dt-master-badge')).toBeNull()
  other.dispose()
})
it('reuses the management page only for the main Session', async () => {
  serve()
  const { entries } = fixture([])
  const system = entries.find(entry => entry.options.name === 'conversation.view')!
  expect(system.options.label?.()).toBe(zh.systemTab)
  const master = await render(system, { sessionId: 'master', t })
  expect(master.container.textContent).toContain(zh.title)
  expect(master.container.textContent).toContain(zh['tab.overview'])
  master.dispose()
  const other = await render(system, { sessionId: 'other', t })
  expect(other.container.textContent).toContain(zh.systemOnlyMaster)
  expect(other.container.textContent).not.toContain(zh.title)
  other.dispose()
})
it('mounts the embedded Status page with unique ids and keeps panel navigation out of it', async () => {
  serve()
  const { main, entries } = fixture(['master'])
  const system = entries.find(entry => entry.options.name === 'conversation.view')!
  const Main = main.component
  const Status = system.component
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<><Main t={t} /><Status sessionId="master" t={t} /></>) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const ids = [...container.querySelectorAll('[id]')].map(node => node.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(container.querySelector('#dt-page')).not.toBeNull()
  expect(container.querySelector('#dt-page-status')).not.toBeNull()
  await act(async () => { window.dispatchEvent(new CustomEvent(PANEL_NAVIGATE, { detail: { page: 'settings', query: { group: 'source' } } })) })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(container.querySelector('#dt-page')?.getAttribute('aria-labelledby')).toBe('dt-tab-settings')
  expect(container.querySelector('#dt-page-status')?.getAttribute('aria-labelledby')).toBe('dt-page-status-tab-overview')
  act(() => { root.unmount() }); container.remove()
})
it('shows the identity error instead of loading forever when GET state fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'down' }, { status: 503 })))
  const { entries } = fixture([])
  const system = entries.find(entry => entry.options.name === 'conversation.view')!
  const master = await render(system, { sessionId: 'master', t })
  expect(master.container.textContent).toContain('down')
  expect(master.container.textContent).not.toContain(zh.loading)
  master.dispose()
})
it('shows the unread notice count in the Events tab title and clears it when the tab opens', async () => {
  serve()
  const { entries } = fixture([])
  const title = await render(entries.find(entry => entry.options.name === 'sidebar.right.pane.tab.title')!, { t })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(title.container.textContent).toContain(zh.eventsTab)
  expect(title.container.querySelector('.dt-events-unread')?.textContent).toBe('1')
  title.dispose()
  const body = await render(entries.find(entry => entry.options.name === 'sidebar.right.pane.tab')!, { t })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(localStorage.getItem('dsh-superagent/activity-seen')).toBe('1')
  body.dispose()
})
it('groups events by task with readable titles, object badges, states, durations and filters', async () => {
  const at = '2026-01-01T00:00:00Z'
  const items: ActivityRecord[] = [
    { seq: 4, at, event: 'ticket.ended', level: 'notice', summary: 'Ticket t1 ended (completed)', ticket: 't1', status: 'done',
      subject: { kind: 'ticket', id: 't1' }, detail: { outcome: 'completed' }, sinceStartMs: 600_000,
      task: { id: 't1', title: 'Fix the Events tab', status: 'done',
        parent: { kind: 'thread', id: 'github:8', source: 'github', label: '#8 Events tab' } } },
    { seq: 3, at, event: 'assignment.started', level: 'quiet', summary: 'Assignment a1 started on t1', ticket: 't1', status: 'working',
      subject: { kind: 'ticket', id: 't1' }, task: { id: 't1', title: 'Fix the Events tab', status: 'done' } },
    { seq: 2, at, event: 'decision.recorded', level: 'feed', summary: 'Decision d1 (accept)', thread: 'github:8', status: 'queued',
      subject: { kind: 'decision', id: 'd1' }, detail: { decision: 'accept' },
      task: { id: 't2', title: 'Review the pull request', status: 'blocked',
        parent: { kind: 'thread', id: 'github:8', source: 'github', label: '#8' } } },
    { seq: 1, at, event: 'policy.changed', level: 'quiet', summary: 'Policy changed from a to b', status: 'done' },
  ]
  serve(items)
  const { entries } = fixture([])
  const view = await render(entries.find(entry => entry.options.name === 'sidebar.right.pane.tab')!, { t })
  const groupTitles = () => [...view.container.querySelectorAll('.dt-events-group-title')].map(node => node.textContent)
  expect(groupTitles()).toEqual(['Fix the Events tab', 'Review the pull request', zh.eventsSystem])
  expect(view.container.textContent).toContain(zh['activityStatus.done'])
  expect(view.container.textContent).toContain(zh['activityStatus.blocked'])
  expect(view.container.textContent).toContain(`来自 GitHub #8 Events tab`)
  expect(view.container.textContent).toContain(`最近：已完成：Fix the Events tab`)
  // Only the blocked task needs a person; the failure filter leaves nothing and says so.
  const filter = (label: string): HTMLButtonElement => [...view.container.querySelectorAll<HTMLButtonElement>('.dt-events-filters button')]
    .find(button => button.textContent === label)!
  await act(async () => { filter(zh['activityFilter.attention']).click() })
  expect(groupTitles()).toEqual(['Review the pull request'])
  await act(async () => { filter(zh['activityFilter.failed']).click() })
  expect(groupTitles()).toEqual([])
  expect(view.container.textContent).toContain(zh.eventsFilterEmpty)
  // Unfold the blocked task: a readable title, its state, the decision badge and the time into the task.
  await act(async () => { filter(zh['activityFilter.all']).click() })
  const blocked = [...view.container.querySelectorAll<HTMLButtonElement>('.dt-events-toggle')]
    .find(button => button.textContent?.includes('Review the pull request'))!
  await act(async () => { blocked.click() })
  expect(view.container.textContent).toContain('判定：接单')
  expect(view.container.textContent).toContain(zh['activityObject.decision'])
  expect(view.container.textContent).toContain(zh['activityStatus.queued'])
  // The object badge opens its own page, not only the row's task.
  let navigated: unknown
  const onNavigate = (event: Event) => { navigated = (event as CustomEvent).detail }
  window.addEventListener(PANEL_NAVIGATE, onNavigate)
  await act(async () => { (view.container.querySelector('.dt-events-subject') as HTMLButtonElement).click() })
  window.removeEventListener(PANEL_NAVIGATE, onNavigate)
  expect(navigated).toEqual({ page: 'eval' })
  view.dispose()
})
it('treats answer and delivery work as needing a person and keeps a recorded ending reason in the title', () => {
  expect(matchesActivityFilter('answer', 'attention')).toBe(true)
  expect(matchesActivityFilter('delivery', 'attention')).toBe(true)
  expect(matchesActivityFilter('answer', 'failed')).toBe(false)
  const ended = { seq: 1, at: '2026-01-01T00:00:00Z', event: 'ticket.ended' as const, level: 'feed' as const,
    summary: 'Ticket t1 ended (manual)', ticket: 't1', detail: { outcome: 'closed' as const, reason: 'manual' },
    task: { id: 't1', title: '固定标题', status: 'failed' as const } }
  const title = activityTitle(t, ended)
  expect(title).toContain('固定标题')
  expect(title).toContain('manual')
  const stopped = { ...ended, summary: 'Ticket t1 ended (不要继续)', detail: { outcome: 'stopped' as const, reason: '不要继续' } }
  expect(activityTitle(t, stopped)).toContain('不要继续')
  expect(activityTitle(t, stopped)).toContain('人工停止')
})
it('opens the Events tab once when the first unread notice reaches the main Session', async () => {
  serve()
  const { opened, entries } = fixture([])
  const bridge = entries.find(entry => entry.options.name === 'conversation.session.header.utilities')!
  const view = await render(bridge, {})
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(opened).toEqual(['system-events'])
  view.dispose()
})

it('keeps the management panel and registers only declared seats on a host without the conversation surfaces', () => {
  const entries: Entry[] = []
  const declared = new Set(['main', 'sidebar.panellist', 'plugins.row.config'])
  const ctx = {
    slots: { inject: (name: string, register: () => void) => { if (declared.has(name)) register() },
      register: (options: Entry['options'], component: Entry['component']) => { entries.push({ options, component }); return () => {} } },
    locale: { register: () => () => {}, bind: () => t },
    effect: (effect: () => unknown) => { effect() },
    sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) }, refresh: vi.fn(async () => {}) },
    uiWorkspace: { openSession: vi.fn() },
    get: () => undefined,
  }
  apply(ctx as never)
  expect(entries.map(entry => entry.options.name)).toEqual(['main', 'sidebar.panellist', 'plugins.row.config'])
})

/** Open the Tickets tab on the management page and let its poll resolve. */
async function openTasks(container: HTMLElement) {
  const tab = [...container.querySelectorAll<HTMLElement>('[role=tab]')].find(item => item.textContent === zh['tab.tasks'])
  expect(tab).toBeDefined()
  await act(async () => { tab!.click() })
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

it('shows the task tree with milestones, tasks, Tickets, reviews and pull requests, and folds a node', async () => {
  serve()
  const { main } = fixture([])
  const view = await render(main, { t })
  await openTasks(view.container)
  const treeTab = [...view.container.querySelectorAll<HTMLElement>('[role=tab]')].find(item => item.textContent === zh['tasksView.tree'])
  expect(treeTab).toBeDefined()
  await act(async () => { treeTab!.click() })
  const rows = [...view.container.querySelectorAll('.dt-task-row')]
  expect(rows.length).toBe(5)
  expect(rows[0]!.textContent).toContain('M2')
  expect(rows[0]!.textContent).toContain('0/2')
  expect(view.container.textContent).toContain('修复登录')
  expect(view.container.textContent).toContain('review PR #42：修复登录')
  expect(view.container.textContent).toContain('#42 Fix login')
  // The milestone row folds its whole subtree; the toggle reports its state for assistive technology.
  const toggle = view.container.querySelector<HTMLButtonElement>('.dt-task-toggle')!
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  await act(async () => { toggle.click() })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(view.container.textContent).not.toContain('修复登录（T2-03）')
  await act(async () => { view.container.querySelector<HTMLButtonElement>('.dt-task-toggle')!.click() })
  expect(view.container.querySelectorAll('.dt-task-row').length).toBe(5)
  view.dispose()
})

it('draws the graph view with a lane per Ticket and its status colour', async () => {
  serve()
  const { main } = fixture([])
  const view = await render(main, { t })
  await openTasks(view.container)
  const graphTab = [...view.container.querySelectorAll<HTMLElement>('[role=tab]')].find(item => item.textContent === zh['tasksView.graph'])
  expect(graphTab).toBeDefined()
  await act(async () => { graphTab!.click() })
  const branch = view.container.querySelector('.dt-graph-branch')
  expect(branch).not.toBeNull()
  expect(branch!.getAttribute('data-status')).toBe('working')
  expect(view.container.querySelectorAll('.dt-graph-legend li')).toHaveLength(1)
  expect(view.container.textContent).toContain(zh.tasksGraphTrunk)
  view.dispose()
})
