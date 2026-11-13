/**
 * A tiny module-level handshake between the shell-level floating notice button and the panel's drawer. Both live in this
 * one client plugin, so the button can open the richer in-panel drawer instead of reimplementing every in-place action.
 * When no panel is mounted, the caller opens the Notifications page instead; nothing is queued or lost.
 */
const READ = 'dsh-superagent:notices-read'
let opener: (() => void) | undefined

/** Register the mounted drawer opener; the latest mount wins, and unmount restores no stale callback. */
export function registerNoticeOpener(open: () => void): () => void {
  opener = open
  return () => { if (opener === open) opener = undefined }
}

/** Open the drawer if a panel is mounted; false tells the caller to open the panel's Notifications page. */
export function openNoticeDrawer(): boolean {
  if (!opener) return false
  opener()
  return true
}

/** Tell the shell button that the read cursor changed, so its count does not wait for the next poll. */
export function announceNoticesRead(): void {
  if (typeof globalThis.dispatchEvent !== 'function' || typeof Event !== 'function') return
  globalThis.dispatchEvent(new Event(READ))
}

/** Subscribe to read-cursor changes; returns the unsubscribe the effect needs. */
export function onNoticesRead(listener: () => void): () => void {
  globalThis.addEventListener?.(READ, listener)
  return () => globalThis.removeEventListener?.(READ, listener)
}

/** The floating entry follows the drawer: hidden while the drawer covers its corner, visible again on close. */
const DRAWER_EVENT = 'dsh-superagent:notice-drawer'
export function announceNoticeDrawer(open: boolean): void {
  window.dispatchEvent(new CustomEvent(DRAWER_EVENT, { detail: open }))
}
export function onNoticeDrawer(listener: (open: boolean) => void): () => void {
  const handle = (event: Event) => { listener(Boolean((event as CustomEvent<unknown>).detail)) }
  window.addEventListener(DRAWER_EVENT, handle)
  return () => window.removeEventListener(DRAWER_EVENT, handle)
}
