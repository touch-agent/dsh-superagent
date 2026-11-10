/**
 * The read-only context-group (shared space) projection.
 *
 * A group is derived on read from a Ticket's Source Channel addresses and the Threads it currently follows: it has no
 * table, no migration, no member list and no write path. It is context and display only, so reading or assembling a group
 * grants no action and does not stand in for the Mandate/Action gate. An absent group means the dimension stays unassembled;
 * once the Ticket drops its last subscription in the shared space, the group disappears without rewriting the Ticket or the
 * work already produced. A closed PR/followed Thread does not by itself drop the subscription (GitHub keeps it for a later
 * resume), so the group stays until the subscription is removed. A child Ticket has no group of its own; T5-04's assembly
 * inherits the root's group, while this projection stays strictly per-Ticket.
 */
import type { ChannelRef, Thread, ThreadRef, Ticket, Trigger } from '@superagent/kernel'
import type { ContextSpaceRef } from '../sources/kind.ts'

/** One Ticket's shared space, from its Channel address and the Threads it still follows. */
export interface ContextGroupView {
  /** Stable `<source>:<space>` key; it is also the identity a caller may show, not an authorization scope. */
  key: string
  source: string
  /** The shared-space address in the Source's own vocabulary, such as a chat ID or `owner/name`. */
  space: string
  label?: string
  url?: string
  /** Visibility is the Source's: this projection carries no member list and cannot widen or narrow what the Source exposes. */
  visibility: 'source'
  /** Threads whose Source-declared conventions are the group's read-only convention sources, newest activity first. */
  conventions: string[]
}

/** One group in `GET contexts/groups`, with the Tickets currently deriving it; Tickets are work, not members. */
export interface ContextGroupBoardEntry extends ContextGroupView { tickets: string[] }

/** The read-only groups list: a view over Tickets and Threads, not an authorization aggregate. */
export interface ContextGroupBoardView {
  generatedAt: string
  groups: ContextGroupBoardEntry[]
  totals: { groups: number; tickets: number }
}

/** The Store and Source reads the projection needs; every other capability stays out of this module. */
export interface ContextGroupReadHost {
  readonly store: {
    tickets: { allList(): Ticket[] }
    triggers: { get(id: string): Trigger | undefined }
    read: { subscribedThreads(): Thread[] }
  }
  readonly sources: {
    contextGroup(channel: Pick<ChannelRef, 'source' | 'address'>): (ContextSpaceRef & { source: string }) | undefined
    threadSpace(thread: ThreadRef): string | undefined
  }
}

/** A T5-04 assembly entry: the fields every context dimension declares, whether or not the dimension is present. */
export interface ContextDimensionEntry {
  key: string
  source: string
  scope: string
  strength: 'constraint' | 'default'
  inheritance: 'inherit' | 'private'
  /** Character ceiling the assembler applies when several entries compete for the same key. */
  truncation: number
  text: string
}

const groupKey = (source: string, space: string): string => `${source}:${space}`
/**
 * The live Threads among `threads` that belong to `space`, newest activity first. Callers pass only Threads whose subscription
 * list still names the Ticket, so a dropped subscription (unsubscribe or leaving the space) removes the group dimension. A
 * closed PR/followed Thread keeps its subscription and therefore its group until the subscription is removed. The Ticket's
 * `follows` record is not enough on its own: it is history, not liveness.
 */
function liveThreads(host: ContextGroupReadHost, threads: Thread[], space: ContextSpaceRef & { source: string }): Thread[] {
  return threads.filter(thread => thread.ref.source === space.source && host.sources.threadSpace(thread.ref) === space.space)
    .sort((left, right) => (right.lastAt ?? right.createdAt).localeCompare(left.lastAt ?? left.createdAt) || left.key.localeCompare(right.key))
}

/** Every Channel that may name a shared space, the origin Trigger's first, without duplicates. */
function channelsOf(host: ContextGroupReadHost, ticket: Ticket): Pick<ChannelRef, 'source' | 'address'>[] {
  const channels: Pick<ChannelRef, 'source' | 'address'>[] = []
  const seen = new Set<string>()
  const add = (channel: Pick<ChannelRef, 'source' | 'address'> | undefined) => {
    if (!channel) return
    const identity = JSON.stringify([channel.source, channel.address])
    if (seen.has(identity)) return
    seen.add(identity)
    channels.push(channel)
  }
  add(host.store.triggers.get(ticket.origin.triggerId)?.channel)
  for (const channel of ticket.channels ?? []) add(channel)
  return channels
}

/**
 * The optional group dimension of `ticket`, or undefined when it has no shared-space Channel, the Channel is private, or the
 * Ticket no longer follows any Thread of that space. It reads only; it never writes a Ticket, Thread or Mandate.
 */
export function contextGroupOf(host: ContextGroupReadHost, ticket: Ticket): ContextGroupView | undefined {
  const threads = host.store.read.subscribedThreads().filter(thread => thread.subscriptions.includes(ticket.id))
  return contextGroupAmong(host, ticket, threads)
}

/** Derives one Ticket's group from the live Threads a caller already read; the board uses it to keep the read to one query. */
function contextGroupAmong(host: ContextGroupReadHost, ticket: Ticket, threads: Thread[]): ContextGroupView | undefined {
  // A child Ticket has no group of its own, even if a later path subscribes it to a Thread: T5-04 owns root-to-child inheritance.
  if (ticket.parentTicketId) return undefined
  for (const channel of channelsOf(host, ticket)) {
    const space = host.sources.contextGroup(channel)
    if (!space) continue
    const live = liveThreads(host, threads, space)
    if (!live.length) continue
    return { key: groupKey(space.source, space.space), source: space.source, space: space.space,
      ...(space.label ? { label: space.label } : {}), ...(space.url ? { url: space.url } : {}),
      visibility: 'source', conventions: live.map(thread => thread.key) }
  }
  return undefined
}

/** Every group the existing Tickets derive, by key, with the Tickets that currently belong to it. */
export function contextGroupBoard(host: ContextGroupReadHost, now = new Date()): ContextGroupBoardView {
  const groups = new Map<string, ContextGroupBoardEntry>()
  // One subscription query for the whole board, indexed by Ticket, rather than one query per Ticket on the read route.
  const byTicket = new Map<string, Thread[]>()
  const activity = new Map<string, string>()
  for (const thread of host.store.read.subscribedThreads()) {
    activity.set(thread.key, thread.lastAt ?? thread.createdAt)
    for (const id of thread.subscriptions) {
      const list = byTicket.get(id)
      if (list) list.push(thread)
      else byTicket.set(id, [thread])
    }
  }
  for (const ticket of host.store.tickets.allList()) {
    const group = contextGroupAmong(host, ticket, byTicket.get(ticket.id) ?? [])
    if (!group) continue
    const existing = groups.get(group.key)
    if (!existing) {
      groups.set(group.key, { ...group, tickets: [ticket.id] })
      continue
    }
    if (!existing.tickets.includes(ticket.id)) existing.tickets.push(ticket.id)
    for (const thread of group.conventions) if (!existing.conventions.includes(thread)) existing.conventions.push(thread)
  }
  const list = [...groups.values()].sort((left, right) => left.key.localeCompare(right.key))
  // A group's convention list follows the per-Ticket promise: newest Thread activity first, then key order.
  for (const group of list) group.conventions.sort((left, right) =>
    (activity.get(right) ?? '').localeCompare(activity.get(left) ?? '') || left.localeCompare(right))
  return { generatedAt: now.toISOString(), groups: list,
    totals: { groups: list.length, tickets: list.reduce((count, group) => count + group.tickets.length, 0) } }
}

/**
 * Turns a present group into the optional dimension T5-04's assembler consumes. The entry repeats the dimension manifest
 * fields (`key/source/scope/strength/inheritance/truncation`) and carries no member list, no Mandate and no action level.
 */
export function contextGroupDimension(group: ContextGroupView): ContextDimensionEntry {
  const conventions = group.conventions.length ? group.conventions.join(', ') : 'no live Thread'
  return { key: `group:${group.key}`, source: group.source, scope: group.key, strength: 'default', inheritance: 'inherit', truncation: 800,
    text: `Shared space ${group.space} in ${group.source}. Visibility follows the Source; this dimension carries no member list and grants nothing. Conventions are read from ${conventions}.` }
}
