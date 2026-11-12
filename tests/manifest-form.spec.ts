/** The manifest form model: the panel's fields, sign-in fields, admission hints, health names and polling defaults come from the manifest, and match the hand-written Source kind. */
import { describe, expect, it } from 'vitest'
import type { SourceManifest } from '@superagent/kernel'
import { githubDefinition, githubKind, githubManifest } from '@superagent/dsh/sources/github.ts'
import { feishuDocDefinition } from '@superagent/dsh/sources/feishu-doc.ts'
import { manifestForm } from '@superagent/dsh/sources/manifest-form.ts'

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
  ],
  health: ['github'],
  limits: { pollSeconds: 60 },
})

describe('a manifest form', () => {
  it('carries the fields, titles and description in manifest order', () => {
    const form = manifestForm(manifest())
    expect(form.id).toBe('github')
    expect(form.title).toEqual(text('GitHub'))
    expect(form.description).toEqual(text('Receives the repository the agent works in.'))
    expect(form.fields.map(field => field.key)).toEqual(['repository', 'cli', 'observeIssues', 'pollSeconds'])
    expect(form.fields[3]).toMatchObject({ advanced: true, type: 'number', min: 60, max: 3600 })
  })
  it('resolves the sign-in fields and keeps the admission hints', () => {
    const form = manifestForm(manifest())
    expect(form.auth).toEqual({ kind: 'cli', fields: [expect.objectContaining({ key: 'cli', type: 'text' })] })
    expect(form.health).toEqual(['github'])
    expect(form.limits).toEqual({ pollSeconds: 60 })
  })
  it('is plain data: it survives a JSON round trip', () => {
    const form = manifestForm(manifest())
    expect(JSON.parse(JSON.stringify(form))).toEqual(form)
  })
  it('throws when a sign-in field is not one of the manifest fields', () => {
    expect(() => manifestForm({ ...manifest(), auth: { kind: 'cli', fields: ['gh'] } }))
      .toThrow(/source "github" authenticates with "gh"/)
  })
  it('leaves limits absent when the manifest declares none', () => {
    const { limits: _, ...withoutLimits } = manifest()
    expect(manifestForm(withoutLimits).limits).toBeUndefined()
  })
  it('keeps each declared polling default equal to its adapter schema default', () => {
    for (const definition of [githubDefinition, feishuDocDefinition])
      expect(definition.manifest.limits?.pollSeconds).toBe(definition.adapter.schema.parse({}).pollSeconds)
  })
  it('gives the GitHub shared-account switch its two receive dependencies and keeps it off by default', () => {
    const fields = manifestForm(githubManifest).fields
    expect(fields.find(field => field.key === 'humanIdentity')).toMatchObject({ type: 'switch', requires: ['observeComments', 'observePulls'] })
    expect(fields.find(field => field.key === 'observeComments')?.type).toBe('switch')
    expect(fields.find(field => field.key === 'observePulls')?.type).toBe('switch')
    expect(githubDefinition.adapter.schema.parse({})).toMatchObject({ humanIdentity: false })
  })
  it('matches the hand-written GitHub kind it will replace', () => {
    const form = manifestForm(githubManifest)
    expect(form.id).toBe(githubKind.kind)
    expect(form.fields).toEqual(githubKind.fields)
    expect(form.auth).toEqual({ kind: 'cli', fields: [githubKind.fields.find(field => field.key === 'cli')] })
    expect(form.health).toEqual(githubKind.health)
  })
})
