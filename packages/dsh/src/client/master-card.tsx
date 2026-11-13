/**
 * The main Agent's card at the top of the task view. It is a plugin-surface card, not the host's sidebar: it names the
 * one stable entry, keeps a custom name and avatar in this browser, reports a one-line state, and opens the existing main
 * Session. Renaming changes only the display label; the Session id and every authorization fact stay as they are.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Icon, Modal, Tag } from './controls.tsx'
import { AVATAR_PRESETS, avatarFileToDataUrl, avatarOf, cleanMasterName, readMasterIdentity, saveMasterIdentity,
  type AvatarPreset, type MasterIdentity } from './master-identity.ts'
import { usePanel } from './provider.tsx'

export interface MasterCardProps {
  /** The one main Session id from `GET state`; absent while the host is still answering. */
  masterId?: string
  paused: boolean
  /** Effects or assignments currently running, for the one-line status. */
  running: number
  /** Live person-turn tasks; the most important reason the agent is waiting. */
  attention: number
  onOpen: (sessionId: string) => Promise<void>
}

const PRESET_CLASS: Record<AvatarPreset, string> = { aurora: 'dt-avatar-aurora', sunset: 'dt-avatar-sunset',
  forest: 'dt-avatar-forest', slate: 'dt-avatar-slate' }

/** The avatar itself: an uploaded crop, a preset gradient, or the default preset. */
function MasterAvatar({ identity, size }: { identity: MasterIdentity; size: number }) {
  const avatar = avatarOf(identity)
  return avatar.image
    ? <img className="dt-master-avatar" width={size} height={size} src={avatar.image} alt="" />
    : <span className={`dt-master-avatar ${PRESET_CLASS[avatar.preset ?? 'aurora']}`} style={{ width: size, height: size }}
      aria-hidden="true"><Icon name="user" size={Math.round(size * 0.42)} /></span>
}

export function MasterCard({ masterId, paused, running, attention, onOpen }: MasterCardProps) {
  const { t, notify } = usePanel()
  const [identity, setIdentity] = useState<MasterIdentity>(readMasterIdentity)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [picker, setPicker] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const upload = useRef<HTMLInputElement>(null)
  const name = identity.name || t('masterDefaultName')

  useEffect(() => { if (editing) input.current?.focus() }, [editing])
  useEffect(() => { if (!picker) return
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setPicker(false) }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [picker])

  const status = paused ? t('masterStatusPaused')
    : masterId === undefined ? t('masterStatusConnecting')
    : attention > 0 ? t('masterStatusWaiting', { count: attention })
    : running > 0 ? t('masterStatusWorking', { count: running })
    : t('masterStatusIdle')

  const startRename = () => { setDraft(identity.name ?? ''); setEditing(true); setFailure(undefined) }
  const saveName = (event: FormEvent) => {
    event.preventDefault()
    const next = cleanMasterName(draft)
    setIdentity(saveMasterIdentity({ name: next || undefined }))
    setEditing(false)
    notify(next ? t('masterNameSaved', { name: next }) : t('masterNameReset'))
  }
  const open = async () => {
    if (!masterId || busy) return
    setBusy(true); setFailure(undefined)
    try { await onOpen(masterId) } catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const choosePreset = (preset: AvatarPreset) => {
    setIdentity(saveMasterIdentity({ avatar: `preset:${preset}` })); setPicker(false); notify(t('masterAvatarSaved'))
  }
  const resetAvatar = () => {
    setIdentity(saveMasterIdentity({ avatar: undefined })); setPicker(false); notify(t('masterAvatarResetDone'))
  }
  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return
    setFailure(undefined)
    try {
      const image = await avatarFileToDataUrl(file)
      setIdentity(saveMasterIdentity({ avatar: image }))
      setPicker(false)
      notify(t('masterAvatarSaved'))
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      setFailure(t(code === 'avatarSize' ? 'masterAvatarTooLarge' : code === 'avatarType' ? 'masterAvatarType' : 'masterAvatarUnreadable'))
    } finally { if (upload.current) upload.current.value = '' }
  }

  return <section className="dt-master-card" aria-labelledby="dt-master-card-name">
    <div className="dt-master-card-main">
      <MasterAvatar identity={identity} size={56} />
      <div className="dt-master-card-copy">
        {editing ? <form className="dt-master-rename" onSubmit={saveName}>
          <input ref={input} className="dt-input" aria-label={t('masterNameLabel')} value={draft} maxLength={24}
            placeholder={t('masterDefaultName')} onChange={event => setDraft(event.target.value)} />
          <Button size="sm" variant="primary" type="submit">{t('masterSave')}</Button>
          <Button size="sm" type="button" onClick={() => setEditing(false)}>{t('masterCancel')}</Button>
        </form> : <div className="dt-master-card-title">
          <h2 id="dt-master-card-name">{name}</h2>
          <Tag tone="info">{t('masterRole')}</Tag>
          <button type="button" className="dt-master-link" onClick={startRename}>{t('masterRename')}</button>
        </div>}
        <p className="dt-master-card-status" data-paused={paused ? 'true' : undefined}>
          <span className="dt-master-status-dot" aria-hidden="true" />{status}
        </p>
        <p className="dt-master-card-hint">{failure ?? t('masterSubtitle')}</p>
      </div>
    </div>
    <div className="dt-master-card-actions">
      <Button size="sm" variant="ghost" icon={<Icon name="user" size={14} />} onClick={() => setPicker(true)}>{t('masterAvatar')}</Button>
      <Button size="sm" variant="primary" icon={<Icon name="message" size={14} />} disabled={!masterId || busy}
        title={failure ?? t('masterEntryHint')} onClick={() => { void open() }}>{busy ? t('masterOpening') : t('masterOpen')}</Button>
    </div>
    <Modal open={picker} onClose={() => setPicker(false)} title={t('masterAvatarTitle')} closeLabel={t('close')}
      description={t('masterAvatarHint')} footer={<Button variant="outline" onClick={() => setPicker(false)}>{t('masterDone')}</Button>}>
      <div className="dt-avatar-picker">
        <div className="dt-avatar-presets" role="group" aria-label={t('masterAvatarPresetLabel')}>
          {AVATAR_PRESETS.map(preset => <button key={preset} type="button" className="dt-avatar-choice"
            aria-label={t(`masterAvatarPreset.${preset}`)} aria-pressed={identity.avatar === `preset:${preset}`}
            onClick={() => choosePreset(preset)}>
            <MasterAvatar identity={{ avatar: `preset:${preset}` }} size={44} />
            <span>{t(`masterAvatarPreset.${preset}`)}</span>
          </button>)}
        </div>
        <div className="dt-avatar-upload">
          <input ref={upload} id="dt-master-avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden
            onChange={event => { void uploadAvatar(event.target.files?.[0]) }} />
          <Button size="sm" variant="outline" icon={<Icon name="plus" size={14} />}
            onClick={() => upload.current?.click()}>{t('masterAvatarUpload')}</Button>
          <Button size="sm" variant="ghost" onClick={resetAvatar}>{t('masterAvatarReset')}</Button>
        </div>
        {failure && <p className="dt-hint dt-error-text" role="alert">{failure}</p>}
      </div>
    </Modal>
  </section>
}
