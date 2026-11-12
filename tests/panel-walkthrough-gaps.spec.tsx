// @vitest-environment jsdom
// G1–G6 from docs/runbooks/novice-walkthrough.md: the default surfaces keep one human name for the review state, name
// the revision and the effect of approval, group rules apart from person confirmations, and stay free of internal ids.
import { expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import { all, click, mount, text, usePanel } from './fixtures/panel.tsx'
import { server, ticketSummary } from './fixtures/panel-server.ts'

usePanel()

const review = {
  canReview: true, reviewRevision: 'review-rev-1', deliverables: [{
    key: 'document:docs/review.md:rev-1', sources: [{ kind: 'ticket' as const, ticketId: 't1', assignmentId: 'a1' }],
    at: '2026-09-22T00:00:00Z', artifact: { kind: 'document' as const, ref: 'docs/review.md', revision: 'rev-1' },
    previewRef: { kind: 'text/redline' as const, ref: 'https://example.test/preview/rev-1', revision: 'rev-1' },
    criteria: [{ kind: 'rule' as const, rule: 'pr.merged' as const }],
    confirmations: [{ kind: 'human' as const, reason: { code: 'said' as const, values: { text: 'Check the tone' } } }] }],
  criteria: [{ kind: 'rule' as const, rule: 'pr.merged' as const }],
  confirmations: [{ ref: 'confirmation-1', source: { kind: 'ticket' as const, ticketId: 't1', assignmentId: 'a1' },
    criterion: { kind: 'human' as const, reason: { code: 'said' as const, values: { text: 'Check the tone' } } } }],
  summary: 'Ready for review' }

function reviewTicket() {
  server.person = [ticketSummary({ id: 't1', title: '修复回归' }, { stage: 'person', action: 'review' as never })]
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, stage: 'person', action: 'review' as never, review }
}

function assertNoInternalIds() {
  const copy = text()
  for (const leak of ['review-rev-1', 'worker-t1', 'ticket_', 'session_', 'assignmentId']) expect(copy).not.toContain(leak)
}

it('names the review state once and offers a visible way in from the overview card', async () => {
  reviewTicket()
  await mount()
  expect(text()).toContain(zh.ticketOpenReview)
  expect(text()).toContain(zh['stage.review'])
  for (const stale of ['待验收', '待审', '需我处理', '审查修订', 'artifact + revision']) expect(text()).not.toContain(stale)
  assertNoInternalIds()
})

it('labels the bound revision, states the effect of approval, and separates rules from person confirmations', async () => {
  reviewTicket()
  await mount()
  await click(zh.ticketOpenReview)
  expect(text()).toContain(zh.reviewRuleGroup)
  expect(text()).toContain(zh.reviewHumanGroup)
  expect(text()).toContain(zh.reviewHumanCovers)
  expect(text()).toContain(zh.reviewEffectEnd)
  expect(text()).toContain(zh.reviewBindingHint)
  expect(text()).toContain(zh['acceptanceRule.pr.merged'])
  expect(text()).not.toContain('pr.merged')
  expect(text()).toContain('Check the tone')
  // The unlabelled prefix of the approval binding used to sit beside the button; the key-value row keeps the revision.
  expect(text()).not.toContain('review-r')
  expect(text()).toContain('rev-1')
  assertNoInternalIds()
})

it('says a pending close takes effect after approval, instead of promising that the task ends immediately', async () => {
  reviewTicket()
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, pendingEnd: { by: 'thread', outcome: 'merged',
    at: '2026-09-22T00:00:00Z' } }
  await mount()
  await click(zh.ticketOpenReview)
  expect(text()).toContain('已发生的PR 已合并会生效')
})

it('says an open follow still has to end before the task can end', async () => {
  reviewTicket()
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!,
    threads: [{ ...server.ticketDetails.t1!.threads[0]!, anchor: { own: true } }] }
  await mount()
  await click(zh.ticketOpenReview)
  expect(text()).toContain(zh.reviewEffectFollows)
})

it('keeps the same copy after approval and removes the action, the effect line and the binding hint', async () => {
  reviewTicket()
  await mount()
  await click(zh.ticketOpenReview)
  await click(zh.approve)
  expect(text()).toContain('已于')
  expect(all('button').some(button => button.textContent === zh.approve)).toBe(false)
  expect(text()).not.toContain(zh.reviewEffectEnd)
  expect(text()).not.toContain(zh.reviewBindingHint)
  assertNoInternalIds()
})