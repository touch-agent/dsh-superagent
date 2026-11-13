/**
 * The main Agent's display identity, stored as a browser preference in this plugin's state. It changes only what the
 * card shows: the main Session id, authorization, prompts and every record stay untouched. A local avatar is cropped and
 * re-encoded here, so the original file name, EXIF and other metadata never reach storage.
 */

/** Longest display name; the card is one line and a name is not a place for a paragraph. */
export const MASTER_NAME_MAX = 24
/** Built-in avatars; a stored value is either `preset:<id>` or a re-encoded `data:image/...` URL. */
export const AVATAR_PRESETS = ['aurora', 'sunset', 'forest', 'slate'] as const
export type AvatarPreset = typeof AVATAR_PRESETS[number]
export const DEFAULT_AVATAR: AvatarPreset = 'aurora'
/** Upload cap before processing; the stored crop is far smaller. */
export const AVATAR_FILE_MAX = 4 * 1024 * 1024
/** Stored data URL cap, so a hand-edited localStorage value cannot bloat every render. */
const AVATAR_STORE_MAX = 300_000
const KEY = 'dsh-superagent/master-identity'

export interface MasterIdentity {
  /** A custom name; absent means the localized default. */
  name?: string
  /** `preset:<id>` or a re-encoded PNG data URL; absent means the default preset. */
  avatar?: string
}

const presetOf = (value: string): AvatarPreset | undefined => value.startsWith('preset:')
  ? (AVATAR_PRESETS as readonly string[]).includes(value.slice(7)) ? value.slice(7) as AvatarPreset : undefined
  : undefined

const isStoredImage = (value: string): boolean => value.startsWith('data:image/png;base64,') && value.length <= AVATAR_STORE_MAX

/** The avatar the card renders: a validated preset id, a re-encoded PNG, or the default. */
export function avatarOf(identity: MasterIdentity): { preset?: AvatarPreset; image?: string } {
  const value = identity.avatar
  if (!value) return { preset: DEFAULT_AVATAR }
  const preset = presetOf(value)
  if (preset) return { preset }
  if (isStoredImage(value)) return { image: value }
  return { preset: DEFAULT_AVATAR }
}

/** Read the stored identity; malformed fields are ignored instead of breaking the task view. */
export function readMasterIdentity(): MasterIdentity {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as unknown
    if (!value || typeof value !== 'object') return {}
    const raw = value as { name?: unknown; avatar?: unknown }
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MASTER_NAME_MAX) : undefined
    const avatar = typeof raw.avatar === 'string' && (presetOf(raw.avatar) || isStoredImage(raw.avatar)) ? raw.avatar : undefined
    return { ...name ? { name } : {}, ...avatar ? { avatar } : {} }
  } catch { return {} }
}

/** Merge and persist one identity field; `undefined` removes a custom value so the default wins again. */
export function saveMasterIdentity(patch: MasterIdentity): MasterIdentity {
  const next: MasterIdentity = { ...readMasterIdentity(), ...patch }
  if (!next.name) delete next.name
  if (!next.avatar) delete next.avatar
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(next)) } catch { /* a blocked storage is not a failure */ }
  return next
}

/** Validate a name the card is about to save; empty means the localized default. */
export function cleanMasterName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MASTER_NAME_MAX)
}

/**
 * Crop a local image to a square, re-encode it at 96x96 and return a data URL. Drawing through a canvas is what strips
 * EXIF, geolocation and the original file name; the caller never stores the raw File.
 */
export async function avatarFileToDataUrl(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
    throw new Error('avatarType')
  if (file.size > AVATAR_FILE_MAX) throw new Error('avatarSize')
  const source = await decode(file)
  try {
    const canvas = globalThis.document.createElement('canvas')
    canvas.width = 96; canvas.height = 96
    const context = canvas.getContext?.('2d')
    if (!context) throw new Error('avatarUnsupported')
    const side = Math.min(source.width, source.height)
    const sx = (source.width - side) / 2, sy = (source.height - side) / 2
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, 96, 96)
    context.drawImage(source.image, sx, sy, side, side, 0, 0, 96, 96)
    return canvas.toDataURL('image/png')
  } finally { source.release() }
}

interface Decoded { image: CanvasImageSource; width: number; height: number; release: () => void }

async function decode(file: File): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }
    } catch { /* fall back to an <img> for browsers without a working bitmap decoder */ }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return { image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error instanceof Error ? error : new Error('avatarUnsupported')
  }
}
