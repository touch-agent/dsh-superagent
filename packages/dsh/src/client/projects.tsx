/**
 * The project layer of the Tasks page: the default project list, the archive filter, the project → task → subtask
 * drill-down and the task detail reached from it. It reads the same `GET tasks` projection as the flat list and adds no
 * second task store: expansion calls the shared `TasksViewClient`, and every row is a `TaskView` from the contract.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ActivityStatus } from '../app/activity.ts'
import type { TaskView } from '../app/tasks.ts'
import { Button, Dot, Icon, Pill, Tag, type DotState, type TagTone } from './controls.tsx'
import { activityItems, actionOf, ancestorsOf, attentionItems, findTask, isArchived, lastActivityOf, ownerIssue,
  ownerMissing, projectIssueItems, projectOwnerLabel, projectTitle, sortedProjects, statusLabel, taskOwnerLabel, tasksOfProject,
  totalsOf, unassignedTasks, updatedText, type ProfileRow, type ProjectAction, type ProjectAttentionItem,
  type ProjectAttentionView, type ProjectBoardView, type ProjectIssueItem, type ProjectScreen, type ProjectView } from './projects.ts'
import { usePanel } from './provider.tsx'
import { TaskDetail } from './task-detail.tsx'
import type { TasksViewClient } from './tasks-view.ts'
import { fullTime, type T } from './text.ts'

const TONE: Record<ActivityStatus, TagTone> = { queued: 'neutral', working: 'info', idle: 'neutral', review: 'warning',
  answer: 'warning', delivery: 'warning', blocked: 'warning', failed: 'danger', done: 'success' }
const DOT: Record<ActivityStatus, DotState> = { queued: 'idle', working: 'ongoing', idle: 'idle', review: 'warning',
  answer: 'warning', delivery: 'warning', blocked: 'warning', failed: 'error', done: 'done' }
const MAX_DEPTH = 5

const actionLabel = (t: T, action: ProjectAction): string => t(`projectsAction.${action}`)
const issueLabel = (t: T, attention: ProjectAttentionView): string => t(`projectsIssue.${attention.kind}`)
const toastTime = (value: string | undefined, t: T): string => value ? fullTime(value, t('lang')) : t('projectsUnknownTime')

/** A read-only profile registry map; an unavailable registry makes owners unknown rather than inventing a name. */
function useProfiles(): readonly ProfileRow[] {
  const { call } = usePanel()
  const [profiles, setProfiles] = useState<ProfileRow[]>([])
  useEffect(() => {
    let active = true
    call('GET profiles').then(result => { if (active) setProfiles(result.profiles) }, () => { if (active) setProfiles([]) })
    return () => { active = false }
  }, [call])
  return profiles
}

function ProjectPending({ items, issues, t, expanded, onToggle, onOpenProject, onOpenTask, expandable = true }: {
  items: readonly ProjectAttentionItem[]; issues: readonly ProjectIssueItem[]
  t: T; expanded: boolean; onToggle: () => void; onOpenProject: (id: string) => void
  onOpenTask: (taskId: string, projectId: string, from: 'project') => void; expandable?: boolean }) {
  const all = items.length + issues.length
  const shown = expanded ? items : items.slice(0, 4)
  return <section className="dt-project-pending" aria-labelledby="dt-project-pending-title">
    <div className="dt-project-pending-head">
      <h3 id="dt-project-pending-title">{t('projectsAttentionTitle')} <span className="dt-project-pending-count">{all}</span></h3>
      {expandable && all > 4 && <button type="button" className="dt-textlink" onClick={onToggle}>
        {expanded ? t('projectsAttentionLess') : t('projectsAttentionAll', { count: all })}</button>}
    </div>
    {all === 0 ? <p className="dt-project-pending-empty">{t('projectsAttentionEmpty')}</p>
      : <ul className="dt-project-pending-list">{issues.map(item => <li key={`issue:${item.project.id}`} data-project-id={item.project.id}
        data-archived={isArchived(item.project) ? 'true' : undefined}>
        <Tag tone="warning">{issueLabel(t, item.attention)}</Tag>
        <button type="button" className="dt-project-pending-title" onClick={() => onOpenProject(item.project.id)}>
          {projectTitle(item.project) || t('projectsUnnamed')}</button>
        {isArchived(item.project) && <Tag tone="quiet">{t('projectsArchivedBadge')}</Tag>}
        {item.attention.detail && <span className="dt-hint">{item.attention.detail}</span>}
        {item.at && <time dateTime={item.at}>{updatedText(item.at, t)}</time>}
        <Button size="sm" variant="outline" onClick={() => onOpenProject(item.project.id)}>{t('projectsIssueFix')}</Button>
      </li>)}{shown.map(item => <li key={`${item.project.id}:${item.task.id}`}
        data-project-id={item.project.id} data-archived={isArchived(item.project) ? 'true' : undefined}>
        <Tag tone="warning">{actionLabel(t, item.action)}</Tag>
        <button type="button" className="dt-project-pending-title" onClick={() => onOpenTask(item.task.id, item.project.id, 'project')}>
          {item.task.title}</button>
        <button type="button" className="dt-textlink dt-project-pending-project" onClick={() => onOpenProject(item.project.id)}>
          {projectTitle(item.project) || t('projectsUnnamed')}</button>
        {isArchived(item.project) && <Tag tone="quiet">{t('projectsArchivedBadge')}</Tag>}
        {item.at && <time dateTime={item.at}>{updatedText(item.at, t)}</time>}
        <Button size="sm" variant="outline" onClick={() => onOpenTask(item.task.id, item.project.id, 'project')}>
          {actionLabel(t, item.action)}</Button>
      </li>)}</ul>}
  </section>
}

function projectChips(project: ProjectView, tasks: readonly TaskView[], t: T): ReactNode {
  const totals = totalsOf(project, tasks)
  const done = totals.tasks > 0 && totals.done === totals.tasks
  return <>
    {isArchived(project) && <Tag tone="quiet">{t('projectsArchivedBadge')}</Tag>}
    {project.attention && <Tag tone="danger">{issueLabel(t, project.attention)}</Tag>}
    {ownerMissing(project) && !project.attention && <Tag tone="danger">{t('projectsOwnerUnavailable')}</Tag>}
    {totals.attention > 0 && <Tag tone="warning">{t('projectsAttentionChip', { count: totals.attention })}</Tag>}
    {totals.blocked > 0 && <Tag tone="warning">{t('projectsBlockedChip', { count: totals.blocked })}</Tag>}
    {!ownerMissing(project) && totals.attention === 0 && totals.blocked === 0 && done && <Tag tone="success">{t('projectsAllDone')}</Tag>}
    {totals.tasks === 0 && <Tag tone="neutral">{t('projectsNoTasks')}</Tag>}
  </>
}

function pendingLine(project: ProjectView, tasks: readonly TaskView[], t: T): ReactNode {
  if (project.attention) return <span className="dt-project-warning">{issueLabel(t, project.attention)}</span>
  if (ownerIssue(project)) return <span className="dt-project-warning">{t('projectsFixOwner')}</span>
  const waiting = tasks.filter(task => task.attention).slice(0, 2)
  if (!waiting.length) return <span className="dt-project-quiet">{t('projectsNoPending')}</span>
  return <>{waiting.map((task, index) => <span key={task.id}>{index > 0 && ' · '}{t('projectsPendingLine', {
    action: actionLabel(t, actionOf(task)), task: task.title })}</span>)}</>
}

function blockedLine(project: ProjectView, tasks: readonly TaskView[], t: T): ReactNode {
  const totals = totalsOf(project, tasks)
  if (!totals.blocked) return null
  const detail = tasks.map(task => task.blocker?.detail).find((value): value is string => !!value)
  return <p className="dt-project-blocked">{detail ? t('projectsBlockedLine', { detail })
    : t('projectsBlockedCount', { count: totals.blocked })}</p>
}

function ProjectCard({ project, board, profiles, t, onOpen }: { project: ProjectView; board: ProjectBoardView; profiles: readonly ProfileRow[]
  t: T; onOpen: () => void }) {
  const tasks = tasksOfProject(project, board)
  const totals = totalsOf(project, tasks)
  const latest = activityItems(project, tasks, t)[0]
  return <article className="dt-project-card" data-archived={isArchived(project) ? 'true' : undefined}>
    <header className="dt-project-card-head">
      <button type="button" className="dt-project-name" onClick={onOpen}>{projectTitle(project) || t('projectsUnnamed')}</button>
      <span className="dt-project-chips">{projectChips(project, tasks, t)}</span>
    </header>
    <p className="dt-project-goal" title={project.goal || undefined}>{project.goal || t('projectsUnknownGoal')}</p>
    <p className="dt-project-owner"><Icon name="user" size={13} /><span>{t('projectsOwner')} {projectOwnerLabel(project, profiles, t)}</span></p>
    {totals.tasks > 0 ? <div className="dt-project-progress">
      <span className="dt-project-progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={totals.tasks} aria-valuenow={totals.done}>
        <span style={{ width: `${totals.progress}%` }} />
      </span>
      <span className="dt-hint">{t('projectsProgress', { done: totals.done, total: totals.tasks })}</span>
    </div> : <p className="dt-hint">{t('projectsNoTasksHint')}</p>}
    <p className="dt-project-pending-line">{pendingLine(project, tasks, t)}</p>
    {blockedLine(project, tasks, t)}
    <footer className="dt-project-card-foot">
      <time dateTime={lastActivityOf(project, tasks)}>{updatedText(lastActivityOf(project, tasks), t)}</time>
      <span className="dt-project-activity" title={latest ? `${latest.task.title} · ${latest.text}` : undefined}>
        {latest ? `${latest.task.title} · ${latest.text}` : t('projectsNoActivity')}</span>
    </footer>
  </article>
}

function UnassignedStrip({ count, t, onOpen }: { count: number; t: T; onOpen: () => void }) {
  return <section className="dt-project-unassigned" aria-label={t('projectsUnassigned')}>
    <div><strong>{t('projectsUnassigned')}</strong> <span className="dt-hint">{t('projectsUnassignedCount', { count })}</span></div>
    <span className="dt-hint">{t('projectsUnassignedHint')}</span>
    <Button size="sm" variant="outline" onClick={onOpen}>{t('projectsUnassignedOpen')}</Button>
  </section>
}

function EmptyProjects({ t, onOpenConversation, onOpenAll }: { t: T; onOpenConversation?: () => void; onOpenAll: () => void }) {
  return <section className="dt-project-empty">
    <h3>{t('projectsEmptyTitle')}</h3>
    <p>{t('projectsEmptyBody')}</p>
    <div className="dt-actions">
      {onOpenConversation && <Button variant="primary" icon={<Icon name="message" size={14} />} onClick={onOpenConversation}>
        {t('projectsEmptyConversation')}</Button>}
      <Button variant="outline" onClick={onOpenAll}>{t('projectsEmptyAllTasks')}</Button>
    </div>
  </section>
}

function ProjectList({ board, profiles, t, extraArchived, loadingArchived, onLoadArchived, onOpenProject, onOpenTask,
  onOpenAll, onOpenUnassigned, onOpenConversation }: {
  board: ProjectBoardView; profiles: readonly ProfileRow[]; t: T; extraArchived: readonly ProjectView[]
  loadingArchived: boolean; onLoadArchived: () => void
  onOpenProject: (id: string) => void; onOpenTask: (taskId: string, projectId: string, from: 'project') => void
  onOpenAll: () => void; onOpenUnassigned: () => void; onOpenConversation?: () => void }) {
  const [archived, setArchived] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const projects = board.projects ?? []
  const active = projects.filter(project => !isArchived(project))
  const archivedProjects = [...projects.filter(isArchived), ...extraArchived.filter(isArchived)]
  const archivedCount = board.totals?.archivedProjects ?? archivedProjects.length
  const chooseArchived = (value: boolean) => {
    setArchived(value)
    if (value) onLoadArchived()
  }
  const sorted = sortedProjects(archived ? archivedProjects : active, board)
  const pending = attentionItems([...projects, ...extraArchived], board)
  const issues = projectIssueItems([...projects, ...extraArchived])
  const unassigned = unassignedTasks(board)
  const shown = projects.length === 0 && extraArchived.length === 0 && unassigned.length === 0
  // Archived pending work must stay in "waiting for you" even while the default list shows active projects only.
  useEffect(() => { if (archivedCount > 0 && archivedProjects.length === 0) onLoadArchived() },
    [archivedCount, archivedProjects.length, onLoadArchived])
  return <section className="dt-projects">
    <header className="dt-projects-head">
      <div>
        <h2 className="dt-projects-heading">{t('projectsHeading')}</h2>
        <p className="dt-hint">{t('projectsIntro')}</p>
      </div>
      <div className="dt-projects-actions">
        <Button size="sm" variant="ghost" icon={<Icon name="queue" size={13} />} onClick={onOpenAll}>{t('projectsAllTasks')}</Button>
        <Button size="sm" variant="ghost" icon={<Icon name="decision" size={13} />} disabled={unassigned.length === 0}
          onClick={onOpenUnassigned}>{t('projectsUnassigned')} {unassigned.length}</Button>
      </div>
    </header>
    <div className="dt-project-filter" role="group" aria-label={t('projectsFilterLabel')}>
      <Pill active={!archived} onClick={() => chooseArchived(false)}>{t('projectsActive')} {active.length}</Pill>
      <Pill active={archived} onClick={() => chooseArchived(true)}>{t('projectsArchived')} {archivedCount}</Pill>
      <button type="button" className="dt-textlink dt-project-archive-entry" onClick={() => chooseArchived(!archived)}>
        {archived ? t('projectsBackToActive') : t('projectsViewArchived', { count: archivedCount })}</button>
    </div>
    {shown ? <EmptyProjects t={t} onOpenConversation={onOpenConversation} onOpenAll={onOpenAll} /> : <>
      <ProjectPending items={pending} issues={issues} t={t} expanded={expanded} onToggle={() => setExpanded(!expanded)}
        onOpenProject={onOpenProject} onOpenTask={onOpenTask} />
      {sorted.length ? <div className="dt-project-grid">{sorted.map(project => <ProjectCard key={project.id} project={project}
        board={board} profiles={profiles} t={t} onOpen={() => onOpenProject(project.id)} />)}</div>
        : <p className="dt-project-filter-empty">{loadingArchived ? t('loading')
          : archived ? t('projectsArchivedEmpty') : t('projectsActiveEmpty')}</p>}
      {unassigned.length > 0 && <UnassignedStrip count={unassigned.length} t={t} onOpen={onOpenUnassigned} />}
    </>}
    <p className="dt-hint">{t('projectsArchiveNote')}</p>
  </section>
}

function ProjectTreeNode({ task, depth, expanded, toggle, profiles, t, onOpenTask, detailOf }: { task: TaskView; depth: number
  expanded: ReadonlySet<string>; toggle: (id: string) => void; profiles: readonly ProfileRow[]; t: T
  onOpenTask: (taskId: string) => void; detailOf: (id: string) => { children: TaskView[] } | undefined }) {
  const open = expanded.has(task.id)
  const loaded = detailOf(task.id)
  const children = open ? loaded?.children ?? task.children ?? [] : []
  const total = task.childSummary?.total ?? children.length
  const hasChildren = total > 0
  const owner = taskOwnerLabel(task, profiles, t)
  const resolution = task.delegation?.resolution
  const report = resolution ? t(`delegationResolution.${resolution.kind}`)
    : task.review?.summary ?? task.blocker?.detail ?? (task.childSummary ? t('projectsChildReports', { count: task.childSummary.total }) : undefined)
  return <li className="dt-project-tree-node" data-status={task.status} data-task-id={task.id}
    data-owner-known={task.owner?.profile || task.form === 'lightweight' ? 'true' : undefined}>
    <div className="dt-project-tree-row" style={{ paddingInlineStart: `${depth * 18}px` }}>
      {hasChildren && depth < MAX_DEPTH ? <button type="button" className="dt-task-toggle" aria-expanded={open}
        aria-label={`${open ? t('tasksCollapse') : t('tasksExpand')} · ${task.title}`} onClick={() => toggle(task.id)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} /></button> : <span className="dt-task-toggle" aria-hidden />}
      <Dot state={DOT[task.status]} label={statusLabel(task, t)} />
      <Tag tone={TONE[task.status]}>{statusLabel(task, t)}</Tag>
      <button type="button" className="dt-project-task-title" onClick={() => onOpenTask(task.id)}>{task.title}</button>
      {hasChildren && <span className="dt-hint">{t('tasksChildCount', { count: total })}</span>}
      <span className="dt-project-task-owner">{t('projectsTaskOwner')} {owner}</span>
      {task.parentTicketId && task.parentOwner && <Tag tone="quiet">{t('projectsParentOwner', {
        owner: taskOwnerLabel({ form: 'tracked', owner: task.parentOwner }, profiles, t) })}</Tag>}
      {report && <span className="dt-project-task-report">{report}</span>}
      {task.lastEventAt && <time dateTime={task.lastEventAt} title={toastTime(task.lastEventAt, t)}>{updatedText(task.lastEventAt, t)}</time>}
    </div>
    {open && hasChildren && !loaded && depth < MAX_DEPTH && <p className="dt-hint dt-project-tree-loading">{t('loading')}</p>}
    {children.length > 0 && <ul className="dt-project-tree-children">{children.map(child => <ProjectTreeNode key={child.id}
      task={child} depth={depth + 1} expanded={expanded} toggle={toggle} profiles={profiles} t={t} onOpenTask={onOpenTask}
      detailOf={detailOf} />)}</ul>}
  </li>
}

function ProjectTree({ tasks, store, profiles, t, onOpenTask }: { tasks: readonly TaskView[]; store: TasksViewClient
  profiles: readonly ProfileRow[]; t: T; onOpenTask: (taskId: string) => void }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (id: string) => {
    const opening = !expanded.has(id)
    setExpanded(current => { const next = new Set(current); if (opening) next.add(id); else next.delete(id); return next })
    if (opening) store.ensureDetail(id)
  }
  if (!tasks.length) return <p className="dt-hint">{t('projectsNoTasksHint')}</p>
  return <ul className="dt-project-tree">{tasks.map(task => <ProjectTreeNode key={task.id} task={task} depth={0}
    expanded={expanded} toggle={toggle} profiles={profiles} t={t} onOpenTask={onOpenTask}
    detailOf={id => store.detailOf(id)} />)}</ul>
}

function ProjectDetail({ project, board, store, profiles, t, onBack, onOpenTask, onOpenProject }: { project: ProjectView
  board: ProjectBoardView; store: TasksViewClient; profiles: readonly ProfileRow[]; t: T; onBack: () => void
  onOpenTask: (taskId: string) => void; onOpenProject: (id: string) => void }) {
  const tasks = tasksOfProject(project, board)
  const totals = totalsOf(project, tasks)
  const pending = attentionItems([project], board)
  const issues = projectIssueItems([project])
  const activity = activityItems(project, tasks, t)
  return <section className="dt-project-detail">
    <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" size={14} />} onClick={onBack}>{t('projectsBack')}</Button>
    <header className="dt-project-detail-head">
      <div className="dt-project-detail-title">
        <h2>{projectTitle(project) || t('projectsUnnamed')}</h2>
        {isArchived(project) && <Tag tone="quiet">{t('projectsArchivedBadge')}</Tag>}
      </div>
      <p className="dt-project-detail-goal">{project.goal || t('projectsUnknownGoal')}</p>
      <p className="dt-project-detail-meta">
        <span><Icon name="user" size={13} /> {t('projectsOwner')} {projectOwnerLabel(project, profiles, t)}</span>
        <span>{t('projectsTopTasks', { count: totals.tasks })}</span>
        <span>{t('projectsProgress', { done: totals.done, total: totals.tasks })}</span>
        <span>{t('projectsUpdated', { time: updatedText(lastActivityOf(project, tasks), t) })}</span>
      </p>
      {project.attention && <p className="dt-project-warning">{t('projectsIssueHint', { kind: issueLabel(t, project.attention) })}</p>}
      {ownerMissing(project) && !project.attention && <p className="dt-project-warning">{t('projectsOwnerUnavailableHint')}</p>}
    </header>
    <ProjectPending items={pending} issues={issues} t={t} expanded onToggle={() => {}} expandable={false}
      onOpenProject={onOpenProject} onOpenTask={(taskId, projectId) => { if (projectId === project.id) onOpenTask(taskId); }} />
    <div className="dt-project-detail-grid">
      <section className="dt-project-tree-section">
        <div className="dt-project-section-head">
          <h3>{t('projectsTaskTree')}</h3>
          <span className="dt-hint">{t('projectsTopTasks', { count: totals.tasks })}</span>
        </div>
        <ProjectTree tasks={tasks} store={store} profiles={profiles} t={t} onOpenTask={onOpenTask} />
      </section>
      <aside className="dt-project-activity-section">
        <h3>{t('projectsRecent')}</h3>
        {activity.length ? <ul className="dt-project-activity-list">{activity.map(item => <li key={item.task.id}>
          <time dateTime={item.at}>{updatedText(item.at, t)}</time>
          <button type="button" className="dt-textlink" onClick={() => onOpenTask(item.task.id)}>{item.task.title}</button>
          <span className="dt-hint">{item.text}</span>
        </li>)}</ul> : <p className="dt-hint">{t('projectsNoActivity')}</p>}
      </aside>
    </div>
  </section>
}

function MissingProject({ t, onBack, onOpenAll }: { t: T; onBack: () => void; onOpenAll: () => void }) {
  return <section className="dt-project-missing">
    <h2>{t('projectsMissingTitle')}</h2>
    <p className="dt-hint">{t('projectsMissingBody')}</p>
    <div className="dt-actions">
      <Button variant="primary" onClick={onBack}>{t('projectsMissingBack')}</Button>
      <Button variant="outline" onClick={onOpenAll}>{t('projectsAllTasks')}</Button>
    </div>
  </section>
}

function MissingTask({ t, onBack, onOpenAll }: { t: T; onBack: () => void; onOpenAll: () => void }) {
  return <section className="dt-project-missing">
    <h2>{t('projectsMissingTaskTitle')}</h2>
    <p className="dt-hint">{t('projectsMissingTaskBody')}</p>
    <div className="dt-actions">
      <Button variant="primary" onClick={onBack}>{t('projectsMissingBack')}</Button>
      <Button variant="outline" onClick={onOpenAll}>{t('projectsAllTasks')}</Button>
    </div>
  </section>
}

function ProjectTaskDetail({ project, task, board, store, profiles, t, from, onBack, onOpenTicket, onOpenProject, onBackFlat,
  onOpenTask }: { project?: ProjectView; task: TaskView; board: ProjectBoardView; store: TasksViewClient
  profiles: readonly ProfileRow[]; t: T; from: 'project' | 'all' | 'unassigned'; onBack: () => void
  onOpenTicket: (id: string) => void; onOpenProject: (id: string) => void; onBackFlat: () => void
  onOpenTask: (id: string) => void }) {
  const crumbs = from === 'project' && project
    ? [{ label: t('projectsHeading'), onClick: onBack }, { label: projectTitle(project) || t('projectsUnnamed'), onClick: () => onOpenProject(project.id) }]
    : from === 'all' ? [{ label: t('projectsAllTasks'), onClick: onBackFlat }]
      : [{ label: t('projectsUnassigned'), onClick: onBackFlat }]
  const ancestors = project ? ancestorsOf(project, board, task, id => store.detailOf(id)) : { ancestors: [] }
  const all = [...crumbs, ...ancestors.ancestors.map(item => ({ label: item.title, onClick: () => onOpenTask(item.id) }))]
  return <section className="dt-project-task-detail">
    <TaskDetail task={task} store={store} onBack={onBack} onOpenTicket={onOpenTicket} crumbs={all}
      backLabel={from === 'project' ? t('projectsBackToProject') : from === 'all' ? t('projectsBackAll') : t('projectsBackUnassigned')}
      project={project ? { name: projectTitle(project) || t('projectsUnnamed'), owner: projectOwnerLabel(project, profiles, t) } : undefined}
      projects={profiles} />
    {ancestors.missingParent && <p className="dt-hint">{t('projectsMissingParent')}</p>}
  </section>
}

/** The flat "all tasks" and "unassigned" destinations keep the existing TaskList renderer from the Tasks page. */
export type FlatTasksRenderer = (tasks: readonly TaskView[], openTask: (id: string) => void) => ReactNode

function FlatScreen({ title, hint, tasks, t, onBack, render, openTask }: { title: string; hint: string; tasks: readonly TaskView[]
  t: T; onBack: () => void; render: FlatTasksRenderer; openTask: (id: string) => void }) {
  return <section className="dt-project-flat">
    <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" size={14} />} onClick={onBack}>{t('projectsBack')}</Button>
    <h2 className="dt-projects-heading">{title}</h2>
    <p className="dt-hint">{hint}</p>
    {render(tasks, openTask)}
  </section>
}

export function ProjectsBoard({ board, store, profiles, t, loadArchived, onOpenTicket, onOpenConversation, renderFlat }: {
  board: ProjectBoardView; store: TasksViewClient; profiles: readonly ProfileRow[]; t: T
  loadArchived?: () => Promise<readonly ProjectView[]>
  onOpenTicket: (id: string) => void
  onOpenConversation?: () => void; renderFlat: FlatTasksRenderer }) {
  const [screen, setScreen] = useState<ProjectScreen>({ view: 'list' })
  const [extraArchived, setExtraArchived] = useState<readonly ProjectView[]>([])
  const [loadingArchived, setLoadingArchived] = useState(false)
  const [archivedTried, setArchivedTried] = useState(false)
  const projects = [...(board.projects ?? []), ...extraArchived]
  const archivedCount = board.totals?.archivedProjects ?? projects.filter(isArchived).length
  const requestArchived = () => {
    if (!loadArchived || loadingArchived || archivedTried || extraArchived.length > 0 || projects.some(isArchived)
      || archivedCount === 0) return
    setArchivedTried(true)
    setLoadingArchived(true)
    void loadArchived().then(items => setExtraArchived(items.filter(project => !projects.some(known => known.id === project.id))),
      () => setExtraArchived([])).finally(() => setLoadingArchived(false))
  }
  const projectOfTask = (id: string): ProjectView | undefined => projects.find(project => !!findTask(project, board, id, key => store.detailOf(key)))
  if (screen.view === 'list') return <ProjectList board={board} profiles={profiles} t={t} extraArchived={extraArchived}
    loadingArchived={loadingArchived} onLoadArchived={requestArchived}
    onOpenProject={id => setScreen({ view: 'project', id })}
    onOpenTask={(taskId, projectId) => setScreen({ view: 'task', taskId, projectId, from: 'project' })}
    onOpenAll={() => setScreen({ view: 'all' })} onOpenUnassigned={() => setScreen({ view: 'unassigned' })}
    onOpenConversation={onOpenConversation} />
  if (screen.view === 'all') return <FlatScreen title={t('projectsAllTasks')} hint={t('projectsAllTasksHint')} tasks={board.tasks}
    t={t} onBack={() => setScreen({ view: 'list' })} render={renderFlat}
    openTask={id => setScreen({ view: 'task', taskId: id, projectId: projectOfTask(id)?.id, from: 'all' })} />
  if (screen.view === 'unassigned') return <FlatScreen title={t('projectsUnassigned')} hint={t('projectsUnassignedHint')}
    tasks={unassignedTasks(board)} t={t} onBack={() => setScreen({ view: 'list' })} render={renderFlat}
    openTask={id => setScreen({ view: 'task', taskId: id, from: 'unassigned' })} />
  if (screen.view === 'project') {
    const project = projects.find(item => item.id === screen.id)
    if (!project) return <MissingProject t={t} onBack={() => setScreen({ view: 'list' })} onOpenAll={() => setScreen({ view: 'all' })} />
    return <ProjectDetail project={project} board={board} store={store} profiles={profiles} t={t}
      onBack={() => setScreen({ view: 'list' })} onOpenProject={id => setScreen({ view: 'project', id })}
      onOpenTask={taskId => setScreen({ view: 'task', taskId, projectId: project.id, from: 'project' })} />
  }
  const project = screen.projectId ? projects.find(item => item.id === screen.projectId) : projectOfTask(screen.taskId)
  if (screen.projectId && !project) return <MissingProject t={t} onBack={() => setScreen({ view: 'list' })}
    onOpenAll={() => setScreen({ view: 'all' })} />
  const task = project ? findTask(project, board, screen.taskId, id => store.detailOf(id)) : board.tasks.find(item => item.id === screen.taskId)
  if (!task) return <MissingTask t={t} onBack={() => setScreen({ view: screen.from === 'all' ? 'all' : screen.from === 'unassigned'
    ? 'unassigned' : 'list' })} onOpenAll={() => setScreen({ view: 'all' })} />
  const flatBack = () => setScreen({ view: screen.from === 'all' ? 'all' : 'unassigned' })
  return <ProjectTaskDetail project={project} task={task} board={board} store={store} profiles={profiles} t={t} from={screen.from}
    onBack={() => project ? setScreen({ view: 'project', id: project.id }) : flatBack()} onOpenTicket={onOpenTicket}
    onOpenProject={id => setScreen({ view: 'project', id })} onBackFlat={flatBack}
    onOpenTask={id => setScreen({ view: 'task', taskId: id, projectId: project?.id, from: screen.from })} />
}

/** The project page owns the profile read; a failed registry leaves every owner visibly unknown. */
export function ProjectsPageBody({ board, store, t, onOpenTicket, onOpenConversation, renderFlat }: {
  board: ProjectBoardView; store: TasksViewClient; t: T; onOpenTicket: (id: string) => void
  onOpenConversation?: () => void; renderFlat: FlatTasksRenderer }) {
  const { call } = usePanel()
  const profiles = useProfiles()
  // The default board carries unarchived projects only; the archive view asks the same GET for the archived ones.
  const loadArchived = async (): Promise<readonly ProjectView[]> => {
    const tasks = await (call as unknown as (route: string, request: { query: Record<string, string> }) => Promise<ProjectBoardView>)(
      'GET tasks', { query: { projects: 'archived' } })
    return tasks.projects ?? []
  }
  return <ProjectsBoard board={board} store={store} profiles={profiles} t={t} loadArchived={loadArchived} onOpenTicket={onOpenTicket}
    onOpenConversation={onOpenConversation} renderFlat={renderFlat} />
}

