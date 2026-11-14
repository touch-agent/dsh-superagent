// @vitest-environment jsdom
// The 2026-11-14 route after the correction: selecting Superagent opens the host's main Conversation. Tasks, notices,
// files and settings move into its header and each auxiliary page keeps a way back. The host shell is never replaced.
import { afterEach, expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import { markPanelPage } from '@superagent/dsh/client/panel.ts'
import { usePanel, mount, all, click } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => localStorage.clear())
/** Every relevant switch on; the older specs pin the same flags off. */
function defaults() {
  for (const flag of ['ux.navFour.v1', 'ux.masterCard.v1', 'ux.noticeButton.v1', 'ux.filesPage.v1', 'ux.appShell.v1',
    'ux.opsInSettings.v1', 'ux.taskDetail.v2', 'ux.firstUse.v1']) localStorage.removeItem(flag)
}
const tabs = () => all('.dt-column > .dt-tabs [role="tab"]')
const card = () => document.querySelector<HTMLElement>('.dt-master-card')

it('opens the main Conversation as the plugin home and offers the four destinations', async () => {
  defaults()
  await mount()
  expect(document.querySelector('.dt-conversation-home')).not.toBeNull()
  expect(document.querySelector('.dt-column')).toBeNull()
  expect(document.querySelector('.dt-conversation-home')?.textContent).toContain(zh.conversationHomeTitle)
  expect(server.opened).toEqual(['master'])
  const browse = all('.dt-conversation-home-browse button').map(item => item.textContent?.trim())
  expect(browse).toEqual([zh['tab.tasks'], zh['tab.notifications'], zh['tab.files'], zh['tab.settings']])
})

it('renders the four-entry page with a back action when an auxiliary destination is open', async () => {
  defaults()
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  markPanelPage()
  await mount()
  expect(document.querySelector('.dt-conversation-home')).toBeNull()
  expect(document.querySelector('.dt-column')).not.toBeNull()
  expect(tabs().map(item => item.textContent)).toEqual([zh['tab.tasks'], zh['tab.notifications'], zh['tab.files'],
    zh['tab.settings']])
  expect(document.querySelector('#dt-tab-tasks')?.getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-conversation-bar')?.textContent).toContain(zh.backToConversation)
  await click(zh.backToConversation)
  expect(server.opened).toEqual(['master'])
})

it('keeps the task page in its two-column layout when opened from the conversation header', async () => {
  defaults()
  sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route: { page: 'tasks' }, stack: [] }))
  markPanelPage()
  await mount()
  expect(document.querySelector('.dt-tasks-layout')).not.toBeNull()
  expect(document.querySelector('.dt-attention')).not.toBeNull()
  expect(document.querySelector('.dt-conversation-bar')).not.toBeNull()
})

it('falls back to the batch-3 header layout when the conversation-home switch is off', async () => {
  defaults()
  localStorage.setItem('ux.appShell.v1', 'off')
  await mount()
  expect(document.querySelector('.dt-conversation-home')).toBeNull()
  expect(document.querySelector('.dt-column')).not.toBeNull()
  expect(document.querySelector('.dt-conversation-bar')).toBeNull()
  expect(tabs().map(item => item.textContent)).toEqual([zh['tab.tasks'], zh['tab.notifications'], zh['tab.files'],
    zh['tab.settings']])
  expect(card()).not.toBeNull()
})

it('falls back to the three-entry layout when four-entry navigation is off', async () => {
  defaults()
  localStorage.setItem('ux.navFour.v1', 'off')
  await mount()
  expect(document.querySelector('.dt-conversation-home')).toBeNull()
  expect(tabs()).toHaveLength(3)
  expect(document.querySelector('#dt-tab-tasks')).not.toBeNull()
})
