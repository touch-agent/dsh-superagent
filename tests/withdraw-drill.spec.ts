/**
 * T2-10: the withdrawal drill. It sends one message through every kind of Channel and asks the Source to take it back,
 * then reads the message back with `probe` to prove it is gone. A Source without a withdraw adapter is reported as
 * unable to withdraw with that reason, never as a success. `pnpm drill:withdraw` runs this file; `docs/runbooks/
 * withdraw.drill.md` records a run.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '@superagent/kernel'
import { CliError, Commands } from '@superagent/dsh/infra/commands.ts'
import { SettingsSchema } from '@superagent/dsh/policy.ts'
import type { SourceKind } from '@superagent/dsh/sources/kind.ts'
import { SourceRegistry } from '@superagent/dsh/sources/registry.ts'
import { feishuKind } from '@superagent/dsh/sources/feishu.ts'
import { githubKind } from '@superagent/dsh/sources/github.ts'
import { testDeployment } from './fixtures/deployment.ts'

const text = { zh: '演练', en: 'Drill' }
/** One row of the drill table: what was sent, what the Source answered, and whether the message is really gone. */
interface Row { source: string; sent: string; withdraw: string; verify: string; verdict: string }
/** A Source that can withdraw a sent object, such as a mail draft: the store is the remote service's journal. */
function revocable(store: Map<string, string>): SourceKind<Record<string, never>> {
  return { kind: 'mail-draft', title: text, description: text, health: [], schema: z.object({}).strict(), fields: [],
    channel: {
      send: async (_host, message) => { store.set(message.id, message.text); return 'sent' },
      probe: async (_host, message) => store.has(message.id) ? 'sent' : 'gone',
      withdraw: async (_host, message) => store.delete(message.id) ? { status: 'withdrawn' } : { status: 'gone' },
      link: () => ({ url: '', label: text }),
    } }
}
/** A Source that can locate the sent object but refuses to withdraw it, with a reason a person can act on. */
function refusing(store: Map<string, string>): SourceKind<Record<string, never>> {
  return { kind: 'calendar-invite', title: text, description: text, health: [], schema: z.object({}).strict(), fields: [],
    channel: {
      send: async (_host, message) => { store.set(message.id, message.text); return 'sent' },
      probe: async (_host, message) => store.has(message.id) ? 'sent' : 'gone',
      withdraw: async () => ({ status: 'refused', reason: 'Two guests accepted the invite; cancelling it needs the organizer' }),
      link: () => ({ url: '', label: text }),
    } }
}
/** A Source whose writes are final: no withdraw adapter at all, which the drill must report instead of guessing. */
const final = (store: Map<string, string>): SourceKind<Record<string, never>> => ({
  kind: 'no-recall', title: text, description: text, health: [], schema: z.object({}).strict(), fields: [],
  channel: { send: async (_host, message) => { store.set(message.id, message.text); return 'sent' },
    probe: async (_host, message) => store.has(message.id) ? 'sent' : 'gone', link: () => ({ url: '', label: text }) },
})
/** A Source whose object is already absent when withdrawal starts: `gone` is a success, not a refusal. */
const vanishing = (): SourceKind<Record<string, never>> => ({
  kind: 'already-gone', title: text, description: text, health: [], schema: z.object({}).strict(), fields: [],
  channel: { send: async () => 'sent', probe: async () => 'gone', withdraw: async () => ({ status: 'gone' }),
    link: () => ({ url: '', label: text }) },
})

/** A message whose id names the drill row, so the GitHub marker and the fixture journals cannot collide. */
const messageOf = (source: string, address: Record<string, string>): OutboundMessage =>
  ({ id: `drill-${source}`, channel: { source, thread: `${source}:drill`, address }, text: 'Withdrawal drill', kind: 'reply' })

describe('withdrawal drill', () => {
  it('withdraws a sent message where the Source can, and names the reason where it cannot', async () => {
    const settings = SettingsSchema.parse({ sources: {} })
    const registry = new SourceRegistry(() => settings)
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    const drafts = new Map<string, string>(), invites = new Map<string, string>(), finalWrites = new Map<string, string>()
    registry.register(revocable(drafts)); registry.register(refusing(invites)); registry.register(final(finalWrites)); registry.register(vanishing())
    registry.register(githubKind); registry.register(feishuKind)
    // GitHub: the marked comment is already there (sent), and DELETE removes the same id from the list.
    const comments = [{ id: 77, body: `Withdrawal drill\n\n<!-- dsh-superagent:drill-github -->`, in_reply_to_id: null, user: { login: 'agent-bot' } }]
    const deleted: string[] = []
    const pages = vi.fn(async () => comments)
    const api = vi.fn(async (path: string, ...flags: string[]) => {
      if (flags.includes('DELETE')) { deleted.push(path); const at = comments.findIndex(comment => path.endsWith(`/${comment.id}`)); if (at >= 0) comments.splice(at, 1) }
      return ''
    })
    // Feishu: the reply is accepted, while withdrawal refuses before touching the remote.
    const lark = vi.fn(async () => ({}))
    Object.assign(commands, { pages, api, lark })

    const rows: Row[] = []
    for (const source of ['mail-draft', 'calendar-invite', 'no-recall', 'already-gone', 'github', 'feishu']) {
      const address: Record<string, string> = source === 'github' ? { number: '12' } : source === 'feishu' ? { messageId: 'om_drill' } : {}
      const sent = await registry.send(messageOf(source, address), commands)
      const withdrawal = await registry.withdraw(messageOf(source, address), commands)
      if (!withdrawal) {
        rows.push({ source, sent, withdraw: 'unsupported', verify: 'not attempted', verdict: `cannot withdraw: the ${source} Source has no withdraw adapter` })
        continue
      }
      if (withdrawal.status === 'refused') {
        rows.push({ source, sent, withdraw: 'refused', verify: 'not attempted', verdict: `cannot withdraw: ${withdrawal.reason}` })
        continue
      }
      const probe = await registry.probe(messageOf(source, address), commands)
      const verdict = probe !== 'gone' ? `failed: the channel said ${withdrawal.status} but probe still reads it`
        : withdrawal.status === 'withdrawn' ? 'withdrawn' : 'already gone'
      rows.push({ source, sent, withdraw: withdrawal.status, verify: probe ?? 'no probe', verdict })
    }
    console.log(['', '| Source | Sent | Withdraw | Verify | Verdict |', '| --- | --- | --- | --- | --- |',
      ...rows.map(row => `| ${row.source} | ${row.sent} | ${row.withdraw} | ${row.verify} | ${row.verdict} |`)].join('\n'))

    const by = (source: string) => rows.find(row => row.source === source)!
    // A Source that can withdraw proves the whole loop, including the read-back.
    expect(by('mail-draft')).toMatchObject({ sent: 'sent', withdraw: 'withdrawn', verify: 'gone', verdict: 'withdrawn' })
    // GitHub's comment is deleted by its own id, and the probe then finds nothing.
    expect(by('github')).toMatchObject({ sent: 'sent', withdraw: 'withdrawn', verify: 'gone', verdict: 'withdrawn' })
    expect(deleted).toEqual(['issues/comments/77'])
    // A refusal is a result too: it names why, and the drill does not claim the message is gone.
    expect(by('calendar-invite')).toMatchObject({ sent: 'sent', withdraw: 'refused', verify: 'not attempted' })
    expect(by('calendar-invite').verdict).toContain('needs the organizer')
    expect(by('feishu')).toMatchObject({ sent: 'sent', withdraw: 'refused', verify: 'not attempted' })
    expect(by('feishu').verdict).toContain('high-risk')
    // A Source with no withdraw adapter is unsupported, with that reason instead of a false success.
    expect(by('no-recall')).toMatchObject({ withdraw: 'unsupported', verify: 'not attempted' })
    expect(by('no-recall').verdict).toContain('no withdraw adapter')
    // An object that is already absent is a successful `gone`, not a failed withdrawal.
    expect(by('already-gone')).toMatchObject({ sent: 'sent', withdraw: 'gone', verify: 'gone', verdict: 'already gone' })
  })

  it('reports an already absent GitHub comment as gone and a refused delete with its reason', async () => {
    const registry = new SourceRegistry(() => SettingsSchema.parse({ sources: {} }))
    registry.register(githubKind)
    const message = messageOf('github', { number: '12' })
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    // A comment the Channel can no longer find was already removed; that is `gone`, not a failure.
    Object.assign(commands, { pages: vi.fn(async () => []), api: vi.fn() })
    expect(await registry.withdraw(message, commands)).toEqual({ status: 'gone' })
    // A locked conversation refuses the delete, and the drill must show why rather than call it withdrawn.
    Object.assign(commands, { pages: vi.fn(async () => { throw new CliError('locked', 403) }), api: vi.fn() })
    const refused = await registry.withdraw(message, commands)
    expect(refused).toMatchObject({ status: 'refused' })
    expect((refused as { reason: string }).reason).toContain('locked')
    // A 404 is not proof of absence: a private repository can answer it when access is lost, so the drill refuses.
    Object.assign(commands, { pages: vi.fn(async () => { throw new CliError('Not Found', 404) }), api: vi.fn() })
    const unreadable = await registry.withdraw(message, commands)
    expect(unreadable).toMatchObject({ status: 'refused' })
    expect((unreadable as { reason: string }).reason).toContain('Not Found')
  })
})
