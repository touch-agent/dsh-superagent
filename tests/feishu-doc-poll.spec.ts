/** The Feishu document Source's polling loops: what a round ingests, the cursor it keeps, and the replies it follows. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Executor, type Ticket, type Trigger } from '@superagent/kernel'
import { sourceContextOf, type SourceContextDeps } from '@superagent/dsh/app/source-context.ts'
import { Store } from '@superagent/dsh/app/store.ts'
import { Commands } from '@superagent/dsh/infra/commands.ts'
import { HealthBoard } from '@superagent/dsh/infra/health.ts'
import { KV } from '@superagent/dsh/kv.ts'
import { SettingsSchema, settingsPolicy } from '@superagent/dsh/policy.ts'
import { feishuDocAdapter, feishuDocKind, type FeishuDocConfig } from '@superagent/dsh/sources/feishu-doc.ts'
import { pollRound, pollThreads, runFeishuDoc } from '@superagent/dsh/sources/feishu-doc-loops.ts'
import { docTriggerId } from '@superagent/dsh/sources/feishu-doc-trigger.ts'
import { SourceRegistry } from '@superagent/dsh/sources/registry.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testDeployment } from './fixtures/deployment.ts'

const MEMBER = 'ou_alice'
const BOT = 'ou_bot'
const DOC = 'https://example.feishu.cn/docx/DOC1'
const SINCE = '2026-11-06T00:00:00.000Z'
const DAY = 86_400
const at = (when: number) => Math.floor(Date.now() / 1000) + when
const text = (value: string) => ({ type: 'text_run', text_run: { text: value } })
const mention = (id: string) => ({ type: 'person', person: { user_id: id } })
const reply = (id: string, user: string, elements: unknown[], when = 0) =>
  ({ reply_id: id, user_id: user, create_time: at(when), content: { elements } })
const config: FeishuDocConfig = feishuDocAdapter.schema.parse({ documents: [{ url: DOC, name: 'Handbook', listen: 'mentions' }] })
const page = (items: unknown[], has_more = false) => ({ file_token: 'DOC1', file_type: 'docx', items, has_more, ...has_more ? { page_token: 'next' } : {} })

/** A Source context over a real store and engine, with `lark` stubbed per call. */
function harness(docConfig: FeishuDocConfig = config) {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-doc-poll-'))
  const store = new Store(join(dir, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({ sources: { 'feishu-doc': { enabled: true, config: docConfig } } }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(feishuDocKind)
  const deployment = testDeployment()
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => store.receipts.add(message) }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }
  const ctx = sourceContextOf(parts, { kind: 'feishu-doc', health: ['feishu-doc'] })
  return { ctx, store, commands, receive, get health() { return board.all['feishu-doc'] }, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('polling document comments', () => {
  let open: ReturnType<typeof harness> | undefined
  afterEach(() => { open?.close(); open = undefined })

  it('ingests new replies only, leaves out the bot and whole-document comments, and steps the cursor back five seconds', async () => {
    const h = open = harness()
    h.store.set(KV.feishuDoc.since(DOC), SINCE)
    const whole = { comment_id: 'c0', is_whole: true, reply_list: { replies: [reply('r0', MEMBER, [text('whole')], -DAY)] } }
    const card = { comment_id: 'c1', is_solved: false, is_whole: false, has_more: false,
      reply_list: { replies: [reply('r1', MEMBER, [text('before')], -DAY * 2), reply('r2', MEMBER, [text('fix the margin')], -60),
        reply('r3', BOT, [text('Working on it')], -30), reply('r4', MEMBER, [mention(BOT), text(' please fix it')], -10)] } }
    const paged = { comment_id: 'c2', has_more: true, reply_list: { replies: [reply('r5', MEMBER, [text('root')], -DAY * 3)] } }
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[1] === '+inspect') return { token: 'DOC1', type: 'docx', title: 'Handbook' }
      if (args[1] === '+list-comments') return page([whole, card, paged])
      if (args[1] === '+list-replies') return page([reply('r5', MEMBER, [text('root')], -DAY * 3), reply('r6', MEMBER, [text('new')], -5)])
      return {}
    })
    await pollRound(h.ctx, config)
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual(['r2', 'r4', 'r6'].map(docTriggerId))
    const thread = h.store.threads.get('feishu-doc:c1')!
    expect(thread.meta).toMatchObject({ document: DOC, commentId: 'c1', label: 'Handbook' })
    const cursor = h.store.get(KV.feishuDoc.since(DOC))!
    expect(Date.parse(cursor)).toBeGreaterThan(Date.parse(SINCE))
    expect(Date.now() - Date.parse(cursor)).toBeLessThan(20_000)
    expect(h.health).toMatchObject({ state: 'ready', detail: expect.stringContaining('polled') })
  })

  it('reports an error only after the configured number of failed rounds, not on the first interruption', async () => {
    vi.useFakeTimers()
    try {
      const h = open = harness(feishuDocAdapter.schema.parse({ documents: [{ url: DOC, listen: 'mentions' }], pollSeconds: 30, failuresBeforeError: 2 }))
      h.store.set(KV.feishuDoc.since(DOC), SINCE)
      vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
        if (args[1] === '+inspect') return { token: 'DOC1', type: 'docx', title: 'Handbook' }
        if (args[1] === '+list-comments') throw new Error('network down')
        return {}
      })
      const controller = new AbortController()
      const running = runFeishuDoc(h.ctx, controller.signal)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.health).toMatchObject({ state: 'starting' })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(h.health).toMatchObject({ state: 'error', detail: expect.stringContaining('2') })
      controller.abort()
      await running
    } finally { vi.useRealTimers() }
  })

  it('returns a failed document and holds its cursor, leaving the error threshold to the watch loop', async () => {
    const h = open = harness()
    h.store.set(KV.feishuDoc.since(DOC), SINCE)
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[1] === '+inspect') return { token: 'DOC1', type: 'docx', title: 'Handbook' }
      if (args[1] === '+list-comments') throw new Error('network down')
      return {}
    })
    expect(await pollRound(h.ctx, config)).toEqual([expect.stringContaining('network down')])
    expect(h.store.get(KV.feishuDoc.since(DOC))).toBe(SINCE)
    expect(h.health).toMatchObject({ state: 'starting' })
  })

  it('holds the cursor when the comment pages are cut off, so no reply is skipped', async () => {
    const h = open = harness()
    h.store.set(KV.feishuDoc.since(DOC), SINCE)
    let pages = 0
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[1] === '+inspect') return { token: 'DOC1', type: 'docx', title: 'Handbook' }
      if (args[1] === '+list-comments') { pages += 1; return { file_token: 'DOC1', file_type: 'docx', items: [], has_more: true, page_token: `p${pages + 1}` } }
      return {}
    })
    expect(await pollRound(h.ctx, config)).toEqual([expect.stringContaining('cursor is held')])
    expect(pages).toBe(20)
    expect(h.store.get(KV.feishuDoc.since(DOC))).toBe(SINCE)
  })

  it('holds the cursor when a comment card has more replies than one read returns', async () => {
    const h = open = harness()
    h.store.set(KV.feishuDoc.since(DOC), SINCE)
    let pages = 0
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[1] === '+inspect') return { token: 'DOC1', type: 'docx', title: 'Handbook' }
      if (args[1] === '+list-comments') return page([{ comment_id: 'c1', has_more: true, reply_list: { replies: [] } }])
      if (args[1] === '+list-replies') { pages += 1; return { file_token: 'DOC1', file_type: 'docx', items: [], has_more: true, page_token: `q${pages + 1}` } }
      return {}
    })
    expect(await pollRound(h.ctx, config)).toEqual([expect.stringContaining('cursor is held')])
    expect(pages).toBe(10)
    expect(h.store.get(KV.feishuDoc.since(DOC))).toBe(SINCE)
  })

  it('reads from the moment a document is saved, not its earlier comments', async () => {
    const h = open = harness()
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[1] === '+inspect') return { token: 'DOC1', type: 'docx', title: 'Handbook' }
      if (args[1] === '+list-comments') return page([{ comment_id: 'c1', reply_list: { replies: [reply('r1', MEMBER, [text('before')], -60)] } }])
      return {}
    })
    await pollRound(h.ctx, config)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.feishuDoc.since(DOC))).toBeDefined()
  })

  it('follows a subscribed comment card and does not re-ingest the replies that were already there', async () => {
    const h = open = harness()
    const now = new Date().toISOString()
    h.store.tickets.save({ id: 't1', title: 'Margin', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '',
      basis: { via: 'listed' }, actor: { source: 'feishu-doc', id: MEMBER }, scope: '' }, channels: [], assignments: [], inputs: [],
      undelivered: [], createdAt: now, updatedAt: now, origin: { triggerId: 'source-t1', triggerIds: [] } } as Ticket)
    h.store.threads.save({ key: 'feishu-doc:c1', ref: { source: 'feishu-doc', id: 'c1' }, createdAt: now, lastAt: now, subscriptions: ['t1'],
      correlated: [], pending: [], meta: { document: DOC, commentId: 'c1' } })
    let replies = [reply('r1', MEMBER, [text('root')], -3600), reply('r2', MEMBER, [text('more detail')], 5), reply('r3', BOT, [text('Done')], 5)]
    vi.spyOn(h.commands, 'lark').mockImplementation(async () => page(replies))
    await pollThreads(h.ctx)
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual([docTriggerId('r2')])
    expect(h.store.get(KV.feishuDoc.seen('feishu-doc:c1'))).toEqual(expect.arrayContaining(['r1', 'r2', 'r3']))
    expect(h.store.get(KV.feishuDoc.initialized('feishu-doc:c1'))).toBe(true)
    replies = [...replies, reply('r4', MEMBER, [text('one more thing')], 10)]
    await pollThreads(h.ctx)
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual(['r2', 'r4'].map(docTriggerId))
    expect(h.store.get(KV.feishuDoc.seen('feishu-doc:c1'))).toEqual(expect.arrayContaining(['r4']))
  })
})