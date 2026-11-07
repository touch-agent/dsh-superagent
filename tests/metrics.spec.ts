/** The health figures `GET metrics` returns: time to judgement, repeated sends, restart recovery and throughput. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { metrics } from '../src/app/metrics.ts'
import { Store } from '../src/app/store.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'orchestrator-metrics-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const path = (): string => join(directory, 'orchestrator.sqlite')

/** `now` for every case: a fixed instant, so the 24-hour window never depends on the clock. */
const NOW = Date.parse('2026-11-07T12:00:00.000Z')
const at = (offsetSeconds: number): string => new Date(NOW + offsetSeconds * 1000).toISOString()

/** Stores a Trigger that arrived `offsetSeconds` from `NOW`. */
function trigger(store: Store, id: string, offsetSeconds: number): void {
  store.db.prepare('INSERT INTO trigger (id, value, at) VALUES (?, ?, ?)')
    .run(id, JSON.stringify({ id, source: 'github', at: at(offsetSeconds) }), at(offsetSeconds))
}
/** Stores the Decision about `triggerId` that was recorded `offsetSeconds` from `NOW`. */
function decision(store: Store, id: string, triggerId: string, offsetSeconds: number): void {
  store.db.prepare('INSERT INTO decision (id, thread, value) VALUES (?, ?, ?)')
    .run(id, 'chat:t1', JSON.stringify({ id, threadKey: 'chat:t1', at: at(offsetSeconds), kind: 'accept', triggerIds: [triggerId] }))
}
/** Stores a Ticket whose Assignments are given as `[createdAt, endedAt?, endedReason?]`. */
function ticket(store: Store, id: string, assignments: [string, string?, string?][]): void {
  const rows = assignments.map(([createdAt, endedAt, endedReason], index) => ({
    id: `${id}-a${index}`, state: endedAt ? 'ended' : 'running', createdAt,
    ...endedAt === undefined ? {} : { endedAt }, ...endedReason === undefined ? {} : { endedReason },
  }))
  store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(id, JSON.stringify({ id, assignments: rows }))
}
/** Stores an outbound receipt. */
function receipt(store: Store, id: string, text: string, kind = 'reply', ticketId = 'k1'): void {
  store.db.prepare('INSERT INTO outbox (id, value) VALUES (?, ?)')
    .run(id, JSON.stringify({ id, channel: { source: 'feishu', thread: 'chat:t1' }, text, kind, ticketId }))
}

it('reports no samples rather than zeros for an empty store', () => {
  const store = new Store(path())
  const view = metrics(store, NOW)
  expect(view.window).toEqual({ since: at(-86_400), hours: 24 })
  expect(view.ttfa).toEqual({ samples: 0, medianSeconds: null, p90Seconds: null })
  expect(view.duplicates).toEqual({ sends: 0, repeated: 0 })
  expect(view.recovery).toEqual({ interrupted: 0, recovered: 0, medianSeconds: null })
  expect(view.throughput).toEqual({ decisions: 0, perHour: 0 })
  store.close()
})

it('measures each Trigger once, from its arrival to the first Decision about it', () => {
  const store = new Store(path())
  trigger(store, 't1', -3600)
  trigger(store, 't2', -3600)
  trigger(store, 't3', -3600)
  decision(store, 'd1', 't1', -3598)
  decision(store, 'd2', 't2', -3594)
  decision(store, 'd3', 't3', -3590)
  // A later Decision about t1 does not add a second sample.
  decision(store, 'd4', 't1', -3000)
  const view = metrics(store, NOW)
  expect(view.ttfa).toEqual({ samples: 3, medianSeconds: 6, p90Seconds: 10 })
  store.close()
})

it('leaves Triggers outside the 24-hour window out of every figure', () => {
  const store = new Store(path())
  trigger(store, 'old', -90_000)
  decision(store, 'd-old', 'old', -89_990)
  trigger(store, 'new', -3600)
  decision(store, 'd-new', 'new', -3595)
  const view = metrics(store, NOW)
  expect(view.ttfa).toEqual({ samples: 1, medianSeconds: 5, p90Seconds: 5 })
  expect(view.throughput.decisions).toBe(1)
  store.close()
})

it('counts a message that repeats the same words to one conversation for one ticket as repeated', () => {
  const store = new Store(path())
  receipt(store, 'm1', 'Working on it')
  receipt(store, 'm2', 'Working on it')
  receipt(store, 'm3', 'Done')
  // The same words to another ticket or conversation are not a repeat.
  receipt(store, 'm4', 'Done', 'reply', 'k2')
  const view = metrics(store, NOW)
  expect(view.duplicates).toEqual({ sends: 4, repeated: 1 })
  store.close()
})

it('measures restart recovery from the interrupted Assignment to the next one', () => {
  const store = new Store(path())
  ticket(store, 'k1', [[at(-7200), at(-7000), 'dsh-superagent restarted'], [at(-6970), at(-6000), 'done']])
  ticket(store, 'k2', [[at(-5000), at(-4900), 'dsh-superagent restarted']])
  const view = metrics(store, NOW)
  expect(view.recovery).toEqual({ interrupted: 2, recovered: 1, medianSeconds: 30 })
  store.close()
})

it('reports judgements per hour over the day', () => {
  const store = new Store(path())
  trigger(store, 't1', -3600)
  for (const [index, offset] of [-3500, -3000, -2000, -1000].entries()) decision(store, `d${index}`, 't1', offset)
  const view = metrics(store, NOW)
  expect(view.throughput.decisions).toBe(4)
  expect(view.throughput.perHour).toBe(0.2)
  store.close()
})