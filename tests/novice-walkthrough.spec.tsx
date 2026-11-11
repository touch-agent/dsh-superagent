// @vitest-environment jsdom
// C4.5: a first-time person finds and approves the current delivery from the overview, without the task tree.
// The same fixture and path are described in docs/runbooks/novice-walkthrough.md; keep the two in step.
import { expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import { usePanel, mount, all, click, text } from './fixtures/panel.tsx'
import { server, ticketSummary } from './fixtures/panel-server.ts'

usePanel()

it('lets a first-time person approve the current delivery from the overview without opening the task tree', async () => {
  server.person = [ticketSummary({ id: 't1', title: '修复回归' }, { stage: 'person', action: 'review' as never })]
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, stage: 'person', action: 'review' as never, review: {
    canReview: true, reviewRevision: 'review-rev-1', deliverables: [{
      key: 'document:docs/review.md:rev-1', sources: [{ kind: 'ticket', ticketId: 't1', assignmentId: 'a1' }],
      at: '2026-09-22T00:00:00Z', artifact: { kind: 'document', ref: 'docs/review.md', revision: 'rev-1' },
      previewRef: { kind: 'text/redline', ref: 'https://example.test/preview/rev-1', revision: 'rev-1' },
      criteria: [{ kind: 'rule', rule: 'pr.merged' }],
      confirmations: [{ kind: 'human', reason: { code: 'said', values: { text: 'Check the tone' } } }] }],
    criteria: [{ kind: 'rule', rule: 'pr.merged' }],
    confirmations: [{ ref: 'confirmation-1', source: { kind: 'ticket', ticketId: 't1', assignmentId: 'a1' },
      criterion: { kind: 'human', reason: { code: 'said', values: { text: 'Check the tone' } } } }], summary: 'Ready for review' } }

  await mount()
  // The overview names the person's next action and the delivery; the title is the way in.
  expect(text()).toContain(zh.entryNeeds)
  expect(text()).toContain(zh['stage.review'])
  const card = all('.dt-open').find(element => element.textContent === '修复回归')
  expect(card).toBeDefined()
  await click(card!)

  // The ticket page shows the aggregate and its one bound approval; no task tree was opened.
  expect(text()).toContain(zh.reviewSection)
  expect(text()).toContain('https://example.test/preview/rev-1')
  expect(text()).toContain(zh['acceptanceRule.pr.merged'])
  expect(text()).toContain('Check the tone')
  await click(zh.approve)

  expect(server.requests).toContainEqual({ path: 'tickets/t1/approve', method: 'POST', body: { reviewRevision: 'review-rev-1' } })
  expect(text()).toContain('已于')
  expect(all('button').some(button => button.textContent === zh.approve)).toBe(false)
})