/**
 * Client-side feature switches. These change only which read-only surface the panel renders; they grant nothing and are
 * read on every render, so an operator can roll back by setting the key to `off` and refreshing the page.
 */
export const TASK_VIEW_V1 = 'taskView.v1'
/** T3-12's read-only Spaces surfaces; off keeps the legacy identifiers block and hides the Execution Spaces list. */
export const WORKSPACE_VIEW = 'workspace.view'

/** Whether a switch is on; absent or unreadable storage means the default (on). */
export function featureEnabled(name: string): boolean {
  try { return globalThis.localStorage?.getItem(name) !== 'off' } catch { return true }
}

/** T3-09's compact task list; off falls back to the plan tree and removes the right Task tab. */
export const taskViewV1 = (): boolean => featureEnabled(TASK_VIEW_V1)

/** T3-12's read-only space surfaces; off shows the legacy directory in identifiers instead. */
export const workspaceView = (): boolean => featureEnabled(WORKSPACE_VIEW)