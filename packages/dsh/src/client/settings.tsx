/** Settings tab shell routing between stage settings (Sources, Eval, Execution), display preferences, Prompts, and Deployment. */
import { useState } from 'react'
import type { StateView } from './api.ts'
import { InfoTip, Switch } from './controls.tsx'
import { ERROR_AGGREGATE, EVENTS_AUTO_OPEN, NOTIFY_DRAWER, NOTIFY_OVERLAY, TASK_HIERARCHY, autoOpenPreference, featureEnabled,
  notifyAutoDismiss, setAutoOpenPreference, setFeature, setNotifyAutoDismiss } from './features.ts'
import { Hint } from './widgets.tsx'
import { DeploymentPage, type DeploymentForm } from './deployment.tsx'
import { EvalSettings } from './eval.tsx'
import { ExecutionSettings } from './execution.tsx'
import { PromptsPage } from './prompts.tsx'
import { usePanel } from './provider.tsx'
import { SETTINGS_GROUPS, settingsRoute, type SettingsGroup } from './route.ts'
import { SettingsProvider } from './settings-kit.tsx'
import { SourceSettings } from './source.tsx'

const STAGE_GROUPS: readonly SettingsGroup[] = ['source', 'eval', 'execution']
/**
 * Display preferences belong to this browser, like the unread cursor: they are not policy and are not saved to the Store.
 * The Events tab's first automatic open is a trust-phase exception and defaults off in the stable phase.
 */
function DisplaySettings() {
  const { t } = usePanel()
  const [autoOpen, setAutoOpen] = useState(autoOpenPreference)
  const [overlay, setOverlay] = useState(() => featureEnabled(NOTIFY_OVERLAY))
  const [autoDismiss, setAutoDismiss] = useState(notifyAutoDismiss)
  const [drawer, setDrawer] = useState(() => featureEnabled(NOTIFY_DRAWER))
  const [hierarchy, setHierarchy] = useState(() => featureEnabled(TASK_HIERARCHY))
  const [aggregate, setAggregate] = useState(() => featureEnabled(ERROR_AGGREGATE))
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
  </div>
}

export function SettingsPage({ group, query, state, deploymentForm }: {
  group: SettingsGroup; query: { source?: string; version?: string }; state: StateView; deploymentForm: DeploymentForm
}) {
  const { t, navigate } = usePanel()
  const content = (() => {
    switch (group) {
      case 'source': return <SettingsProvider><SourceSettings {...query.source ? { focus: query.source } : {}} /></SettingsProvider>
      case 'eval': return <SettingsProvider><EvalSettings version={query.version} /></SettingsProvider>
      case 'execution': return <SettingsProvider><ExecutionSettings /></SettingsProvider>
      case 'display': return <DisplaySettings />
      case 'prompts': return <PromptsPage />
      case 'deployment': return <DeploymentPage setup={state.setup} form={deploymentForm} />
    }
  })()
  return <div className="dt-settings">
    <nav className="dt-settings-nav" aria-label={t('tab.settings')}>
      {SETTINGS_GROUPS.map(value => <button key={value} type="button" className="dt-settings-link" data-stage={STAGE_GROUPS.includes(value)
        || undefined}
        aria-current={value === group ? 'page' : undefined} onClick={() => navigate(settingsRoute(value),
          true)}>{t(`settingsGroup.${value}`)}</button>)}
    </nav>
    <div className="dt-settings-body">
      <h2 className="dt-settings-title">{t(`settingsGroup.${group}`)}</h2>
      {content}
    </div>
  </div>
}
