// @vitest-environment jsdom
// UX batch 3: the main-Agent card, the four-entry navigation, the floating notice entry and Files.
import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import { usePanel, mount, remount, all, click, field, text, type } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => localStorage.clear())
/** The batch-3 defaults: nav four, card, floating entry and Files are on; the earlier specs pin them off. */
function newDefaults() {
  for (const flag of ['ux.navFour.v1', 'ux.masterCard.v1', 'ux.noticeButton.v1', 'ux.filesPage.v1',
    'ux.opsInSettings.v1', 'ux.taskDetail.v2', 'ux.firstUse.v1']) localStorage.removeItem(flag)
}
const navTabs = () => all('.dt-column > .dt-tabs [role="tab"]').map(item => item.textContent)
const card = () => document.querySelector<HTMLElement>('.dt-master-card')
const fab = () => document.querySelector<HTMLButtonElement>('.dt-notice-fab')
const drawer = () => document.querySelector<HTMLElement>('.dt-drawer')

it('opens on the task view with the main-Agent card and exactly four first-level entries', async () => {
  newDefaults()
  await mount()
  expect(navTabs()).toEqual([zh['tab.tasks'], zh['tab.notifications'], zh['tab.files'], zh['tab.settings']])
  expect(card()).not.toBeNull()
  expect(card()!.textContent).toContain(zh.masterDefaultName)
  expect(card()!.textContent).toContain(zh.masterRole)
  // The task view is the default page, not the pre-batch Overview.
  expect(document.querySelector('#dt-tab-tasks')?.getAttribute('aria-selected')).toBe('true')
})

it('offers one main-Session action on the task page, and the header action elsewhere', async () => {
  newDefaults()
  await mount()
  const labels = () => all('button').map(item => item.textContent?.trim())
  // The card's entrance replaces the header shortcut while the card is on screen; two buttons would be one action twice.
  expect(labels().filter(label => label === zh.masterOpen)).toHaveLength(1)
  expect(labels().filter(label => label === zh.openMaster)).toHaveLength(0)
  await click(zh['tab.notifications'])
  expect(card()).toBeNull()
  expect(labels().filter(label => label === zh.openMaster)).toHaveLength(1)
})

it('renames the main Agent and keeps the name across a remount', async () => {
  newDefaults()
  await mount()
  await click(zh.masterRename)
  await type(field<HTMLInputElement>(zh.masterNameLabel), '  阿助  ')
  await click(zh.masterSave)
  expect(card()!.textContent).toContain('阿助')
  expect(JSON.parse(localStorage.getItem('dsh-superagent/master-identity')!).name).toBe('阿助')
  await remount()
  expect(card()!.textContent).toContain('阿助')
})

it('changes the avatar to a preset and keeps it across a remount', async () => {
  newDefaults()
  await mount()
  await click(zh.masterAvatar)
  await click(zh['masterAvatarPreset.sunset'])
  expect(JSON.parse(localStorage.getItem('dsh-superagent/master-identity')!).avatar).toBe('preset:sunset')
  expect(card()!.querySelector('.dt-avatar-sunset')).not.toBeNull()
  await remount()
  expect(card()!.querySelector('.dt-avatar-sunset')).not.toBeNull()
})

it('opens the existing main Session from the card instead of creating one', async () => {
  newDefaults()
  await mount()
  await click(zh.masterOpen)
  expect(server.opened).toEqual(['master'])
})

it('falls back to the task view without the card but leaves the rest of the navigation intact', async () => {
  newDefaults()
  localStorage.setItem('ux.masterCard.v1', 'off')
  await mount()
  expect(card()).toBeNull()
  expect(navTabs()).toHaveLength(4)
})

it('shows the floating notice count and latest summary, opens the drawer and closes it from the keyboard', async () => {
  newDefaults()
  await mount()
  expect(fab()).not.toBeNull()
  expect(fab()!.textContent).toContain(zh.noticeFabPending.replace('{count}', '2'))
  expect(fab()!.getAttribute('data-unread')).toBe('true')
  // The tab order reaches a real button; focus is visible through the normal focus state.
  const trigger = fab()!
  trigger.focus()
  expect(document.activeElement).toBe(trigger)
  await click(trigger)
  expect(drawer()).not.toBeNull()
  // The hidden floating entry leaves the tab order while the drawer owns the corner.
  expect(fab()!.getAttribute('tabindex')).toBe('-1')
  const close = drawer()!.querySelector<HTMLElement>('.dt-drawer-head button')!
  expect(close.getAttribute('aria-label')).toBe(zh.close)
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(document.querySelector('.dt-drawer')).toBeNull()
  // Closing returns focus to the control that opened the drawer, not to the page body.
  expect(document.activeElement).toBe(trigger)
  expect(fab()!.getAttribute('tabindex')).toBeNull()
})

it('keeps the floating entry quiet after everything is read and falls back to the header bell when switched off', async () => {
  newDefaults()
  await mount()
  await click(zh['tab.notifications'])
  await click(zh.noticeMarkAllRead)
  expect(fab()?.getAttribute('data-unread')).toBeNull()
  expect(fab()!.getAttribute('aria-label')).toBe(zh.noticeFabQuiet)

  localStorage.setItem('ux.noticeButton.v1', 'off')
  await remount()
  expect(fab()).toBeNull()
  expect(document.querySelector('.dt-bell')).not.toBeNull()
})

it('lists task deliverables on the Files page and keeps the entry optional', async () => {
  newDefaults()
  server.tasks.tasks[0]!.deliverables = [{ key: 'file:docs/migration.md:r1', sources: [],
    at: '2026-09-23T02:00:00Z', summary: '迁移说明已补', artifact: { kind: 'file', ref: 'https://example.test/migration.md', revision: 'r1' },
    previewRef: { kind: 'text/diff', ref: 'https://example.test/migration.md', revision: 'r1' }, criteria: [], confirmations: [] }]
  await mount()
  await click(zh['tab.files'])
  expect(text()).toContain(zh.filesCount.replace('{count}', '1'))
  expect(text()).toContain('迁移说明已补')
  expect(text()).toContain('修复回归（T2-03）')
  expect(document.querySelector('.dt-files-list a')?.getAttribute('href')).toBe('https://example.test/migration.md')

  localStorage.setItem('ux.filesPage.v1', 'off')
  await remount()
  expect(navTabs()).toEqual([zh['tab.tasks'], zh['tab.notifications'], zh['tab.settings']])
})

it('restores Overview, Tasks and Settings when the four-entry navigation is switched off', async () => {
  newDefaults()
  for (const flag of ['ux.navFour.v1', 'ux.masterCard.v1', 'ux.noticeButton.v1', 'ux.filesPage.v1']) localStorage.setItem(flag, 'off')
  await mount()
  expect(navTabs()).toEqual([zh['tab.overview'], zh['tab.tasks'], zh['tab.settings']])
  expect(card()).toBeNull()
  expect(document.querySelector('.dt-bell')).not.toBeNull()
})
