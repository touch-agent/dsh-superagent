/**
 * Turns the person's latest message into one or more conversation Triggers and accepts them deterministically. How a
 * message is split follows the `dispatch` settings block (docs/009): `single` keeps one Ticket, `explicit` splits only an
 * explicit list, and `auto` takes the main Session's items. Every intent a message becomes is its own Trigger with the
 * same `meta.messageId`, so the source message keeps an auditable link to each Ticket it started.
 */
import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { UserError, reasonText, threadKey, type AssessmentOutcome, type Decision, type ReceiveResult, type Ticket, type Trigger,
  type TriggerDisposition } from '@superagent/kernel'
import type { DispatchMode } from '../policy.ts'
import { conversationTrigger } from '../sources/conversation.ts'

/** The slice of a DSH Agent this module reads: its identity and its session log. */
export interface ConversationAgent {
  readonly id: string
  readonly session: { snapshotEvents(): readonly SessionEvent[] }
}
export interface PersonMessage { id: string; text: string; at: string }
/** One item the main Session read from the message in `auto` mode, or the whole message's single item. */
export interface DispatchItemInput {
  title?: string
  scope?: string
  acknowledgement?: string
  ticketId?: string
  note?: string
  name?: string
  /** Set only for one read-only repository lookup the inline executor can finish; omitted means tracked. */
  form?: 'lightweight'
}
export interface DispatchInput extends DispatchItemInput {
  /** Distinct requests the main Session found in the message, for `auto` mode. */
  items?: DispatchItemInput[]
}
/** What dispatch reads of the settings block; `single` and five tickets when a host gives none. */
export interface DispatchConfigView { mode: DispatchMode; maxTickets: number }
export interface DispatchHost {
  engine: { receive(trigger: Trigger): ReceiveResult; decide(triggerId: string, outcome: AssessmentOutcome): Decision;
    attach(ticketId: string, triggerId: string, note?: string): Ticket }
  disposition(triggerId: string): TriggerDisposition | undefined
  ticket(id: string): Ticket | undefined
  /** The Thread a message's Triggers share, read before receiving a split so a reachable ticket is never mutated by a refused dispatch. */
  thread?(key: string): { subscriptions: readonly string[]; context?: readonly string[] } | undefined
  config?(): DispatchConfigView
}
/** What happened to one item: its Trigger, the Ticket it started or joined, or why it did not. */
export interface DispatchItemResult {
  triggerId: string
  title: string
  ticketId?: string
  attached?: boolean
  duplicate?: boolean
  refused?: string
}
export type DispatchResult =
  | { triggerId: string; duplicate: boolean; attached?: boolean; ticket?: Ticket; tickets?: Ticket[]; items?: DispatchItemResult[] }
  | { refused: string }
interface PlannedItem {
  title: string
  scope: string
  name: string
  acknowledgement?: string
  ticketId?: string
  note?: string
  form?: 'lightweight'
}
interface Plan { items: PlannedItem[]; split: boolean }

const TITLE_CHARS = 80
const SCOPE_CHARS = 2000
const INLINE_ITEM_CHARS = 200
const MAX_INLINE_CHARS = 600
const DEFAULT_CONFIG: DispatchConfigView = { mode: 'single', maxTickets: 5 }
const NUMBERED = /^(?:\d{1,3}[、.．)）]|[一二三四五六七八九十]{1,3}[、.．)）]|[①-⑳])\s*(.+)$/u
const BULLETED = /^(?:[-*•·]|\d{1,3}[.)])\s+(.+)$/u
const CJK = /[\u3400-\u9fff]/u

/** Derives a valid ticket worktree name from a title's English words, falling back to `conversation` for a non-Latin title. */
export function worktreeName(title: string): string {
  const words = title.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []
  const slug = words.slice(0, 4).join('-').slice(0, 32).replace(/-+$/u, '')
  return slug || 'conversation'
}
const clean = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim()
const cut = (text: string, chars: number): string => Array.from(text).slice(0, chars).join('')
/** A short label for one item: its first line or sentence, without a list marker or trailing punctuation. */
function titleFrom(text: string): string {
  const first = text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? text
  const body = first.replace(/^(?:\d{1,3}[、.．)）]|[一二三四五六七八九十]{1,3}[、.．)）]|[①-⑳]|[-*•·])\s*/u, '')
  const label = cut(body, TITLE_CHARS).replace(/[。；;：:，,、.!?！？\s]+$/u, '').trim()
  return label || 'Task'
}
const receipt = (title: string, source: string): string => CJK.test(source) ? `已拆成任务：${title}。` : `Split into a task: ${title}.`
/** The identity of an item: its target ticket, title and scope, so the same request to two tickets is not merged. */
const intentText = (item: PlannedItem): string => `${item.title}\n${item.scope}${item.ticketId ? `\n${item.ticketId}` : ''}`
const intentKey = (item: PlannedItem): string => createHash('sha256').update(intentText(item)).digest('hex').slice(0, 12)
const sameIntent = (item: PlannedItem): string => intentText(item).toLowerCase().replace(/\s+/gu, ' ').trim()
/** Whether a Thread already reached a ticket that decides it, rather than one that only follows it for context. */
const reachedThread = (thread: { subscriptions: readonly string[]; context?: readonly string[] } | undefined): boolean =>
  !!thread?.subscriptions.some(ticketId => !thread.context?.includes(ticketId))

/**
 * The latest message in the main Session must be the person's, not a notice or relay the plugin delivered; otherwise the
 * main agent has no request to dispatch and the call is refused. Only text is dispatched.
 */
export function latestPersonMessage(agent: ConversationAgent): PersonMessage | undefined {
  const last = agent.session.snapshotEvents().filter(event => event.type === 'user/message').at(-1)
  if (!last || last.type !== 'user/message' || last.data.source?.kind !== 'user') return undefined
  const text = last.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  if (!text) return undefined
  return { id: String(last.data.id), text, at: new Date(last.time).toISOString() }
}

/** Splits an inline list such as `A、B、C` or `Fix A, Fix B`; too short or too long a list is no split. */
function inlineItems(text: string): string[] | undefined {
  const body = text.replace(/\s+/g, ' ').trim()
  if (body.length > MAX_INLINE_CHARS) return undefined
  const items = body.split(/[、；;\r\n]+|，|,/u).map(item => item.trim().replace(/[。.!?！？；;]+$/u, '').trim()).filter(Boolean)
  if (items.length < 2 || items.some(item => item.length > INLINE_ITEM_CHARS || !/[\p{L}\p{N}]/u.test(item))) return undefined
  return items
}

/**
 * Reads an explicit list from a message, deterministically: a numbered or bulleted list of at least two lines, a
 * confirmation line followed by lines, or a launching/confirming phrase followed by an inline list such as
 * `开 A、B、C` or `确认：A、B`. Anything less explicit, or any list that is not clearly the message's content, is no
 * split, so dispatch keeps one Ticket.
 */
export function explicitItems(text: string): string[] | undefined {
  // A question about items is a status question, not an instruction to split them.
  if (/(?:[?？]|没有|没|吧|怎么样)\s*$/u.test(text) || /(?:吗|么)[。.!！?？\s]*$/u.test(text)) return undefined
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const questions = /(?:[?？]|没有|没|吧|怎么样|是否|状态|进展|完成情况|都完成)[。.!！?？\s]*$/u
  // An inline list asking whether or how items are doing is a status question; a multi-line task list is not.
  if (lines.length === 1 && /[、,，]/u.test(text) && /(?:是否|状态|进展|完成情况|都完成)/u.test(text)) return undefined
  if (lines.length > 1 && lines.every(line => questions.test(line))) return undefined
  if (lines.length >= 2) {
    // One non-item line before the list is its lead-in; any other prose means the list is not the message's content.
    const numbered = lines.flatMap(line => { const match = NUMBERED.exec(line); return match?.[1] ? [match[1].trim()] : [] })
    if (numbered.length >= 2 && numbered.length >= lines.length - (NUMBERED.test(lines[0]!) ? 0 : 1)) return numbered
    const bulleted = lines.flatMap(line => { const match = BULLETED.exec(line); return match?.[1] ? [match[1].trim()] : [] })
    if (bulleted.length >= 2 && bulleted.length >= lines.length - (BULLETED.test(lines[0]!) ? 0 : 1)) return bulleted
    if (/^(?:确认|确认任务|确认拆单|确认拆分)[：:]?$/u.test(lines[0]!) && lines.length >= 3) return lines.slice(1)
  }
  const lead = /^(?:请|帮我|麻烦)?\s*(?:确认|拆成|分成|拆为|拆分|拆单(?:为|成)?|开|新建|创建|安排)\s*(?:以下|下面|出)?\s*(?:任务|工单|单|事项)?\s*[：:]\s*(.+)$/u.exec(text)
    ?? /^(?:请|帮我|麻烦)?\s*(?:确认|拆成|分成|拆为|拆分)\s+(.+)$/u.exec(text)
    ?? /^(?:请|帮我|麻烦)?\s*(?:开|新建|创建|安排)\s+(.+)$/u.exec(text)
  return lead?.[1] ? inlineItems(lead[1]) : undefined
}

function plannedItem(input: DispatchItemInput, source: string): PlannedItem | undefined {
  const title = clean(input.title)
  const scope = clean(input.scope)
  const ticketId = clean(input.ticketId) || undefined
  if (!title && !scope && !ticketId) return undefined
  const label = title || titleFrom(scope) || titleFrom(source) || 'Existing ticket'
  return { title: cut(label, 200), scope: cut(scope || title || source || label, SCOPE_CHARS), name: worktreeName(clean(input.name) || label),
    ...input.acknowledgement?.trim() ? { acknowledgement: input.acknowledgement.trim() } : {},
    ...ticketId ? { ticketId } : {}, ...input.note?.trim() ? { note: input.note.trim() } : {},
    ...input.form === 'lightweight' ? { form: 'lightweight' } : {} }
}

/** Fills an item's missing acknowledgement with a short receipt, so every accepted ticket answers the source message. */
function withReceipt(item: PlannedItem, source: string): PlannedItem {
  return item.acknowledgement ? item : { ...item, acknowledgement: receipt(item.title, source) }
}

/** The one item a message becomes when dispatch does not split it, combining any items the main Session supplied. */
function singleItem(input: DispatchInput, text: string, fresh: readonly PlannedItem[] = []): PlannedItem | { refused: string } {
  // A combined fallback keeps every planned item it is given, not whatever the main Session supplied beside it.
  const supplied = fresh.length ? fresh.map(item => item.scope) : (input.items ?? []).map(item => clean(item.scope) || clean(item.title))
  const scopes = [...new Set(supplied.filter(Boolean))]
  const combined = scopes.join('\n')
  const title = clean(input.title) || clean(fresh[0]?.title) || clean(input.items?.[0]?.title)
    || titleFrom(clean(input.scope) || scopes[0] || text)
  // A combined fallback keeps every item rather than a caller's scope for only one of them; otherwise keep the message.
  const scope = (fresh.length > 1 ? combined : clean(input.scope) || combined) || cut(text.trim(), SCOPE_CHARS) || title
  const name = clean(input.name) || clean(fresh[0]?.name) || clean(input.items?.[0]?.name) || worktreeName(title)
  const acknowledgement = clean(input.acknowledgement)
    || (fresh.length > 1 ? receipt(title, text) : clean(fresh[0]?.acknowledgement) || clean(input.items?.[0]?.acknowledgement))
  if (!title || !scope) return { refused: 'A new dispatch needs a title and a scope; only an attach to an existing ticket omits them.' }
  // A combined fallback is one ticket: keep the lightweight form only when the whole item is one lookup.
  const forms = [...fresh, ...(input.items ?? [])]
  const form = input.form === 'lightweight' ? 'lightweight' : forms.length === 1 ? forms[0]!.form : undefined
  return { title: cut(title, 200), scope: cut(scope, SCOPE_CHARS), name: worktreeName(name),
    ...acknowledgement ? { acknowledgement } : {}, ...form ? { form } : {} }
}

/** Builds the tickets one message becomes, by the configured mode, and never loses work to a failed or over-wide split. */
function planDispatch(input: DispatchInput, text: string, config: DispatchConfigView): Plan | { refused: string } {
  // The single mode keeps the tool's original contract: the main Session names what it dispatches.
  if (config.mode === 'single' && !input.title && !input.scope && !input.items?.length) {
    return { refused: 'A new dispatch needs a title and a scope; only an attach to an existing ticket omits them.' }
  }
  const fallback = (parsed?: readonly PlannedItem[]): Plan | { refused: string } => {
    const item = singleItem(input, text, parsed)
    return 'refused' in item ? item : { items: [item], split: false }
  }
  const single = config.mode === 'single'
  let items: PlannedItem[] | undefined
  if (single) items = input.items?.flatMap(item => plannedItem(item, text) ?? [])
  else if (config.mode === 'auto' && input.items?.length) items = input.items.flatMap(item => plannedItem(item, text) ?? [])
  else if (config.mode !== 'single') items = explicitItems(text)?.flatMap(item => plannedItem({ title: titleFrom(item), scope: item }, text) ?? [])
  // One item that names a ticket is an attach, not new work; a whole-message attach normally takes the other path.
  if (items?.length === 1 && items[0]!.ticketId) return { items, split: false }
  if (!items || items.length < 2) {
    // One Session item must not hide the rest of an explicit list: combine the list, and the Session's item, into one ticket.
    const listed = config.mode === 'auto' && items?.length ? explicitItems(text)?.flatMap(item =>
      plannedItem({ title: titleFrom(item), scope: item }, text) ?? []) : undefined
    if (listed?.length) {
      const seen = new Set<string>()
      const merged = [...items ?? [], ...listed].filter(item => { const id = sameIntent(item); if (seen.has(id)) return false; seen.add(id); return true })
      return fallback(merged)
    }
    return fallback(items)
  }
  const seen = new Set<string>()
  const unique = items.filter(item => { const id = sameIntent(item); if (seen.has(id)) return false; seen.add(id); return true })
    .map(item => withReceipt(item, text))
  if (!unique.length) return fallback()
  const attaches = unique.filter(item => item.ticketId !== undefined)
  const fresh = unique.filter(item => item.ticketId === undefined)
  // Attaches start no ticket, so only the new items count against the bound. A split with only attaches still needs one
  // Trigger per target, because each Trigger attaches to a different ticket.
  if (!fresh.length) return { items: attaches, split: attaches.length > 1 }
  if (fresh.length === 1 && !attaches.length) return fallback(fresh)
  const maxTickets = single ? 1 : config.maxTickets
  if (fresh.length > maxTickets) {
    // Too many new items: one Ticket holds all of them, while every attach keeps its own target and is not lost.
    const combined = singleItem(input, text, fresh)
    if ('refused' in combined) return combined
    return { items: [combined, ...attaches], split: attaches.length > 0 }
  }
  return { items: unique, split: true }
}

/**
 * Records the message as one or more conversation Triggers and accepts them with direct Evals, so the Decisions,
 * Mandates and audit exist without a model assessment. With `ticketId` the whole message is attached to that ticket
 * instead, for a person's follow-up or status question. In `auto` mode `items` names the requests the main Session read;
 * in `explicit` mode an explicit list in the message is parsed; in `single` mode the message becomes one ticket. A
 * message dispatched before is not accepted again; `duplicate` says so.
 */
export function dispatchConversation(agent: ConversationAgent, host: DispatchHost, input: DispatchInput): DispatchResult {
  const message = latestPersonMessage(agent)
  if (!message) return { refused: 'The latest message is not text the person wrote, so there is no request to dispatch.' }
  // A whole-message attach keeps the original trigger id and the message text; it neither splits nor creates work.
  if (input.ticketId) {
    const trigger = conversationTrigger({ messageId: message.id, text: message.text, at: message.at, sessionId: agent.id })
    // Any disposition means the message was received before, including an attach that withdraws its pending Trigger
    // rather than deciding it; repeating it is a duplicate, not a changed plan.
    if (host.disposition(trigger.id)) return { triggerId: trigger.id, duplicate: true }
    // A whole-message attach shares the message's Thread: if that Thread already reached a ticket, receiving it here would
    // add an input to those siblings before the attach. Refuse before receiving, as a changed split plan does.
    if (reachedThread(host.thread?.(threadKey(trigger.threads[0]!)))) {
      return { refused: 'This message already reached a ticket; attach the new request to that ticket or send it in a new message.' }
    }
    const received = host.engine.receive(trigger)
    if (received === 'filtered') return { refused: 'The conversation Source is off, so the request was not received.' }
    if (received === 'duplicate') return { triggerId: trigger.id, duplicate: true }
    try {
      const ticket = host.engine.attach(input.ticketId, trigger.id, input.note)
      return { triggerId: trigger.id, duplicate: false, attached: true, ticket }
    } catch (error) {
      if (error instanceof UserError) return { refused: error.message }
      throw error
    }
  }
  const config = host.config?.() ?? DEFAULT_CONFIG
  const plan = planDispatch(input, message.text, config)
  if ('refused' in plan) return plan
  const results: DispatchItemResult[] = []
  const tickets: Ticket[] = []
  const triggerIds: string[] = []
  // A split intent gets its own stable Trigger id from the source message and the item, so re-dispatching the same plan is
  // idempotent and every ticket keeps a link to the message it came from.
  const prepared = plan.items.map((item, index) => {
    const trigger = conversationTrigger({ messageId: message.id, text: plan.split ? item.scope : message.text, at: message.at,
      sessionId: agent.id, ...plan.split ? { intent: { key: intentKey(item), index, count: plan.items.length } } : {} })
    triggerIds.push(trigger.id)
    return { item, trigger }
  })
  if (prepared.every(entry => host.disposition(entry.trigger.id))) {
    return { triggerId: triggerIds[0]!, duplicate: true, ...plan.split ? { items: prepared.map(entry => ({ triggerId: entry.trigger.id,
      title: entry.item.title, duplicate: true })) } : {} }
  }
  // A changed plan for a message that already reached a ticket must be refused before receiving anything: receiving would
  // add its Triggers to that ticket as inputs and the decision would then fail, leaving the conversation changed.
  if (reachedThread(host.thread?.(threadKey(prepared[0]!.trigger.threads[0]!)))) {
    return { refused: 'This message already reached a ticket; attach the new request to that ticket or send it in a new message.' }
  }
  // Receive every item before deciding any of them: once the first ticket exists it subscribes to the shared thread, and a
  // later item received then would reach that ticket as a follow-up instead of becoming a ticket of its own.
  const receivedItems = prepared.map(entry => ({ ...entry, received: host.engine.receive(entry.trigger) }))
  for (const { item, trigger, received } of receivedItems) {
    const head = { triggerId: trigger.id, title: item.title }
    if (received === 'filtered') { results.push({ ...head, refused: 'The conversation Source is off, so the request was not received.' }); continue }
    if (host.disposition(trigger.id)?.decisionId || received === 'duplicate') { results.push({ ...head, duplicate: true }); continue }
    try {
      if (item.ticketId) {
        const ticket = host.engine.attach(item.ticketId, trigger.id, item.note ?? input.note)
        tickets.push(ticket)
        results.push({ ...head, ticketId: ticket.id, attached: true })
        continue
      }
      const decision = host.engine.decide(trigger.id, { kind: 'accept', title: item.title, scope: item.scope, name: item.name,
        reason: 'Dispatched from the conversation', ...(item.acknowledgement ? { acknowledgement: item.acknowledgement } : {}),
        ...(item.form ? { form: item.form } : {}) })
      if (!decision.ticketId) { results.push({ ...head, refused: `Ticket was not created: ${reasonText(decision.reason)}` }); continue }
      const ticket = host.ticket(decision.ticketId)
      if (ticket) tickets.push(ticket)
      results.push({ ...head, ticketId: decision.ticketId })
    } catch (error) {
      if (!(error instanceof UserError)) throw error
      results.push({ ...head, refused: error.message })
    }
  }
  if (results.every(result => result.duplicate)) return { triggerId: triggerIds[0]!, duplicate: true, ...plan.split ? { items: results } : {} }
  const first = results.find(result => result.ticketId)
  if (!first) return { refused: results[0]?.refused ?? 'No ticket was created.' }
  if (!plan.split) return { triggerId: triggerIds[0]!, duplicate: false, ...first.attached ? { attached: true } : {},
    ...tickets[0] ? { ticket: tickets[0] } : {} }
  return { triggerId: triggerIds[0]!, duplicate: false, ...tickets[0] ? { ticket: tickets[0] } : {}, tickets, items: results }
}