/**
 * Main-Session surfaces: the New Session entry that opens the existing main Session, the "主" row marker, the read-only
 * System view inside the Conversation, and the right Events tab with its unread title, automatic first open and rows.
 * All data is read from the management API; nothing here mutates a Ticket.
 */
import { useEffect, useState } from 'react'
import type { ActivityRecord } from '../app/activity.ts'
import type { Call, TicketRow } from './api.ts'
import { usePoll } from './api.ts'
import type { ActivityFeedClient, ActivitySnapshot } from './activity-feed.ts'
import { useActivityFeed } from './activity-feed.ts'
import { Button, Icon, Tag, StateDot, type DotState } from './controls.tsx'
import type { MasterStore } from './master.ts'
import { useMaster } from './master.ts'
import { ticketMark } from './marks.ts'
import type { Route } from './route.ts'
import { healthText, valueLabel, when, fullTime, type T } from './text.ts'
import { StageMark, Section } from './widgets.tsx'

const LEVEL_TONE = { quiet: 'outline', feed: 'info', notice: 'warning' } as const
const HEALTH_DOT: Record<string, DotState> = { ready: 'done', starting: 'ongoing', paused: 'warning', error: 'error' }
const openTicket = (id: string): Route => ({ page: 'execution', id })
const openThread = (id: string): Route => ({ page: 'trigger', id })

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
/** One feed record; a Ticket or Thread identity is a button that opens its management page. */
export function ActivityLine({ record, t, onOpen }: { record: ActivityRecord; t: T; onOpen: (route: Route) => void }) {
  const target = record.ticket ? openTicket(record.ticket) : record.thread ? openThread(record.thread) : undefined
  return <li className="dt-row dt-activity" data-level={record.level}>
    <div className="dt-row-main">
      <div className="dt-row-title">
        {target ? <button type="button" className="dt-open" onClick={() => onOpen(target)}>{record.summary}</button> : record.summary}
      </div>
      <div className="dt-row-meta">
        <Tag tone={LEVEL_TONE[record.level]}>{t(`activityLevel.${record.level}`)}</Tag>
        {record.suppressed && <Tag tone="outline">{t(`activitySuppressed.${record.suppressed}`)}</Tag>}
        {record.ticket && <span className="dt-mono dt-quiet">{record.ticket}</span>}
        <Time at={record.at} t={t} />
      </div>
    </div>
  </li>
}
export function ActivityList({ items, t, onOpen, empty }: { items: readonly ActivityRecord[]; t: T; onOpen: (route: Route) => void
  empty: string }) {
  if (!items.length) return <p className="dt-hint">{empty}</p>
  return <ul className="dt-list dt-activity-list">{items.map(item => <ActivityLine key={item.seq} record={item} t={t}
    onOpen={onOpen} />)}</ul>
}
function FeedHint({ snapshot, t }: { snapshot: ActivitySnapshot; t: T }) {
  const mode = snapshot.mode === 'streaming' ? t('eventsLive') : snapshot.mode === 'polling' ? t('eventsPolling') : t('eventsConnecting')
  return <p className={snapshot.error ? 'dt-hint dt-error-text' : 'dt-hint'}>{snapshot.error ?? mode}</p>
}
/** The right pane body; opening it marks the head seen, so its tab title clears. */
export function EventsTab({ t, activity, master, onOpen }: { t: T; activity: ActivityFeedClient; master: MasterStore
  onOpen: (route: Route) => void }) {
  const snapshot = useActivityFeed(activity)
  const identity = useMaster(master)
  useEffect(() => { activity.markSeen() }, [activity])
  const current = identity.masterId === undefined || identity.masterId === ''
    ? undefined : identity.masterId
  return <div className="dt-events-tab">
    <div className="dt-events-head">
      <h2 className="dt-events-title">{t('eventsTab')}</h2>
      <FeedHint snapshot={snapshot} t={t} />
    </div>
    {current === undefined && <p className="dt-hint">{t('eventsWaitingMaster')}</p>}
    <ActivityList items={snapshot.items} t={t} onOpen={onOpen} empty={t('eventsEmpty')} />
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
    if (autoOpen.done || snapshot.unread === 0 || sessionId === undefined) return
    autoOpen.done = true
    open()
  }, [autoOpen, open, sessionId, snapshot.unread])
  return null
}
function HealthLine({ name, state, detail, t }: { name: string; state: string; detail: string; t: T }) {
  return <li className="dt-row dt-health" data-state={state}>
    <StateDot state={HEALTH_DOT[state] ?? 'idle'} />
    <span className="dt-health-name">{valueLabel(t, 'health', name)}</span>
    <span className="dt-health-detail">{detail}</span>
  </li>
}
function SystemTicket({ ticket, t, onOpen }: { ticket: TicketRow; t: T; onOpen: (route: Route) => void }) {
  const status = ticketMark(t, ticket)
  return <li className="dt-row dt-link dt-ticket dt-system-ticket" data-state={status.dot}>
    <div className="dt-ticket-stage"><StageMark state={status.dot} icon={status.icon} label={status.label} /></div>
    <div className="dt-ticket-body">
      <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => onOpen(openTicket(ticket.id))}>
        {ticket.title}</button></div>
      <div className="dt-row-meta"><Time at={ticket.updatedAt} t={t} /></div>
    </div>
  </li>
}
/**
 * The "体系" Conversation view. It is read-only and only meaningful on the main Session: every other Session sees a short
 * explanation of where the System view lives. Data comes from the same `GET state`, `GET tickets` and `GET activity`
 * endpoints the management panel uses, so no second business rule lives here.
 */
export function SystemView({ t, call, sessionId, master, activity, onOpen }: { t: T; call: Call; sessionId: string
  master: MasterStore; activity: ActivityFeedClient; onOpen: (route: Route) => void }) {
  const identity = useMaster(master)
  const state = usePoll(() => call('GET state'), [call], 5_000)
  const tickets = usePoll(() => call('GET tickets', { query: { state: 'open', limit: 20 } }), [call], 5_000)
  const feed = useActivityFeed(activity)
  if (identity.masterId !== undefined && identity.masterId !== '' && identity.masterId !== sessionId) {
    return <div className="dt-system-view"><p className="dt-hint">{t('systemOnlyMaster')}</p></div>
  }
  const health = Object.entries(state.data?.health ?? {}).sort(([left], [right]) => left.localeCompare(right))
  const load = state.data?.load
  return <div className="dt-system-view">
    <header className="dt-system-head">
      <div>
        <h2 className="dt-system-title">{t('systemTitle')}</h2>
        <p className="dt-hint">{t('systemIntro')}</p>
      </div>
      <Button variant="outline" size="sm" icon={<Icon name="external" size={14} />} onClick={() => onOpen({ page: 'overview' })}>
        {t('systemOpenPanel')}</Button>
    </header>
    {state.error && <p className="dt-error" role="alert">{state.error.message}</p>}
    <Section title={t('systemHealth')}>
      {load && <div className="dt-stats">
        <span className="dt-stat"><b>{load.running}</b>{t('executingLabel')}</span>
        <span className="dt-stat"><b>{load.queued}</b>{t('queuedLabel')}</span>
        <span className="dt-stat"><b>{load.maxWorkers}</b>{t('systemWorkers')}</span>
        <span className="dt-stat"><b>{state.data?.paused ? t('yes') : t('no')}</b>{t('systemPaused')}</span>
      </div>}
      {health.length ? <ul className="dt-list dt-health-list">{health.map(([name, item]) => <HealthLine key={name} name={name}
        state={item.state} detail={healthText(t, item)} t={t} />)}</ul> : <p className="dt-hint">{t('loading')}</p>}
    </Section>
    <Section title={t('systemTickets')} count={tickets.data?.items.length} action={<Button variant="ghost" size="sm"
      onClick={() => onOpen({ page: 'execution' })}>{t('systemAllTickets')}</Button>}>
      {tickets.data?.items.length ? <ul className="dt-list dt-system-tickets">{tickets.data.items.map(ticket => <SystemTicket
        key={ticket.id} ticket={ticket} t={t} onOpen={onOpen} />)}</ul> : <p className="dt-hint">{tickets.error?.message
        ?? (tickets.data ? t('systemNoTickets') : t('loading'))}</p>}
    </Section>
    <Section title={t('systemEvents')} action={<Button variant="ghost" size="sm" onClick={() => onOpen({ page: 'overview' })}>
      {t('systemMoreEvents')}</Button>}>
      <FeedHint snapshot={feed} t={t} />
      <ActivityList items={feed.items.slice(0, 8)} t={t} onOpen={onOpen} empty={t('eventsEmpty')} />
    </Section>
  </div>
}