/**
 * The offline replacement drill's driver: one fixed task, run through the real Engine and a real SQLite Store, with an
 * interchangeable Executor boundary and a read-only task projection that can be read or hidden.
 *
 * The drill never touches a network, a credential, DSH or a model. It replays a recorded Executor decision sequence and
 * drives the same Engine callbacks, then compares the stored decisions, tickets, trace, activity, outbox requests and
 * the organization/attention figures. A failing replacement proves the failure is recorded rather than hidden, and
 * reinstating the baseline Executor proves recovery. `scripts/replacement/run.mjs` prints the report this module returns
 * and `tests/replacement-drill.spec.ts` asserts it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, latestAssignment, traceId, type Assignment, type Candidate, type Executor, type Outbox, type Policy,
  type ReplyStatus, type Ticket, type Trigger } from '@superagent/kernel'
import { ActivityLog, type ActivityRecord } from '@superagent/dsh/app/activity.ts'
import { attentionMetrics, organizationMetrics, type AttentionMetrics, type OrganizationMetrics } from '@superagent/dsh/app/replacement.ts'
import { Store } from '@superagent/dsh/app/store.ts'
import { taskBoard, taskDetail, type TaskBoardView, type TaskDetailView } from '@superagent/dsh/app/tasks.ts'
import type { ViewHost } from '@superagent/dsh/app/views/records.ts'
import { SqliteTraceSink } from '@superagent/dsh/app/trace.ts'

/** The fixed instant every run starts from; each Engine call advances one second. */
export const DRILL_NOW = '2026-11-11T00:00:00.000Z'
/** The one Trigger the drill's task comes from. */
export const DRILL_TRIGGER = 'replacement-drill-trigger'
const THREAD = 'conversation:drill'
const ACTOR = { source: 'conversation', id: 'local-user' }
const PARENT_OWNER = { source: 'dsh-superagent', id: 'parent-owner' }
const ACK = 'On it: running the replacement drill'
const RESULT = 'Drill: completed'
const CHILD_GOAL = 'Child drill work'

/** Which run is being made: the hierarchy baseline, a replayed Executor, a flat organization, or a failing replacement. */
export type RunKind = 'baseline' | 'replay' | 'flat' | 'failure' | 'rollback'
/** The organization shape a run exercises. */
export type Shape = 'hierarchical' | 'flat' | 'failure'

/**
 * One step the fixture Executor asks the host to take. The actions are data, so a replay fixture is a plain JSON file
 * instead of a saved closure; ids are resolved against the live Store when the action runs.
 */
export type DrillAction =
  | { kind: 'started'; ticketId: string; assignmentId: string }
  | { kind: 'delegate'; parentId: string }
  | { kind: 'report'; ticketId: string; state: 'ready' | 'failed'; summary: string }
  | { kind: 'delivered'; ticketId: string }
  | { kind: 'read'; ticketId: string }
  | { kind: 'acceptChild'; parentId: string; childId: string }
  | { kind: 'failChild'; parentId: string; childId: string; reason: string }
  | { kind: 'result'; ticketId: string; text: string }

/** A recorded Executor boundary: the plans `start` and `deliver` queued, in call order. */
export interface ExecutorReplay {
  starts: DrillAction[][]
  delivers: DrillAction[][]
}

/** What the Store held after one run, all plain data so it survives the Store closing. */
export interface DrillDigest {
  decisions: unknown[]
  tickets: Ticket[]
  spans: unknown[]
  activity: ActivityRecord[]
  outbox: unknown[]
  organization: OrganizationMetrics
  attention: AttentionMetrics
}

/** One drill run's evidence and verdict. */
export interface DrillRun {
  kind: RunKind
  digest: DrillDigest
  /** The read-only task projection, when the run read it; the view-hidden run leaves it undefined. */
  board?: TaskBoardView
  detail?: TaskDetailView
  /** Rows added or changed by reading the task projection; always empty for a projection with no write path. */
  viewWrites: string[]
  /** The Executor fixture this run recorded, for the baseline only. */
  fixture?: ExecutorReplay
  audit: { checks: { name: string; ok: boolean; detail: string }[]; complete: boolean }
}

/** A run's outcome summarized for the report table. */
export interface RunSummary {
  kind: RunKind
  tickets: number
  children: number
  depth: number
  spans: number
  decisions: number
  activity: { quiet: number; feed: number; notice: number }
  outbox: number
  result: string
  complete: boolean
}

/** A difference between the baseline and another run, graded instead of waved through. */
export interface Difference {
  id: string
  area: 'behavior' | 'audit' | 'notification' | 'structure' | 'coverage'
  severity: 'none' | 'low' | 'medium' | 'high'
  detail: string
}

/** The drill's whole result: the runs, the equivalence verdicts, the graded differences and the fixed fixture. */
export interface DrillReport {
  generatedAt: string
  runs: RunSummary[]
  equivalence: { executorReplay: boolean; flatBehavior: boolean; viewHidden: boolean; rollback: boolean }
  audits: { kind: RunKind; checks: { name: string; ok: boolean; detail: string }[] }[]
  differences: Difference[]
  fixture: ExecutorReplay
}

/** The fixed Policy every run shares; it is a port, not the deployment's settings. */
function policy(): Policy {
  return {
    version: 'replacement-drill-v1', paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
    revalidate: () => ({ ok: true }),
    mandateLimits: () => ({ maxActionLevel: 'send' }),
    admitsInferred: () => false,
  }
}

/** The outbox port: records the request and reports it as pending, exactly like a queued receipt. */
class RecordingOutbox implements Outbox {
  readonly messages: { id: string; kind: string; ticketId?: string; text: string }[] = []
  send(message: { action: { idempotencyKey: string; kind: string }; ticketId?: string; text: string }): void {
    if (this.messages.some(item => item.id === message.action.idempotencyKey)) return
    this.messages.push({ id: message.action.idempotencyKey, kind: message.action.kind, ticketId: message.ticketId, text: message.text })
  }
  status(id: string): ReplyStatus | undefined {
    return this.messages.some(item => item.id === id) ? 'pending' : undefined
  }
  withdraw(): void { /* No effect leaves the drill's in-memory queue. */ }
  recall(id: string): ReplyStatus { return this.status(id) ?? 'pending' }
}

/** What one run's fixture Executor needs from the host: the actions queue and the Engine callbacks they name. */
interface DrillHost {
  enqueue(actions: readonly DrillAction[]): void
  pump(): void
}

/**
 * The original Executor of the drill: it plans the fixture worker's steps for a root or child Assignment and for the
 * delivery of a child report. It only queues, as the Executor port requires; the host runs the callbacks.
 */
class ScriptedExecutor implements Executor {
  readonly replay: ExecutorReplay = { starts: [], delivers: [] }
  constructor(private readonly host: DrillHost, private readonly shape: Shape) {}
  start(ticket: Ticket, assignment: Assignment): void {
    const plan = this.startPlan(ticket, assignment)
    this.replay.starts.push(plan)
    this.host.enqueue(plan)
  }
  deliver(ticket: Ticket): void {
    if (ticket.parentTicketId) return
    const child = [...ticket.inputs].reverse().find(input => input.kind === 'child-report')?.childTicketId
    const plan: DrillAction[] = [{ kind: 'delivered', ticketId: ticket.id }, { kind: 'read', ticketId: ticket.id }]
    if (this.shape === 'failure') {
      if (child) plan.push({ kind: 'failChild', parentId: ticket.id, childId: child, reason: 'child drill failed' })
      plan.push({ kind: 'report', ticketId: ticket.id, state: 'failed', summary: 'blocked by a failed child' })
    } else {
      if (child) plan.push({ kind: 'acceptChild', parentId: ticket.id, childId: child })
      plan.push({ kind: 'report', ticketId: ticket.id, state: 'ready', summary: 'drill ready' }, { kind: 'result', ticketId: ticket.id, text: RESULT })
    }
    this.replay.delivers.push(plan)
    this.host.enqueue(plan)
  }
  stop(): void { /* The drill has nothing to cancel. */ }
  private startPlan(ticket: Ticket, assignment: Assignment): DrillAction[] {
    const started: DrillAction = { kind: 'started', ticketId: ticket.id, assignmentId: assignment.id }
    if (ticket.parentTicketId) {
      return [started, { kind: 'report', ticketId: ticket.id, state: this.shape === 'failure' ? 'failed' : 'ready',
        summary: this.shape === 'failure' ? 'child drill failed' : 'child drill ready' }]
    }
    if (this.shape === 'flat') {
      return [started, { kind: 'report', ticketId: ticket.id, state: 'ready', summary: 'drill ready' },
        { kind: 'result', ticketId: ticket.id, text: RESULT }]
    }
    return [started, { kind: 'delegate', parentId: ticket.id }]
  }
}

/** The replacement Executor: it looks each plan up in the recorded fixture instead of deciding anything itself. */
class ReplayExecutor implements Executor {
  private startIndex = 0
  private deliverIndex = 0
  constructor(private readonly host: DrillHost, private readonly replay: ExecutorReplay) {}
  start(): void { this.host.enqueue(this.replay.starts[this.startIndex++] ?? []) }
  deliver(): void { this.host.enqueue(this.replay.delivers[this.deliverIndex++] ?? []) }
  stop(): void { /* The replay has no live work to cancel. */ }
}

/** The boundary the Engine holds: a stable port whose implementation the drill swaps after construction. */
class SwitchableExecutor implements Executor {
  constructor(public current: Executor) {}
  start(ticket: Ticket, assignment: Assignment): void { this.current.start(ticket, assignment) }
  deliver(ticket: Ticket, assignment: Assignment): void { this.current.deliver(ticket, assignment) }
  stop(ticket: Ticket, assignment: Assignment, reason: string): void { this.current.stop(ticket, assignment, reason) }
}

/** One run's open Store, Engine and host; the callbacks resolve ids against the live Store. */
class Run {
  private readonly queue: DrillAction[] = []
  private readonly clockStart = Date.parse(DRILL_NOW)
  private clock = 0
  readonly store: Store
  private readonly activity: ActivityLog
  readonly outbox = new RecordingOutbox()
  readonly requests: Candidate[] = []
  readonly engine: Engine
  readonly host: DrillHost
  private readonly executor: SwitchableExecutor
  readonly scripted: ScriptedExecutor
  constructor(readonly directory: string, shape: Shape) {
    this.store = new Store(join(directory, 'orchestrator.sqlite'))
    this.activity = new ActivityLog(this.store)
    const host: DrillHost = { enqueue: actions => { this.queue.push(...actions) }, pump: () => this.pump() }
    this.host = host
    this.scripted = new ScriptedExecutor(host, shape)
    this.executor = new SwitchableExecutor(this.scripted)
    this.engine = new Engine({
      repo: this.store,
      policy,
      scope: { scope: () => ({ listened: true, observed: false }) },
      assessor: { request: candidate => { this.requests.push(candidate) } },
      executor: this.executor,
      outbox: this.outbox,
      now: () => new Date(this.clockStart + this.clock++ * 1000).toISOString(),
      emit: event => { this.activity.record(event) },
      trace: new SqliteTraceSink(this.store),
      prepareTicket: ticket => ({ ...ticket, form: 'tracked', execution: { name: `drill-${ticket.id.slice(-8)}`,
        directory: `/tmp/replacement-drill/${ticket.id}`, assignment: 'Run the replacement drill' } }),
    })
  }
  /** Replace the Executor implementation after the Engine exists; the replay boundary keeps the same callbacks. */
  use(executor: Executor): void { this.executor.current = executor }
  pump(): void {
    while (this.queue.length) {
      const action = this.queue.shift()!
      this.apply(action)
    }
  }
  private apply(action: DrillAction): void {
    const ticket = (id: string) => this.store.tickets.get(id)
    const assignment = (id: string) => latestAssignment(ticket(id)!)
    switch (action.kind) {
      case 'started':
        this.engine.assignmentStarted(action.ticketId, action.assignmentId)
        return
      case 'delegate':
        this.engine.delegate(action.parentId, { goal: CHILD_GOAL, scope: 'replacement drill child' })
        return
      case 'report':
        this.engine.report(action.ticketId, { state: action.state, summary: action.summary,
          assignmentId: assignment(action.ticketId)?.id })
        return
      case 'delivered': {
        const current = ticket(action.ticketId)!
        if (current.undelivered.length) this.engine.inputsDelivered(current.id, assignment(current.id)!.id, [...current.undelivered])
        return
      }
      case 'read': {
        const current = ticket(action.ticketId)!
        const ids = current.inputs.filter(input => input.kind === 'child-report'
          && (input.readAt === undefined || input.readAt === null)).map(input => input.id)
        if (ids.length) this.engine.inputsRead(current.id, ids)
        return
      }
      case 'acceptChild':
        this.engine.acceptChild(action.parentId, action.childId, PARENT_OWNER)
        return
      case 'failChild':
        this.engine.cancelChild(action.parentId, action.childId, PARENT_OWNER, action.reason, 'failed')
        return
      case 'result':
        this.engine.reply({ purpose: 'result', ticketId: action.ticketId, text: action.text })
        return
    }
  }
  /** Runs the fixed task: one human request, one explicit accept, then the fixture Executor's steps. */
  run(): void {
    const trigger: Trigger = { id: DRILL_TRIGGER, source: 'conversation', threads: [{ source: 'conversation', id: 'drill' }],
      actor: ACTOR, human: true, at: DRILL_NOW, text: '做替换演练', meta: {},
      channel: { source: 'conversation', thread: THREAD, address: {} } }
    this.engine.receive(trigger)
    this.engine.evaluateDue()
    const candidate = this.requests[0]
    if (!candidate) throw new Error('the drill trigger produced no candidate')
    this.engine.candidateDelivered(candidate.evalId)
    const decision = this.engine.decide(trigger.id, { kind: 'accept', title: 'Replacement drill task', scope: '组织观测与替换演练',
      reason: 'authorized drill', acknowledgement: ACK, rules: ['explicit'], evalId: candidate.evalId })
    if (!decision.ticketId) throw new Error('the drill accept produced no ticket')
    this.host.pump()
  }
  digest(): DrillDigest {
    return {
      decisions: this.store.decisions.byThread(THREAD),
      tickets: this.store.tickets.allList(),
      spans: this.store.spans.byTraces([traceId(DRILL_TRIGGER)]),
      activity: this.store.activity.recent(500),
      outbox: this.outbox.messages,
      organization: organizationMetrics(this.store),
      attention: attentionMetrics(this.store),
    }
  }
  close(): void { this.store.close() }
}

/** The rows a digest names, as stable text, to compare a run with itself before and after reading the task view. */
function digestText(digest: DrillDigest): string {
  return JSON.stringify([digest.decisions, digest.tickets, digest.spans, digest.activity, digest.outbox])
}

/** The root Ticket of a run, or undefined if the accept produced none. */
export function rootOf(digest: DrillDigest): Ticket | undefined {
  return digest.tickets.find(ticket => !ticket.parentTicketId)
}
/** The child Tickets of a run. */
export function childrenOf(digest: DrillDigest): Ticket[] {
  return digest.tickets.filter(ticket => !!ticket.parentTicketId)
}
/** The span kinds a run recorded. */
export function spanKinds(digest: DrillDigest): string[] {
  return digest.spans.map(span => String((span as { kind: unknown }).kind))
}

/**
 * Checks that a run's audit chain is complete and can explain the Ticket without a task view: the Decision authorized a
 * root, the root has an Assignment with a report, the trace reached every stage the Engine ran, the activity kept the
 * events, and the result has a queued message. A missing link is listed, never silently accepted.
 */
export function audit(digest: DrillDigest): DrillRun['audit'] {
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
  const root = rootOf(digest)
  const decisions = digest.decisions as { kind: string; mandate?: unknown }[]
  check('decision', decisions.some(decision => decision.kind === 'accept' && !!decision.mandate),
    `accepted Decision(s): ${decisions.filter(decision => decision.kind === 'accept').length}`)
  check('root', !!root?.decisionId && !!root.mandate, root ? `root ${root.id}` : 'no root Ticket')
  const report = root ? latestAssignment(root)?.report : undefined
  check('report', !!report, report ? `${report.state} report on the latest Assignment` : 'no report')
  const kinds = new Set(spanKinds(digest))
  const required = ['ingest', 'enqueue', 'gate', 'assess', 'decide', 'attach', 'dispatch', 'report']
  const missing = required.filter(kind => !kinds.has(kind))
  check('trace', missing.length === 0, missing.length ? `missing stages: ${missing.join(', ')}` : `${kinds.size} stage kinds`)
  const events = new Set<string>(digest.activity.map(record => String(record.event)))
  const wanted = ['decision.recorded', 'ticket.created', 'assignment.started']
  const missingEvents = wanted.filter(event => !events.has(event))
  check('activity', missingEvents.length === 0, missingEvents.length ? `missing events: ${missingEvents.join(', ')}` : `${digest.activity.length} records`)
  const messages = digest.outbox as { kind: string; ticketId?: string }[]
  const acknowledged = messages.some(message => message.kind === 'acknowledgement')
  const replied = messages.some(message => message.kind === 'reply')
  const needsReply = !report || report.state === 'ready'
  check('outbox', acknowledged && (replied || !needsReply),
    `${messages.length} request(s): acknowledgement ${acknowledged}; result reply ${replied}${needsReply ? ' (needed)' : ' (not needed before a person acts)'}`)
  if (digest.tickets.some(ticket => ticket.parentTicketId)) {
    const child = childrenOf(digest)[0]!
    const resolved = child.delegation?.resolution?.kind
    check('child-chain', !!child.delegation && !!resolved && !!child.delegation.lastDisposition,
      child.delegation ? `child ${child.id}; resolution ${resolved ?? 'none'}` : 'child has no delegation')
  }
  return { checks, complete: checks.every(item => item.ok) }
}

/** A summary for the report's run table. */
function summarize(kind: RunKind, digest: DrillDigest, complete: boolean): RunSummary {
  const root = rootOf(digest)
  const result = root?.ended?.outcome ?? (root ? latestAssignment(root)?.report?.state : undefined) ?? 'none'
  return { kind, tickets: digest.tickets.length, children: childrenOf(digest).length, depth: digest.organization.tickets.maxDepth,
    spans: digest.spans.length, decisions: digest.decisions.length,
    activity: { quiet: digest.attention.activity.quiet, feed: digest.attention.activity.feed, notice: digest.attention.activity.notice },
    outbox: (digest.outbox as unknown[]).length, result, complete }
}

/** The read-only task projection; the view itself must not change a row it reads. */
function readView(store: Store): { board: TaskBoardView; detail?: TaskDetailView } {
  const host = { store, sources: { kind: () => undefined }, links: () => undefined } as unknown as ViewHost
  const board = taskBoard(host, new Date(DRILL_NOW))
  const root = store.tickets.allList().find(ticket => !ticket.parentTicketId)
  return { board, detail: root ? taskDetail(host, root.id, 2, new Date(DRILL_NOW)) : undefined }
}

/** One run from an empty Store to the finished digest, with the task view read or hidden as asked. */
function execute(kind: RunKind, shape: Shape, mode: 'scripted' | 'replay', fixture: ExecutorReplay | undefined, view: boolean): DrillRun {
  const directory = mkdtempSync(join(tmpdir(), 'replacement-drill-'))
  const run = new Run(directory, shape)
  try {
    if (mode === 'replay' && fixture) run.use(new ReplayExecutor(run.host, fixture))
    run.run()
    const digest = run.digest()
    let board: TaskBoardView | undefined, detail: TaskDetailView | undefined
    let viewWrites: string[] = []
    if (view) {
      const before = digestText(run.digest())
      const projected = readView(run.store)
      board = projected.board
      detail = projected.detail
      viewWrites = before === digestText(run.digest()) ? [] : ['the task projection changed a stored row']
    }
    const evidence = audit(digest)
    return { kind, digest, board, detail, viewWrites, fixture: mode === 'scripted' ? run.scripted.replay : undefined,
      audit: evidence }
  } finally {
    run.close()
    rmSync(directory, { recursive: true, force: true })
  }
}

/** Whether two plain values are equal after JSON normalization. */
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

/** The user-visible end of a run: the root outcome, the result messages and the notice count. */
function endOf(run: DrillRun): { outcome?: string; result: string[]; notices: number; requests: number } {
  const root = rootOf(run.digest)
  const result = (run.digest.outbox as { kind: string; text: string }[]).filter(message => message.kind === 'reply').map(message => message.text)
  return { outcome: root?.ended?.outcome, result, notices: run.digest.attention.activity.notice, requests: (run.digest.outbox as unknown[]).length }
}

/**
 * Runs the whole drill: the original Executor and its fixture, the replay replacement, a flat organization, a failing
 * replacement, and the baseline again after rollback. Returns the evidence and the graded differences.
 */
export function runReplacementDrill(): DrillReport {
  const baseline = execute('baseline', 'hierarchical', 'scripted', undefined, true)
  const fixture = baseline.fixture!
  const replay = execute('replay', 'hierarchical', 'replay', fixture, false)
  const flat = execute('flat', 'flat', 'scripted', undefined, false)
  const failure = execute('failure', 'failure', 'scripted', undefined, false)
  const rollback = execute('rollback', 'hierarchical', 'scripted', undefined, false)

  const executorReplay = same([baseline.digest.decisions, baseline.digest.tickets, baseline.digest.spans,
    baseline.digest.activity, baseline.digest.outbox, baseline.digest.organization, baseline.digest.attention],
  [replay.digest.decisions, replay.digest.tickets, replay.digest.spans, replay.digest.activity, replay.digest.outbox,
    replay.digest.organization, replay.digest.attention])
  const baselineEnd = endOf(baseline), flatEnd = endOf(flat), rollbackEnd = endOf(rollback)
  const flatBehavior = baselineEnd.outcome === flatEnd.outcome && same(baselineEnd.result, flatEnd.result)
    && baselineEnd.notices === flatEnd.notices && baselineEnd.requests === flatEnd.requests
  const viewHidden = baseline.viewWrites.length === 0 && same(
    [baseline.digest.decisions, baseline.digest.tickets, baseline.digest.spans, baseline.digest.activity, baseline.digest.outbox],
    [rollback.digest.decisions, rollback.digest.tickets, rollback.digest.spans, rollback.digest.activity, rollback.digest.outbox])
  const rollbackRecovered = rollback.audit.complete && rollbackEnd.outcome === 'completed'
    && same(baseline.digest.tickets.map(ticket => [ticket.id, ticket.ended?.outcome]),
      rollback.digest.tickets.map(ticket => [ticket.id, ticket.ended?.outcome]))

  const differences: Difference[] = [
    { id: 'D1', area: 'coverage', severity: 'medium',
      detail: 'The Executor boundary is replaced by a replay driver, not by the production DshExecutor, which needs a DSH host and a model. Equivalence is proven at the port and Engine/Store contract, not for a live model turn.' },
    { id: 'D2', area: 'structure', severity: 'low',
      detail: `Flattening the organization changes the task tree (${baselineEnd.outcome ?? 'open'} root with ${baseline.digest.organization.tickets.children} child -> flat with 0) and removes the delegation spans; the result outcome and result messages stay equal, so the difference is structural and audit-complete, not a behavior regression.` },
    { id: 'D3', area: 'coverage', severity: 'medium',
      detail: 'The model provider is not replaced: the replay fixture fixes the worker decisions, so this drill cannot claim provider-level output equivalence.' },
    { id: 'D4', area: 'notification', severity: 'medium',
      detail: 'Notifications are compared as Outbox requests and graded activity, not as live Source deliveries; the withdraw drill covers the transport Channel contract separately.' },
    { id: 'D5', area: 'coverage', severity: 'medium',
      detail: 'Auto-open close rate and default-surface click depth are not collected: both live only in the browser, so the attention figures report them as not-collected rather than zero.' },
    { id: 'D6', area: 'coverage', severity: 'medium',
      detail: 'The Store stays SQLite in every run; the drill does not swap Repositories for another implementation, so the storage boundary is supported by the domain tests over MemoryRepositories rather than by this drill.' },
  ]

  return {
    generatedAt: DRILL_NOW,
    runs: [baseline, replay, flat, failure, rollback].map(run => summarize(run.kind, run.digest, run.audit.complete)),
    equivalence: { executorReplay, flatBehavior, viewHidden, rollback: rollbackRecovered },
    audits: [baseline, replay, flat, failure, rollback].map(run => ({ kind: run.kind, checks: run.audit.checks })),
    differences,
    fixture,
  }
}
/** The drill's Markdown table and graded differences, for the runbook and `pnpm drill:replacement`. */
export function markdownReport(report: DrillReport): string {
  const lines = [
    '| Run | Tickets | Children | Depth | Spans | Decisions | quiet/feed/notice | Outbox | Result | Audit |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.runs.map(run => `| ${run.kind} | ${run.tickets} | ${run.children} | ${run.depth} | ${run.spans} | ${run.decisions} | `
      + `${run.activity.quiet}/${run.activity.feed}/${run.activity.notice} | ${run.outbox} | ${run.result} | ${run.complete ? 'complete' : 'incomplete'} |`),
    '',
    `Equivalence: executor replay ${report.equivalence.executorReplay}; flat behavior ${report.equivalence.flatBehavior}; `
      + `view hidden ${report.equivalence.viewHidden}; rollback ${report.equivalence.rollback}.`,
    '',
    ...report.audits.flatMap(auditRun => [`${auditRun.kind}: ${auditRun.checks.map(check => `${check.name}=${check.ok ? 'ok' : `FAIL (${check.detail})`}`).join('; ')}`]),
    '',
    ...report.differences.map(item => `- ${item.id} (${item.area}/${item.severity}): ${item.detail}`),
  ]
  return lines.join('\n')
}
