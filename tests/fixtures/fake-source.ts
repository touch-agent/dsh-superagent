/** A Source that exists only as a manifest: registering it must make the panel show its fields, sign-in, health entries and polling default without panel code. */
import { z } from 'zod'
import type { SourceManifest } from '@superagent/kernel'
import type { SourceAdapter, SourceDefinition } from '@superagent/dsh/sources/kind.ts'

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