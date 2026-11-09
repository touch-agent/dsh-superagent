/**
 * Stages of a Trigger's journey, and the ids that keep one Trigger's stages together.
 * The Engine reports a Span per stage; nothing here decides what is recorded.
 */
import { key } from './ids.ts'

/**
 * The stages of a Trigger's trace, in the order the Engine runs them: a Source hands it in, it is deduplicated, queued,
 * gated, admitted, assessed, decided, attached and dispatched, then a lightweight ticket's actions run inline and the
 * ticket reports on it. A tracked ticket records no `action` stage: its actions happen inside its worker's Session.
 */
export const SPAN_KINDS = ['ingest', 'dedupe', 'enqueue', 'gate', 'admission', 'assess', 'decide', 'attach', 'dispatch', 'action', 'report',
  'delegation.delegate', 'delegation.report', 'delegation.review', 'delegation.self-work', 'delegation.report-up'] as const
/** One stage of `SPAN_KINDS`: what happened to a Trigger, not what its message said. */
export type SpanKind = typeof SPAN_KINDS[number]

/**
 * One stage a Trigger passed. `id` is derived from the trace and the stage, so a stage recorded twice keeps one row;
 * `data` holds the bounded facts of that stage, such as a reason code, a strength or a decision kind, never message text.
 */
export interface Span {
  id: string
  traceId: string
  kind: SpanKind
  /** When the stage happened, as `Date#toISOString` gives it, so spans of a trace sort as text. */
  at: string
  /** The Thread the Trigger was being handled on, when the stage names one. */
  threadKey?: string
  ticketId?: string
  evalId?: string
  assignmentId?: string
  data?: Record<string, unknown>
}

/** The trace of one Trigger: every stage of its journey lands under this id. */
export const traceId = (triggerId: string): string => key('trace', triggerId)
/**
 * The id of one stage of a trace, equal for equal inputs so a repeated report does not add a row. A stage that may happen
 * more than once for one Trigger — a ticket dispatched to a second Assignment, a second report — passes a `ref` that tells
 * those happenings apart; without one the stage keeps its first row.
 */
export const spanId = (traceIdValue: string, kind: SpanKind, ref?: string): string =>
  ref === undefined ? key('span', traceIdValue, kind) : key('span', traceIdValue, kind, ref)