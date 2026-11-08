// @vitest-environment jsdom
// The approvals queue on the overview.
import { expect, it } from 'vitest'
import { en, zh } from '@superagent/dsh/client/locales.ts'
import { usePanel, mount, all, find, click, type } from './fixtures/panel.tsx'
import { approvalSummary, server } from './fixtures/panel-server.ts'

usePanel()
it('keeps the overview quiet while no Approval waits for a person', async () => {
  await mount()
  expect(document.querySelector('.dt-approval')).toBeNull()
  expect(all('.dt-section-title').map(title => title.textContent)[0]).toBe(`${zh.pendingTickets}2`)
})

it('leads with each pending Approval: the Action, its object, its revision, its consequence and one-click approve', async () => {
  server.approvals = [approvalSummary()]
  await mount()
  expect(all('.dt-section-title').map(title => title.textContent)[0]).toBe(`${zh.approvalsTitle}1`)
  const row = document.querySelector('.dt-approval')!
  expect(row.textContent).toContain('修复回归')
  expect(row.textContent).toContain('mail.reply')
  expect(row.textContent).toContain(zh['level.send'])
  expect(row.textContent).toContain(zh['levelEffect.send'])
  expect(row.textContent).toContain('om_reply_1')
  expect(row.textContent).toContain('rev-1')
  expect(row.textContent).toContain(zh.approvalExpires)
  expect(find(zh.approve).getAttribute('aria-label')).toContain('修复回归')
  await click(zh.approve)
  expect(server.requests).toContainEqual({ path: 'approvals/ap1/approve', method: 'POST', body: {} })
  expect(document.querySelector('.dt-approval')).toBeNull()
})

it('grants a lower level picked before approving, and shows that smaller consequence', async () => {
  server.approvals = [approvalSummary()]
  await mount()
  await type(document.querySelector<HTMLSelectElement>('.dt-approval-level')!, 'draft')
  expect(document.querySelector('.dt-approval')!.textContent).toContain(zh['levelEffect.draft'])
  expect(document.querySelector('.dt-approval')!.textContent).not.toContain(zh['levelEffect.send'])
  await click(zh.approve)
  expect(server.requests).toContainEqual({ path: 'approvals/ap1/approve', method: 'POST', body: { level: 'draft' } })
})

it('shows the money cost of a spend request', async () => {
  const spend = approvalSummary()
  server.approvals = [approvalSummary({ action: { ...spend.action, kind: 'calendar.invite', revision: 'rev-2', level: 'spend',
    cost: { kind: 'money', amount: 12, currency: 'USD' } }, levels: ['read', 'draft', 'commit', 'send', 'spend'] })]
  await mount()
  expect(document.querySelector('.dt-approval')!.textContent).toContain('USD 12')
})

it('hides the level selector when only the requested level is possible', async () => {
  const spend = approvalSummary()
  server.approvals = [approvalSummary({ action: { ...spend.action, level: 'read' }, levels: ['read'] })]
  await mount()
  expect(document.querySelector('.dt-approval-level')).toBeNull()
  await click(zh.approve)
  expect(server.requests).toContainEqual({ path: 'approvals/ap1/approve', method: 'POST', body: {} })
})

it('denies an Approval only after the confirmation, without granting anything', async () => {
  server.approvals = [approvalSummary()]
  await mount()
  await click(zh.deny)
  expect(server.requests).not.toContainEqual({ path: 'approvals/ap1/deny', method: 'POST' })
  expect(document.body.textContent).toContain(zh.denyConfirmTitle)
  await click(zh.confirm)
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