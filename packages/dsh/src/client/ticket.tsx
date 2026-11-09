/** Ticket detail page: stage and actions, Mandate details, undelivered/delivered Inputs, subscribed Threads, and Assignments. */
import { useState, type ReactNode } from 'react'
import { ApiError, usePoll, type TicketPageView, type TicketTimelineView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, Tag, type IconName } from './controls.tsx'
import { decisionMark, reportDot, ticketMark } from './marks.ts'
import { useAction, usePanel } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { Earlier, ThreadLine, automatedRuns } from './rows.tsx'
import { actorName, localized, readableMarkers, reasonLabel, valueLabel, when, type T } from './text.ts'
import { ActionLink, ConfirmButton, ExternalLink, Hint, KeyValues, LabelValue, LoadState, MarkdownLite, PageHead, Section, SessionButton,
  StageMark, When } from './widgets.tsx'

type Input = TicketPageView['inputs'][number]
function InputLine({ input, earlier = [] }: { input: Input; earlier?: { id: string; at: string; preview: string }[] }) {
  const { t, navigate } = usePanel()
  const trigger = input.kind === 'trigger' ? input.trigger : undefined
  return <li className="dt-row">
    <Dot state={input.delivered ? 'idle' : 'warning'} label={input.delivered ? t('inputDelivered') : t('inputUndelivered')} />
    <div className="dt-row-main">
      {trigger ? <div className="dt-row-title"><button type="button" className="dt-open" onClick={() => navigate({ page: 'trigger',
        id: trigger.thread, query: { trigger: trigger.id } })}>
        {actorName(t, trigger.actor)}{t('labelSeparator')}{readableMarkers(t, trigger.preview) || t('empty')}
      </button></div> : <div className="dt-row-title">{valueLabel(t, 'input', input.kind)}</div>}
      <div className="dt-row-meta">{input.kind === 'trigger' && <span>{valueLabel(t, 'input', input.kind)}</span>}
        {input.kind === 'binding' && input.channel && <span className="dt-mono">{valueLabel(t, 'source', input.channel.source)}
          {' · '}{input.channel.thread}</span>}<When at={input.at} /></div>
      {(input.kind === 'text' || input.kind === 'note') && input.text && <div className="dt-row-quote"><MarkdownLite text={input.text} /></div>}
      {trigger?.handback && <Hint>{t('inputHandedBack', { reason: trigger.handback.reason })}</Hint>}
      <Earlier items={earlier} />
    </div>
  </li>
}
function InputList({ inputs }: { inputs: Input[] }) {
  const sender = (input: Input) => input.kind === 'trigger' && input.trigger && !input.trigger.human
    ? `${input.trigger.actor.source}:${input.trigger.actor.id}` : undefined
  const shown = (input: Input) => ({ id: input.id, at: input.at, preview: input.kind === 'trigger' ? input.trigger?.preview ?? '' : '' })
  return <ul className="dt-list">{automatedRuns(inputs, sender).map(run => <InputLine key={run.item.id} input={run.item}
    earlier={run.earlier.map(shown)} />)}</ul>
}

function Details({ icon, title, open = false, children }: { icon: IconName; title: ReactNode; open?: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(open)
  return <DisclosureRow icon={<Icon name={icon} />} title={title} open={shown} onToggle={() => setShown(!shown)}>
    <div className="dt-disclosure-body">{children}</div>
  </DisclosureRow>
}
function Assignments({ ticket }: { ticket: TicketPageView }) {
  const { t } = usePanel()
  const report = (state: string) => t('assignmentReportShort', { state: valueLabel(t, 'report', state) })
  return <ul className="dt-list">{ticket.assignments.slice().reverse().map((item, index) => <li key={item.id} className="dt-row">
    <Dot state={item.state === 'running' ? reportDot(item.report?.state) : 'idle'} label={valueLabel(t, 'assignment', item.state)} />
    <div className="dt-row-main">
      <div className="dt-row-title">{t('assignmentNumber', { number: ticket.assignments.length - index })}</div>
      <div className="dt-row-meta">
        {/* A running Assignment whose worker reported a non-progress state has ended its turn; show that report as its tag and end its span there. */}
        {item.turnEndedAt && item.report ? <Tag tone="neutral">{report(item.report.state)}</Tag> : <Tag tone={item.state === 'running'
          ? 'info'
          : 'neutral'}>{valueLabel(t, 'assignment', item.state)}</Tag>}
        {item.state !== 'running' && item.report && <span>{report(item.report.state)}</span>}
        <span>{t('assignmentSpan', { from: when(item.startedAt ?? item.createdAt, t('lang')), to: when(item.endedAt ?? item.turnEndedAt,
          t('lang')) || t('now') })}</span>
        {item.endedReason && <span>{reasonLabel(t, item.endedReason)}</span>}
      </div>
    </div>
    {item.ref && item.ref !== ticket.sessionId && <div className="dt-row-actions"><SessionButton variant="outline"
      sessionId={item.ref} /></div>}
  </li>)}</ul>
}
/**
 * The review stage's structural gate: render the deliverable preview, or say the Ticket cannot be reviewed. Approval is
 * offered only when that preview exists; the server refuses it otherwise.
 */
function ReviewSection({ ticket, onChanged }: { ticket: TicketPageView; onChanged: () => Promise<void> }) {
  const { t, call } = usePanel()
  const approve = useAction(() => call('POST tickets/:id/approve', { id: ticket.id }), { reload: onChanged })
  const review = ticket.review
  if (!review) return null
  const deliverable = review.deliverable
  if (!review.canReview || !deliverable) return <Section title={t('reviewSection')} icon="review">
    <Hint>{t('reviewUnavailable')}</Hint>
  </Section>
  const reference = (ref: string) => /^https?:\/\//.test(ref) ? <ExternalLink href={ref}>{ref}</ExternalLink>
    : <span className="dt-mono dt-clamp">{ref}</span>
  const criteria = [
    ...(review.criteria ?? []).map(criterion => criterion.window
      ? t('reviewWindowedRule', { rule: valueLabel(t, 'acceptanceRule', criterion.rule), hours: criterion.window })
      : valueLabel(t, 'acceptanceRule', criterion.rule)),
    ...(review.confirmations ?? []).map(criterion => criterion.reason ? reasonLabel(t, criterion.reason) : t('reviewHumanConfirm')),
  ]
  return <Section title={t('reviewSection')} icon="review">
    <KeyValues rows={[
      [t('reviewArtifact'), `${valueLabel(t, 'artifact', deliverable.artifact.kind)} · ${deliverable.artifact.ref}`],
      [t('reviewRevision'), <span className="dt-mono">{deliverable.artifact.revision}</span>],
      [t('reviewPreviewKind'), valueLabel(t, 'previewKind', deliverable.previewRef.kind)],
      [t('reviewPreviewRef'), reference(deliverable.previewRef.ref)],
      ...criteria.length > 0 ? [[t('reviewCriteria'), <ul className="dt-plain-list">{criteria.map((criterion, index) =>
        <li key={index}>{criterion}</li>)}</ul>] as [string, ReactNode]] : [],
    ]} />
    {review.summary && <div className="dt-row-quote"><MarkdownLite text={review.summary} /></div>}
    {review.accepted ? <Hint>{t('reviewAccepted', { by: actorName(t, review.accepted.by), time: when(review.accepted.at, t('lang')) })}</Hint>
      : <div className="dt-row-buttons"><Button variant="primary" size="sm" disabled={approve.busy} onClick={() => void approve.run()}>
        {t('approve')}</Button></div>}
  </Section>
}

/** One Mandate-basis fact in the words the panel already uses for it. */
function basisFactLabel(t: T, item: TicketPageView['basis']['facts'][number]): string {
  if (item.name === 'legacyAuthority') return valueLabel(t, 'legacy', item.value)
  if (item.name === 'mode' || item.name === 'addressed') return valueLabel(t, item.name, item.value)
  if (item.name === 'admission') return valueLabel(t, 'admissionCell', item.value)
  if (item.name === 'rules') return item.value.map(rule => rule.name).join(t('listSeparator'))
  return item.name === 'sender' ? item.value : t('yes')
}
/** What one timeline step changed: an Action, a Report, an Input, an Assignment, a Decision, a Policy change or an end. */
function TimelineChangeView({ change }: { change: TicketTimelineView['entries'][number]['change'] }) {
  const { t } = usePanel()
  switch (change.kind) {
    case 'action': {
      const { action } = change
      const cost = action.cost?.kind === 'money' ? `${action.cost.amount} ${action.cost.currency}`
        : action.cost?.kind === 'time' ? t('approvalCostTime', { minutes: action.cost.minutes }) : undefined
      return <>
        <span className="dt-mono">{action.kind} · {action.source}:{action.objectId}</span>
        <span className="dt-mono">{action.revision}</span>
        {action.target && <span className="dt-mono">{action.target}</span>}
        <Tag tone="neutral">{valueLabel(t, 'level', action.level)}</Tag>
        {cost && <span className="dt-mono">{cost}</span>}
        {change.ok === false ? <Tag tone="danger">{t('timelineActionFailed')}</Tag>
          : change.ok === true ? <Tag tone="success">{t('timelineActionOk')}</Tag> : null}
        {change.error && <span className="dt-mono dt-clamp">{change.error}</span>}
      </>
    }
    case 'report': return <>
      <Tag tone={change.state === 'ready' ? 'success' : change.state === 'blocked' || change.state === 'failed' ? 'danger' : 'neutral'}>
        {valueLabel(t, 'report', change.state)}</Tag>
      {change.summary && <div className="dt-row-quote"><MarkdownLite text={change.summary} /></div>}
      {change.review?.deliverable && <span>{t('timelineReportArtifact', { kind: valueLabel(t, 'artifact',
        change.review.deliverable.artifact.kind), revision: change.review.deliverable.artifact.revision })}</span>}
    </>
    case 'input':
      return change.input.kind === 'trigger'
        ? <span>{readableMarkers(t, change.input.preview ?? '') || t('empty')}</span>
        : <div className="dt-row-quote"><MarkdownLite text={change.input.text ?? t('empty')} /></div>
    case 'decision': return <span>{decisionMark(t, change.outcome).label}</span>
    case 'ticket': return <span>{change.title}</span>
    case 'assignment': return <span className="dt-mono">{change.id} · {valueLabel(t, 'assignment', change.state)}</span>
    case 'end': return <>{valueLabel(t, 'outcome', change.outcome)}{change.reason && <span> · {reasonLabel(t, change.reason)}</span>}</>
    case 'policy': return <>
      <span className="dt-mono">{change.from.slice(0, 8)} → {change.to.slice(0, 8)}</span>
      {!!change.effect?.rules?.length && <span>{t('timelinePolicyRules', { rules: change.effect.rules.map(rule => rule.name).join(t('listSeparator')) })}</span>}
    </>
    case 'resume': return <span>{t('timelineResumed')}</span>
    case 'reopen': return <span>{t('timelineReopened')}</span>
    case 'binding': return <span className="dt-mono">{valueLabel(t, 'source', change.channel.source)} · {change.channel.thread}</span>
  }
}
/** 凭什么: the Decision, Mandate, Policy, Approval and disposition a timeline step rests on. */
function TimelineBasisView({ basis }: { basis: TicketTimelineView['entries'][number]['basis'] }) {
  const { t } = usePanel()
  const parts: ReactNode[] = []
  if (basis.strength) parts.push(<LabelValue key="strength" label={t('timelineBasisStrength')}
    value={valueLabel(t, 'strength', basis.strength)} />)
  if (basis.policyVersion) parts.push(<LabelValue key="policy" label={t('policyVersion')}
    value={<span className="dt-mono">{basis.policyVersion.slice(0, 8)}</span>} />)
  if (basis.decision) parts.push(<LabelValue key="decision" label={t('timelineBasisDecision')}
    value={valueLabel(t, 'decision', basis.decision.kind)} />)
  const facts = (basis.facts ?? []).filter(item => item.name !== 'sender')
  if (facts.length) parts.push(<LabelValue key="facts" label={t('timelineBasisFacts')}
    value={facts.map(item => basisFactLabel(t, item)).join(t('listSeparator'))} />)
  if (basis.rules?.length) parts.push(<LabelValue key="rules" label={t('timelineBasisRules')}
    value={basis.rules.map(rule => rule.name).join(t('listSeparator'))} />)
  if (basis.reason?.length) parts.push(<LabelValue key="reason" label={t('timelineBasisReason')}
    value={reasonLabel(t, basis.reason)} />)
  if (basis.approval) {
    const { approval } = basis
    const by = approval.decidedBy ? actorName(t, approval.decidedBy) : approval.requestedBy ? actorName(t, approval.requestedBy) : undefined
    parts.push(<LabelValue key="approval" label={t('timelineBasisApproval')} value={`${valueLabel(t, 'approvalState', approval.state)}
      · ${valueLabel(t, 'level', approval.grantedLevel ?? approval.level)}${by ? ` · ${by}` : ''}`} />)
    if (approval.reason) parts.push(<LabelValue key="approval-reason" label={t('timelineBasisApprovalReason')} value={approval.reason} />)
  }
  if (basis.disposition) {
    const { disposition } = basis
    const shown: string[] = []
    if (disposition.filtered) shown.push(reasonLabel(t, disposition.filtered))
    if (disposition.delivered) shown.push(t('timelineDispositionDelivered'))
    if (disposition.context) shown.push(t('timelineDispositionContext'))
    if (disposition.acked) shown.push(t('timelineDispositionAcked'))
    if (disposition.requeued) shown.push(t('timelineDispositionRequeued'))
    for (const handback of disposition.handbacks) shown.push(t('timelineDispositionHandback', { reason: handback.reason }))
    if (shown.length) parts.push(<LabelValue key="disposition" label={t('timelineBasisDisposition')} value={shown.join(t('listSeparator'))} />)
  }
  return <>{parts}</>
}
/** One readable step: who acted, on what basis, and what changed, with a gap stated when the records cannot name the actor. */
function TimelineRow({ entry }: { entry: TicketTimelineView['entries'][number] }) {
  const { t } = usePanel()
  const who = entry.who.actor ? actorName(t, entry.who.actor) : t(`timelineSystem.${entry.who.system ?? 'system'}` as never)
  return <li className="dt-timeline-entry">
    <Dot state={entry.gap ? 'warning' : 'idle'} label={t(`timelineKind.${entry.kind}` as never)} />
    <div className="dt-row-main">
      <div className="dt-row-title"><strong className="dt-timeline-actor">{who}</strong>
        <span className="dt-timeline-kind">{t(`timelineKind.${entry.kind}` as never)}</span><When at={entry.at} /></div>
      <div className="dt-timeline-change"><TimelineChangeView change={entry.change} /></div>
      <div className="dt-timeline-basis"><TimelineBasisView basis={entry.basis} /></div>
      {entry.gap && <Hint>{t(`timelineGap.${entry.gap}` as never)}</Hint>}
    </div>
  </li>
}
/** The Ticket's read-only audit timeline; it fetches on its own so the rest of the page does not wait for it. */
function TimelineSection({ ticketId }: { ticketId: string }) {
  const { t, call } = usePanel()
  const { data, error } = usePoll(() => call('GET tickets/:id/timeline', { id: ticketId }), [ticketId])
  if (error instanceof ApiError && error.missing) return null
  return <Section title={t('timelineTitle')} icon="history" count={data?.entries.length} hint={t('timelineHint')}>
    {!data ? <LoadState error={error} loading={!error} /> : <>
      {!!data.gaps?.length && <Hint>{t('timelineGaps', { gaps: data.gaps.map(gap => t(`timelineGap.${gap}` as never))
        .join(t('listSeparator')) })}</Hint>}
      {data.entries.length ? <ul className="dt-list dt-timeline">{data.entries.map(entry => <TimelineRow key={entry.id}
        entry={entry} />)}</ul> : <Hint>{t('timelineEmpty')}</Hint>}
    </>}
  </Section>
}

function MandateDetails({ ticket, actor }: { ticket: TicketPageView; actor: string }) {
  const { t, navigate } = usePanel()
  const { mandate, decision } = ticket
  const fact = (item: TicketPageView['basis']['facts'][number]): string => basisFactLabel(t, item)
  const { legacy } = ticket.basis
  // Omit `sender` when it matches `actor`, which is already shown on the status line.
  const facts = ticket.basis.facts.filter(item => !(item.name === 'sender' && item.value === actor))
  const direction = decision?.direction
  const rows: [string, ReactNode][] = decision ? [
    [t('term.trigger'), <button type="button" className="dt-trigger-link" onClick={() => navigate({ page: 'trigger', id: decision.thread,
      query: { trigger: decision.triggerIds[0] ?? '' } })}>
      <span className="dt-trigger-text">{readableMarkers(t, decision.preview) || t('empty')}</span>
      <span className="dt-row-meta"><span>{valueLabel(t, 'source', mandate.actor.source)} · {actor}</span><When at={decision.at} /></span>
    </button>],
    [t('term.decision'), <div className="dt-kv-stack">
      <span>{decisionMark(t, decision.outcome).label}</span>
      <Hint>{reasonLabel(t, decision.reason)}</Hint>
      {decision.rules.map(rule => <Hint key={rule.id}>{t(rule.matched ? 'ruleMatched' : 'ruleUnmatched', { rule: rule.name,
        reason: rule.reason })}</Hint>)}
      {direction && <Hint>{t('directionLine', { intent: t(direction.implementation_requested ? 'intentYes' : 'intentNo'),
        basis: valueLabel(t, 'targetBasis', direction.target_basis),
        design: t(direction.requires_design_decision ? 'designNeeded' : 'designNotNeeded') })} {t('directionEvidence',
          { evidence: direction.evidence })}</Hint>}
    </div>],
  ] : []
  const version = <button type="button" className="dt-textlink dt-mono" onClick={() => navigate(settingsRoute('eval',
    { version: mandate.policyVersion }))}>{mandate.policyVersion.slice(0, 8)}</button>
  return <Section title={t('mandateDetails')} icon="shield">
    <KeyValues rows={[...rows, [t('term.scope'), legacy ? t('legacyScopeShort') : mandate.scope || t('empty')],
      ...facts.map((item): [string, string] => [valueLabel(t, 'basis', item.name), fact(item)]),
      ...legacy ? [] : [[t('policyVersion'), version] as [string, ReactNode]]]} />
  </Section>
}

export function TicketPage({ id }: { id: string }) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET tickets/:id', { id }), [id])
  const after = async (request: Promise<unknown>) => { await request; await reload() }
  if (!data) return <><PageHead
    title={t('term.ticket')} />{error instanceof ApiError && error.missing ? <Hint>{t('ticketNotFound')}</Hint> : <LoadState
      error={error} loading />}</>
  const status = ticketMark(t, data)
  const actor = actorName(t, data.mandate.actor)
  const { legacy } = data.basis
  const undelivered = data.inputs.filter(input => !input.delivered)
  const failedText = /^(?:\w+Error|Error)\b[:：]/.test(data.summary)
  const failed = data.stage === 'person' && data.action === 'failed'
  const opening = data.threads.find(thread => thread.url)
  const ended = data.ended && (() => {
    const outcome = valueLabel(t, 'outcome', data.ended.outcome), reason = reasonLabel(t, data.ended.reason), time = when(data.ended.at,
      t('lang'))
    return reason ? t('endedAt', { time, outcome, reason }) : t('endedAtShort', { time, outcome })
  })()
  const channel = data.channels[0]
  return <>
    <PageHead title={data.title}>
      {opening?.url && <ActionLink href={opening.url}>{t('openThread', { source: valueLabel(t, 'source', opening.source) })}</ActionLink>}
      {data.actions.retry && <ConfirmButton variant="outline" icon="refresh" label={t('retry')} title={t('retryTitle')}
        message={t('retryConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/retry', { id }))} />}
      {data.conversationSession && <SessionButton variant="outline" sessionId={data.conversationSession} label={t('openConversation')} />}
      {data.sessionId && <SessionButton variant="outline" sessionId={data.sessionId} />}
    </PageHead>
    {error && <LoadState error={error} loading={false} />}
    <div className="dt-row-meta dt-status-line">
      <StageMark state={status.dot} icon={status.icon} label={status.label} />
      {data.origin === 'conversation' && <Tag tone="quiet">{t('ticketFromConversation')}</Tag>}
      <LabelValue label={t('ticketMandateLabel')} value={valueLabel(t, 'strength', data.mandate.strength)} />
      <LabelValue label={t('ticketActorLabel')} value={`${valueLabel(t, 'source', data.mandate.actor.source)} · ${actor}`} />
      <LabelValue label={t('ticketUpdatedLabel')} value={when(data.updatedAt, t('lang'))} />
    </div>
    {ended && <Hint>{ended}</Hint>}
    {data.attention && <div className="dt-banner"><span className="dt-banner-label">{t('attentionPrefix')}</span><MarkdownLite
      text={data.attention.question} />
      {channel && <div className="dt-banner-actions">
        <ActionLink href={channel.url} icon="message">{t('answerIn', { source: valueLabel(t, 'source', channel.source) })}</ActionLink>
      </div>}</div>}
    {/* Ordinary progress stays in the Session/Channels; only a report that halted work (blocked/failed) is shown here. */}
    {data.actions.retry && data.summary && <p className={`dt-banner${failed ? ' dt-danger' : ''}${failedText ? ' dt-mono' : ''}`}>
      <span className="dt-banner-label">{t(failed ? 'failedPrefix' : 'blockedPrefix')}</span>{data.summary}
    </p>}
    {data.deliveryError && <p className="dt-banner dt-danger dt-mono">
      <span className="dt-banner-label">{t('deliveryFailedPrefix')}</span>{data.deliveryError}
    </p>}
    <ReviewSection ticket={data} onChanged={reload} />
    <MandateDetails ticket={data} actor={actor} />
    <TimelineSection ticketId={data.id} />
    {undelivered.length > 0 && <Section title={t('undeliveredInputs')} count={undelivered.length}>
      <Hint>{data.deliveryError ? t('inputRetryHint') : data.paused ? t('inputPausedHint') : t('inputWaitingHint')}</Hint>
      <InputList inputs={undelivered} />
    </Section>}
    {data.threads.length > 0 && <Section title={t('subscribedThreads')} count={data.threads.length}>
      <ul className="dt-list">{data.threads.map(thread => <ThreadLine key={thread.key} thread={thread} ticketId={data.id}
        context={thread.context} />)}</ul>
    </Section>}
    <div className="dt-details">
      {/* A single Assignment adds nothing beyond the status line; list Assignments only once work has been resumed or handed over. */}
      {data.assignments.length > 1 && <Details icon="queue" title={`${t('term.assignment')} · ${data.assignments.length}`} open><Assignments
        ticket={data} /></Details>}
      {data.environment.length > 0 && <Details icon="settings" title={t('term.environment')}>
        <table className="dt-table"><tbody>{data.environment.map(variable => <tr key={variable.key} title={localized(t,
          variable.description)}>
          <td className="dt-mono">{variable.key}</td><td className="dt-mono">{variable.value || <span
            className="dt-hint">{t('empty')}</span>}</td>
        </tr>)}</tbody></table>
      </Details>}
      <Details icon="message" title={t('term.channel')}>
        <ul className="dt-plain-list">{data.channels.map((item, index) => <li key={index}>
          <ExternalLink href={item.url} icon={item.source === 'github' ? 'pull' : 'message'}>{localized(t, item.label)}</ExternalLink>
        </li>)}</ul>
      </Details>
      {data.inputs.length > undelivered.length && <Details icon="inbox" title={t('deliveredInputs',
        { count: data.inputs.length - undelivered.length })}>
        <InputList inputs={data.inputs.filter(input => input.delivered)} />
      </Details>}
      <Details icon="hash" title={t('identifiers')}>
        <KeyValues rows={[[t('ticketId'), <span className="dt-mono">{data.id}</span>], [t('executionDirectory'), <span
          className="dt-mono">{data.directory ?? t('empty')}</span>],
          ...legacy && data.mandate.scope ? [[t('legacyAssignment'), <span
            className="dt-mono dt-clamp">{data.mandate.scope}</span>] as [string, ReactNode]] : []]} />
      </Details>
    </div>
    {data.actions.stop && <div className="dt-danger-zone">
      <span className="dt-hint">{t('stopHint')}</span>
      <ConfirmButton variant="outline" label={t('stop')} title={t('stopConfirmTitle')} message={t('stopConfirm', { title: data.title })}
        onConfirm={() => after(call('POST tickets/:id/stop', { id }))} />
    </div>}
  </>
}
