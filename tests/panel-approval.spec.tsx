// @vitest-environment jsdom
// The approvals queue on the overview.
import { expect, it } from 'vitest'
import { en, zh } from '@superagent/dsh/client/locales.ts'
import { usePanel, mount, all, find, click, type, field } from './fixtures/panel.tsx'
import { approvalSummary, server } from './fixtures/panel-server.ts'

usePanel()
it('keeps the overview quiet while no Approval waits for a person', async () => {
  await mount()
  expect(document.querySelector('.dt-approval')).toBeNull()
  expect(all('.dt-section-title').map(title => title.textContent)[0]).toBe(`${zh.pendingTickets}2`)
})

it('leads with each pending Approval: the Action, its object, its consequence and one-click approve or deny', async () => {
  server.approvals = [approvalSummary()]
  await mount()
  expect(all('.dt-section-title').map(title => title.textContent)[0]).toBe(`${zh.approvalsTitle}1`)
  const row = document.querySelector('.dt-approval')!
  expect(row.textContent).toContain('修复回归')
  expect(row.textContent).toContain('mail.reply')
  expect(row.textContent).toContain(zh['level.send'])
  expect(row.textContent).toContain(zh['levelEffect.send'])
  expect(row.textContent).toContain('om_reply_1')
  expect(row.textContent).toContain(zh.approvalExpires)
  await click(zh.approve)
  expect(server.requests).toContainEqual({ path: 'approvals/ap1/approve', method: 'POST', body: {} })
  expect(document.querySelector('.dt-approval')).toBeNull()
})

it('grants a lower level picked before approving', async () => {
  server.approvals = [approvalSummary()]
  await mount()
  await type(field<HTMLSelectElement>(zh.approvalLevel), 'draft')
  await click(zh.approve)
  expect(server.requests).toContainEqual({ path: 'approvals/ap1/approve', method: 'POST', body: { level: 'draft' } })
})

it('denies an Approval without granting anything', async () => {
  server.approvals = [approvalSummary()]
  await mount()
  await click(zh.deny)
  expect(server.requests).toContainEqual({ path: 'approvals/ap1/deny', method: 'POST' })
  expect(document.querySelector('.dt-approval')).toBeNull()
})

it('shows the approval queue and its latency figure in English', async () => {
  server.approvals = [approvalSummary()]
  await mount(en)
  expect(all('.dt-section-title').map(title => title.textContent)[0]).toBe(`${en.approvalsTitle}1`)
  expect(textOf(find(en.approve))).toBe(en.approve)
  expect(all('.dt-stat-label').map(label => label.textContent)).toContain(en.metricApprovalLabel)
})

/** The text of one control, as the row renders it. */
function textOf(element: HTMLElement): string { return element.textContent?.trim() ?? '' }