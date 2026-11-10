/** Settings tab shell routing between stage settings (Sources, Eval, Execution), display preferences, Prompts, and Deployment. */
import { useState } from 'react'
import type { StateView } from './api.ts'
import { InfoTip, Switch } from './controls.tsx'
import { EVENTS_AUTO_OPEN, autoOpenPreference, featureEnabled, setAutoOpenPreference } from './features.ts'
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
