/** The trace a person reads to answer why a Trigger did or did not become work. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { spanId, traceId, type Span, type SpanKind } from '@superagent/kernel'
import { Store } from '../src/app/store.ts'
import { triggerTrace } from '../src/app/views/trace.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-trace-view-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const path = (): string => join(directory, 'orchestrator.sqlite')

/** Records one stage of `trigger`'s trace, `second` seconds after the trace began. */
function stage(store: Store, trigger: string, kind: SpanKind, second: number, data?: Record<string, unknown>): void {
  const id = spanId(traceId(trigger), kind)
  const at = new Date(Date.parse('2026-11-07T12:00:00.000Z') + second * 1000).toISOString()
  const span: Span = { id, traceId: traceId(trigger), kind, at, threadKey: 'chat:t1', ...data ? { data } : {} }
  store.spans.record(span)
}

it('answers with an empty trace for a Trigger the Store does not know, rather than failing', () => {
  const store = new Store(path())
  expect(triggerTrace({ store }, 'missing')).toEqual({ trigger: 'missing', source: '', stages: [] })
})

it('lists the stages in the order they ran, and stops where the trace stops', () => {
  const store = new Store(path())
  store.triggers.save({ id: 't1', source: 'github', threads: [{ source: 'github', id: 'issue:7' }], actor: { source: 'github', id: 'u' },
    human: true, at: '2026-11-07T12:00:00.000Z', text: 'please fix', meta: {} })
  stage(store, 't1', 'ingest', 0)
  stage(store, 't1', 'enqueue', 1)
  stage(store, 't1', 'gate', 2, { admitted: true, strength: 'explicit', via: 'addressed' })
  stage(store, 't1', 'admission', 3)
  const view = triggerTrace({ store }, 't1')
  expect(view.source).toBe('github')
  expect(view.stages.map(item => item.kind)).toEqual(['ingest', 'enqueue', 'gate', 'admission'])
  expect(view.stages[2]?.facts).toEqual({ admitted: true, strength: 'explicit', via: 'addressed' })
  // No Decision yet, so the view says so instead of calling the last stage the end.
  expect(view.stop).toBeUndefined()
  expect(view.partial).toBe(true)
})

it('is complete once a Decision settles the Trigger, even before its work starts', () => {
  const store = new Store(path())
  stage(store, 't3', 'ingest', 0)
  stage(store, 't3', 'decide', 1, { kind: 'ignore' })
  const view = triggerTrace({ store }, 't3')
  expect(view.stages.map(item => item.kind)).toEqual(['ingest', 'decide'])
  expect(view.stop).toBeUndefined()
  expect(view.partial).toBeUndefined()
})

it('reports the gate\'s refusal as the reason the Trigger stopped', () => {
  const store = new Store(path())
  stage(store, 't2', 'ingest', 0)
  stage(store, 't2', 'gate', 1, { admitted: false, reason: 'not_a_member' })
  expect(triggerTrace({ store }, 't2')).toMatchObject({ stages: [{ kind: 'ingest' }, { kind: 'gate' }],
    stop: { stage: 'gate', reason: 'not_a_member' } })
})

it('ends a duplicate at the dedupe stage instead of calling it incomplete', () => {
  const store = new Store(path())
  stage(store, 't4', 'ingest', 0)
  stage(store, 't4', 'dedupe', 0, { duplicate: true })
  expect(triggerTrace({ store }, 't4')).toMatchObject({ stages: [{ kind: 'ingest' }, { kind: 'dedupe' }],
    stop: { stage: 'dedupe' } })
  // A first sighting of the same Trigger is not a duplicate, so it is still in flight.
  const first = new Store(join(directory, 'first.sqlite'))
  stage(first, 't5', 'ingest', 0)
  stage(first, 't5', 'dedupe', 0, { duplicate: false })
  expect(triggerTrace({ store: first }, 't5').partial).toBe(true)
})