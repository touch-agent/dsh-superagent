// @vitest-environment jsdom
// Settings › Agent profiles: the E2 list, immutable revisions, activation, rollback, switches and field metrics.
import type { AgentProfile, ProfileHead } from '@superagent/kernel'
import type { ProfileDetailView } from '@superagent/dsh/app/profiles.ts'
import type { ProfileMetricsView } from '@superagent/dsh/app/profile-metrics.ts'
import { afterEach, expect, it } from 'vitest'
import { zh } from '@superagent/dsh/client/locales.ts'
import { all, click, field, find, mount, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
afterEach(() => localStorage.clear())
const profile = (revision: number, description = '负责文档与测试'): AgentProfile => ({ id: 'worker-docs', revision, role: 'worker',
  title: '文档与测试', description, model: { mode: 'pinned', provider: 'deepseek', model: 'deepseek-v4.1' },
  tools: { mode: 'list', names: ['bash', 'grep', 'read'] }, prompt: { mode: 'pinned', revision: 1 },
  provenance: { by: 'panel:local', at: `2026-11-12T0${revision}:00:00.000Z`, reason: `v${revision}`, source: 'panel' },
  contentHash: `sha256:${String(revision).repeat(64)}` })
const head: ProfileHead = { activeRevision: 2, previousActiveRevision: 1, retiredRevisions: [], updatedBy: 'panel:local' }
const detail = (): ProfileDetailView => ({ profile: profile(2), head, revisions: [profile(1), profile(2)] })
const metrics = (): ProfileMetricsView => ({ generatedAt: '2026-11-12T00:00:00.000Z', profile: 'worker-docs', window: 'all',
  totals: { roots: 4, children: 0, lightweight: 0, fallback: 0, censored: 0, closed: 4, tickets: 4,
    success: { n: 4, successes: 3, rate: 0.75, suppressed: true }, childSuccess: { n: 0, successes: 0, rate: null, suppressed: false },
    lightweightSuccess: { n: 0, successes: 0, rate: null, suppressed: false }, blocked: { blocked: 0, failed: 1, stopped: 0, dropped: 0 },
    rework: { tickets: 0, rate: null, suppressed: false }, cost: 'unknown',
    tokens: { state: 'available', input: 1200, output: 340, cost: 'unknown' }, effectiveConfigurations: 1 },
  groups: [{ effectiveHash: `sha256:${'a'.repeat(64)}`, promptRevision: 1, model: { provider: 'deepseek', model: 'deepseek-v4.1' }, moving: false,
    tickets: 4, roots: 4, children: 0, lightweight: 0, fallback: 0, censored: 0, closed: 4,
    success: { n: 4, successes: 3, rate: 0.75, suppressed: true }, childSuccess: { n: 0, successes: 0, rate: null, suppressed: false },
    lightweightSuccess: { n: 0, successes: 0, rate: null, suppressed: false }, blocked: { blocked: 0, failed: 1, stopped: 0, dropped: 0 },
    rework: { tickets: 0, rate: null, suppressed: false },
    latency: { decisionToDispatch: { samples: 0, p50Seconds: null, p90Seconds: null }, dispatchToReady: { samples: 0, p50Seconds: null, p90Seconds: null },
      readyToEnd: { samples: 0, p50Seconds: null, p90Seconds: null } }, tokens: { state: 'available', input: 1200, output: 340,
      cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 'unknown' }] })
function fixture() {
  server.settings = { ...server.settings, executor: { ...server.settings.executor, model: { provider: 'deepseek', model: 'deepseek-v4.1' } } }
  server.profileConfig = { enabled: true, resolve: 'snapshot', telemetry: true, defaultProfile: 'worker-docs' }
  server.profiles = [
    { id: 'worker-default', title: '兼容默认', description: '内置兼容配置', role: 'worker', activeRevision: 1, previousActiveRevision: undefined,
      disabled: false, retiredRevisions: [], lastBoundAt: undefined, updatedBy: 'builtin', contentHash: 'sha256:builtin', moving: true },
    { id: 'worker-docs', title: '文档与测试', description: '负责文档与测试', role: 'worker', activeRevision: 2, previousActiveRevision: 1,
      disabled: false, retiredRevisions: [], lastBoundAt: '2026-11-12T00:02:00.000Z', updatedBy: 'panel:local', contentHash: 'sha256:docs', moving: false },
  ]
  server.profileDetails = { 'worker-docs': detail() }
  server.profileMetrics = { 'worker-docs': metrics() }
}
async function open() {
  await mount()
  await click(zh['tab.settings'])
  await click(zh['settingsGroup.profiles'])
}

it('shows the profile list with names and versions but no internal id by default', async () => {
  fixture(); await open()
  expect(text()).toContain('文档与测试')
  expect(text()).toContain('第 2 版')
  expect(text()).toContain('当前生效')
  expect(text()).not.toContain('worker-docs')
  expect(text()).not.toContain('worker-default')
})

it('creates a revision with the approved model, pinned prompt and a subset of work tools', async () => {
  fixture(); await open()
  await click(zh.profilesCreate)
  expect(text()).toContain(zh.profilesModelMissing === '' ? '' : 'deepseek/deepseek-v4.1')
  await type(field<HTMLInputElement>(zh.profilesTitleLabel), 'Docs helper')
  await type(field<HTMLTextAreaElement>(zh.profilesDescriptionLabel), 'Only docs and tests')
  await click(zh.profilesSave)
  const request = server.requests.find(item => item.path === 'profiles' && item.method === 'POST')!
  const body = request.body as { profile: Record<string, unknown>; reason: string }
  expect(body.reason).toBe('管理面板')
  expect(body.profile).toMatchObject({ role: 'worker', title: 'Docs helper', description: 'Only docs and tests',
    model: { mode: 'pinned', provider: 'deepseek', model: 'deepseek-v4.1' }, prompt: { mode: 'pinned', revision: 0 } })
  expect(body.profile.id).toMatch(/^worker-/)
  expect(body.profile).not.toHaveProperty('maxActionLevel')
  expect(body.profile).not.toHaveProperty('approval')
  expect((body.profile.tools as { names: string[] }).names).toContain('read')
  expect((body.profile.tools as { names: string[] }).names).not.toContain('orchestrator_route')
})

it('opens version history, hides the internal id until technical details, and shows field metrics on demand', async () => {
  fixture(); await open()
  await click('文档与测试')
  expect(text()).toContain('第 1 版')
  expect(text()).toContain('第 2 版')
  expect(text()).not.toContain('worker-docs')
  await click(zh.profilesTech)
  expect(text()).toContain('worker-docs')
  await click(zh.profilesMetrics)
  expect(text()).toContain('deepseek/deepseek-v4.1')
  expect(text()).toContain('<5')
  expect(text()).toContain('1200 / 340')
  expect(server.requests.some(item => item.path === 'profiles/worker-docs/metrics')).toBe(true)
})

it('disables, re-enables and rolls back only through the management routes', async () => {
  fixture(); await open()
  await click('文档与测试')
  await click(all('button').filter(item => item.textContent === zh.profilesDisable).at(-1)!)
  await click(zh.confirm)
  expect(server.requests.find(item => item.path === 'profiles/worker-docs/enabled')?.body).toMatchObject({ enabled: false })
  await click(zh.profilesEnable)
  expect(server.requests.filter(item => item.path === 'profiles/worker-docs/enabled').at(-1)?.body).toMatchObject({ enabled: true })
  await click(all('button').filter(item => item.textContent === zh.profilesRollback).at(-1)!)
  await click(zh.confirm)
  expect(server.requests.find(item => item.path === 'profiles/worker-docs/rollback')?.body).toMatchObject({ reason: '管理面板' })
})

it('saves the independent profile switches without touching Settings', async () => {
  fixture(); server.profileConfig = { ...server.profileConfig, enabled: false }; await open()
  await click(find(zh.profilesEnabled, '[role="switch"]'))
  await click(zh.profilesConfigSave)
  const request = server.requests.find(item => item.path === 'profiles/config')!
  expect(request.body).toMatchObject({ enabled: true, resolve: 'snapshot', telemetry: true, defaultProfile: 'worker-docs', reason: '管理面板' })
  expect(server.requests.some(item => item.method === 'PUT' && item.path.startsWith('settings/'))).toBe(false)
})
