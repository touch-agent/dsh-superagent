/**
 * Main-Session surfaces: the New Session entry that opens the existing main Session, the "主" row marker, the "状态"
 * Conversation view that reuses the management page, and the right Events tab with its unread title, automatic first open
 * and task groups. All data comes from the management API the panel already uses.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ActivityRecord, ActivityStatus, ActivitySubject, ActivityTask } from '../app/activity.ts'
import type { ActivityFeedClient, ActivitySnapshot } from './activity-feed.ts'
import { useActivityFeed } from './activity-feed.ts'
import { eventsAutoOpen } from './features.ts'
import { Button, Icon, Pill, Tag, type IconName, type TagTone } from './controls.tsx'
import { useTaskSelection, type TasksViewClient } from './tasks-view.ts'
import type { MasterStore } from './master.ts'
import { useMaster } from './master.ts'
import { settingsRoute, type Route } from './route.ts'
import { duration, fullTime, localized, reasonLabel, valueLabel, when, type T } from './text.ts'
import { registerConversationView } from './view-actions.ts'

const LEVEL_TONE = { quiet: 'outline', feed: 'info', notice: 'warning' } as const
const STATUS_TONE: Record<ActivityStatus, TagTone> = { queued: 'neutral', working: 'info', idle: 'neutral', review: 'warning',
  answer: 'warning', delivery: 'warning', blocked: 'warning', failed: 'danger', done: 'success' }
const STATUS_ICON: Record<ActivityStatus, IconName> = { queued: 'queue', working: 'running', idle: 'clock', review: 'review',
  answer: 'ask', delivery: 'inbox', blocked: 'blocked', failed: 'alert', done: 'decision' }
const FILTERS = ['all', 'attention', 'running', 'failed'] as const
const REPORT_REASONS = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'] as const
/** How the Events tab narrows task groups: everything, a person's turn or trouble, live work, or failure alone. */
export type ActivityFilter = typeof FILTERS[number]

const openTicket = (id: string): Route => ({ page: 'execution', id })
const openThread = (id: string): Route => ({ page: 'trigger', id })
const shortId = (id: string): string => /^\d+$/.test(id) ? `#${id}` : id.length > 8 ? id.slice(0, 6) : id
const statusLabel = (t: T, status: ActivityStatus): string => t(`activityStatus.${status}`)
const assignmentReason = (t: T, reason: string): string => (REPORT_REASONS as readonly string[]).includes(reason)
  ? t(`report.${reason as typeof REPORT_REASONS[number]}`) : reasonLabel(t, reason)

/** The badge name of the object an event is about; a Thread shows its Source. */
export function activitySubjectText(t: T, subject: ActivitySubject): string {
  if (subject.kind === 'thread') {
    const name = localized(t, subject.label) || shortId(subject.id)
    const source = subject.source ? valueLabel(t, 'source', subject.source) : ''
    return source ? `${source} ${name}` : name
  }
  if (subject.kind === 'ticket' || subject.kind === 'trigger') return `${t(`activityObject.${subject.kind}`)} ${shortId(subject.id)}`
  return t(`activityObject.${subject.kind}`)
}

/** The human-readable line for one event, from its graded facts; a row stored before they existed keeps its summary. */
export function activityTitle(t: T, record: ActivityRecord): string {
  const title = record.task?.title ?? ''
  const detail = record.detail
  switch (record.event) {
    case 'trigger.received':
      return detail?.trigger?.preview ? t('activityEvent.triggerReceived', { preview: detail.trigger.preview }) : record.summary
    case 'eval.started':
      return t('activityEvent.evalStarted')
    case 'decision.recorded':
      return detail?.decision ? t('activityEvent.decision', { decision: t(`decision.${detail.decision}`) }) : record.summary
    case 'ticket.created':
      return title ? t('activityEvent.ticketCreated', { title }) : record.summary
    case 'ticket.resumed':
      return title ? t('activityEvent.ticketResumed', { title }) : record.summary
    case 'ticket.ended': {
      if (!detail?.outcome || !title) return record.summary
      const reason = detail.reason && detail.reason !== detail.outcome ? reasonLabel(t, detail.reason) : ''
      return reason ? t('activityEvent.ticketEndedReason', { outcome: t(`outcome.${detail.outcome}`), reason, title })
        : t('activityEvent.ticketEnded', { outcome: t(`outcome.${detail.outcome}`), title })
    }
    case 'assignment.started':
      return t('activityEvent.assignmentStarted')
    case 'assignment.ended':
      return detail?.reason ? t('activityEvent.assignmentEnded', { reason: assignmentReason(t, detail.reason) }) : record.summary
    case 'thread.subscribed':
      return record.subject ? t('activityEvent.threadSubscribed', { name: activitySubjectText(t, record.subject) }) : record.summary
    case 'thread.unsubscribed':
      return record.subject ? t('activityEvent.threadUnsubscribed', { name: activitySubjectText(t, record.subject) }) : record.summary
    case 'trigger.requeued':
      return t('activityEvent.triggerRequeued')
    case 'trigger.followup':
      return t('activityEvent.triggerFollowup')
    case 'policy.changed':
      return t('activityEvent.policyChanged')
    case 'ticket.delegated':
      return t('activityEvent.ticketDelegated', { child: shortId(detail?.childTicketId ?? record.subject?.id ?? '') })
    case 'ticket.child.reported':
      return t('activityEvent.childReported', { child: shortId(detail?.childTicketId ?? record.subject?.id ?? '') })
    case 'ticket.child.reviewed':
      return t('activityEvent.childReviewed', { child: shortId(detail?.childTicketId ?? record.subject?.id ?? '') })
    case 'ticket.end.pending':
      return record.summary
    case 'ticket.child.orphaned':
      return t('activityEvent.childOrphaned', { child: shortId(detail?.childTicketId ?? record.subject?.id ?? '') })
    default:
      return record.summary
  }
}

/** Where an event's object or row opens in the management panel. */
export function activityTarget(record: ActivityRecord): Route | undefined {
  const subject = record.subject
  if (subject?.kind === 'ticket') return openTicket(subject.id)
  if (subject?.kind === 'thread') return openThread(subject.id)
  if (subject?.kind === 'trigger') return record.thread ? { page: 'trigger', id: record.thread, query: { trigger: subject.id } } : undefined
  if (subject?.kind === 'decision') return { page: 'eval' }
  if (subject?.kind === 'policy') return settingsRoute('eval')
  if (record.ticket) return openTicket(record.ticket)
  if (record.thread) return openThread(record.thread)
  return undefined
}

/** What a task group shows in its header: the Ticket's current state, or the latest event's for work no Ticket owns. */
export function groupStatus(record: ActivityRecord): ActivityStatus {
  return record.task?.status ?? record.status ?? 'done'
}

/** Whether a group belongs under one of the four filters. */
export function matchesActivityFilter(status: ActivityStatus, filter: ActivityFilter): boolean {
  switch (filter) {
    case 'all': return true
    case 'attention': return status === 'review' || status === 'answer' || status === 'delivery' || status === 'blocked'
      || status === 'failed'
    case 'running': return status === 'queued' || status === 'working' || status === 'idle'
    case 'failed': return status === 'failed'
  }
}

/** One task's events, newest first, with the newest record's facts in the header. */
export interface ActivityGroup {
  key: string
  title: string
  status: ActivityStatus
  parent?: ActivitySubject
  items: ActivityRecord[]
}

/** Fold the feed into one newest-first group per task; events with no task stand together as the system group. */
export function groupActivity(items: readonly ActivityRecord[]): ActivityGroup[] {
  const groups = new Map<string, ActivityGroup>()
  for (const item of items) {
    const key = item.task?.id ?? (item.thread ? `thread:${item.thread}` : 'system')
    const existing = groups.get(key)
    if (existing) { existing.items.push(item); continue }
    const task: ActivityTask | undefined = item.task
    groups.set(key, { key, title: task?.title ?? '', status: groupStatus(item), ...task?.parent ? { parent: task.parent } : {},
      items: [item] })
  }
  return [...groups.values()]
}

function Time({ at, t }: { at: string | undefined; t: T }) {
  return <time dateTime={at} title={fullTime(at, t('lang'))}>{when(at, t('lang'))}</time>
}
/** The right-aligned New Session action: it focuses the existing main Session instead of creating a second router Session. */
export function MasterEntry({ t, master, onOpen }: { t: T; master: MasterStore; onOpen: (id: string) => Promise<void> }) {
  const identity = useMaster(master)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const open = async () => {
    if (!identity.masterId || busy) return
    setBusy(true); setFailure(undefined)
    try { await onOpen(identity.masterId) } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const title = failure ?? identity.error ?? t('masterEntryHint')
  return <Button variant="outline" size="sm" disabled={!identity.masterId || busy} title={title}
    aria-label={t('masterSession')} onClick={() => { void open() }}>
    <Icon name="inbox" size={14} />{t('masterSession')}{failure && <span className="dt-master-attention" aria-hidden>!</span>}
  </Button>
}
/** A compact "主" marker on the Session row; the host rc.5 row has a leading seat, not a trailing one. */
export function MasterBadge({ t, master, sessionId }: { t: T; master: MasterStore; sessionId: string }) {
  const identity = useMaster(master)
  if (!identity.masterId || sessionId !== identity.masterId) return null
  return <span className="dt-master-badge" title={t('masterBadgeHint')} aria-label={t('masterSession')}>{t('masterBadge')}</span>
}
/** One feed record: a readable title, the object badge that opens it, its own state, and when and how far into the task it happened. */
export function ActivityLine({ record, t, onOpen }: { record: ActivityRecord; t: T; onOpen: (route: Route) => void }) {
  const target = activityTarget(record)
  const title = activityTitle(t, record)
  const subject = record.subject && (record.subject.kind !== 'ticket' || !record.task) ? record.subject : undefined
  const subjectTarget = subject ? activityTarget({ ...record, ticket: undefined, subject }) : undefined
  const status = record.status ?? record.task?.status
  const elapsed = duration(record.sinceStartMs, t('lang'))
  return <li className="dt-row dt-activity" data-level={record.level} data-status={status}>
    <div className="dt-row-main">
      <div className="dt-row-title">
        {target ? <button type="button" className="dt-open" onClick={() => onOpen(target)}>{title}</button> : title}
        {subject && <button type="button" className="dt-events-subject" title={activitySubjectText(t, subject)}
          onClick={() => subjectTarget && onOpen(subjectTarget)}>{activitySubjectText(t, subject)}</button>}
      </div>
      <div className="dt-row-meta">
        {status && <Tag tone={STATUS_TONE[status]}><span className="dt-events-status-icon"><Icon name={STATUS_ICON[status]}
          size={12} /></span>{statusLabel(t, status)}</Tag>}
        {record.level !== 'feed' && <Tag tone={LEVEL_TONE[record.level]}>{t(`activityLevel.${record.level}`)}</Tag>}
        {record.suppressed && <Tag tone="outline">{t(`activitySuppressed.${record.suppressed}`)}</Tag>}
        {elapsed && <span className="dt-quiet">{t('eventsAfterStart', { duration: elapsed })}</span>}
        <Time at={record.at} t={t} />
      </div>
    </div>
  </li>
}
/** One task: its title, state and origin, folded open to the event lines. */
function ActivityGroupView({ group, t, open, onToggle, onOpen, onLocate }: { group: ActivityGroup; t: T; open: boolean
  onToggle: () => void; onOpen: (route: Route) => void; onLocate?: () => void }) {
  const latest = group.items[0]!
  return <li className="dt-events-group" data-status={group.status}>
    <div className="dt-events-group-head">
      <button type="button" className="dt-events-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="dt-events-chevron"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /></span>
        <span className="dt-events-group-title">{group.title || t('eventsSystem')}</span>
      </button>
      {onLocate && <Button className="dt-events-locate" size="sm" variant="ghost" aria-label={t('eventsLocateTask')}
        title={t('eventsLocateTask')} icon={<Icon name="review" size={13} />} onClick={onLocate} />}
      <Tag tone={STATUS_TONE[group.status]}><span className="dt-events-status-icon"><Icon name={STATUS_ICON[group.status]}
        size={12} /></span>{statusLabel(t, group.status)}</Tag>
    </div>
    <div className="dt-events-group-meta">
      {group.parent && <span className="dt-events-parent">{t('activityFrom', { name: activitySubjectText(t, group.parent) })}</span>}
      <span>{t('eventsCount', { count: group.items.length })}</span>
      <Time at={latest.at} t={t} />
    </div>
    {open ? <ul className="dt-events-rows">{group.items.map(item => <ActivityLine key={item.seq} record={item} t={t}
      onOpen={onOpen} />)}</ul> : <p className="dt-events-latest">{t('eventsLatest', { title: activityTitle(t, latest) })}</p>}
  </li>
}
/** The folded feed: groups in newest-first order, each expandable to its event lines. */
function ActivityGroups({ groups, t, onOpen, empty, onLocate, locatable }: { groups: readonly ActivityGroup[]; t: T; onOpen: (route: Route) => void
  empty: string; onLocate?: (key: string) => void; locatable?: (key: string) => boolean }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) => setOpen(previous => {
    const next = new Set(previous)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })
  if (!groups.length) return <p className="dt-hint">{empty}</p>
  return <ul className="dt-list dt-events-groups">{groups.map(group => <ActivityGroupView key={group.key} group={group}
    t={t} open={open.has(group.key)} onToggle={() => toggle(group.key)} onOpen={onOpen}
    onLocate={onLocate && locatable?.(group.key) ? () => onLocate(group.key) : undefined} />)}</ul>
}
/** The feed as task groups, folded by default so the newest event of each task stays visible without its whole history. */
export function ActivityList({ items, t, onOpen, empty, onLocate, locatable }: { items: readonly ActivityRecord[]; t: T; onOpen: (route: Route) => void
  empty: string; onLocate?: (key: string) => void; locatable?: (key: string) => boolean }) {
  return <ActivityGroups groups={groupActivity(items)} t={t} onOpen={onOpen} empty={empty} onLocate={onLocate} locatable={locatable} />
}
function FeedHint({ snapshot, t }: { snapshot: ActivitySnapshot; t: T }) {
  const mode = snapshot.mode === 'streaming' ? t('eventsLive') : snapshot.mode === 'polling' ? t('eventsPolling') : t('eventsConnecting')
  return <p className={snapshot.error ? 'dt-hint dt-error-text' : 'dt-hint'}>{snapshot.error ?? mode}</p>
}
/** The right pane body; opening it marks the head seen, so its tab title clears. */
export function EventsTab({ t, activity, master, tasks, onOpen, onOpenTasks }: { t: T; activity: ActivityFeedClient; master: MasterStore
  tasks?: TasksViewClient; onOpen: (route: Route) => void; onOpenTasks?: () => void }) {
  const snapshot = useActivityFeed(activity)
  const identity = useMaster(master)
  const selection = useTaskSelection(tasks)
  const [filter, setFilter] = useState<ActivityFilter>('all')
  useEffect(() => { activity.markSeen() }, [activity])
  const current = identity.masterId === undefined || identity.masterId === ''
    ? undefined : identity.masterId
  const groups = groupActivity(snapshot.items)
  // A selected review row narrows to the Ticket it reviews, whose events own the group.
  const selectedTask = selection && tasks ? tasks.taskOf(selection.id) : undefined
  // The Events chip names the Ticket whose events are shown, not the review row that selected it.
  const selectedEventTask = selectedTask?.kind === 'review' && selectedTask.reviewedTicketId
    ? tasks?.taskOf(selectedTask.reviewedTicketId) : selectedTask
  const scoped = selection && tasks ? groups.filter(group => group.key === tasks.eventTaskId(selection.id)) : groups
  const shown = scoped.filter(group => matchesActivityFilter(group.status, filter))
  const locate = tasks ? (key: string) => { const task = tasks.taskOf(key); if (!task) return
    tasks.select({ kind: 'ticket', id: task.id }); onOpenTasks?.() } : undefined
  return <div className="dt-events-tab">
    <div className="dt-events-head">
      <h2 className="dt-events-title">{t('eventsTab')}</h2>
      <FeedHint snapshot={snapshot} t={t} />
    </div>
    {current === undefined && <p className="dt-hint">{t('eventsWaitingMaster')}</p>}
    {selection && tasks && <div className="dt-events-selection">
      <span className="dt-events-selection-title">{t('eventsTaskFilter', { title: selectedEventTask?.title ?? tasks.titleOf(selection.id) ?? selection.id })}</span>
      <Button size="sm" variant="ghost" aria-label={t('eventsClearTask')} title={t('eventsClearTask')} icon={<Icon name="close" size={13} />}
        onClick={() => tasks.select(undefined)} />
    </div>}
    <div className="dt-events-filters" role="group" aria-label={t('eventsTab')}>
      {FILTERS.map(value => <Pill key={value} active={filter === value} onClick={() => setFilter(value)}>{t(`activityFilter.${value}`)}</Pill>)}
    </div>
    <ActivityGroups groups={shown} t={t} onOpen={onOpen} onLocate={locate} locatable={tasks ? key => !!tasks.taskOf(key) : undefined}
      empty={selection ? t('eventsTaskEmpty') : snapshot.items.length ? t('eventsFilterEmpty') : t('eventsEmpty')} />
  </div>
}
/** The tab chip; unread notice-level events after the persisted cursor are counted here. */
export function EventsTitle({ t, activity }: { t: T; activity: ActivityFeedClient }) {
  const snapshot = useActivityFeed(activity)
  return <span className="dt-events-chip">{t('eventsTab')}{snapshot.unread > 0 && <span className="dt-events-unread"
    aria-label={t('eventsUnread', { count: snapshot.unread })}>{snapshot.unread > 99 ? '99+' : snapshot.unread}</span>}</span>
}
/**
 * An invisible per-Session companion: it keeps the feed connected while the main Session is on screen and opens the Events
 * tab the first time an unread notice-level record exists, then leaves every later choice to the person.
 */
export function EventsBridge({ activity, master, autoOpen, open }: { activity: ActivityFeedClient; master: MasterStore
  autoOpen: { done: boolean }; open: () => void }) {
  const snapshot = useActivityFeed(activity)
  const identity = useMaster(master)
  const sessionId = identity.masterId
  useEffect(() => {
    // The stable phase never opens Events by itself: the trust-phase exception is a Settings › Display preference
    // (default off), and the `events.autoOpen.v1` switch can disable it for a whole deployment.
    if (autoOpen.done || snapshot.unread === 0 || sessionId === undefined || !eventsAutoOpen()) return
    autoOpen.done = true
    open()
  }, [autoOpen, open, sessionId, snapshot.unread])
  return null
}
/**
 * The "状态" Conversation view: on the main Session it mounts the existing management page rather than a second, partial
 * management page; every other Session sees a short explanation of where the management page lives.
 */
export function SystemView({ t, sessionId, master, children }: { t: T; sessionId: string; master: MasterStore
  children: ReactNode }) {
  const identity = useMaster(master)
  // Do not mount the management page for an ordinary Session while `masterId` is still unknown.
  if (identity.masterId === undefined) return <div className="dt-system-view"><p className="dt-hint">{identity.error ?? t('loading')}</p></div>
  if (identity.masterId !== sessionId) return <div className="dt-system-view"><p className="dt-hint">{t('systemOnlyMaster')}</p></div>
  return <div className="dt-status-page">{children}</div>
}

/** Lend this Session's View selector to panel actions while its Status View is mounted. */
export function SystemViewSeat({ sessionId, openView, children }: { sessionId: string
  openView?: (view: string, focus: string) => void; children: ReactNode }) {
  useEffect(() => openView ? registerConversationView(sessionId, openView) : undefined, [sessionId, openView])
  return <>{children}</>
}
