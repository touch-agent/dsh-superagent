/**
 * X-02: dependency-cruiser replaces the hand-written import scanner for the layer
 * rules of docs/007-architecture.md.
 *
 * The fixtures under tests/fixtures/dependency-rules are the negative half of the
 * check: every rule gets a deliberately added violation, so a rule that stops
 * matching fails here instead of silently passing CI. The clean fixture is the
 * other half: the imports the architecture allows must stay free of violations.
 *
 * Two rules cannot be expressed as dependency-cruiser path rules and stay as
 * assertions here: the kernel manifest may declare no dependency at all, and the
 * panel's value import from app/api.ts may name only its filter constants.
 */
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { cruise, type ICruiseOptions, type ICruiseResult, type IConfiguration } from 'dependency-cruiser'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'dependency-rules')
const KERNEL = join(ROOT, 'packages', 'kernel')
const CLIENT = join(ROOT, 'packages', 'dsh', 'src', 'client')
const PANEL_VALUE_MODULES = new Set(['TICKET_FILTERS', 'THREAD_FILTERS'])

/** The real rule set, so a fixture cruises the same rules CI runs. */
const config = (await import(pathToFileURL(join(ROOT, '.dependency-cruiser.mjs')).href)).default as IConfiguration

/** Cruise one tree with the repository's rule set and return its report. */
async function report(baseDir: string): Promise<ICruiseResult> {
  const options: ICruiseOptions = {
    ...config.options,
    validate: true,
    ruleSet: { forbidden: config.forbidden },
    baseDir,
    tsConfig: { fileName: join(baseDir, 'tsconfig.json') },
    outputType: 'json',
  }
  const { output } = await cruise(['packages', 'meta', 'tests'], options)
  return JSON.parse(String(output)) as ICruiseResult
}

/** The rule names a report reports, sorted. */
function rulesOf(report: ICruiseResult): string[] {
  return [...new Set(report.summary.violations.map(violation => violation.rule.name))].sort()
}

/** The files each rule reports against, keyed by rule name and sorted. */
function offendersOf(report: ICruiseResult): Record<string, string[]> {
  const offenders: Record<string, string[]> = {}
  for (const violation of report.summary.violations) {
    ;(offenders[violation.rule.name] ??= []).push(violation.from)
  }
  for (const rule of Object.keys(offenders)) offenders[rule] = [...new Set(offenders[rule]!)].sort()
  return offenders
}

/** The value bindings of a named import/export clause; null for a namespace, default or side-effect form. */
function valueBindings(clause: string): string[] | null {
  const named = /^\{([\s\S]*?)\}$/.exec(clause.trim())
  if (named === null) return null
  return named[1]!.split(',')
    .map(binding => binding.trim())
    .filter(binding => binding.length > 0 && !binding.startsWith('type '))
    .map(binding => binding.split(/\s+as\s+/)[0]!.trim())
}

/** Every non-type import, re-export or dynamic import of app/api.ts that is not one of its filter constants. */
function apiValueViolations(text: string, file = ''): string[] {
  const violations: string[] = []
  const illegal = (clause: string | null): boolean => {
    const bindings = clause === null ? null : valueBindings(clause)
    return bindings === null || bindings.some(binding => !PANEL_VALUE_MODULES.has(binding))
  }
  for (const match of text.matchAll(/^import\s+(?:type\s+)?(?:[\w*{][\s\S]*?from\s+(['"])([^'"]+)\1|(['"])([^'"]+)\3)/gm)) {
    const specifier = match[2] ?? match[4]
    if (specifier !== '../app/api.ts') continue
    const statement = match[0]
    if (/^import\s+type\s/.test(statement)) continue
    const clause = /^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+/.exec(statement)?.[1] ?? null
    if (illegal(clause)) violations.push(`${file}: ${statement}`)
  }
  for (const match of text.matchAll(/^export\s+(?:type\s+)?(\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]\.\.\/app\/api\.ts['"]/gm)) {
    const statement = match[0]
    if (/^export\s+type\s/.test(statement)) continue
    if (illegal(match[1]!)) violations.push(`${file}: ${statement}`)
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]\.\.\/app\/api\.ts['"]\s*\)/g)) {
    // A `typeof import(...)` is a type query, not a value import.
    if (/typeof\s*$/.test(text.slice(0, match.index))) continue
    violations.push(`${file}: ${match[0]}`)
  }
  return violations
}

describe('the dependency rules of docs/007-architecture.md', () => {
  // The repository itself is cruised by `pnpm check:arch` (part of `pnpm check`);
  // this spec uses the same rule set on fixtures so the suite stays fast.
  it('accepts every allowed import in the clean fixture', async () => {
    const cruised = await report(realpathSync(join(FIXTURES, 'clean')))
    expect(offendersOf(cruised)).toEqual({})
  })

  it('catches a newly added violation in every rule', async () => {
    const cruised = await report(realpathSync(join(FIXTURES, 'violations')))
    // Every configured rule must appear in the fixtures, so a new rule without a
    // reverse test fails this test rather than relying on review alone.
    expect(rulesOf(cruised)).toEqual(config.forbidden!.map(rule => rule.name!).sort())
    expect(offendersOf(cruised)).toEqual({
      'kernel-zero-dependencies': ['packages/kernel/src/external.ts', 'packages/kernel/src/io.ts', 'packages/kernel/src/outside.ts'],
      'kernel-never-reaches-out': ['packages/kernel/src/outside.ts'],
      'runtime-does-not-depend-on-bundle': ['packages/dsh/src/app/imports-bundle.ts'],
      'runtime-uses-kernel-by-package-name': ['packages/dsh/src/app/imports-kernel-by-path.ts'],
      'meta-re-exports-runtime-only': ['meta/imports-other.ts'],
      'meta-uses-runtime-by-package-name': ['meta/imports-runtime.ts', 'meta/reexports-runtime-by-path.ts'],
      'meta-reexport-only': ['meta/imports-runtime.ts'],
      'sources-do-not-import-app': ['packages/dsh/src/sources/imports-app.ts'],
      'panel-never-imports-runtime': ['packages/dsh/src/client/imports-runtime.ts'],
      'panel-values-only-from-whitelist': [
        'packages/dsh/src/client/imports-host-value.ts',
        'packages/dsh/src/client/imports-runtime.ts',
      ],
      'panel-no-node-builtins': ['packages/dsh/src/client/imports-node.ts'],
      'packages-imported-by-name': ['packages/dsh/src/app/imports-kernel-by-path.ts', 'tests/imports-packages.ts'],
      'tests-do-not-reach-packages-by-relative-path': ['tests/imports-packages.ts'],
    })
  })

  it('declares no dependency in the kernel manifest', () => {
    const manifest = JSON.parse(readFileSync(join(KERNEL, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].filter(field => field in manifest)).toEqual([])
  })

  it('lets the panel name only filter constants as values from app/api.ts', () => {
    const violations = readdirSync(CLIENT, { recursive: true, encoding: 'utf8' })
      .filter(name => /\.tsx?$/.test(name))
      .flatMap(name => apiValueViolations(readFileSync(join(CLIENT, name), 'utf8'), name))
    expect(violations).toEqual([])
  })

  it('refuses a namespace, default or side-effect import of app/api.ts', () => {
    const violations = apiValueViolations([
      "import { TICKET_FILTERS, type TicketFilter } from '../app/api.ts'",
      "import type { Api } from '../app/api.ts'",
      "import { filter } from '../app/api.ts'",
      "import * as api from '../app/api.ts'",
      "import defaults from '../app/api.ts'",
      "import '../app/api.ts'",
      "const api = await import('../app/api.ts')",
      "export type ApiModule = typeof import('../app/api.ts')",
      "export type { Api } from '../app/api.ts'",
      "export * from '../app/api.ts'",
      "export { TICKET_FILTERS as filters } from '../app/api.ts'",
      "export { filter } from '../app/api.ts'",
    ].join('\n'))
    expect(violations).toHaveLength(7)
  })
})