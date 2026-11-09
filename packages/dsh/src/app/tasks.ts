/**
 * The Tickets board: the task-plan shape of the work, its progress, and the pull-request lanes the optional graph draws.
 *
 * Milestones and task ids come from the Ticket titles and Mandate scopes the task plan already uses (`M2`, `T2-03`), and
 * reviews and pull requests come from the ownership derivation shared with the Events tab. Nothing here writes to the
 * Store: a board is a projection of the Tickets, Threads and reports that exist, so it cannot disagree with them.
 */
import { latestReport, liveTicket, threadKey, ticketForm, traceId, type Artifact, type HumanCriterion, type PreviewRef, type RuleCriterion,
  type Span, type Thread, type ThreadFacts, type Ticket, type TicketOutcome } from '@superagent/kernel'
import { activityStatusOf, type ActivityRecord, type ActivityStatus } from './activity.ts'
import { isReviewTicket, ownershipIndex, type OwnershipIndex, type PlanRef } from './ownership.ts'
import { snapshot, threadFacts, type ActorView, type Snapshot, type ViewHost } from './views/records.ts'
import { markdown, preview } from './views/text.ts'
import { workerSessionId } from '../executor/dsh.ts'

/** What a node stands for: a planning milestone, a planned task, a Ticket, a review Ticket, or a pull request. */
export type TaskNodeKind = 'milestone' | 'task' | 'ticket' | 'review' | 'pull'

/** One node of the Tickets board, with the counts and the times its header shows. */
export interface TaskNode {
  kind: TaskNodeKind
  id: string
  title: string
  subtitle?: string
  status: ActivityStatus
  /** How many descendant Tickets finished; a planned task and a milestone only. */
  progress?: { done: number; total: number }
  /** From the earliest descendant's start to the latest end, or to now for live work. */
  durationMs?: number
  startedAt?: string
  endedAt?: string
  /** How the work ended, for a graph merge point. */
  outcome?: TicketOutcome
  /** Where the client opens the node: an internal page, or the source's own URL for a pull request. */
  href?: { page: 'execution' | 'trigger'; id: string } | { url: string }
  /** The task id a graph lane labels itself with, and the source facts a pull request shows. */
  plan?: { milestone: string; task: string }
  facts?: ThreadFacts
  children: TaskNode[]
}

/** One pull request lane of a milestone graph; times are ISO so the client can scale them without reparsing a duration. */
export interface TaskGraphBranch {
  id: string
  title: string
  task: string
  start: string
  end?: string
  outcome?: TicketOutcome
  status: ActivityStatus
  lane: number
}

/** The time span and lanes the graph view draws for one milestone. */
export interface TaskGraph {
  start: string
  end: string
  lanes: number
  branches: TaskGraphBranch[]
}

/** A milestone node always carries its graph, so the two views of the same board cannot disagree. */
export interface TaskMilestone extends TaskNode { kind: 'milestone'; graph: TaskGraph }

/** One source anchor of a task: the conversation, pull request or other Thread the work came from. */
export interface TaskSourceView {
  source: string
  threadKey?: string
  label?: string
  url?: string
  facts?: ThreadFacts
}

/** One reviewable delivery, deduplicated by artifact and revision; the Phase 1 view has at most one per Ticket. */
export interface TaskDeliverableSummary {
  /** `<artifact.kind>:<artifact.ref>:<artifact.revision>`, the key a later aggregate dedupes parent and child work by. */
  key: string
  at: string
  artifact: Artifact
  previewRef: PreviewRef
  criteria: RuleCriterion[]
  confirmations: HumanCriterion[]
  summary: string
  /** The person who accepted this revision; present only when the report records it. */
  accepted?: { by: ActorView; at: string }
}

/** A Ticket's review surface: its recorded deliverable and criteria, empty when it delivered nothing reviewable. */
export interface TaskReviewView {
  deliverables: TaskDeliverableSummary[]
  criteria: RuleCriterion[]
  confirmations: HumanCriterion[]
  summary: string
  accepted?: { by: ActorView; at: string }
}

/** How a lightweight Ticket's inline run went, read from the trace it records instead of an Assignment. */
export interface TaskInlineView {
  steps: number
  lastActionAt?: string
  summary?: string
  traceId: string
}

/** One Ticket as the task list reads it; reviews stay separate rows and name the Ticket they review. */
export interface TaskView {
  id: string
  kind: 'ticket' | 'review'
  /** For a review, the Ticket whose pull request it reviews, when ownership resolves one. */
  reviewedTicketId?: string
  title: string
  /** Missing on records written before forms existed; both the data and the UI read that as `tracked`. */
  form: 'tracked' | 'lightweight'
  status: ActivityStatus
  /** `dropped` and `stopped` are terminal but not failures; counts use this, not `status` alone. */
  terminal?: 'dropped' | 'stopped'
  /** A person's turn: review, answer, delivery, blocked or failed work that has not ended. */
  attention?: boolean
  plan?: PlanRef
  origin: { source: string; triggerId: string; preview: string; at: string }
  sources: TaskSourceView[]
  lastEventAt?: string
  startedAt?: string
  endedAt?: string
  durationMs?: number
  /** The review Tickets finished below this Ticket; a delivery step count is not invented here. */
  progress?: { done: number; total: number }
  execution: { name?: string; sessionId?: string; assignments: number }
  /** Deduplicated deliveries; empty for a lightweight Ticket and for a Ticket with no reviewable report. */
  deliverables: TaskDeliverableSummary[]
  /** Present only when the latest report recorded a review with a preview; never an empty card. */
  review?: TaskReviewView
  /** Present only for a lightweight Ticket, whose inline run has no Assignment to describe it. */
  inline?: TaskInlineView
}

/** Everything the Tickets tab reads in one request. The plan tree stays for the rollback and the status-page tree/graph. */
export interface TaskBoardView {
  generatedAt: string
  milestones: TaskMilestone[]
  /** The flat task list both the right tab and the status page read; read-only and derived at request time. */
  tasks: TaskView[]
  totals: { milestones: number; tasks: number; tickets: number; open: number; attention: number }
}

/** The highest-standing child state; one failure colours the container, and an all-finished container is done. */
const ROLLUP: readonly ActivityStatus[] = ['failed', 'blocked', 'delivery', 'answer', 'review', 'working', 'queued', 'idle']
export function rollupStatus(statuses: readonly ActivityStatus[]): ActivityStatus {
  const live: ActivityStatus[] = statuses.filter(status => status !== 'done')
  return live.length ? ROLLUP.find(status => live.includes(status)) ?? 'idle' : 'done'
}

/** Every Ticket and review below a node, depth first; containers count work items, not their own rows. */
const workOf = (nodes: readonly TaskNode[]): TaskNode[] => nodes.flatMap(node =>
  node.kind === 'review' ? [node]
    : node.kind === 'ticket' ? [node, ...node.children.filter(child => child.kind === 'review')]
    : workOf(node.children))

/** A container's times and progress from all the work below it. */
function container(kind: 'milestone' | 'task', nodes: readonly TaskNode[], now: number,
  base: Omit<TaskNode, 'kind' | 'children' | 'status'>): TaskNode {
  const work = workOf(nodes)
  const starts = work.flatMap(node => node.startedAt ? [Date.parse(node.startedAt)] : []).filter(Number.isFinite)
  const ends = work.flatMap(node => node.endedAt ? [Date.parse(node.endedAt)] : []).filter(Number.isFinite)
  const live = work.some(node => !node.endedAt)
  const done = work.filter(node => node.status === 'done').length
  const end = live ? Math.max(now, ...ends) : Math.max(...ends)
  return { kind, ...base, status: rollupStatus(work.map(node => node.status)),
    ...work.length ? { progress: { done, total: work.length } } : {},
    ...starts.length ? { startedAt: new Date(Math.min(...starts)).toISOString(), durationMs: Math.max(0, end - Math.min(...starts)) } : {},
    ...ends.length && !live ? { endedAt: new Date(Math.max(...ends)).toISOString() } : {},
    children: [...nodes] }
}

const span = (ticket: Ticket, now: number): Pick<TaskNode, 'durationMs' | 'startedAt' | 'endedAt' | 'outcome'> => {
  const start = Date.parse(ticket.createdAt)
  const end = ticket.ended ? Date.parse(ticket.ended.at) : now
  if (!Number.isFinite(start) || !Number.isFinite(end)) return {}
  return { durationMs: Math.max(0, end - start), startedAt: ticket.createdAt, ...ticket.ended ? { endedAt: ticket.ended.at } : {},
    ...ticket.ended ? { outcome: ticket.ended.outcome } : {} }
}

/** A reviewed pull request as a leaf: its CI fact and source link, which is where the review itself lives. */
function threadNode(thread: Thread, view: Snapshot): TaskNode {
  const facts = threadFacts(view.store, thread)
  const status: ActivityStatus = thread.meta.pollError ? 'failed' : thread.evaluating || thread.pending.length ? 'working' : 'idle'
  return { kind: 'pull', id: thread.key, title: facts.title, subtitle: thread.ref.source, status,
    ...facts.url ? { href: { url: facts.url } } : { href: { page: 'trigger', id: thread.key } },
    facts: facts.facts, children: [] }
}

function reviewNode(ticket: Ticket, now: number): TaskNode {
  return { kind: 'review', id: ticket.id, title: ticket.title, subtitle: ticket.ended?.reason || undefined,
    status: activityStatusOf(ticket), ...span(ticket, now), href: { page: 'execution', id: ticket.id }, children: [] }
}

function ticketNode(ticket: Ticket, view: Snapshot, index: OwnershipIndex, now: number): TaskNode {
  const reviews = index.reviewsOf(ticket.id).map(review => reviewNode(review, now))
  const pulls = view.threadsOf(ticket.id)
    .filter(thread => thread.ref.source === 'github' && /^\d+$/.test(thread.ref.id))
    .map(thread => threadNode(thread, view))
  const facts = pulls.length === 1 && pulls[0]!.facts ? pulls[0]!.facts : undefined
  return { kind: 'ticket', id: ticket.id, title: ticket.title, status: activityStatusOf(ticket), ...span(ticket, now),
    ...reviews.length ? { progress: { done: reviews.filter(node => node.status === 'done').length, total: reviews.length } } : {},
    href: { page: 'execution', id: ticket.id }, ...facts ? { facts } : {},
    children: [...pulls, ...reviews] }
}

/** A top-level node keeps a review's own kind when no owning Ticket could be found; it is never silently relabelled as work. */
const topNode = (ticket: Ticket, view: Snapshot, index: OwnershipIndex, now: number): TaskNode =>
  isReviewTicket(ticket) ? reviewNode(ticket, now) : ticketNode(ticket, view, index, now)

interface Group { plan: PlanRef; tickets: Ticket[] }

/** The task-plan grouping: `M1`/`M2` first, then Tickets no plan names, each standing as its own task. */
function groups(tickets: readonly Ticket[], index: OwnershipIndex): { plans: Group[]; unplanned: Ticket[] } {
  const plans = new Map<string, Group>()
  const unplanned: Ticket[] = []
  for (const ticket of tickets) {
    const plan = index.of(ticket.id).plan
    if (!plan) { unplanned.push(ticket); continue }
    const group = plans.get(plan.task) ?? { plan, tickets: [] }
    group.tickets.push(ticket)
    plans.set(plan.task, group)
  }
  const ordered = [...plans.values()].sort((left, right) => {
    const [lm = 0, lt = 0] = left.plan.task.replace('T', '').split('-').map(Number)
    const [rm = 0, rt = 0] = right.plan.task.replace('T', '').split('-').map(Number)
    return lm - rm || lt - rt
  })
  return { plans: ordered, unplanned }
}

/** The task name: the first non-review Ticket's title without its plan tag, else the task id. */
const taskTitle = (group: Group, index: OwnershipIndex): string => {
  const first = group.tickets.find(ticket => !isReviewTicket(ticket))
  return first ? index.of(first.id).plan?.title ?? group.plan.task : group.plan.task
}

/** Assign each Ticket a lane: it reuses the lowest lane whose last branch already ended when it starts. */
export function graphOf(tasks: readonly TaskNode[], now: number): TaskGraph {
  const branches: TaskGraphBranch[] = tasks.flatMap(task => {
    const tickets = task.kind === 'ticket' ? [task] : task.children.filter(node => node.kind === 'ticket')
    return tickets.flatMap(node => {
      if (!node.startedAt) return []
      return [{ id: node.id, title: node.title, task: task.subtitle ?? task.title, start: node.startedAt,
        ...node.endedAt ? { end: node.endedAt } : {}, ...node.outcome ? { outcome: node.outcome } : {},
        status: node.status, lane: 0 }]
    })
  })
  branches.sort((left, right) => Date.parse(left.start) - Date.parse(right.start) || left.id.localeCompare(right.id))
  const lanes: number[] = []
  for (const branch of branches) {
    const start = Date.parse(branch.start)
    const lane = lanes.findIndex(end => end <= start)
    if (lane < 0) { branch.lane = lanes.length; lanes.push(branch.end ? Date.parse(branch.end) : Number.POSITIVE_INFINITY) }
    else { branch.lane = lane; lanes[lane] = branch.end ? Date.parse(branch.end) : Number.POSITIVE_INFINITY }
  }
  const starts = branches.map(branch => Date.parse(branch.start)).filter(Number.isFinite)
  const ends = branches.flatMap(branch => branch.end ? [Date.parse(branch.end)] : []).filter(Number.isFinite)
  const start = starts.length ? Math.min(...starts) : now
  const end = branches.some(branch => !branch.end) || !ends.length ? Math.max(now, ...ends) : Math.max(...ends)
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), lanes: Math.max(lanes.length, 1), branches }
}

const milestoneNode = (id: string, title: string, tasks: TaskNode[], now: number): TaskMilestone => ({
  ...container('milestone', tasks, now, { id, title }) as TaskNode, kind: 'milestone', graph: graphOf(tasks, now) })

/** The person stages that make a task need attention; the same set the Events tab's `attention` filter uses. */
const ATTENTION: ReadonlySet<ActivityStatus> = new Set(['review', 'answer', 'delivery', 'blocked', 'failed'])
const TERMINAL: Partial<Record<TicketOutcome, 'dropped' | 'stopped'>> = { dropped: 'dropped', stopped: 'stopped' }

/** One snapshot of a Ticket's latest review; absent unless the report recorded a preview of the artifact. */
function reviewOf(ticket: Ticket, view: Snapshot): { review?: TaskReviewView; deliverables: TaskDeliverableSummary[] } {
  const report = latestReport(ticket)
  // A review without a preview cannot be shown or approved; render no card rather than an empty one.
  const recorded = report?.review
  if (!report || !recorded?.deliverable?.previewRef) return { deliverables: [] }
  const { artifact, previewRef } = recorded.deliverable
  const accepted = report.accepted ? { by: view.actor(report.accepted.by), at: report.accepted.at } : undefined
  const summary = markdown(report.summary)
  const deliverable: TaskDeliverableSummary = { key: `${artifact.kind}:${artifact.ref}:${artifact.revision}`, at: report.at, artifact,
    previewRef, criteria: recorded.criteria, confirmations: recorded.confirmations, summary, ...accepted ? { accepted } : {} }
  return { review: { deliverables: [deliverable], criteria: recorded.criteria, confirmations: recorded.confirmations, summary,
    ...accepted ? { accepted } : {} }, deliverables: [deliverable] }
}

/** A lightweight Ticket's inline history, from the action spans under its Trigger's trace. */
function inlineOf(ticket: Ticket, spans: readonly Span[]): TaskInlineView {
  const actions = spans.filter(item => item.kind === 'action')
  const last = actions.reduce<string | undefined>((latest, item) => !latest || item.at > latest ? item.at : latest, undefined)
  return { steps: actions.length, ...last ? { lastActionAt: last } : {},
    ...ticket.ended?.reason ? { summary: markdown(ticket.ended.reason) } : {}, traceId: traceId(ticket.origin.triggerId) }
}

/** The source anchors a row shows: the originating Trigger first, then every Thread the Ticket subscribes to. */
function sourcesOf(ticket: Ticket, view: Snapshot): TaskSourceView[] {
  const trigger = view.store.triggers.get(ticket.origin.triggerId)
  const sources: TaskSourceView[] = []
  if (trigger) {
    const originKey = trigger.threads[0] ? threadKey(trigger.threads[0]) : undefined
    sources.push({ source: trigger.source, ...originKey ? { threadKey: originKey } : {}, label: preview(trigger.text, 80),
      ...trigger.url ? { url: trigger.url } : {} })
  }
  for (const thread of view.threadsOf(ticket.id)) {
    const facts = threadFacts(view.store, thread)
    if (sources.some(item => item.threadKey === facts.key)) continue
    sources.push({ source: facts.source, threadKey: facts.key, label: facts.title, ...facts.url ? { url: facts.url } : {},
      ...Object.keys(facts.facts).length ? { facts: facts.facts } : {} })
  }
  return sources
}

/** One Ticket's flat task row; everything here is derived at request time and writes nothing. */
function taskView(ticket: Ticket, view: Snapshot, index: OwnershipIndex, now: number, latest: ActivityRecord | undefined,
  inlineSpans: readonly Span[]): TaskView {
  const form = ticketForm(ticket)
  const trigger = view.store.triggers.get(ticket.origin.triggerId)
  const review = isReviewTicket(ticket)
  const parent = review ? index.of(ticket.id).parent : undefined
  const status = form === 'lightweight' && !ticket.ended ? 'working' : activityStatusOf(ticket)
  const terminal = ticket.ended ? TERMINAL[ticket.ended.outcome] : undefined
  const start = Date.parse(ticket.createdAt), end = ticket.ended ? Date.parse(ticket.ended.at) : now
  const reviews = index.reviewsOf(ticket.id)
  const { review: reviewView, deliverables } = form === 'tracked' ? reviewOf(ticket, view) : { review: undefined, deliverables: [] }
  return {
    id: ticket.id, kind: review ? 'review' : 'ticket', ...parent ? { reviewedTicketId: parent } : {}, title: ticket.title, form, status,
    ...terminal ? { terminal } : {}, ...form === 'tracked' && !ticket.ended && ATTENTION.has(status) ? { attention: true } : {},
    ...index.of(ticket.id).plan ? { plan: index.of(ticket.id).plan } : {},
    origin: { source: trigger?.source ?? '', triggerId: ticket.origin.triggerId, preview: preview(trigger?.text ?? ''),
      at: trigger?.at ?? ticket.createdAt },
    sources: sourcesOf(ticket, view),
    ...latest ? { lastEventAt: latest.at } : {},
    ...Number.isFinite(start) && Number.isFinite(end) ? { startedAt: ticket.createdAt, durationMs: Math.max(0, end - start),
      ...ticket.ended ? { endedAt: ticket.ended.at } : {} } : {},
    ...reviews.length ? { progress: { done: reviews.filter(item => activityStatusOf(item) === 'done').length, total: reviews.length } } : {},
    execution: form === 'lightweight' ? { assignments: 0 } : { assignments: ticket.assignments.length,
      ...ticket.assignments.some(assignment => assignment.startedAt) ? { sessionId: workerSessionId(ticket.id) } : {},
      ...ticket.execution?.name ? { name: ticket.execution.name } : {} },
    deliverables,
    ...reviewView ? { review: reviewView } : {},
    ...form === 'lightweight' ? { inline: inlineOf(ticket, inlineSpans) } : {},
  }
}

/** Build the board from the Store and the source facts the panel already reads. */
export function taskBoard(host: ViewHost, now = new Date()): TaskBoardView {
  const view = snapshot(host)
  const tickets = host.store.tickets.list()
  const index = ownershipIndex(tickets)
  const at = now.getTime()
  // A review that belongs to a Ticket is shown below it, never again as its own task row.
  const { plans, unplanned } = groups(tickets.filter(ticket => index.of(ticket.id).parent === undefined), index)
  const byMilestone = new Map<string, { title: string; tasks: TaskNode[] }>()
  for (const group of plans) {
    const ordered = group.tickets.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const task = container('task', ordered.map(ticket => topNode(ticket, view, index, at)), at,
      { id: group.plan.task, title: taskTitle(group, index), subtitle: group.plan.task,
        plan: { milestone: group.plan.milestone, task: group.plan.task } })
    const bucket = byMilestone.get(group.plan.milestone) ?? { title: group.plan.milestone, tasks: [] }
    bucket.tasks.push(task)
    byMilestone.set(group.plan.milestone, bucket)
  }
  const milestones = [...byMilestone].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([id, bucket]) => milestoneNode(id, bucket.title, bucket.tasks, at))
  // Work no plan names still stands as one task per Ticket: a task tree that hid unplanned work would lie by omission.
  const loose = unplanned.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(ticket => topNode(ticket, view, index, at))
  if (loose.length) milestones.push(milestoneNode('unplanned', 'unplanned', loose, at))
  // The flat list is the one projection the right tab and the status page share; its order is stable for tests and people.
  const latest = new Map<string, ActivityRecord>()
  for (const record of host.store.activity.latestByTicket()) if (record.ticket) latest.set(record.ticket, record)
  const lightweight = tickets.filter(ticket => ticketForm(ticket) === 'lightweight')
  const spans = lightweight.length ? host.store.spans.byTraces(lightweight.map(ticket => traceId(ticket.origin.triggerId))) : []
  const byTrace = new Map<string, Span[]>()
  for (const item of spans) byTrace.set(item.traceId, [...byTrace.get(item.traceId) ?? [], item])
  const tasks = tickets.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .map(ticket => taskView(ticket, view, index, at, latest.get(ticket.id), byTrace.get(traceId(ticket.origin.triggerId)) ?? []))
  return { generatedAt: new Date(at).toISOString(), milestones, tasks,
    totals: { milestones: milestones.length, tasks: milestones.reduce((sum, milestone) => sum + milestone.children.length, 0),
      tickets: tickets.length, open: tickets.filter(liveTicket).length, attention: tasks.filter(task => task.attention).length } }
}