/** The four auxiliary destinations the main Conversation's header exposes in the host right sidebar. */
import { settingsRoute, type Route } from './route.ts'

export type AuxKind = 'tasks' | 'notifications' | 'files' | 'settings'

/** The page a right-side tab starts at; internal navigation stays inside that tab's own App. */
export function auxRoute(kind: AuxKind): Route {
  switch (kind) {
    case 'tasks': return { page: 'tasks', id: undefined }
    case 'notifications': return { page: 'notifications', id: undefined }
    case 'files': return { page: 'files', id: undefined }
    case 'settings': return settingsRoute('display')
  }
}

/** The stable tab type id; the kind is the public `ctx.sidebarRight.openTab` argument. */
export function auxTabId(kind: AuxKind): string { return `dsh-superagent-side-${kind}` }
