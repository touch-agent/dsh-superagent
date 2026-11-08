/**
 * The runtime's Approval producer: an external Ticket message revalidates the Mandate, waits in the panel queue, and
 * only reaches its Channel once a person or the Policy approves it; a denial, expiry or lower grant never sends it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Commands } from '@superagent/dsh/infra/commands.ts'
import { requestActionApproval } from '@superagent/dsh/app/action-gate.ts'
import { approvalQueue } from '@superagent/dsh/app/views/approvals.ts'
import { settingsPolicy } from '@superagent/dsh/policy.ts'
import { createAction, OUTBOX_ACTOR, outboundAction, type Approval } from '@superagent/kernel'
import type { Receipt } from '@superagent/dsh/app/store.ts'
import { CHAT, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime(undefined, undefined, { autoApprove: false }) })
afterEach(async () => { await h.stop() })

/** The receipt the action gate is holding for its Approval, if any. */
const held = (): Receipt => {
  const receipt = h.runtime.store.receipts.waiting().find(row => row.approvalId !== undefined)
  if (!receipt) throw new Error('No outbox message waits for an approval')
  return receipt
}
/** The one request the panel queue shows for the held message. */
const request = (): Approval => h.runtime.store.approvals.pending().find(row => row.id === held().approvalId)!
/** The receipt of an acknowledgement of `trigger`, which every accepted Ticket queues. */
const acknowledgement = (triggerId: string): Receipt => {
  const id = outboundAction({ kind: 'acknowledgement', source: 'feishu', objectId: triggerId, revision: 'accepted' }).idempotencyKey
  const receipt = h.runtime.store.receipts.get(id)
  if (!receipt) throw new Error(`No acknowledgement receipt for ${triggerId}`)
  return receipt
}
/** Feishu replies this run sent, without the reads and health probes on the same CLI. */
const sent = (): number => vi.mocked(Commands.prototype.lark).mock.calls
  .filter(([args]) => (args as string[]).includes('+messages-reply')).length
const approve = async (approval: Approval, level?: string) => {
  const answer = await h.api('POST', `approvals/${approval.id}/approve`, level === undefined ? {} : { level })
  expect(answer.status).toBe(200)
}

it('queues an external message for approval, with its target and revision, and produces no external effect before the decision', async () => {
  const { trigger, ticket } = await h.acceptedTicket(feishu('1', '@bot 修一下回归'))
  const receipt = held()
  const approval = request()
  // The panel queue names the action, its exact revision and where it would reach.
  expect(approval).toMatchObject({ ticketId: ticket.id, target: CHAT, state: 'requested',
    action: { kind: 'acknowledgement', objectId: trigger.id, revision: 'accepted', level: 'send' } })
  expect(receipt).toMatchObject({ status: 'pending', ticketId: ticket.id, approvalId: approval.id })
  // The panel's Overview queue reads the same request.
  expect(approvalQueue(h.runtime.store).find(row => row.id === approval.id)).toMatchObject({
    ticket: { id: ticket.id, title: ticket.title },
    action: { kind: 'acknowledgement', objectId: trigger.id, revision: 'accepted', level: 'send' } })
  // Before a decision the effect is not even queued, so a pass cannot deliver it.
  expect(h.runtime.effects.pending('reply', receipt.id)).toBe(false)
  expect(sent()).toBe(0)
  await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(receipt.id)).toBe('pending')
  expect(sent()).toBe(0)
})

it('delivers the message after the panel approves it, and sends a denial nowhere', async () => {
  const denied = (await h.acceptedTicket(feishu('2', '@bot 修一下回归'))).trigger
  const deniedRequest = request()
  await h.api('POST', `approvals/${deniedRequest.id}/deny`)
  await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(acknowledgement(denied.id)!.id)).toBe('dropped')
  expect(acknowledgement(denied.id)!.dropped).toMatchObject({ reason: 'approvalDenied' })
  // The same revision does not ask again or run under the denial; only a new revision does.
  h.runtime.outbox.send({ action: outboundAction({ kind: 'acknowledgement', source: 'feishu', objectId: denied.id, revision: 'accepted' }),
    channel: denied.channel!, text: '收到。', ticketId: deniedRequest.ticketId })
  await h.runtime.sendReplies()
  expect(acknowledgement(denied.id).status).toBe('dropped')
  expect(sent()).toBe(0)

  const { trigger, ticket } = await h.acceptedTicket(feishu('3', '@bot 再修一个'))
  expect(held().ticketId).toBe(ticket.id)
  const approval = request()
  await approve(approval)
  await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(acknowledgement(trigger.id).id)).toBe('sent')
  expect(sent()).toBe(1)
  expect(h.runtime.store.approvals.get(approval.id)?.state).toBe('approved')
})

it('drops a message granted at a lower level than it needs, and keeps it retryable under a new revision', async () => {
  const { trigger, ticket } = await h.acceptedTicket(feishu('4', '@bot 修一下回归'))
  const approval = request()
  await approve(approval, 'draft')
  await h.runtime.sendReplies()
  const receipt = acknowledgement(trigger.id)
  expect(receipt.status).toBe('dropped')
  expect(receipt.dropped).toMatchObject({ reason: 'approvalLevelInsufficient' })
  expect(h.runtime.store.approvals.get(approval.id)).toMatchObject({ state: 'approved', grantedLevel: 'draft' })
  expect(sent()).toBe(0)

  // A new revision is a new send Action, so it asks again instead of reusing the insufficient grant.
  const action = outboundAction({ kind: 'reply', source: 'feishu', objectId: trigger.id, revision: 'retry-1' })
  h.runtime.outbox.send({ action, channel: trigger.channel!, text: '再次请求。', ticketId: ticket.id })
  const retried = h.runtime.store.approvals.pending().find(row => row.action.idempotencyKey === action.idempotencyKey)!
  await approve(retried)
  await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(action.idempotencyKey)).toBe('sent')
  expect(sent()).toBe(1)
})

it('recalls a message that waits for an approval, revoking the request and keeping it unsent', async () => {
  const { trigger, ticket } = await h.acceptedTicket(feishu('5', '@bot 修一下回归'))
  const receipt = held()
  const approval = request()
  expect(await h.api('POST', `outbox/${receipt.id}/recall`)).toMatchObject({ status: 200, body: { status: 'recalled' } })
  expect(h.runtime.store.approvals.get(approval.id)?.state).toBe('revoked')
  expect(h.runtime.store.approvals.pending()).toEqual([])
  await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(acknowledgement(trigger.id).id)).toBe('recalled')
  expect(sent()).toBe(0)
})

it('expires an undecided request and records why the message did not go', async () => {
  const { trigger, ticket } = await h.acceptedTicket(feishu('6', '@bot 修一下回归'))
  const approval = request()
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 25 * 60 * 60 * 1000 })
  try { await h.runtime.sendReplies() } finally { vi.useRealTimers() }
  const receipt = acknowledgement(trigger.id)
  expect(receipt.status).toBe('dropped')
  expect(receipt.dropped).toMatchObject({ reason: 'approvalExpired', values: { at: approval.expiresAt } })
  expect(h.runtime.store.approvals.get(approval.id)?.state).toBe('expired')
  expect(sent()).toBe(0)
})

it('refuses a message whose Mandate no longer authorizes its level, without asking for approval', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, maxActionLevel: 'draft' } })
  const { trigger } = await h.acceptedTicket(feishu('7', '@bot 修一下回归'))
  const receipt = acknowledgement(trigger.id)
  expect(receipt.status).toBe('dropped')
  expect(receipt.dropped).toMatchObject({ reason: 'actionLevelExceeded', values: { level: 'send', max: 'draft' } })
  expect(receipt.approvalId).toBeUndefined()
  expect(h.runtime.store.approvals.pending()).toEqual([])
  expect(sent()).toBe(0)
})

it('revalidates at release, so a Policy lowered while the request waited drops the approved message', async () => {
  const { trigger, ticket } = await h.acceptedTicket(feishu('9', '@bot 修一下回归'))
  const approval = request()
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, maxActionLevel: 'draft' } })
  await approve(approval)
  await h.runtime.sendReplies()
  const receipt = acknowledgement(trigger.id)
  expect(receipt.status).toBe('dropped')
  expect(receipt.dropped).toMatchObject({ reason: 'actionLevelExceeded', values: { level: 'send', max: 'draft' } })
  expect(h.runtime.store.approvals.get(approval.id)?.state).toBe('approved')
  expect(sent()).toBe(0)
})

it('lets the Policy approve an internal target itself, and never approves a spend automatically', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, maxActionLevel: 'spend',
    approval: { sources: { feishu: { domains: ['corp.example'], always: true } } } } })
  const { trigger, ticket } = await h.acceptedTicket(feishu('8', '@bot 修一下回归'))
  // The acknowledgement targets a chat id, which is not a domain; it stays for a person.
  expect(request()).toMatchObject({ state: 'requested', target: CHAT })
  await approve(request())
  await h.runtime.sendReplies()
  expect(sent()).toBe(1)

  const channel = trigger.channel!
  const action = outboundAction({ kind: 'reply', source: 'feishu', objectId: trigger.id, revision: 'auto-1' })
  h.runtime.outbox.send({ action, channel, text: '内部文档。', ticketId: ticket.id, target: 'https://corp.example/doc/1' })
  await h.runtime.sendReplies()
  expect(h.runtime.store.replyStatus(action.idempotencyKey)).toBe('sent')
  expect(h.runtime.store.approvals.pending()).toEqual([])
  expect(sent()).toBe(2)

  // A spend is never automatic, even on the same internal target and outside any working-hours question.
  const spend = createAction({ kind: 'payment', source: 'feishu', objectId: trigger.id, revision: 'spend-1', actor: OUTBOX_ACTOR, level: 'spend',
    cost: { kind: 'money', amount: 100, currency: 'CNY' } })
  const outcome = requestActionApproval(h.runtime.store, { ticket, action: spend, target: 'https://corp.example/doc/1',
    policy: settingsPolicy(h.runtime.store.settings(), h.runtime.sources), approvalPolicy: h.runtime.store.settings().policy.approval })
  expect(outcome).toMatchObject({ ok: true, approval: { state: 'requested', action: { level: 'spend' }, target: 'https://corp.example/doc/1' } })
  expect(h.runtime.store.approvals.pending().map(row => row.id)).toContain(outcome.ok ? outcome.approval.id : '')
})