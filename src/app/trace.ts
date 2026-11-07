/** The Engine's `TraceSink` over the Store: every stage of a Trigger's trace kept for the panel and the tools. */
import type { Span, TraceSink } from '@superagent/kernel'
import type { Store } from './store.ts'

/**
 * Records the stages the Engine reports in the Store's `span` table, and reads a trace back for a person asking why a
 * Trigger did what it did. Recording is synchronous and idempotent per stage; a failure to write is the caller's to handle,
 * so a broken trace never corrupts a decision that has already been recorded.
 */
export class SqliteTraceSink implements TraceSink {
  constructor(private readonly store: Store) {}
  /** Records one stage; the same stage of the same trace recorded twice keeps its first row. */
  record(span: Span): void { this.store.spans.record(span) }
  /** One trace's stages in the order the Engine recorded them, for the panel's trace view. */
  trace(traceId: string): Span[] { return this.store.spans.trace(traceId) }
  /** The newest stages of every trace, newest first, for a health view. */
  recent(limit?: number): Span[] { return this.store.spans.recent(limit) }
}