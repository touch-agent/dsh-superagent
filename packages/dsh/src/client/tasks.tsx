/**
 * The Tickets tab: the task plan as a tree of milestones, tasks, Tickets and their pull requests and reviews, with an
 * optional git-like graph of when Tickets ran in parallel and where they merged. Both views read one `GET tasks`
 * projection, so they cannot disagree about a node's state, progress or times.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { ActivityStatus } from '../app/activity.ts'
import type { TaskBoardView, TaskGraphBranch, TaskMilestone, TaskNode, TaskView } from '../app/tasks.ts'
import { Button, Dot, Icon, Pill, SegmentedTabs, Tag, type DotState, type TagTone } from './controls.tsx'
import { taskHierarchy, taskViewV1 } from './features.ts'
import { usePanel } from './provider.tsx'
import type { Route } from './route.ts'
import { duration, fullTime, localized, valueLabel, when, type T } from './text.ts'
import { TaskDetail } from './task-detail.tsx'
import { TasksViewClient, useTasksView, type TaskSelection } from './tasks-view.ts'
import { Hint, LoadState, Section } from './widgets.tsx'

const STATUS_TONE: Record<ActivityStatus, TagTone> = { queued: 'neutral', working: 'info', idle: 'neutral', review: 'warning',
  answer: 'warning', delivery: 'warning', blocked: 'warning', failed: 'danger', done: 'success' }
const STATUS_DOT: Record<ActivityStatus, DotState> = { queued: 'idle', working: 'ongoing', idle: 'idle', review: 'warning',
  answer: 'warning', delivery: 'warning', blocked: 'warning', failed: 'error', done: 'done' }
const VIEWS = ['tree', 'graph'] as const
type PlanView = typeof VIEWS[number]
type TasksView = 'list' | 'tickets' | PlanView
export const TASK_FILTERS = ['all', 'attention', 'running', 'failed'] as const
export type TaskFilter = typeof TASK_FILTERS[number]

/** The same status semantics as the Events tab, except that only a live person stage counts as attention. */
export function matchesTaskFilter(task: Pick<TaskView, 'status' | 'attention'>, filter: TaskFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'attention': return !!task.attention
    case 'running': return task.status === 'queued' || task.status === 'working' || task.status === 'idle'
    case 'failed': return task.status === 'failed'
  }
}

/** Put each review row directly below the Ticket it reviews; a review with no known owner stays a top-level row. */
export function orderTasks(tasks: readonly TaskView[]): TaskView[] {
  const reviews = new Map<string, TaskView[]>()
  for (const task of tasks) if (task.kind === 'review' && task.reviewedTicketId) {
    reviews.set(task.reviewedTicketId, [...reviews.get(task.reviewedTicketId) ?? [], task])
  }
  const seen = new Set<string>()
  const ordered: TaskView[] = []
  for (const task of tasks) {
    if (task.kind === 'review' && task.reviewedTicketId) continue
    ordered.push(task); seen.add(task.id)
    for (const review of reviews.get(task.id) ?? []) { ordered.push(review); seen.add(review.id) }
  }
  for (const task of tasks) if (!seen.has(task.id)) ordered.push(task)
  return ordered
}

const statusLabel = (t: T, status: ActivityStatus): string => t(`activityStatus.${status}`)
const kindLabel = (t: T, node: TaskNode): string => t(`tasksKind.${node.kind}`)

/** Internal navigation for a Ticket or Thread, and a new tab for a source URL. */
function NodeTitle({ node, onOpen }: { node: TaskNode; onOpen: (route: Route) => void }) {
  if (!node.href) return <span className="dt-task-title">{node.title}</span>
  if ('url' in node.href) return <a className="dt-task-title dt-task-link" href={node.href.url} target="_blank"
    rel="noreferrer">{node.title}<Icon name="external" size={12} /></a>
  return <button type="button" className="dt-task-title dt-task-open" onClick={() => onOpen(node.href as Route)}>{node.title}</button>
}

function Progress({ done, total }: { done: number; total: number }) {
  const percent = total ? Math.round(done / total * 100) : 0
  return <span className="dt-task-progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
    <span className="dt-task-progress-bar"><span style={{ width: `${percent}%` }} /></span>
    <span className="dt-task-progress-text">{done}/{total}</span>
  </span>
}

function Facts({ node }: { node: TaskNode }) {
  const { t } = usePanel()
  if (!node.facts) return null
  return <>{Object.entries(node.facts).map(([id, fact]) => <Tag key={id} tone={fact.problem ? 'danger' : 'quiet'}
    title={localized(t, fact.label)}>{localized(t, fact.value)}</Tag>)}</>
}

/** One row and, when open, its children; every row carries its kind, state, progress and elapsed time. */
function TreeRow({ node, depth, collapsed, toggle, onOpen }: { node: TaskNode; depth: number
  collapsed: ReadonlySet<string>; toggle: (id: string) => void; onOpen: (route: Route) => void }) {
  const { t } = usePanel()
  const open = !collapsed.has(node.id)
  const hasChildren = node.children.length > 0
  const elapsed = duration(node.durationMs, t('lang'))
  // A pull request leaf is linked, not waiting: its own CI fact carries the state a person acts on.
  const label = node.kind === 'pull' ? t('tasksPullLinked') : statusLabel(t, node.status)
  return <li className="dt-task-node" data-kind={node.kind} data-status={node.status}>
    <div className="dt-task-row" style={{ paddingInlineStart: `${depth * 16}px` }}>
      {hasChildren ? <button type="button" className="dt-task-toggle" aria-expanded={open}
        aria-label={hasChildren ? `${open ? t('tasksCollapse') : t('tasksExpand')} · ${node.title}` : undefined}
        onClick={() => toggle(node.id)}><Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /></button>
        : <span className="dt-task-toggle" aria-hidden />}
      <Dot state={STATUS_DOT[node.status]} label={label} />
      <Tag tone={node.kind === 'pull' ? 'outline' : 'quiet'}>{kindLabel(t, node)}</Tag>
      <NodeTitle node={node} onOpen={onOpen} />
      {node.subtitle && node.kind !== 'pull' && <span className="dt-task-subtitle">{node.subtitle}</span>}
      {node.progress && <Progress {...node.progress} />}
      {elapsed && <span className="dt-task-duration">{elapsed}</span>}
      <Tag tone={STATUS_TONE[node.status]}>{label}</Tag>
      <Facts node={node} />
    </div>
    {hasChildren && open && <ul className="dt-task-list">
      {node.children.map(child => <TreeRow key={`${child.kind}:${child.id}`} node={child} depth={depth + 1} collapsed={collapsed}
        toggle={toggle} onOpen={onOpen} />)}
    </ul>}
  </li>
}

function TreeView({ board }: { board: TaskBoardView }) {
  const { t, navigate } = usePanel()
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) => setCollapsed(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const all = [...board.milestones.flatMap(milestone => [milestone.id, ...milestone.children.flatMap(task =>
    [task.id, ...task.children.map(child => child.id)])])]
  return <>
    <div className="dt-task-toolbar">
      <span className="dt-hint">{t('tasksStats', board.totals)}</span>
      <button type="button" className="dt-textlink" onClick={() => setCollapsed(new Set())}>{t('tasksExpandAll')}</button>
      <button type="button" className="dt-textlink" onClick={() => setCollapsed(new Set(all))}>{t('tasksCollapseAll')}</button>
    </div>
    <ul className="dt-task-list dt-task-root">
      {board.milestones.map(milestone => <MilestoneRow key={milestone.id} milestone={milestone} collapsed={collapsed}
        toggle={toggle} onOpen={navigate} />)}
    </ul>
  </>
}

function MilestoneRow({ milestone, collapsed, toggle, onOpen }: { milestone: TaskMilestone; collapsed: ReadonlySet<string>
  toggle: (id: string) => void; onOpen: (route: Route) => void }) {
  const { t } = usePanel()
  const title = milestone.id === 'unplanned' ? t('tasksUnplanned') : t('tasksMilestone', { id: milestone.id })
  return <TreeRow node={{ ...milestone, title }} depth={0} collapsed={collapsed} toggle={toggle} onOpen={onOpen} />
}

const SHORT = 30
const truncate = (text: string): string => text.length > SHORT ? `${text.slice(0, SHORT - 1)}…` : text
const WIDTH = 1000
// A fixed label column keeps titles clear of the fork and merge curves; the time area starts after it.
const PAD = 32
const RIGHT = 20
const TRUNK_Y = 18
const ROW = 30

/** Scale one instant into the graph's drawing area; a milestone whose Tickets all share one instant still spreads out. */
function scaler(graph: TaskMilestone['graph']): (value: string) => number {
  const start = Date.parse(graph.start)
  const end = Date.parse(graph.end)
  const span = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 1
  return value => {
    const at = Date.parse(value)
    return Number.isFinite(at) ? PAD + Math.min(1, Math.max(0, (at - start) / span)) * (WIDTH - PAD - RIGHT) : PAD
  }
}

function GraphBranch({ branch, x }: { branch: TaskGraphBranch; x: (value: string) => number }) {
  const { t } = usePanel()
  const y = TRUNK_Y + ROW * (branch.lane + 1)
  const from = x(branch.start)
  const to = branch.end ? x(branch.end) : WIDTH - RIGHT
  const end = Math.max(from + 2, to)
  // A fork leaves the trunk, runs on its lane, and merges back where the Ticket ended; live work stays dashed on its lane.
  const path = `M ${from} ${TRUNK_Y} C ${from} ${y} ${from} ${y} ${from + 10} ${y} L ${end - 10} ${y}`
    + (branch.end ? ` C ${end} ${y} ${end} ${y} ${end} ${TRUNK_Y}` : '')
  return <g className="dt-graph-branch" data-status={branch.status}>
    <path className="dt-graph-line" d={path} />
    <circle className="dt-graph-fork" cx={from} cy={TRUNK_Y} r={3} />
    <circle className="dt-graph-node" cx={from + 10} cy={y} r={3.5} />
    {branch.end ? <circle className="dt-graph-merge" cx={end} cy={TRUNK_Y} r={4} />
      : <circle className="dt-graph-open" cx={end} cy={y} r={4} />}
    <title>{`${branch.title} · ${branch.task} · ${statusLabel(t, branch.status)}`}</title>
  </g>
}

function MilestoneGraph({ milestone }: { milestone: TaskMilestone }) {
  const { t, navigate } = usePanel()
  const { graph } = milestone
  const x = scaler(graph)
  const height = TRUNK_Y + ROW * graph.lanes + 24
  if (!graph.branches.length) return <p className="dt-hint">{t('tasksGraphEmpty')}</p>
  return <figure className="dt-task-graph">
    <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label={t('tasksGraphLabel', { milestone: milestone.title })}>
      <line className="dt-graph-trunk" x1={PAD} y1={TRUNK_Y} x2={WIDTH - RIGHT} y2={TRUNK_Y} />
      {graph.branches.map(branch => <GraphBranch key={branch.id} branch={branch} x={x} />)}
    </svg>
    <figcaption className="dt-graph-caption"><span>{fullTime(graph.start, t('lang'))}</span>
      <span>{fullTime(graph.end, t('lang'))}</span></figcaption>
    <ul className="dt-graph-legend">
      {graph.branches.map(branch => <li key={branch.id} data-status={branch.status}>
        <Dot state={STATUS_DOT[branch.status]} label={statusLabel(t, branch.status)} />
        <button type="button" className="dt-graph-link" onClick={() => navigate({ page: 'execution', id: branch.id })}>{branch.title}</button>
        <span className="dt-hint">{branch.task}</span>
        <span className="dt-hint">{branch.outcome ? t(`outcome.${branch.outcome}`) : statusLabel(t, branch.status)}</span>
        <span className="dt-hint">{when(branch.start, t('lang'))}</span>
      </li>)}
    </ul>
  </figure>
}

function GraphView({ board }: { board: TaskBoardView }) {
  const { t } = usePanel()
  return <>
    <div className="dt-task-toolbar"><span className="dt-hint">{t('tasksStats', board.totals)}</span>
      <span className="dt-graph-key"><span className="dt-graph-key-line" />{t('tasksGraphTrunk')}
        <span className="dt-graph-key-dot" />{t('tasksGraphMerge')}</span></div>
    {board.milestones.map(milestone => <Section key={milestone.id} title={milestone.id === 'unplanned'
      ? t('tasksUnplanned') : t('tasksMilestone', { id: milestone.id })} count={milestone.graph.branches.length}>
      <MilestoneGraph milestone={milestone} />
    </Section>)}
  </>
}

const filterCount = (tasks: readonly TaskView[], filter: TaskFilter): number => tasks.filter(task => matchesTaskFilter(task, filter)).length

/** The four status filters shared with the Events tab's vocabulary; a count appears only where it asks for a person. */
export function TaskFilters({ t, value, onChange, tasks }: { t: T; value: TaskFilter; onChange: (filter: TaskFilter) => void
  tasks: readonly TaskView[] }) {
  const attention = filterCount(tasks, 'attention')
  return <div className="dt-tasks-filters dt-events-filters" role="group" aria-label={t('tasksFilterLabel')}>
    {TASK_FILTERS.map(filter => <Pill key={filter} active={value === filter} onClick={() => onChange(filter)}>
      {t(`activityFilter.${filter}`)}{filter === 'attention' && attention > 0 ? ` ${attention}` : ''}
    </Pill>)}
  </div>
}

/** A row's source anchors, deduplicated and capped so three sources fit a 360px pane. */
function TaskSources({ t, task }: { t: T; task: TaskView }) {
  const sources = [...new Set(task.sources.map(source => source.source).filter(Boolean))]
  return <>{sources.slice(0, 3).map(source => <Tag key={source} tone="quiet">{valueLabel(t, 'source', source)}</Tag>)}
    {sources.length > 3 && <Tag tone="quiet">+{sources.length - 3}</Tag>}
    {task.form === 'lightweight' && task.inline && task.inline.steps > 0 && <Tag tone="quiet">
      {t('tasksInlineSteps', { count: task.inline.steps })}</Tag>}
    {task.deliverables[0] && <span className="dt-tasks-delivery" title={task.review?.summary}>
      {t('tasksLatestDelivery', { kind: valueLabel(t, 'artifact', task.deliverables[0].artifact.kind),
        revision: task.deliverables[0].artifact.revision })}</span>}</>
}

/** The E1 selected-detail block: the same Goal the main Session's result card carries, in stable E0 words. */
function TaskGoal({ task, t }: { task: TaskView; t: T }) {
  const goal = task.goal
  const decision = goal.decision
  const result = goal.results[0]
  return <div className="dt-tasks-goal">
    <span>{t('tasksGoal')} · {goal.statement}</span>
    {decision && <span>{t('tasksDecision')} · {decision.question ?? valueLabel(t, 'stage', decision.kind)}</span>}
    <span>{t('tasksResult')} · {result ? `${valueLabel(t, 'artifact', result.artifact.kind)} · ${result.artifact.ref} · ${result.artifact.revision}`
      : t('tasksNoResult')}</span>
  </div>
}

/**
 * The compact task list both task surfaces show: one row per root Ticket and, while selected, its direct child
 * Tickets; reviews stay indented below their owner. A child row never opens its own children here: the right pane
 * shows one child layer and deeper levels open on the Ticket page.
 */
export function TaskList({ tasks, t, filter, selected, expanded, childrenOf, onSelect, onSelectChild, onOpenTask, onOpenEvents, onOpenDetail, empty }: {
  tasks: readonly TaskView[]; t: T; filter: TaskFilter; selected?: string; expanded?: string
  childrenOf?: (id: string) => readonly TaskView[]; onSelect?: (id: string) => void; onSelectChild?: (root: string, id: string) => void
  onOpenTask?: (id: string) => void; onOpenEvents?: (id: string) => void; onOpenDetail?: (id: string) => void; empty?: string
}) {
  const shown = orderTasks(tasks).filter(task => matchesTaskFilter(task, filter))
  if (!shown.length) return <p className="dt-hint">{tasks.length ? t('tasksFilterEmpty') : empty ?? t('tasksEmpty')}</p>
  const childRow = (task: TaskView, root: string) => {
    const confirmations = task.review?.confirmations.length ?? 0
    return <li key={task.id} className="dt-tasks-item dt-tasks-child" data-kind={task.kind} data-form={task.form}
      data-status={task.status} data-selected={selected === task.id ? 'true' : undefined}>
      <button type="button" className="dt-tasks-row" aria-pressed={selected === task.id} onClick={() => onSelectChild?.(root, task.id)}>
        <span className="dt-tasks-row-head">
          <span className="dt-tasks-indent" aria-hidden />
          <Dot state={STATUS_DOT[task.status]} />
          <span className="dt-tasks-title" title={task.title}>{task.title}</span>
        </span>
        <span className="dt-tasks-row-meta">
          <Tag tone={STATUS_TONE[task.status]}>{task.status === 'review' ? t('tasksParentReview') : statusLabel(t, task.status)}</Tag>
          {task.terminal && <Tag tone="quiet">{t(`tasksTerminal.${task.terminal}`)}</Tag>}
          {task.delegation?.resolution && task.delegation.resolution.kind !== 'accepted'
            && <Tag tone="quiet">{t(`delegationResolution.${task.delegation.resolution.kind}` as never)}</Tag>}
          {task.delegation?.orphaned && <Tag tone="danger">{t('tasksNeedsOwner')}</Tag>}
          {task.deliverables.length > 0 && <Tag tone="info">{t('tasksDeliverables', { count: task.deliverables.length,
            confirmations })}</Tag>}
        </span>
        <span className="dt-tasks-row-foot"><span className="dt-tasks-role">{t('tasksRole.child')}</span>
          {task.parentOwner && <span className="dt-hint">{task.delegation?.resolution?.kind === 'accepted'
              ? t('tasksParentAccepted') : t('tasksOwnedByParent')}</span>}</span>
      </button>
      {selected === task.id && <div className="dt-tasks-detail">
        <TaskGoal task={task} t={t} />
        <span className="dt-hint">{t('tasksChildSelectedHint')}</span>
        {onOpenDetail && <Button size="sm" variant="primary" icon={<Icon name="queue" size={13} />}
          onClick={() => onOpenDetail(task.id)}>{t('taskHierarchyOpen')}</Button>}
        {onOpenTask && <Button size="sm" variant="outline" icon={<Icon name="external" size={13} />}
          onClick={() => onOpenTask(task.id)}>{t('tasksOpen')}</Button>}
        {onOpenEvents && <Button size="sm" variant="ghost" onClick={() => onOpenEvents(task.id)}>{t('tasksViewEvents')}</Button>}
      </div>}
    </li>
  }
  return <ul className="dt-tasks-list">
    {shown.map(task => {
      const review = task.kind === 'review'
      const role = task.form === 'lightweight' ? t('tasksForm.lightweight')
        : review ? t('tasksRole.reviewer') : task.parentTicketId ? t('tasksRole.child') : t('tasksRole.parentWorker')
      const confirmations = task.review?.confirmations.length ?? 0
      const children = (expanded === task.id ? childrenOf?.(task.id) ?? [] : []).filter(child => matchesTaskFilter(child, filter))
      return <li key={task.id} className="dt-tasks-item" data-kind={task.kind} data-form={task.form}
        data-status={task.status} data-selected={selected === task.id ? 'true' : undefined}
        data-review={review ? 'true' : undefined} data-parent={task.parentTicketId ? 'true' : undefined}>
        <button type="button" className="dt-tasks-row" aria-pressed={selected === task.id} onClick={() => onSelect?.(task.id)}>
          <span className="dt-tasks-row-head">
            <Dot state={STATUS_DOT[task.status]} />
            {review && <Tag tone="quiet">{t('tasksKind.review')}</Tag>}
            {task.childSummary && <Icon name={expanded === task.id ? 'chevron-down' : 'chevron-right'} size={12} />}
            <span className="dt-tasks-title" title={task.title}>{task.title}</span>
            {task.childSummary && task.childSummary.total > 0 && <span className="dt-hint">{t('tasksChildCount',
              { count: task.childSummary.total })}</span>}
          </span>
          <span className="dt-tasks-row-meta">
            <Tag tone={STATUS_TONE[task.status]}>{statusLabel(t, task.status)}</Tag>
            {task.attention && <Tag tone="warning">{t('tasksAttention')}</Tag>}
            {task.terminal && <Tag tone="quiet">{t(`tasksTerminal.${task.terminal}`)}</Tag>}
            {task.pendingEnd && <Tag tone="warning">{t('tasksPendingEnd')}</Tag>}
            {task.progress && <span className="dt-tasks-progress">{t('tasksReviewProgress', task.progress)}</span>}
            {task.deliverables.length > 0 && <Tag tone="info">{t('tasksDeliverables', { count: task.deliverables.length,
              confirmations })}</Tag>}
            {task.lastEventAt && <time dateTime={task.lastEventAt} title={fullTime(task.lastEventAt, t('lang'))}>
              {when(task.lastEventAt, t('lang'))}</time>}
          </span>
          <span className="dt-tasks-row-foot">
            <span className="dt-tasks-role">{role}</span>
            <TaskSources t={t} task={task} />
          </span>
        </button>
        {children.length > 0 && <ul className="dt-tasks-children">{children.map(child => childRow(child, task.id))}</ul>}
        {selected === task.id && <div className="dt-tasks-detail">
          <TaskGoal task={task} t={t} />
          <span className="dt-hint">{task.form === 'lightweight' ? t('tasksLightweightNote') : t('tasksSelectedHint')}</span>
          {onOpenDetail && <Button size="sm" variant="primary" icon={<Icon name="queue" size={13} />}
            onClick={() => onOpenDetail(task.id)}>{t('taskHierarchyOpen')}</Button>}
          {onOpenTask && <Button size="sm" variant="outline" icon={<Icon name="external" size={13} />}
            onClick={() => onOpenTask(task.id)}>{t('tasksOpen')}</Button>}
          {onOpenEvents && <Button size="sm" variant="ghost" onClick={() => onOpenEvents(task.id)}>{t('tasksViewEvents')}</Button>}
        </div>}
      </li>
    })}
  </ul>
}

/** One lazily expanded child Ticket row in the status-page tree. */
function TicketTreeNode({ task, depth, client, expanded, toggle }: { task: TaskView; depth: number; client: TasksViewClient
  expanded: ReadonlySet<string>; toggle: (id: string) => void }) {
  const { t, navigate } = usePanel()
  const open = expanded.has(task.id)
  const total = task.childSummary?.total ?? 0
  const loaded = client.detailOf(task.id)
  const children = open ? loaded?.children ?? [] : []
  return <li className="dt-ticket-tree-node" data-status={task.status} data-child={task.parentTicketId ? 'true' : undefined}>
    <div className="dt-ticket-tree-row" style={{ paddingInlineStart: `${depth * 16}px` }}>
      {total > 0 ? <button type="button" className="dt-task-toggle" aria-expanded={open}
        aria-label={t(open ? 'tasksCollapse' : 'tasksExpand')} onClick={() => toggle(task.id)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} /></button>
        : <span className="dt-task-toggle" aria-hidden />}
      <Dot state={STATUS_DOT[task.status]} label={statusLabel(t, task.status)} />
      <button type="button" className="dt-task-title dt-task-open" onClick={() => navigate({ page: 'execution', id: task.id })}>
        {task.title}</button>
      {task.childSummary && <Tag tone="quiet">{t('tasksChildCount', { count: task.childSummary.total })}</Tag>}
      {task.parentOwner && <Tag tone="quiet">{t('tasksRole.child')}</Tag>}
      {task.attention && <Tag tone="warning">{t('tasksAttention')}</Tag>}
      {task.pendingEnd && <Tag tone="warning">{t('tasksPendingEnd')}</Tag>}
      {task.terminal && <Tag tone="quiet">{t(`tasksTerminal.${task.terminal}`)}</Tag>}
      <Tag tone={STATUS_TONE[task.status]}>{task.parentTicketId && task.status === 'review'
        ? t('tasksParentReview') : statusLabel(t, task.status)}</Tag>
      {task.review?.deliverables.length ? <span className="dt-hint">{t('tasksDeliverables', {
        count: task.review.deliverables.length, confirmations: task.review.confirmations.length })}</span> : null}
    </div>
    {open && total > 0 && !loaded && <p className="dt-hint" style={{ paddingInlineStart: `${(depth + 1) * 16 + 20}px` }}>{t('loading')}</p>}
    {children.length > 0 && <ul className="dt-ticket-tree-children">{children.map(child => <TicketTreeNode key={child.id} task={child}
      depth={depth + 1} client={client} expanded={expanded} toggle={toggle} />)}</ul>}
  </li>
}

/**
 * The status page's Ticket tree: roots at one level, children loaded on expansion through `GET tasks/:id`, so a
 * 500-root/2000-child board never loads every child to draw its first screen. A node at the fourth level and deeper
 * stays collapsed until opened, matching the architecture's L4 rule.
 */
export function TicketTree({ roots, client }: { roots: readonly TaskView[]; client: TasksViewClient }) {
  const { t } = usePanel()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) => {
    const opening = !expanded.has(id)
    setExpanded(current => {
      const next = new Set(current)
      if (opening) next.add(id); else next.delete(id)
      return next
    })
    if (opening) client.ensureDetail(id)
  }
  if (!roots.length) return <p className="dt-hint">{t('tasksEmpty')}</p>
  return <ul className="dt-ticket-tree dt-task-list">{roots.map(task => <TicketTreeNode key={task.id} task={task} depth={0}
    client={client} expanded={expanded} toggle={toggle} />)}</ul>
}

/** The right-pane body. It is outside the panel's React tree, so it owns its poll and never assumes `usePanel()`. */
export function TasksTab({ t, tasks, onOpenStatus, onOpenTask, onOpenEvents }: { t: T; tasks: TasksViewClient
  onOpenStatus: () => void; onOpenTask: (id: string) => void; onOpenEvents: (id: string) => void }) {
  const snapshot = useTasksView(tasks)
  const [filter, setFilter] = useState<TaskFilter>('all')
  const selected = snapshot.selection?.id
  const rootId = snapshot.selection?.rootId ?? snapshot.selection?.id
  const selectRoot = (id: string) => tasks.select(selected === id ? undefined : { kind: 'ticket', id, rootId: id })
  const selectChild = (root: string, id: string) => tasks.select(selected === id ? undefined : { kind: 'ticket', id, rootId: root })
  return <div className="dt-tasks-tab">
    <div className="dt-tasks-head">
      <h2 className="dt-tasks-heading">{t('tasksTab')}</h2>
      <Button size="sm" variant="ghost" onClick={onOpenStatus}>{t('tasksOpenInStatus')}</Button>
    </div>
    {!snapshot.data && !snapshot.error && <p className="dt-hint">{t('loading')}</p>}
    {snapshot.error && <div className="dt-tasks-error" role="alert"><span>{snapshot.error.message}</span>
      <Button size="sm" variant="outline" onClick={() => tasks.refresh()}>{t('retry')}</Button></div>}
    {snapshot.data && <>
      <TaskFilters t={t} value={filter} onChange={setFilter} tasks={snapshot.data.tasks} />
      {snapshot.data.totals.tickets === 0
        ? <p className="dt-hint">{t('tasksEmpty')}</p>
        : <TaskList tasks={snapshot.data.tasks} t={t} filter={filter} selected={selected} expanded={rootId}
          childrenOf={id => tasks.detailOf(id)?.children ?? []} onSelect={selectRoot} onSelectChild={selectChild}
          onOpenTask={onOpenTask} onOpenEvents={onOpenEvents} />}
    </>}
  </div>
}

/** The tab chip is intentionally quiet: the Task tab must not pull attention or start a poll before it is opened. */
export function TasksTitle({ t }: { t: T }) {
  return <span className="dt-events-chip">{t('tasksTab')}</span>
}

export function TasksPage({ tasks }: { tasks?: TasksViewClient } = {}): ReactNode {
  const { t, call, navigate } = usePanel()
  const store = useMemo(() => tasks ?? new TasksViewClient(call), [tasks, call])
  // A page-specific client belongs to this page; the shared one is disposed by the plugin effect.
  useEffect(() => () => { if (!tasks) store.dispose() }, [store, tasks])
  const snapshot = useTasksView(store)
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [detailId, setDetailId] = useState<string>()
  const flag = taskViewV1()
  const hierarchy = taskHierarchy()
  const views = flag ? ['list', 'tickets', ...VIEWS] as const : VIEWS
  const [view, setView] = useState<TasksView>(flag ? 'list' : 'tree')
  const id = useId()
  const data = snapshot.data
  const selected = snapshot.selection?.id
  const rootId = snapshot.selection?.rootId ?? snapshot.selection?.id
  const selectRoot = (ticket: string) => store.select(selected === ticket ? undefined : { kind: 'ticket', id: ticket, rootId: ticket })
  const selectChild = (root: string, ticket: string) => store.select(selected === ticket ? undefined
    : { kind: 'ticket', id: ticket, rootId: root } satisfies TaskSelection)
  const openDetail = (ticket: string) => {
    const root = data?.tasks.find(item => item.id === ticket)?.id ?? rootId ?? ticket
    store.select({ kind: 'ticket', id: ticket, rootId: root })
    store.ensureDetail(ticket)
    setDetailId(ticket)
  }
  const detailTask = detailId ? store.taskOf(detailId) : undefined
  if (!data) return <LoadState error={snapshot.error} loading={!snapshot.ready || snapshot.loading} />
  return <>
    {snapshot.error && <LoadState error={snapshot.error} loading={false} />}
    <p className="dt-hint dt-task-intro">{view === 'list' ? t('tasksListIntro')
      : view === 'tickets' ? t('tasksTicketsIntro') : t('tasksIntro')}</p>
    {view !== 'list' && view !== 'tickets' && <Hint>{t('tasksPlanFallback')}</Hint>}
    <div className="dt-task-views">
      <SegmentedTabs label={t('tasksViewLabel')} value={view} onChange={value => setView(value)}
        items={views.map(value => ({ value, label: t(`tasksView.${value}`), id: `${id}-${value}`, panelId: `${id}-panel` }))} />
      <span className="dt-hint">{t('tasksGenerated', { time: when(data.generatedAt, t('lang')) })}</span>
    </div>
    {detailTask && hierarchy ? <TaskDetail task={detailTask} store={store} onBack={() => setDetailId(undefined)}
      onOpenTicket={ticket => navigate({ page: 'execution', id: ticket })} /> : <>
    {view === 'list' && <TaskFilters t={t} value={filter} onChange={setFilter} tasks={data.tasks} />}
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${view}`}>
      {data.totals.tickets === 0 ? <p className="dt-hint">{t('tasksEmpty')}</p>
        : view === 'list' ? <TaskList tasks={data.tasks} t={t} filter={filter} selected={selected} expanded={rootId}
          childrenOf={ticket => store.detailOf(ticket)?.children ?? []} onSelect={selectRoot} onSelectChild={selectChild}
          onOpenTask={ticket => navigate({ page: 'execution', id: ticket })} onOpenDetail={hierarchy ? openDetail : undefined}
          empty={t('tasksEmpty')} />
        : view === 'tickets' ? <TicketTree roots={data.tasks} client={store} />
          : view === 'tree' ? <TreeView board={data} /> : <GraphView board={data} />}
    </div></>}
  </>
}
