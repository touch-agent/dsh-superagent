/**
 * Stages of a Trigger's journey, and the ids that keep one Trigger's stages together.
 * The Engine reports a Span per stage; nothing here decides what is recorded.
 */
import { key } from './ids.ts'

/**
 * The ten stages of a Trigger, in the order the Engine records them: five while the Trigger is admitted and queued,
 * five while its Eval decides and its work starts.
 */
export const SPAN_KINDS = ['ingest', 'dedupe', 'gate', 'admission', 'enqueue', 'assess', 'decide', 'attach', 'dispatch', 'report'] as const
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
/** The id of one stage of a trace, equal for equal inputs so a repeated report does not add a row. */
export const spanId = (traceIdValue: string, kind: SpanKind): string => key('span', traceIdValue, kind)