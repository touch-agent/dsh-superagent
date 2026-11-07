/** The panel model a Source manifest yields: configuration fields, sign-in fields, admission hints, health names and polling defaults. React-free so the panel renders from data and tests can compare it. */
import type { FieldSpec, SourceManifest } from '@superagent/kernel'

export interface SourceFormAuth { kind: SourceManifest['auth']['kind']; fields: readonly FieldSpec[] }
export interface SourceForm {
  id: string
  title: SourceManifest['title']
  description: SourceManifest['description']
  /** The configuration fields in manifest order, `advanced` ones included so the panel can fold them. */
  fields: readonly FieldSpec[]
  /** The fields that carry the credential, resolved from `auth.fields`. */
  auth: SourceFormAuth
  /** Health entries the Source may report its own state under. */
  health: readonly string[]
  limits: SourceManifest['limits']
}

/** Projects a manifest into the panel model; a sign-in field key the manifest does not declare is a programming error, so it throws instead of rendering a nameless field. */
export function manifestForm(manifest: SourceManifest): SourceForm {
  const fields = new Map(manifest.fields.map(field => [field.key, field]))
  const auth = manifest.auth.fields.map(key => {
    const field = fields.get(key)
    if (!field) throw new Error(`source "${manifest.id}" authenticates with "${key}", which is not one of its fields`)
    return field
  })
  return { id: manifest.id, title: manifest.title, description: manifest.description, fields: manifest.fields,
    auth: { kind: manifest.auth.kind, fields: auth }, health: manifest.health, limits: manifest.limits }
}
