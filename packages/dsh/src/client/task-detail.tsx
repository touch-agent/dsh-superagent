/**
 * UX batch 1's task hierarchy detail: one Ticket at a time, in the order a person reads work — goal, next step, owner,
 * child levels, deliverables, blocker, reporting and the working session. A child level opens in place, so the whole
 * delegation chain is reachable without turning the default list into a deep tree. Internal ids and Session ids stay
 * inside the collapsed E2 block, and every fact is a projection of `GET tasks`/`GET tasks/:id`.
 */
import { useEffect, useMemo, useState } from 'react'
import type { TaskView } from '../app/tasks.ts'
import { Button, Icon, Tag, type TagTone } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { useTasksView, type TasksViewClient } from './tasks-view.ts'
import { errorText, fullTime, valueLabel, when, type T } from './text.ts'
import { Hint } from './widgets.tsx'

const STATUS_TONE: Record<TaskView['status'], TagTone> = { queued: 'neutral', working: 'info', idle: 'neutral', review: 'warning',
  answer: 'warning', delivery: 'warning', blocked: 'warning', failed: 'danger', done: 'success' }

/** What this level expects from a person next; a child's waiting state names the parent owner, not a person. */
export function nextStep(task: TaskView, t: T): string {
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

function Deliverables({ task, t }: { task: TaskView; t: T }) {
  if (!task.deliverables.length) return <p className="dt-hint">{t('taskHierarchyNoDeliverables')}</p>
  return <ul className="dt-task-report-list">{task.deliverables.map(item => <li key={item.key} className="dt-task-report">
    <Tag tone="info">{valueLabel(t, 'artifact', item.artifact.kind)}</Tag>
    <span className="dt-task-level-meta">{item.artifact.ref} · {item.artifact.revision}</span>
    {item.parentAccepted && <Tag tone="neutral">{t('taskHierarchyParentAccepted')}</Tag>}
    {item.humanAccepted && <Tag tone="success">{t('taskHierarchyAccepted')}</Tag>}
    <span className="dt-hint">{when(item.at, t('lang'))}</span>
  </li>)}</ul>
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

function Reports({ task, t }: { task: TaskView; t: T }) {
  const resolution = task.delegation?.resolution
  return <>
    {task.parentTicketId ? <>
      <p className="dt-task-report">
        <Tag tone={resolution?.kind === 'accepted' ? 'success' : resolution ? 'neutral' : 'warning'}>
          {resolution?.kind === 'accepted' ? t('taskHierarchyParentAccepted')
            : resolution?.kind === 'cancelled' ? t('taskHierarchyParentRejected')
              : resolution?.kind === 'failed' ? t('taskHierarchyReportedFailed') : t('taskHierarchyWaitingParent')}</Tag>
        {task.parentOwner && <span>{t('tasksRole.parentWorker')} · {profileText(t, task.parentOwner.profile)}</span>}
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
    {task.review?.summary && <p className="dt-task-report"><span>{task.review.summary}</span></p>}
    {task.review?.accepted && <p className="dt-task-report"><Tag tone="success">{t('taskHierarchyAccepted')}</Tag>
      <span>{when(task.review.accepted.at, t('lang'))}</span></p>}
    {task.delegation?.resolution?.reason && <p className="dt-task-report"><span>{task.delegation.resolution.reason}</span></p>}
  </>
}

function LevelRow({ task, t, onEnter }: { task: TaskView; t: T; onEnter: () => void }) {
  const deliverables = task.deliverables.length
  return <li className="dt-task-level" data-status={task.status}>
    <div className="dt-task-level-head">
      <button type="button" className="dt-task-level-title" onClick={onEnter}>{task.title}</button>
      <Tag tone={STATUS_TONE[task.status]}>{statusLabel(t, task.status)}</Tag>
      {task.terminal && <Tag tone="quiet">{t(`tasksTerminal.${task.terminal}`)}</Tag>}
    </div>
    <div className="dt-task-level-meta">
      {t('taskHierarchyOwner')} · {profileText(t, task.owner?.profile)}
      {deliverables > 0 && ` · ${t('tasksDeliverables', { count: deliverables })}`}
      {task.blocker && ` · ${t('taskHierarchyBlockers')}`}
    </div>
    {task.delegation?.resolution && <div className="dt-task-report">
      <Tag tone={task.delegation.resolution.kind === 'accepted' ? 'success' : 'neutral'}>
        {task.delegation.resolution.kind === 'accepted' ? t('taskHierarchyReported')
          : task.delegation.resolution.kind === 'cancelled' ? t('taskHierarchyParentRejected') : t('taskHierarchyReportedFailed')}</Tag>
      {task.delegation.resolution.reason && <span>{task.delegation.resolution.reason}</span>}
      <span className="dt-hint">{when(task.delegation.resolution.at, t('lang'))}</span>
    </div>}
    <div><Button variant="ghost" size="sm" icon={<Icon name="chevron-right" size={13} />} onClick={onEnter}>
      {t('taskHierarchyOpenTicket')}</Button></div>
  </li>
}

/**
 * The dedicated hierarchy detail. `task` is the row a person entered from; a child click swaps the focus instead of
 * navigating away, and the breadcrumb keeps the way back. The store loads each level's direct children on demand.
 */
export function TaskDetail({ task, store, onBack, onOpenTicket }: { task: TaskView; store: TasksViewClient
  onBack: () => void; onOpenTicket: (id: string) => void }) {
  const { t, navigate, openSession, notify } = usePanel()
  const snapshot = useTasksView(store)
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
  return <section className="dt-task-detail" aria-label={t('taskHierarchyGoal')}>
    <div className="dt-task-detail-head">
      <div>
        <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" size={14} />} onClick={() => {
          if (stack.length > 1) setStack(stack.slice(0, -1)); else onBack()
        }}>{stack.length > 1 ? t('taskHierarchyParent') : t('taskHierarchyBack')}</Button>
        {stack.length > 1 && <p className="dt-hint">{resolved.map(item => item.title).join(' / ')}</p>}
        <h2 className="dt-task-detail-title">{focus.title}</h2>
        <div className="dt-task-level-meta">{t('taskHierarchyStatus')} · {statusLabel(t, focus.status)}
          {source && ` · ${t('taskHierarchySource')} ${valueLabel(t, 'source', source)}`}</div>
      </div>
      <Button variant="outline" size="sm" icon={<Icon name="external" size={13} />}
        onClick={() => onOpenTicket(focus.id)}>{t('tasksOpen')}</Button>
    </div>
    <div className="dt-task-detail-next"><strong>{t('taskHierarchyNext')}</strong><span>{nextStep(focus, t)}</span>
      {(focus.status === 'failed' || focus.status === 'delivery') && <ConfirmRetry task={focus} />}</div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyGoal')}</h4>
      <p className="dt-task-report">{focus.goal.statement}</p>
      {focus.goal.decision && <p className="dt-task-report"><Tag tone="warning">{t('tasksDecision')}</Tag>
        <span>{focus.goal.decision.question ?? valueLabel(t, 'stage', focus.goal.decision.kind ?? '')}</span></p>}
    </div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyOwner')}</h4>
      {focus.form === 'lightweight' ? <Hint>{t('tasksLightweightNote')}</Hint> : <>
        <p className="dt-task-owner"><Tag tone="neutral">{t('tasksRole.parentWorker')}</Tag>
          <span>{profileText(t, focus.owner?.profile)}</span></p>
        {focus.parentOwner && <p className="dt-task-owner"><Tag tone="quiet">{t('taskHierarchyParent')}</Tag>
          <span>{t('tasksRole.parentWorker')} · {profileText(t, focus.parentOwner.profile)}</span></p>}
        <p className="dt-task-report"><span>{focus.parentTicketId
          ? t('taskHierarchyRelationChild', { parent: t('taskHierarchyParent'), attempt: focus.delegation?.attempt ?? 1 })
          : t('taskHierarchyRelationRoot', { source: valueLabel(t, 'source', focus.origin.source || 'conversation') })}</span></p>
      </>}
    </div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyChildren')}</h4>
      {children.length ? <ul className="dt-task-levels">{children.map(child => <LevelRow key={child.id} task={child} t={t}
        onEnter={() => { store.ensureDetail(child.id); setStack([...stack, { id: child.id, task: child }]) }} />)}</ul>
        : focus.childSummary?.total ? <p className="dt-hint">{t('loading')}</p> : <p className="dt-hint">{t('taskHierarchyNoChildren')}</p>}
      {deeper > 0 && <p className="dt-hint">{t('taskHierarchyMore', { count: deeper })}</p>}
    </div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyDeliverables')}</h4>
      <Deliverables task={focus} t={t} />
    </div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyBlockers')}</h4>
      <Blocker task={focus} t={t} />
    </div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchyReports')}</h4>
      <Reports task={focus} t={t} />
    </div>
    <div className="dt-task-detail-section">
      <h4>{t('taskHierarchySession')}</h4>
      {sessionId ? <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />}
        onClick={() => { openSession(sessionId).catch(failure => notify(errorText(failure))) }}>{t('taskHierarchyOpenSession')}</Button>
        : <p className="dt-hint">{t('taskHierarchyNoSession')}</p>}
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