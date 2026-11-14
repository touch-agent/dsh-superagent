/**
 * The four auxiliary pages as host right-sidebar tabs: opening one keeps the main Conversation mounted and visible.
 * The tab owns its own embedded App, so links inside a page (a task detail, a settings group) change only that tab.
 */
import type { Context } from '@deepseek-ai/cordis'
import { App } from './app.tsx'
import { auxRoute, type AuxKind } from './aux.ts'
import { usePageForm } from './deployment.tsx'
import type { DshSuperagentKey } from './locales.ts'
import type { TasksViewClient } from './tasks-view.ts'
import type { T } from './text.ts'

const ENTRY = 'dsh-superagent'

/** The stable tab kinds and their labels, in the order the header presents them. */
export const AUX_TABS: readonly { kind: AuxKind; title: DshSuperagentKey }[] = [
  { kind: 'tasks', title: 'tab.tasks' },
  { kind: 'notifications', title: 'tab.notifications' },
  { kind: 'files', title: 'tab.files' },
  { kind: 'settings', title: 'tab.settings' }
]

type ClientContext = Context

/** A tab body: the management page in an embedded, side-only mode, with its own route and shared task snapshot. */
export function SideMounted({ ctx, t, openSession, tasks, kind }: { ctx: ClientContext; t: T
  openSession: (id: string) => Promise<void>; tasks: TasksViewClient; kind: AuxKind }) {
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  return <App t={t} openSession={openSession} deploymentForm={form} embedded side={kind} initialRoute={auxRoute(kind)}
    tasks={tasks} shellNotice />
}
