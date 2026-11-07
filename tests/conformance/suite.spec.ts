/**
 * Proves the conformance suite itself: a well-behaved fake Source passes, and each deliberate contract violation is
 * reported by the group that owns it. The idempotency case is the acceptance test for T1-06.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { key, type OutboundMessage, type SourceManifest, type Trigger } from '@superagent/kernel'
import type { Commands } from '@superagent/dsh/infra/commands.ts'
import type { SourceContext } from '@superagent/dsh/sources/host.ts'
import type { SourceAdapter } from '@superagent/dsh/sources/kind.ts'
import { checkConformance, type ConformanceSubject, type SendHost } from './suite.ts'

const text = (value: string) => ({ zh: value, en: value })
const manifest = (health: string[] = ['fake']): SourceManifest => ({
  id: 'fake', title: text('Fake'), description: text('A fake Source'), auth: { kind: 'none', fields: [] }, fields: [], health,
})
const trigger = (id: string): Trigger => ({ id, source: 'fake', threads: [{ source: 'fake', id: '1' }],
  actor: { source: 'fake', id: 'alice' }, human: true, at: '2026-11-07T10:00:00.000Z', text: 'hello',
  channel: { source: 'fake', thread: 'fake:1', address: {} }, meta: {} })
const message = (id: string, address: Record<string, string> = {}): OutboundMessage =>
  ({ id, channel: { source: 'fake', thread: 'fake:1', address }, text: 'Fixed', kind: 'reply' })
/** A fresh stub whose `calls` records what the Channel passed to the remote service. */
const host = (): SendHost => {
  const calls: string[] = []
  return { commands: { calls } as unknown as Commands, calls }
}
/** A Channel that answers without passing anything to the remote service, so the suite sees the missing key. */
const silent = async (_host: Pick<SourceContext, 'commands' | 'conversation'>, sent: OutboundMessage): Promise<'sent' | 'gone'> =>
  sent.channel.address.gone === 'true' ? 'gone' : 'sent'

/** A Source that obeys every contract, so a violation below is the one this test introduced. */
function adapter(overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  return {
    schema: z.object({}).strict(),
    scope: () => ({ listened: true, observed: false }),
    channel: {
      send: async (given, sent) => {
        ;(given.commands as unknown as { calls: string[] }).calls.push(sent.id)
        return sent.channel.address.gone === 'true' ? 'gone' : 'sent'
      },
      link: () => ({ url: '', label: text('Fake') }),
    },
    ...overrides,
  }
}
function subject(overrides: Partial<ConformanceSubject<Record<string, unknown>>> = {}): ConformanceSubject<Record<string, unknown>> {
  return {
    config: {},
    definition: { manifest: manifest(), adapter: adapter() },
    events: [
      { name: 'the first event', trigger: () => trigger(key('fake', '1')), replay: () => trigger(key('fake', '1')) },
      { name: 'the second event', trigger: () => trigger(key('fake', '2')), replay: () => trigger(key('fake', '2')) },
    ],
    scope: [{ name: 'anything', config: {}, meta: {}, expected: { listened: true, observed: false } }],
    sends: [
      { name: 'a new reply', message: message('reply-1'), outcome: 'sent', host },
      { name: 'a deleted target', message: message('reply-2', { gone: 'true' }), outcome: 'gone', host },
    ],
    cursor: { from: '2026-11-07T12:00:00.000Z', next: () => '2026-11-07T11:59:55.000Z' },
    probes: [{ name: 'a sent message', key: 'reply-1', answer: 'sent' }],
    probe: async () => 'sent',
    ...overrides,
  }
}

describe('the adapter conformance suite', () => {
  it('passes a fake Source that keeps every contract', async () => {
    expect(await checkConformance(subject())).toEqual([])
  })
  it('fails a Source whose idempotency key changes between two reads of one event', async () => {
    let reads = 0
    const violations = await checkConformance(subject({
      events: [{ name: 'an event read twice', trigger: () => trigger(`fake-${reads++}`), replay: () => trigger(`fake-${reads++}`) }],
    }))
    expect(violations).toEqual(expect.arrayContaining([expect.objectContaining({ group: 'triggers',
      detail: expect.stringContaining('idempotency key') })]))
    // A stable builder with the same shape passes, so the failure belongs to the changing id and not the fixture.
    expect(await checkConformance(subject())).toEqual([])
  })
  it('fails a Source that does not step its cursor back five seconds', async () => {
    const violations = await checkConformance(subject({ cursor: { from: '2026-11-07T12:00:00.000Z', next: () => '2026-11-07T12:00:00.000Z' } }))
    expect(violations).toEqual([expect.objectContaining({ group: 'cursor', detail: expect.stringContaining('five seconds') })])
  })
  it('fails a Source that returns an outbound answer without passing its idempotency key', async () => {
    const broken = adapter({ channel: { send: silent, link: () => ({ url: '', label: text('Fake') }) } })
    const violations = await checkConformance(subject({
      definition: { manifest: manifest(), adapter: broken },
      sends: [
        { name: 'a new reply', message: message('reply-1'), outcome: 'sent', host },
        { name: 'a deleted target', message: message('reply-2', { gone: 'true' }), outcome: 'gone', host },
      ],
    }))
    expect(violations).toEqual([expect.objectContaining({ group: 'send', detail: expect.stringContaining('idempotency key') })])
  })
  it('fails a Source whose scope disagrees with its fixture', async () => {
    const violations = await checkConformance(subject({
      scope: [{ name: 'a refused scope', config: {}, meta: {}, expected: { listened: false, reason: 'not_allowed' } }],
    }))
    expect(violations).toEqual([expect.objectContaining({ group: 'scope', detail: expect.stringContaining('expected') })])
  })
  it('fails a Source that declares a health name the runtime owns', async () => {
    const violations = await checkConformance(subject({ definition: { manifest: manifest(['runtime']), adapter: adapter() } }))
    expect(violations.some(item => item.group === 'health' && item.detail.includes('runtime'))).toBe(true)
  })
  it('fails a probe that answers outside sent, gone and unknown', async () => {
    const violations = await checkConformance(subject({ probe: async () => 'maybe' as never }))
    expect(violations.some(item => item.group === 'probe' && item.detail.includes('sent, gone or unknown'))).toBe(true)
  })
  it('fails a probe whose answer disagrees with its case', async () => {
    const violations = await checkConformance(subject({ probe: async () => 'gone' }))
    expect(violations).toEqual([expect.objectContaining({ group: 'probe', detail: expect.stringContaining('expected sent') })])
  })
})