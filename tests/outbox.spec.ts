/** Outbox delivery when processing is paused or a Source kind registers late, and the undo window before sending. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { outboundAction, UserError, type ChannelRef, type OutboundKind, type OutboundMessage } from '@superagent/kernel'
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
/** Queue a message under a send Action: `revision` is what distinguishes two writes of one object. */
function send(kind: OutboundKind, channel: ChannelRef, objectId: string, options: { revision?: string; text?: string; ticketId?: string } = {}) {
  const action = outboundAction({ kind, source: channel.source, objectId, revision: options.revision ?? 'rev-1' })
  h.runtime.outbox.send({ action, channel, text: options.text ?? 'Done', ...options.ticketId ? { ticketId: options.ticketId } : {} })
  return action
}

it('holds every message while processing is paused, and sends it once processing resumes', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  await h.runtime.settings.pause(true, 'panel')
  lark.mockClear()
  const action = send('notice', feishu('1', 'x').channel!, 'held', { text: '已合并。' })
  const id = action.idempotencyKey
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status(id), lark.mock.calls.length]).toEqual(['pending', 0])
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect(h.runtime.outbox.status(id)).toBe('sent')
  expect(JSON.stringify(lark.mock.calls)).toContain('已合并。')
})

it('keeps a message for a Source that is not installed waiting, and sends it once the Source\'s kind registers', async () => {
  const sent: OutboundMessage[] = []
  const probe: SourceKind<Record<string, never>> = { kind: 'probe', title: { zh: '探针', en: 'Probe' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { zh: '探针', en: 'Probe' } }) } }
  const action = send('reply', { source: 'probe', thread: 'probe:1', address: {} }, 'waiting')
  const id = action.idempotencyKey
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status(id), h.runtime.health.reply?.state]).toEqual(['pending', 'ready'])
  h.runtime.sources.register(probe)
  // A message whose Source was not installed is tried again after 5 seconds.
  await at(5000)
  expect([h.runtime.outbox.status(id), sent.map(message => message.id)]).toEqual(['sent', [id]])
})

it('holds a message through its undo window, recalls it inside the window, and never sends it', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  setWindow(30)
  const channel = feishu('1', 'x').channel!
  const action = send('notice', channel, 'undo', { text: '已合并。' })
  const id = action.idempotencyKey
  await h.runtime.sendReplies()
  const base = Date.now()
  expect([h.runtime.outbox.status(id), lark.mock.calls.length]).toEqual(['pending', 0])
  await atFrom(base, 29_000, async () => {
    expect(h.runtime.outbox.recall(id)).toBe('recalled')
    // A repeated recall is idempotent.
    expect(h.runtime.outbox.recall(id)).toBe('recalled')
  })
  expect([h.runtime.outbox.status(id), lark.mock.calls.length]).toEqual(['recalled', 0])
  // Its reply effect is gone, so even after the window it is not sent.
  await atFrom(base, 60_000, async () => { await h.runtime.sendReplies() })
  expect([h.runtime.outbox.status(id), lark.mock.calls.length]).toEqual(['recalled', 0])
  // A recalled ID is terminal: queueing it again keeps the receipt and sends nothing.
  send('reply', channel, 'undo', { text: 'Again' })
  expect([h.runtime.outbox.status(id), h.runtime.effects.pending('reply', id)]).toEqual(['recalled', false])
})

it('freezes the undo window when a message is queued', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  setWindow(30)
  const channel = feishu('4', 'x').channel!
  const action = send('notice', channel, 'frozen')
  const id = action.idempotencyKey
  const receipt = h.runtime.store.receipts.get(id)!
  const dueAt = receipt.dueAt
  setWindow(0)
  await atFrom(Date.now(), 1_000, async () => { await h.runtime.sendReplies() })
  expect([h.runtime.outbox.status(id), lark.mock.calls.length, receipt.windowMs]).toEqual(['pending', 0, 30_000])
  expect(h.runtime.store.receipts.get(id)!.dueAt).toBe(dueAt)
  // The receipt keeps the deadline it was queued with, so it is still recallable inside that window.
  await atFrom(Date.now(), 15_000, async () => { expect(h.runtime.outbox.recall(id)).toBe('recalled') })
})

it('retries a reply that failed after its window, once a probe shows it is not there', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  let replies = 0
  lark.mockClear().mockImplementation(async (args: string[]) => {
    // The retry first asks the topic whether the failed reply arrived; it did not, so sending it again is safe.
    if (args[1] === '+threads-messages-list') return { messages: [], has_more: false }
    replies += 1
    if (replies === 1) throw new Error('network down')
    return {}
  })
  setWindow(1)
  const channel = feishu('3', 'x').channel!
  const action = send('notice', channel, 'retry')
  const id = action.idempotencyKey
  const base = Date.now()
  await atFrom(base, 2_000, async () => { await h.runtime.sendReplies() })
  expect([h.runtime.outbox.status(id), replies, h.runtime.effects.pending('reply', id)])
    .toEqual(['pending', 1, true])
  // The failed attempt retries after 5 seconds, as before the window existed.
  await atFrom(base, 8_000, async () => { await h.runtime.sendReplies() })
  expect([h.runtime.outbox.status(id), replies]).toEqual(['sent', 2])
})

it('refuses to recall an unknown message, naming it as unknown', () => {
  let refused: unknown
  try { h.runtime.outbox.recall('never-queued') } catch (error) { refused = error }
  expect((refused as UserError).code).toBe('unknownReply')
})

it('refuses to recall a legacy pending receipt, which has no undo window', () => {
  // A receipt from before send Actions carried the key kept only its id; it is inserted in its stored shape.
  h.runtime.store.db.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)').run('legacy',
    JSON.stringify({ id: 'legacy', channel: feishu('8', 'x').channel!, text: 'Old', kind: 'reply', status: 'pending' }))
  let refused: unknown
  try { h.runtime.outbox.recall('legacy') } catch (error) { refused = error }
  expect((refused as UserError).code).toBe('undoUnavailable')
})

it('sends at the end of the undo window, refuses a late recall with its reason, and sends once', async () => {
  const lark = vi.mocked(Commands.prototype.lark)
  lark.mockClear()
  setWindow(30)
  const channel = feishu('2', 'x').channel!
  const action = send('notice', channel, 'late', { text: '已合并。' })
  const id = action.idempotencyKey
  const base = Date.now()
  await atFrom(base, 31_000, async () => {
    let refused: unknown
    try { h.runtime.outbox.recall(id) } catch (error) { refused = error }
    expect(refused).toBeInstanceOf(UserError)
    expect((refused as UserError).code).toBe('undoClosed')
    expect((refused as Error).message).toContain('undo window')
    await h.runtime.sendReplies()
  })
  expect([h.runtime.outbox.status(id), lark.mock.calls.length]).toEqual(['sent', 1])
  // Once sent, a recall names the settled status instead of pretending it can undo the message.
  let settled: unknown
  try { h.runtime.outbox.recall(id) } catch (error) { settled = error }
  expect((settled as UserError).code).toBe('replySettled')
  expect((settled as Error).message).toContain('sent')
  // The same send Action revision stays idempotent after sending, so its ID is not delivered twice.
  send('reply', channel, 'late', { text: 'Duplicate' })
  await h.runtime.sendReplies()
  expect([h.runtime.outbox.status(id), lark.mock.calls.length]).toEqual(['sent', 1])
})

it('keys each effect by the send Action, so two revisions are two effects and a repeated revision is one', () => {
  const channel = feishu('5', 'x').channel!
  const first = send('notice', channel, 'om_1', { revision: 'rev-1', text: 'first' })
  const second = send('notice', channel, 'om_1', { revision: 'rev-2', text: 'second' })
  // A replay of the first revision keeps its first message and adds no effect.
  send('notice', channel, 'om_1', { revision: 'rev-1', text: 'first again' })
  const rows = h.runtime.store.db.prepare("SELECT key FROM effect WHERE kind = 'reply' ORDER BY seq").all().map(row => String(row.key))
  expect(rows).toEqual([first.idempotencyKey, second.idempotencyKey])
  expect(h.runtime.store.receipts.get(first.idempotencyKey)?.text).toBe('first')
  // A receipt still carries the adapter-facing kind, taken from its send Action.
  expect(h.runtime.store.receipts.get(first.idempotencyKey)?.kind).toBe('notice')
  expect([h.runtime.outbox.status(first.idempotencyKey), h.runtime.outbox.status(second.idempotencyKey)]).toEqual(['pending', 'pending'])
})
/** A Source whose Channel answers probes and sends on demand, to test what the Outbox does after a failed attempt. */
function checkKind(probe: (id: string) => Promise<'sent' | 'gone' | 'unknown'>, send: (id: string) => Promise<'sent' | 'gone'>): SourceKind<Record<string, never>> {
  return { kind: 'check', title: { zh: '检查', en: 'Check' }, description: { zh: '', en: '' }, health: [],
    schema: z.object({}).strict(), fields: [],
    channel: { probe: async (_host, message) => probe(message.id), send: async (_host, message) => send(message.id),
      link: () => ({ url: '', label: { zh: '检查', en: 'Check' } }) } }
}

it('probes after a failed attempt and settles a message it already sent without sending twice', async () => {
  const sends: string[] = [], probes: string[] = []
  h.runtime.sources.register(checkKind(async id => { probes.push(id); return 'sent' },
    async id => { sends.push(id); throw new Error('network down') }))
  const action = send('notice', { source: 'check', thread: 'check:1', address: {} }, 'already-sent')
  const id = action.idempotencyKey
  await h.runtime.sendReplies()
  expect(sends).toEqual([id])
  // The retry asks first: the Source has the message, so it settles `sent` and is not written again.
  await at(5000)
  expect([h.runtime.outbox.status(id), sends.length, probes]).toEqual(['sent', 1, [id]])
})

it('keeps a message pending without resending it while a probe is unknown, then sends it once the probe says it is gone', async () => {
  const sends: string[] = [], probes: string[] = []
  let answer: 'unknown' | 'gone' = 'unknown'
  h.runtime.sources.register(checkKind(async id => { probes.push(id); return answer },
    async id => { sends.push(id); if (sends.length === 1) throw new Error('timeout'); return 'sent' }))
  const action = send('notice', { source: 'check', thread: 'check:1', address: {} }, 'unverifiable')
  const id = action.idempotencyKey
  await h.runtime.sendReplies()
  // An unknown probe is the conservative branch: the message is never resent while delivery cannot be ruled out.
  await at(5000)
  expect([h.runtime.outbox.status(id), sends.length, h.runtime.effects.pending('reply', id)]).toEqual(['pending', 1, true])
  // A later probe that proves the message is gone makes the send safe again.
  answer = 'gone'
  await at(20_000)
  expect([h.runtime.outbox.status(id), sends.length, probes.length]).toEqual(['sent', 2, 2])
})

it('probes a pending receipt left by a stopped process before sending it, so a restart delivers once', async () => {
  const sends: string[] = []
  h.runtime.sources.register(checkKind(async () => 'sent', async id => { sends.push(id); return 'sent' }))
  setWindow(0)
  const action = send('notice', { source: 'check', thread: 'check:1', address: {} }, 'restarted', { text: 'Restarted' })
  const id = action.idempotencyKey
  // The process recorded the attempt but stopped before its outcome; on restart the probe answers what happened.
  h.runtime.store.receipts.attempt(id, new Date().toISOString())
  await h.runtime.pump(); await h.runtime.sendReplies()
  expect([h.runtime.outbox.status(id), sends]).toEqual(['sent', []])
})

it('does not resend when the probe itself cannot be read', async () => {
  const sends: string[] = []
  h.runtime.sources.register(checkKind(async () => { throw new Error('permission denied') },
    async id => { sends.push(id); throw new Error('network down') }))
  const action = send('notice', { source: 'check', thread: 'check:1', address: {} }, 'unreadable')
  const id = action.idempotencyKey
  await h.runtime.sendReplies()
  await at(5000)
  expect([h.runtime.outbox.status(id), sends.length, h.runtime.effects.pending('reply', id)]).toEqual(['pending', 1, true])
})
