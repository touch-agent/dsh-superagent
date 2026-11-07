import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APPROVAL_STATES, approvalId, approve, createAction, createApproval, deny, expire, isApprovalState, MemoryRepositories, revoke,
  type Action, type Approval, type Repositories } from '@superagent/kernel'
import { SCHEMA_VERSION, Store } from '@superagent/dsh/app/store.ts'
import { KV } from '@superagent/dsh/kv.ts'

const requester = { source: 'feishu', id: 'ou_bot' }
const approver = { source: 'feishu', id: 'ou_alice' }
const action = (revision = 'rev-1'): Action => createAction({ source: 'feishu', objectId: 'om_1', kind: 'mail.reply', revision,
  actor: requester, level: 'send' })
const times = { requestedAt: '2026-11-07T10:00:00.000Z', expiresAt: '2026-11-07T11:00:00.000Z' }
const request = (overrides: Partial<Parameters<typeof createApproval>[0]> = {}) =>
  ({ ticketId: 't1', action: action(), ...times, requestedBy: requester, ...overrides })
const requested = (): Approval => createApproval(request())
const decided = (at = '2026-11-07T10:10:00.000Z') => ({ by: approver, at })
/** Each way an Approval leaves `requested`, for the state and idempotency tests. */
const transitions: Record<string, (approval: Approval, at: string) => Approval> = {
  approved: (approval, at) => approve(approval, decided(at)),
  denied: (approval, at) => deny(approval, decided(at)),
  revoked: (approval, at) => revoke(approval, { at, by: approver }),
  expired: (approval, at) => expire(approval, at),
}
const final = (state: keyof typeof transitions): Approval => transitions[state]!(requested(), state === 'expired' ? times.expiresAt : '2026-11-07T10:10:00.000Z')

describe('the approval state machine', () => {
  it('names the five states, from requested to the four final ones', () => {
    expect(APPROVAL_STATES).toEqual(['requested', 'approved', 'denied', 'expired', 'revoked'])
    expect(APPROVAL_STATES.map(isApprovalState)).toEqual([true, true, true, true, true])
    expect([isApprovalState('waiting'), isApprovalState(undefined), isApprovalState(1)]).toEqual([false, false, false])
  })

  it('keeps one approval per ticket and action, with the time it stops being decidable', () => {
    const send = action()
    const first = createApproval(request({ action: send }))
    expect(first).toMatchObject({ state: 'requested', ticketId: 't1', action: send, ...times, requestedBy: requester })
    expect(first.id).toBe(approvalId('t1', send.idempotencyKey))
    expect(first.id).toMatch(/^[0-9a-f]{32}$/)
    // Asking again for the same action names the same record; another ticket or revision is another approval.
    expect(createApproval(request({ action: send })).id).toBe(first.id)
    expect(createApproval(request({ action: send, ticketId: 't2' })).id).not.toBe(first.id)
    expect(createApproval(request({ action: action('rev-2') })).id).not.toBe(first.id)
  })

  it('moves requested to approved, denied, revoked or expired, recording who decided and when', () => {
    expect(transitions.approved!(requested(), '2026-11-07T10:10:00.000Z')).toMatchObject({ state: 'approved',
      decidedAt: '2026-11-07T10:10:00.000Z', decidedBy: approver })
    expect(transitions.denied!(requested(), '2026-11-07T10:10:00.000Z')).toMatchObject({ state: 'denied',
      decidedAt: '2026-11-07T10:10:00.000Z', decidedBy: approver })
    expect(transitions.revoked!(requested(), '2026-11-07T10:10:00.000Z')).toMatchObject({ state: 'revoked',
      decidedAt: '2026-11-07T10:10:00.000Z', decidedBy: approver })
    // Expiry never moves a request before its expiry, and records the moment it stopped being decidable.
    const pending = requested()
    expect(expire(pending, '2026-11-07T10:59:59.999Z')).toBe(pending)
    expect(transitions.expired!(pending, times.expiresAt)).toMatchObject({ state: 'expired', decidedAt: times.expiresAt })
    expect(transitions.expired!(pending, times.expiresAt)).not.toHaveProperty('decidedBy')
  })

  it('cannot jump out of a final state, and repeating its own transition changes nothing', () => {
    for (const state of Object.keys(transitions) as (keyof typeof transitions)[]) {
      const record = final(state)
      for (const [target, other] of Object.entries(transitions) as [keyof typeof transitions, typeof transitions[string]][]) {
        if (target === state) expect(other(record, state === 'expired' ? times.expiresAt : '2026-11-07T10:20:00.000Z')).toEqual(record)
        else expect(() => other(record, '2026-11-07T10:20:00.000Z')).toThrow(/only a requested approval can change/)
      }
    }
  })

  it('refuses a decision at or after the expiry', () => {
    const pending = requested()
    expect(approve(pending, decided('2026-11-07T10:59:59.999Z')).state).toBe('approved')
    expect(() => approve(pending, decided(times.expiresAt))).toThrow(/expired at 2026-11-07T11:00:00.000Z/)
    expect(() => approve(pending, decided('2026-11-07T11:01:00.000Z'))).toThrow(/expired/)
    expect(() => deny(pending, decided(times.expiresAt))).toThrow(/expired/)
    expect(() => revoke(pending, { at: times.expiresAt, by: approver })).toThrow(/expired/)
  })

  it('keeps a repeated approval idempotent, with its first decision time and approver', () => {
    const first = approve(requested(), decided('2026-11-07T10:10:00.000Z'))
    const again = approve(first, { by: { source: 'feishu', id: 'ou_bob' }, at: '2026-11-07T12:00:00.000Z' })
    expect(again).toEqual(first)
    expect(again.decidedAt).toBe('2026-11-07T10:10:00.000Z')
    expect(again.decidedBy).toEqual(approver)
    expect(deny(requested(), { ...decided(), reason: 'Not this revision' })).toMatchObject({ state: 'denied', reason: 'Not this revision' })
    const denied = deny(requested(), decided())
    expect(deny(denied, decided('2026-11-07T10:20:00.000Z'))).toEqual(denied)
    const revoked = revoke(requested(), { at: '2026-11-07T10:10:00.000Z' })
    expect(revoke(revoked, { at: '2026-11-07T10:20:00.000Z' })).toEqual(revoked)
  })

  it('refuses a decision before the request, an expiry that is not later, and an action that no longer matches its key', () => {
    expect(() => createApproval(request({ expiresAt: times.requestedAt }))).toThrow(/expire after it was requested/)
    expect(() => createApproval(request({ expiresAt: '2026-11-07T09:00:00.000Z' }))).toThrow(/expire after it was requested/)
    expect(() => createApproval(request({ requestedAt: 'yesterday' }))).toThrow(/request time must be a timestamp/)
    expect(() => approve(requested(), decided('2026-11-07T09:59:59.999Z'))).toThrow(/before it was requested/)
    const send = action()
    expect(() => createApproval(request({ action: { ...send, revision: 'rev-2' } }))).toThrow(/does not match its idempotency key/)
  })
})

describe('the approval repository', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-approval-')) })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  it('keeps approvals per ticket and queues only the requested ones, in SQLite as in memory', () => {
    const store = new Store(join(directory, 'db.sqlite'))
    try {
      for (const repo of [store, new MemoryRepositories()] as Repositories[]) {
        const one = createApproval(request())
        const two = createApproval(request({ action: action('rev-2') }))
        const other = createApproval(request({ ticketId: 't2' }))
        repo.approvals.save(one)
        repo.approvals.save(one)
        repo.approvals.save(two)
        repo.approvals.save(other)
        expect(repo.approvals.get(one.id)).toEqual(one)
        expect(repo.approvals.byTicket('t1').map(approval => approval.id)).toEqual([one.id, two.id])
        expect(repo.approvals.pending().map(approval => approval.id)).toEqual([one.id, two.id, other.id])
        repo.approvals.save(approve(one, decided()))
        expect(repo.approvals.get(one.id)).toMatchObject({ state: 'approved' })
        expect(repo.approvals.pending().map(approval => approval.id)).toEqual([two.id, other.id])
        expect(repo.approvals.byTicket('t1').map(approval => approval.id)).toEqual([one.id, two.id])
      }
    } finally { store.close() }
  })

  it('keeps approvals across a reopen', () => {
    const path = join(directory, 'db.sqlite')
    const approval = createApproval(request())
    const first = new Store(path)
    first.approvals.save(approve(approval, decided()))
    first.close()
    const reopened = new Store(path)
    expect(reopened.approvals.get(approval.id)).toEqual(approve(approval, decided()))
    expect(reopened.approvals.pending()).toEqual([])
    reopened.close()
  })

  it('adds the approval table and its queries when opening a schema 13 database', () => {
    const path = join(directory, 'db.sqlite')
    new Store(path).close()
    // A database written before the approval table existed: schema 13 and no `approval` table.
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE approval')
    legacy.prepare('UPDATE kv SET value=? WHERE key=?').run('13', KV.store.schema)
    legacy.close()
    const store = new Store(path)
    expect(store.get(KV.store.schema)).toBe(SCHEMA_VERSION)
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval'").get()).toBeDefined()
    const approval = createApproval(request())
    store.approvals.save(approval)
    expect(store.approvals.byTicket('t1')).toEqual([approval])
    expect(store.approvals.pending()).toEqual([approval])
    store.close()
  })
})