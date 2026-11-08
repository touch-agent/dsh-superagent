/**
 * Health metrics of one Store: how long a Trigger waits for its first judgement, whether any message went to one
 * conversation twice for the same ticket, how long work stayed stalled after the host restarted, how many judgements the
 * Evals produce per hour, and how long approvals waited for a decision.
 *
 * The panel shows them read-only and `GET metrics` returns the same figures, so an operator can check the system
 * without reading the database. Every figure is derived from stored rows; a missing sample is `null`, never a zero.
 */
import type { Store } from './store.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Seconds at the `fraction` quantile of `values`, or `null` for no samples. */
function quantile(values: number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return Math.round(sorted[index]!)
}

/** Seconds between two stored ISO timestamps, or `null` when either is missing or unreadable. */
function seconds(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const start = Date.parse(from), end = Date.parse(to)
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null
  return (end - start) / 1000
}

/** What the health figures cover and what they measured, as the panel and `GET metrics` return them. */
export interface MetricsView {
  window: { since: string; hours: number }
  /** Time from a Trigger arriving to the first Decision about it, over the last 24 hours. */
  ttfa: { samples: number; medianSeconds: number | null; p90Seconds: number | null }
  /** Outbound messages the Store holds, and how many repeated the same words to one conversation for one ticket. */
  duplicates: { sends: number; repeated: number }
  /** Assignments a host restart interrupted, and how long the next Assignment took to start, over the whole Store. */
  recovery: { interrupted: number; recovered: number; medianSeconds: number | null }
  /** Decisions recorded in the last 24 hours, and the same count per hour. */
  throughput: { decisions: number; perHour: number }
  /** Time from an Approval being requested to its decision, over the last 24 hours; a withdrawal is not a decision. */
  approval: { samples: number; medianSeconds: number | null; p90Seconds: number | null }
}

/**
 * Reads the health metrics of `store`. `now` fixes the 24-hour window, so tests and callers can read a stable view.
 */
export function metrics(store: Store, now = Date.now()): MetricsView {
  const since = new Date(now - DAY).toISOString()
  const db = store.db
  // Each Trigger counts once, measured to its earliest Decision; a Trigger judged twice contributes its first wait only.
  const waits = db.prepare(`SELECT t.at AS at, MIN(json_extract(d.value, '$.at')) AS decided
    FROM decision d, json_each(json_extract(d.value, '$.triggerIds')) j JOIN trigger t ON t.id = j.value
    WHERE t.at >= ? GROUP BY t.id`).all(since)
  const delays = waits.flatMap(row => {
    const value = seconds(row.at === null ? null : String(row.at), row.decided === null ? null : String(row.decided))
    return value === null ? [] : [value]
  })
  const counts = db.prepare(`SELECT (SELECT COUNT(*) FROM outbox) AS sends,
    (SELECT COUNT(*) FROM (SELECT 1 FROM outbox
      GROUP BY json_extract(value, '$.ticketId'), json_extract(value, '$.kind'),
        json_extract(value, '$.channel.thread'), json_extract(value, '$.text')
      HAVING COUNT(*) > 1)) AS repeated`).get()
  // An interrupted Assignment followed by another one on the same ticket: `key` is the index in the stored array.
  const interrupted = db.prepare(`SELECT COUNT(*) AS n FROM ticket t, json_each(json_extract(t.value, '$.assignments')) a
    WHERE json_extract(a.value, '$.endedReason') LIKE '%restarted%'`).get()
  const recovered = db.prepare(`SELECT json_extract(a.value, '$.endedAt') AS endedAt,
    json_extract(b.value, '$.createdAt') AS nextAt
    FROM ticket t, json_each(json_extract(t.value, '$.assignments')) a, json_each(json_extract(t.value, '$.assignments')) b
    WHERE b.key = a.key + 1 AND json_extract(a.value, '$.endedReason') LIKE '%restarted%'`).all()
  const gaps = recovered.flatMap(row => {
    const value = seconds(row.endedAt === null ? null : String(row.endedAt), row.nextAt === null ? null : String(row.nextAt))
    return value === null ? [] : [value]
  })
  const decisions = Number(db.prepare(`SELECT COUNT(*) AS n FROM decision WHERE json_extract(value, '$.at') >= ?`).get(since)?.n ?? 0)
  // A person's approval, denial or an expiry is a decision; a withdrawal by the requester is not. A policy auto-approval
  // is automation rather than a human wait, so it is left out and cannot pull the median down. A request past its expiry
  // counts at that expiry even before anything records the `expired` state, so the wait is not lost.
  const waited = db.prepare(`SELECT requested, decided FROM (
    SELECT json_extract(value, '$.requestedAt') AS requested,
      CASE WHEN json_extract(value, '$.state') = 'requested' THEN json_extract(value, '$.expiresAt')
        ELSE json_extract(value, '$.decidedAt') END AS decided
    FROM approval
    WHERE (json_extract(value, '$.state') IN ('approved', 'denied', 'expired')
      OR (json_extract(value, '$.state') = 'requested' AND json_extract(value, '$.expiresAt') <= ?))
      AND COALESCE(json_extract(value, '$.decidedBy.source'), '') <> 'policy'
  ) WHERE decided >= ?`).all(new Date(now).toISOString(), since)
  const approvalDelays = waited.flatMap(row => {
    const value = seconds(row.requested === null ? null : String(row.requested), row.decided === null ? null : String(row.decided))
    return value === null ? [] : [value]
  })
  return {
    window: { since, hours: 24 },
    ttfa: { samples: delays.length, medianSeconds: quantile(delays, 0.5), p90Seconds: quantile(delays, 0.9) },
    duplicates: { sends: Number(counts?.sends ?? 0), repeated: Number(counts?.repeated ?? 0) },
    recovery: { interrupted: Number(interrupted?.n ?? 0), recovered: gaps.length, medianSeconds: quantile(gaps, 0.5) },
    throughput: { decisions, perHour: Math.round((decisions / (DAY / HOUR)) * 10) / 10 },
    approval: { samples: approvalDelays.length, medianSeconds: quantile(approvalDelays, 0.5), p90Seconds: quantile(approvalDelays, 0.9) },
  }
}
