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

function assertNoInternalIds(allowed: string[] = []) {
  const copy = text()
  for (const leak of ['review-rev-1', 'worker-t1', 'ticket_', 'session_', 'assignmentId']) {
    if (!allowed.includes(leak)) expect(copy).not.toContain(leak)
  }
}

function group(label: string) { return all('p').find(node => node.textContent === label)?.parentElement }

it('uses the 021 section heading, one review name and a visible way in from the overview card', async () => {
  reviewTicket()
  await mount()
  // The section heading and filter split is 021 §5.1: 「需要你处理 N」 above, 「待我处理」 in the filter.
  expect(text()).toContain('需要你处理')
  expect(text()).not.toContain('需我处理')
  expect(text()).toContain('查看并确认')
  expect(text()).toContain('待你确认 · 审阅')
  for (const stale of ['待验收', '待审', '审查修订', 'artifact + revision']) expect(text()).not.toContain(stale)
  assertNoInternalIds()
})

it('keeps the card title as a second way into the same task', async () => {
  reviewTicket()
  await mount()
  await click('修复回归')
  expect(text()).toContain('验收预览')
})

it('uses 「待我处理」 for the task filter and 「需要你处理」 for the attention tag', async () => {
  reviewTicket()
  await mount()
  await click('任务')
  expect(text()).toContain('待我处理')
  expect(text()).toContain('需要你处理')
  expect(text()).not.toContain('需我处理')
})

it('labels the approval revision, states the effect, and separates rules from person confirmations', async () => {
  reviewTicket()
  await mount()
  await click('查看并确认')
  expect(text()).toContain('本次修订')
  expect(text()).toContain('批准只对上面的「本次修订」有效。')
  expect(text()).toContain('本任务与已接受的子任务交付按文件与修订去重；批准只对当前修订有效。')
  expect(text()).toContain('批准后：任务会结束，并出现在最近历史里。')
  expect(text()).toContain('规则（自动检查）')
  expect(text()).toContain('需要你确认')
  expect(text()).toContain('批准时一并确认这些事项，不需要另外回复。')
  expect(text()).toContain('PR 已合并')
  expect(text()).not.toContain('pr.merged')
  expect(text()).toContain('Check the tone')
  // The approval row is labelled; the old bare prefix beside the button is gone, even though the full id stays on E2.
  const labels = all('dt').map(node => node.textContent)
  const at = labels.indexOf('本次修订')
  expect(at).toBeGreaterThanOrEqual(0)
  expect(all('dd')[at]?.textContent).toBe('review-rev-1')
  expect(all('span').some(node => node.textContent === 'review-r')).toBe(false)
  expect(text()).toContain('rev-1')
  // The person confirmation sits under its own group, not among the automatic rules.
  expect(group('规则（自动检查）')?.textContent).toContain('PR 已合并')
  expect(group('规则（自动检查）')?.textContent).not.toContain('Check the tone')
  expect(group('需要你确认')?.textContent).toContain('Check the tone')
  assertNoInternalIds(['review-rev-1'])
})

it('says a pending close takes effect after approval, and wins over an open follow', async () => {
  reviewTicket()
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!, pendingEnd: { by: 'thread', outcome: 'merged',
    at: '2026-09-22T00:00:00Z' }, threads: [{ ...server.ticketDetails.t1!.threads[0]!, anchor: { own: true, follow: true } }] }
  await mount()
  await click('查看并确认')
  expect(text()).toContain('已记录的「PR 已合并」会生效')
  expect(text()).not.toContain('继续等待关联来源')
})

it('counts an open follow when the task opened none', async () => {
  reviewTicket()
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!,
    threads: [{ ...server.ticketDetails.t1!.threads[0]!, anchor: { own: false, follow: true } }] }
  await mount()
  await click('查看并确认')
  expect(text()).toContain('任务会继续等待关联来源结束；来源结束后任务才结束。')
})

it('ends once the only follows are closed', async () => {
  reviewTicket()
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!,
    threads: [{ ...server.ticketDetails.t1!.threads[0]!, anchor: { own: false, closed: { at: '2026-09-22T00:00:00Z', outcome: 'merged' } } }] }
  await mount()
  await click('查看并确认')
  expect(text()).toContain('批准后：任务会结束，并出现在最近历史里。')
})

it('does not treat a bound Channel as a follow', async () => {
  reviewTicket()
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!,
    threads: [{ ...server.ticketDetails.t1!.threads[0]!, anchor: { own: false } }] }
  await mount()
  await click('查看并确认')
  expect(text()).toContain('批准后：任务会结束，并出现在最近历史里。')
})

it('says an own open follow still has to end before the task can end', async () => {
  reviewTicket()
  server.ticketDetails.t1 = { ...server.ticketDetails.t1!,
    threads: [{ ...server.ticketDetails.t1!.threads[0]!, anchor: { own: true, follow: true } }] }
  await mount()
  await click('查看并确认')
  expect(text()).toContain('任务会继续等待关联来源结束；来源结束后任务才结束。')
})

it('keeps the same copy after approval and removes the action, the effect line and the binding hint', async () => {
  reviewTicket()
  await mount()
  await click('查看并确认')
  await click(zh.approve)
  expect(text()).toContain('已于')
  expect(all('button').some(button => button.textContent === zh.approve)).toBe(false)
  expect(text()).not.toContain('批准后：')
  expect(text()).not.toContain('批准只对上面的「本次修订」有效。')
  expect(text()).toContain('本次修订')
  assertNoInternalIds(['review-rev-1'])
})