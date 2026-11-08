/** The panel's approval commands: record a person's decision on one requested Approval. */
import { approve, deny, type ActionLevel, type Approval } from '@superagent/kernel'
import type { Store } from './store.ts'

/** The person at the local management panel: the operator has no Source identity, so the audit names the panel. */
export const PANEL_ACTOR = { source: 'panel', id: 'local' } as const

/**
 * Decide one requested Approval at `at`, optionally granting a lower Action level, and save it in one transaction.
 * Returns the stored record, or `undefined` when no Approval has that id; a decided, expired or invalid request is
 * refused by the kernel state machine.
 */
export function decideApproval(store: Store, id: string, state: 'approved' | 'denied', at: string,
  level?: ActionLevel): Approval | undefined {
  return store.atomic(() => {
    const approval = store.approvals.get(id)
    if (!approval) return undefined
    const decision = { by: PANEL_ACTOR, at, ...(level === undefined ? {} : { level }) }
    const next = state === 'approved' ? approve(approval, decision) : deny(approval, decision)
    store.approvals.save(next)
    return next
  })
}