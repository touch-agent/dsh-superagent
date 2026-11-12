/**
 * Settings › Agent profiles: the E2 management surface for the versioned execution registry. A person can see which
 * profile new Tickets bind, create an immutable revision, activate or roll back a revision, disable a profile and read
 * field-level telemetry. The surface never edits authorization: it shows execution fields only, rejects no field in the
 * client that the server would accept, and never displays an internal profile id on the default list.
 */
import { useEffect, useState } from 'react'
import type { ProfileDetailView, ProfileListView } from '../app/profiles.ts'
import type { ProfileMetricsView } from '../app/profile-metrics.ts'
import { SUBAGENT_CONTROL, WORK_TOOL_NAMES } from '../app/work-tools.ts'
import type { PromptsView, SettingsView } from './api.ts'
import { usePoll } from './api.ts'
import { Button, Icon, InfoTip, Input, Modal, SegmentedControl, Switch, Tag } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { useSettings } from './settings-kit.tsx'
import { errorText, when } from './text.ts'
import { ConfirmButton, Hint, KeyValues, LoadState, Section, When } from './widgets.tsx'

type ProfileRow = ProfileListView['profiles'][number]
type ProfileConfig = ProfileListView['config']
type Model = NonNullable<SettingsView['blocks']['executor']['value']['model']>
const BUILTIN = 'worker-default'
// A pinned model cannot force a subagent's model, so the server removes these control tools from the effective set.
const SELECTABLE_WORK_TOOLS = WORK_TOOL_NAMES.filter(name => !SUBAGENT_CONTROL.has(name))
/** A draft id derived from the title, hidden under Advanced unless the operator sets it explicitly. */
function generatedId(title: string): string {
  const slug = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug ? `worker-${slug}`.slice(0, 80).replace(/-+$/g, '') : `worker-${Date.now().toString(36)}`
}
const modelLabel = (model: { mode: 'inherit' } | { mode: 'pinned'; provider: string; model: string; reasoningEffort?: string }): string =>
  model.mode === 'inherit' ? 'inherit' : `${model.provider}/${model.model}${model.reasoningEffort ? ` · ${model.reasoningEffort}` : ''}`
const toolLabel = (names: readonly string[]): string => names.length ? names.join(' · ') : '—'

/** The settings group's page. */
export function ProfilesPage() {
  const { t, call, notify } = usePanel()
  const { settings } = useSettings()
  const { data, error, reload } = usePoll(() => call('GET profiles'), [])
  const { data: prompts } = usePoll(() => call('GET prompts'), [])
  const [selected, setSelected] = useState<string>()
  const [editing, setEditing] = useState<'create' | ProfileDetailView>()
  const [failure, setFailure] = useState<string>()
  const approved = settings.blocks.executor.value.model
  const rows = data?.profiles ?? []
  const activeDefault = data?.config.defaultProfile ?? BUILTIN
  const defaultRow = rows.find(row => row.id === activeDefault)
  const warnDefault = data?.config.enabled === true && (!defaultRow || defaultRow.disabled)
  const refresh = async () => { await reload(); setFailure(undefined) }
  const action = async (run: () => Promise<unknown>) => {
    try { await run(); await refresh(); notify(t('saved')) } catch (error) { setFailure(errorText(error)) }
  }
  return <div className="dt-form">
    <Hint>{t('profilesIntro')}</Hint>
    {failure && <p className="dt-hint" role="alert">{failure}</p>}
    <ConfigSwitch config={data?.config} rows={rows} disabled={!data} onSaved={refresh} />
    <Section title={t('profilesList')} count={rows.length} hint={t('profilesListHint')} icon="user"
      action={<Button variant="outline" icon={<Icon name="plus" size={14} />} disabled={!approved} onClick={() => setEditing('create')}>
        {t('profilesCreate')}</Button>}>
      {!approved && <Hint>{t('profilesModelMissing')}</Hint>}
      {warnDefault && <p className="dt-hint" role="alert">{t('profilesDefaultWarning')}</p>}
      <LoadState error={error} loading={!data} />
      {data && (rows.length ? <ul className="dt-list">{rows.map(row => <ProfileLine key={row.id} row={row} defaultProfile={activeDefault}
        selected={selected === row.id} onOpen={() => setSelected(row.id)} onToggle={() => void action(() => call('POST profiles/:id/enabled',
          { id: row.id, body: { enabled: row.disabled, reason: t('profilesReasonPanel') } }))} />)}</ul>
        : <Hint>{t('profilesEmpty')}</Hint>)}
    </Section>
    {selected && <ProfileDetail key={selected} id={selected} config={data?.config} onChanged={refresh}
      onEdit={detail => setEditing(detail)} onClose={() => setSelected(undefined)} onAction={action} />}
    {editing && <ProfileEditor mode={editing === 'create' ? 'create' : 'edit'} detail={editing === 'create' ? undefined : editing}
      approved={approved} prompts={prompts} onClose={() => setEditing(undefined)} onSaved={async id => {
        await refresh(); setSelected(id); setEditing(undefined)
      }} />}
  </div>
}

/** The independent fallback switches. Each save sends only operator fields; no Value enters SettingsSchema. */
function ConfigSwitch({ config, rows, disabled, onSaved }: { config: ProfileConfig | undefined; rows: ProfileRow[]; disabled: boolean
  onSaved: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const [draft, setDraft] = useState<ProfileConfig | undefined>(config)
  const [savedAt, setSavedAt] = useState(config?.updatedAt)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  useEffect(() => {
    if (!draft && config) { setDraft(config); setSavedAt(config.updatedAt) }
    else if (config?.updatedAt !== savedAt) { setDraft(config); setSavedAt(config?.updatedAt); setFailure(undefined) }
  }, [config?.updatedAt, config, draft, savedAt])
  if (!draft) return <Section title={t('profilesFeature')} hint={t('profilesFeatureHint')} icon="shield"><Hint>{t('loading')}</Hint></Section>
  const dirty = JSON.stringify({ enabled: draft.enabled, resolve: draft.resolve, telemetry: draft.telemetry,
    defaultProfile: draft.defaultProfile }) !== JSON.stringify({ enabled: config?.enabled, resolve: config?.resolve,
    telemetry: config?.telemetry, defaultProfile: config?.defaultProfile })
  const save = async () => {
    setBusy(true); setFailure(undefined)
    try {
      await call('PUT profiles/config', { body: { enabled: draft.enabled, resolve: draft.resolve, telemetry: draft.telemetry,
        ...draft.defaultProfile ? { defaultProfile: draft.defaultProfile } : {}, reason: t('profilesReasonPanel') } })
      notify(t('saved')); await onSaved()
    } catch (error) { setFailure(errorText(error)) } finally { setBusy(false) }
  }
  return <Section title={t('profilesFeature')} hint={t('profilesFeatureHint')} icon="shield"
    action={<Button variant="outline" disabled={disabled || busy || !dirty} onClick={() => void save()}>{t('profilesConfigSave')}</Button>}>
    <div className="dt-form dt-block">
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('profilesEnabled')}<InfoTip text={t('profilesEnabledHint')} /></div>
        <Switch checked={draft.enabled} label={t('profilesEnabled')} onChange={enabled => setDraft({ ...draft, enabled })} />
      </div>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('profilesTelemetry')}<InfoTip text={t('profilesTelemetryHint')} /></div>
        <Switch checked={draft.telemetry} label={t('profilesTelemetry')} onChange={telemetry => setDraft({ ...draft, telemetry })} />
      </div>
      <div className="dt-field">
        <span className="dt-field-head">{t('profilesResolve')}<InfoTip text={t('profilesResolveHint')} /></span>
        <SegmentedControl label={t('profilesResolve')} value={draft.resolve} onChange={resolve => setDraft({ ...draft, resolve })}
          options={[{ value: 'snapshot', label: t('profilesResolveSnapshot') }, { value: 'legacy', label: t('profilesResolveLegacy') }]} />
      </div>
      <div className="dt-field">
        <span className="dt-field-head"><label htmlFor="dt-profile-default">{t('profilesDefault')}</label><InfoTip text={t('profilesDefaultHint')} /></span>
        <select id="dt-profile-default" className="dt-select" value={draft.defaultProfile ?? BUILTIN}
          onChange={event => setDraft({ ...draft, defaultProfile: event.target.value === BUILTIN ? undefined : event.target.value })}>
          {rows.map(row => <option key={row.id} value={row.id}>{row.title}{row.disabled ? ` · ${t('profilesDisabled')}` : ''}</option>)}
        </select>
      </div>
      {warnForDefault(draft, rows) && <Hint>{t('profilesDefaultWarning')}</Hint>}
      {failure && <p className="dt-hint" role="alert">{failure}</p>}
    </div>
  </Section>
}
function warnForDefault(config: ProfileConfig, rows: ProfileRow[]): boolean {
  if (!config.enabled) return false
  const row = rows.find(item => item.id === (config.defaultProfile ?? BUILTIN))
  return !row || row.disabled
}

/** One list row: title, description, active version and status. The internal id stays out of this default list. */
function ProfileLine({ row, defaultProfile, selected, onOpen, onToggle }: { row: ProfileRow; defaultProfile: string
  selected: boolean; onOpen: () => void; onToggle: () => void }) {
  const { t } = usePanel()
  const builtin = row.id === BUILTIN
  const status = row.disabled ? 'profilesDisabled' : builtin ? 'profilesBuiltin' : row.moving ? 'profilesMoving' : 'profilesCustom'
  return <li className="dt-row" data-selected={selected || undefined}>
    <div className="dt-row-main">
      <div className="dt-row-title">
        <button type="button" className="dt-open" onClick={onOpen}>{row.title}</button>
        <Tag tone={row.disabled ? 'quiet' : defaultProfile === row.id ? 'success' : 'outline'}>
          {row.disabled ? t('profilesDisabled') : defaultProfile === row.id ? t('profilesActive') : t(status)}
        </Tag>
        <span className="dt-hint">{t('profilesVersion', { revision: row.activeRevision })}</span>
      </div>
      <div className="dt-row-meta"><span>{row.description}</span></div>
      <div className="dt-row-meta">
        <span>{row.lastBoundAt ? t('profilesLastBound', { at: when(row.lastBoundAt, t('lang')) }) : t('profilesNeverBound')}</span>
        <button type="button" className="dt-textlink" onClick={onOpen}>{t('profilesDetails')}</button>
        {!builtin && <button type="button" className="dt-textlink" onClick={onToggle}>
          {row.disabled ? t('profilesEnable') : t('profilesDisable')}</button>}
      </div>
    </div>
  </li>
}
/** One profile's immutable versions, state, technical detail and field-level telemetry. */
function ProfileDetail({ id, config, onChanged, onEdit, onClose, onAction }: { id: string; config: ProfileConfig | undefined
  onChanged: () => Promise<void>; onEdit: (detail: ProfileDetailView) => void; onClose: () => void
  onAction: (run: () => Promise<unknown>) => Promise<void> }) {
  const { t, call } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET profiles/:id', { id }), [id])
  const [metricsOpen, setMetricsOpen] = useState(false)
  const [technical, setTechnical] = useState(false)
  const telemetry = config?.telemetry !== false
  const { data: metrics, error: metricsError } = usePoll(() => metricsOpen && telemetry
    ? call('GET profiles/:id/metrics', { id }) : Promise.resolve(undefined), [id, metricsOpen, telemetry])
  if (!data) return <Section title={t('profilesDetails')} action={<Button onClick={onClose}>{t('close')}</Button>}>
    <LoadState error={error} loading /></Section>
  const profile = data.profile, head = data.head, builtin = id === BUILTIN
  const reloadAll = async () => { await reload(); await onChanged() }
  return <Section title={profile.title} hint={profile.description} count={t('profilesVersion', { revision: head.activeRevision })}
    icon="user" action={<><Button variant="ghost" onClick={onClose}>{t('close')}</Button></>}>
    <KeyValues rows={[
      [t('profilesState'), head.disabled ? t('profilesStateDisabled') : t('profilesStateEnabled')],
      [t('profilesModel'), modelLabel(profile.model)],
      [t('profilesToolsLabel'), toolLabel((profile.tools.mode === 'list' ? [...profile.tools.names] : [...WORK_TOOL_NAMES])
        .filter(name => profile.model.mode !== 'pinned' || !SUBAGENT_CONTROL.has(name)).sort())],
      [t('profilesPromptLabel'), profile.prompt.mode === 'pinned' ? t('profilesVersion', { revision: profile.prompt.revision }) : 'live'],
      [t('profilesLastBoundLabel'), head.lastBoundAt ? <When at={head.lastBoundAt} /> : t('profilesNeverBound')],
    ]} />
    <div className="dt-row-actions">
      {!builtin && <Button variant="outline" icon={<Icon name="plus" size={14} />} onClick={() => onEdit(data)}>{t('profilesEdit')}</Button>}
      {!builtin && (head.disabled
        ? <Button variant="outline" icon={<Icon name="play" size={14} />} onClick={() => void onAction(() => call('POST profiles/:id/enabled',
          { id, body: { enabled: true, reason: t('profilesReasonPanel') } }).then(reloadAll))}>{t('profilesEnable')}</Button>
        : <ConfirmButton label={t('profilesDisable')} title={t('profilesDisable')} message={t('profilesDisableConfirm')}
          onConfirm={() => call('POST profiles/:id/enabled', { id, body: { enabled: false, reason: t('profilesReasonPanel') } }).then(reloadAll)} />)}
      {head.previousActiveRevision !== undefined && <ConfirmButton label={t('profilesRollback')} title={t('profilesRollback')}
        message={t('profilesRollbackConfirm', { revision: head.previousActiveRevision })} onConfirm={() => call('POST profiles/:id/rollback',
          { id, body: { reason: t('profilesReasonPanel') } }).then(reloadAll)} />}
    </div>
    <table className="dt-table">
      <thead><tr><th>{t('profilesVersions')}</th><th>{t('profilesState')}</th><th>{t('profilesSavedAt')}</th>
        <th>{t('profilesReason')}</th><th /></tr></thead>
      <tbody>{[...data.revisions].sort((left, right) => right.revision - left.revision).map(revision => {
        const current = revision.revision === head.activeRevision
        const retired = head.retiredRevisions.includes(revision.revision)
        return <tr key={revision.revision}>
          <td>{t('profilesVersion', { revision: revision.revision })}</td>
          <td>{current ? <Tag tone="success">{t('profilesCurrent')}</Tag> : retired ? <Tag>{t('profilesRetired')}</Tag> : <Tag tone="quiet">{t('profilesHistory')}</Tag>}</td>
          <td><When at={revision.provenance.at} /></td>
          <td className="dt-clamp">{revision.provenance.reason}</td>
          <td className="dt-row-actions">
            {!current && <button type="button" className="dt-textlink" onClick={() => void onAction(() => call('POST profiles/:id/activate',
              { id, body: { revision: revision.revision, reason: t('profilesReasonPanel') } }).then(reloadAll))}>{t('profilesActivate')}</button>}
            {!current && !retired && <ConfirmButton label={t('profilesRetire')} title={t('profilesRetire')} message={t('profilesRetireConfirm')}
              onConfirm={() => call('POST profiles/:id/retire', { id, body: { revision: revision.revision,
                reason: t('profilesReasonPanel') } }).then(reloadAll)} />}
          </td>
        </tr>
      })}</tbody>
    </table>
    <div className="dt-form dt-block">
      <div className="dt-field-head">{t('profilesMetricsTitle')}<InfoTip text={t('profilesMetricsHint')} /></div>
      {!telemetry ? <Hint>{t('profilesMetricsOff')}</Hint> : <>
        <div className="dt-row-actions"><Button variant="ghost" onClick={() => setMetricsOpen(!metricsOpen)}>
          {metricsOpen ? t('collapse') : t('profilesMetrics')}</Button></div>
        {metricsOpen && <LoadState error={metricsError} loading={!metrics && !metricsError} />}
        {metricsOpen && metrics && (metrics.groups.length ? <MetricsTable metrics={metrics} /> : <Hint>{t('profilesMetricsEmpty')}</Hint>)}
      </>}
    </div>
    <div className="dt-details">
      <button type="button" className="dt-textlink" aria-expanded={technical} onClick={() => setTechnical(!technical)}>{t('profilesTech')}</button>
      {technical && <KeyValues rows={[[t('profilesIdLabel'), <code key="id" className="dt-mono">{id}</code>],
        [t('profilesContentHash'), <code key="hash" className="dt-mono">{profile.contentHash}</code>]]} />}
    </div>
  </Section>
}

/** Field-level telemetry: one row per effective configuration (model, prompt revision, work-tool hash). */
function MetricsTable({ metrics }: { metrics: ProfileMetricsView }) {
  const { t } = usePanel()
  const rate = (value: { n: number; rate: number | null; suppressed: boolean; successes: number }): string =>
    value.suppressed || value.rate === null ? (value.n ? `<5` : '—') : `${Math.round(value.rate * 100)}% (${value.successes}/${value.n})`
  return <table className="dt-table">
    <thead><tr><th>{t('profilesEffective')}</th><th>{t('profilesPromptRevision')}</th><th>{t('profilesModel')}</th>
      <th>{t('profilesTickets')}</th><th>{t('profilesSuccess')}</th><th>{t('profilesTokens')}</th></tr></thead>
    <tbody>{metrics.groups.map(group => <tr key={group.effectiveHash}>
      <td><code className="dt-mono" title={group.effectiveHash}>{group.effectiveHash.slice(0, 15)}…</code>
        {group.moving && <Tag tone="quiet">{t('profilesMoving')}</Tag>}</td>
      <td>{t('profilesVersion', { revision: group.promptRevision })}</td>
      <td>{group.model.provider}/{group.model.model}</td>
      <td>{group.tickets}{group.fallback ? ` · ${t('profilesFallback', { count: group.fallback })}` : ''}</td>
      <td>{rate(group.success)}</td>
      <td>{group.tokens.state === 'available' ? `${group.tokens.input ?? 0} / ${group.tokens.output ?? 0}` : t('profilesUnknown')}</td>
    </tr>)}</tbody>
  </table>
}

/** Create a new profile or add an immutable revision. The model is read-only and must equal the approved worker model. */
function ProfileEditor({ mode, detail, approved, prompts, onClose, onSaved }: { mode: 'create' | 'edit'
  detail: ProfileDetailView | undefined; approved: Model | null; prompts: PromptsView | undefined; onClose: () => void
  onSaved: (id: string) => Promise<void> }) {
  const { t, call } = usePanel()
  const [title, setTitle] = useState(detail?.profile.title ?? '')
  const [description, setDescription] = useState(detail?.profile.description ?? '')
  const [reason, setReason] = useState(t('profilesReasonPanel'))
  const [id, setId] = useState(detail?.profile.id ?? generatedId(''))
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [tools, setTools] = useState<readonly string[]>(() => detail?.profile.tools.mode === 'list'
    ? detail.profile.tools.names.filter(name => !SUBAGENT_CONTROL.has(name)) : SELECTABLE_WORK_TOOLS)
  const [promptRevision, setPromptRevision] = useState<number>(() => detail?.profile.prompt.mode === 'pinned'
    ? detail.profile.prompt.revision : prompts?.current.revision ?? 0)
  const revisions = prompts?.revisions ?? []
  const submit = async () => {
    if (!approved) return
    setBusy(true); setFailure(undefined)
    const profile = { id: mode === 'create' ? id : detail!.profile.id, role: 'worker', title: title.trim(), description: description.trim(),
      model: { mode: 'pinned', provider: approved.provider, model: approved.model,
        ...approved.reasoningEffort ? { reasoningEffort: approved.reasoningEffort } : {} },
      tools: { mode: 'list', names: [...tools].sort() }, prompt: { mode: 'pinned', revision: promptRevision } }
    try {
      if (mode === 'create') await call('POST profiles', { body: { profile, reason: reason.trim() } })
      else await call('POST profiles/:id/revisions', { id: profile.id, body: { profile, reason: reason.trim(),
        baseRevision: detail!.head.activeRevision } })
      await onSaved(profile.id)
    } catch (error) { setFailure(errorText(error)) } finally { setBusy(false) }
  }
  const toggle = (name: string) => setTools(current => current.includes(name) ? current.filter(item => item !== name) : [...current, name])
  return <Modal open title={mode === 'create' ? t('profilesCreate') : t('profilesEdit')} closeLabel={t('close')} onClose={onClose}
    description={t('profilesEditorHint')} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy || !approved || !title.trim() || !description.trim() || !reason.trim()}
        onClick={() => void submit()}>{busy ? t('saving') : t('profilesSave')}</Button>
    </>}>
    <div className="dt-form">
      <label className="dt-field"><span className="dt-field-head">{t('profilesTitleLabel')}</span>
        <Input aria-label={t('profilesTitleLabel')} value={title} maxLength={120} onChange={event => { setTitle(event.target.value)
          if (mode === 'create' && !advanced) setId(generatedId(event.target.value)) }} /></label>
      <label className="dt-field"><span className="dt-field-head">{t('profilesDescriptionLabel')}</span>
        <textarea className="dt-textarea" aria-label={t('profilesDescriptionLabel')} rows={3} maxLength={2000} value={description}
          onChange={event => setDescription(event.target.value)} /></label>
      <label className="dt-field"><span className="dt-field-head">{t('profilesReasonLabel')}</span>
        <Input aria-label={t('profilesReasonLabel')} value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label>
      <div className="dt-field"><span className="dt-field-head">{t('profilesModel')}<InfoTip text={t('profilesModelPinnedHint')} /></span>
        <p className="dt-hint">{approved ? modelLabel({ mode: 'pinned', ...approved }) : t('profilesModelMissing')}</p></div>
      <div className="dt-field"><span className="dt-field-head">{t('profilesToolsLabel')}<InfoTip text={t('profilesToolsHint')} /></span>
        <div className="dt-checkgrid">{SELECTABLE_WORK_TOOLS.map(name => <label key={name} className="dt-check">
          <input type="checkbox" checked={tools.includes(name)} onChange={() => toggle(name)} />{name}</label>)}</div></div>
      <div className="dt-field"><span className="dt-field-head">{t('profilesPromptLabel')}<InfoTip text={t('profilesPromptHint')} /></span>
        <select className="dt-select" value={promptRevision} onChange={event => setPromptRevision(Number(event.target.value))}>
          {revisions.map(revision => <option key={revision.revision} value={revision.revision}>
            {t('profilesVersion', { revision: revision.revision })}{revision.revision === prompts?.current.revision ? ` · ${t('profilesCurrent')}` : ''}
          </option>)}
        </select></div>
      <details className="dt-details" open={advanced} onToggle={event => setAdvanced((event.target as HTMLDetailsElement).open)}>
        <summary>{t('profilesAdvanced')}</summary>
        <label className="dt-field"><span className="dt-field-head">{t('profilesIdLabel')}<InfoTip text={t('profilesIdHint')} /></span>
          <Input className="dt-mono" aria-label={t('profilesIdLabel')} value={id} disabled={mode === 'edit'} spellCheck={false}
            onChange={event => setId(event.target.value)} /></label>
      </details>
      {failure && <p className="dt-hint" role="alert">{failure}</p>}
    </div>
  </Modal>
}
