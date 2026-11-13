/**
 * Files: the results a person can open, grouped by the task that produced them. This reads the existing `GET tasks`
 * deliverables; it is not the host's file browser and it does not add a second file record. Only metadata is shown here;
 * the artifact itself is E3 and opens from its own link.
 */
import { useEffect, useMemo } from 'react'
import type { TaskDeliverableSummary } from '../app/tasks.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { TasksViewClient, useTasksView } from './tasks-view.ts'
import { fullTime, valueLabel, when } from './text.ts'
import { LoadState } from './widgets.tsx'

const isHttp = (ref: string): boolean => /^https?:\/\//i.test(ref)

export function FilesPage({ tasks }: { tasks?: TasksViewClient }) {
  const { t, call, navigate } = usePanel()
  const store = useMemo(() => tasks ?? new TasksViewClient(call), [tasks, call])
  useEffect(() => () => { if (!tasks) store.dispose() }, [store, tasks])
  const snapshot = useTasksView(store)
  const data = snapshot.data
  const rows = useMemo(() => (data?.tasks ?? []).flatMap(task => task.deliverables.map(deliverable => ({ task, deliverable })))
    .sort((a, b) => (a.deliverable.at < b.deliverable.at ? 1 : a.deliverable.at > b.deliverable.at ? -1 : 0)), [data])
  if (!data) return <LoadState error={snapshot.error} loading={!snapshot.ready} />
  return <section className="dt-files-page">
    <p className="dt-hint dt-page-lead">{t('filesIntro')}</p>
    {rows.length === 0 ? <p className="dt-hint">{t('filesEmpty')}</p> : <>
      <p className="dt-files-summary">{t('filesCount', { count: rows.length })}</p>
      <ul className="dt-files-list">
        {rows.map(({ task, deliverable }) => <FileRow key={`${task.id}:${deliverable.key}`} taskId={task.id} taskTitle={task.title}
          deliverable={deliverable} onOpenTask={() => navigate({ page: 'execution', id: task.id })} />)}
      </ul>
    </>}
  </section>
}

function FileRow({ taskId, taskTitle, deliverable, onOpenTask }: { taskId: string; taskTitle: string
  deliverable: TaskDeliverableSummary; onOpenTask: () => void }) {
  const { t } = usePanel()
  const ref = deliverable.artifact.ref
  const external = isHttp(ref)
  return <li className="dt-file-row" data-task={taskId}>
    <div className="dt-file-main">
      <div className="dt-file-title">
        <Icon name="inbox" size={15} />
        <span>{deliverable.summary ?? ref}</span>
        <Tag tone="quiet">{valueLabel(t, 'artifact', deliverable.artifact.kind)}</Tag>
        <Tag tone="quiet">{deliverable.artifact.revision}</Tag>
      </div>
      <p className="dt-hint">{t('filesTask', { task: taskTitle })} · <time dateTime={deliverable.at}
        title={fullTime(deliverable.at, t('lang'))}>{when(deliverable.at, t('lang'))}</time></p>
    </div>
    {external ? <a className="dt-btn dt-btn-outline dt-btn-sm" href={ref} target="_blank" rel="noreferrer">
      {t('filesOpen')}<Icon name="external" size={13} /></a> : <Button size="sm" variant="outline" onClick={onOpenTask}>
      {t('noticeViewTask')}</Button>}
  </li>
}
