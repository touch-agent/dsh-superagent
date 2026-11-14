/** Select the management panel and ask it to show one route, from a Conversation view or a header action. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { remember, type Route } from './route.ts'

export const PANEL_ID = 'dsh-superagent' as MainPanelId
/** Dispatched on `window` after the route is remembered; a mounted panel navigates without remounting. */
export const PANEL_NAVIGATE = 'dsh-superagent:navigate'
/**
 * Whether the next main-panel mount is the plugin home (the main Conversation) or one auxiliary page. Header actions
 * open a page; selecting the Superagent row from the host sidebar opens home again after the panel has unmounted.
 */
let home = true
/** Mark the next panel mount as home; the panel clears it when it unmounts or when a page opens. */
export function requestPanelHome(): void { home = true }
/** Mark the next panel mount as an auxiliary page; called by every route opener. */
export function markPanelPage(): void { home = false }
export function panelWantsHome(): boolean { return home }
/** Open one management route in the main panel, remembering it for a panel that mounts afterwards. */
export function openPanelRoute(ctx: Context, route: Route): void {
  markPanelPage()
  remember({ route, stack: [] })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PANEL_NAVIGATE, { detail: route }))
  try { ctx.get('layout')?.selectPanel(PANEL_ID) } catch { /* a host without the layout service keeps the current panel */ }
}