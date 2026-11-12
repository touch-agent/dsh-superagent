/** The declarative half of a Source kind: identity, configuration fields, admission rows, health claims and polling defaults. Behavior stays in the runtime adapter. */

export interface Localized { zh: string; en: string }
/** `advanced` folds a rarely changed field (such as a polling tunable) behind the card's Advanced section. */
interface FieldBase { key: string; label: Localized; hint?: Localized; advanced?: true }
/** A switch's `requires` names other switch keys that must be on for its effect; the panel offers to turn them on. */
interface SwitchBase extends FieldBase { type: 'switch'; requires?: readonly string[] }
/**
 * Configuration field specification; `rows` edits a list of records keyed by its first column, `choose` picks from
 * resolved source labels, and `fact` displays a read-only value from `facts`.
 */
export type FieldSpec =
  | SwitchBase
  | FieldBase & { type: 'select'; options: { value: string; label: Localized }[] }
  | FieldBase & { type: 'number'; min: number; max: number }
  | FieldBase & { type: 'text'; pattern?: string; readonly?: boolean; choose?: Localized }
  | FieldBase & { type: 'fact'; settings?: 'deployment' }
  | FieldBase & { type: 'rows'; columns: ({ key: string; label: Localized; type: 'text'; pattern?: string; optional?: boolean; choose?: Localized; refresh?: Localized } | { key: string; label: Localized; type: 'select'; options: { value: string; label: Localized }[] })[] }

/** How a Source signs in and which of its fields carry the credential (`cli` is a command name or path, `app` an application identity). */
export interface SourceAuth { kind: 'cli' | 'app' | 'none'; fields: readonly string[] }
/** Defaults the runtime applies when a Source's configuration leaves them out. */
export interface SourceLimits { pollSeconds?: number }
/**
 * The manifest of a Source kind, which the management panel renders from: `fields` become the configuration form, `auth` names
 * the fields that carry the credential, `health` the entries the Source may report, `limits` the polling defaults. It is data,
 * so it can be validated, snapshotted and compared; a runtime adapter supplies the behavior (`schema`, `channel`,
 * `threadContext`, `policy`, `environment`). Admission (rows and the explicit-request note) lives in the adapter's policy part,
 * because its rows depend on configuration and belong to the Policy version. `extra` carries what a future field adds, so a
 * manifest that needs it does not fork the type.
 */
export interface SourceManifest {
  id: string
  title: Localized
  description: Localized
  auth: SourceAuth
  fields: readonly FieldSpec[]
  health: readonly string[]
  limits?: SourceLimits
  extra?: Record<string, unknown>
}
