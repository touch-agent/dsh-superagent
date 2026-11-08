/**
 * T2-09: inject an abort or a restart at every durable interruptible point between queuing a message and its receipt
 * settling as `sent`, one hundred rounds, and prove the remote service received exactly one copy. A failure prints the
 * send Action's idempotency key, the remote journal and the delivery trace that led to the second copy.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { outboundAction, type ChannelRef, type OutboundSend } from '@superagent/kernel'
import type { Host } from './fixtures/host.ts'
import { startRuntime } from './fixtures/host.ts'
import type { SourceKind } from '@superagent/dsh/sources/kind.ts'

/** A durable point a process can stop at between `enqueue` and `sent`; `none` is the healthy delivery used after recovery. */
type CrashPoint = 'none' | 'queued' | 'before-write' | 'after-write' | 'after-settle'
const POINTS: readonly CrashPoint[] = ['queued', 'before-write', 'after-write', 'after-settle']
const ROUNDS = 100
/** What a remote service kept, and every call the Channel made, so a duplicate can be explained. */
interface Remote {
  writes: string[]
  events: { at: string; event: 'send' | 'probe'; id: string; point: CrashPoint; answer?: string }[]
}
const channel: ChannelRef = { source: 'chaos', thread: 'chaos:1', address: {} }
const text = { zh: '断电', en: 'Chaos' }

/**
 * A Channel whose remote keeps one entry per message and whose probe reads that journal back, so the test knows whether
 * the remote service really received a copy. `crash` names where this attempt stops; `before-write` aborts before the
 * journal write and `after-write` aborts after it, which is the dangerous case a careless retry would duplicate.
 */
function chaosKind(remote: Remote, crash: () => CrashPoint): SourceKind<Record<string, never>> {
  return {
    kind: 'chaos', title: text, description: text, health: [], schema: z.object({}).strict(), fields: [],
    channel: {
      send: async (_host, message) => {
        remote.events.push({ at: new Date().toISOString(), event: 'send', id: message.id, point: crash() })
        if (crash() === 'before-write') throw new Error('aborted before the remote write')
        remote.writes.push(message.id)
        if (crash() === 'after-write') throw new Error('aborted after the remote write')
        return 'sent'
      },
      probe: async (_host, message) => {
        const answer = remote.writes.includes(message.id) ? 'sent' as const : 'gone' as const
        remote.events.push({ at: new Date().toISOString(), event: 'probe', id: message.id, point: crash(), answer })
        return answer
      },
      link: () => ({ url: '', label: text }),
    },
  }
}
/** Queue one message under the given send Action; `id` is the receipt and effect key. */
function queue(h: Host, action: OutboundSend['action']): string {
  h.runtime.outbox.send({ action, channel, text: 'Ping' })
  return action.idempotencyKey
}
/** Advance `Date` past the failed effect's backoff and deliver whatever waits. */
async function recover(h: Host): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 300_000 })
  try { await h.runtime.sendReplies() } finally { vi.useRealTimers() }
}
/** How many `reply` effect rows wait for `id`; the crash points that failed one leave it for the restart to clear. */
const replyEffects = (h: Host, id: string): number =>
  Number(h.runtime.store.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind = 'reply' AND key = ?").get(id)?.n ?? 0)
/** How many receipts the round stored at all: a second key would be a second receipt, not a duplicate of `id`. */
const receipts = (h: Host): number => Number(h.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n ?? 0)
/** Everything needed to explain a duplicate: the key, every remote write, the receipt, the effect row, and the calls. */
function failure(round: number, point: CrashPoint, id: string, remote: Remote, h: Host): string {
  const receipt = h.runtime.store.receipts.get(id)
  const effects = h.runtime.store.db.prepare("SELECT kind, key, attempts, error, due FROM effect WHERE kind = 'reply' AND key = ?").all(id)
  return JSON.stringify({ round, point, id, writes: remote.writes, writesForId: remote.writes.filter(written => written === id).length,
    receipts: receipts(h), receipt, effects, events: remote.events }, null, 2)
}

describe('T2-09: a crash between enqueue and sent never sends twice', () => {
  it('keeps one remote copy across 100 abort/restart rounds', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const point = POINTS[round % POINTS.length]!
      const remote: Remote = { writes: [], events: [] }
      let current: CrashPoint = point
      let h = await startRuntime()
      h.runtime.sources.register(chaosKind(remote, () => current))
      const action = outboundAction({ kind: 'notice', source: channel.source, objectId: `chaos-${round}`, revision: 'rev-1' })
      const id = action.idempotencyKey
      try {
        queue(h, action)
        if (point === 'queued') {
          // The receipt and its effect are durable, but dispatch has not run yet. Assert the injected state before the
          // restart so a drained queue cannot make this round a healthy send that proves nothing.
          expect(h.runtime.store.receipts.get(id)?.status).toBe('pending')
          expect(replyEffects(h, id)).toBe(1)
          expect(remote.writes).toEqual([])
          await h.runtime.stop()
        } else {
          if (point === 'after-settle') {
            // Settle the receipt, then stop before the effect row is deleted: the next start replays it.
            const store = h.runtime.store.receipts
            const settle = store.settle
            let aborted = false
            store.settle = (message, outcome) => {
              settle(message, outcome)
              if (!aborted) { aborted = true; throw new Error('aborted after the receipt settled') }
            }
          }
          await h.runtime.sendReplies()
          const receipt = h.runtime.store.receipts.get(id)
          if (point === 'before-write') {
            expect([receipt?.status, receipt?.attemptedAt !== undefined, remote.writes.length, replyEffects(h, id)])
              .toEqual(['pending', true, 0, 1])
          } else if (point === 'after-write') {
            expect([receipt?.status, receipt?.attemptedAt !== undefined, remote.writes.length, replyEffects(h, id)])
              .toEqual(['pending', true, 1, 1])
          } else {
            // The receipt is sent, while its effect row survived the crash and is what the restart replays.
            expect([receipt?.status, remote.writes.length, replyEffects(h, id)]).toEqual(['sent', 1, 1])
          }
          current = 'none'
          await h.runtime.stop()
        }
        current = 'none'
        // A restarted process replays the client's enqueue; the same Action revision must not add work.
        h = await startRuntime(undefined, h.directory)
        h.runtime.sources.register(chaosKind(remote, () => current))
        queue(h, action)
        await recover(h)
        const receipt = h.runtime.store.receipts.get(id)
        // Count every write and every receipt, not only those under this id: a second derived key is the T2-05 failure.
        if (remote.writes.length !== 1 || remote.writes[0] !== id || receipts(h) !== 1
          || receipt?.status !== 'sent' || replyEffects(h, id) !== 0) {
          throw new Error(`chaos round ${round} at ${point} kept ${remote.writes.length} remote writes; ${failure(round, point, id, remote, h)}`)
        }
        expect(remote.writes).toEqual([id])
      } finally {
        await h.stop()
      }
    }
  }, 300_000)
})
