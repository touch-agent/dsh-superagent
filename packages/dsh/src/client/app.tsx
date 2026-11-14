/** Root panel: the conversation-home bridge or the auxiliary page, its navigation and the active route view. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { AuxKind } from './aux.ts'
import type { SearchView } from './api.ts'
import type { ThreadFilter } from '../app/api.ts'
import { Button, Dot, Icon, Input, Modal, SegmentedTabs } from './controls.tsx'
import type { DeploymentForm } from './deployment.tsx'
import { EvalStatus } from './eval.tsx'
import { ExecutionStatus } from './execution.tsx'
import { appShell, masterCard, noticeButton, opsInSettings } from './features.ts'
import { ConversationHome } from './conversation-home.tsx'
import { BUILD, buildMismatch, reloadClient } from './build.ts'
import { ticketMark } from './marks.ts'
import { GLOSSARY, GLOSSARY_VALUES, en, zh, type DshSuperagentKey } from './locales.ts'
import { NotificationHost, useNoticeCenter } from './notification-center.tsx'
import { FilesPage } from './files-page.tsx'
import { NotificationsPage } from './notifications-page.tsx'
import { OverviewPage } from './overview.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { PANEL_NAVIGATE, markPanelPage, panelWantsHome, requestPanelHome } from './panel.ts'
import { homeRoute, initialLocation, isOpsTab, lastSettingsGroup, parseRoute, remember, routeLabel, settingsRoute, visibleTabs, type Location,
  type Route, type SettingsGroup, type Tab } from './route.ts'
import { SettingsPage } from './settings.tsx'
import { SourceStatus } from './source.tsx'
import { TasksPage } from './tasks.tsx'
import { TasksViewClient } from './tasks-view.ts'
import { actorName, errorText, reasonLabel, valueLabel, type T, readableMarkers } from './text.ts'
import { ThreadPage } from './thread.tsx'
import { TicketPage } from './ticket.tsx'
import { TriggerStatus } from './trigger.tsx'
import { When } from './widgets.tsx'

export interface AppProps {
  t: T; openSession: (sessionId: string) => Promise<void>
  deploymentForm: DeploymentForm
  /** A second mount inside the Conversation: local route, unique DOM ids, no panel-navigation listener. */
  embedded?: boolean
  /** The plugin's shared task list; a standalone mount (tests, embedded host) may create its own. */
  tasks?: TasksViewClient
  /** The host already mounts the frame-wide floating notice entry; an embedded/standalone mount draws its own copy. */
  shellNotice?: boolean
  /** A host right-sidebar tab: no panel header, navigation or home; the tab's own route starts at `initialRoute`. */
  side?: AuxKind
  /** The first route of a right-sidebar tab (embedded mounts default to the conversation home). */
  initialRoute?: Route
}

function Glossary({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = usePanel()
  const chinese = t('tab.overview') === zh['tab.overview']
  const [own, other] = chinese ? [zh, en] : [en, zh]
  const heading = (group: keyof typeof GLOSSARY) => t(group === 'roles' ? 'glossaryGroup.roles' : `tab.${group}`)
  return <Modal className="dt-glossary-modal" open={open} onClose={onClose} title={t('glossary')} closeLabel={t('close')}
    description={t('glossaryIntro')} footer={<Button variant="primary" onClick={onClose}>{t('close')}</Button>}>
    <div className="dt-glossary-body">
      <table className="dt-glossary">
        <thead><tr>
          <th>{t(chinese ? 'glossaryChinese' : 'glossaryEnglish')}</th><th>{t(chinese ? 'glossaryEnglish' : 'glossaryChinese')}</th>
          <th>{t('glossaryMeaning')}</th>
        </tr></thead>
        {Object.entries(GLOSSARY).map(([group, keys]) => <tbody key={group}>
          <tr><th colSpan={3} scope="rowgroup" className="dt-glossary-group">{heading(group as keyof typeof GLOSSARY)}</th></tr>
          {keys.map(key => <tr key={key}><td>{own[`term.${key}`]}</td><td>{other[`term.${key}`]}</td><td>{own[`meaning.${key}`]}</td></tr>)}
        </tbody>)}
      </table>
      <p className="dt-legend-title">{t('legendTitle')}</p>
      <ul className="dt-legend">{(['done', 'ongoing', 'warning', 'error', 'idle'] as const).map(state => <li key={state}>
        <Dot state={state} /><span>{t(`legend.${state}`)}</span>
      </li>)}</ul>
      <dl className="dt-values">{Object.entries(GLOSSARY_VALUES).map(([group, values]) => <div key={group} style={{ display: 'contents' }}>
        <dt>{own[`term.${group}` as DshSuperagentKey]}</dt>
        <dd>{values.map(key => `${own[key]} ${other[key]}`).join(' · ')}</dd>
      </div>)}</dl>
    </div>
  </Modal>
}

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (index < 0) return <>{text}</>
  return <>{text.slice(0, index)}<mark className="dt-mark">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>
}
function Result({ name, open, children }: { name: ReactNode; open: (() => void) | undefined; children: ReactNode }) {
  return <li className="dt-row dt-link"><div className="dt-row-main">
    <div className="dt-row-title">{open ? <button type="button" className="dt-open" onClick={open}>{name}</button> : name}</div>
    <div className="dt-row-meta">{children}</div>
  </div></li>
}
function SearchResults({ result, query, onClose }: { result: SearchView; query: string; onClose: () => void }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const empty = !result.items.length && !result.threads.length && !result.tickets.length
  const counts = { tickets: result.tickets.length, threads: result.threads.length, items: result.items.length }
  const go = (route: Route) => () => { onClose(); navigate(route) }
  return <div className="dt-search-results" role="region" aria-label={t('searchLabel')}>
    <div className="dt-search-head">
      <span className="dt-hint">{empty ? t(setup?.accounts?.feishu ? 'searchNone' : 'searchNoneGithub')
        : t(result.items.length >= 20 ? 'searchFoundCapped' : 'searchFound', counts)}</span>
      <Button variant="ghost" size="sm" icon={<Icon name="close" size={14} />} aria-label={t('close')} onClick={onClose} />
    </div>
    {!empty && <ul className="dt-list">
      {result.tickets.map(ticket => <Result key={ticket.id} name={<Highlight text={ticket.title} query={query} />}
        open={go({ page: 'execution', id: ticket.id })}>
        <span>{t('term.ticket')}</span><span>{ticket.stage === 'ended' ? t('ticket.ended') : ticketMark(t, ticket).label}</span>
      </Result>)}
      {result.threads.map(thread => <Result key={thread.key} name={readableMarkers(t, thread.title)} open={go({ page: 'trigger',
        id: thread.key })}>
        <span>{t('term.thread')}</span>
      </Result>)}
      {/* Filtered triggers have no Thread and display their filter reason instead of a link. */}
      {result.items.map(item => <Result key={item.id} name={<Highlight text={readableMarkers(t, item.preview) || t('empty')}
        query={query} />}
        open={item.filtered === undefined ? go({ page: 'trigger', id: item.threads[0]!, query: { trigger: item.id } }) : undefined}>
        <span>{valueLabel(t, 'source', item.source)}</span><span>{actorName(t, item.actor)}</span><When at={item.at} />
        {item.threadTitle && <span className="dt-ellipsis">{t('inThread', { thread: readableMarkers(t, item.threadTitle) })}</span>}
        {item.filtered !== undefined && <span>{t('searchFiltered', { reason: reasonLabel(t, item.filtered) })}</span>}
      </Result>)}
    </ul>}
  </div>
}

function Header({ masterId, hideMaster = false }: { masterId: string | undefined; hideMaster?: boolean }) {
  const { t, call, openSession, notify } = usePanel()
  const notices = useNoticeCenter()
  const [glossary, setGlossary] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ query: string; value: SearchView }>()
  // Ignore responses from superseded or cleared search requests.
  const latest = useRef(0)
  const show = (value?: { query: string; value: SearchView }) => { latest.current++; setResult(value) }
  const search = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!result) return
    const close = (event: PointerEvent) => { if (!search.current?.contains(event.target as Node)) show() }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [result])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) { show(); return }
    const request = ++latest.current
    call('GET search', { query: { q: text } }).then(value => { if (request === latest.current) setResult({ query: text, value }) },
      failure => { if (request === latest.current) notify(errorText(failure)) })
  }
  return <div className="dt-head">
    <div className="dt-head-title"><h1 className="dt-title">{t('title')}</h1></div>
    <div className="dt-toolbar">
      <form ref={search} className="dt-search" role="search" onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') show() }}>
        <Input type="search" icon={<Icon name="search" />} value={query} placeholder={t('searchPlaceholder')} aria-label={t('searchLabel')}
          onChange={event => { setQuery(event.target.value); if (!event.target.value) show() }} />
        {result && <SearchResults result={result.value} query={result.query} onClose={() => { show() }} />}
      </form>
      {notices && !noticeButton() && <Button className="dt-bell" variant="ghost" size="sm" icon={<Icon name="bell" />}
        aria-label={t('noticeUnread', { count: notices.unread })} title={t('notifications')} aria-haspopup="dialog"
        aria-expanded={notices.open} onClick={notices.openDrawer}>
        {notices.unread > 0 && <span className="dt-bell-badge" aria-hidden="true">{notices.unread > 99 ? '99+' : notices.unread}</span>}
      </Button>}
      <Button variant="ghost" size="sm" icon={<Icon name="question" />} aria-label={t('glossary')} title={t('glossary')} aria-haspopup="dialog"
        onClick={() => setGlossary(true)} />
      {!hideMaster && <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} disabled={!masterId}
        onClick={() => { if (masterId) openSession(masterId).catch(failure => notify(errorText(failure))) }}>{t('openMaster')}</Button>}
    </div>
    <Glossary open={glossary} onClose={() => setGlossary(false)} />
  </div>
}

function Pages({ route, openTab, deploymentForm, pageId, tabPrefix, tasks, conversation = false, onBackHome, side = false,
  onBack, canBack }: { route: Route; openTab: (tab: Tab) => void
  deploymentForm: DeploymentForm; pageId: string; tabPrefix: string; tasks?: TasksViewClient; conversation?: boolean
  onBackHome?: () => void; side?: boolean; onBack?: () => void; canBack?: boolean }) {
  const { t, call } = usePanel()
  const { state, error, reload } = usePanelData()
  const consolidated = opsInSettings()
  const tabs = visibleTabs()
  // The conversation home and the auxiliary pages share one task snapshot; a caller that already owns one keeps disposal.
  const store = useMemo(() => tasks ?? new TasksViewClient(call), [tasks, call])
  useEffect(() => () => { if (!tasks) store.dispose() }, [store, tasks])
  // A record detail reached by a direct link (a task, a message) keeps no tab selected; an operations list opens Settings.
  const selected: Tab = consolidated && isOpsTab(route.page) ? (route.id === undefined ? 'settings' : route.page) : route.page
  // Keep the active tab scrolled into view on narrow screens when routes change via links.
  useEffect(() => { document.getElementById(`${tabPrefix}-${selected}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) },
    [selected, tabPrefix])
  const waiting = error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>
  const settings = (group: SettingsGroup, ops: { filter?: string; window?: '24h'; from?: 'conversation' } = {},
    triggerFilter?: ThreadFilter) => <SettingsPage key={state?.masterId} group={group} query={{}}
    {...state ? { state } : {}} deploymentForm={deploymentForm} ops={ops} {...triggerFilter ? { triggerFilter } : {}} />
  const page = (() => {
    switch (route.page) {
      case 'overview': return <OverviewPage />
      case 'tasks': return <TasksPage tasks={store} />
      case 'notifications': return <NotificationsPage tasks={store} />
      case 'files': return <FilesPage tasks={store} />
      case 'source': return consolidated ? settings('source') : <SourceStatus />
      case 'trigger': return route.id !== undefined ? <ThreadPage key={route.id} id={route.id} target={route.query?.trigger} />
        : consolidated ? settings('trigger', {}, route.query?.filter ?? 'subscribed')
          : <TriggerStatus filter={route.query?.filter ?? 'subscribed'} />
      case 'eval': return consolidated ? settings('eval', { ...route.query?.filter ? { filter: route.query.filter } : {},
        ...route.query?.window ? { window: route.query.window } : {} }) : <EvalStatus filter={route.query?.filter ?? 'work'}
        window={route.query?.window} paused={!!state?.paused} />
      case 'execution': return route.id !== undefined ? <TicketPage key={route.id} id={route.id} />
        : consolidated ? settings('execution', { ...route.query?.filter ? { filter: route.query.filter } : {},
          ...route.query?.from ? { from: route.query.from } : {} })
          : state ? <ExecutionStatus filter={route.query?.filter ?? 'open'} from={route.query?.from} state={state} reload={reload} /> : waiting
      case 'settings': return !consolidated && !state ? waiting
        : <SettingsPage key={state?.masterId} group={!consolidated && route.query.group === 'trigger' ? 'source' : route.query.group}
          query={route.query}
          {...state ? { state } : {}} deploymentForm={deploymentForm} />
    }
  })()
  const nav = <SegmentedTabs className="dt-tabs" label={t('pagesLabel')} value={selected} onChange={openTab}
    items={tabs.map(value => ({ value, label: t(`tab.${value}`), id: `${tabPrefix}-${value}`, panelId: pageId }))} />
  const banners = <>
    {buildMismatch(BUILD, state?.build) && <div className="dt-banner dt-build-mismatch" role="status">
      <span className="dt-banner-label">{t('buildMismatchTitle')}</span>{' '}
      {t('buildMismatchDetail', { client: BUILD.buildId, server: state!.build.buildId })}
      <div className="dt-banner-actions">
        <Button variant="outline" size="sm" onClick={() => { void reloadClient() }}>{t('buildReload')}</Button>
      </div>
    </div>}
    {error && state && <p className="dt-error" role="status">{error.message}</p>}
  </>
  // Return to the conversation by making the panel's home the next view; that view opens the main Session itself, so
  // this path cannot race a second open of the same Session.
  const back = () => { requestPanelHome(); onBackHome?.() }
  // The card holds the entrance on the fallback task page; the conversation bar owns it on every auxiliary page.
  const cardHere = !conversation && masterCard() && route.page === 'tasks'
  return <div className={side ? 'dt-page dt-side-page' : 'dt-page'}>
    <div className={side ? 'dt-column dt-side-column' : 'dt-column'}>
      {side && canBack && <div className="dt-side-back">
        <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" size={14} />} onClick={onBack}>{t('back')}</Button>
      </div>}
      {!side && conversation && <div className="dt-conversation-bar">
        <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" size={14} />} disabled={!state?.masterId}
          onClick={back}>{t('backToConversation')}</Button>
        <span className="dt-hint">{t('backToConversationHint')}</span>
      </div>}
      {!side && <Header masterId={state?.masterId} hideMaster={conversation || cardHere} />}
      {banners}
      {!side && nav}
      <main id={pageId} role="tabpanel" className={side ? 'dt-main dt-side-main' : 'dt-main'}
        {...!side && tabs.includes(selected) ? { 'aria-labelledby': `${tabPrefix}-${selected}` } : { 'aria-label': t(`tab.${selected}`) }}>{page}</main>
    </div>
  </div>
}

/** Root panel component managing route history and shared panel state. */
export function App({ t, openSession, deploymentForm, embedded = false, tasks, shellNotice = false, side, initialRoute }: AppProps) {
  // The embedded Status page and right-side tabs keep their own route and do not overwrite the panel's remembered route.
  const [location, setLocation] = useState<Location>(() => embedded ? { route: initialRoute ?? homeRoute(), stack: [] } : initialLocation())
  useEffect(() => { if (!embedded) remember(location) }, [location, embedded])
  // Preserve the last opened settings group across navigation so the Settings tab reopens at it.
  const move = useCallback((next: (current: Location) => Pick<Location, 'route' | 'stack'>) =>
    setLocation(current => ({ ...next(current), group: lastSettingsGroup(current) })), [])
  /** Navigates to `route`; `replace` swaps the current entry (filters, paging) instead of pushing a back step. */
  const navigate = useCallback((route: Route, replace = false) => move(current => ({ route,
    stack: replace ? current.stack : [...current.stack, current.route].slice(-20) })), [move])
  const back = useCallback(() => move(current => ({ route: current.stack.at(-1) ?? homeRoute(), stack: current.stack.slice(0, -1) })), [move])
  const openTab = useCallback((tab: Tab) => move(current => ({ stack: [], route: tab === 'settings'
    ? settingsRoute(lastSettingsGroup(current)) : { page: tab, id: undefined } })), [move])
  // A Conversation view or the Events tab asks for one management page; the panel may already be mounted or may mount later.
  useEffect(() => {
    if (embedded) return
    const onNavigate = (event: Event) => {
      const route = parseRoute((event as CustomEvent<unknown>).detail)
      if (route) { setWantsHome(false); navigate(route) }
    }
    window.addEventListener(PANEL_NAVIGATE, onNavigate)
    return () => window.removeEventListener(PANEL_NAVIGATE, onNavigate)
  }, [navigate, embedded])
  const pageId = side ? `dt-page-side-${side}` : embedded ? 'dt-page-status' : 'dt-page'
  const tabPrefix = side ? `dt-page-side-${side}-tab` : embedded ? 'dt-page-status-tab' : 'dt-tab'
  const conversation = !embedded && appShell()
  // The intent is read once per mount; a header action or a page opened while mounted overrides it.
  const [wantsHome, setWantsHome] = useState(() => !embedded && panelWantsHome())
  const home = conversation && wantsHome
  const browse = useCallback((route: Route) => { markPanelPage(); setWantsHome(false); navigate(route) }, [navigate])
  // Leaving the panel to the host, another plugin or the conversation makes the next Superagent selection start at home.
  useEffect(() => () => { if (!embedded) requestPanelHome() }, [embedded])
  return <PanelProvider t={t} openSession={openSession} navigate={navigate} back={back} interval={side ? 10_000 : 5_000}
    backLabel={routeLabel(t, location.stack.at(-1) ?? homeRoute())}>
    <NotificationHost shellNotice={shellNotice}>
      {home ? <ConversationHome onBrowse={browse} /> : <Pages route={location.route} openTab={openTab} deploymentForm={deploymentForm}
        pageId={pageId} tabPrefix={tabPrefix} tasks={tasks} conversation={conversation} onBackHome={() => setWantsHome(true)}
        {...side ? { side: true, onBack: back, canBack: location.stack.length > 0 } : {}} />}
    </NotificationHost>
  </PanelProvider>
}
