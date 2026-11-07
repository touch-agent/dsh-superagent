/**
 * Browser plugin entry point: the sidebar icon and management panel, the New Session main-Session entry, the in-Session
 * System view, the right Events tab with its unread title, and the Plugin Manager config view.
 */
import { useCallback, useEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { ActivityFeedClient } from './activity-feed.ts'
import { App } from './app.tsx'
import { caller } from './api.ts'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { en, zh } from './locales.ts'
import { MasterStore } from './master.ts'
import { openPanelRoute, PANEL_ID } from './panel.ts'
import { messages } from './provider.tsx'
import { mountStyles } from './styles.ts'
import { EventsBridge, EventsTab, EventsTitle, MasterBadge, MasterEntry, SystemView } from './system.tsx'
import type { T } from './text.ts'
import type { Route } from './route.ts'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const ENTRY = 'dsh-superagent'
const EVENTS_ID = 'dsh-superagent-events'
const EVENTS_KIND = 'system-events'

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

/** Mounted panel wrapper; cancels any pending Session navigation when a new one starts or the panel unmounts. */
function Mounted({ ctx, t, openSession }: { ctx: ClientContext; t: T; openSession: (id: string) => Promise<void> }) {
  const form = usePageForm(ctx.get('configForms')?.get<Record<string, unknown>>(ENTRY))
  return <App t={t} openSession={openSession} deploymentForm={form} />
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
/** Registers every surface; a host without a seat simply never runs that `slots.inject` callback, and the panel remains. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  ctx.effect(() => mountStyles(), 'dsh-superagent: stylesheet')
  const t = ctx.locale.bind(NS)
  const call = caller(() => messages(t))
  const master = new MasterStore(call)
  const activity = new ActivityFeedClient(call)
  const autoOpen = { done: false }
  ctx.effect(() => () => { master.dispose(); activity.dispose() }, 'dsh-superagent: session surfaces')
  const openSession = async (id: string) => {
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, new AbortController().signal)
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }
  const openPanel = (route: Route) => openPanelRoute(ctx, route)
  const openEvents = () => {
    try { ctx.get('sidebarRight')?.openTab(EVENTS_KIND) } catch { /* a host without the right sidebar has no Events tab */ }
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} openSession={openSession} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS },
    HammerIcon))
  // The New Session row's right-aligned option: open the process's existing main Session rather than start a second router Session.
  ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({ name: 'conversation.hero.options', id: 'system-master', order: 10,
    locale: NS }, (props: { t: T }) => <MasterEntry t={props.t} master={master} onOpen={openSession} />))
  // rc.5's row exposes a leading decoration; a trailing badge is not part of this host version.
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({ name: 'sidebar.session.row.leading', id: 'system-master', order: 10,
    locale: NS }, (props: { sessionId: string; t: T }) => <MasterBadge t={props.t} master={master} sessionId={props.sessionId} />))
  // The in-Session System view; non-main Sessions render its explanation instead of the system.
  ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'system', order: 20, locale: NS,
    label: () => t('systemTab') }, (props: { sessionId: string; t: T }) => <SystemView t={props.t} call={call} sessionId={props.sessionId}
    master={master} activity={activity} onOpen={openPanel} />))
  // The right Events tab type: the host owns closing, expanding, floating and docking.
  try {
    ctx.effect(() => ctx.get('sidebarRightTabs')?.register({ id: EVENTS_ID, kind: EVENTS_KIND, title: () => t('eventsTab'),
      priority: 'extension', guide: [{ id: EVENTS_ID, order: 300, title: () => t('eventsTab'), description: () => t('eventsGuide') }] })
      ?? (() => {}), 'dsh-superagent: events tab type')
  } catch { /* a host without the right sidebar keeps the rest of the plugin */ }
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: EVENTS_ID, locale: NS },
    (props: { t: T }) => <EventsTab t={props.t} activity={activity} master={master} onOpen={openPanel} />))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: EVENTS_ID, locale: NS },
    (props: { t: T }) => <EventsTitle t={props.t} activity={activity} />))
  // An invisible Session companion: it keeps the stream alive and opens Events on the first unread notice.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({ name: 'conversation.session.header.utilities',
    id: 'system-events-bridge', order: 900, locale: NS }, () => <EventsBridge activity={activity} master={master} autoOpen={autoOpen}
      open={openEvents} />))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}