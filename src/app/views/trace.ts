/** One Trigger's trace: the stages the Engine ran, in order, and where they stopped. */
import { traceId, type SpanKind } from '@superagent/kernel'
import type { ViewHost } from './records.ts'

/** One recorded stage of a trace, with the facts the Engine wrote down at that stage. */
export interface TraceStageView { kind: SpanKind; at: string; facts?: Record<string, unknown> }
/** Where a trace stopped: the last stage that ran, and the gate's reason when the gate refused it. */
export interface TraceStopView { stage: SpanKind; reason?: string }
/** The trace a person reads to answer why a Trigger did or did not become work. */
export interface TriggerTraceView { trigger: string; source: string; stages: TraceStageView[]; stop?: TraceStopView
  /** True while the Engine records fewer stages than `SpanKind` names, so a reader does not mistake the last stage for the end. */
  partial?: true }

/**
 * Projects one Trigger's trace for the panel: every stage in the order the Engine ran it, and the stage where it
 * stopped. A Trigger the Store knows nothing about still answers with an empty trace rather than a failure, so a
 * stale link shows "no trace" instead of an error.
 */
export function triggerTrace(host: Pick<ViewHost, 'store'>, triggerId: string): TriggerTraceView {
  const trigger = host.store.triggers.get(triggerId)
  const spans = host.store.spans.trace(traceId(triggerId))
  const stages = spans.map(span => ({ kind: span.kind, at: span.at, ...span.data ? { facts: span.data } : {} }))
  const gate = spans.find(span => span.kind === 'gate')
  const refused = gate?.data?.admitted === false
  // The Engine records ingest through admission today; later stages are declared but not yet written, so a trace that
  // got past the gate is incomplete rather than finished.
  const complete = spans.some(span => span.kind === 'report')
  return {
    trigger: triggerId,
    source: trigger?.source ?? '',
    stages,
    ...refused ? { stop: { stage: 'gate' as const, reason: String(gate?.data?.reason ?? '') } }
      : spans.length && !complete ? { partial: true as const } : {},
  }
}