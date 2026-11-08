/** X-11: an installed profile composes every row of the bundle patch through the host's own `dsh --dump-config`, so a host upgrade or a package split that stops applying `cordis.patch.yml` fails here instead of installing silently. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/** The bundle's root package, which a profile installs as `dsh-superagent`. */
const bundle = join(import.meta.dirname, '..')
/** The host CLI the profile dumps through; CI installs it, and `DSH_BIN` points a local run at another copy. */
const dsh = process.env.DSH_BIN ?? 'dsh'

interface Row { id?: string; name?: string; disabled?: unknown; config?: { id?: string; order?: number; [key: string]: unknown } }
interface ExpectedRow { id: string; name: string; disabled?: true; preset?: string; order?: number }
/** The six rows `cordis.patch.yml` inserts: the bundle, three Sources, and the two agent presets. */
const expected: ExpectedRow[] = [
  { id: 'dsh-superagent', name: 'dsh-superagent' },
  { id: 'dsh-superagent-github', name: 'dsh-superagent/github-watch' },
  { id: 'dsh-superagent-feishu', name: 'dsh-superagent/feishu-watch', disabled: true },
  { id: 'dsh-superagent-feishu-doc', name: 'dsh-superagent/feishu-doc-watch', disabled: true },
  { id: 'dsh-superagent-worker-preset', name: '@deepseek-ai/dsh-agent-preset', preset: 'dsh-superagent-worker', order: 90 },
  { id: 'dsh-superagent-router-preset', name: '@deepseek-ai/dsh-agent-preset', preset: 'dsh-superagent-router', order: 91 },
]

/**
 * Compare a composed profile with the rows the bundle must contribute. Every failure names the row (by id and plugin name) and the
 * field that differs, so a host change that drops or rewrites one row says which one instead of only that the count is wrong.
 */
function check(composed: readonly Row[]): void {
  const failures: string[] = []
  const ids = composed.map(row => row.id ?? '(no id)')
  const byId = new Map(composed.map(row => [row.id, row]))
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))]
  if (duplicates.length !== 0) failures.push(`duplicate row ids: ${duplicates.join(', ')}`)
  if (composed.length !== expected.length) failures.push(`expected ${expected.length} rows, found ${composed.length}: ${ids.join(', ')}`)
  for (const want of expected) {
    const row = byId.get(want.id)
    if (row === undefined) {
      failures.push(`missing row ${JSON.stringify(want.id)} (${want.name}); the dump has: ${ids.join(', ')}`)
      continue
    }
    if (row.name !== want.name) failures.push(`row ${JSON.stringify(want.id)}: name is ${JSON.stringify(row.name)}, expected ${JSON.stringify(want.name)}`)
    if ('disabled' in want) {
      if (row.disabled !== true) failures.push(`row ${JSON.stringify(want.id)}: disabled is ${JSON.stringify(row.disabled)}, expected true`)
    } else if (row.disabled !== undefined) failures.push(`row ${JSON.stringify(want.id)}: disabled is ${JSON.stringify(row.disabled)}, expected no disabled flag`)
    if (want.preset !== undefined) {
      if (row.config?.id !== want.preset) failures.push(`row ${JSON.stringify(want.id)}: config.id is ${JSON.stringify(row.config?.id)}, expected ${JSON.stringify(want.preset)}`)
      if (row.config?.order !== want.order) failures.push(`row ${JSON.stringify(want.id)}: config.order is ${JSON.stringify(row.config?.order)}, expected ${want.order}`)
    }
  }
  const found = ids.filter(id => expected.some(want => want.id === id))
  const wanted = expected.map(want => want.id)
  if (found.join('\n') !== wanted.join('\n')) failures.push(`rows appear in the order ${found.join(', ')}; expected ${wanted.join(', ')}`)
  if (failures.length !== 0) throw new Error(`the profile does not compose the six rows the bundle patch installs:\n- ${failures.join('\n- ')}`)
}

/** Parse the host's dump with the entry-list dialect it prints, including its `!!js` scalars. */
async function parsed(dump: string): Promise<Row[]> {
  const cordis = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/cordis/package.json'))
  const include = cordis.resolve('@deepseek-ai/cordis-plugin-include')
  const { entryListSchema } = await import(include) as { entryListSchema: unknown }
  const yaml = await import(createRequire(include).resolve('js-yaml')) as { load(text: string, options: { schema: unknown }): unknown }
  return yaml.load(dump, { schema: entryListSchema }) as Row[]
}

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

/** A fresh Harness home with one profile that installs this bundle by link, as `dsh plugin --profile x11 add link:<bundle>` would. */
function installed(userLayer = '[]\n'): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-dump-config-'))
  homes.push(home)
  const dir = join(home, 'profiles', 'x11')
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-x11', private: true,
    dependencies: { 'dsh-superagent': `link:${bundle}` }, dsh: { profile: { bundles: ['dsh-superagent'] } } }, undefined, 2) + '\n')
  symlinkSync(bundle, join(dir, 'node_modules', 'dsh-superagent'), 'dir')
  writeFileSync(join(dir, 'cordis.patch.yml'), userLayer)
  return home
}

/** Run the host's dump for the profile, refusing a non-zero exit or a warning that says a bundle was skipped. */
function dumped(home: string): string {
  const result = spawnSync(dsh, ['--profile', 'x11', '--dump-config'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
  if (result.error !== undefined) throw new Error(`cannot run \`${dsh} --dump-config\`; install @deepseek-ai/dsh or set DSH_BIN: ${String(result.error)}`)
  if (result.status !== 0) throw new Error(`dsh --dump-config exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`)
  if (result.stderr.trim() !== '') throw new Error(`dsh --dump-config reported: ${result.stderr.trim()}`)
  return result.stdout
}

/** The six rows as a parsed dump would hand them back, for the failure-message tests. */
const complete = (): Row[] => expected.map(want => ({ id: want.id, name: want.name,
  ...('disabled' in want ? { disabled: true } : {}), ...(want.preset === undefined ? {} : { config: { id: want.preset, order: want.order } }) }))

describe('X-11: the bundle as an installed profile sees it', () => {
  it('composes all six patch rows through the host dump-config', async () => {
    const composed = await parsed(dumped(installed()))
    check(composed)
    expect(composed).toHaveLength(6)
  })
  it('keeps all six rows when the profile layer already configures the bundle', async () => {
    const composed = await parsed(dumped(installed('- id: dsh-superagent\n  config:\n    stateDir: /srv/dsh-superagent\n')))
    check(composed)
    expect(composed.find(row => row.id === 'dsh-superagent')?.config).toMatchObject({ stateDir: '/srv/dsh-superagent' })
  })
  it('names the missing row and the wrong field when the dump is incomplete', () => {
    expect(() => check(complete().filter(row => row.id !== 'dsh-superagent-feishu')))
      .toThrow('missing row "dsh-superagent-feishu" (dsh-superagent/feishu-watch); the dump has: dsh-superagent, dsh-superagent-github, dsh-superagent-feishu-doc')
    expect(() => check(complete().map(row => row.id === 'dsh-superagent-router-preset' ? { ...row, config: { ...row.config, order: 90 } } : row)))
      .toThrow('row "dsh-superagent-router-preset": config.order is 90, expected 91')
  })
})