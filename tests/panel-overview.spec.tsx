// @vitest-environment jsdom
// The overview.
import { afterEach, expect, it } from 'vitest'
import { en, zh } from '@superagent/dsh/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, text } from './fixtures/panel.tsx'
import { server, approvalSummary, droppedReply, threadSummary } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => localStorage.clear())
it('opens with the three zones and keeps health as a folded E2 path', async () => {
  await mount()
  expect(tab(zh['tab.overview']).getAttribute('aria-selected')).toBe('true')
  expect(all('[role="tab"]').map(tab => tab.textContent)).toEqual(['概览', '任务', '来源', '触发', '评估', '执行', '设置'])
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual(['待我处理4', '正在跑1任务详情 ›', '最近历史1详情 ›',
    '过去 24 小时详情 ›', '运行健康'])
  // Waiting for a person first, then the running Ticket and the recently ended one; each carries its own stage.
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual(['待回答', '待处理失败', '执行中', '人工停止'])
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  // Actions sit below the title and Threads, apart from the stage, each with its icon.
  expect(all('.dt-ticket').every(row => row.querySelector('.dt-ticket-stage button, .dt-ticket-stage a') === null
    && [...row.querySelectorAll('.dt-ticket-actions button, .dt-ticket-actions a')].every(action => action.querySelector('svg')))).toBe(true)
  expect(text()).toContain('来源会在每次轮询时自动重试')
  expect(text()).toContain('需要确认按钮颜色')
  expect(all('.dt-stat').map(stat => stat.textContent)).toEqual(['执行中2 / 3', '排队0', '等待新触发1', '到达12', '被过滤2', '已评估5',
    '接单或续做1', `${zh.metricTtfaLabel}4 s / 9 s`, `${zh.metricDuplicatesLabel}0`, `${zh.metricRecoveryLabel}30 s`,
    `${zh.metricThroughputLabel}0.2`, `${zh.metricApprovalLabel}20 s / 1 min`])
  expect(all('.dt-chip').map(chip => chip.textContent)[0]).toBe('GitHub#42CI 失败1')
  expect(document.querySelector('.dt-chip-problem')?.textContent).toBe('CI 失败1')
  expect(document.querySelector<HTMLAnchorElement>('a.dt-chip-link')?.href).toBe('https://github.com/acme/widgets/pull/42')
  // Running links to the task view (E1) and to the working filter of the Execution page (E2).
  expect(all('.dt-zone-links button').map(link => link.textContent)).toEqual(['任务', '详情 ›', '详情 ›'])
  await click(all('.dt-zone-links button')[0]!)
  expect(tab(zh['tab.tasks']).getAttribute('aria-selected')).toBe('true')
  await click(tab(zh['tab.overview']))
  await click(all('.dt-zone-links button')[1]!)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  expect(text()).toContain(zh['ticketFilter.working'])
  await click(tab(zh['tab.overview']))
  await click(all('.dt-zone-links button')[2]!)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  expect(text()).toContain(zh['ticketFilter.ended'])
})

it('re-evaluates or dismisses an unjudged Eval from the problem list', async () => {
  await mount()
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(zh.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})

it('opens the Thread of an unjudged Eval at its Trigger from the problem list', async () => {
  await mount()
  await click('评估未完成：这个文案好奇怪')
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e3')
})

it('follows the last day\'s counts to the status of each stage', async () => {
  await mount()
  // Arrived Triggers include filtered ones, which have no Thread, so no list has that count to link to.
  expect(all('.dt-stat button').map(button => button.textContent)).toEqual(['2', '1'])
  await click(all('.dt-stat button')[0]!)
  expect(tab(zh['tab.source']).getAttribute('aria-selected')).toBe('true')
  await click(zh.sourceFilteredTitle)
  expect(text()).toContain('looks wrong')
  expect(text()).toContain(zh['reason.source_disabled'])
})

it('offers each Ticket that needs a person its E0 actions on the overview: answer in its Channel, retry and stop',
  async () => {
  await mount()
  expect(all('.dt-ticket-actions a').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['去飞书回答',
    'https://applink.feishu.cn/client/chat/open?openChatId=oc_1']])
  expect(all('.dt-ticket-note').map(note => note.textContent)).toContain('LlmError: no adapter registered for provider "provider-a"')
  // The default row carries goal, state and the decision; opening the Executor Session is an E3 detail on the Ticket page.
  expect(all('.dt-ticket-actions button').map(button => button.textContent)).not.toContain(zh.openSession)
  expect(all('.dt-ticket .dt-ticket-meta').map(meta => meta.textContent).join(' ')).not.toContain('未送达')
  expect(text()).not.toMatch(/worker-|Assignment|Session id/)
  await click(zh.retry)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/retry' && request.method === 'POST')).toBe(true)
  const row = all('.dt-ticket').find(item => item.textContent?.includes('截图工具'))!
  await click([...row.querySelectorAll<HTMLButtonElement>('.dt-ticket-actions button')].find(button => button.textContent === '停止')!)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'tickets/t4/stop' && request.method === 'POST')).toBe(true)
  expect(text()).not.toContain('截图工具')
})

it('puts the approval decision in E0 words and folds the object id and action kind into technical details', async () => {
  server.approvals = [approvalSummary()]
  await mount()
  expect(text()).toContain(zh.approvalNeedsYou)
  expect(text()).toContain(zh['level.send'])
  expect(text()).toContain(zh['levelEffect.send'])
  const details = document.querySelector('.dt-e0-technical') as HTMLDetailsElement
  expect(details.open).toBe(false)
  expect(details.querySelector('summary')?.textContent).toBe(zh.approvalTechnical)
  expect(details.textContent).toContain('om_reply_1')
  expect(details.textContent).toContain('mail.reply')
})

it('keeps the Executor Session entry on the Ticket page as an explicit E3 detail, not on the E1 default page', async () => {
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(text()).not.toContain(zh.openSession)
  await click(zh.identifiers)
  await click(find(zh.openSession))
  expect(server.opened).toEqual(['worker-t1'])
})

it('shows paused processing as a system problem with its resume action, and says so on the Policy records', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  expect(text()).toContain(zh.problemPaused)
  await click(zh['tab.eval'])
  expect(text()).toContain(zh.evalRecordsPaused)
  await click(zh.resumeWhere)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
  await click(zh['tab.overview'])
  await click(find(zh.resumeProcessing, '.dt-att button'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
})

it('offers the step that fixes a settings problem as a button on the overview', async () => {
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { feishu: { allowed: [], admission: {} },
    github: { allowed: [], admission: {} } } } }
  await mount()
  expect(text()).toContain(zh.problemNoAllowed)
  await click(zh.actionAddAllowed)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
})

it('counts the messages not sent in the last day, linking to the Source status, and shows nothing when there are none', async () => {
  await mount()
  expect(all('.dt-stat-label').map(label => label.textContent)).not.toContain(zh.flowDroppedLabel)
  server.dropped = [droppedReply('m2', 1, 'feishu', 'channelGone'), droppedReply('m1', 2, 'github', 'channelIgnored'), droppedReply('m0',
    30, 'feishu', 'channelGone')]
  await remount()
  const stat = all('.dt-stat').find(item => item.querySelector('.dt-stat-label')?.textContent === zh.flowDroppedLabel)!
  expect(stat.textContent).toBe(`${zh.flowDroppedLabel}2`)
  await click(stat.querySelector('button')!)
  expect(tab(zh['tab.source'])?.getAttribute('aria-selected')).toBe('true')
})

it('names a failing part of dsh-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toContain(zh.problemRuntime.replace('{name}', zh['health.launch']))
  expect(text()).toContain('spawn failed')
})

it('words a refused retry in the interface language by its code', async () => {
  await mount()
  // Simulate another user retrying the ticket after the overview loaded.
  server.person = server.person.map(ticket => ticket.id === 't4' ? { ...ticket, actions: { ...ticket.actions, retry: false } } : ticket)
  await click(find(zh.retry, '.dt-ticket-actions button'))
  await click(zh.confirm)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh['userError.notRetryable'])
  expect(text()).not.toContain('Only an open ticket can be retried, and only when its worker last reported failed or blocked and no person has sent a message since, or when delivering an Input to its worker failed')
})

it('shows the three zones in English', async () => {
  await mount(en)
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${en.entryNeeds}4`, `${en.entryRunning}1TasksDetails ›`,
    `${en.entryRecent}1Details ›`, `${en.lastDay}${en.details}`, en.metricsTitle])
  expect(all('.dt-cards .dt-ticket-stage').map(item => item.textContent)).toEqual([en['stage.answer'], en['stage.failed'],
    en['stage.working'], en['outcome.stopped']])
  expect(all('.dt-stat-label').map(label => label.textContent)).toEqual([en.executingLabel, en.queuedLabel, en.idleLabel,
    en.flowReceivedLabel, en.flowFilteredLabel, en.flowJudgedLabel, en.flowAcceptedLabel, en.metricTtfaLabel, en.metricDuplicatesLabel,
    en.metricRecoveryLabel, en.metricThroughputLabel, en.metricApprovalLabel])
})

it('restores the pre-X-09 Overview, and hides no record, when entry.threeZones.v1 is off', async () => {
  localStorage.setItem('entry.threeZones.v1', 'off')
  await mount()
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${zh.pendingTickets}2`, `${zh.problems}2`,
    `${zh.lastDay}${zh.details}`, zh.metricsTitle, `${zh['term.executor']}${zh.details}`])
  // The old sections still lead to the same records and tabs.
  await click(all('.dt-more-link').at(-1)!)
  expect(tab(zh['tab.execution']).getAttribute('aria-selected')).toBe('true')
})

it('lists the unavailable Evals one by one, without the health entry that counts them as a failure of dsh-superagent', async () => {
  server.health.evals = { state: 'error', detail: '1 Eval(s) unavailable in the last hour without a later judgement' }
  await mount()
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  expect(text()).not.toContain(zh['health.evals'])
})

it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'github']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'github:9', title: '#9 迟迟未决', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'github', thread: 'github:42', address: { number: '42' } },
    text: '已修复', attempts: 4,
    error: 'HTTP 502 from GitHub' }]
  await mount()
  const titles = () => all('.dt-cards .dt-att-what').map(item => item.textContent)
  // The Feishu Source is off, so its error is no problem any more.
  expect(titles()).toEqual([zh.problemNoSource, '评估超时未决定：#9 迟迟未决', '评估未完成：这个文案好奇怪', 'GitHub 回复发送失败（已重试 4 次）'])
  expect(text()).toContain('HTTP 502 from GitHub')
  await click(zh.actionOpenSources)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.source'])
  await click(tab(zh['tab.overview']))
  await click('评估超时未决定：#9 迟迟未决')
  expect(server.requests.some(request => request.path.startsWith('threads/github:9'))).toBe(true)
})
