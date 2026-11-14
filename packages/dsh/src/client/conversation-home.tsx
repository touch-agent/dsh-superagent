/**
 * The plugin home and its Conversation-header entries. The home is the existing main Session, not a second chat: the
 * panel asks the host to open it as soon as Superagent is selected. Tasks, notices, files and settings sit in the main
 * Session's utility seat, and each opens the plugin panel at that page with a way back to the conversation.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActivityFeedClient } from './activity-feed.ts'
import type { AuxKind } from './aux.ts'
import { useActivityFeed } from './activity-feed.ts'
import { useAttention } from './attention.ts'
import { Button, Icon } from './controls.tsx'
import { appShell, filesPage } from './features.ts'
import type { MasterStore } from './master.ts'
import { useMaster } from './master.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { settingsRoute, type Route } from './route.ts'
import type { T } from './text.ts'

/** The plugin's standalone home: ask the host to reveal the main Session, with a readable fallback if it cannot. */
export function ConversationHome({ onBrowse }: { onBrowse: (route: Route) => void }) {
  const { t, openSession } = usePanel()
  const { state, error } = usePanelData()
  const [opening, setOpening] = useState(false)
  const [failure, setFailure] = useState<string>()
  const started = useRef<string>()
  const masterId = state?.masterId
  const open = useCallback(() => {
    if (!masterId || opening) return
    setOpening(true)
    setFailure(undefined)
    openSession(masterId).catch(reason => setFailure(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setOpening(false))
  }, [masterId, openSession, opening])
  useEffect(() => {
    // One automatic attempt per main Session; a failure leaves the explicit retry and the four page entries.
    if (!masterId || started.current === masterId) return
    started.current = masterId
    setOpening(true)
    openSession(masterId).catch(reason => setFailure(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setOpening(false))
  }, [masterId, openSession])
  const reason = failure ?? error?.message
  return <div className="dt-page dt-conversation-home">
    <section className="dt-conversation-home-card" aria-labelledby="dt-conversation-home-title">
      <span className="dt-conversation-home-mark" aria-hidden="true"><Icon name="session" size={22} /></span>
      <h1 id="dt-conversation-home-title">{t('conversationHomeTitle')}</h1>
      <p className="dt-conversation-home-copy" role={reason ? 'alert' : 'status'}>
        {reason ? t('conversationHomeFailed', { reason }) : t('conversationHomeOpening')}
      </p>
      {reason && <div className="dt-conversation-home-actions">
        <Button variant="primary" icon={<Icon name="session" size={14} />} disabled={!masterId || opening}
          onClick={() => { void open() }}>{opening ? t('masterOpening') : t('conversationHomeRetry')}</Button>
      </div>}
      <div className="dt-conversation-home-browse">
        <p className="dt-hint">{t('conversationHomeBrowse')}</p>
        <div className="dt-conversation-home-actions">
          <Button variant="outline" size="sm" icon={<Icon name="queue" size={14} />} onClick={() => onBrowse({ page: 'tasks' })}>
            {t('tab.tasks')}
          </Button>
          <Button variant="outline" size="sm" icon={<Icon name="bell" size={14} />} onClick={() => onBrowse({ page: 'notifications' })}>
            {t('tab.notifications')}
          </Button>
          {filesPage() && <Button variant="outline" size="sm" icon={<Icon name="inbox" size={14} />} onClick={() => onBrowse({ page: 'files' })}>
            {t('tab.files')}
          </Button>}
          <Button variant="outline" size="sm" icon={<Icon name="settings" size={14} />} onClick={() => onBrowse(settingsRoute('display'))}>
            {t('tab.settings')}
          </Button>
        </div>
      </div>
      <p className="dt-hint">{t('conversationHomeHint')}</p>
    </section>
  </div>
}

/** The main Session's header utilities: the four Superagent destinations, each opening one host right-sidebar tab. */
export function ConversationActions({ t, sessionId, master, attention, activity, onOpen }: { t: T
  sessionId: string; master: MasterStore; attention: Parameters<typeof useAttention>[0]
  activity: ActivityFeedClient; onOpen: (kind: AuxKind) => void }) {
  const identity = useMaster(master)
  if (!appShell() || !identity.masterId || identity.masterId !== sessionId) return null
  // The badge hooks bind only on the main Session, not on every Session header.
  return <MainActions t={t} attention={attention} activity={activity} onOpen={onOpen} />
}

function MainActions({ t, attention, activity, onOpen }: { t: T; attention: Parameters<typeof useAttention>[0]
  activity: ActivityFeedClient; onOpen: (kind: AuxKind) => void }) {
  const waiting = useAttention(attention)
  const feed = useActivityFeed(activity)
  return <div className="dt-header-actions" role="group" aria-label={t('headerActionsLabel')}>
    <Button className="dt-header-action" variant="ghost" size="sm" icon={<Icon name="queue" />}
      aria-label={t('tab.tasks')} title={t('headerTasksHint')} onClick={() => onOpen('tasks')}>
      {waiting > 0 && <span className="dt-header-action-badge" aria-hidden="true">{waiting > 99 ? '99+' : waiting}</span>}
    </Button>
    <Button className="dt-header-action" variant="ghost" size="sm" icon={<Icon name="bell" />}
      aria-label={t('tab.notifications')}
      title={feed.unread > 0 ? `${t('tab.notifications')} · ${t('headerActivityDot')}` : t('headerNoticesHint')}
      onClick={() => onOpen('notifications')}>
      {feed.unread > 0 && <span className="dt-header-action-dot" aria-hidden="true" />}
    </Button>
    {filesPage() && <Button className="dt-header-action" variant="ghost" size="sm" icon={<Icon name="inbox" />}
      aria-label={t('tab.files')} title={t('headerFilesHint')} onClick={() => onOpen('files')} />}
    <Button className="dt-header-action" variant="ghost" size="sm" icon={<Icon name="settings" />}
      aria-label={t('tab.settings')} title={t('headerSettingsHint')} onClick={() => onOpen('settings')} />
  </div>
}