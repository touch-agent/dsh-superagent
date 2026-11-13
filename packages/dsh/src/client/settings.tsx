/** Settings tab shell routing between stage settings (Sources, Triggers, Eval, Execution), display preferences, Prompts, and Deployment. */
import { useState } from 'react'
import type { DecisionFilter, StateView } from './api.ts'
import type { TicketFilter } from '../app/api.ts'
import { Button, Icon, InfoTip, Switch, type IconName } from './controls.tsx'
import { BUILD, buildMismatch, reloadClient } from './build.ts'
import { ERROR_AGGREGATE, EVENTS_AUTO_OPEN, FILES_PAGE, FIRST_USE, MASTER_CARD, NAV_FOUR, NOTICE_BUTTON, NOTIFY_DRAWER,
  NOTIFY_OVERLAY, OPS_IN_SETTINGS, TASK_DETAIL_V2, TASK_HIERARCHY, autoOpenPreference, featureEnabled, notifyAutoDismiss,
  opsInSettings, restoreFirstUse, setAutoOpenPreference, setFeature, setNotifyAutoDismiss } from './features.ts'
import { Hint } from './widgets.tsx'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings, EvalStatus } from './eval.tsx'
import { ExecutionSettings, ExecutionStatus } from './execution.tsx'
import { ProfilesPage } from './profiles.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { DEFAULT_SETTINGS_GROUPS, SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
import { SettingsProvider } from './settings-kit.tsx'
import { fullTime } from './text.ts'
import { SourceSettings, SourceStatus } from './source.tsx'
import { TriggerStatus } from './trigger.tsx'

const STAGE_GROUPS: readonly SettingsGroup[] = ['source', 'trigger', 'eval', 'execution']
/** The operations pages keep the same one-line boundary inside Settings as they had as tabs. */
const OPS_GROUPS: readonly SettingsGroup[] = STAGE_GROUPS
const NAV: readonly { title: 'settingsNav.work' | 'settingsNav.interface' | 'settingsNav.system'; items: readonly SettingsGroup[] }[] = [
  { title: 'settingsNav.work', items: ['source', 'trigger', 'eval', 'execution', 'profiles'] },
  { title: 'settingsNav.interface', items: ['display', 'prompts'] },
  { title: 'settingsNav.system', items: ['deployment'] },
]
/** One icon per page, drawn from the panel's own SVG set so no emoji or remote asset enters the default surface. */
const GROUP_ICON: Record<SettingsGroup, IconName> = { source: 'inbox', trigger: 'message', eval: 'decision', execution: 'running',
  profiles: 'user', display: 'bell', prompts: 'hash', deployment: 'shield' }
/** The visible groups: with the batch-2 switch off, trigger stays a tab and the old settings list returns unchanged. */
export function settingsGroups(consolidated = opsInSettings()): readonly SettingsGroup[] {
  return consolidated ? SETTINGS_GROUPS : DEFAULT_SETTINGS_GROUPS
}
/**
 * Display preferences belong to this browser, like the unread cursor: they are not policy and are not saved to the Store.
 * The Events tab's first automatic open is a trust-phase exception and defaults off in the stable phase.
 */
function DisplaySettings() {
  const { t, notify } = usePanel()
  const { state } = usePanelData()
  const server = state?.build
  const mismatch = buildMismatch(BUILD, server)
  const [autoOpen, setAutoOpen] = useState(autoOpenPreference)
  const [overlay, setOverlay] = useState(() => featureEnabled(NOTIFY_OVERLAY))
  const [autoDismiss, setAutoDismiss] = useState(notifyAutoDismiss)
  const [drawer, setDrawer] = useState(() => featureEnabled(NOTIFY_DRAWER))
  const [hierarchy, setHierarchy] = useState(() => featureEnabled(TASK_HIERARCHY))
  const [aggregate, setAggregate] = useState(() => featureEnabled(ERROR_AGGREGATE))
  const [consolidated, setConsolidated] = useState(() => featureEnabled(OPS_IN_SETTINGS))
  const [detail, setDetail] = useState(() => featureEnabled(TASK_DETAIL_V2))
  const [onboarding, setOnboarding] = useState(() => featureEnabled(FIRST_USE))
  const [fourNav, setFourNav] = useState(() => featureEnabled(NAV_FOUR))
  const [card, setCard] = useState(() => featureEnabled(MASTER_CARD))
  const [button, setButton] = useState(() => featureEnabled(NOTICE_BUTTON))
  const [files, setFiles] = useState(() => featureEnabled(FILES_PAGE))
  const available = featureEnabled(EVENTS_AUTO_OPEN)
  return <div className="dt-form">
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('displayAttention')}<InfoTip text={t('displayAttentionHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('eventsAutoOpenSetting')}<InfoTip text={t('eventsAutoOpenHint')} /></div>
        <Switch checked={autoOpen} label={t('eventsAutoOpenSetting')} onChange={next => { setAutoOpen(next)
          setAutoOpenPreference(next) }} />
      </div>
      <Hint>{available ? t('eventsAutoOpenStable') : t('eventsAutoOpenDisabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('notificationOverlaySection')}<InfoTip text={t('notificationOverlayHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('notificationOverlaySetting')}<InfoTip text={t('notificationOverlayHint')} /></div>
        <Switch checked={overlay} label={t('notificationOverlaySetting')} onChange={next => { setOverlay(next)
          setFeature(NOTIFY_OVERLAY, next) }} />
      </div>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('notificationAutoDismissSetting')}<InfoTip text={t('notificationAutoDismissHint')} /></div>
        <Switch checked={autoDismiss} label={t('notificationAutoDismissSetting')} onChange={next => { setAutoDismiss(next)
          setNotifyAutoDismiss(next) }} />
      </div>
      <Hint>{overlay ? t('notificationOverlayHint') : t('notificationOverlayDisabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('notificationDrawerSection')}<InfoTip text={t('notificationDrawerHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('notificationDrawerSetting')}</div>
        <Switch checked={drawer} label={t('notificationDrawerSetting')} onChange={next => { setDrawer(next)
          setFeature(NOTIFY_DRAWER, next) }} />
      </div>
      <Hint>{t('notificationDrawerHint')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('taskHierarchySection')}<InfoTip text={t('taskHierarchyHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('taskHierarchySetting')}<InfoTip text={t('taskHierarchyHint')} /></div>
        <Switch checked={hierarchy} label={t('taskHierarchySetting')} onChange={next => { setHierarchy(next)
          setFeature(TASK_HIERARCHY, next) }} />
      </div>
      <Hint>{hierarchy ? t('taskHierarchyHint') : t('taskHierarchyDisabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('errorAggregateSection')}<InfoTip text={t('errorAggregateHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('errorAggregateSetting')}<InfoTip text={t('errorAggregateHint')} /></div>
        <Switch checked={aggregate} label={t('errorAggregateSetting')} onChange={next => { setAggregate(next)
          setFeature(ERROR_AGGREGATE, next) }} />
      </div>
      <Hint>{aggregate ? t('errorAggregateHint') : t('errorAggregateDisabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('opsInSettingsSection')}<InfoTip text={t('opsInSettingsHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('opsInSettingsSetting')}<InfoTip text={t('opsInSettingsHint')} /></div>
        <Switch checked={consolidated} label={t('opsInSettingsSetting')} onChange={next => { setConsolidated(next)
          setFeature(OPS_IN_SETTINGS, next) }} />
      </div>
      <Hint>{consolidated ? t('opsInSettingsHint') : t('opsInSettingsDisabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('taskDetailV2Section')}<InfoTip text={t('taskDetailV2Hint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('taskDetailV2Setting')}<InfoTip text={t('taskDetailV2Hint')} /></div>
        <Switch checked={detail} label={t('taskDetailV2Setting')} onChange={next => { setDetail(next)
          setFeature(TASK_DETAIL_V2, next) }} />
      </div>
      <Hint>{detail ? t('taskDetailV2Hint') : t('taskDetailV2Disabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('navFourSection')}<InfoTip text={t('navFourHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('navFourSetting')}<InfoTip text={t('navFourHint')} /></div>
        <Switch checked={fourNav} label={t('navFourSetting')} onChange={next => { setFourNav(next); setFeature(NAV_FOUR, next) }} />
      </div>
      <Hint>{fourNav ? t('navFourHint') : t('navFourDisabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('masterCardSection')}<InfoTip text={t('masterCardHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('masterCardSetting')}<InfoTip text={t('masterCardHint')} /></div>
        <Switch checked={card} label={t('masterCardSetting')} onChange={next => { setCard(next); setFeature(MASTER_CARD, next) }} />
      </div>
      <Hint>{card ? t('masterCardHint') : t('masterCardDisabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('noticeButtonSection')}<InfoTip text={t('noticeButtonHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('noticeButtonSetting')}<InfoTip text={t('noticeButtonHint')} /></div>
        <Switch checked={button} label={t('noticeButtonSetting')} onChange={next => { setButton(next); setFeature(NOTICE_BUTTON, next) }} />
      </div>
      <Hint>{button ? t('noticeButtonHint') : t('noticeButtonDisabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('filesSection')}<InfoTip text={t('filesHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('filesSetting')}<InfoTip text={t('filesHint')} /></div>
        <Switch checked={files} label={t('filesSetting')} onChange={next => { setFiles(next); setFeature(FILES_PAGE, next) }} />
      </div>
      <Hint>{files ? t('filesHint') : t('filesDisabled')}</Hint>
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('firstUseSection')}<InfoTip text={t('firstUseHint')} /></h2>
      <div className="dt-switch-row">
        <div className="dt-field-head">{t('firstUseSetting')}<InfoTip text={t('firstUseHint')} /></div>
        <Switch checked={onboarding} label={t('firstUseSetting')} onChange={next => { setOnboarding(next)
          setFeature(FIRST_USE, next) }} />
      </div>
      <Hint>{onboarding ? t('firstUseHint') : t('firstUseDisabled')}</Hint>
      {onboarding && <div className="dt-row-buttons">
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
          onClick={() => { restoreFirstUse(); notify(t('firstUseRestored')) }}>{t('firstUseRestore')}</Button>
      </div>}
    </div>
    <div className="dt-form dt-block">
      <h2 className="dt-block-title">{t('displayBuild')}<InfoTip text={t('displayBuildHint')} /></h2>
      <dl className="dt-kv">
        <dt>{t('buildVersion')}</dt><dd>v{BUILD.version}</dd>
        <dt>{t('buildCommit')}</dt><dd><code className="dt-code">{BUILD.commit}</code>{BUILD.dirty && ` + ${t('buildDirty')}`}</dd>
        <dt>{t('buildBuiltAt')}</dt><dd>{BUILD.builtAt ? fullTime(BUILD.builtAt, t('lang')) : t('buildUnknown')}</dd>
        <dt>{t('buildClientId')}</dt><dd><code className="dt-code">{BUILD.buildId}</code></dd>
        <dt>{t('buildServerId')}</dt><dd><code className="dt-code">{server?.buildId ?? t('buildUnknown')}</code></dd>
      </dl>
      <div className="dt-row-actions">
        {mismatch && <span className="dt-error">{t('buildMismatchShort')}</span>}
        <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
          onClick={() => { void reloadClient() }}>{t('buildReload')}</Button>
      </div>
      <Hint>{mismatch ? t('buildMismatchHint') : t('buildHint')}</Hint>
    </div>
  </div>
}

export function SettingsPage({ group, query, state, deploymentForm, triggerFilter, ops = {} }: {
  group: SettingsGroup; query: { source?: string; version?: string }; state?: StateView; deploymentForm: DeploymentForm
  triggerFilter?: Parameters<typeof TriggerStatus>[0]['filter']
  /** The direct-link filters an operations list opened from Overview or a notice carries into this page. */
  ops?: { filter?: string; window?: '24h'; from?: 'conversation' }
}) {
  const { t, navigate } = usePanel()
  const { reload } = usePanelData()
  const consolidated = opsInSettings()
  const groups = settingsGroups(consolidated)
  const live = consolidated ? (() => {
    switch (group) {
      case 'source': return <SourceStatus embedded />
      case 'trigger': return <TriggerStatus filter={triggerFilter ?? 'subscribed'} />
      case 'eval': return <EvalStatus filter={(ops.filter as DecisionFilter | undefined) ?? 'work'} window={ops.window}
        paused={!!state?.paused} embedded />
      case 'execution': return state ? <ExecutionStatus filter={(ops.filter as TicketFilter | undefined) ?? 'open'}
        from={ops.from} state={state} reload={reload} embedded /> : <p className="dt-hint">{t('loading')}</p>
      default: return null
    }
  })() : null
  const content = (() => {
    switch (group) {
      case 'source': return <>
        {live && <div className="dt-settings-ops">{live}</div>}
        {consolidated && <h3 className="dt-settings-subtitle">{t('settingsConfigTitle')}</h3>}
        <SettingsProvider><SourceSettings {...query.source ? { focus: query.source } : {}} /></SettingsProvider>
      </>
      case 'trigger': return live ?? <TriggerStatus filter={triggerFilter ?? 'subscribed'} />
      case 'eval': return <>
        {live && <div className="dt-settings-ops">{live}</div>}
        {consolidated && <h3 className="dt-settings-subtitle">{t('settingsConfigTitle')}</h3>}
        <SettingsProvider><EvalSettings version={query.version} /></SettingsProvider>
      </>
      case 'execution': return <>
        {live && <div className="dt-settings-ops">{live}</div>}
        {consolidated && <h3 className="dt-settings-subtitle">{t('settingsConfigTitle')}</h3>}
        <SettingsProvider><ExecutionSettings /></SettingsProvider>
      </>
      case 'profiles': return <SettingsProvider><ProfilesPage /></SettingsProvider>
      case 'display': return <DisplaySettings />
      case 'prompts': return <PromptsPage />
      case 'deployment': return state ? <DeploymentPage setup={state.setup} form={deploymentForm} />
        : <p className="dt-hint">{t('loading')}</p>
    }
  })()
  return <div className="dt-settings">
    <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
      {NAV.map(section => {
        const items = section.items.filter(item => groups.includes(item))
        if (!items.length) return null
        return <div className="dt-settings-nav-group" key={section.title}>
          <p className="dt-settings-nav-title">{t(section.title)}</p>
          {items.map(value => <button key={value} type="button" className="dt-settings-link"
            data-stage={STAGE_GROUPS.includes(value) || undefined}
            aria-current={value === group ? 'page' : undefined} onClick={() => navigate(settingsRoute(value),
              true)}><Icon name={GROUP_ICON[value]} size={15} />{t(`settingsGroup.${value}`)}</button>)}
        </div>
      })}
    </nav>
    <div className="dt-settings-body">
      <div className="dt-settings-head">
        <h2 className="dt-settings-title">{t(`settingsGroup.${group}`)}</h2>
        <p className="dt-hint">{t(`settingsDescription.${group}`)}</p>
      </div>
      {opsInSettings() && OPS_GROUPS.includes(group) && <p className="dt-hint dt-settings-boundary">{t('settingsOpsBoundary')}</p>}
      {content}
    </div>
  </div>
}
