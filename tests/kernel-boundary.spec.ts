/**
 * Verifies that the kernel stays a host-free workspace package: it may import only its own files and Node built-ins.
 *
 * @deprecated X-02 transitional: `.dependency-cruiser.mjs` checks the imports, and
 * `tests/dependency-rules.spec.ts` keeps the manifest assertion. This scanner stays
 * for one release; it is deleted in the release after the one that ships the config.
 * See "Architecture checks" in docs/007-architecture.md.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const KERNEL = join(ROOT, 'packages', 'kernel')
const modules = readdirSync(join(KERNEL, 'src'), { encoding: 'utf8' }).filter(name => /\.ts$/.test(name))

/** Every module specifier a kernel file imports or re-exports, including type-only and dynamic imports. */
function specifiers(text: string): string[] {
  return [...text.matchAll(/\bfrom\s+'([^']+)'|\bimport\s*\(\s*'([^']+)'\s*\)/g)].map(match => match[1] ?? match[2]!)
}

describe('the kernel package', () => {
  it('imports nothing but its own files and Node built-ins', () => {
    const offenders = modules.flatMap(name => specifiers(readFileSync(join(KERNEL, 'src', name), 'utf8'))
      .filter(specifier => !specifier.startsWith('./') && !specifier.startsWith('node:'))
      .map(specifier => `packages/kernel/src/${name} → ${specifier}`))
    expect(offenders).toEqual([])
  })
  it('never reaches back out of the package', () => {
    const offenders = modules.flatMap(name => specifiers(readFileSync(join(KERNEL, 'src', name), 'utf8'))
      .filter(specifier => specifier.startsWith('../'))
      .map(specifier => `packages/kernel/src/${name} → ${specifier}`))
    expect(offenders).toEqual([])
  })
  it('declares no dependency, so nothing outside it can leak in through resolution', () => {
    const manifest = JSON.parse(readFileSync(join(KERNEL, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].filter(field => field in manifest)).toEqual([])
  })
})