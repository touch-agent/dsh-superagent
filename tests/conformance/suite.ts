/**
 * The adapter conformance suite: one set of contract tests every Source definition passes.
 *
 * A Source contributes a fixture of its own read paths (`events`), its cursor step, its receiving-scope decisions,
 * its outbound cases and its health claims. The suite checks what an adapter must do regardless of the remote
 * service: derive one Trigger id per event so a re-read is a duplicate, step a time cursor back five seconds so a
 * late event is not lost, claim only the health names its manifest declares, decide scope from `meta` and configuration,
 * answer `sent` or `gone` for one outbound message, and — once T2-06 gives every adapter a probe — answer a probe with
 * `sent`, `gone` or `unknown`.
 *
 * `checkConformance` returns violations instead of throwing, so a test can prove the suite bites: a fixture that
 * derives a new id on every read must fail the `triggers` group.
 */
import { describe, expect, it } from 'vitest'
import type { Commands } from '@superagent/dsh/infra/commands.ts'
import { HealthBoard } from '@superagent/dsh/infra/health.ts'
import { SettingsSchema } from '@superagent/dsh/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '@superagent/dsh/app/source-context.ts'
import type { SourceDefinition } from '@superagent/dsh/sources/kind.ts'
import { parseSourceManifest } from '@superagent/dsh/sources/manifest-schema.ts'
import { SourceRegistry } from '@superagent/dsh/sources/registry.ts'
import type { OutboundMessage, ScopeResult, SourceManifest, Trigger } from '@superagent/kernel'

export type ConformanceGroup = 'manifest' | 'triggers' | 'cursor' | 'health' | 'scope' | 'send' | 'probe'
export interface Violation { group: ConformanceGroup; case: string; detail: string }

/**
 * One remote event and the two ways a conformance test reads it. `trigger` is the path a poll takes; `replay` is a
 * second poll, a live event, or another read path for the same event. Both must produce one id.
 * An `ignored` event is the agent's own message, which a Source must not turn into a Trigger.
 */
export interface EventCase {
  name: string
  trigger: () => Trigger | undefined
  replay?: () => Trigger | undefined
  ignored?: true
}

/** A receiving-scope decision under one configuration; `expected` is the adapter's exact answer. */
export interface ScopeCase<C extends Record<string, unknown>> {
  name: string
  config: C
  meta: Record<string, unknown>
  expected: ScopeResult
}

/** The fresh command stub and the arguments it received for one outbound send. */
export interface SendHost { commands: Commands; calls: string[] }

/** One outbound message: a new send, a permanent answer, or a failure that must stay retryable. */
export interface SendCase {
  name: string
  message: OutboundMessage
  outcome: 'sent' | 'gone' | 'throw'
  host: () => SendHost
}

/** One probe answer, once T2-06 adds probe to the adapter contract. */
export interface ProbeCase { name: string; key: string; answer: 'sent' | 'gone' | 'unknown' }

/** The Source-specific half of the suite: real read paths and real remote shapes, not mocks of the adapter. */
export interface ConformanceSubject<C extends Record<string, unknown>> {
  config: C
  definition: SourceDefinition<C>
  events: EventCase[]
  scope: ScopeCase<C>[]
  sends: SendCase[]
  /** The newest event time (or the round start) a time cursor advances from, and the Source's own step. */
  cursor: { from: string; next: () => string | undefined }
  probes?: ProbeCase[]
  probe?: (key: string) => Promise<'sent' | 'gone' | 'unknown'>
}

const GROUPS: readonly { id: ConformanceGroup; label: string }[] = [
  { id: 'manifest', label: 'manifest and configuration' },
  { id: 'triggers', label: 'idempotency keys' },
  { id: 'cursor', label: 'five-second cursor overlap' },
  { id: 'health', label: 'health claim names' },
  { id: 'scope', label: 'receiving scope' },
  { id: 'send', label: 'outbound sent and gone' },
  { id: 'probe', label: 'probe answers' },
]
const RESERVED_HEALTH = new Set(['runtime', 'models', 'worker', 'evals'])
const PROBE_ANSWERS = new Set(['sent', 'gone', 'unknown'])

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

function fail(violations: Violation[], group: ConformanceGroup, name: string, detail: string): void {
  violations.push({ group, case: name, detail })
}

/** Runs one check, turning an unexpected throw into a violation of its group instead of aborting the rest. */
async function guard(group: ConformanceGroup, name: string, violations: Violation[], work: () => void | Promise<void>): Promise<void> {
  try { await work() } catch (error) { fail(violations, group, name, reason(error)) }
}

function checkManifest<C extends Record<string, unknown>>(subject: ConformanceSubject<C>, violations: Violation[]): void {
  const { manifest, adapter } = subject.definition
  let parsed: SourceManifest
  try { parsed = parseSourceManifest(manifest) } catch (error) { fail(violations, 'manifest', 'manifest', reason(error)); return }
  if (parsed.id !== manifest.id) fail(violations, 'manifest', 'id', `parsed id ${parsed.id} differs from ${manifest.id}`)
  try {
    const config = adapter.schema.parse(subject.config)
    if (!same(adapter.schema.parse(config), config)) fail(violations, 'manifest', 'config', 'configuration is not stable under a second parse')
  } catch (error) { fail(violations, 'manifest', 'config', `the fixture configuration is invalid: ${reason(error)}`) }
}

function checkTriggers<C extends Record<string, unknown>>(subject: ConformanceSubject<C>, violations: Violation[]): void {
  const { manifest } = subject.definition
  const ids = new Map<string, string>()
  for (const event of subject.events) {
    if (event.ignored) {
      const ignored = event.trigger()
      if (ignored) fail(violations, 'triggers', event.name, 'an event the Source must ignore produced a Trigger')
      continue
    }
    const first = event.trigger()
    if (!first) { fail(violations, 'triggers', event.name, 'the event produced no Trigger'); continue }
    if (!first.id.trim() || /\s/.test(first.id)) fail(violations, 'triggers', event.name, `id ${JSON.stringify(first.id)} is empty or contains whitespace`)
    if (first.source !== manifest.id) fail(violations, 'triggers', event.name, `source ${first.source} differs from ${manifest.id}`)
    if (!first.threads.length) fail(violations, 'triggers', event.name, 'the Trigger names no Thread')
    for (const thread of first.threads) if (!thread.id) fail(violations, 'triggers', event.name, 'a Thread has no id')
    if (first.actor.source !== manifest.id) fail(violations, 'triggers', event.name, `actor source ${first.actor.source} differs from ${manifest.id}`)
    if (!Number.isFinite(Date.parse(first.at))) fail(violations, 'triggers', event.name, `at ${JSON.stringify(first.at)} is not a timestamp`)
    if (typeof first.text !== 'string') fail(violations, 'triggers', event.name, 'text is not a string')
    if (first.channel) {
      if (first.channel.source !== manifest.id) fail(violations, 'triggers', event.name, `channel source ${first.channel.source} differs from ${manifest.id}`)
      if (!first.channel.thread) fail(violations, 'triggers', event.name, 'the channel names no Thread')
      if (typeof first.channel.address !== 'object' || first.channel.address === null) fail(violations, 'triggers', event.name, 'the channel has no address')
    }
    if (typeof first.meta !== 'object' || first.meta === null) fail(violations, 'triggers', event.name, 'meta is not an object')
    const again = (event.replay ?? event.trigger)()
    if (!again) fail(violations, 'triggers', event.name, 'the replay produced no Trigger')
    else if (again.id !== first.id) fail(violations, 'triggers', event.name,
      `the same remote event must keep one id (idempotency key): ${first.id} then ${again.id}`)
    const earlier = ids.get(first.id)
    if (earlier !== undefined) fail(violations, 'triggers', event.name, `events "${earlier}" and "${event.name}" share the id ${first.id}`)
    else ids.set(first.id, event.name)
  }
}

function checkCursor<C extends Record<string, unknown>>(subject: ConformanceSubject<C>, violations: Violation[]): void {
  const next = subject.cursor.next()
  if (next === undefined) { fail(violations, 'cursor', 'step', 'the Source stores no cursor'); return }
  const from = Date.parse(subject.cursor.from)
  const at = Date.parse(next)
  if (!Number.isFinite(from)) fail(violations, 'cursor', 'from', `${JSON.stringify(subject.cursor.from)} is not a timestamp`)
  else if (!Number.isFinite(at)) fail(violations, 'cursor', 'step', `${JSON.stringify(next)} is not a timestamp`)
  else if (from - at !== 5000) fail(violations, 'cursor', 'step', `the cursor must step back five seconds from ${subject.cursor.from}: got ${next}`)
  if (subject.cursor.next() !== next) fail(violations, 'cursor', 'step', 'the cursor step is not deterministic')
}

function checkHealth<C extends Record<string, unknown>>(subject: ConformanceSubject<C>, violations: Violation[]): void {
  const { manifest } = subject.definition
  for (const name of manifest.health) {
    if (name.startsWith('sync:')) fail(violations, 'health', name, 'sync health entries belong to the Policy sync, not a Source manifest')
    if (RESERVED_HEALTH.has(name)) fail(violations, 'health', name, `the runtime itself reports ${name}`)
  }
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  let unregister: (() => void) | undefined
  try { unregister = sources.registerDefinition(subject.definition) }
  catch (error) { fail(violations, 'health', 'registration', `registering the definition failed: ${reason(error)}`); return }
  try {
    if (!sources.kind(manifest.id)) fail(violations, 'health', 'registration', 'the registered definition has no flat kind view')
    for (const name of manifest.health) {
      const entry = sources.healthEntries([name]).get(name)
      if (!entry) { fail(violations, 'health', name, 'the manifest declares the name, and registration did not claim it'); continue }
      entry.set({ state: 'ready', detail: '' })
      if (board.all[name]?.state !== 'ready') fail(violations, 'health', name, 'a claim did not reach the health board')
    }
    const context = sourceContextOf({ sources } as unknown as SourceContextDeps, { kind: manifest.id, health: manifest.health })
    for (const name of manifest.health) {
      try { context.report(name, { state: 'ready', detail: '' }) }
      catch (error) { fail(violations, 'health', name, `reporting a declared entry was refused: ${reason(error)}`) }
    }
    try {
      context.report('conformance-undeclared', { state: 'ready', detail: '' })
      fail(violations, 'health', 'undeclared', 'a Source reported a health entry its manifest never declared')
    } catch { /* The refusal is the contract. */ }
  } finally {
    unregister?.()
  }
  if (Object.keys(board.all).length) fail(violations, 'health', 'release', 'unregistering the definition left health entries behind')
}

function checkScope<C extends Record<string, unknown>>(subject: ConformanceSubject<C>, violations: Violation[]): void {
  const { adapter } = subject.definition
  for (const item of subject.scope) {
    if (!adapter.scope) {
      if (!same(item.expected, { listened: true, observed: false })) fail(violations, 'scope', item.name,
        'a Source without scope must listen to everything and observe none of it')
      continue
    }
    const actual = adapter.scope({ meta: item.meta }, item.config)
    if (!same(actual, item.expected)) fail(violations, 'scope', item.name, `expected ${JSON.stringify(item.expected)}, got ${JSON.stringify(actual)}`)
    if (!same(adapter.scope({ meta: item.meta }, item.config), actual)) fail(violations, 'scope', item.name, 'scope is not deterministic')
    if (!actual.listened) {
      if (!String(actual.reason ?? '').trim()) fail(violations, 'scope', item.name, 'a refusal must name a reason')
      continue
    }
    const policy = adapter.policy
    if (!policy) continue
    if (!policy.explicit?.zh || !policy.explicit.en) fail(violations, 'scope', item.name, 'the policy part must say what addresses the agent')
    if (!policy.rows) continue
    const rows = policy.rows(item.config)
    const rowIds = rows.map(row => row.id)
    if (new Set(rowIds).size !== rowIds.length) fail(violations, 'scope', item.name, `duplicate Policy row ids: ${rowIds.join(', ')}`)
    for (const row of rows) {
      if (!row.id) fail(violations, 'scope', item.name, 'a Policy row has no id')
      if (!row.label || (typeof row.label === 'object' && (!row.label.zh || !row.label.en))) fail(violations, 'scope', item.name, `Policy row ${row.id} has no label`)
      for (const cell of ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed'] as const) {
        if (typeof row.cells[cell] !== 'boolean') fail(violations, 'scope', item.name, `Policy row ${row.id} has no ${cell} cell`)
      }
    }
    if (actual.row !== undefined && !rowIds.includes(actual.row)) fail(violations, 'scope', item.name,
      `scope names row ${actual.row}, which the policy part does not list`)
    if (actual.observed && actual.row === undefined) fail(violations, 'scope', item.name,
      'an observed Trigger must name the admission row its cells come from')
  }
}

async function checkSend<C extends Record<string, unknown>>(subject: ConformanceSubject<C>, violations: Violation[]): Promise<void> {
  const channel = subject.definition.adapter.channel
  if (!channel) { fail(violations, 'send', 'channel', 'a Source that replies must declare a channel'); return }
  const outcomes = new Set(subject.sends.map(item => item.outcome))
  for (const outcome of ['sent', 'gone'] as const) if (!outcomes.has(outcome)) fail(violations, 'send', outcome,
    `no case covers the ${outcome} answer an outbound message must distinguish`)
  for (const item of subject.sends) {
    await guard('send', item.name, violations, async () => {
      const host = item.host()
      if (channel.allowed && !channel.allowed(item.message.channel.address, subject.config)) {
        fail(violations, 'send', item.name, 'the sample address is not allowed under the fixture configuration')
      }
      let answer: 'sent' | 'gone' | undefined
      let error: unknown
      try {
        answer = await channel.send({ commands: host.commands, conversation: { deliver: async () => 'sent' } }, item.message)
      } catch (thrown) { error = thrown }
      if (item.outcome === 'throw') {
        if (!error) fail(violations, 'send', item.name, 'the failure was answered instead of being left for a retry')
        return
      }
      if (error) { fail(violations, 'send', item.name, `threw instead of answering ${item.outcome}: ${reason(error)}`); return }
      if (answer !== item.outcome) fail(violations, 'send', item.name, `expected ${item.outcome}, got ${String(answer)}`)
      // A remote service deduplicates a retry by this key: a successful send must carry the outbound message id.
      if (item.outcome === 'sent' && !host.calls.some(call => call.includes(item.message.id))) {
        fail(violations, 'send', item.name, 'a successful send never passed the message id to the remote service (idempotency key)')
      }
    })
  }
}

async function checkProbe<C extends Record<string, unknown>>(subject: ConformanceSubject<C>, violations: Violation[]): Promise<void> {
  if (!subject.probes?.length) {
    if (subject.probe) fail(violations, 'probe', 'cases', 'a probe is declared without cases that prove its answers')
    return
  }
  if (!subject.probe) { fail(violations, 'probe', 'probe', 'probe cases are declared without a probe'); return }
  for (const item of subject.probes) {
    await guard('probe', item.name, violations, async () => {
      const answer = await subject.probe!(item.key)
      if (!PROBE_ANSWERS.has(answer)) fail(violations, 'probe', item.name, `probe answered ${String(answer)}, which is not sent, gone or unknown`)
      if (answer !== item.answer) fail(violations, 'probe', item.name, `expected ${item.answer}, got ${String(answer)}`)
      if (await subject.probe!(item.key) !== answer) fail(violations, 'probe', item.name, 'probe answers are not stable for one key')
    })
  }
}

/** Collects every violation of the contract; never throws, so a deliberately broken fixture can be checked too. */
export async function checkConformance<C extends Record<string, unknown>>(subject: ConformanceSubject<C>): Promise<Violation[]> {
  const violations: Violation[] = []
  await guard('manifest', 'manifest', violations, () => checkManifest(subject, violations))
  await guard('triggers', 'events', violations, () => checkTriggers(subject, violations))
  await guard('cursor', 'step', violations, () => checkCursor(subject, violations))
  await guard('health', 'claims', violations, () => checkHealth(subject, violations))
  await guard('scope', 'decisions', violations, () => checkScope(subject, violations))
  await guard('send', 'outbound', violations, () => checkSend(subject, violations))
  await guard('probe', 'answers', violations, () => checkProbe(subject, violations))
  return violations
}

/**
 * Registers the suite for one Source. Its `it` per group names the contract it holds, so a failure reads as the
 * rule that broke rather than the test file.
 */
export function describeConformance<C extends Record<string, unknown>>(subject: ConformanceSubject<C>): void {
  const id = subject.definition.manifest.id
  let checks: Promise<Violation[]> | undefined
  for (const group of GROUPS) {
    describe(`${id} adapter conformance · ${group.label}`, () => {
      it(`obeys the ${group.label} contract`, async () => {
        checks ??= checkConformance(subject)
        const failures = (await checks).filter(item => item.group === group.id).map(item => `${item.case}: ${item.detail}`)
        expect(failures).toEqual([])
      })
    })
  }
}