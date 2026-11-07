/** Select the management panel and ask it to show one route, from a Conversation view or the right Events tab. */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { remember, type Route } from './route.ts'

export const PANEL_ID = 'dsh-superagent' as MainPanelId
/** Dispatched on `window` after the route is remembered; a mounted panel navigates without remounting. */
export const PANEL_NAVIGATE = 'dsh-superagent:navigate'
/** Open one management route in the main panel, remembering it for a panel that mounts afterwards. */
export function openPanelRoute(ctx: Context, route: Route): void {
  remember({ route, stack: [] })
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(PANEL_NAVIGATE, { detail: route }))
  try { ctx.get('layout')?.selectPanel(PANEL_ID) } catch { /* a host without the layout service keeps the current panel */ }
}