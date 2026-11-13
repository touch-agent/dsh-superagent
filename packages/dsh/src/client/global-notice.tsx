/**
 * The floating global notice entry. It lives in the host's `shell.overlay` seat, so it is present outside the plugin's
 * panel too, and it is the plugin's substitute for a host-level notification nav item (DSH rc.5 does not have one). It
 * shows the unread count and the latest summary while something needs a person, stays quiet otherwise, and opens the
 * panel's drawer; without a mounted panel it opens the Notifications page, which carries the same notices.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Call, OverviewView } from './api.ts'
import { noticeButton, readNotices } from './features.ts'
import { onNoticeDrawer, openNoticeDrawer, onNoticesRead } from './notice-open.ts'
import { noticeItems, unreadOf, type Notice } from './notifications.ts'
import type { T } from './text.ts'

/** The presentational pill both mounts share: the frame-wide shell entry and the panel's inline copy in tests/embedded. */
export function NoticeFab({ t, unread, latest, onOpen, covered = false }: { t: T; unread: number; latest?: Notice; onOpen: () => void
  covered?: boolean }) {
  const label = unread ? t('noticeFabOpen', { count: unread }) : t('noticeFabQuiet')
  return <button type="button" className="dt-notice-fab" data-unread={unread > 0 ? 'true' : undefined} data-covered={covered || undefined}
    aria-hidden={covered || undefined} aria-label={label} title={latest?.title ?? t('noticeFabQuietHint')} aria-haspopup="dialog"
    onClick={onOpen}>
    <span className="dt-notice-fab-icon" aria-hidden="true"><Bell /></span>
    <span className="dt-notice-fab-copy">
      <span className="dt-notice-fab-title">{unread ? t('noticeFabPending', { count: unread }) : t('noticeFabQuiet')}</span>
      {unread > 0 && <span className="dt-notice-fab-summary">{latest?.title ?? t('noticeEmpty')}</span>}
    </span>
    {unread > 0 && <span className="dt-notice-fab-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
  </button>
}

export function GlobalNoticeButton({ t, call, onOpenPanel }: { t: T; call: Call; onOpenPanel: () => void }) {
  const enabled = noticeButton()
  const [data, setData] = useState<OverviewView>()
  const [read, setRead] = useState<ReadonlySet<string>>(readNotices)
  // The shell entry hides while the drawer is open, so the two do not stack in the same corner.
  const [covered, setCovered] = useState(false)
  useEffect(() => onNoticeDrawer(setCovered), [])
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    if (!enabled) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try { const next = await call('GET overview'); if (mounted.current) setData(next) } catch { /* keep the last answer */ }
    }
    const run = () => { clearTimeout(timer); void load().finally(() => {
      if (mounted.current) timer = setTimeout(run, globalThis.document?.hidden ? 30_000 : 10_000) }) }
    run()
    const onVisible = () => { if (!globalThis.document?.hidden) run() }
    globalThis.document?.addEventListener('visibilitychange', onVisible)
    const offRead = onNoticesRead(() => setRead(readNotices()))
    return () => { mounted.current = false; clearTimeout(timer)
      globalThis.document?.removeEventListener('visibilitychange', onVisible); offRead() }
  }, [enabled, call])
  // The read cursor is browser state, not the overview answer; re-read it when the button regains focus too.
  const items = useMemo(() => data ? noticeItems(data, t) : [], [data, t])
  const unread = unreadOf(items, read)
  const latest = useMemo(() => [...items].filter(item => !read.has(item.id))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0], [items, read])
  if (!enabled) return null
  const open = () => {
    setRead(readNotices())
    if (openNoticeDrawer()) setCovered(true)
    else onOpenPanel()
  }
  return <NoticeFab t={t} unread={unread} latest={latest} onOpen={open} covered={covered} />
}

/** The bell glyph, local to this shell-level component so it carries no panel context. */
function Bell() {
  return <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0" /></svg>
}
