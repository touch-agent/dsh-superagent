/**
 * UX batch 1's notification layer: a header bell with an unread count, a right-side drawer that keeps every notice, and
 * up to three floating cards for the items that actually need a person. It is a view of the existing overview answer,
 * so it creates no notification record and removes nothing: an item disappears when its Approval, Ticket or problem
 * does. The drawer and the cards have separate switches, and the browser's read cursor and auto-close preference are
 * local, like the Events auto-open preference.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { OverviewView } from './api.ts'
import { Button, Icon, Pill } from './controls.tsx'
import type { IconName } from './controls.tsx'
import { ConfirmButton } from './widgets.tsx'
import { usePanel } from './provider.tsx'
import { noticeItems, unreadOf, type Notice, type NoticeAction } from './notifications.ts'
import { errorText, localized, when, type T } from './text.ts'
import { hasReadCursor, notifyAutoDismiss, notifyDrawer, notifyOverlay, readNotices, rememberRead } from './features.ts'

const CARD_SECONDS = 8
const CARD_LIMIT = 3
const GROUPS = ['attention', 'progress', 'system'] as const
type Group = typeof GROUPS[number]

interface NoticeCenter {
  items: readonly Notice[]
  unread: number
  open: boolean
  openDrawer: () => void
  closeDrawer: () => void
  markAllRead: () => void
  onAction: (notice: Notice, action: NoticeAction) => Promise<void>
  busy: boolean
}
const Center = createContext<NoticeCenter | undefined>(undefined)
/** The header bell and any page may open the drawer; undefined when this deployment switched the drawer off. */
export const useNoticeCenter = (): NoticeCenter | undefined => useContext(Center)

const kindLabel = (t: T, kind: Notice['kind']): string => t(`noticeGroup.${kind}`)
const kindTone = (kind: Notice['kind']): 'warning' | 'info' | 'danger' => kind === 'attention' ? 'warning'
  : kind === 'progress' ? 'info' : 'danger'
const actionIcon = (key: NoticeAction['key']): IconName => {
  switch (key) {
    case 'approve': return 'decision'
    case 'deny': return 'dismiss'
    case 'retry': return 'refresh'
    case 'disable-source': return 'pause'
    case 'requeue': return 'queue'
    case 'dismiss': return 'dismiss'
    case 'view': case 'route': case 'open-source': return 'external'
  }
}

function NoticeActions({ notice, onAction, busy, compact = false }: { notice: Notice; onAction: (notice: Notice, action: NoticeAction) => Promise<void>
  busy: boolean; compact?: boolean }) {
  const { t } = usePanel()
  const actions = compact ? notice.actions.slice(0, 2) : notice.actions
  return <div className="dt-notice-actions">
    {actions.map(action => action.key === 'deny'
      ? <ConfirmButton key={action.key} variant="outline" icon="dismiss" label={action.label} title={t('denyConfirmTitle')}
        message={t('denyConfirm')} ariaLabel={`${action.label} · ${notice.title}`} onConfirm={() => onAction(notice, action)} />
      : action.key === 'disable-source'
        ? <ConfirmButton key={action.key} variant="outline" icon="pause" label={action.label} title={t('noticeDisableSourceTitle')}
          message={t('noticeDisableSourceConfirm')} ariaLabel={`${action.label} · ${notice.title}`}
          onConfirm={() => onAction(notice, action)} />
        : <Button key={action.key} variant={action.tone === 'primary' ? 'primary' : 'outline'} size="sm"
          icon={<Icon name={actionIcon(action.key)} size={14} />} disabled={busy} onClick={() => { void onAction(notice, action) }}>
          {action.label}</Button>)}
  </div>
}

function NoticeBody({ notice, compact = false }: { notice: Notice; compact?: boolean }) {
  const { t } = usePanel()
  const [details, setDetails] = useState(false)
  return <>
    <div className="dt-notice-head">
      <span className="dt-tag" data-tone={kindTone(notice.kind)}>{kindLabel(t, notice.kind)}</span>
      <span className="dt-notice-time">{when(notice.at, t('lang'))}</span>
      {notice.kind === 'system' && notice.attempts !== undefined
        && <span className="dt-hint">{t('noticeAttempts', { count: notice.attempts })}</span>}
    </div>
    <h3 className="dt-notice-title">{notice.title}</h3>
    <p className="dt-notice-what">{notice.what}</p>
    <p className="dt-notice-next"><strong>{t('taskHierarchyNext')}</strong> {notice.next}</p>
    <p className="dt-notice-consequence">{notice.consequence}</p>
    {!!notice.details?.length && <div className="dt-notice-details">
      <button type="button" className="dt-textlink dt-more-link" aria-expanded={details} onClick={() => setDetails(value => !value)}>
        {details ? t('noticeDetailsHide') : t('noticeDetails', { count: notice.details.length })}</button>
      {details && <ul>{notice.details.map((line, index) => <li key={index}>{line}</li>)}</ul>}
    </div>}
  </>
}

function ToastCard({ notice, onDone, onAction, onOpenDrawer, busy }: { notice: Notice; onDone: () => void
  onAction: (notice: Notice, action: NoticeAction) => Promise<void>; onOpenDrawer?: () => void; busy: boolean }) {
  const { t } = usePanel()
  const [paused, setPaused] = useState(false)
  const done = useRef(onDone)
  done.current = onDone
  // The five-second overview poll re-renders the host; keep one eight-second timer per card instead of restarting it.
  useEffect(() => {
    if (!notifyAutoDismiss() || paused) return
    const timer = setTimeout(() => done.current(), CARD_SECONDS * 1000)
    return () => clearTimeout(timer)
  }, [paused, notice.id])
  return <article className="dt-notice-card" role="group" aria-label={notice.title} onMouseEnter={() => setPaused(true)}
    onMouseLeave={() => setPaused(false)}>
    <div className="dt-notice-card-bar" data-kind={notice.kind} />
    <div className="dt-notice-card-body">
      <button type="button" className="dt-notice-close" aria-label={t('close')} title={t('close')} onClick={onDone}>
        <Icon name="close" size={14} /></button>
      <NoticeBody notice={notice} compact />
      <div className="dt-notice-card-foot">
        <NoticeActions notice={notice} onAction={onAction} busy={busy} compact />
        {onOpenDrawer && <button type="button" className="dt-textlink" onClick={onOpenDrawer}>{t('noticeViewAll')}</button>}
      </div>
    </div>
  </article>
}

function Drawer({ center }: { center: NoticeCenter }) {
  const { t } = usePanel()
  const [group, setGroup] = useState<'all' | Group>('all')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') center.closeDrawer() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [center])
  const items = group === 'all' ? center.items : center.items.filter(item => item.kind === group)
  return createPortal(<div className="dt-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) center.closeDrawer() }}>
    <aside className="dt-drawer" role="dialog" aria-modal="true" aria-labelledby="dt-drawer-title">
      <header className="dt-drawer-head">
        <div>
          <h2 id="dt-drawer-title">{t('notifications')}</h2>
          <p className="dt-hint">{t('notificationsHint')}</p>
        </div>
        <Button autoFocus variant="ghost" size="sm" icon={<Icon name="close" size={14} />} aria-label={t('close')}
          title={t('close')} onClick={center.closeDrawer} />
      </header>
      <div className="dt-drawer-tools">
        <div className="dt-pills" role="group" aria-label={t('notifications')}>
          <Pill active={group === 'all'} onClick={() => setGroup('all')}>{t('noticeGroup.all')}{center.unread ? ` · ${center.unread}` : ''}</Pill>
          {GROUPS.map(kind => <Pill key={kind} active={group === kind} onClick={() => setGroup(kind)}>
            {kindLabel(t, kind)} {center.items.filter(item => item.kind === kind).length}</Pill>)}
        </div>
        <Button variant="outline" size="sm" disabled={!center.unread} onClick={center.markAllRead}>{t('noticeMarkAllRead')}</Button>
      </div>
      <div className="dt-drawer-list">
        {items.length ? items.map(notice => <article key={notice.id} className="dt-notice-item" data-kind={notice.kind}>
          <NoticeBody notice={notice} />
          <NoticeActions notice={notice} onAction={center.onAction} busy={center.busy} />
        </article>) : <p className="dt-hint">{t('noticeEmpty')}</p>}
      </div>
      <footer className="dt-drawer-foot">{notifyAutoDismiss() ? t('noticeAutoDismiss', { seconds: CARD_SECONDS }) : t('noticeAutoDismissOff')}</footer>
    </aside>
  </div>, document.body)
}

export function NotificationHost({ children }: { children: ReactNode }) {
  const { t, call, navigate, notify } = usePanel()
  const [data, setData] = useState<OverviewView>()
  const [read, setRead] = useState<ReadonlySet<string>>(() => readNotices())
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cards, setCards] = useState<Notice[]>([])
  const queue = useRef<Notice[]>([])
  const seen = useRef<Set<string>>(new Set())
  const seeded = useRef(false)
  const overlay = useRef(notifyOverlay())
  const drawerOn = notifyDrawer()
  // With both switches off this component adds no poll and no surface at all.
  const active = drawerOn || overlay.current
  const readRef = useRef(read)
  readRef.current = read
  const load = useCallback(async () => {
    try { setData(await call('GET overview')) } catch { /* a transient poll failure keeps the last notices */ }
  }, [call])
  useEffect(() => { if (active) void load() }, [active, load])
  // A five-second cadence matches the rest of the panel; a hidden tab waits longer. Opening the drawer does not poll
  // separately, and a mutation reloads right away so an approved row does not linger.
  useEffect(() => {
    if (!active) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = true
    const run = () => {
      clearTimeout(timer)
      void load().finally(() => { if (running) timer = setTimeout(run, document.hidden ? 30_000 : 5000) })
    }
    timer = setTimeout(run, 5000)
    const shown = () => { if (!document.hidden) run() }
    document.addEventListener('visibilitychange', shown)
    return () => { running = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
  }, [active, load])
  const items = useMemo(() => data ? noticeItems(data, t) : [], [data, t])
  const unread = unreadOf(items, read)
  const pump = useCallback(() => {
    setCards(current => {
      if (current.length >= CARD_LIMIT) return current
      const next = [...current]
      while (next.length < CARD_LIMIT && queue.current.length) next.push(queue.current.shift()!)
      return next
    })
  }, [])
  useEffect(() => {
    if (!data) return
    if (!seeded.current) {
      seeded.current = true
      seen.current = new Set(items.map(item => item.id))
      // The first load in this browser marks old results read, so a fresh panel does not count finished work as unread;
      // pending approvals and problems stay unread on purpose.
      if (!hasReadCursor()) {
        const seededRead = new Set(items.filter(item => item.kind === 'progress').map(item => item.id))
        setRead(seededRead)
        rememberRead(seededRead)
      }
      return
    }
    const fresh = items.filter(item => item.pop && !seen.current.has(item.id))
    for (const item of items) seen.current.add(item.id)
    if (!fresh.length || !overlay.current) return
    queue.current.push(...fresh)
    pump()
  }, [data, items, pump])
  // A card is only a view of a notice: when its Approval, Ticket or problem leaves the overview, it leaves the stack too,
  // including anything still queued behind the three-card limit.
  useEffect(() => {
    const ids = new Set(items.map(item => item.id))
    queue.current = queue.current.filter(item => ids.has(item.id))
    setCards(current => {
      const next = current.filter(item => ids.has(item.id))
      return next.length === current.length ? current : next
    })
  }, [items])
  const markAllRead = useCallback(() => {
    const all = new Set([...readRef.current, ...items.map(item => item.id)])
    setRead(all)
    rememberRead(all)
  }, [items])
  const action = useCallback(async (notice: Notice, item: NoticeAction) => {
    if (busy) return
    if (item.key === 'view' || item.key === 'route' || item.key === 'open-source') {
      const route = item.route ?? (item.ticketId ? { page: 'execution' as const, id: item.ticketId }
        : item.sourceId ? { page: 'settings' as const, query: { group: 'source', source: item.sourceId } } : { page: 'overview' as const })
      navigate(route)
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      if (item.key === 'approve' && item.approvalId) await call('POST approvals/:id/approve', { id: item.approvalId, body: {} })
      else if (item.key === 'deny' && item.approvalId) await call('POST approvals/:id/deny', { id: item.approvalId })
      else if (item.key === 'retry' && item.ticketId) await call('POST tickets/:id/retry', { id: item.ticketId })
      else if (item.key === 'requeue' && item.triggerId) await call('POST triggers/:id/requeue', { id: item.triggerId })
      else if (item.key === 'dismiss' && item.decisionId) await call('POST decisions/:id/dismiss', { id: item.decisionId })
      else if (item.key === 'disable-source' && item.sourceId) {
        const settings = await call('GET settings')
        const source = settings.sources.find(candidate => candidate.id === item.sourceId)
        if (!source) throw new Error(t('noticeSourceGone'))
        await call('PUT settings/:block', { block: `source:${item.sourceId}`,
          body: { value: { ...source.value, enabled: false }, revision: source.revision } })
        const next = new Set([...readRef.current, notice.id])
        setRead(next)
        rememberRead(next)
      }
      await load()
    } catch (failure) { notify(errorText(failure)) } finally { setBusy(false) }
  }, [busy, call, load, navigate, notify, t])
  // The drawer and the floating cards are separate switches: turning the drawer off must keep the cards that the
  // overlay switch still allows, and turning both off returns the page untouched.
  if (!active) return <>{children}</>
  const center: NoticeCenter = { items, unread, open, openDrawer: () => setOpen(true), closeDrawer: () => setOpen(false),
    markAllRead, onAction: action, busy }
  const body = <>
    {children}
    {overlay.current && createPortal(<div className="dt-notice-stack">
      {cards.map(notice => <ToastCard key={notice.id} notice={notice} busy={busy} onAction={action}
        onDone={() => { setCards(current => current.filter(item => item.id !== notice.id)); setTimeout(pump, 0) }}
        {...drawerOn ? { onOpenDrawer: () => setOpen(true) } : {}} />)}
    </div>, document.body)}
    {drawerOn && open && <Drawer center={center} />}
  </>
  return drawerOn ? <Center.Provider value={center}>{body}</Center.Provider> : body
}