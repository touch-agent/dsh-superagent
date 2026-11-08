/** Actions: what a worker may do beyond reading, graded by how far its effect reaches. */
import type { ActorRef, ChannelRef } from './model.ts'
import { key } from './ids.ts'

/** The levels in their order of consequence, which is also the order of any `maxActionLevel` comparison. */
export const ACTION_LEVELS = ['read', 'draft', 'commit', 'send', 'spend'] as const

/**
 * The five action levels, from an effect inside the worker to one that leaves the system or spends real money:
 * `read` changes nothing; `draft` produces internal objects; `commit` writes a shared workspace; `send` leaves the
 * system's boundary; `spend` costs money or another person's time.
 */
export type ActionLevel = typeof ACTION_LEVELS[number]

/** What a spend action consumes: money, or time taken from another person, as a calendar booking does. */
export type ActionCost =
  | { kind: 'money'; amount: number; currency: string }
  | { kind: 'time'; minutes: number }

/** The kinds of message an outbox writes; each is also the action kind of the send it records. */
export const OUTBOUND_KINDS = ['acknowledgement', 'reply', 'notice'] as const
/** What an outbound message is for: a person's request taken up, an answer or result, or an automated notice. */
export type OutboundKind = typeof OUTBOUND_KINDS[number]

/** The system actor that writes through the outbox: the agent, not the person whose request it carries out. */
export const OUTBOX_ACTOR: ActorRef = { source: 'dsh-superagent', id: 'outbox' }

/** What an action is and the exact revision of the object it applies to, before its idempotency key is derived. */
export interface ActionIdentity {
  /** The kind of action in the Source's vocabulary, such as `mail.reply` or `calendar.invite`. */
  kind: string
  /** The Source that owns the object acted on, such as `feishu` or `github`. */
  source: string
  /** The object's id in that Source, such as a message id, a document id or a pull request number. */
  objectId: string
  /** The revision the action was prepared against; a newer revision is a different action. */
  revision: string
  /** The person or agent acting. */
  actor: ActorRef
  level: ActionLevel
}

/**
 * One action instance: its identity, the level it was graded at, and its derived idempotency key. A `spend` action
 * always says what it costs; no other level carries a cost.
 */
export type Action = Omit<ActionIdentity, 'level'> &
  ({ level: 'spend'; cost: ActionCost; idempotencyKey: string }
  | { level: Exclude<ActionLevel, 'spend'>; cost?: undefined; idempotencyKey: string })

/** Whether a value names one of the five action levels. */
export const isActionLevel = (value: unknown): value is ActionLevel =>
  typeof value === 'string' && (ACTION_LEVELS as readonly string[]).includes(value)

/** The level a Policy authorizes unless it explicitly raises it: writing internal drafts, never sending. */
export const DEFAULT_MAX_ACTION_LEVEL: ActionLevel = 'draft'

/**
 * Whether `level` is at or below `max` in the consequence order. A maximum therefore permits itself and every level
 * below it; an unknown level permits nothing.
 */
export function withinActionLevel(level: ActionLevel, max: ActionLevel): boolean {
  const at = ACTION_LEVELS.indexOf(level), limit = ACTION_LEVELS.indexOf(max)
  return at >= 0 && limit >= 0 && at <= limit
}

/**
 * The key that makes an action repeatable: equal identities produce equal keys, while another level, revision, actor,
 * object or kind always names another action. The same action therefore has one key on every attempt, and the five
 * levels of one object never share one.
 */
export function actionKey(identity: ActionIdentity): string {
  return key(identity.source, identity.objectId, identity.kind, identity.level, identity.revision,
    identity.actor.source, identity.actor.id)
}

/** Refuse a cost whose amount, currency or duration cannot describe a real charge. */
function checkCost(cost: ActionCost): void {
  if (cost.kind === 'money') {
    if (!Number.isFinite(cost.amount) || cost.amount <= 0) throw new TypeError('A money cost needs a positive amount')
    if (typeof cost.currency !== 'string' || !cost.currency.trim()) throw new TypeError('A money cost needs a currency')
    return
  }
  if (cost.kind === 'time') {
    if (!Number.isFinite(cost.minutes) || cost.minutes <= 0) throw new TypeError('A time cost needs a positive number of minutes')
    return
  }
  throw new TypeError(`Unknown action cost: ${String((cost as { kind?: unknown }).kind)}`)
}

/**
 * Build an Action and derive its idempotency key. Refuses a level outside the five, a spend without a money or time
 * cost, and a cost on a level that spends nothing.
 */
export function createAction(input: ActionIdentity & { cost?: ActionCost }): Action {
  if (!isActionLevel(input.level)) throw new TypeError(`Unknown action level: ${String(input.level)}`)
  const { kind, source, objectId, revision, actor } = input
  const idempotencyKey = actionKey(input)
  if (input.level === 'spend') {
    const cost = input.cost
    if (!cost) throw new TypeError('A spend action must carry a money or time cost')
    checkCost(cost)
    return { kind, source, objectId, revision, actor, idempotencyKey, level: 'spend', cost }
  }
  if (input.cost !== undefined) throw new TypeError('Only a spend action carries a cost')
  return { kind, source, objectId, revision, actor, idempotencyKey, level: input.level }
}

/** An Action whose kind names an outbound write; the Outbox and its receipts carry this narrower shape. */
export type OutboundAction = Action & { kind: OutboundKind }

/** What a caller supplies to describe an outbound write, before its `send` Action and key are derived. */
export interface OutboundActionInput {
  /** What the message is for; it is also the Action's kind. */
  kind: OutboundKind
  /** The Source that owns the object written on, such as the conversation's Source. */
  source: string
  /** The object's id in that Source: the Trigger answered, the question asked, or the pull request reported. */
  objectId: string
  /** The content revision: the same revision is the same write, a new one is another message. */
  revision: string
  /** Who writes; the system outbox actor unless a caller names another. */
  actor?: ActorRef
}

/**
 * Build the `send` Action an outbound message carries. Its idempotency key becomes the message id and the `reply`
 * effect's key, so two revisions of one write are two effects and a replay of one revision is one.
 */
export function outboundAction(input: OutboundActionInput): OutboundAction {
  return createAction({ kind: input.kind, source: input.source, objectId: input.objectId, revision: input.revision,
    actor: input.actor ?? OUTBOX_ACTOR, level: 'send' }) as OutboundAction
}

/** The send Action of an acknowledgement of `triggerId`, sent into `channel`; who accepted it does not change its key. */
export function acknowledgementAction(channel: Pick<ChannelRef, 'source'>, triggerId: string): OutboundAction {
  return outboundAction({ kind: 'acknowledgement', source: channel.source, objectId: triggerId, revision: 'accepted' })
}
