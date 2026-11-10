/**
 * The Tickets board: the task-plan shape of the work, its progress, and the pull-request lanes the optional graph draws.
 *
 * Milestones and task ids come from the Ticket titles and Mandate scopes the task plan already uses (`M2`, `T2-03`), and
 * reviews and pull requests come from the ownership derivation shared with the Events tab. Nothing here writes to the
 * Store: a board is a projection of the Tickets, Threads and reports that exist, so it cannot disagree with them.
 */
import { childUnresolved, depthOf, latestReport, liveTicket, reviewAggregate, rootTicketIdOf, threadKey, ticketForm, traceId,
  type Artifact, type HumanCriterion, type PreviewRef, type ReviewSource, type RuleCriterion, type Span, type Thread, type ThreadFacts,
  type Ticket, type TicketOutcome, type Trigger } from '@superagent/kernel'
import { activityStatusOf, type ActivityRecord, type ActivityStatus } from './activity.ts'
import { isReviewTicket, ownershipIndex, type OwnershipIndex, type PlanRef } from './ownership.ts'
import { snapshot, threadFacts, type ActorView, type Snapshot, type ViewHost } from './views/records.ts'
import { markdown, preview } from './views/text.ts'
import { workerSessionId } from '../executor/dsh.ts'
import { SpaceProjection, type SpaceView } from './spaces.ts'
import { goalView, type GoalView } from './goals.ts'

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

/** One reviewable delivery, deduplicated by artifact revision across the root and its accepted child Tickets. */
export interface TaskDeliverableSummary {
  /** `<artifact.kind>:<artifact.ref>:<artifact.revision>`, the key the aggregate deduplicates parent and child work by. */
  key: string
  /** Every Ticket/Assignment that delivered this revision; a merged parent and child keep one row and both sources. */
  sources: ReviewSource[]
  at: string
  artifact: Artifact
  previewRef: PreviewRef
  criteria: RuleCriterion[]
  confirmations: HumanCriterion[]
  summary?: string
  /** The child delivery was accepted by its parent owner; that is not a person's confirmation. */
  parentAccepted?: { by: ActorView; at: string }
  /** The person approval that covers this row, bound to the aggregate revision. */
  humanAccepted?: { by: ActorView; at: string; reviewRevision: string }
}

/** One person confirmation of a source delivery, with the ref the approval covers. */
export interface TaskReviewConfirmationView {
  ref: string
  source: ReviewSource
  criterion: HumanCriterion
  coveredBy?: { by: ActorView; at: string; reviewRevision: string }
}

/** A Ticket's review surface: its deliveries plus the accepted children's, and the revision a person approves. */
export interface TaskReviewView {
  reviewRevision: string
  deliverables: TaskDeliverableSummary[]
  criteria: RuleCriterion[]
  confirmations: TaskReviewConfirmationView[]
  summary?: string
  /** Present only when the stored approval matches the current revision. */
  accepted?: { by: ActorView; at: string; reviewRevision: string }
  /** A stored approval that no longer describes the current aggregate; the person must approve again. */
  staleAccepted?: { by: ActorView; at: string; reviewRevision: string }
}

/** How one task node's owner/worker is shown; the internals such as a Session id stay in E2 details. */
export interface TaskActorView { role: 'owner' | 'worker'; sessionId?: string }

/** One accepted, cancelled or failed parent decision on a child Ticket, without the internal Session id. */
export interface TaskDelegationView {
  parentTicketId: string
  rootTicketId: string
  goal: string
  scope?: string
  attempt: number
  orphaned?: { reason: string; at: string }
  resolution?: { kind: 'accepted' | 'cancelled' | 'failed'; by: ActorView; at: string; reason?: string }
  dispositions: { decision: string; by: ActorView; at: string; reason?: string }[]
  merge?: { into?: string; resolution: 'merged' | 'escalated' | 'none'; childRevisions: string[]; conflicts: string[]; reason?: string }
}

/** Direct child counts for one node; a projection of child Tickets, not a second stored state. */
export interface TaskChildSummary {
  total: number
  live: number
  queued: number
  working: number
  waiting: number
  review: number
  blocked: number
  failed: number
  orphaned: number
  accepted: number
  cancelled: number
  unresolved: number
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
  /** `dropped`, `stopped` and a parent-cancelled child are terminal but not failures; counts use this, not `status` alone. */
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
  /** Read-only space projection; absent for a lightweight Ticket and for a record without an Execution. */
  space?: SpaceView
  /** Present only on a child Ticket; a root has none. */
  parentTicketId?: string
  rootTicketId?: string
  /** 0 for a root; the parent chain's length for a child. */
  depth?: number
  /** The node's own owner; a lightweight Ticket has none, since it runs inline. */
  owner?: TaskActorView
  /** The node's worker when an Assignment started; the Session id stays for E2 details only. */
  worker?: TaskActorView
  /** Present only on a child Ticket: its parent node's owner. */
  parentOwner?: TaskActorView
  /** Present only on a child Ticket: the parent owner's goal, judgements and terminal decision. */
  delegation?: TaskDelegationView
  /** Direct child Tickets; counts only, never a second hierarchy inside the board's root list. */
  childSummary?: TaskChildSummary
  /** The close a PR or Thread already reported while child Tickets or the final approval still held it. */
  pendingEnd?: { by: 'thread' | 'follows'; outcome: 'merged' | 'closed'; at: string; reason?: string; ref?: string }
  /** Children expanded on demand for a detail tree; the root list never carries them. */
  children?: TaskView[]
  /** The E0 goal, the same projection the main Session's result card carries. */
  goal: GoalView
  /** Deduplicated deliveries; empty for a lightweight Ticket and for a Ticket with no reviewable report. */
  deliverables: TaskDeliverableSummary[]
  /** Present when the latest report recorded a review with a preview; never an empty card. */
  review?: TaskReviewView
  /** Present only for a lightweight Ticket, whose inline run has no Assignment to describe it. */
  inline?: TaskInlineView
}

/** Everything the Tickets tab reads in one request. The plan tree stays for the rollback and the status-page tree/graph. */
export interface TaskBoardView {
  generatedAt: string
  milestones: TaskMilestone[]
  /** The root Ticket rows both the right tab and the status page read; children are loaded from `GET tasks/:id`. */
  tasks: TaskView[]
  totals: { milestones: number; tasks: number; tickets: number; open: number; attention: number; children?: number }
}

/** One detail request: the selected Ticket and its direct children, for one-layer expansion or a deeper tree. */
export interface TaskDetailView {
  task: TaskView
  children: TaskView[]
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

/** One request's Ticket tree: the read-once parent index every projection below shares, so no row queries per child. */
export interface TaskTreeIndex {
  tickets: readonly Ticket[]
  get(id: string): Ticket | undefined
  childrenOf(id: string): Ticket[]
}

/** Build the parent index once; the board and a detail request both project from it instead of querying per node. */
export function treeIndex(tickets: readonly Ticket[]): TaskTreeIndex {
  const byId = new Map(tickets.map(ticket => [ticket.id, ticket]))
  const children = new Map<string, Ticket[]>()
  for (const ticket of tickets) {
    if (!ticket.parentTicketId) continue
    children.set(ticket.parentTicketId, [...children.get(ticket.parentTicketId) ?? [], ticket])
  }
  return { tickets, get: id => byId.get(id), childrenOf: id => children.get(id) ?? [] }
}

/** The summary of the report that delivered one source, so a merged row can explain what changed there. */
function sourceSummary(index: TaskTreeIndex, source: ReviewSource): string | undefined {
  const ticket = index.get(source.ticketId)
  const report = ticket?.assignments.find(assignment => assignment.id === source.assignmentId)?.report
  return report ? markdown(report.summary) : undefined
}

/**
 * One Ticket's review aggregate: its own latest report plus the accepted child deliveries, deduplicated by artifact
 * revision. A stored approval only counts while it names the current revision; an older one is reported as stale.
 */
function reviewOf(ticket: Ticket, view: Snapshot, index: TaskTreeIndex): { review?: TaskReviewView; deliverables: TaskDeliverableSummary[] } {
  const report = latestReport(ticket)
  const aggregate = reviewAggregate(ticket, index.get, index.childrenOf)
  if (!aggregate) return { deliverables: [] }
  const stored = report?.accepted
  const accepted = stored?.reviewRevision === aggregate.reviewRevision
    ? { by: view.actor(stored.by), at: stored.at, reviewRevision: stored.reviewRevision } : undefined
  const stale = stored && !accepted ? { by: view.actor(stored.by), at: stored.at, reviewRevision: stored.reviewRevision ?? '' } : undefined
  const deliverables: TaskDeliverableSummary[] = aggregate.deliverables.map(item => {
    const summary = sourceSummary(index, item.sources[0]!)
    return { ...item, ...summary ? { summary } : {},
      ...item.parentAccepted ? { parentAccepted: { by: view.actor(item.parentAccepted.by), at: item.parentAccepted.at } } : {},
      ...accepted ? { humanAccepted: accepted } : {} }
  })
  const summary = report ? markdown(report.summary) : deliverables.find(item => item.summary)?.summary
  return { deliverables, review: { reviewRevision: aggregate.reviewRevision, deliverables, criteria: aggregate.criteria,
    confirmations: aggregate.confirmations.map(item => ({ ...item, ...accepted ? { coveredBy: accepted } : {} })),
    ...summary ? { summary } : {}, ...accepted ? { accepted } : {}, ...stale ? { staleAccepted: stale } : {} } }
}

/** A lightweight Ticket's inline history, from the action spans under its Trigger's trace. */
function inlineOf(ticket: Ticket, spans: readonly Span[]): TaskInlineView {
  const actions = spans.filter(item => item.kind === 'action')
  const last = actions.reduce<string | undefined>((latest, item) => !latest || item.at > latest ? item.at : latest, undefined)
  return { steps: actions.length, ...last ? { lastActionAt: last } : {},
    ...ticket.ended?.reason ? { summary: markdown(ticket.ended.reason) } : {}, traceId: traceId(ticket.origin.triggerId) }
}

/** The source anchors a row shows: the originating Trigger first, then every Thread the Ticket subscribes to. */
function sourcesOf(ticket: Ticket, view: Snapshot, triggers?: ReadonlyMap<string, Trigger>): TaskSourceView[] {
  const trigger = triggers?.get(ticket.origin.triggerId) ?? view.store.triggers.get(ticket.origin.triggerId)
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

/** A child Ticket's status: an orphaned child stays blocked even while its last Assignment is ended. */
function childStatus(ticket: Ticket): ActivityStatus {
  if (!ticket.ended && ticket.delegation?.orphaned) return 'blocked'
  // A child its parent cancelled is terminal without being a failure; only its resolution says so.
  if (ticket.ended && ticket.delegation?.resolution?.kind === 'cancelled') return 'done'
  if (ticketForm(ticket) === 'lightweight' && !ticket.ended) return 'working'
  return activityStatusOf(ticket)
}

/** Whether a live Ticket has an Assignment the owner can still resume, rather than a finished one. */
function ownerAvailable(ticket: Ticket): boolean {
  return !ticket.ended && ticket.assignments.some(assignment => assignment.state !== 'ended')
}

/** Whether any living ancestor owner can still take a child's report; only then is the child's failure not a person's. */
function hasAvailableOwner(ticket: Ticket, tree: TaskTreeIndex): boolean {
  const seen = new Set<string>()
  let parentId = ticket.parentTicketId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = tree.get(parentId)
    if (!parent) return false
    if (ownerAvailable(parent)) return true
    parentId = parent.parentTicketId
  }
  return false
}

/** Every descendant of a Ticket, depth first; the board uses it for attention and the detail tree for expansion. */
function descendants(ticket: Ticket, tree: TaskTreeIndex, seen = new Set<string>()): Ticket[] {
  const found: Ticket[] = []
  for (const child of tree.childrenOf(ticket.id)) {
    if (seen.has(child.id)) continue
    seen.add(child.id)
    found.push(child, ...descendants(child, tree, seen))
  }
  return found
}

/**
 * Whether a person must act. It is computed from Ticket/Delegation state, never from the display status: a live root's
 * own person stage counts, and a failed, blocked or orphaned child counts only when no living ancestor owner can decide
 * it. A child waiting for its parent's review is the parent owner's queue, not a person's.
 */
function attentionFor(ticket: Ticket, tree: TaskTreeIndex): boolean {
  if (ticket.ended || ticketForm(ticket) !== 'tracked') return false
  if (ATTENTION.has(activityStatusOf(ticket))) return true
  if (ticket.endPending && !ownerAvailable(ticket)) return true
  for (const child of descendants(ticket, tree)) {
    const status = childStatus(child)
    if (!childUnresolved(child) || (status !== 'failed' && status !== 'blocked')) continue
    if (!hasAvailableOwner(child, tree)) return true
  }
  return false
}

/** A child's delegation as the E1 task view shows it: no Session id and no Mandate, since a child has neither of its own. */
function delegationView(ticket: Ticket, view: Snapshot): TaskDelegationView | undefined {
  const delegation = ticket.delegation
  if (!delegation) return undefined
  return { parentTicketId: delegation.parentTicketId, rootTicketId: delegation.rootTicketId, goal: delegation.goal,
    ...delegation.scope ? { scope: delegation.scope } : {}, attempt: delegation.attempt,
    ...delegation.orphaned ? { orphaned: { reason: delegation.orphaned.reason, at: delegation.orphaned.at } } : {},
    ...delegation.resolution ? { resolution: { kind: delegation.resolution.kind, by: view.actor(delegation.resolution.by),
      at: delegation.resolution.at, ...delegation.resolution.reason ? { reason: delegation.resolution.reason } : {} } } : {},
    dispositions: (delegation.dispositions ?? []).map(item => ({ decision: item.decision, by: view.actor(item.by), at: item.at,
      ...item.reason ? { reason: item.reason } : {} })),
    ...delegation.merge ? { merge: { ...delegation.merge } } : {} }
}

/** Count direct children by state; a child waiting for its parent is `review`, not a person's attention. */
function childSummaryOf(children: readonly Ticket[]): TaskChildSummary {
  const statuses = children.map(childStatus)
  const count = (status: ActivityStatus) => statuses.filter(item => item === status).length
  const resolved = (kind: 'accepted' | 'cancelled' | 'failed') => children.filter(child => child.delegation?.resolution?.kind === kind).length
  return { total: children.length, live: children.filter(child => !child.ended).length, queued: count('queued'), working: count('working'),
    waiting: count('idle'), review: count('review'), blocked: count('blocked'), failed: count('failed'),
    orphaned: children.filter(child => !child.ended && !!child.delegation?.orphaned).length,
    accepted: resolved('accepted'), cancelled: resolved('cancelled'), unresolved: children.filter(childUnresolved).length }
}

/** A parent's status is aware of its live children: waiting for them is working, and a failed child blocks it. */
function nodeStatus(ticket: Ticket, children: readonly Ticket[]): ActivityStatus {
  if (ticket.ended || ticket.parentTicketId || ticketForm(ticket) === 'lightweight') return childStatus(ticket)
  const live = children.filter(child => !child.ended)
  if (!live.length) return activityStatusOf(ticket)
  return live.some(child => childStatus(child) === 'failed' || childStatus(child) === 'blocked') ? 'blocked' : 'working'
}

/** One Ticket's flat task row; everything here is derived at request time and writes nothing. */
function taskView(ticket: Ticket, view: Snapshot, owners: OwnershipIndex, tree: TaskTreeIndex, now: number,
  latest: ActivityRecord | undefined, inlineSpans: readonly Span[], spaces?: SpaceProjection,
  triggers?: ReadonlyMap<string, Trigger>): TaskView {
  const form = ticketForm(ticket)
  const trigger = triggers?.get(ticket.origin.triggerId) ?? view.store.triggers.get(ticket.origin.triggerId)
  const review = isReviewTicket(ticket)
  const parent = review ? owners.of(ticket.id).parent : undefined
  const children = tree.childrenOf(ticket.id)
  const status = nodeStatus(ticket, children)
  const terminal = ticket.ended ? TERMINAL[ticket.ended.outcome] : undefined
  const start = Date.parse(ticket.createdAt), end = ticket.ended ? Date.parse(ticket.ended.at) : now
  const reviews = owners.reviewsOf(ticket.id)
  const { review: reviewView, deliverables } = form === 'tracked' ? reviewOf(ticket, view, tree) : { review: undefined, deliverables: [] }
  const childSummary = children.length ? childSummaryOf(children) : undefined
  const sessionId = ticket.assignments.some(assignment => assignment.startedAt) ? workerSessionId(ticket.id) : undefined
  const space = spaces?.view(ticket, ticket.parentTicketId ? tree.get(ticket.parentTicketId) : undefined)
  return {
    id: ticket.id, kind: review ? 'review' : 'ticket', ...parent ? { reviewedTicketId: parent } : {}, title: ticket.title, form, status,
    ...terminal ? { terminal } : {}, ...!ticket.parentTicketId && attentionFor(ticket, tree) ? { attention: true } : {},
    ...owners.of(ticket.id).plan ? { plan: owners.of(ticket.id).plan } : {},
    origin: { source: trigger?.source ?? '', triggerId: ticket.origin.triggerId, preview: preview(trigger?.text ?? ''),
      at: trigger?.at ?? ticket.createdAt },
    sources: sourcesOf(ticket, view, triggers),
    ...latest ? { lastEventAt: latest.at } : {},
    ...Number.isFinite(start) && Number.isFinite(end) ? { startedAt: ticket.createdAt, durationMs: Math.max(0, end - start),
      ...ticket.ended ? { endedAt: ticket.ended.at } : {} } : {},
    ...reviews.length ? { progress: { done: reviews.filter(item => activityStatusOf(item) === 'done').length, total: reviews.length } } : {},
    execution: form === 'lightweight' ? { assignments: 0 } : { assignments: ticket.assignments.length,
      ...sessionId ? { sessionId } : {}, ...ticket.execution?.name ? { name: ticket.execution.name } : {} },
    ...space ? { space } : {},
    ...ticket.parentTicketId ? { parentTicketId: ticket.parentTicketId, rootTicketId: rootTicketIdOf(ticket) } : {},
    ...ticket.parentTicketId ? { depth: depthOf(ticket, tree.get) } : { depth: 0 },
    ...form === 'tracked' ? { owner: { role: 'owner' as const }, worker: { role: 'worker' as const, ...sessionId ? { sessionId } : {} } } : {},
    ...ticket.parentTicketId ? { parentOwner: { role: 'owner' as const } } : {},
    ...delegationView(ticket, view) ? { delegation: delegationView(ticket, view) } : {},
    ...childSummary ? { childSummary } : {},
    ...ticket.endPending ? { pendingEnd: { ...ticket.endPending } } : {},
    goal: goalView(ticket),
    deliverables,
    ...reviewView ? { review: reviewView } : {},
    ...form === 'lightweight' ? { inline: inlineOf(ticket, inlineSpans) } : {},
  }
}

/** The activity and inline spans one request needs, read once for every Ticket in the projection. */
function readContext(host: ViewHost, tickets: readonly Ticket[]): {
  latest: Map<string, ActivityRecord>; byTrace: Map<string, Span[]>; triggers: Map<string, Trigger> } {
  const latest = new Map<string, ActivityRecord>()
  for (const record of host.store.activity.latestByTicket()) if (record.ticket) latest.set(record.ticket, record)
  const lightweight = tickets.filter(ticket => ticketForm(ticket) === 'lightweight')
  const spans = lightweight.length ? host.store.spans.byTraces(lightweight.map(ticket => traceId(ticket.origin.triggerId))) : []
  const byTrace = new Map<string, Span[]>()
  for (const item of spans) byTrace.set(item.traceId, [...byTrace.get(item.traceId) ?? [], item])
  return { latest, byTrace, triggers: new Map(host.store.triggers.all().map(trigger => [trigger.id, trigger])) }
}

/** Build the board from the Store and the source facts the panel already reads. */
export function taskBoard(host: ViewHost, now = new Date()): TaskBoardView {
  const view = snapshot(host)
  // Read every Ticket once and index parents in memory: the board needs roots plus each root's child counts, never a query
  // per root. `list()` would hide the children; `allList()` is the one read this projection is allowed.
  const all = host.store.tickets.allList()
  const tree = treeIndex(all)
  const roots = all.filter(ticket => !ticket.parentTicketId)
  const owners = ownershipIndex(all)
  const at = now.getTime()
  // A review that belongs to a Ticket is shown below it, never again as its own task row.
  const { plans, unplanned } = groups(roots.filter(ticket => owners.of(ticket.id).parent === undefined), owners)
  const byMilestone = new Map<string, { title: string; tasks: TaskNode[] }>()
  for (const group of plans) {
    const ordered = group.tickets.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const task = container('task', ordered.map(ticket => topNode(ticket, view, owners, at)), at,
      { id: group.plan.task, title: taskTitle(group, owners), subtitle: group.plan.task,
        plan: { milestone: group.plan.milestone, task: group.plan.task } })
    const bucket = byMilestone.get(group.plan.milestone) ?? { title: group.plan.milestone, tasks: [] }
    bucket.tasks.push(task)
    byMilestone.set(group.plan.milestone, bucket)
  }
  const milestones = [...byMilestone].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([id, bucket]) => milestoneNode(id, bucket.title, bucket.tasks, at))
  // Work no plan names still stands as one task per Ticket: a task tree that hid unplanned work would lie by omission.
  const loose = unplanned.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(ticket => topNode(ticket, view, owners, at))
  if (loose.length) milestones.push(milestoneNode('unplanned', 'unplanned', loose, at))
  // The flat list is the one projection the right tab and the status page share; its order is stable for tests and people.
  const { latest, byTrace, triggers } = readContext(host, all)
  // A board row does not read the file system for a Space: only the detail page shows one, so the 2,500-row projection stays cheap.
  const tasks = roots.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .map(ticket => taskView(ticket, view, owners, tree, at, latest.get(ticket.id), byTrace.get(traceId(ticket.origin.triggerId)) ?? [], undefined, triggers))
  const children = all.length - roots.length
  return { generatedAt: new Date(at).toISOString(), milestones, tasks,
    totals: { milestones: milestones.length, tasks: milestones.reduce((sum, milestone) => sum + milestone.children.length, 0),
      tickets: roots.length, open: roots.filter(liveTicket).length, attention: tasks.filter(task => task.attention).length,
      ...children ? { children } : {} } }
}

/**
 * One Ticket's detail: its own row plus its children to `depth` levels (1 by default, at most 5), read from the root's
 * subtree so a child's parent chain and review aggregate are available without a query per node.
 */
export function taskDetail(host: ViewHost, id: string, depth = 1, now = new Date()): TaskDetailView | undefined {
  const ticket = host.store.tickets.get(id)
  if (!ticket) return undefined
  const root = host.store.tickets.get(rootTicketIdOf(ticket)) ?? ticket
  const all = host.store.tickets.subtree(root.id)
  const tree = treeIndex(all.some(item => item.id === root.id) ? all : [root, ...all])
  const owners = ownershipIndex(tree.tickets)
  const view = snapshot(host)
  const at = now.getTime()
  const { latest, byTrace, triggers } = readContext(host, tree.tickets)
  const spaces = new SpaceProjection(host.store, 0, () => false)
  const levels = Math.max(0, Math.min(5, depth))
  const build = (current: Ticket, remaining: number): TaskView => {
    const row = taskView(current, view, owners, tree, at, latest.get(current.id), byTrace.get(traceId(current.origin.triggerId)) ?? [], spaces, triggers)
    if (remaining <= 0) return row
    const children = tree.childrenOf(current.id).map(child => build(child, remaining - 1))
    return children.length ? { ...row, children } : row
  }
  const task = build(ticket, levels)
  return { task, children: task.children ?? [] }
}
