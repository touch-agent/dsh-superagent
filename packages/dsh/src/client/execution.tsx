/** Execution status view (active Tickets and pause control) and Execution settings group (Executor capacity and workspace environment). */
import { useRef, useState } from 'react'
import { TICKET_FILTERS, type TicketFilter, type TicketOrigin } from '../app/api.ts'
import { LIMITS } from '../limits.ts'
import { usePoll, type SettingsView, type SourceView, type StateView } from './api.ts'
import { DisclosureRow, Icon, InfoTip, Input, Pill } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { workspaceView } from './features.ts'
import { usePanel } from './provider.tsx'
import { TicketLine } from './rows.tsx'
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from './settings-kit.tsx'
import { localized, valueLabel } from './text.ts'
import { ConfirmButton, Hint, LabelValue, LoadMore, LoadState, Section, StatusHead, When } from './widgets.tsx'
import type { SpaceRow } from '../app/spaces.ts'

export function ExecutionStatus({ filter: current, from, state, reload, embedded = false }: {
  filter: TicketFilter; from?: TicketOrigin | undefined; state: StateView; reload: () => Promise<void>; embedded?: boolean
}) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error, reload: reloadTickets } = usePoll(() => call('GET tickets', { query: { state: current, limit,
    ...from ? { origin: from } : {} } }), [current, from, limit])
  const show = (filter: TicketFilter, origin?: TicketOrigin) => navigate({ page: 'execution',
    query: { ...filter === 'open' ? {} : { filter }, ...origin ? { from: origin } : {} } }, true)
  const { paused, load: { maxWorkers } } = state
  // Pausing uses its own block revision so toggling pause does not invalidate an open Execution settings draft.
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const status = state.setup.problem ? { tone: 'warning', label: t('executorWaitingSetup') } : paused ? { tone: 'warning',
    label: t('processingPaused') }
    : { tone: 'ongoing', label: t('executorRunning') }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <>
    <StatusHead hint={t('executionStatusIntro')} {...embedded ? {} : { settings: 'execution' }} />
    <div className="dt-row-meta dt-status-line">
      <span className="dt-status-text" data-state={status.tone}>{status.label}</span>
      {!state.setup.problem && <>
        <LabelValue label={t('executingLabel')}
          value={`${state.load.running} / ${maxWorkers}`} /><LabelValue label={t('queuedLabel')} value={state.load.queued} />
      </>}
      <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)} message={t(paused
        ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')}
        onConfirm={pause} />
    </div>
    <div className="dt-filters">
      {TICKET_FILTERS.map(value => <Pill key={value} active={current === value}
        onClick={() => { setLimit(20); show(value, from) }}>{t(`ticketFilter.${value}`)}</Pill>)}
      <span className="dt-filters-separator" />
      <Pill active={!from} onClick={() => { setLimit(20); show(current) }}>{t('ticketOriginAll')}</Pill>
      <Pill active={from === 'conversation'} onClick={() => { setLimit(20); show(current, 'conversation') }}>{t('ticketFromConversation')}</Pill>
    </div>
    {current === 'idle' && <Hint>{t('idleHint')}</Hint>}
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(ticket => ticket.stage === 'person'
      ? <TicketLine key={ticket.id} ticket={ticket} question surface="e2"
        onChanged={reloadTickets} /> : <TicketLine key={ticket.id} ticket={ticket} surface="e2" />)}</ul> : <Hint>{t('none')}</Hint>)}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
    {current === 'open' && !from && <SpacesSection />}
  </>
}

/** Read-only Spaces list: display name, holder, lease diagnostics and a copyable path, grouped by state. */
function SpacesSection() {
  const { t, call, navigate } = usePanel()
  const { data, error } = usePoll(() => call('GET spaces'), [])
  const [filter, setFilter] = useState<'all' | 'active' | 'legacy' | 'stale' | 'checkout' | 'scratch' | 'unknown'>('all')
  const [copied, setCopied] = useState<string>()
  if (!workspaceView()) return null
  const rows = data?.rows ?? []
  const isStale = (row: SpaceRow) => !!row.lease?.stale
  const shown = rows.filter(row => {
    if (filter === 'all') return true
    if (filter === 'stale') return isStale(row)
    if (filter === 'active') return row.state === 'active' && !isStale(row)
    if (filter === 'legacy') return !!row.legacy
    if (filter === 'checkout' || filter === 'scratch' || filter === 'unknown') return row.kind === filter
    return row.state === filter
  })
  const order = ['preparing', 'active', 'legacy', 'planned', 'ready', 'failed']
  const grouped = [...new Set(shown.map(row => isStale(row) ? 'stale' : row.state))]
    .sort((left, right) => (order.indexOf(left) + 1 || 99) - (order.indexOf(right) + 1 || 99))
    .map(state => [state, shown.filter(row => (isStale(row) ? 'stale' : row.state) === state)] as const)
  const copy = async (row: SpaceRow) => {
    try {
      await navigator.clipboard.writeText(row.locator)
      setCopied(row.ticket.id)
      window.setTimeout(() => setCopied(value => value === row.ticket.id ? undefined : value), 1500)
    } catch { /* clipboard access may be denied; the path stays readable */ }
  }
  return <Section title={t('spaces')} count={rows.length} icon="session" hint={t('spacesHint')}>
    <div className="dt-filters">
      {(['all', 'active', 'legacy', 'stale'] as const).map(value => <Pill key={value} active={filter === value}
        onClick={() => setFilter(value)}>{t(`spaceFilter.${value}`)}</Pill>)}
      <span className="dt-filters-separator" />
      {(['checkout', 'scratch', 'unknown'] as const).map(value => <Pill key={value} active={filter === value}
        onClick={() => setFilter(value)}>{valueLabel(t, 'spaceKind', value)}</Pill>)}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (shown.length ? <div className="dt-form">
      {grouped.map(([state, group]) => <div key={state}>
        <h3 className="dt-block-title">{valueLabel(t, 'spaceState', state)}<span className="dt-count">{group.length}</span></h3>
        <ul className="dt-list">{group.map(row => <li className="dt-row" key={row.ticket.id}>
          <div className="dt-row-main">
            <div className="dt-row-title"><button type="button" className="dt-open"
              onClick={() => navigate({ page: 'execution', id: row.ticket.id })}>{row.name}</button>
              <span className="dt-hint"> · {valueLabel(t, 'spaceKind', row.kind)}{row.branch ? ` · ${row.branch}` : ''}</span>
              {row.legacy && <span className="dt-hint"> · {t('spaceLegacy')}</span>}
            </div>
            <div className="dt-row-meta"><span>{row.ticket.title}</span>
              <span>{valueLabel(t, 'activityStatus', row.ticket.status)}</span>
              {row.lease && <span>{t('spaceLeaseState', { state: valueLabel(t, 'spaceLease', row.lease.stale ? 'stale' : row.lease.state),
                epoch: row.lease.epoch })}</span>}
              {row.lastAt && <When at={row.lastAt} />}
            </div>
            <div className="dt-row-meta"><span className="dt-mono dt-clamp">{row.locator}</span>
              <button type="button" className="dt-textlink" onClick={() => void copy(row)}>{copied === row.ticket.id ? t('copied') : t('copyPath')}</button>
            </div>
          </div>
        </li>)}</ul>
      </div>)}
    </div> : <Hint>{t('spaceNone')}</Hint>)}
  </Section>
}

const firstSentence = (text: string): string => /^[^。；;.]*(?:[。；;]|\.(?=\s|$))?/.exec(text)?.[0] ?? text
function EnvironmentVariables({ groups, sources,
  onPick }: { groups: SettingsView['environment']['variables']; sources: SourceView[]; onPick: (key: string) => void }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const owner = (id: string) => id === 'executor' ? t('term.executor') : localized(t, sources.find(source => source.id === id)?.title ?? id)
  const count = groups.reduce((sum, group) => sum + group.variables.length, 0)
  return <DisclosureRow icon={<Icon name="hash" />} title={<>{t('environmentVariables')} <span className="dt-count">{count}</span></>}
    open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('environmentPick')}</Hint>
      <table className="dt-table">
        <thead><tr><th>{t('environmentKey')}</th><th>{t('environmentDescription')}</th><th>{t('environmentOwner')}</th></tr></thead>
        <tbody>{groups.flatMap(group => group.variables.map(variable => <tr key={variable.key}>
          <td><button type="button" className="dt-textlink dt-mono" onClick={() => onPick(variable.key)}>{variable.key}</button></td>
          <td title={localized(t, variable.description)}>{firstSentence(localized(t, variable.description))}</td>
          <td>{owner(group.owner)}{!group.enabled && <span className="dt-hint"> · {t('sourceOff')}</span>}</td>
        </tr>))}</tbody>
      </table>
    </div>
  </DisclosureRow>
}
export function ExecutionSettings() {
  const { t } = usePanel()
  const { blocks, environment, sources } = useSettings().settings
  // Keep raw user text (such as separators between blocked commands) in the draft and parse only on save.
  const executor = blocks.executor.value
  const saved = { ...executor, maxWorkers: String(executor.maxWorkers), blockedCommands: executor.blockedCommands.join(' ') }
  const draft = useBlockDraft('executor', saved, blocks.executor.revision,
    value => ({ ...value, maxWorkers: numberOf(value.maxWorkers), blockedCommands: value.blockedCommands.split(/[\s,]+/).filter(Boolean) }))
  const value = draft.value
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next })
  const prepare = useRef<HTMLTextAreaElement>(null)
  const insert = (key: string) => {
    const field = prepare.current
    const at = field?.selectionStart ?? value.prepare.length, to = field?.selectionEnd ?? at
    edit({ prepare: `${value.prepare.slice(0, at)}"$${key}"${value.prepare.slice(to)}` })
    requestAnimationFrame(() => { field?.focus(); const caret = at + key.length + 3; field?.setSelectionRange(caret, caret) })
  }
  return <div className="dt-form">
    <form className="dt-form" onSubmit={event => { void draft.submit(event) }}>
      <Fields disabled={draft.busy}>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.executor')}<InfoTip text={t('executorIntro')} /></h2>
          <Section title={t('executorModel')} hint={t('executorModelHint')}><ModelField id="dt-worker-model" value={value.model}
            onChange={model => edit({ model })} /></Section>
          <Field label={t('maxWorkers')} hint={t('maxWorkersHint')}>
            <Input type="number" min={LIMITS.maxWorkers.min} max={LIMITS.maxWorkers.max} required value={value.maxWorkers}
              onChange={event => edit({ maxWorkers: event.target.value })} />
          </Field>
        </div>
        <div className="dt-form dt-block">
          <h2 className="dt-block-title">{t('term.environment')}<InfoTip text={t('environmentIntro')} /></h2>
          <Field label={t('executionDirectory')} hint={t('executionDirectoryHint')} note={value.directory ? undefined
            : t('executionDirectoryDefault', { root: environment.root })}>
            <Input className="dt-mono" value={value.directory} placeholder={t('executionDirectoryEmpty')} spellCheck={false} pattern="/.*"
              onChange={event => edit({ directory: event.target.value })} />
          </Field>
          <Field label={t('prepareCommand')} hint={t('prepareCommandHint')}>
            <textarea ref={prepare} className="dt-textarea dt-mono" rows={3} maxLength={LIMITS.prepareCommand} spellCheck={false}
              placeholder={t('prepareCommandEmpty')} value={value.prepare}
              onChange={event => edit({ prepare: event.target.value })} />
          </Field>
          <EnvironmentVariables groups={environment.variables} sources={sources} onPick={insert} />
          <Field label={t('blockedCommands')} hint={t('blockedCommandsHint')}>
            <Input className="dt-mono" value={value.blockedCommands} placeholder={t('blockedCommandsNone')} spellCheck={false}
              onChange={event => edit({ blockedCommands: event.target.value })} />
          </Field>
          <Section title={t('workspaceOptions')} hint={t('workspaceOptionsHint')}>
            <label className="dt-hint" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
              <input type="checkbox" checked={value.workspace.lease}
                onChange={event => edit({ workspace: { ...value.workspace, lease: event.target.checked } })} />
              {t('workspaceLease')}
            </label>
            <label className="dt-hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={value.workspace.childSibling}
                onChange={event => edit({ workspace: { ...value.workspace, childSibling: event.target.checked } })} />
              {t('workspaceChildSibling')}
            </label>
          </Section>
        </div>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
    <ConfigHistory blocks={['executor', 'pause']} />
  </div>
}
