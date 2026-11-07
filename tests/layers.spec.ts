/** Verifies the layer rules of docs/007-architecture.md: a Source never depends on the host, the panel sees the host side only through types and the documented plain values, and no source crosses into packages/ by relative path. */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** One import statement, kept whole so a type-only import stays distinguishable from a value import. */
type ImportStatement = { statement: string; specifier: string }

/** The directories whose relative imports the panel must take as types, plus the paths that name their owners. */
const HOST_PREFIXES = ['../app/', '../sources/', '../infra/'] as const

/** The plain-value modules the panel may import as values, per the Dependency rules. */
const VALUE_MODULES = new Set(['../admission.ts', '../limits.ts', '../setup.ts', '../navigation.ts', '../sources/host.ts'])

/** `packages/dsh/src/app/api.ts` is a whitelist for its filter constants, which are its whole value surface. */
const FILTER_CONSTANTS: Record<string, readonly string[]> = { '../app/api.ts': ['TICKET_FILTERS', 'THREAD_FILTERS'] }

/** Every TypeScript file under a tree, as a path relative to the repository root. */
function files(tree: string): string[] {
  return readdirSync(join(ROOT, tree), { recursive: true, encoding: 'utf8' })
    .filter(path => /\.tsx?$/.test(path))
    .map(path => `${tree}/${path}`)
}

/** Every module specifier a file imports or re-exports, static or dynamic, with the statement that carried it. */
function importsOf(path: string): ImportStatement[] {
  const text = readFileSync(join(ROOT, path), 'utf8')
  const found: ImportStatement[] = []
  for (const match of text.matchAll(/^import\s+(?:type\s+)?(?:[\w*{][\s\S]*?from\s+(['"])([^'"]+)\1|(['"])([^'"]+)\3)/gm)) {
    found.push({ statement: match[0], specifier: match[2] ?? match[4]! })
  }
  for (const match of text.matchAll(/^export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[\s\S]*?\})\s*from\s+(['"])([^'"]+)\1/gm)) {
    found.push({ statement: match[0], specifier: match[2]! })
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    found.push({ statement: match[0], specifier: match[2]! })
  }
  return found
}

/** Whether a statement at `import` or `export` imports types only, so it leaves no runtime edge. */
function isTypeOnly(statement: string): boolean {
  return /^(?:import|export)\s+type\s/.test(statement)
}

/** The value bindings of a named import or re-export, leaving out inline `type` bindings; null when the form cannot be judged. */
function valueBindings(statement: string): string[] | null {
  const named = /^(?:import|export)\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s+/.exec(statement)
  if (!named) return null
  return named[1]!.split(',')
    .map(binding => binding.trim())
    .filter(binding => binding.length > 0 && !binding.startsWith('type '))
    .map(binding => binding.split(/\s+as\s+/)[0]!.trim())
}

describe('the layers of docs/007-architecture.md', () => {
  it('keeps Sources free of the host: nothing under packages/dsh/src/sources imports from packages/dsh/src/app', () => {
    const offenders = files('packages/dsh/src/sources').flatMap(path => importsOf(path)
      .filter(({ specifier }) => specifier.startsWith('../app/'))
      .map(({ specifier }) => `${path} → ${specifier}`))
    expect(offenders).toEqual([])
  })
  it('lets the panel take only types and the whitelisted plain values from the host side, never the Runtime', () => {
    const offenders = files('packages/dsh/src/client').flatMap(path => importsOf(path).flatMap(({ statement, specifier }) => {
      const where = `${path} → ${specifier}`
      if (specifier === '../app/runtime.ts') return [where]
      if (isTypeOnly(statement)) return []
      if (!HOST_PREFIXES.some(prefix => specifier.startsWith(prefix))) return []
      // `@superagent/kernel` and `node:*` name packages, so they never reach this relative-path check.
      const allowed = FILTER_CONSTANTS[specifier]
      if (allowed) {
        const bindings = valueBindings(statement)
        return bindings && bindings.every(binding => allowed.includes(binding)) ? [] : [where]
      }
      return VALUE_MODULES.has(specifier) ? [] : [where]
    }))
    expect(offenders).toEqual([])
  })
  it('reaches packages/ only by package name, never by relative path', () => {
    const offenders = [...files('packages/dsh/src'), ...files('tests')].flatMap(path => importsOf(path)
      .filter(({ specifier }) => specifier.startsWith('.') && /(^|\/)packages\//.test(specifier))
      .map(({ specifier }) => `${path} → ${specifier}`))
    expect(offenders).toEqual([])
  })
  it('keeps the browser half free of Node built-ins', () => {
    const offenders = files('packages/dsh/src/client').flatMap(path => importsOf(path)
      .filter(({ specifier }) => specifier.startsWith('node:'))
      .map(({ specifier }) => `${path} → ${specifier}`))
    expect(offenders).toEqual([])
  })
})