/** The Source manifest contract: a complete manifest parses, and every violation carries the path that fixes it. */
import { describe, expect, it } from 'vitest'
import type { SourceManifest } from '@superagent/kernel'
import { parseSourceManifest, parseSourceManifests, SourceManifestSchema, SourceManifestsSchema } from '@superagent/dsh/sources/manifest-schema.ts'

const text = (value: string) => ({ zh: value, en: value })
const manifest = (): SourceManifest => ({
  id: 'github',
  title: text('GitHub'),
  description: text('Receives the repository the agent works in.'),
  auth: { kind: 'cli', fields: ['cli'] },
  fields: [
    { key: 'repository', type: 'text', label: text('Repository'), pattern: '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+' },
    { key: 'cli', type: 'text', label: text('Agent GitHub CLI'), choose: text('Choose the wrapper') },
    { key: 'observeIssues', type: 'switch', label: text('Receive new Issues') },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: text('Polling interval') },
    { key: 'chats', type: 'rows', label: text('Chats'), columns: [
      { key: 'chatId', type: 'text', label: text('Chat'), pattern: 'oc_[a-zA-Z0-9]+' },
      { key: 'listen', type: 'select', label: text('Receive'), options: [{ value: 'mentions', label: text('@ only') }] }] },
    { key: 'region', type: 'select', label: text('Region'), options: [{ value: 'us', label: text('US') }] },
    { key: 'account', type: 'fact', settings: 'deployment', label: text('Account') },
  ],
  health: ['github'],
  limits: { pollSeconds: 60 },
})
const issues = <T>(result: { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } }) => {
  if (result.success) throw new Error('expected a validation failure')
  return result.error.issues
}

describe('a Source manifest', () => {
  it('parses a complete manifest and keeps the escape hatch', () => {
    const parsed = parseSourceManifest({ ...manifest(), extra: { notifications: 'rest' } })
    expect(parsed.id).toBe('github')
    expect(parsed.fields.map(field => field.type)).toEqual(['text', 'text', 'switch', 'number', 'rows', 'select', 'fact'])
    expect(parsed.limits).toEqual({ pollSeconds: 60 })
    expect(parsed.extra).toEqual({ notifications: 'rest' })
  })
  it('refuses a scope: admission belongs to the policy part, not the manifest', () => {
    expect(SourceManifestSchema.safeParse({ ...manifest(), scope: { rows: [], explicit: text('Any') } }).success).toBe(false)
  })
  it('names the second Source when two answer to the same id', () => {
    const parsed = SourceManifestsSchema.safeParse([manifest(), { ...manifest(), title: text('Copy') }])
    const issue = issues(parsed).find(item => item.message.includes('duplicate source id'))
    expect(issue?.path).toEqual([1, 'id'])
    expect(issue?.message).toContain('"github"')
  })
  it('refuses two Sources with one id through parseSourceManifests', () => {
    expect(parseSourceManifests([manifest()])).toHaveLength(1)
    expect(() => parseSourceManifests([manifest(), manifest()])).toThrow(/duplicate source id/)
  })
  it('names an auth field the manifest does not declare', () => {
    const result = SourceManifestSchema.safeParse({ ...manifest(), auth: { kind: 'cli', fields: ['gh'] } })
    expect(issues(result).map(issue => issue.path)).toContainEqual(['auth', 'fields', 0])
  })
  it('refuses a sign-in kind and its fields disagreeing', () => {
    const bare = SourceManifestSchema.safeParse({ ...manifest(), auth: { kind: 'cli', fields: [] } })
    expect(issues(bare).map(issue => issue.path)).toContainEqual(['auth', 'fields'])
    const none = SourceManifestSchema.safeParse({ ...manifest(), auth: { kind: 'none', fields: ['cli'] } })
    expect(issues(none).map(issue => issue.path)).toContainEqual(['auth', 'fields'])
    const twice = SourceManifestSchema.safeParse({ ...manifest(), auth: { kind: 'cli', fields: ['cli', 'cli'] } })
    expect(issues(twice).map(issue => issue.path)).toContainEqual(['auth', 'fields', 1])
  })
  it('names the second of two fields with one key', () => {
    const fields = [...manifest().fields, { key: 'cli', type: 'text' as const, label: text('Again') }]
    const result = SourceManifestSchema.safeParse({ ...manifest(), fields })
    expect(issues(result).map(issue => issue.path)).toContainEqual(['fields', fields.length - 1, 'key'])
  })
  it('names a polling default that cannot be a limit', () => {
    const result = SourceManifestSchema.safeParse({ ...manifest(), limits: { pollSeconds: 0 } })
    expect(issues(result).map(issue => issue.path)).toContainEqual(['limits', 'pollSeconds'])
  })
  it('refuses unknown keys and unknown field types', () => {
    expect(SourceManifestSchema.safeParse({ ...manifest(), beta: true }).success).toBe(false)
    expect(SourceManifestSchema.safeParse({ ...manifest(), fields: [{ key: 'level', type: 'slider', label: text('Level') }] }).success).toBe(false)
  })
})
