// @vitest-environment jsdom
// The 2026-11-14 route: the plugin panel is the application shell, with the main-Agent card, four entries, a content area
// and the waiting-on-you summary. The host's own lists stay outside; the shell never claims a host capability.
import { afterEach, expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import { usePanel, mount, all, click } from './fixtures/panel.tsx'

usePanel()
afterEach(() => localStorage.clear())
/** Every shell-era switch on; the older specs pin the same four plus this one off. */
function shellDefaults() {
  for (const flag of ['ux.navFour.v1', 'ux.masterCard.v1', 'ux.noticeButton.v1', 'ux.filesPage.v1', 'ux.appShell.v1',
    'ux.opsInSettings.v1', 'ux.taskDetail.v2', 'ux.firstUse.v1']) localStorage.removeItem(flag)
}
const tabs = () => all('.dt-column > .dt-tabs [role="tab"], .dt-app-tabs [role="tab"]')
const card = () => document.querySelector<HTMLElement>('.dt-master-card')
const labels = () => all('button').map(item => item.textContent?.trim())

it('lands on the task page inside the full-width shell, with the card, four entries and the waiting summary', async () => {
  shellDefaults()
  await mount()
  expect(document.querySelector('.dt-app-shell')).not.toBeNull()
  expect(document.querySelector('.dt-column')).toBeNull()
  expect(document.querySelector('.dt-app-header')?.contains(card())).toBe(true)
  expect(tabs().map(item => item.textContent)).toEqual([zh['tab.tasks'], zh['tab.notifications'], zh['tab.files'],
    zh['tab.settings']])
  expect(document.querySelector('#dt-tab-tasks')?.getAttribute('aria-selected')).toBe('true')
  const summary = document.querySelector('.dt-attention')
  expect(summary).not.toBeNull()
  expect(summary!.textContent).toContain(zh.attentionTitle)
  expect(summary!.querySelectorAll('.dt-attention-row')).toHaveLength(2)
  expect(summary!.textContent).toContain('整理迁移说明')
  // The floating notice entry stays inside the page's own frame.
  expect(document.querySelector('.dt-notice-fab')).not.toBeNull()
})

it('keeps one main-Session action across entries and task detail', async () => {
  shellDefaults()
  await mount()
  expect(labels().filter(label => label === zh.masterOpen)).toHaveLength(1)
  expect(labels().filter(label => label === zh.openMaster)).toHaveLength(0)
  await click(zh['tab.notifications'])
  expect(card()).not.toBeNull()
  expect(labels().filter(label => label === zh.masterOpen)).toHaveLength(1)
  expect(labels().filter(label => label === zh.openMaster)).toHaveLength(0)
  await click(zh['tab.settings'])
  expect(card()).not.toBeNull()
  expect(labels().filter(label => label === zh.masterOpen)).toHaveLength(1)
  await click(zh['tab.tasks'])
  const row = all('.dt-tasks-row').find(item => item.textContent?.includes('修复回归（T2-03）'))
  expect(row).toBeTruthy()
  await click(row!)
  await click(zh.taskHierarchyOpen)
  expect(document.querySelector('.dt-task-detail')).not.toBeNull()
  expect(document.querySelector('.dt-app-shell')).not.toBeNull()
  expect(labels().filter(label => label === zh.masterOpen)).toHaveLength(1)
})

it('opens the waiting task from the summary and applies the existing waiting filter', async () => {
  shellDefaults()
  await mount()
  const first = all('.dt-attention-row').find(item => item.textContent?.includes('review PR #42'))
  expect(first).toBeTruthy()
  await click(first!)
  expect(document.querySelector('.dt-task-detail')).not.toBeNull()
  expect(document.querySelector('.dt-task-detail')?.textContent).toContain('review PR #42')
  // Back to the list, switch to a plan view, then the summary's action returns to the existing waiting filter.
  await click(zh.taskHierarchyBack)
  await click(zh['tasksView.tree'])
  await click(zh.attentionViewAll)
  expect(all('.dt-pill-active')[0]?.textContent).toContain(zh['activityFilter.attention'])
  expect(all('.dt-tasks-row')).toHaveLength(2)
  expect(document.querySelector('.dt-task-views [role="tab"][aria-selected="true"]')?.textContent).toBe(zh['tasksView.list'])
})

it('falls back to the batch-3 header layout when the shell switch is off, keeping four entries', async () => {
  shellDefaults()
  localStorage.setItem('ux.appShell.v1', 'off')
  await mount()
  expect(document.querySelector('.dt-app-shell')).toBeNull()
  expect(document.querySelector('.dt-column')).not.toBeNull()
  expect(tabs().map(item => item.textContent)).toEqual([zh['tab.tasks'], zh['tab.notifications'], zh['tab.files'],
    zh['tab.settings']])
  expect(card()).not.toBeNull()
  expect(labels().filter(label => label === zh.masterOpen)).toHaveLength(1)
  expect(labels().filter(label => label === zh.openMaster)).toHaveLength(0)
})

it('falls back to the three-entry layout when four-entry navigation is off', async () => {
  shellDefaults()
  localStorage.setItem('ux.navFour.v1', 'off')
  await mount()
  expect(document.querySelector('.dt-app-shell')).toBeNull()
  expect(document.querySelector('.dt-app-header')).toBeNull()
  expect(tabs()).toHaveLength(3)
  expect(document.querySelector('#dt-tab-tasks')).not.toBeNull()
})

it('keeps the header main-Session action when the card switch is off inside the shell', async () => {
  shellDefaults()
  localStorage.setItem('ux.masterCard.v1', 'off')
  await mount()
  expect(document.querySelector('.dt-app-shell')).not.toBeNull()
  expect(card()).toBeNull()
  expect(labels().filter(label => label === zh.openMaster)).toHaveLength(1)
  expect(labels().filter(label => label === zh.masterOpen)).toHaveLength(0)
})