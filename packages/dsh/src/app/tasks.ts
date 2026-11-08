/**
 * The Tickets board: the task-plan shape of the work, its progress, and the pull-request lanes the optional graph draws.
 *
 * Milestones and task ids come from the Ticket titles and Mandate scopes the task plan already uses (`M2`, `T2-03`), and
 * reviews and pull requests come from the ownership derivation shared with the Events tab. Nothing here writes to the
 * Store: a board is a projection of the Tickets, Threads and reports that exist, so it cannot disagree with them.
 */
import { liveTicket, type Thread, type ThreadFacts, type Ticket, type TicketOutcome } from '@superagent/kernel'
import { activityStatusOf, type ActivityStatus } from './activity.ts'
import { isReviewTicket, ownershipIndex, type OwnershipIndex, type PlanRef } from './ownership.ts'
import { snapshot, threadFacts, type Snapshot, type ViewHost } from './views/records.ts'

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

/** Everything the Tickets tab reads in one request. */
export interface TaskBoardView {
  generatedAt: string
  milestones: TaskMilestone[]
  totals: { milestones: number; tasks: number; tickets: number; open: number }
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
  return { generatedAt: new Date(at).toISOString(), milestones,
    totals: { milestones: milestones.length, tasks: milestones.reduce((sum, milestone) => sum + milestone.children.length, 0),
      tickets: tickets.length, open: tickets.filter(liveTicket).length } }
}