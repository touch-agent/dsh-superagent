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
const DAY = 86_400
/** One day back, so replies two and three days old stay behind the cursor whatever the calendar date is. */
const SINCE = new Date(Date.now() - DAY * 1000).toISOString()
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
    const before = Date.now()
    await pollRound(h.ctx, config)
    const after = Date.now()
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual(['r2', 'r4', 'r6'].map(docTriggerId))
    const thread = h.store.threads.get('feishu-doc:c1')!
    expect(thread.meta).toMatchObject({ document: DOC, commentId: 'c1', label: 'Handbook' })
    const cursor = h.store.get(KV.feishuDoc.since(DOC))!
    expect(Date.parse(cursor)).toBeGreaterThanOrEqual(before - 5000 - 1)
    expect(Date.parse(cursor)).toBeLessThanOrEqual(after - 5000 + 1)
    expect(h.health).toMatchObject({ state: 'ready', detail: expect.stringContaining('polled') })
  })

  it('reports an error only after the configured number of failed rounds, not on the first interruption', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let running: Promise<unknown> | undefined
    try {
      const h = open = harness(feishuDocAdapter.schema.parse({ documents: [{ url: DOC, listen: 'mentions' }], pollSeconds: 30, failuresBeforeError: 2 }))
      h.store.set(KV.feishuDoc.since(DOC), SINCE)
      vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
        if (args[1] === '+inspect') return { token: 'DOC1', type: 'docx', title: 'Handbook' }
        if (args[1] === '+list-comments') throw new Error('network down')
        return {}
      })
      running = runFeishuDoc(h.ctx, controller.signal)
      await vi.advanceTimersByTimeAsync(0)
      expect(h.health).toMatchObject({ state: 'starting' })
      // Each advance flushes a round and then its pause; let the round's promise chain finish before the next advance.
      for (let round = 0; round < 20 && h.health?.state !== 'error'; round += 1) {
        await vi.advanceTimersByTimeAsync(30_000)
        for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
      }
      expect(h.health).toMatchObject({ state: 'error', detail: expect.stringContaining('2') })
    } finally {
      controller.abort()
      await running
      vi.useRealTimers()
    }
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
    let done = false
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[1] === '+inspect') return { token: 'DOC1', type: 'docx', title: 'Handbook' }
      if (args[1] === '+list-comments') {
        if (done) return { file_token: 'DOC1', file_type: 'docx', items: [], has_more: false }
        pages += 1
        return { file_token: 'DOC1', file_type: 'docx', items: [], has_more: true, page_token: `p${pages + 1}` }
      }
      return {}
    })
    expect(await pollRound(h.ctx, config)).toEqual([expect.stringContaining('continuing from the saved page')])
    expect(pages).toBe(20)
    expect(h.store.get(KV.feishuDoc.since(DOC))).toBe(SINCE)
    const saved = h.store.get(KV.feishuDoc.page(DOC))
    expect(saved).toBe('p21')
    // The next round continues from the saved page, so a document larger than the page cap makes progress.
    expect(await pollRound(h.ctx, config)).toEqual([expect.stringContaining('continuing from the saved page')])
    expect(h.store.get(KV.feishuDoc.page(DOC))).toBe('p42')
    expect(h.store.get(KV.feishuDoc.since(DOC))).toBe(SINCE)
    done = true
    expect(await pollRound(h.ctx, config)).toEqual([])
    expect(h.store.get(KV.feishuDoc.page(DOC))).toBeUndefined()
    expect(Date.parse(h.store.get(KV.feishuDoc.since(DOC))!)).toBeGreaterThan(Date.parse(SINCE))
  })

  it('holds the cursor when a comment card has more replies than one read returns', async () => {
    const h = open = harness()
    h.store.set(KV.feishuDoc.since(DOC), SINCE)
    let pages = 0
    let done = false
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[1] === '+inspect') return { token: 'DOC1', type: 'docx', title: 'Handbook' }
      if (args[1] === '+list-comments') return page([{ comment_id: 'c1', has_more: true, reply_list: { replies: [] } }])
      if (args[1] === '+list-replies') {
        if (done) return { file_token: 'DOC1', file_type: 'docx', items: [], has_more: false }
        pages += 1
        return { file_token: 'DOC1', file_type: 'docx', items: [], has_more: true, page_token: `q${pages + 1}` }
      }
      return {}
    })
    expect(await pollRound(h.ctx, config)).toEqual([expect.stringContaining('continuing from the saved page')])
    expect(pages).toBe(10)
    expect(h.store.get(KV.feishuDoc.since(DOC))).toBe(SINCE)
    expect(h.store.get(KV.feishuDoc.page(`${DOC}#c1`))).toBe('q11')
    done = true
    expect(await pollRound(h.ctx, config)).toEqual([])
    expect(h.store.get(KV.feishuDoc.page(`${DOC}#c1`))).toBeUndefined()
    expect(Date.parse(h.store.get(KV.feishuDoc.since(DOC))!)).toBeGreaterThan(Date.parse(SINCE))
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

  it('continues a subscribed card whose reply list was truncated and initializes only after a full read', async () => {
    const h = open = harness()
    const now = new Date().toISOString()
    h.store.tickets.save({ id: 't1', title: 'Margin', decisionId: 'd1', mandate: { strength: 'explicit', policyVersion: '',
      basis: { via: 'listed' }, actor: { source: 'feishu-doc', id: MEMBER }, scope: '' }, channels: [], assignments: [], inputs: [],
      undelivered: [], createdAt: now, updatedAt: now, origin: { triggerId: 'source-t1', triggerIds: [] } } as Ticket)
    h.store.threads.save({ key: 'feishu-doc:c1', ref: { source: 'feishu-doc', id: 'c1' }, createdAt: now, lastAt: now, subscriptions: ['t1'],
      correlated: [], pending: [], meta: { document: DOC, commentId: 'c1' } })
    let resume: string | undefined
    let fetches = 0
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      const at = args.indexOf('--page-token')
      if (at >= 0) resume = args[at + 1]
      fetches += 1
      if (fetches <= 10) return { items: fetches === 1 ? [reply('r1', MEMBER, [text('root')], -3600), reply('r2', MEMBER, [text('detail')], 5)] : [],
        has_more: true, page_token: `q${fetches + 1}` }
      return { items: [reply('r3', MEMBER, [text('more')], 10)], has_more: false }
    })
    expect(await pollThreads(h.ctx)).toEqual([expect.stringContaining('continuing from the saved page')])
    expect(resume).toBe('q10')
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual([docTriggerId('r2')])
    expect(h.store.get(KV.feishuDoc.initialized('feishu-doc:c1'))).toBeUndefined()
    expect(h.store.get(KV.feishuDoc.page('thread:feishu-doc:c1'))).toBe('q11')
    await pollThreads(h.ctx)
    expect(resume).toBe('q11')
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual(['r2', 'r3'].map(docTriggerId))
    expect(h.store.get(KV.feishuDoc.page('thread:feishu-doc:c1'))).toBeUndefined()
    expect(h.store.get(KV.feishuDoc.initialized('feishu-doc:c1'))).toBe(true)
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