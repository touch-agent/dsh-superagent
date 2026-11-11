/**
 * Read-only observation of the organization and attention costs a replacement drills, derived from the Store's own
 * records. It never writes and never reads a panel view: the same figures are available from trace, activity and
 * metrics alone, so hiding the task view cannot take the evidence with it.
 *
 * Organization cost depends on the task-tree data (depth, active children, parent review waits, orphans). Attention
 * cost counts the messages and graded events a result produced; the two browser-side measures the design plan names
 * (auto-open close rate and default-surface click depth) are reported as `not-collected`, never as zero.
 */
import { childUnresolved, latestAssignment, type Ticket } from '@superagent/kernel'
import type { ActivityLevel, ActivityRecord } from './activity.ts'
import type { Receipt, Store } from './store.ts'

/** Seconds between two stored timestamps, or null when either is missing or unreadable. */
function seconds(from: string | undefined, to: string | undefined): number | null {
  if (!from || !to) return null
  const start = Date.parse(from), end = Date.parse(to)
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? null : (end - start) / 1000
}
/** A nearest-rank quantile, or null for no samples. */
function quantile(values: number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!)
}
/** Whether a child still has work its parent has not resolved. */
function activeChild(child: Ticket): boolean {
  if (child.ended) return false
  if (child.undelivered.length) return true
  return latestAssignment(child)?.state === 'pending' || latestAssignment(child)?.state === 'running'
}

/** Organization cost: how deep the tree is, which children are active, how long parents took to review, and orphans. */
export interface OrganizationMetrics {
  tickets: {
    roots: number
    children: number
    open: number
    openChildren: number
    /** The deepest ticket in the tree; a root alone is depth 0. */
    maxDepth: number
    medianDepth: number | null
    /** Ticket count per depth, keyed by the number as text for JSON. */
    depthDistribution: Record<string, number>
  }
  children: {
    /** Open children that still have undelivered work or a pending/running assignment. */
    active: number
    maxActivePerRoot: number
    rootsWithActiveChildren: number
    /** Children marked orphaned because their parent or root went away. */
    orphaned: number
    /** Unresolved children, whether or not they are orphaned. */
    unresolved: number
  }
  parentReview: { samples: number; medianSeconds: number | null; p90Seconds: number | null }
}

/** Attention cost: what each result cost in messages and graded events, plus the measures the browser alone can see. */
export interface AttentionMetrics {
  /** Ended root Tickets: the results attention is attributed to. */
  results: number
  notifications: {
    /** Outbound messages that name a Ticket, over the whole Store, by kind. */
    sends: number
    perResult: number | null
    kinds: Record<'acknowledgement' | 'reply' | 'notice', number>
  }
  activity: {
    /** The retained activity window, by level; the feed keeps the newest 5,000 records. */
    quiet: number
    feed: number
    notice: number
    noticesPerResult: number | null
  }
  /** The event panel's first auto-open and how often a person closed it at once; the browser does not report it yet. */
  autoOpen: { samples: 0; closeRate: null; status: 'not-collected'; reason: string }
  /** How many clicks it took to reach a result from the default surface; the browser does not report it yet. */
  clickDepth: { samples: 0; medianClicks: null; status: 'not-collected'; reason: string }
}

/** The Store reads the replacement observation needs, so a test can pass a Store or a partial double. */
export interface ReplacementStore {
  tickets: { allList: () => Ticket[]; get: (id: string) => Ticket | undefined }
  db: Store['db']
}

/** The depth of `ticket` under its root, following `parentTicketId`; a root is 0. */
function depthOf(ticket: Ticket, read: (id: string) => Ticket | undefined): number {
  let depth = 0, current = ticket
  const seen = new Set<string>([ticket.id])
  while (current.parentTicketId) {
    if (seen.has(current.parentTicketId)) return depth
    seen.add(current.parentTicketId)
    const parent = read(current.parentTicketId)
    if (!parent) return depth
    depth += 1
    current = parent
  }
  return depth
}

/**
 * Reads the organization cost of `store`. Every figure is derived from stored Tickets; a missing sample is null, never 0.
 */
export function organizationMetrics(store: ReplacementStore): OrganizationMetrics {
  const all = store.tickets.allList()
  const read = (id: string) => store.tickets.get(id)
  const roots = all.filter(ticket => !ticket.parentTicketId)
  const children = all.filter(ticket => !!ticket.parentTicketId)
  const depths = all.map(ticket => depthOf(ticket, read))
  const depthDistribution: Record<string, number> = {}
  for (const depth of depths) depthDistribution[String(depth)] = (depthDistribution[String(depth)] ?? 0) + 1
  const openChildren = children.filter(ticket => !ticket.ended)
  const activeByRoot = new Map<string, number>()
  for (const child of children) {
    if (!activeChild(child)) continue
    const root = child.rootTicketId ?? child.parentTicketId!
    activeByRoot.set(root, (activeByRoot.get(root) ?? 0) + 1)
  }
  const active = [...activeByRoot.values()].reduce((sum, count) => sum + count, 0)
  const reviews = children.flatMap(child => (child.delegation?.dispositions ?? []).flatMap(disposition => {
    const waited = seconds(disposition.reportAt, disposition.at)
    return waited === null ? [] : [waited]
  }))
  return {
    tickets: {
      roots: roots.length,
      children: children.length,
      open: all.filter(ticket => !ticket.ended).length,
      openChildren: openChildren.length,
      maxDepth: depths.length ? Math.max(...depths) : 0,
      medianDepth: quantile(depths, 0.5),
      depthDistribution,
    },
    children: {
      active,
      maxActivePerRoot: activeByRoot.size ? Math.max(...activeByRoot.values()) : 0,
      rootsWithActiveChildren: activeByRoot.size,
      orphaned: children.filter(child => !!child.delegation?.orphaned).length,
      unresolved: children.filter(child => childUnresolved(child)).length,
    },
    parentReview: { samples: reviews.length, medianSeconds: quantile(reviews, 0.5), p90Seconds: quantile(reviews, 0.9) },
  }
}

/** The receipt fields the attention figures read; a receipt is stored as JSON in the `outbox` table. */
const receipts = (store: ReplacementStore): Receipt[] =>
  store.db.prepare('SELECT value FROM outbox ORDER BY rowid').all().map(row => JSON.parse(String(row.value)) as Receipt)
/** The retained activity records, oldest first. */
const activity = (store: ReplacementStore): ActivityRecord[] =>
  store.db.prepare('SELECT value FROM activity ORDER BY seq').all().map(row => JSON.parse(String(row.value)) as ActivityRecord)

/**
 * Reads the attention cost of `store`: messages per ended result and the graded activity the feed retained, plus the
 * two browser-side measures no server record holds. The browser measures are `not-collected`, because claiming a zero
 * would read as "attention was free".
 */
export function attentionMetrics(store: ReplacementStore): AttentionMetrics {
  const all = store.tickets.allList()
  const roots = all.filter(ticket => !ticket.parentTicketId)
  const endedRoots = new Set(roots.filter(ticket => !!ticket.ended).map(ticket => ticket.id))
  const messages = receipts(store)
  const kinds: Record<'acknowledgement' | 'reply' | 'notice', number> = { acknowledgement: 0, reply: 0, notice: 0 }
  let sends = 0
  for (const message of messages) {
    if (message.ticketId === undefined || !endedRoots.has(message.ticketId)) continue
    sends += 1
    if (message.kind === 'acknowledgement' || message.kind === 'reply' || message.kind === 'notice') kinds[message.kind] += 1
  }
  const levels: Record<ActivityLevel, number> = { quiet: 0, feed: 0, notice: 0 }
  for (const record of activity(store)) levels[record.level] += 1
  const results = endedRoots.size
  return {
    results,
    notifications: { sends, perResult: results ? Math.round((sends / results) * 100) / 100 : null, kinds },
    activity: { ...levels, noticesPerResult: results ? Math.round((levels.notice / results) * 100) / 100 : null },
    autoOpen: { samples: 0, closeRate: null, status: 'not-collected',
      reason: 'Auto-open and its close happen in the panel; the browser reports no event to the server.' },
    clickDepth: { samples: 0, medianClicks: null, status: 'not-collected',
      reason: 'Default-surface clicks stay in the client route memory; nothing is sent to the server.' },
  }
}