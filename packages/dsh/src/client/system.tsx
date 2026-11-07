/**
 * Main-Session surfaces: the New Session entry that opens the existing main Session, the "主" row marker, the "状态"
 * Conversation view that reuses the management page, and the right Events tab with its unread title, automatic first open
 * and rows. All data comes from the management API the panel already uses.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { ActivityRecord } from '../app/activity.ts'
import type { ActivityFeedClient, ActivitySnapshot } from './activity-feed.ts'
import { useActivityFeed } from './activity-feed.ts'
import { Button, Icon, Tag } from './controls.tsx'
import type { MasterStore } from './master.ts'
import { useMaster } from './master.ts'
import type { Route } from './route.ts'
import { when, fullTime, type T } from './text.ts'

const LEVEL_TONE = { quiet: 'outline', feed: 'info', notice: 'warning' } as const
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
/**
 * The "状态" Conversation view: on the main Session it mounts the existing management page rather than a second, partial
 * management page; every other Session sees a short explanation of where the management page lives.
 */
export function SystemView({ t, sessionId, master, children }: { t: T; sessionId: string; master: MasterStore
  children: ReactNode }) {
  const identity = useMaster(master)
  // Do not mount the management page for an ordinary Session while `masterId` is still unknown.
  if (identity.masterId === undefined) return <div className="dt-system-view"><p className="dt-hint">{t('loading')}</p></div>
  if (identity.masterId !== sessionId) return <div className="dt-system-view"><p className="dt-hint">{t('systemOnlyMaster')}</p></div>
  return <div className="dt-status-page">{children}</div>
}
