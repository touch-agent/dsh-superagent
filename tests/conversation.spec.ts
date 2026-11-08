import { describe, expect, it, vi } from 'vitest'
import type { Commands } from '@superagent/dsh/infra/commands.ts'
import { HealthBoard } from '@superagent/dsh/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '@superagent/dsh/policy.ts'
import { conversationAdapter, conversationDefinition, conversationManifest, conversationTrigger, LOCAL_USER, SOURCE } from '@superagent/dsh/sources/conversation.ts'
import { SourceRegistry } from '@superagent/dsh/sources/registry.ts'

const request = (overrides: Partial<Parameters<typeof conversationTrigger>[0]> = {}) => ({ messageId: 'msg_1', text: 'Fix the flaky test', at: '2026-11-07T10:00:00.000Z',
  sessionId: 'orchestrator-1', ...overrides })

describe('the conversation Source', () => {
  it('names a task thread after its request and its channel after the same root', () => {
    const trigger = conversationTrigger(request())
    expect(trigger).toMatchObject({ source: SOURCE, human: true, addressed: 'direct', text: 'Fix the flaky test',
      actor: { source: SOURCE, id: LOCAL_USER }, threads: [{ source: SOURCE, id: 'msg_1' }],
      channel: { source: SOURCE, thread: 'conversation:msg_1', address: { session: 'orchestrator-1', root: 'msg_1', messageId: 'msg_1' } },
      meta: { sessionId: 'orchestrator-1', messageId: 'msg_1', root: 'msg_1' } })
  })

  it('keeps one trigger id per message and one thread per task root', () => {
    expect(conversationTrigger(request()).id).toBe(conversationTrigger(request()).id)
    const reply = conversationTrigger(request({ messageId: 'msg_2', root: 'msg_1', parentId: 'msg_1' }))
    expect(reply.threads).toEqual([{ source: SOURCE, id: 'msg_1' }])
    expect(reply.channel?.thread).toBe('conversation:msg_1')
    expect(reply.meta.parentId).toBe('msg_1')
    expect(conversationAdapter.repliesTo?.(reply)).toBe(conversationTrigger(request()).id)
  })

  it('declares itself trusted and needs no configuration', () => {
    expect(conversationManifest.fields).toEqual([])
    expect(conversationAdapter.trusted).toBe(true)
    expect(conversationAdapter.schema.parse({})).toEqual({})
    expect(conversationAdapter.scope?.({ meta: {} }, {})).toEqual({ listened: true, observed: true })
  })

  it('delivers a reply into the main Session once per message id', async () => {
    const deliver = vi.fn(async () => 'sent' as const)
    const message = { id: 'reply-1', channel: { source: SOURCE, thread: 'conversation:msg_1', address: {} }, text: 'Working on it', kind: 'reply' as const }
    await expect(conversationAdapter.channel!.send({ commands: {} as Commands, conversation: { deliver } }, message)).resolves.toBe('sent')
    expect(deliver).toHaveBeenCalledWith('reply-1', 'Working on it')
  })

  it('admits its local user as explicit without a roster and revalidates under the same Source', () => {
    const scope = { scope: () => ({ listened: true as const, observed: true }), trusted: (id: string) => id === SOURCE }
    const policy = settingsPolicy(SettingsSchema.parse({}), scope)
    expect(policy.gate(conversationTrigger(request()), {} as never, [])).toMatchObject({ admissible: true, strength: 'explicit',
      basis: { source: SOURCE, via: 'local', addressed: 'direct' } })
    expect(policy.revalidate({ strength: 'explicit', policyVersion: policy.version, actor: { source: SOURCE, id: LOCAL_USER },
      scope: 'Fix the test', basis: { source: SOURCE, scope: {}, via: 'local' } }, '2026-09-23T00:00:00.000Z').ok).toBe(true)
  })

  it('does not admit a trusted Source that stopped listening', () => {
    const scope = { scope: () => ({ listened: false as const, reason: 'source_disabled' }), trusted: (id: string) => id === SOURCE }
    const policy = settingsPolicy(SettingsSchema.parse({}), scope)
    expect(policy.gate(conversationTrigger(request()), {} as never, [])).toEqual({ admissible: false, reason: 'source_disabled' })
  })

  it('registers as a built-in definition', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), new HealthBoard())
    sources.registerDefinition(conversationDefinition)
    expect(sources.trusted(SOURCE)).toBe(true)
    expect(sources.instance(SOURCE)).toMatchObject({ enabled: true, config: {} })
    expect(sources.kind(SOURCE)).toMatchObject({ kind: SOURCE, fields: [] })
  })
})
