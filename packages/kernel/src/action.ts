/** Actions: what a worker may do beyond reading, graded by how far its effect reaches. */
import type { ActorRef } from './model.ts'
import { key } from './ids.ts'

/**
 * The five action levels, from an effect inside the worker to one that leaves the system or spends real money:
 * `read` changes nothing; `draft` produces internal objects; `commit` writes a shared workspace; `send` leaves the
 * system's boundary; `spend` costs money or another person's time.
 */
export type ActionLevel = 'read' | 'draft' | 'commit' | 'send' | 'spend'

/** The levels in their order of consequence, which is also the order of any `maxActionLevel` comparison. */
export const ACTION_LEVELS: readonly ActionLevel[] = ['read', 'draft', 'commit', 'send', 'spend']

/** What a spend action consumes: money, or time taken from another person, as a calendar booking does. */
export type ActionCost =
  | { kind: 'money'; amount: number; currency: string }
  | { kind: 'time'; minutes: number }

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
    if (!cost.currency) throw new TypeError('A money cost needs a currency')
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