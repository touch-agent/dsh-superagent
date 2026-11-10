/**
 * Read-only profile telemetry: the same facts the health metrics use, grouped by execution configuration instead of by
 * time. A frozen configuration groups by the binding `effective.hash`; a moving one (`live` prompt or `inherit` model or
 * tools) groups by the run hash recorded on its latest model request, because its binding hash is not a stable coordinate.
 *
 * Nothing here is authorization or a promotion decision. Small groups suppress only their displayed rate; the counts and
 * the sample remain visible, because suppression is a privacy affordance, not an analysis rule. A missing sample is
 * `unknown` or `null`, never a zero.
 */
import type { Assignment, ProfileSnapshot, Ticket } from '@superagent/kernel'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

/** Seconds between two stored timestamps, or null when missing or unreadable. */
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
/** A group's success sample: roots, child resolutions and lightweight runs each follow their own ending rule. */
interface Success { n: number; successes: number }
/** One effective configuration's telemetry. */
export interface ProfileMetricsGroup {
  effectiveHash: string
  promptRevision: number
  model: { provider: string; model: string; reasoningEffort?: string }
  moving: boolean
  tickets: number
  roots: number
  children: number
  lightweight: number
  fallback: number
  censored: number
  closed: number
  success: { n: number; successes: number; rate: number | null; suppressed: boolean }
  blocked: { blocked: number; failed: number; stopped: number; dropped: number }
  rework: { tickets: number; rate: number | null; suppressed: boolean }
  latency: { decisionToDispatch: { samples: number; p50Seconds: number | null; p90Seconds: number | null }
    dispatchToReady: { samples: number; p50Seconds: number | null; p90Seconds: number | null }
    readyToEnd: { samples: number; p50Seconds: number | null; p90Seconds: number | null } }
  tokens: { state: 'available' | 'unknown'; input: number | null; output: number | null; cacheRead: number | null
    cacheWrite: number | null; reasoning: number | null }
  cost: 'unknown'
}
/** `GET profiles/:id/metrics`, and its totals across every effective configuration of one profile. */
export interface ProfileMetricsView {
  generatedAt: string
  profile: string
  window: 'all'
  totals: Omit<ProfileMetricsGroup, 'effectiveHash' | 'promptRevision' | 'model' | 'moving' | 'tokens' | 'latency'>
    & { effectiveConfigurations: number; tokens: { state: 'available' | 'unknown'; input: number | null; output: number | null; cost: 'unknown' } }
  groups: ProfileMetricsGroup[]
}

/** A lightweight ticket has no Assignment or Session; it has a form and an ending, and no rework or latency sample. */
const isLightweight = (ticket: Ticket): boolean => ticket.form === 'lightweight'
/** The latest assignment report, if any. */
const latestReportOf = (ticket: Ticket): Assignment['report'] => ticket.assignments.findLast(assignment => assignment.report)?.report
/** Whether the ticket shows rework rather than an operational retry. */
function hasRework(ticket: Ticket): boolean {
  if (isLightweight(ticket)) return false
  const returned = ticket.assignments.some(assignment => assignment.endedReason === 'returned')
    || ticket.delegation?.dispositions?.some(item => item.decision === 'returned') === true
  const firstReady = ticket.assignments.find(assignment => assignment.report?.state === 'ready')?.report?.at
  const resumedAfterReady = !!firstReady && ticket.inputs.some(input => input.kind === 'resumed' && input.at > firstReady)
  return returned || resumedAfterReady
}
/** The run hash for a moving snapshot, or the binding hash for a frozen one. */
function hashOf(store: Store, ticket: Ticket, snapshot: ProfileSnapshot): string {
  if (!snapshot.selection.moving) return snapshot.effective.hash
  return store.get(KV.sessions.effective(`worker-${ticket.id}`))?.hash ?? snapshot.effective.hash
}
/** Whether a ticket ended successfully under its own rule: root/lightweight completion or merge, child parent acceptance. */
function succeeded(ticket: Ticket): boolean {
  if (ticket.parentTicketId) return ticket.delegation?.resolution?.kind === 'accepted'
  return ticket.ended?.outcome === 'completed' || ticket.ended?.outcome === 'merged'
}
/** Whether a ticket contributes a decided success sample (open tickets are censored, closed-unmerged roots are failures). */
function decided(ticket: Ticket): boolean {
  if (ticket.parentTicketId) return !!ticket.delegation?.resolution
  return !!ticket.ended
}
/** The status counters a ticket contributes. */
function statusOf(ticket: Ticket): { blocked: number; failed: number; stopped: number; dropped: number } {
  const report = latestReportOf(ticket)
  return { blocked: report?.state === 'blocked' ? 1 : 0, failed: report?.state === 'failed' ? 1 : 0,
    stopped: ticket.ended?.outcome === 'stopped' ? 1 : 0, dropped: ticket.ended?.outcome === 'dropped' ? 1 : 0 }
}
/** Build one group accumulator. */
function emptyGroup(effectiveHash: string, snapshot: ProfileSnapshot): ProfileMetricsGroup {
  return { effectiveHash, promptRevision: snapshot.effective.promptRevision, model: snapshot.effective.model, moving: snapshot.selection.moving,
    tickets: 0, roots: 0, children: 0, lightweight: 0, fallback: 0, censored: 0, closed: 0,
    success: { n: 0, successes: 0, rate: null, suppressed: false }, blocked: { blocked: 0, failed: 0, stopped: 0, dropped: 0 },
    rework: { tickets: 0, rate: null, suppressed: false },
    latency: { decisionToDispatch: { samples: 0, p50Seconds: null, p90Seconds: null },
      dispatchToReady: { samples: 0, p50Seconds: null, p90Seconds: null },
      readyToEnd: { samples: 0, p50Seconds: null, p90Seconds: null } },
    tokens: { state: 'unknown', input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null }, cost: 'unknown' }
}
const rate = (ratio: number): number => Math.round(ratio * 1000) / 10

/**
 * Derive a profile's telemetry from stored Tickets and the usage Sessions recorded. `now` fixes `generatedAt` so tests
 * read a stable object. It filters by profile id and includes only tickets that actually bound that profile.
 */
export function profileMetrics(store: Store, profile: string, now = new Date()): ProfileMetricsView {
  // A fallback snapshot keeps the legacy id but names the profile it could not resolve, so its tickets stay visible
  // beside that profile's own runs instead of disappearing from every per-profile view.
  const tickets = store.tickets.allList().filter(ticket => ticket.profile?.id === profile
    || (ticket.profile?.selection.fallback === true && ticket.profile.selection.reason === `profileUnavailable:${profile}`))
  const groups = new Map<string, { group: ProfileMetricsGroup; decisionToDispatch: number[]; dispatchToReady: number[]; readyToEnd: number[]
    tokenInput: number; tokenOutput: number; tokenCacheRead: number; tokenCacheWrite: number; tokenReasoning: number; usageSamples: number }>()
  for (const ticket of tickets) {
    const snapshot = ticket.profile!
    const hash = hashOf(store, ticket, snapshot)
    let entry = groups.get(hash)
    if (!entry) { entry = { group: emptyGroup(hash, snapshot), decisionToDispatch: [], dispatchToReady: [], readyToEnd: [],
      tokenInput: 0, tokenOutput: 0, tokenCacheRead: 0, tokenCacheWrite: 0, tokenReasoning: 0, usageSamples: 0 }; groups.set(hash, entry) }
    const group = entry.group
    group.tickets += 1
    if (ticket.parentTicketId) group.children += 1
    else group.roots += 1
    if (isLightweight(ticket)) group.lightweight += 1
    if (snapshot.selection.fallback) group.fallback += 1
    if (!decided(ticket)) group.censored += 1
    if (ticket.ended?.outcome === 'closed') group.closed += 1
    if (decided(ticket)) { group.success.n += 1; if (succeeded(ticket)) group.success.successes += 1 }
    const status = statusOf(ticket)
    group.blocked.blocked += status.blocked; group.blocked.failed += status.failed
    group.blocked.stopped += status.stopped; group.blocked.dropped += status.dropped
    if (hasRework(ticket)) group.rework.tickets += 1
    if (!isLightweight(ticket)) {
      const decision = ticket.decisionId ? store.decisions.get(ticket.decisionId) : undefined
      const firstStart = ticket.assignments.find(assignment => assignment.startedAt)?.startedAt
      const firstReady = ticket.assignments.find(assignment => assignment.report?.state === 'ready')?.report?.at
      const dispatch = seconds(decision?.at, firstStart)
      if (dispatch !== null) entry.decisionToDispatch.push(dispatch)
      const ready = seconds(firstStart, firstReady)
      if (ready !== null) entry.dispatchToReady.push(ready)
      const end = seconds(firstReady, ticket.ended?.at)
      if (end !== null) entry.readyToEnd.push(end)
    }
    const usage = store.get(KV.sessions.usage(`worker-${ticket.id}`))
    if (usage) {
      entry.tokenInput += usage.input; entry.tokenOutput += usage.output; entry.tokenCacheRead += usage.cacheRead
      entry.tokenCacheWrite += usage.cacheWrite; entry.tokenReasoning += usage.reasoning; entry.usageSamples += usage.messages
    }
  }
  const result = [...groups.values()].map(entry => {
    const group = entry.group
    group.success.suppressed = group.success.n < 5
    group.success.rate = group.success.suppressed ? null : rate(group.success.successes / group.success.n)
    group.rework.suppressed = (group.tickets - group.lightweight) < 5
    group.rework.rate = group.rework.suppressed || group.tickets === group.lightweight ? null
      : rate(group.rework.tickets / (group.tickets - group.lightweight))
    group.latency = { decisionToDispatch: latency(entry.decisionToDispatch), dispatchToReady: latency(entry.dispatchToReady),
      readyToEnd: latency(entry.readyToEnd) }
    group.tokens = entry.usageSamples > 0 ? { state: 'available', input: entry.tokenInput, output: entry.tokenOutput,
      cacheRead: entry.tokenCacheRead, cacheWrite: entry.tokenCacheWrite, reasoning: entry.tokenReasoning } : group.tokens
    return group
  }).sort((left, right) => right.tickets - left.tickets || left.effectiveHash.localeCompare(right.effectiveHash))
  const totals = result.reduce((sum, group) => ({
    tickets: sum.tickets + group.tickets, roots: sum.roots + group.roots, children: sum.children + group.children,
    lightweight: sum.lightweight + group.lightweight, fallback: sum.fallback + group.fallback, censored: sum.censored + group.censored,
    closed: sum.closed + group.closed, successN: sum.successN + group.success.n, successes: sum.successes + group.success.successes,
    blocked: sum.blocked + group.blocked.blocked, failed: sum.failed + group.blocked.failed, stopped: sum.stopped + group.blocked.stopped,
    dropped: sum.dropped + group.blocked.dropped, rework: sum.rework + group.rework.tickets,
    reworkSamples: sum.reworkSamples + group.tickets - group.lightweight,
    tokenInput: sum.tokenInput + (group.tokens.state === 'available' ? group.tokens.input ?? 0 : 0),
    tokenOutput: sum.tokenOutput + (group.tokens.state === 'available' ? group.tokens.output ?? 0 : 0),
    tokenSamples: sum.tokenSamples + (group.tokens.state === 'available' ? 1 : 0),
  }), { tickets: 0, roots: 0, children: 0, lightweight: 0, fallback: 0, censored: 0, closed: 0, successN: 0, successes: 0,
    blocked: 0, failed: 0, stopped: 0, dropped: 0, rework: 0, reworkSamples: 0, tokenInput: 0, tokenOutput: 0, tokenSamples: 0 })
  // A total is available only when every tracked ticket contributed usage; one silent group makes it unknown.
  const tokenComplete = result.every(group => group.lightweight === group.tickets || group.tokens.state === 'available')
  return { generatedAt: now.toISOString(), profile, window: 'all',
    totals: { tickets: totals.tickets, roots: totals.roots, children: totals.children, lightweight: totals.lightweight,
      fallback: totals.fallback, censored: totals.censored, closed: totals.closed,
      success: { n: totals.successN, successes: totals.successes,
        rate: totals.successN >= 5 ? rate(totals.successes / totals.successN) : null, suppressed: totals.successN < 5 },
      blocked: { blocked: totals.blocked, failed: totals.failed, stopped: totals.stopped, dropped: totals.dropped },
      rework: { tickets: totals.rework, rate: totals.reworkSamples >= 5 ? rate(totals.rework / totals.reworkSamples) : null,
        suppressed: totals.reworkSamples < 5 },
      effectiveConfigurations: result.length,
      tokens: { state: tokenComplete && totals.tokenSamples > 0 ? 'available' : 'unknown',
        input: tokenComplete && totals.tokenSamples > 0 ? totals.tokenInput : null,
        output: tokenComplete && totals.tokenSamples > 0 ? totals.tokenOutput : null, cost: 'unknown' }, cost: 'unknown' },
    groups: result }
}
function latency(values: number[]): { samples: number; p50Seconds: number | null; p90Seconds: number | null } {
  return { samples: values.length, p50Seconds: quantile(values, 0.5), p90Seconds: quantile(values, 0.9) }
}
/** The read-only profile list's per-profile summary, derived from the same metrics. */
export function profileSummary(store: Store, definition: { id: string }): { tickets: number; successRate: number | null; censored: number; fallback: number } {
  const view = profileMetrics(store, definition.id)
  return { tickets: view.totals.tickets, successRate: view.totals.success.rate, censored: view.totals.censored, fallback: view.totals.fallback }
}
