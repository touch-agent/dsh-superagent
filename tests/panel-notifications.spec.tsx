// @vitest-environment jsdom
// UX batch 1's notification layer: unread cursor, drawer grouping, in-place actions, folded system notice and cards.
import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import { usePanel, mount, remount, all, find, click, text, settle } from './fixtures/panel.tsx'
import { server, approvalSummary } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => localStorage.clear())
const bell = () => document.querySelector<HTMLButtonElement>('.dt-bell')
const drawer = () => document.querySelector<HTMLElement>('.dt-drawer')
/** The host polls on mount; a server mutation plus a visibility event is the same path a real tab takes. */
async function nextPoll() {
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await settle()
}

it('shows an unread badge, opens the drawer from the bell and groups notices by what a person can do', async () => {
  server.approvals = [approvalSummary()]
  await mount()
  expect(bell()?.getAttribute('aria-label')).toBe(zh.noticeUnread.replace('{count}', '3'))
  await click(bell()!)
  expect(drawer()).not.toBeNull()
  expect(drawer()!.textContent).toContain(zh.notifications)
  expect(drawer()!.textContent).toContain(zh['noticeGroup.attention'])
  expect(drawer()!.textContent).toContain(zh['noticeGroup.progress'])
  expect(drawer()!.textContent).toContain(zh['noticeGroup.system'])
  expect(drawer()!.textContent).toContain(zh.noticeApprovalTitle.replace('{task}', '修复回归'))
  expect(drawer()!.textContent).toContain(zh.noticeApprovalNext.replace('{effect}', zh['levelEffect.send']))
  // Each item answers what happened, what you can do and what ignoring it costs.
  expect(drawer()!.textContent).toContain(zh.noticeApprovalConsequence)
  expect(all('.dt-notice-item[data-kind="attention"]').length).toBe(2)
  expect(drawer()!.querySelectorAll('.dt-notice-unread').length).toBeGreaterThan(0)
  await click(zh.noticeMarkAllRead)
  expect(bell()?.querySelector('.dt-bell-badge')).toBeNull()
  expect(drawer()!.querySelectorAll('.dt-notice-unread')).toHaveLength(0)
})

it('approves and hands a Source over to Settings from the drawer without leaving the notice', async () => {
  server.approvals = [approvalSummary()]
  await mount()
  await click(bell()!)
  await click(zh.approve)
  expect(server.requests.find(request => request.path === 'approvals/ap1/approve')).toMatchObject({ method: 'POST' })
  await click(all('.dt-drawer .dt-pill').find(item => item.textContent?.startsWith(zh['noticeGroup.system']))!)
  await click(zh.noticeDisableSource.replace('{source}', '飞书'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'settings/source:feishu')).toMatchObject({ method: 'PUT' })
  expect((server.requests.find(request => request.path === 'settings/source:feishu')?.body as { value: { enabled: boolean } }).value.enabled)
    .toBe(false)
})

it('folds a Source error and a failed task into one system notice with retry and disable entries', async () => {
  await mount()
  await click(bell()!)
  const system = all('.dt-notice-item[data-kind="system"]')[0]!
  expect(system.textContent).toContain(zh.noticeSystemTitle.replace('{count}', '3'))
  expect(system.textContent).toContain(zh.noticeRetryTask.replace('{task}', '截图工具'))
  expect(system.textContent).toContain(zh.noticeDisableSource.replace('{source}', '飞书'))
  await click(system.querySelector<HTMLElement>('.dt-notice-details button')!)
  expect(system.textContent).toContain(zh.sourceError.replace('{source}', '飞书'))
  expect(system.textContent).toContain('截图工具')
  expect(system.textContent).toContain('LlmError: no adapter registered')
})

it('floats at most three cards for new notices, keeps results in the drawer and stops them with the overlay switch', async () => {
  await mount()
  expect(all('.dt-notice-card').length).toBe(0)
  server.approvals = [approvalSummary(), approvalSummary({ id: 'ap2' }), approvalSummary({ id: 'ap3' }), approvalSummary({ id: 'ap4' })]
  await nextPoll()
  expect(all('.dt-notice-card').length).toBe(3)
  // A result that becomes ready is progress: it joins the drawer and may interrupt, but never displaces a person's work.
  await click(bell()!)
  expect(all('.dt-notice-item[data-kind="attention"]').length).toBeGreaterThanOrEqual(4)
  await click(document.querySelector<HTMLElement>('.dt-drawer-head button')!)
  localStorage.setItem('ux.notifyOverlay.v1', 'off')
  await remount()
  server.approvals = [approvalSummary({ id: 'ap5' })]
  await nextPoll()
  expect(all('.dt-notice-card').length).toBe(0)
  expect(bell()).not.toBeNull()
})

it('keeps the Events tab as the fallback when the drawer switch is off, without deleting notices', async () => {
  localStorage.setItem('ux.notifyDrawer.v1', 'off')
  await mount()
  expect(bell()).toBeNull()
  expect(document.querySelector('.dt-drawer')).toBeNull()
  // No header entry, but the overlay is its own switch, and the right Events tab and every record remain.
  server.approvals = [approvalSummary({ id: 'ap6' })]
  await nextPoll()
  expect(all('.dt-notice-card').length).toBe(1)
  expect(all('.dt-notice-card button').some(button => button.textContent === zh.noticeViewAll)).toBe(false)
  expect(document.querySelector('.dt-page')).not.toBeNull()
  expect(text()).toContain(zh['tab.overview'])
})

it('explains the auto-dismiss choice and stores the browser preference from Display settings', async () => {
  await mount()
  await click(zh['tab.settings'])
  await click(all('.dt-settings-link').find(link => link.textContent === zh['settingsGroup.display'])!)
  expect(text()).toContain(zh.notificationOverlaySetting)
  expect(text()).toContain(zh.notificationAutoDismissSetting)
  expect(text()).toContain(zh.taskHierarchySetting)
  expect(text()).toContain(zh.errorAggregateSetting)
  const toggle = find(zh.notificationAutoDismissSetting, '[role="switch"]')
  await click(toggle)
  expect(localStorage.getItem('dsh-superagent/notify-auto-dismiss')).toBe('off')
  await click(find(zh.errorAggregateSetting, '[role="switch"]'))
  expect(localStorage.getItem('ux.errorAggregate.v1')).toBe('off')
})