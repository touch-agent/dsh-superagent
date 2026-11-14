/**
 * The task detail: one Ticket at a time, in the order a person reads work. Batch 2 leads with the person's decision,
 * result, next step with honest timing and a human owner before the goal, then child levels, blockers, reporting and the
 * working session. A child level opens in place and its report folds out its goal, judgement and deliverables, so the
 * whole delegation chain is reachable without turning the default list into a deep tree. Internal ids and Session ids
 * stay inside the collapsed E2 block, and every fact is a projection of `GET tasks`/`GET tasks/:id` and `GET profiles`.
 */
import { useEffect, useMemo, useState } from 'react'
import type { TaskView } from '../app/tasks.ts'
import { Button, Icon, Tag, type TagTone } from './controls.tsx'
import type { ApiResponse } from '../app/api.ts'
import { taskDetailV2 } from './features.ts'
import { usePanel } from './provider.tsx'
import { useTasksView, type TasksViewClient } from './tasks-view.ts'
import { errorText, fullTime, localized, valueLabel, when, type T } from './text.ts'
import { Hint } from './widgets.tsx'

type ProfileRow = ApiResponse<'GET profiles'>['profiles'][number]
const EMPTY_PROFILES: readonly ProfileRow[] = []

const STATUS_TONE: Record<TaskView['status'], TagTone> = { queued: 'neutral', working: 'info', idle: 'neutral', review: 'warning',
  answer: 'warning', delivery: 'warning', blocked: 'warning', failed: 'danger', done: 'success' }

/** What this level expects from a person next; a child's waiting state names the parent owner, not a person. */
export function nextStep(task: TaskView, t: T): string {
  if (task.parentTicketId && ['review', 'answer', 'delivery', 'blocked', 'failed'].includes(task.status))
    return t('taskHierarchyNextParent')
  if (task.status === 'review') return t('taskHierarchyNextReview')
  if (task.status === 'answer') return t('taskHierarchyNextAnswer', { question: task.goal.decision?.question ?? t('noticeNoQuestion') })
  if (task.status === 'delivery') return t('taskHierarchyNextDelivery')
  if (task.status === 'failed') return t('taskHierarchyNextRetry')
  if (task.status === 'blocked') return t('taskHierarchyNextBlocked')
  if (task.status === 'done') return t('taskHierarchyNextEnded')
  if (task.status === 'idle') return t('taskHierarchyNextIdle')
  return t('taskHierarchyNextWorking')
}

const statusLabel = (t: T, status: TaskView['status']): string => status === 'blocked' ? t('stage.blocked')
  : status === 'failed' ? t('stage.failed') : t(`activityStatus.${status}`)

const profileText = (t: T, profile: { id: string; revision: number } | undefined): string =>
  profile ? t('taskHierarchyOwnerProfile', profile) : t('taskHierarchyOwnerDefault')

/**
 * Batch 2 names the owner in human words. A profile title and description come from the read-only profile registry;
 * an unknown or unbound profile falls back to the default configuration, and the internal id never reaches E0/E1.
 */
function ownerLabel(t: T, profile: { id: string; revision: number } | undefined, profiles: readonly ProfileRow[]): { text: string
  description?: string } {
  if (!profile) return { text: t('taskDetailOwnerFallback'), description: t('taskDetailOwnerFallbackHint') }
  const known = profiles.find(item => item.id === profile.id)
  return { text: t('taskDetailOwnerProfile', { title: known?.title || t('taskDetailOwnerFallback'), revision: profile.revision }),
    ...known?.description ? { description: known.description } : {} }
}

/** A direct link only for a real address; a repository-relative ref opens the full record that contains it. */
const isWeb = (ref: string): boolean => /^https?:\/\//.test(ref)
const deliverableLink = (item: TaskView['deliverables'][number]): string | undefined =>
  [item.previewRef?.ref, item.artifact.ref].find(isWeb)

/** How soon this level is expected to move, phrased from what the record actually knows rather than invented. */
export function estimateText(task: TaskView, t: T): string {
  if (task.status === 'done') return t('taskDetailEstimateEnded')
  if (task.status === 'blocked' && !task.goal.decision) return t('taskDetailEstimateBlocked')
  if (task.status === 'review' || task.status === 'answer' || task.status === 'delivery' || task.status === 'failed'
    || task.status === 'blocked') return t('taskDetailEstimateWaiting')
  return t('taskDetailEstimateWorking')
}

function Deliverables({ task, t, onOpenTicket }: { task: TaskView; t: T; onOpenTicket?: (id: string) => void }) {
  if (!task.deliverables.length) return <p className="dt-hint">{t('taskHierarchyNoDeliverables')}</p>
  return <ul className="dt-task-report-list">{task.deliverables.map(item => <li key={item.key} className="dt-task-report">
    <Tag tone="info">{valueLabel(t, 'artifact', item.artifact.kind)}</Tag>
    <span className="dt-task-level-meta">{item.artifact.ref} · {item.artifact.revision}</span>
    {deliverableLink(item) ? <a className="dt-textlink" href={deliverableLink(item)} target="_blank" rel="noreferrer">
      {t('taskDetailOpenDeliverable')}</a> : onOpenTicket && <button type="button" className="dt-textlink"
      onClick={() => onOpenTicket(task.id)}>{t('taskDetailOpenRecord')}</button>}
    {item.parentAccepted && <Tag tone="neutral">{t('taskHierarchyParentAccepted')}</Tag>}
    {item.humanAccepted && <Tag tone="success">{t('taskHierarchyAccepted')}</Tag>}
    <span className="dt-hint">{when(item.at, t('lang'))}</span>
  </li>)}</ul>
}

/** The person's decision, stated before anything else; no decision is itself a useful answer. */
function Decision({ task, t, onOpenTicket }: { task: TaskView; t: T; onOpenTicket: (id: string) => void }) {
  const decision = task.goal.decision
  return <div className="dt-task-detail-section dt-task-decision" data-decision={decision?.kind ?? 'none'}>
    <h4>{t('taskDetailDecision')}</h4>
    {decision ? <>
      <p className="dt-task-report"><Tag tone="warning">{t('tasksDecision')}</Tag>
        <span>{decision.kind === 'answer' ? t('taskHierarchyNextAnswer', { question: decision.question ?? t('noticeNoQuestion') })
          : decision.kind === 'review' ? t('taskDetailDecisionReview')
            : decision.kind === 'delivery' ? t('taskDetailDecisionDelivery')
              : decision.kind === 'blocked' ? t('taskDetailDecisionBlocked') : t('taskDetailDecisionFailed')}</span></p>
      <div className="dt-actions">
        <Button variant="outline" size="sm" icon={<Icon name="chevron-right" size={13} />} onClick={() => onOpenTicket(task.id)}>
          {t('taskDetailDecisionOpen')}</Button>
        {(task.status === 'failed' || task.status === 'delivery') && <ConfirmRetry task={task} />}
      </div>
    </> : <>
      <p className="dt-task-report">{t('taskDetailDecisionNone')}</p>
      <p className="dt-hint">{t('taskDetailDecisionHint')}</p>
    </>}
  </div>
}

/** What the work produced: the latest report summary and every reviewable deliverable, linked when it has an address. */
function Done({ task, t, onOpenTicket }: { task: TaskView; t: T; onOpenTicket: (id: string) => void }) {
  const summary = task.review?.summary ?? [...task.deliverables].reverse().find(item => item.summary)?.summary
  return <div className="dt-task-detail-section dt-task-done">
    <h4>{t('taskDetailDone')}</h4>
    {summary ? <p className="dt-task-report dt-row-quote">{summary}</p> : !task.deliverables.length
      && <p className="dt-hint">{t('taskDetailNoResult')}</p>}
    <Deliverables task={task} t={t} onOpenTicket={onOpenTicket} />
  </div>
}

/** One ancestor link above an open task; a project crumb is supplied by the project page. */
export interface TaskCrumb { label: string; onClick?: () => void }

/** Who is doing the work at this level, in human words from the profile registry. */
function Owner({ task, t, profiles, project }: { task: TaskView; t: T; profiles: readonly ProfileRow[]
  project?: { name: string; owner: string } }) {
  if (task.form === 'lightweight') return <div className="dt-task-detail-section"><h4>{t('taskDetailOwner')}</h4>
    <Hint>{t('tasksLightweightNote')}</Hint></div>
  const own = ownerLabel(t, task.owner?.profile, profiles)
  const parent = task.parentOwner ? ownerLabel(t, task.parentOwner.profile, profiles) : undefined
  return <div className="dt-task-detail-section dt-task-owner-section">
    <h4>{t('taskDetailOwner')}</h4>
    <p className="dt-task-owner"><Tag tone="neutral">{t('taskDetailOwnerWorker')}</Tag>
      <span>{own.text}</span></p>
    {own.description && <p className="dt-hint dt-task-owner-note">{own.description}</p>}
    {project && <p className="dt-task-owner"><Tag tone="quiet">{t('projectsProjectOwner')}</Tag>
      <span>{project.owner}</span></p>}
    {parent && <>
      <p className="dt-task-owner"><Tag tone="quiet">{t('taskDetailOwnerUpstream')}</Tag><span>{parent.text}</span></p>
      {parent.description && <p className="dt-hint dt-task-owner-note">{parent.description}</p>}
      <p className="dt-hint">{t('taskDetailOwnerParentHint')}</p>
    </>}
    <p className="dt-task-report"><span>{task.parentTicketId
      ? t('taskHierarchyRelationChild', { parent: t('taskHierarchyParent'), attempt: task.delegation?.attempt ?? 1 })
      : t('taskHierarchyRelationRoot', { source: valueLabel(t, 'source', task.origin.source || 'conversation') })}</span></p>
  </div>
}

function Blocker({ task, t }: { task: TaskView; t: T }) {
  if (!task.blocker) return <p className="dt-hint">{t('taskHierarchyNoBlockers')}</p>
  const label = task.blocker.kind === 'delivery' ? t('taskHierarchyNextDelivery')
    : task.blocker.kind === 'orphaned' ? t('tasksNeedsOwner')
      : task.blocker.kind === 'child' ? `${task.blocker.count ?? 0} ${t('taskHierarchyChildren')}`
        : task.blocker.kind === 'blocked' ? t('stage.blocked') : t('stage.failed')
  return <div className="dt-task-report">
    <Tag tone={task.blocker.kind === 'failed' ? 'danger' : 'warning'}>{label}</Tag>
    {task.blocker.kind === 'child' ? <span>{t('taskHierarchyChildBlocker', { count: task.blocker.count ?? 0 })}</span>
      : task.blocker.detail && <span>{task.blocker.detail}</span>}
    {task.blocker.at && <span className="dt-hint">{when(task.blocker.at, t('lang'))}</span>}
  </div>
}

function Reports({ task, t, v2 = false, profiles = [] }: { task: TaskView; t: T; v2?: boolean
  profiles?: readonly ProfileRow[] }) {
  const resolution = task.delegation?.resolution
  return <>
    {task.parentTicketId ? <>
      <p className="dt-task-report">
        <Tag tone={resolution?.kind === 'accepted' ? 'success' : resolution ? 'neutral' : 'warning'}>
          {resolution?.kind === 'accepted' ? t('taskHierarchyParentAccepted')
            : resolution?.kind === 'cancelled' ? t('taskHierarchyParentRejected')
              : resolution?.kind === 'failed' ? t('taskHierarchyReportedFailed') : t('taskHierarchyWaitingParent')}</Tag>
        {task.parentOwner && <span>{t('tasksRole.parentWorker')} · {v2 ? ownerLabel(t, task.parentOwner.profile, profiles).text
          : profileText(t, task.parentOwner.profile)}</span>}
        {resolution?.at && <span className="dt-hint">{when(resolution.at, t('lang'))}</span>}
      </p>
      {task.delegation?.orphaned && <p className="dt-task-report"><Tag tone="danger">{t('tasksNeedsOwner')}</Tag>
        <span>{task.delegation.orphaned.reason}</span></p>}
      {task.delegation?.goal && <p className="dt-task-report"><span>{task.delegation.goal}</span></p>}
    </> : task.childSummary ? <p className="dt-task-report">
      <Tag tone={task.childSummary.blocked + task.childSummary.failed + task.childSummary.orphaned > 0 ? 'warning' : 'neutral'}>
        {t('tasksChildCount', { count: task.childSummary.total })}</Tag>
      <span className="dt-hint">{t('taskHierarchyChildReportsHint')}</span>
      {task.childSummary.review > 0 && <Tag tone="warning">{t('tasksParentReview')} {task.childSummary.review}</Tag>}
      {task.childSummary.accepted > 0 && <Tag tone="success">{t('taskHierarchyParentAccepted')} {task.childSummary.accepted}</Tag>}
      {task.childSummary.unresolved > 0 && <Tag tone="warning">{task.childSummary.unresolved} {t('taskHierarchyReportsWaiting')}</Tag>}
      {task.childSummary.failed > 0 && <Tag tone="danger">{task.childSummary.failed} {t('taskHierarchyReportsFailed')}</Tag>}
    </p> : <p className="dt-hint">{t('tasksNoResult')}</p>}
    {!v2 && task.review?.summary && <p className="dt-task-report"><span>{task.review.summary}</span></p>}
    {task.review?.accepted && <p className="dt-task-report"><Tag tone="success">{t('taskHierarchyAccepted')}</Tag>
      <span>{when(task.review.accepted.at, t('lang'))}</span></p>}
    {task.delegation?.resolution?.reason && <p className="dt-task-report"><span>{task.delegation.resolution.reason}</span></p>}
  </>
}

function LevelRow({ task, t, onEnter, onOpenTicket, v2 = false, profiles = [] }: { task: TaskView; t: T; onEnter: () => void
  onOpenTicket: (id: string) => void; v2?: boolean; profiles?: readonly ProfileRow[] }) {
  const deliverables = task.deliverables.length
  const report = task.delegation?.resolution
  return <li className="dt-task-level" data-status={task.status}>
    <div className="dt-task-level-head">
      <button type="button" className="dt-task-level-title" onClick={onEnter}>{task.title}</button>
      <Tag tone={STATUS_TONE[task.status]}>{statusLabel(t, task.status)}</Tag>
      {task.terminal && <Tag tone="quiet">{t(`tasksTerminal.${task.terminal}`)}</Tag>}
    </div>
    <div className="dt-task-level-meta">
      {t('taskHierarchyOwner')} · {v2 ? ownerLabel(t, task.owner?.profile, profiles).text : profileText(t, task.owner?.profile)}
      {deliverables > 0 && ` · ${t('tasksDeliverables', { count: deliverables })}`}
      {task.blocker && ` · ${t('taskHierarchyBlockers')}`}
    </div>
    {v2 ? <details className="dt-task-child-report">
      <summary>{t('taskDetailChildReport')}{report ? ` · ${report.kind === 'accepted' ? t('taskHierarchyReported')
        : report.kind === 'cancelled' ? t('taskHierarchyParentRejected') : t('taskHierarchyReportedFailed')}` : ''}</summary>
      <div className="dt-task-child-report-body">
        {task.delegation?.goal && <p className="dt-task-report"><span className="dt-hint">{t('taskDetailChildGoal')}</span>
          <span>{task.delegation.goal}</span></p>}
        {report ? <p className="dt-task-report"><Tag tone={report.kind === 'accepted' ? 'success' : 'neutral'}>
          {t('taskDetailChildJudgement')}</Tag>
          <span>{report.kind === 'accepted' ? t('taskHierarchyReported') : report.kind === 'cancelled'
            ? t('taskHierarchyParentRejected') : t('taskHierarchyReportedFailed')}</span>
          {report.reason && <span>{report.reason}</span>}
          <span className="dt-hint">{when(report.at, t('lang'))}</span></p>
          : <p className="dt-hint">{t('taskDetailChildNoReport')}</p>}
        {deliverables > 0 && <><p className="dt-task-report"><span className="dt-hint">{t('taskDetailDone')}</span>
          <span>{t('tasksDeliverables', { count: deliverables })}</span></p>
          <Deliverables task={task} t={t} onOpenTicket={onOpenTicket} /></>}
      </div>
    </details> : report && <div className="dt-task-report">
      <Tag tone={report.kind === 'accepted' ? 'success' : 'neutral'}>
        {report.kind === 'accepted' ? t('taskHierarchyReported')
          : report.kind === 'cancelled' ? t('taskHierarchyParentRejected') : t('taskHierarchyReportedFailed')}</Tag>
      {report.reason && <span>{report.reason}</span>}
      <span className="dt-hint">{when(report.at, t('lang'))}</span>
    </div>}
    <div><Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={13} />} onClick={onEnter}>
      {t('taskHierarchyOpenTicket')}</Button></div>
  </li>
}

/** The reports people and parent owners already made at this level, newest first; no entry is invented. */
function ReportHistory({ task, t }: { task: TaskView; t: T }) {
  const entries: { at: string; label: string; text?: string; who?: string }[] = []
  for (const item of task.deliverables) entries.push({ at: item.at, label: t('taskHistoryDelivered'),
    text: `${valueLabel(t, 'artifact', item.artifact.kind)} · ${item.artifact.ref} · ${item.artifact.revision}` })
  for (const item of task.delegation?.dispositions ?? []) entries.push({ at: item.at,
    label: valueLabel(t, 'decision', item.decision), ...item.reason ? { text: item.reason } : {},
    ...item.by?.name ? { who: localized(t, item.by.name) } : {} })
  const resolution = task.delegation?.resolution
  if (resolution) entries.push({ at: resolution.at, label: t(`delegationResolution.${resolution.kind}`),
    ...resolution.reason ? { text: resolution.reason } : {}, ...resolution.by?.name ? { who: localized(t, resolution.by.name) } : {} })
  if (task.review?.accepted) entries.push({ at: task.review.accepted.at, label: t('taskHierarchyAccepted'),
    ...task.review.accepted.by?.name ? { who: localized(t, task.review.accepted.by.name) } : {} })
  const ordered = entries.filter(item => item.at).sort((left, right) => Date.parse(right.at) - Date.parse(left.at)).slice(0, 8)
  if (!ordered.length) return <p className="dt-hint">{t('taskHierarchyNoReports')}</p>
  return <ul className="dt-task-history">{ordered.map((item, index) => <li key={`${item.at}:${index}`}>
    <Tag tone="quiet">{item.label}</Tag>
    {item.who && <span className="dt-hint">{item.who}</span>}
    {item.text && <span className="dt-task-report">{item.text}</span>}
    <time dateTime={item.at} className="dt-hint">{when(item.at, t('lang'))}</time>
  </li>)}</ul>
}

/**
 * The dedicated hierarchy detail. `task` is the row a person entered from; a child click swaps the focus instead of
 * navigating away, and the breadcrumb keeps the way back. The store loads each level's direct children on demand.
 */
export function TaskDetail({ task, store, onBack, onOpenTicket, crumbs = [], backLabel, project, projects = EMPTY_PROFILES }: {
  task: TaskView; store: TasksViewClient; onBack: () => void; onOpenTicket: (id: string) => void
  crumbs?: readonly TaskCrumb[]; backLabel?: string; project?: { name: string; owner: string }
  projects?: readonly ProfileRow[] }) {
  const { t, call, openSession, notify } = usePanel()
  const snapshot = useTasksView(store)
  const v2 = taskDetailV2()
  // Profile titles and descriptions are read-only; loading them only in the deeper view keeps the rollback path silent.
  const [profiles, setProfiles] = useState<readonly ProfileRow[]>([])
  // Entries keep the row a person entered from; every render resolves the same id against the newest poll answer,
  // so an open detail does not freeze at the first render while the list keeps moving underneath it.
  const [stack, setStack] = useState<Array<{ id: string; task: TaskView }>>(() => [{ id: task.id, task }])
  useEffect(() => {
    setStack(current => current[0]?.id === task.id ? current : [{ id: task.id, task }])
  }, [task.id, task])
  const resolved = stack.map(entry => entry.id === task.id ? task : store.detailOf(entry.id)?.task ?? store.findTask(entry.id) ?? entry.task)
  const focus = resolved.at(-1) ?? task
  const ids = stack.map(entry => entry.id).join('\u0000')
  const generatedAt = snapshot.data?.generatedAt
  useEffect(() => { for (const entry of stack) store.ensureDetail(entry.id) }, [store, ids, generatedAt])
  const detail = store.detailOf(focus.id)
  const children = detail?.children ?? focus.children ?? []
  const sessionId = focus.parentTicketId ? undefined : focus.worker?.sessionId ?? focus.execution.sessionId
  const deeper = (focus.childSummary?.total ?? 0) - children.length
  const source = useMemo(() => focus.sources.map(item => item.source).find(Boolean) ?? focus.origin.source, [focus])
  useEffect(() => {
    if (!v2 || projects.length > 0) { setProfiles(projects); return }
    let active = true
    call('GET profiles').then(result => { if (active) setProfiles(result.profiles) }, () => { if (active) setProfiles([]) })
    return () => { active = false }
  }, [call, projects, v2])
  return <section className="dt-task-detail" aria-label={t('taskHierarchyGoal')}>
    <div className="dt-task-detail-head">
      <div>
        <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" size={14} />} onClick={() => {
          if (stack.length > 1) setStack(stack.slice(0, -1)); else onBack()
        }}>{stack.length > 1 ? t('taskHierarchyParent') : backLabel ?? t('taskHierarchyBack')}</Button>
        {(crumbs.length > 0 || stack.length > 1) && <nav className="dt-task-crumbs" aria-label={t('projectsBreadcrumb')}>
          {crumbs.map((crumb, index) => <span key={`${crumb.label}:${index}`} className="dt-task-crumb-item">
            {index > 0 && <span className="dt-task-crumb-sep" aria-hidden>/</span>}
            {crumb.onClick ? <button type="button" className="dt-textlink" onClick={crumb.onClick}>{crumb.label}</button>
              : <span>{crumb.label}</span>}
          </span>)}
          {resolved.map((item, index) => {
            const current = index === resolved.length - 1
            return <span key={item.id} className="dt-task-crumb-item">
              {index > 0 || crumbs.length > 0 ? <span className="dt-task-crumb-sep" aria-hidden>/</span> : null}
              {current ? <span aria-current="page">{item.title}</span>
                : <button type="button" className="dt-textlink" onClick={() => setStack(stack.slice(0, index + 1))}>{item.title}</button>}
            </span>
          })}
        </nav>}
        <h2 className="dt-task-detail-title">{focus.title}</h2>
        <div className="dt-task-level-meta">{t('taskHierarchyStatus')} · {statusLabel(t, focus.status)}
          {source && ` · ${t('taskHierarchySource')} ${valueLabel(t, 'source', source)}`}</div>
      </div>
      <Button variant="outline" size="sm" icon={<Icon name="external" size={13} />}
        onClick={() => onOpenTicket(focus.id)}>{t('tasksOpen')}</Button>
    </div>
    {v2 && <Decision task={focus} t={t} onOpenTicket={onOpenTicket} />}
    {v2 && <Done task={focus} t={t} onOpenTicket={onOpenTicket} />}
    <div className="dt-task-detail-next"><strong>{t('taskHierarchyNext')}</strong><span>{nextStep(focus, t)}</span>
      {!v2 && (focus.status === 'failed' || focus.status === 'delivery') && <ConfirmRetry task={focus} />}</div>
    {v2 && <p className="dt-task-detail-estimate"><strong>{t('taskDetailNextEstimate')}</strong><span>{estimateText(focus, t)}</span></p>}
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyGoal')}</h4>
      <p className="dt-task-report">{focus.goal.statement}</p>
      {!v2 && focus.goal.decision && <p className="dt-task-report"><Tag tone="warning">{t('tasksDecision')}</Tag>
        <span>{focus.goal.decision.question ?? valueLabel(t, 'stage', focus.goal.decision.kind ?? '')}</span></p>}
    </div>
    {v2 ? <Owner task={focus} t={t} profiles={profiles} project={project} /> : <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyOwner')}</h4>
      {focus.form === 'lightweight' ? <Hint>{t('tasksLightweightNote')}</Hint> : <>
        <p className="dt-task-owner"><Tag tone="neutral">{t('tasksRole.parentWorker')}</Tag>
          <span>{profileText(t, focus.owner?.profile)}</span></p>
        {project && <p className="dt-task-owner"><Tag tone="quiet">{t('projectsProjectOwner')}</Tag><span>{project.owner}</span></p>}
        {focus.parentOwner && <p className="dt-task-owner"><Tag tone="quiet">{t('taskHierarchyParent')}</Tag>
          <span>{t('tasksRole.parentWorker')} · {profileText(t, focus.parentOwner.profile)}</span></p>}
        <p className="dt-task-report"><span>{focus.parentTicketId
          ? t('taskHierarchyRelationChild', { parent: t('taskHierarchyParent'), attempt: focus.delegation?.attempt ?? 1 })
          : t('taskHierarchyRelationRoot', { source: valueLabel(t, 'source', focus.origin.source || 'conversation') })}</span></p>
      </>}
    </div>}
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyChildren')}</h4>
      {v2 && children.length > 0 && <p className="dt-hint">{t('taskDetailChildReportsHint')}</p>}
      {children.length ? <ul className="dt-task-levels">{children.map(child => <LevelRow key={child.id} task={child} t={t} v2={v2} onOpenTicket={onOpenTicket}
        profiles={profiles} onEnter={() => { store.ensureDetail(child.id); setStack([...stack, { id: child.id, task: child }]) }} />)}</ul>
        : focus.childSummary?.total ? <p className="dt-hint">{t('loading')}</p> : <p className="dt-hint">{t('taskHierarchyNoChildren')}</p>}
      {deeper > 0 && <p className="dt-hint">{t('taskHierarchyMore', { count: deeper })}</p>}
    </div>
    {!v2 && <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyDeliverables')}</h4>
      <Deliverables task={focus} t={t} />
    </div>}
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyBlockers')}</h4>
      <Blocker task={focus} t={t} />
    </div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyReports')}</h4>
      <Reports task={focus} t={t} v2={v2} profiles={profiles} />
    </div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyReportHistory')}</h4>
      <ReportHistory task={focus} t={t} />
    </div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchySession')}</h4>
      {sessionId ? <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />}
        onClick={() => { openSession(sessionId).catch(failure => notify(errorText(failure))) }}>{t('openExecutorSession')}</Button>
        : <p className="dt-hint">{t('noExecutorSession')}</p>}
    </div>
    <details className="dt-details dt-e0-technical">
      <summary>{t('taskHierarchyAdvanced')}</summary>
      <div className="dt-row-meta">
        <span>{t('taskHierarchyTaskId')} · {focus.id}</span>
        {focus.rootTicketId && <span>{t('taskHierarchyRootId')} · {focus.rootTicketId}</span>}
        {focus.parentTicketId && <span>{t('taskHierarchyParent')} · {focus.parentTicketId}</span>}
        <span>{t('taskHierarchyAssignments')} · {focus.execution.assignments}</span>
        {focus.lastEventAt && <span>{t('noticeLatest', { time: fullTime(focus.lastEventAt, t('lang')) })}</span>}
      </div>
    </details>
    <p className="dt-hint">{t('taskHierarchyParentAcceptedNote')}</p>
  </section>
}

/** A retry of the failed work from the detail; the task page holds the same confirmed action for the record. */
function ConfirmRetry({ task }: { task: TaskView }) {
  const { t, call, notify } = usePanel()
  const [busy, setBusy] = useState(false)
  if (!task.attention) return null
  return <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={busy}
    onClick={() => {
      setBusy(true)
      call('POST tickets/:id/retry', { id: task.id }).then(() => notify(t('retryRequested')), failure => notify(errorText(failure)))
        .finally(() => setBusy(false))
    }}>{t('retry')}</Button>
}