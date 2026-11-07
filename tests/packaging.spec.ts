/** Guards the split between the bundle and the runtime: the names the patch resolves stay the same, the bundle installs the runtime instead of carrying it, and each package ships what it promises. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as bundleEntry from '../meta/index.ts'
import * as feishuEntry from '../meta/feishu-watch.ts'
import * as githubEntry from '../meta/github-watch.ts'
import * as runtimeEntry from '@superagent/dsh/index.ts'
import * as runtimeFeishu from '@superagent/dsh/feishu-watch'
import * as runtimeGithub from '@superagent/dsh/github-watch'

interface Manifest {
  name: string
  dependencies?: Record<string, string>
  files?: string[]
  exports: Record<string, unknown>
  dsh?: { bundle?: { patch?: string } }
}
const manifest = (path: string): Manifest => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as Manifest
const bundle = manifest('package.json')
const runtime = manifest('packages/dsh/package.json')

describe('the split between the bundle and the runtime', () => {
  it('keeps the bundle name and the three entry names its patch rows resolve', () => {
    expect(bundle.name).toBe('dsh-superagent')
    expect(Object.keys(bundle.exports)).toEqual(expect.arrayContaining(['.', './client', './github-watch', './feishu-watch']))
    expect(bundle.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })
  it('installs the runtime as a dependency and keeps the packaged content with its reader', () => {
    expect(bundle.dependencies).toEqual({ '@superagent/dsh': 'workspace:*' })
    expect(bundle.files).not.toContain('skills')
    expect(bundle.files).not.toContain('prompts')
    expect(runtime.name).toBe('@superagent/dsh')
    expect(runtime.exports).toHaveProperty('./github-watch')
    expect(runtime.files).toEqual(expect.arrayContaining(['lib', 'skills', 'prompts']))
  })
  it('re-exports the runtime plugins unchanged, so a patch row and its entry are the same plugin', () => {
    expect(bundleEntry.name).toBe(runtimeEntry.name)
    expect(bundleEntry.apply).toBe(runtimeEntry.apply)
    expect(bundleEntry.inject).toEqual(runtimeEntry.inject)
    expect(githubEntry.apply).toBe(runtimeGithub.apply)
    expect(feishuEntry.apply).toBe(runtimeFeishu.apply)
  })
})
