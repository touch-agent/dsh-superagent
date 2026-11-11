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
/** The person's per-browser preference, like the unread cursor: absent means the stable-phase default, off. */
const AUTO_OPEN_PREF = 'dsh-superagent/events-auto-open'

/** Whether a switch is on; absent or unreadable storage means the default (on). */
export function featureEnabled(name: string): boolean {
  try { return globalThis.localStorage?.getItem(name) !== 'off' } catch { return true }
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