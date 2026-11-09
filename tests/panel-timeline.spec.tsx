// @vitest-environment jsdom
// The Ticket page's read-only audit timeline.
import { expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import { all, click, mount, text, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('shows the Ticket\'s audit timeline as who, on what basis and what changed, with no action in it', async () => {
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(all('.dt-section-title .dt-section-name').map(name => name.textContent)).toContain(zh.timelineTitle)
  expect(all('.dt-timeline-entry')).toHaveLength(6)
  expect(text()).toContain('Alice')
  expect(text()).toContain(zh['timelineKind.decision'])
  expect(text()).toContain(zh['approvalState.approved'])
  expect(text()).toContain('mail.reply')
  expect(text()).toContain('om_reply_1')
  expect(text()).toContain('rev-1')
  // The timeline is a reading surface: it offers no control that changes the Ticket.
  expect(all('.dt-timeline-entry .dt-btn, .dt-timeline-entry button')).toEqual([])
})

it('leaves the Ticket page usable when the timeline cannot be read', async () => {
  delete server.ticketTimelines.t1
  await mount()
  await click(all('.dt-open').find(button => button.textContent === '修复回归')!)
  expect(all('.dt-section-title .dt-section-name').map(name => name.textContent)).not.toContain(zh.timelineTitle)
  expect(text()).toContain(zh.mandateDetails)
})
