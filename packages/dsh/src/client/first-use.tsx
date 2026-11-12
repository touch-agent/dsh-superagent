/** UX batch 2's first-use notes and empty-state examples: what it does, what it needs, and where to start. */
import { useState } from 'react'
import { Button, Icon } from './controls.tsx'
import { dismissFirstUse, firstUse, firstUseDismissed } from './features.ts'
import { usePanel } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { errorText } from './text.ts'

/** One labelled line: the three questions a person asks before trusting the surface. */
function Line({ label, text }: { label: string; text: string }) {
  return <div className="dt-first-use-line">
    <span className="dt-first-use-label">{label}</span>
    <span className="dt-first-use-text">{text}</span>
  </div>
}

/** The three-line introduction, shown until it is read once in this browser. */
export function FirstUseNotes() {
  const { t } = usePanel()
  const [open, setOpen] = useState(() => firstUse() && !firstUseDismissed())
  if (!open) return null
  return <section className="dt-first-use" aria-label={t('firstUseCanDo')}>
    <Line label={t('firstUseCanDo')} text={t('firstUseCanDoText')} />
    <Line label={t('firstUseNeeds')} text={t('firstUseNeedsText')} />
    <Line label={t('firstUseStart')} text={t('firstUseStartText')} />
    <div className="dt-first-use-actions">
      <Button variant="ghost" size="sm" onClick={() => { dismissFirstUse(); setOpen(false) }}>{t('firstUseDismiss')}</Button>
    </div>
  </section>
}

/**
 * The zero-task surface offers two starting points that work without an existing task: talk to the main Session, or
 * connect a Source. Both use existing navigation; neither creates a task or grants anything.
 */
export function EmptyExamples({ masterId, onAsk }: { masterId?: string; onAsk: (sessionId: string) => Promise<void> }) {
  const { t, navigate, notify } = usePanel()
  if (!firstUse()) return null
  const ask = () => {
    if (masterId) { onAsk(masterId).catch(failure => notify(errorText(failure))); return }
    navigate(settingsRoute('source'))
  }
  return <div className="dt-first-use dt-first-use-empty">
    <p className="dt-hint">{t('firstUseExamples')}</p>
    <div className="dt-first-use-actions">
      {masterId && <Button variant="outline" size="sm" icon={<Icon name="message" size={14} />} onClick={ask}
        title={t('firstUseExampleAskHint')}>{t('firstUseExampleAsk')}</Button>}
      <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />}
        onClick={() => navigate(settingsRoute('source'))} title={t('firstUseExampleSourceHint')}>{t('firstUseExampleSource')}</Button>
    </div>
    <p className="dt-hint">{masterId ? t('firstUseExampleAskHint') : t('firstUseExampleSourceHint')}</p>
  </div>
}
