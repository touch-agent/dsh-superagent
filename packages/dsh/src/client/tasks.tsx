/**
 * The Tickets tab: the task plan as a tree of milestones, tasks, Tickets and their pull requests and reviews, with an
 * optional git-like graph of when Tickets ran in parallel and where they merged. Both views read one `GET tasks`
 * projection, so they cannot disagree about a node's state, progress or times.
 */
import { useId, useState, type ReactNode } from 'react'
import type { ActivityStatus } from '../app/activity.ts'
import type { TaskBoardView, TaskGraphBranch, TaskMilestone, TaskNode } from '../app/tasks.ts'
import { usePoll } from './api.ts'
import { Dot, Icon, SegmentedTabs, Tag, type DotState, type TagTone } from './controls.tsx'
import { usePanel } from './provider.tsx'
import type { Route } from './route.ts'
import { duration, fullTime, localized, when, type T } from './text.ts'
import { LoadState, Section } from './widgets.tsx'

const STATUS_TONE: Record<ActivityStatus, TagTone> = { queued: 'neutral', working: 'info', idle: 'neutral', review: 'warning',
  answer: 'warning', delivery: 'warning', blocked: 'warning', failed: 'danger', done: 'success' }
const STATUS_DOT: Record<ActivityStatus, DotState> = { queued: 'idle', working: 'ongoing', idle: 'idle', review: 'warning',
  answer: 'warning', delivery: 'warning', blocked: 'warning', failed: 'error', done: 'done' }
const VIEWS = ['tree', 'graph'] as const
type TasksView = typeof VIEWS[number]

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

/** The task board page: one poll, a tree by default, and the graph behind the same toggle in either direction. */
export function TasksPage(): ReactNode {
  const { t, call } = usePanel()
  const id = useId()
  const [view, setView] = useState<TasksView>('tree')
  const { data, error } = usePoll(() => call('GET tasks'), [])
  if (!data) return <LoadState error={error} loading />
  return <>
    {error && <LoadState error={error} loading={false} />}
    <p className="dt-hint dt-task-intro">{t('tasksIntro')}</p>
    <div className="dt-task-views">
      <SegmentedTabs label={t('tasksViewLabel')} value={view} onChange={setView}
        items={VIEWS.map(value => ({ value, label: t(`tasksView.${value}`), id: `${id}-${value}`, panelId: `${id}-panel` }))} />
      <span className="dt-hint">{t('tasksGenerated', { time: when(data.generatedAt, t('lang')) })}</span>
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${view}`}>
      {data.totals.tickets === 0 ? <p className="dt-hint">{t('tasksEmpty')}</p>
        : view === 'tree' ? <TreeView board={data} /> : <GraphView board={data} />}
    </div>
  </>
}