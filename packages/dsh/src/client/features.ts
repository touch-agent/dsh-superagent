/**
 * Client-side feature switches. These change only which read-only surface the panel renders; they grant nothing and are
 * read on every render, so an operator can roll back by setting the key to `off` and refreshing the page.
 */
export const TASK_VIEW_V1 = 'taskView.v1'
/** T3-12's read-only Spaces surfaces; off hides the Space block and the Execution Spaces list, never the E2 path. */
export const WORKSPACE_VIEW = 'workspace.view'
/** X-09's three-zone entry page; off restores the pre-X-09 Overview without hiding any tab or record. */
export const ENTRY_THREE_ZONES = 'entry.threeZones.v1'
/**
 * The Events tab's trust-phase exception: enabled by a person in Settings › Display, and off in the stable phase.
 * This switch is the deployment rollback: off forces no automatic opening regardless of the stored preference.
 */
export const EVENTS_AUTO_OPEN = 'events.autoOpen.v1'
/** UX batch 1's task-hierarchy detail; off keeps the compact selected-row goal block from T5-02. */
export const TASK_HIERARCHY = 'ux.taskHierarchy.v1'
/** UX batch 1's notification drawer and header bell; off leaves the Events tab as the only notice surface. */
export const NOTIFY_DRAWER = 'ux.notifyDrawer.v1'
/** UX batch 1's floating notice cards; off stops the interruption while the drawer keeps every notice. */
export const NOTIFY_OVERLAY = 'ux.notifyOverlay.v1'
/** UX batch 1's one-row problem aggregate; off restores one row per system problem. */
export const ERROR_AGGREGATE = 'ux.errorAggregate.v1'
/** The person's per-browser preference, like the unread cursor: absent means the stable-phase default, off. */
const AUTO_OPEN_PREF = 'dsh-superagent/events-auto-open'
/** Whether a floating card closes itself after the hold window; a browser preference, not policy. */
const NOTIFY_AUTO_DISMISS_PREF = 'dsh-superagent/notify-auto-dismiss'
/** Read notice ids, capped; a browser preference so a reload does not re-announce everything. */
const NOTIFY_READ_PREF = 'dsh-superagent/notify-read'

/** Whether a switch is on; absent or unreadable storage means the default (on). */
export function featureEnabled(name: string): boolean {
  try { return globalThis.localStorage?.getItem(name) !== 'off' } catch { return true }
}
/** Flip one deployment switch from the Display page; `on` removes the opt-out key so the default wins again. */
export function setFeature(name: string, on: boolean): void {
  try {
    if (on) globalThis.localStorage?.removeItem(name); else globalThis.localStorage?.setItem(name, 'off')
  } catch { /* a blocked storage is not a failure */ }
}

/** Whether the Events tab may open by itself once for the first unread notice. */
export const eventsAutoOpen = (): boolean => {
  try { return featureEnabled(EVENTS_AUTO_OPEN) && globalThis.localStorage?.getItem(AUTO_OPEN_PREF) === 'on' } catch { return false }
}

/** The stored display preference alone; the Settings page shows this even while the deployment switch is off. */
export const autoOpenPreference = (): boolean => {
  try { return globalThis.localStorage?.getItem(AUTO_OPEN_PREF) === 'on' } catch { return false }
}

/** Persist the display preference; a blocked storage keeps the stable-phase default. */
export const setAutoOpenPreference = (on: boolean): void => {
  try { globalThis.localStorage?.setItem(AUTO_OPEN_PREF, on ? 'on' : 'off') } catch { /* a blocked storage is not a failure */ }
}

/** T3-09's compact task list; off falls back to the plan tree and removes the right Task tab. */
export const taskViewV1 = (): boolean => featureEnabled(TASK_VIEW_V1)

/** T3-12's read-only space surfaces; off shows the ticket without its Space block, whose path lives only on E2. */
export const workspaceView = (): boolean => featureEnabled(WORKSPACE_VIEW)

/** X-09's three-zone entry page; off restores the pre-X-09 Overview and removes the sidebar attention dot. */
export const entryThreeZones = (): boolean => featureEnabled(ENTRY_THREE_ZONES)

/** UX batch 1: the task hierarchy detail, drawer, floating cards and one-row error aggregate, each independently closable. */
export const taskHierarchy = (): boolean => featureEnabled(TASK_HIERARCHY)
export const notifyDrawer = (): boolean => featureEnabled(NOTIFY_DRAWER)
export const notifyOverlay = (): boolean => featureEnabled(NOTIFY_OVERLAY)
export const errorAggregate = (): boolean => featureEnabled(ERROR_AGGREGATE)

/** Whether a floating card auto-closes; on by default, and off keeps it until a person closes it. */
export const notifyAutoDismiss = (): boolean => {
  try { return globalThis.localStorage?.getItem(NOTIFY_AUTO_DISMISS_PREF) !== 'off' } catch { return true }
}
export const setNotifyAutoDismiss = (on: boolean): void => {
  try { globalThis.localStorage?.setItem(NOTIFY_AUTO_DISMISS_PREF, on ? 'on' : 'off') } catch { /* a blocked storage is not a failure */ }
}

/** The notice ids this browser already read; an unreadable value reads as none so notices are never silently hidden. */
export const readNotices = (): ReadonlySet<string> => {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(NOTIFY_READ_PREF) ?? '[]') as unknown
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch { return new Set() }
}
/** Whether this browser has a read cursor at all, so the first load can seed old results without toasting them. */
export const hasReadCursor = (): boolean => {
  try { return globalThis.localStorage?.getItem(NOTIFY_READ_PREF) !== null } catch { return false }
}
/** Persist read ids, newest last, capped so the browser preference cannot grow without bound. */
export const rememberRead = (ids: Iterable<string>): void => {
  try {
    const next = [...new Set(ids)].slice(-500)
    globalThis.localStorage?.setItem(NOTIFY_READ_PREF, JSON.stringify(next))
  } catch { /* a blocked storage is not a failure */ }
}