/** The Notifications destination for the four-entry navigation: the full notice list plus the E2 activity record fold. */
import { useEffect, useMemo } from 'react'
import { ActivityFeedClient } from './activity-feed.ts'
import { MasterStore } from './master.ts'
import { NoticeInbox, useNoticeCenter } from './notification-center.tsx'
import { usePanel } from './provider.tsx'
import { EventsTab } from './system.tsx'
import type { TasksViewClient } from './tasks-view.ts'
import type { Route } from './route.ts'

export function NotificationsPage({ tasks }: { tasks?: TasksViewClient }) {
  const { t, call, navigate } = usePanel()
  const activity = useMemo(() => new ActivityFeedClient(call), [call])
  const master = useMemo(() => new MasterStore(call), [call])
  useEffect(() => () => { activity.dispose(); master.dispose() }, [activity, master])
  const center = useNoticeCenter()
  const open = (route: Route) => navigate(route)
  return <section className="dt-notices-page">
    <p className="dt-hint dt-page-lead">{t('notificationsHint')}</p>
    {center ? <NoticeInbox center={center} /> : <p className="dt-hint">{t('notificationsUnavailable')}</p>}
    <details className="dt-events-fold">
      <summary>{t('eventsFold')}</summary>
      <EventsTab t={t} activity={activity} master={master} tasks={tasks} onOpen={open}
        onOpenTasks={() => navigate({ page: 'tasks' })} />
    </details>
  </section>
}
