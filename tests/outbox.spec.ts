/** Outbox delivery when processing is paused or a Source kind registers late, and the undo window before sending. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { UserError, type OutboundMessage } from '@superagent/kernel'
import { Commands } from '@superagent/dsh/infra/commands.ts'
import type { SourceKind } from '@superagent/dsh/sources/kind.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
async function at(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ms })
  try { await h.runtime.pump(); await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}
/** Set the Policy's undo window for the messages this test queues. */
function setWindow(seconds: number) {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, undoWindowSeconds: seconds } })
}
/** Run `body` with the clock at `base + ms`; only `Date` is faked so queued effects keep their durable due times. */
async function atFrom(base: number, ms: number, body: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ['Date'], now: base + ms })
  try { await body() } finally { vi.useRealTimers() }
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  h.runtime.outbox.send({ id: 'held', channel: feishu('1', 'x').channel!, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('held'), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status('held')).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  h.runtime.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Done', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('waiting'), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status('waiting'), sent.map(message => message.id)]).toEqual(['sent', ['waiting']])
})

it('holds a message through its undo window, recalls it inside the window, and never sends it', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  setWindow(30)
  const channel = feishu('1', 'x').channel!
  h.runtime.outbox.send({ id: 'undo', channel, text: '已合并。', kind: 'notice' })
  await h.runtime.sendReplies()
  const base = Date.now()
  expect([h.runtime.outbox.status('undo'), lark.mock.calls.length]).toEqual(['pending', 0])
  await atFrom(base, 29_000, async () => {
    expect(h.runtime.outbox.recall('undo')).toBe('recalled')
    // A repeated recall is idempotent.
    expect(h.runtime.outbox.recall('undo')).toBe('recalled')
  })
  expect([h.runtime.outbox.status('undo'), lark.mock.calls.length]).toEqual(['recalled', 0])
  // Its reply effect is gone, so even after the window it is not sent.
  await atFrom(base, 60_000, async () => { await h.runtime.sendReplies() })
  expect([h.runtime.outbox.status('undo'), lark.mock.calls.length]).toEqual(['recalled', 0])
  // A recalled ID is terminal: queueing it again keeps the receipt and sends nothing.
  h.runtime.outbox.send({ id: 'undo', channel, text: 'Again', kind: 'reply' })
  expect([h.runtime.outbox.status('undo'), h.runtime.effects.pending('reply', 'undo')]).toEqual(['recalled', false])
})

it('freezes the undo window when a message is queued', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  setWindow(30)
  const channel = feishu('4', 'x').channel!
  h.runtime.outbox.send({ id: 'frozen', channel, text: 'Done', kind: 'notice' })
  const receipt = h.runtime.store.receipts.get('frozen')!
  const dueAt = receipt.dueAt
  setWindow(0)
  await atFrom(Date.now(), 1_000, async () => { await h.runtime.sendReplies() })
  expect([h.runtime.outbox.status('frozen'), lark.mock.calls.length, receipt.windowMs]).toEqual(['pending', 0, 30_000])
  expect(h.runtime.store.receipts.get('frozen')!.dueAt).toBe(dueAt)
  // The receipt keeps the deadline it was queued with, so it is still recallable inside that window.
  await atFrom(Date.now(), 15_000, async () => { expect(h.runtime.outbox.recall('frozen')).toBe('recalled') })
})

it('retries a reply that failed after its window, and sends it once the retry succeeds', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear().mockRejectedValueOnce(new Error('network down'))
  setWindow(1)
  const channel = feishu('3', 'x').channel!
  h.runtime.outbox.send({ id: 'retry', channel, text: 'Done', kind: 'notice' })
  const base = Date.now()
  await atFrom(base, 2_000, async () => { await h.runtime.sendReplies() })
  expect([h.runtime.outbox.status('retry'), lark.mock.calls.length, h.runtime.effects.pending('reply', 'retry')])
    .toEqual(['pending', 1, true])
  // The failed attempt retries after 5 seconds, as before the window existed.
  await atFrom(base, 8_000, async () => { await h.runtime.sendReplies() })
  expect([h.runtime.outbox.status('retry'), lark.mock.calls.length]).toEqual(['sent', 2])
})

it('refuses to recall an unknown message, naming it as unknown', () => {
  let refused: unknown
  try { h.runtime.outbox.recall('never-queued') } catch (error) { refused = error }
  expect((refused as UserError).code).toBe('unknownReply')
})

it('refuses to recall a legacy pending receipt, which has no undo window', () => {
  h.runtime.store.receipts.add({ id: 'legacy', channel: feishu('8', 'x').channel!, text: 'Old', kind: 'reply' })
  let refused: unknown
  try { h.runtime.outbox.recall('legacy') } catch (error) { refused = error }
  expect((refused as UserError).code).toBe('undoUnavailable')
})

it('sends at the end of the undo window, refuses a late recall with its reason, and sends once', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  setWindow(30)
  const channel = feishu('2', 'x').channel!
  h.runtime.outbox.send({ id: 'late', channel, text: '已合并。', kind: 'notice' })
  const base = Date.now()
  await atFrom(base, 31_000, async () => {
    let refused: unknown
    try { h.runtime.outbox.recall('late') } catch (error) { refused = error }
    expect(refused).toBeInstanceOf(UserError)
    expect((refused as UserError).code).toBe('undoClosed')
    expect((refused as Error).message).toContain('undo window')
    await h.runtime.sendReplies()
  })
  expect([h.runtime.outbox.status('late'), lark.mock.calls.length]).toEqual(['sent', 1])
  // Once sent, a recall names the settled status instead of pretending it can undo the message.
  let settled: unknown
  try { h.runtime.outbox.recall('late') } catch (error) { settled = error }
  expect((settled as UserError).code).toBe('replySettled')
  expect((settled as Error).message).toContain('sent')
  // The same ID stays idempotent after sending, so it is not delivered twice.
  h.runtime.outbox.send({ id: 'late', channel, text: 'Duplicate', kind: 'reply' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status('late'), lark.mock.calls.length]).toEqual(['sent', 1])
})
