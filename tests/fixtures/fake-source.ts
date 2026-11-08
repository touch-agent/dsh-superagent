/** Sources that exist only as manifests: registering one must make the panel show its fields, sign-in, health entries and polling default without panel code. */
import { z } from 'zod'
import type { SourceManifest } from '@superagent/kernel'
import type { SourceView } from '@superagent/dsh/client/api.ts'
import type { SourceAdapter, SourceDefinition } from '@superagent/dsh/sources/kind.ts'
import { manifestForm } from '@superagent/dsh/sources/manifest-form.ts'

const localized = (zh: string, en: string) => ({ zh, en })

export const fakeManifest: SourceManifest = {
  id: 'fixture',
  title: localized('示例来源', 'Example Source'),
  description: localized('只由 manifest 描述的测试来源。', 'A test Source described only by its manifest.'),
  auth: { kind: 'cli', fields: ['cli'] },
  fields: [
    { key: 'cli', type: 'text', label: localized('示例命令行', 'Example CLI'),
      hint: localized('用这个命令登录示例来源。', 'Signs in to the example Source with this command.') },
    { key: 'target', type: 'text', label: localized('示例目标', 'Example target') },
    { key: 'observe', type: 'switch', label: localized('接收示例事件', 'Receive example events') },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 600,
      label: localized('示例轮询间隔 / 秒', 'Example polling interval / seconds') },
  ],
  health: ['fixture'],
  limits: { pollSeconds: 30 },
}

const FixtureConfigSchema = z.object({
  cli: z.string().default('fixture-cli'),
  target: z.string().default(''),
  observe: z.boolean().default(false),
  pollSeconds: z.number().int().min(10).max(600).default(30),
}).strict()
export type FixtureConfig = z.infer<typeof FixtureConfigSchema>

export const fakeAdapter: SourceAdapter<FixtureConfig> = { schema: FixtureConfigSchema }
export const fakeDefinition: SourceDefinition<FixtureConfig> = { manifest: fakeManifest, adapter: fakeAdapter }

/** A Source that signs in through an application identity instead of a CLI. */
export const fakeAppManifest: SourceManifest = { ...fakeManifest, id: 'fixture-app',
  title: localized('示例应用来源', 'Example App Source'), auth: { kind: 'app', fields: ['cli'] } }
export const fakeAppAdapter: SourceAdapter<FixtureConfig> = { schema: FixtureConfigSchema }

const SilentConfigSchema = z.object({ note: z.string().default('') }).strict()
/** A Source with no sign-in, no health entries and no declared limits, which the card must leave unadorned. */
export const fakeSilentManifest: SourceManifest = {
  id: 'fixture-silent',
  title: localized('无登录来源', 'No-sign-in Source'),
  description: localized('没有登录、健康项或限流的测试来源。', 'A test Source with no sign-in, health entries or limits.'),
  auth: { kind: 'none', fields: [] },
  fields: [{ key: 'note', type: 'text', label: localized('示例说明', 'Example note') }],
  health: [],
}
export const fakeSilentAdapter: SourceAdapter<z.infer<typeof SilentConfigSchema>> = { schema: SilentConfigSchema }

/**
 * The settings card a manifest-only registration produces: title, description and form come from `manifestForm`, exactly
 * as `settingsView` builds them, and the configuration defaults come from the adapter's schema.
 */
function sourceViewOf(manifest: SourceManifest, config: Record<string, unknown>): SourceView {
  const form = manifestForm(manifest)
  return { id: manifest.id, kind: manifest.id, title: form.title, description: form.description, installed: true,
    value: { enabled: true, config }, revision: 0, restarts: [], form, facts: {}, labels: {} }
}
export const fakeSourceView = (config: Partial<FixtureConfig> = {}): SourceView =>
  sourceViewOf(fakeManifest, FixtureConfigSchema.parse(config))
export const fakeAppView = (config: Partial<FixtureConfig> = {}): SourceView =>
  sourceViewOf(fakeAppManifest, FixtureConfigSchema.parse(config))
export const fakeSilentView = (config: { note?: string } = {}): SourceView =>
  sourceViewOf(fakeSilentManifest, SilentConfigSchema.parse(config))
