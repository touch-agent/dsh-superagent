/** Entry page: X-09's three zones (waiting for a person, running, recent history) with flow and health folded as E2. */
import { useState, type ReactNode } from 'react'
import { usePoll, type ApprovalRow, type OverviewView, type Problem, type TicketRow } from './api.ts'
import { Button, Icon, Tag } from './controls.tsx'
import { entryThreeZones, errorAggregate } from './features.ts'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { TicketLine } from './rows.tsx'
import { healthText, localized, reasonLabel, valueLabel, readableMarkers, when } from './text.ts'
import { CheckSetupButton, ConfirmButton, Hint, LabelValue, LoadState, Section, SetupMessage, When } from './widgets.tsx'

function ProblemLine({ problem, onChanged }: { problem: Problem; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  const row = (title: string, detail: ReactNode, route: Route | undefined, hint?: string, actions?: ReactNode) => <li
    className="dt-row dt-link dt-att dt-att-error">
    <div className="dt-row-main">
      <div className="dt-att-what">{route ? <button type="button" className="dt-open dt-open-wrap"
        onClick={() => navigate(route)}>{title}</button> : title}</div>
      {detail}{hint && <Hint>{hint}</Hint>}{actions && <div className="dt-row-meta dt-row-buttons">{actions}</div>}
    </div>
  </li>
  const go = (label: string, route: Route) => <Button variant="outline" size="sm" icon={<Icon name="settings"
    size={14} />} onClick={() => navigate(route)}>{label}</Button>
  const raw = (text: string | undefined) => text && <p className="dt-error dt-clamp dt-mono">{text}</p>
  const worded = (text: string) => <p className="dt-error">{text}</p>
  switch (problem.kind) {
    // A failed Feishu bot check pauses only the Feishu Source; other setup problems halt the entire service.
    case 'setup': return row(t(problem.place === 'feishu' ? 'problemSetupFeishu' : 'problemSetup'), <p className="dt-error"><SetupMessage
      problem={problem} /></p>,
      setupPage(problem.place), t(`problemSetupFix.${problem.place}`), <CheckSetupButton />)
    case 'no-source': return row(t('problemNoSource'), undefined, settingsRoute('source'), undefined, go(t('actionOpenSources'),
      settingsRoute('source')))
    case 'no-allowed': return row(t('problemNoAllowed'), undefined, settingsRoute('eval'), undefined, go(t('actionAddAllowed'),
      settingsRoute('eval')))
    case 'executor-paused': return row(t('problemPaused'), undefined, { page: 'execution' }, undefined,
      <ConfirmButton variant="outline" icon="play" label={t('resumeProcessing')} title={t('resumeProcessing')}
        message={t('resumeProcessingConfirm')}
        onConfirm={async () => { await call('POST executor/pause', { body: { paused: false } }); await onChanged() }} />)
    case 'runtime-error': return row(t('problemRuntime', { name: valueLabel(t, 'health', problem.name) }), raw(problem.detail), undefined)
    case 'source-error': {
      const health = problem.source.health
      return row(t('sourceError', { source: localized(t, problem.source.title) }), health.code ? worded(healthText(t, health))
        : raw(health.detail), { page: 'source' }, t('sourceErrorHint'))
    }
    case 'eval-overdue': return row(t('problemEvalOverdue', { thread: readableMarkers(t, problem.thread.title) }), undefined, { page: 'trigger',
      id: problem.thread.key })
    case 'eval-unavailable': return row(t('problemEvalUnavailable', { thread: readableMarkers(t, problem.thread.title) }), raw(reasonLabel(t,
      problem.reason)),
      { page: 'trigger', id: problem.thread.key, query: { trigger: problem.triggerId } }, undefined, <>
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST triggers/:id/requeue', { id: problem.triggerId })) }}>{t('requeue')}</Button>
        <Button variant="outline" size="sm" icon={<Icon name="dismiss" size={14} />} disabled={post.busy}
          onClick={() => { void post.run(() => call('POST decisions/:id/dismiss', { id: problem.decisionId })) }}>{t('dismiss')}</Button>
      </>)
    case 'outgoing': return row(t('problemReply', { source: valueLabel(t, 'source', problem.outgoing.channel.source),
      attempts: problem.outgoing.attempts }),
      raw(problem.outgoing.error), undefined)
  }
}

/** A failed or blocked Ticket belongs in the same folded row as a Source or runtime problem, not in its own card. */
const failedTicket = (ticket: TicketRow): boolean =>
  ticket.stage === 'person' && (ticket.action === 'failed' || ticket.action === 'blocked')

/**
 * UX batch 1's one-row aggregate. Every underlying problem keeps its own actionable row when expanded, so folding hides
 * nothing; the summary carries the automatic retry count and the latest attempt, and disappears with the last problem.
 */
function ProblemGroup({ problems, tickets, onChanged }: { problems: readonly Problem[]; tickets: readonly TicketRow[]
  onChanged: () => Promise<void> }) {
  const { t, call } = usePanel()
  const [open, setOpen] = useState(false)
  const source = problems.find((problem): problem is Extract<Problem, { kind: 'source-error' }> => problem.kind === 'source-error')
  const retryTicket = tickets.find(ticket => ticket.actions.retry)
  const times = [...problems.flatMap(problem => problem.kind === 'source-error' ? [problem.source.health.at]
    : problem.kind === 'eval-overdue' || problem.kind === 'eval-unavailable' ? [problem.thread.lastAt] : []),
  ...tickets.map(ticket => ticket.updatedAt)].filter((at): at is string => !!at).sort()
  const retries = Math.max(0, ...problems.flatMap(problem => problem.kind === 'source-error'
    ? [Number(problem.source.health.values?.count) || 0]
    : problem.kind === 'outgoing' ? [problem.outgoing.attempts] : []))
  const disable = async () => {
    const settings = await call('GET settings')
    const row = settings.sources.find(candidate => candidate.id === source!.source.id)
    if (!row) throw new Error(t('noticeSourceGone'))
    await call('PUT settings/:block', { block: `source:${source!.source.id}`,
      body: { value: { ...row.value, enabled: false }, revision: row.revision } })
    await onChanged()
  }
  const retry = async () => {
    await call('POST tickets/:id/retry', { id: retryTicket!.id })
    await onChanged()
  }
  return <li className="dt-row dt-link dt-att dt-att-error dt-problem-group">
    <div className="dt-row-main">
      <div className="dt-att-what">{t('problemAggregateTitle')} <Tag tone="danger">
        {t('problemAggregateCount', { count: problems.length + tickets.length })}</Tag></div>
      {(() => { const latest = times.at(-1); return <p className="dt-hint">{latest ? t('problemAggregateSummary', {
        sources: problems.filter(problem => problem.kind === 'source-error').length, tasks: tickets.length,
        problems: problems.filter(problem => problem.kind !== 'source-error').length, time: when(latest, t('lang')) })
        : t('problemAggregateSummaryNoTime', { sources: problems.filter(problem => problem.kind === 'source-error').length,
          tasks: tickets.length, problems: problems.filter(problem => problem.kind !== 'source-error').length })}</p> })()}
      {retries > 0 && <p className="dt-hint">{t('problemAggregateRetries', { count: retries })}</p>}
      <div className="dt-row-meta dt-row-buttons">
        {retryTicket && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retry')}
          message={t('problemAggregateRetryConfirm', { task: retryTicket.title })} onConfirm={retry} />}
        {source && <ConfirmButton variant="outline" icon="pause" label={t('noticeDisableSource', { source: localized(t, source.source.title) })}
          title={t('noticeDisableSourceTitle')} message={t('noticeDisableSourceConfirm')} onConfirm={disable} />}
        <Button variant="outline" size="sm" onClick={() => setOpen(value => !value)}>{open ? t('problemAggregateHide')
          : t('problemAggregateShow')}</Button>
      </div>
      {open && <ul className="dt-list dt-cards dt-problem-group-list">
        {problems.map((problem, index) => <ProblemLine key={`problem-${index}`} problem={problem} onChanged={onChanged} />)}
        {tickets.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question onChanged={onChanged} />)}
      </ul>}
      <p className="dt-hint">{t('problemAggregateClear')}</p>
    </div>
  </li>
}

function ApprovalLine({ approval, onChanged }: { approval: ApprovalRow; onChanged: () => Promise<void> }) {
  const { t, call, navigate } = usePanel()
  const [level, setLevel] = useState(approval.action.level)
  const post = useAction((request: () => Promise<unknown>) => request(), { reload: onChanged })
  // The effect follows the level the person picked: a lower grant does less than the requested Action, and a spend
  // costs nothing unless it is granted at the level that carries the cost.
  const spend = level === approval.action.level ? approval.action.cost : undefined
  const consequence = `${valueLabel(t, 'levelEffect', level)}${spend === undefined ? ''
    : ` · ${spend.kind === 'money' ? `${spend.currency} ${spend.amount}` : t('approvalCostTime', { minutes: spend.minutes })}`}`
  return <li className="dt-row dt-link dt-approval">
    <div className="dt-row-main">
      <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'execution',
        id: approval.ticket.id })}>{approval.ticket.title}</button></div>
      <div className="dt-row-meta">
        <Tag tone="warning">{t('approvalNeedsYou')}</Tag>
        <LabelValue label={t('approvalAction')} value={valueLabel(t, 'level', approval.action.level)} />
        <LabelValue label={t('approvalConsequence')} value={consequence} />
        <LabelValue label={t('approvalExpires')} value={<When at={approval.expiresAt} />} />
      </div>
      {/* The object id and action kind are audit facts: available on request, never part of the E0 default row. */}
      <details className="dt-details dt-e0-technical">
        <summary>{t('approvalTechnical')}</summary>
        <div className="dt-row-meta">
          <LabelValue label={t('approvalActionKind')} value={approval.action.kind} />
          <LabelValue label={t('approvalObject')} value={`${valueLabel(t, 'source', approval.action.source)} ${approval.action.objectId} · ${approval.action.revision}`} />
        </div>
      </details>
      <div className="dt-row-meta dt-row-buttons">
        {approval.levels.length > 1 && <select className="dt-select dt-approval-level"
          aria-label={`${t('approvalLevel')} · ${approval.ticket.title}`} title={t('approvalLevel')} value={level}
          onChange={event => setLevel(event.target.value as ApprovalRow['action']['level'])}>
          {approval.levels.map(item => <option key={item} value={item}>{valueLabel(t, 'level', item)}</option>)}
        </select>}
        <Button variant="primary" size="sm" icon={<Icon name="decision" size={14} />} disabled={post.busy}
          aria-label={`${t('approve')} · ${approval.ticket.title}`}
          onClick={() => { void post.run(() => call('POST approvals/:id/approve', { id: approval.id,
            body: level === approval.action.level ? {} : { level } })) }}>{t('approve')}</Button>
        <ConfirmButton variant="outline" icon="dismiss" label={t('deny')} title={t('denyConfirmTitle')}
          message={t('denyConfirm')} ariaLabel={`${t('deny')} · ${approval.ticket.title}`}
          onConfirm={async () => { await call('POST approvals/:id/deny', { id: approval.id }); await onChanged() }} />
      </div>
    </div>
  </li>
}

function ZoneLinks({ links }: { links: { label: string; route: Route }[] }) {
  const { navigate } = usePanel()
  return <span className="dt-zone-links">{links.map(link => <button key={link.label} type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(link.route)}>{link.label}</button>)}</span>
}

/** The two figures the entry page shares with the old Overview: 24-hour flow and health metrics, folded away by default. */
function HealthFold({ data }: { data: OverviewView }) {
  const { t, navigate } = usePanel()
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  const duration = (value: number | null): ReactNode => value === null ? t('empty')
    : value < 60 ? `${Math.round(value * 10) / 10} s` : `${Math.round(value / 60)} min`
  return <details className="dt-details dt-entry-health">
    <summary className="dt-entry-health-summary"><span>{t('entryHealth')}</span><span className="dt-hint">{t('entryHealthHint')}</span></summary>
    <div className="dt-entry-health-body">
      <Section title={t('lastDay')} action={<button type="button" className="dt-textlink dt-more-link"
        onClick={() => navigate({ page: 'trigger', query: { filter: 'recent' } })}>{t('details')}</button>}>
        <div className="dt-stats">
          {stat(t('flowReceivedLabel'), data.flow.received)}
          {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? { page: 'source' } : undefined)}
          {stat(t('flowJudgedLabel'), data.flow.judged)}
          {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { window: '24h' } })}
          {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, { page: 'source' })}
        </div>
      </Section>
      <Section title={t('metricsTitle')}>
        {/* Read-only figures: a missing sample stays `—`, so an empty Store never looks like a healthy zero. */}
        <div className="dt-stats">
          {stat(t('metricTtfaLabel'), <span title={t('metricTtfaHint', { samples: data.metrics.ttfa.samples })}>
            {duration(data.metrics.ttfa.medianSeconds)} / {duration(data.metrics.ttfa.p90Seconds)}</span>)}
          {stat(t('metricDuplicatesLabel'), data.metrics.duplicates.repeated)}
          {stat(t('metricRecoveryLabel'), data.metrics.recovery.recovered
            ? duration(data.metrics.recovery.medianSeconds) : t('empty'))}
          {stat(t('metricThroughputLabel'), data.metrics.throughput.perHour)}
          {stat(t('metricApprovalLabel'), <span title={t('metricApprovalHint', { samples: data.metrics.approval.samples })}>
            {duration(data.metrics.approval.medianSeconds)} / {duration(data.metrics.approval.p90Seconds)}</span>)}
        </div>
        <Hint>{t('metricHint', { interrupted: data.metrics.recovery.interrupted, recovered: data.metrics.recovery.recovered })}</Hint>
      </Section>
    </div>
  </details>
}

/**
 * X-09's entry page: what waits for a person, what is running, and what ended recently. Flow and health figures stay
 * reachable but folded (E2); no tab, record or E2/E3 path is removed.
 */
function EntryPage({ data, error, reload }: { data: OverviewView; error?: Error; reload: () => Promise<void> }) {
  const { t } = usePanel()
  const { setup } = usePanelData()
  const stat = (label: string, value: ReactNode) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span><span className="dt-stat-value">{value}</span>
  </span>
  const failed = data.person.filter(failedTicket)
  const grouped = errorAggregate() && (data.problems.length > 0 || failed.length > 0)
  const person = grouped ? data.person.filter(ticket => !failedTicket(ticket)) : data.person
  // The section counts the underlying items even when one aggregate row carries them, so folding hides no volume.
  const needs = data.approvals.length + person.length + data.problems.length + (grouped ? failed.length : 0)
  return <>
    {error && <LoadState error={error} loading={false} />}
    <Section title={t('entryNeeds')} count={needs} icon="inbox" hint={t('entryNeedsHint')}>
      {needs ? <ul className="dt-list dt-cards">
        {data.approvals.map(approval => <ApprovalLine key={approval.id} approval={approval} onChanged={reload} />)}
        {person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question onChanged={reload} />)}
        {grouped ? <ProblemGroup problems={data.problems} tickets={failed} onChanged={reload} />
          : data.problems.map((problem, index) => <ProblemLine key={`problem-${index}`} problem={problem} onChanged={reload} />)}
      </ul> : <Hint>{t('entryNeedsNone')}</Hint>}
    </Section>
    <Section title={t('entryRunning')} count={data.running.length} icon="running" hint={t('entryRunningHint')}
      action={<ZoneLinks links={[{ label: t('tab.tasks'), route: { page: 'tasks' } },
        { label: t('details'), route: { page: 'execution', query: { filter: 'working' } } }]} />}>
      {/* A pause is already a problem above, so these counts keep their meaning in both states. */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('idleLabel'), data.executor.idle)}
      </div>}
      {data.running.length ? <ul className="dt-list dt-cards">{data.running.map(ticket => <TicketLine key={ticket.id} ticket={ticket}
        onChanged={reload} />)}</ul> : <Hint>{t('entryRunningNone')}</Hint>}
    </Section>
    <Section title={t('entryRecent')} count={data.recent.length} icon="history" hint={t('entryRecentHint')}
      action={<ZoneLinks links={[{ label: t('details'), route: { page: 'execution', query: { filter: 'ended' } } }]} />}>
      {data.recent.length ? <ul className="dt-list dt-cards">{data.recent.map(ticket => <TicketLine key={ticket.id} ticket={ticket} />)}</ul>
        : <Hint>{t('entryRecentNone')}</Hint>}
    </Section>
    <HealthFold data={data} />
  </>
}

/** The pre-X-09 Overview, kept as the `entry.threeZones.v1` fallback; it hides nothing either. */
function LegacyOverview({ data, error, reload }: { data: OverviewView; error?: Error; reload: () => Promise<void> }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const failed = data.person.filter(failedTicket)
  const grouped = errorAggregate() && (data.problems.length > 0 || failed.length > 0)
  const person = grouped ? data.person.filter(ticket => !failedTicket(ticket)) : data.person
  const stat = (label: string, value: ReactNode, route?: Route) => <span className="dt-stat">
    <span className="dt-stat-label">{label}</span>
    {route ? <button type="button" className="dt-textlink dt-stat-value" onClick={() => navigate(route)}>{value}</button> : <span
      className="dt-stat-value">{value}</span>}
  </span>
  const duration = (value: number | null): ReactNode => value === null ? t('empty')
    : value < 60 ? `${Math.round(value * 10) / 10} s` : `${Math.round(value / 60)} min`
  const more = (route: Route) => <button type="button" className="dt-textlink dt-more-link"
    onClick={() => navigate(route)}>{t('details')}</button>
  return <>
    {error && <LoadState error={error} loading={false} />}
    {/* An empty queue is quiet: no section, no explanation. */}
    {data.approvals.length > 0 && <Section title={t('approvalsTitle')} count={data.approvals.length} hint={t('approvalsHint')}>
      <ul className="dt-list dt-cards">{data.approvals.map(approval => <ApprovalLine key={approval.id} approval={approval}
        onChanged={reload} />)}</ul>
    </Section>}
    <Section title={t('pendingTickets')} count={person.length + (grouped ? failed.length : 0)}>
      {person.length ? <ul className="dt-list dt-cards">{person.map(ticket => <TicketLine key={ticket.id} ticket={ticket} question
        onChanged={reload} />)}</ul>
        : <Hint>{t('needsYouNone')}</Hint>}
    </Section>
    {(data.problems.length > 0 || failed.length > 0) && <Section title={t('problems')} count={data.problems.length + (grouped ? failed.length : 0)}>
      <ul className="dt-list dt-cards">{grouped ? <ProblemGroup problems={data.problems} tickets={failed} onChanged={reload} />
        : data.problems.map((problem, index) => <ProblemLine key={index} problem={problem} onChanged={reload} />)}</ul>
    </Section>}
    <Section title={t('lastDay')} action={more({ page: 'trigger', query: { filter: 'recent' } })}>
      {/* Received and evaluated counts operate on Triggers rather than Threads or Decisions, so they do not link to filtered views. */}
      <div className="dt-stats">
        {stat(t('flowReceivedLabel'), data.flow.received)}
        {stat(t('flowFilteredLabel'), data.flow.filtered, data.flow.filtered ? { page: 'source' } : undefined)}
        {stat(t('flowJudgedLabel'), data.flow.judged)}
        {stat(t('flowAcceptedLabel'), data.flow.accepted, { page: 'eval', query: { window: '24h' } })}
        {data.flow.dropped > 0 && stat(t('flowDroppedLabel'), data.flow.dropped, { page: 'source' })}
      </div>
    </Section>
    <Section title={t('metricsTitle')}>
      {/* Read-only figures: a missing sample stays `—`, so an empty Store never looks like a healthy zero. */}
      <div className="dt-stats">
        {stat(t('metricTtfaLabel'), <span title={t('metricTtfaHint', { samples: data.metrics.ttfa.samples })}>
          {duration(data.metrics.ttfa.medianSeconds)} / {duration(data.metrics.ttfa.p90Seconds)}</span>)}
        {stat(t('metricDuplicatesLabel'), data.metrics.duplicates.repeated)}
        {stat(t('metricRecoveryLabel'), data.metrics.recovery.recovered
          ? duration(data.metrics.recovery.medianSeconds) : t('empty'))}
        {stat(t('metricThroughputLabel'), data.metrics.throughput.perHour)}
        {stat(t('metricApprovalLabel'), <span title={t('metricApprovalHint', { samples: data.metrics.approval.samples })}>
          {duration(data.metrics.approval.medianSeconds)} / {duration(data.metrics.approval.p90Seconds)}</span>)}
      </div>
      <Hint>{t('metricHint', { interrupted: data.metrics.recovery.interrupted, recovered: data.metrics.recovery.recovered })}</Hint>
    </Section>
    <Section title={t('term.executor')} action={more({ page: 'execution' })}>
      {/* Pauses surface in `problems` above, so Executor counts render the same in both states; while setup waits, nothing runs. */}
      {setup?.problem ? <Hint>{t('executorWaitingSetup')}</Hint> : <div className="dt-stats">
        {stat(t('executingLabel'), `${data.executor.running} / ${data.executor.maxWorkers}`)}
        {stat(t('queuedLabel'), data.executor.queued)}
        {stat(t('idleLabel'), data.executor.idle)}
      </div>}
    </Section>
  </>
}

export function OverviewPage() {
  const { call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET overview'), [])
  if (!data) return <LoadState error={error} loading />
  return entryThreeZones() ? <EntryPage data={data} error={error} reload={reload} />
    : <LegacyOverview data={data} error={error} reload={reload} />
}
