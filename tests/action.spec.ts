import { describe, expect, it } from 'vitest'
import { ACTION_LEVELS, actionKey, createAction, isActionLevel, withinActionLevel, type Action, type ActionCost, type ActionIdentity,
  type ActionLevel } from '@superagent/kernel'

const actor = { source: 'feishu', id: 'ou_1' }
const base: Omit<ActionIdentity, 'level'> = { source: 'feishu', objectId: 'om_1', kind: 'mail.reply', revision: 'rev-1', actor }
const identity = (level: ActionLevel): ActionIdentity => ({ ...base, level })
const money: ActionCost = { kind: 'money', amount: 8, currency: 'CNY' }
const spend = (cost: ActionCost = money): Action => createAction({ ...identity('spend'), cost })

describe('action levels', () => {
  it('names the five levels from no effect to the most consequence', () => {
    expect(ACTION_LEVELS).toEqual(['read', 'draft', 'commit', 'send', 'spend'])
    expect(ACTION_LEVELS.map(isActionLevel)).toEqual([true, true, true, true, true])
    expect([isActionLevel('delete'), isActionLevel(undefined), isActionLevel(3)]).toEqual([false, false, false])
  })

  it('orders a comparison by consequence so a maximum permits itself and every level below it', () => {
    expect(ACTION_LEVELS.map(level => withinActionLevel(level, 'commit'))).toEqual([true, true, true, false, false])
    expect(ACTION_LEVELS.map(max => withinActionLevel('draft', max))).toEqual([false, true, true, true, true])
    expect(withinActionLevel('read', 'read')).toBe(true)
    expect(withinActionLevel('spend', 'send')).toBe(false)
  })

  it('derives a different idempotency key for each of the five levels', () => {
    const keys = [createAction(identity('read')), createAction(identity('draft')), createAction(identity('commit')),
      createAction(identity('send')), spend()].map(action => action.idempotencyKey)
    expect(new Set(keys).size).toBe(5)
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{32}$/)
  })

  it('keeps one key for one identity and a new key for every part of it', () => {
    const first = createAction(identity('send'))
    const second = createAction(identity('send'))
    expect(second.idempotencyKey).toBe(first.idempotencyKey)
    expect(first).toEqual({ ...base, level: 'send', idempotencyKey: first.idempotencyKey })
    const variants = [
      createAction({ ...identity('send'), source: 'github' }),
      createAction({ ...identity('send'), objectId: 'om_2' }),
      createAction({ ...identity('send'), kind: 'mail.forward' }),
      createAction({ ...identity('send'), revision: 'rev-2' }),
      createAction({ ...identity('send'), actor: { source: 'feishu', id: 'ou_2' } }),
      createAction({ ...identity('send'), actor: { source: 'github', id: 'ou_1' } }),
      createAction(identity('commit')),
    ].map(action => action.idempotencyKey)
    expect(new Set([first.idempotencyKey, ...variants]).size).toBe(8)
    expect(actionKey(identity('send'))).toBe(first.idempotencyKey)
  })
})

describe('spend actions', () => {
  it('carries a money cost', () => {
    expect(spend()).toMatchObject({ level: 'spend', cost: { kind: 'money', amount: 8, currency: 'CNY' } })
  })

  it('maps a calendar booking that takes another person’s time to spend with a time cost', () => {
    const invite = createAction({ ...identity('spend'), kind: 'calendar.invite', cost: { kind: 'time', minutes: 30 } })
    expect(invite).toMatchObject({ kind: 'calendar.invite', level: 'spend', cost: { kind: 'time', minutes: 30 } })
    expect(invite.cost).toEqual({ kind: 'time', minutes: 30 })
  })

  it('requires a cost, and cannot be written without one', () => {
    expect(() => createAction(identity('spend'))).toThrow(/spend action must carry a money or time cost/)
    // @ts-expect-error a spend Action must say what it costs
    const missing: Action = { ...base, level: 'spend', idempotencyKey: actionKey({ ...base, level: 'spend' }) }
    expect(missing.level).toBe('spend')
  })

  it('refuses a cost that is not a positive amount or duration', () => {
    expect(() => spend({ kind: 'money', amount: 0, currency: 'CNY' })).toThrow(/positive amount/)
    expect(() => spend({ kind: 'money', amount: -1, currency: 'CNY' })).toThrow(/positive amount/)
    expect(() => spend({ kind: 'money', amount: Number.POSITIVE_INFINITY, currency: 'CNY' })).toThrow(/positive amount/)
    expect(() => spend({ kind: 'money', amount: 8, currency: '' })).toThrow(/currency/)
    expect(() => spend({ kind: 'money', amount: 8, currency: '   ' })).toThrow(/currency/)
    expect(() => spend({ kind: 'money', amount: 8, currency: 123 as unknown as string })).toThrow(/currency/)
    expect(() => spend({ kind: 'time', minutes: 0 })).toThrow(/positive number of minutes/)
    expect(() => spend({ kind: 'time', minutes: Number.NaN })).toThrow(/positive number of minutes/)
    expect(() => spend({ kind: 'voucher' } as unknown as ActionCost)).toThrow(/Unknown action cost: voucher/)
  })
})

describe('the other levels', () => {
  it('carry no cost', () => {
    expect(() => createAction({ ...identity('commit'), cost: money })).toThrow(/Only a spend action carries a cost/)
    expect(createAction(identity('read'))).not.toHaveProperty('cost')
  })

  it('refuse a level outside the five even when a caller bypasses the type', () => {
    expect(() => createAction({ ...identity('send'), level: 'delete' as ActionLevel })).toThrow(/Unknown action level: delete/)
  })
})