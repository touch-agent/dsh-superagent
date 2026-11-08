import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { approvalId, createAction, createApproval, MemoryRepositories, type Action } from '@superagent/kernel'
import { AUTO_APPROVAL_ACTOR, approvalTargetDomain, requestApproval, withinWorkingHours } from '@superagent/dsh/app/approvals.ts'
import { PolicyConfigSchema, policyVersion, SettingsSchema, WorkHoursSchema, type PolicyConfig } from '@superagent/dsh/policy.ts'
import { Store } from '@superagent/dsh/app/store.ts'

/** A five-day, local-time window; 09:00–18:00 in Shanghai. */
const WINDOW = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', timeZone: 'Asia/Shanghai' }
/** Monday 10:00 in Shanghai (02:00 UTC). */
const MONDAY_10 = '2026-11-09T02:00:00.000Z'
/** Monday 20:00 in Shanghai, outside the window. */
const MONDAY_20 = '2026-11-09T12:00:00.000Z'
/** Sunday 10:00 in Shanghai, a day outside the window. */
const SUNDAY_10 = '2026-11-08T02:00:00.000Z'
const EXPIRES = '2026-11-10T00:00:00.000Z'

const operator = { source: 'dsh-superagent', id: 'worker' }
const action = (level: 'send' | 'spend' = 'send'): Action => level === 'spend'
  ? createAction({ kind: 'mail.reply', source: 'feishu', objectId: 'om_1', revision: 'rev-1', actor: operator, level: 'spend',
    cost: { kind: 'money', amount: 10, currency: 'CNY' } })
  : createAction({ kind: 'mail.reply', source: 'feishu', objectId: 'om_1', revision: 'rev-1', actor: operator, level: 'send' })
/** A Policy with only the auto-approval part supplied; every other part keeps its default. */
const policy = (approval: Record<string, unknown> = {}): PolicyConfig => PolicyConfigSchema.parse({ approval })
/** A request for the default Ticket and Action, sending to `alice@corp.example`. */
const request = (overrides: Partial<Parameters<typeof requestApproval>[1]> = {}): Parameters<typeof requestApproval>[1] =>
  ({ ticketId: 't1', action: action(), expiresAt: EXPIRES, target: 'alice@corp.example', ...overrides })

describe('the approval whitelist', () => {
  it('auto-approves an internal-domain action inside the working window and keeps the approval record', () => {
    const store = new MemoryRepositories()
    const approval = requestApproval(store, request(), policy({ tenant: { domains: ['corp.example'], hours: WINDOW } }), MONDAY_10)
    expect(approval).toMatchObject({ state: 'approved', decidedAt: MONDAY_10, decidedBy: AUTO_APPROVAL_ACTOR,
      requestedAt: MONDAY_10, target: 'alice@corp.example' })
    // It is an ordinary Approval, not a skipped request: by id, by Ticket, with what decided it and why.
    expect(approval.reason).toContain('Auto-approved by policy')
    expect(approval.reason).toContain('corp.example')
    expect(store.approvals.get(approvalId('t1', action().idempotencyKey))).toEqual(approval)
    expect(store.approvals.byTicket('t1')).toEqual([approval])
    expect(store.approvals.pending(Date.parse(MONDAY_10))).toEqual([])
  })

  it('leaves an action whose target is outside the whitelist waiting for a person', () => {
    const store = new MemoryRepositories()
    const approval = requestApproval(store, request({ target: 'alice@outside.test' }),
      policy({ tenant: { domains: ['corp.example'], hours: WINDOW } }), MONDAY_10)
    expect(approval).toMatchObject({ state: 'requested', requestedAt: MONDAY_10 })
    expect(approval).not.toHaveProperty('decidedBy')
    expect(approval).not.toHaveProperty('decidedAt')
    expect(store.approvals.pending(Date.parse(MONDAY_10))).toEqual([approval])
  })

  it('leaves an internal-domain action outside the working window waiting for a person', () => {
    const scoped = policy({ tenant: { domains: ['corp.example'], hours: WINDOW } })
    for (const at of [SUNDAY_10, MONDAY_20]) {
      const store = new MemoryRepositories()
      expect(requestApproval(store, request(), scoped, at)).toMatchObject({ state: 'requested', requestedAt: at })
    }
  })

  it('never auto-approves a spend action, even on an internal domain inside the window', () => {
    const approval = requestApproval(new MemoryRepositories(), request({ action: action('spend') }),
      policy({ tenant: { domains: ['corp.example'], hours: WINDOW } }), MONDAY_10)
    expect(approval).toMatchObject({ state: 'requested', action: { level: 'spend' } })
    expect(approval).not.toHaveProperty('decidedBy')
  })

  it('lets a source rule replace the tenant rule, and an empty source rule disables it', () => {
    const replaced = policy({ tenant: { domains: ['corp.example'], hours: WINDOW },
      sources: { feishu: { domains: ['partner.test'] } } })
    expect(requestApproval(new MemoryRepositories(), request(), replaced, MONDAY_10)).toMatchObject({ state: 'requested' })
    // The source rule names another domain and no hours, so any moment approves it.
    expect(requestApproval(new MemoryRepositories(), request({ target: 'bob@partner.test' }), replaced, SUNDAY_10))
      .toMatchObject({ state: 'approved', decidedBy: AUTO_APPROVAL_ACTOR })
    expect(requestApproval(new MemoryRepositories(), request(), policy({ tenant: { domains: ['corp.example'], hours: WINDOW },
      sources: { feishu: { domains: [] } } }), MONDAY_10)).toMatchObject({ state: 'requested' })
  })

  it('matches domains case-insensitively and includes their subdomains', () => {
    const scoped = policy({ tenant: { domains: ['corp.example'], hours: WINDOW } })
    expect(requestApproval(new MemoryRepositories(), request({ target: 'Alice@MAIL.CORP.EXAMPLE' }), scoped, MONDAY_10))
      .toMatchObject({ state: 'approved' })
    expect(requestApproval(new MemoryRepositories(), request({ target: 'https://docs.corp.example/doc/1' }), scoped, MONDAY_10))
      .toMatchObject({ state: 'approved' })
    // A sibling domain that only ends in the whitelisted text is not a subdomain.
    expect(requestApproval(new MemoryRepositories(), request({ target: 'alice@evilcorp.example' }), scoped, MONDAY_10))
      .toMatchObject({ state: 'requested' })
  })

  it('keeps a target without a domain waiting for a person', () => {
    const scoped = policy({ tenant: { domains: ['corp.example'], hours: WINDOW } })
    for (const target of ['om_1', 'corp.example.evil', 'https://corp.example.evil/doc']) {
      expect(requestApproval(new MemoryRepositories(), request({ target }), scoped, MONDAY_10)).toMatchObject({ state: 'requested' })
    }
    expect(approvalTargetDomain('Alice@MAIL.CORP.EXAMPLE')).toBe('mail.corp.example')
    expect(approvalTargetDomain('https://docs.corp.example:8443/doc')).toBe('docs.corp.example')
    expect(approvalTargetDomain('mailto:bob@corp.example?subject=hi')).toBe('corp.example')
    expect(approvalTargetDomain('om_1')).toBeUndefined()
  })

  it('keeps the first record and decision when the same request arrives again', () => {
    const store = new MemoryRepositories()
    const scoped = policy({ tenant: { domains: ['corp.example'], hours: WINDOW } })
    const first = requestApproval(store, request(), scoped, MONDAY_10)
    // A later attempt under a narrower rule neither reopens the approved record nor creates another one.
    const again = requestApproval(store, request({ target: 'alice@outside.test' }), policy(), MONDAY_10)
    expect(again).toEqual(first)
    expect(store.approvals.byTicket('t1')).toHaveLength(1)
    // The same holds for a request that is still waiting: it is not auto-approved after the fact.
    const waitingStore = new MemoryRepositories()
    const waiting = requestApproval(waitingStore, request({ target: 'alice@outside.test' }), policy(), MONDAY_10)
    expect(requestApproval(waitingStore, request(), scoped, MONDAY_10)).toEqual(waiting)
    expect(waitingStore.approvals.pending(Date.parse(MONDAY_10))).toHaveLength(1)
  })

  it('requires a person when the Policy configures no rule, and leaves the Policy version unchanged', () => {
    const empty = policy()
    expect(empty.approval).toEqual({ sources: {} })
    expect(requestApproval(new MemoryRepositories(), request(), empty, MONDAY_10)).toMatchObject({ state: 'requested' })
    const scoped = policy({ tenant: { domains: ['corp.example'], hours: WINDOW } })
    // Auto-approval is not a reason to discard running Evals or revoke a Mandate.
    expect(policyVersion(SettingsSchema.parse({ policy: { approval: scoped.approval } })))
      .toBe(policyVersion(SettingsSchema.parse({})))
  })

  it('records the automatic decision in the Store, and the pending query leaves it out', () => {
    const store = new Store(join(directory, 'db.sqlite'))
    try {
      const approval = requestApproval(store, request(), policy({ tenant: { domains: ['corp.example'], hours: WINDOW } }), MONDAY_10)
      expect(store.approvals.get(approval.id)).toEqual(approval)
      expect(store.approvals.pending(Date.parse(MONDAY_10))).toEqual([])
    } finally { store.close() }
  })
})

describe('the auto-approval settings', () => {
  it('treats a target as inside the window only on a listed day and between start and end', () => {
    const hours = WorkHoursSchema.parse(WINDOW)
    expect(withinWorkingHours(hours, MONDAY_10)).toBe(true)
    expect(withinWorkingHours(hours, MONDAY_20)).toBe(false)
    expect(withinWorkingHours(hours, SUNDAY_10)).toBe(false)
    // The same instant in another zone is another local time.
    expect(withinWorkingHours(WorkHoursSchema.parse({ ...WINDOW, timeZone: 'UTC' }), MONDAY_10)).toBe(false)
  })

  it('rejects an impossible window and an unknown zone', () => {
    expect(() => WorkHoursSchema.parse({ ...WINDOW, end: '08:00' })).toThrow(/end must be after the start/i)
    expect(() => WorkHoursSchema.parse({ ...WINDOW, timeZone: 'Mars/Olympus' })).toThrow(/IANA time zone/)
    expect(() => WorkHoursSchema.parse({ ...WINDOW, days: [1, 1] })).toThrow(/Each day at most once/)
    expect(() => WorkHoursSchema.parse({ ...WINDOW, start: '9:00' })).toThrow(/HH:MM/)
    expect(() => PolicyConfigSchema.parse({ approval: { tenant: { domains: ['not a domain'] } } })).toThrow(/domain name/)
    // Deliberately accepting an empty whitelist gives no automatic approval.
    expect(PolicyConfigSchema.parse({ approval: { tenant: { domains: [] } } }).approval.tenant).toEqual({ domains: [] })
  })

  it('refuses an empty target on a request', () => {
    expect(() => createApproval({ ticketId: 't1', action: action(), requestedAt: MONDAY_10, expiresAt: EXPIRES, target: '  ' }))
      .toThrow(/target/)
  })
})

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dsh-approval-policy-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })