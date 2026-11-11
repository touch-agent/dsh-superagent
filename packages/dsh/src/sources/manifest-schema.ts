/** Validation of the kernel's SourceManifest: the panel, the registry and conformance tests parse manifests through it, so a violation names its path. */
import { z } from 'zod'
import type { SourceManifest } from '@superagent/kernel'

const LocalizedSchema = z.object({ zh: z.string().min(1), en: z.string().min(1) }).strict()
const OptionSchema = z.object({ value: z.string().min(1), label: LocalizedSchema }).strict()
const FieldBase = { key: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), label: LocalizedSchema, hint: LocalizedSchema.optional(), advanced: z.literal(true).optional() }
const ColumnSchema = z.discriminatedUnion('type', [
  z.object({ key: z.string().min(1), label: LocalizedSchema, type: z.literal('text'), pattern: z.string().optional(), optional: z.boolean().optional(),
    choose: LocalizedSchema.optional(), refresh: LocalizedSchema.optional() }).strict(),
  z.object({ key: z.string().min(1), label: LocalizedSchema, type: z.literal('select'), options: z.array(OptionSchema).min(1) }).strict(),
])
const FieldSchema = z.discriminatedUnion('type', [
  z.object({ ...FieldBase, type: z.literal('switch'), requires: z.array(z.string().min(1)).min(1).optional() }).strict(),
  z.object({ ...FieldBase, type: z.literal('select'), options: z.array(OptionSchema).min(1) }).strict(),
  z.object({ ...FieldBase, type: z.literal('number'), min: z.number(), max: z.number() }).strict(),
  z.object({ ...FieldBase, type: z.literal('text'), pattern: z.string().optional(), readonly: z.boolean().optional(), choose: LocalizedSchema.optional() }).strict(),
  z.object({ ...FieldBase, type: z.literal('fact'), settings: z.literal('deployment').optional() }).strict(),
  z.object({ ...FieldBase, type: z.literal('rows'), columns: z.array(ColumnSchema).min(1) }).strict(),
])
const IdPattern = /^[a-z][a-z0-9-]*$/

export const SourceManifestSchema = z.object({
  id: z.string().regex(IdPattern),
  title: LocalizedSchema,
  description: LocalizedSchema,
  auth: z.object({ kind: z.enum(['cli', 'app', 'none']), fields: z.array(z.string()).default([]) }).strict(),
  fields: z.array(FieldSchema),
  // A Source may have no health probe when the runtime itself is its only dependency.
  health: z.array(z.string().regex(IdPattern)),
  limits: z.object({ pollSeconds: z.number().int().positive().optional() }).strict().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((manifest, ctx) => {
  const keys = manifest.fields.map(field => field.key)
  keys.forEach((key, index) => {
    if (keys.indexOf(key) !== index) ctx.addIssue({ code: 'custom', message: `duplicate field key "${key}"`, path: ['fields', index, 'key'] })
  })
  manifest.auth.fields.forEach((key, index) => {
    if (!keys.includes(key)) ctx.addIssue({ code: 'custom', message: `auth field "${key}" is not one of the manifest's fields`, path: ['auth', 'fields', index] })
    if (manifest.auth.fields.indexOf(key) !== index) ctx.addIssue({ code: 'custom', message: `duplicate auth field "${key}"`, path: ['auth', 'fields', index] })
  })
  if (manifest.auth.kind === 'none' && manifest.auth.fields.length) ctx.addIssue({ code: 'custom',
    message: 'a manifest that needs no sign-in names no auth fields', path: ['auth', 'fields'] })
  if (manifest.auth.kind !== 'none' && !manifest.auth.fields.length) ctx.addIssue({ code: 'custom',
    message: `a ${manifest.auth.kind} sign-in must name the fields that carry it`, path: ['auth', 'fields'] })
  manifest.health.forEach((name, index) => {
    if (manifest.health.indexOf(name) !== index) ctx.addIssue({ code: 'custom', message: `duplicate health entry "${name}"`, path: ['health', index] })
  })
  // A switch may name the switches it depends on, which the panel offers to turn on; a dangling or non-switch key would
  // render a prompt that cannot be fixed.
  manifest.fields.forEach((field, index) => {
    if (field.type !== 'switch') return
    field.requires?.forEach((key, position) => {
      const target = manifest.fields.find(item => item.key === key)
      if (target?.type !== 'switch') ctx.addIssue({ code: 'custom',
        message: `requires "${key}", which is not a switch in this manifest`, path: ['fields', index, 'requires', position] })
    })
  })
})

/** A list of manifests, refusing two Sources that answer to the same id; the second one is the offending path. */
export const SourceManifestsSchema = z.array(SourceManifestSchema).superRefine((manifests, ctx) => {
  const seen = new Map<string, number>()
  manifests.forEach((manifest, index) => {
    const first = seen.get(manifest.id)
    if (first === undefined) { seen.set(manifest.id, index); return }
    ctx.addIssue({ code: 'custom', message: `duplicate source id "${manifest.id}" (first at index ${first})`, path: [index, 'id'] })
  })
})

/** Parses one manifest of unknown shape; throws a ZodError whose issues carry the path of each violation. */
export const parseSourceManifest = (value: unknown): SourceManifest => SourceManifestSchema.parse(value)
/** Parses a list of manifests, including the id-uniqueness rule across the list. */
export const parseSourceManifests = (values: readonly unknown[]): SourceManifest[] => SourceManifestsSchema.parse([...values])
