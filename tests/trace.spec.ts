/** The trace ids and the Store's `span` table: what the Engine reports, kept once per stage and read back in order. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SPAN_KINDS, spanId, traceId, type Span } from '@superagent/kernel'
import { SCHEMA_VERSION, Store } from '@superagent/dsh/app/store.ts'
import { SqliteTraceSink } from '@superagent/dsh/app/trace.ts'
import { KV } from '@superagent/dsh/kv.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-trace-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const path = (): string => join(directory, 'orchestrator.sqlite')

/** A span of `trigger`'s trace at stage `kind`, with the time and facts a caller gives. */
function span(trigger: string, kind: (typeof SPAN_KINDS)[number], at: string, data?: Record<string, unknown>): Span {
  const trace = traceId(trigger)
  return { id: spanId(trace, kind), traceId: trace, kind, at, ...data === undefined ? {} : { data } }
}

it('derives a trace id from the Trigger and a stage id from the trace and the stage, equal for equal inputs', () => {
  expect(traceId('t1')).toBe(traceId('t1'))
  expect(traceId('t1')).not.toBe(traceId('t2'))
  const trace = traceId('t1')
  expect(spanId(trace, 'gate')).toBe(spanId(trace, 'gate'))
  // Every stage of one trace has its own id, so a trace holds one row per stage.
  expect(new Set(SPAN_KINDS.map(kind => spanId(trace, kind))).size).toBe(SPAN_KINDS.length)
  expect(SPAN_KINDS).toEqual(['ingest', 'dedupe', 'enqueue', 'gate', 'admission', 'assess', 'decide', 'attach', 'dispatch', 'context', 'action', 'report', 'delegation.delegate', 'delegation.report', 'delegation.review', 'delegation.self-work', 'delegation.report-up'])
})

it('reads a trace back in the order its stages happened, not the order they were written', () => {
  const store = new Store(path())
  const sink = new SqliteTraceSink(store)
  sink.record(span('t1', 'gate', '2026-11-07T10:00:02.000Z'))
  sink.record(span('t1', 'ingest', '2026-11-07T10:00:00.000Z'))
  sink.record(span('t1', 'dedupe', '2026-11-07T10:00:01.000Z'))
  expect(sink.trace(traceId('t1')).map(item => item.kind)).toEqual(['ingest', 'dedupe', 'gate'])
  // A trace holds only its own stages.
  sink.record(span('t2', 'ingest', '2026-11-07T10:00:03.000Z'))
  expect(sink.trace(traceId('t1')).map(item => item.kind)).toEqual(['ingest', 'dedupe', 'gate'])
  store.close()
})

it('keeps the first row when a stage is recorded twice, so a repeated report cannot rewrite a trace', () => {
  const store = new Store(path())
  const sink = new SqliteTraceSink(store)
  sink.record(span('t1', 'gate', '2026-11-07T10:00:00.000Z', { reason: 'not_a_member' }))
  sink.record(span('t1', 'gate', '2026-11-07T10:05:00.000Z', { reason: 'policy' }))
  expect(sink.trace(traceId('t1'))).toHaveLength(1)
  expect(sink.trace(traceId('t1'))[0]).toMatchObject({ kind: 'gate', at: '2026-11-07T10:00:00.000Z', data: { reason: 'not_a_member' } })
  store.close()
})

it('keeps the facts of a stage and omits the ids the Engine has not named yet', () => {
  const store = new Store(path())
  const sink = new SqliteTraceSink(store)
  const trace = traceId('t1')
  sink.record({ id: spanId(trace, 'decide'), traceId: trace, kind: 'decide', at: '2026-11-07T10:00:00.000Z',
    threadKey: 'github:o/r#4', ticketId: 'ticket-1', data: { decision: 'accept', strength: 'explicit' } })
  expect(sink.trace(trace)[0]).toEqual({ id: spanId(trace, 'decide'), traceId: trace, kind: 'decide', at: '2026-11-07T10:00:00.000Z',
    threadKey: 'github:o/r#4', ticketId: 'ticket-1', data: { decision: 'accept', strength: 'explicit' } })
  store.close()
})

it('reads the newest stages of every trace, newest first, limited by the caller', () => {
  const store = new Store(path())
  const sink = new SqliteTraceSink(store)
  for (const [trigger, at] of [['t1', '2026-11-07T10:00:00.000Z'], ['t2', '2026-11-07T10:00:02.000Z'], ['t3', '2026-11-07T10:00:01.000Z']] as const) {
    sink.record(span(trigger, 'ingest', at))
  }
  expect(sink.recent().map(item => item.traceId)).toEqual([traceId('t2'), traceId('t3'), traceId('t1')])
  expect(sink.recent(2)).toHaveLength(2)
  expect(sink.recent(2)[0]!.traceId).toBe(traceId('t2'))
  store.close()
})

it('keeps spans across a reopen, because a trace outlives the process that recorded it', () => {
  const first = new Store(path())
  new SqliteTraceSink(first).record(span('t1', 'enqueue', '2026-11-07T10:00:00.000Z', { queued: true }))
  first.close()
  const second = new Store(path())
  expect(new SqliteTraceSink(second).trace(traceId('t1'))).toMatchObject([{ kind: 'enqueue', data: { queued: true } }])
  second.close()
})

it('opens a schema-11 database at the current schema with its records and no spans', () => {
  const store = new Store(path())
  store.triggers.save({ id: 't1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }],
    actor: { source: 'feishu', id: 'u' }, human: true, at: '2026-11-07T10:00:00.000Z', text: 'fix it', meta: {} })
  store.close()
  // A database written before the span table existed: schema 11 and no `span` table.
  const legacy = new DatabaseSync(path())
  legacy.exec('DROP INDEX span_trace; DROP INDEX span_at; DROP TABLE span')
  legacy.prepare('UPDATE kv SET value=? WHERE key=?').run('11', KV.store.schema)
  legacy.close()
  const opened = new Store(path())
  expect(opened.get(KV.store.schema)).toBe(SCHEMA_VERSION)
  expect(opened.triggers.get('t1')).toMatchObject({ text: 'fix it' })
  expect(opened.spans.trace(traceId('t1'))).toEqual([])
  // The table the migration did not have to fill is there for the next span.
  new SqliteTraceSink(opened).record(span('t1', 'ingest', '2026-11-07T10:00:01.000Z'))
  expect(opened.spans.trace(traceId('t1'))).toHaveLength(1)
  opened.close()
})

it('refuses a database written by a newer build, so a trace it cannot read is never silently ignored', () => {
  const store = new Store(path())
  store.set(KV.store.schema, SCHEMA_VERSION + 1)
  store.close()
  expect(() => new Store(path())).toThrow('Unsupported')
})