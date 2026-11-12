import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PUBLIC_ROUTES, ROUTES } from '@superagent/dsh/app/api-contract.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(ROOT, 'docs')
const NUMBERED = /^(\d{3})-[a-z0-9-]+(?:\.zh)?\.md$/
const numbered = readdirSync(DOCS).filter(name => NUMBERED.test(name)).sort()
const entries = ['README.md', 'SETUP.md', 'ARCHITECTURE-TOUR.zh.md', 'PLUGIN-PACKAGING.zh.md']
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
function links(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/\]\(([^)\s]+)\)/g)].map(match => match[1]!.split('#')[0]!).filter(target => target && !/^[a-z]+:/.test(target))
}
const files = (directory: string): string[] => readdirSync(join(ROOT, directory), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile()).map(entry => relative(ROOT, join(entry.parentPath, entry.name)))
/** Every Markdown document this repository publishes, relative to the root. */
function documents(): string[] {
  return [...entries, ...readdirSync(DOCS, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => relative(ROOT, join(entry.parentPath, entry.name)))]
}
const MANIFEST_SOURCE = 'packages/kernel/src/manifest.ts'
const API_SOURCE = 'packages/dsh/src/app/api-contract.ts'
const MANIFEST_GUIDE = 'docs/010-adding-a-source.md'
const DEPLOYMENT_GUIDE = 'docs/006-deployment.md'
/**
 * The body rows of the first table under `### <heading>` in `file`. A missing section or table
 * fails with the file and heading, because that is the documentation the check requires.
 */
function tableRows(file: string, heading: string): string[] {
  const lines = read(file).split('\n')
  const start = lines.findIndex(line => /^#{2,3} /.test(line) && line.replace(/^#{2,3} /, '').trim() === heading)
  if (start < 0) throw new Error(`${file} has no "${heading}" section; add it so tests/docs.spec.ts can find the table`)
  const end = lines.findIndex((line, index) => index > start && /^#{2,3} /.test(line))
  const section = lines.slice(start + 1, end < 0 ? undefined : end)
  const first = section.findIndex(line => line.trimStart().startsWith('|'))
  if (first < 0) throw new Error(`${file} has no table under "${heading}"; add one so tests/docs.spec.ts can read it`)
  const table: string[] = []
  for (const line of section.slice(first)) {
    const row = line.trimStart()
    if (!row.startsWith('|')) break
    table.push(row.trimEnd())
  }
  // The first two rows are the header and its separator.
  return table.slice(2)
}
/** The trimmed contents of one cell of a Markdown table row, counting the first content cell as 0. */
function cell(row: string, index = 0): string {
  return row.replace(/^\|/, '').replace(/\|$/, '').split('|')[index]!.trim()
}
/** The inline code spans in one table cell. */
function codeSpans(value: string): string[] {
  return [...value.matchAll(/`([^`]+)`/g)].map(match => match[1]!)
}
/** The property names declared directly on `SourceManifest`, read from its interface rather than a second list. */
function manifestFields(): string[] {
  const source = read(MANIFEST_SOURCE)
  const start = source.indexOf('export interface SourceManifest {')
  const end = source.indexOf('\n}', start)
  if (start < 0 || end < 0) throw new Error(`${MANIFEST_SOURCE} has no readable SourceManifest interface`)
  const body = source.slice(start, end)
  const fields = [...body.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map(match => match[1]!)
  if (fields.length === 0) throw new Error(`${MANIFEST_SOURCE}'s SourceManifest interface declares no fields in the expected form`)
  return fields
}
/** The SourceManifest field names documented in the manifest guide's table; the first code span names the field. */
function documentedManifestFields(): string[] {
  return tableRows(MANIFEST_GUIDE, 'Manifest fields').flatMap(row => codeSpans(cell(row)).slice(0, 1))
}
/** Every route key declared in the contract, read from the object rather than a second list. */
function apiRoutes(): string[] {
  return Object.keys(ROUTES)
}
/** The routes documented in the deployment guide's Management API table. */
function documentedRoutes(): string[] {
  return tableRows(DEPLOYMENT_GUIDE, 'Management API').flatMap(row => codeSpans(cell(row))
    .filter(span => /^(GET|POST|PUT|PATCH|DELETE) \S/.test(span)))
}
/** A route with parameter names and angle-bracket placeholders erased, so the two spellings compare equal. */
function routeShape(route: string): string {
  return route.replace(/<[^>]+>/g, ':').replace(/:[A-Za-z][A-Za-z0-9]*/g, ':')
}
/**
 * Extract repo-relative file paths from the first column of a table under `## <heading>` in `docs/007-architecture.md`.
 * Bare filenames inherit the directory of the preceding path in the same cell.
 */
function listed(heading: string): string[] {
  const lines = read('docs/007-architecture.md').split('\n')
  const start = lines.indexOf(`## ${heading}`)
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  // The first two rows are the header and its separator.
  const rows = lines.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith('| ')).slice(2)
  return rows.flatMap(row => {
    let directory = ''
    return [...row.split('|')[1]!.matchAll(/`([^`]+)`/g)].map(([, name]) => {
      if (!name!.includes('/')) return join(directory, name!)
      directory = dirname(name!)
      return name!
    })
  })
}

/** The numbered document filenames the README's Documentation list names, in order. */
function readmeList(): string[] {
  const readme = read('README.md')
  const start = readme.indexOf('## Documentation')
  const end = readme.indexOf('## Development')
  return [...readme.slice(start, end).matchAll(/\]\(docs\/((\d{3})-[a-z0-9-]+(?:\.zh)?\.md)\)/g)].map(match => match[1]!)
}

/**
 * Design principles (011) and platform evolution (012) are a deliberate pair,
 * so 011 may link forward to 012. The reverse needs no exception: 011 is earlier.
 */
const PAIR: Record<string, string> = { '011': '012' }

const TASK_PLAN = 'docs/plan/TASK-PLAN.zh.md'
const TRACKING = 'docs/plan/TRACKING.zh.md'
const TASK_STATUSES = new Set(['未开始', '进行中', '已完成', '已暂停', '已取消'])
// Format and field gate; scripts/check-tracking.mjs adds cross-file alignment, PR state and exemptions.
const PR_URL = /^https:\/\/github\.com\/touch-agent\/dsh-superagent\/pull\/\d+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
/** A real calendar date in YYYY-MM-DD form. */
function validDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day!))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day
}

interface TrackingRow {
  task: string
  status: string
  pr: string
  evidence: string
  updated: string
}

function trackingRows(): TrackingRow[] {
  return read(TRACKING).split('\n').filter(line => /^\|\s*[TSXE]\d?-\d{2}\s*\|/.test(line)).map(line => {
    const task = /^\|\s*([TSXE]\d?-\d{2})\s*\|/.exec(line)![1]!
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    return { task, status: cells[1]!, pr: cells[2]!, evidence: cells[3]!, updated: cells[4]! }
  })
}

/** Every task id the plan declares, wherever it appears. */
function planTasks(): string[] {
  return [...new Set([...read(TASK_PLAN).matchAll(/\b([TSXE]\d?-\d{2})\b/g)].map(match => match[1]!))]
}

describe('documentation', () => {
  it('numbers documents consecutively from 000', () => {
    expect(numbered.map(name => name.slice(0, 3))).toEqual(numbered.map((_, index) => String(index).padStart(3, '0')))
  })
  it('lists every numbered document once in the README, in order', () => {
    expect(readmeList()).toEqual(numbered)
  })
  it('maps every numbered document once in docs/README, in order', () => {
    const mapped = [...read('docs/README.md').matchAll(/\]\(((\d{3})-[a-z0-9-]+(?:\.zh)?\.md)\)/g)].map(match => match[1]!)
    expect(mapped).toEqual(numbered)
  })
  it('links numbered documents only backwards, except 011 → 012', () => {
    const violations = numbered.flatMap(name => links(join(ROOT, 'docs', name)).flatMap(target => {
      const linked = resolve(ROOT, 'docs', target)
      if (!linked.endsWith('.md')) return []
      const number = NUMBERED.exec(linked.slice(linked.lastIndexOf('/') + 1))?.[1]
      const current = name.slice(0, 3)
      const allowed = number !== undefined && (number < current || PAIR[current] === number)
      return dirname(linked) === join(ROOT, 'docs') && !allowed ? [`${name} → ${target}`] : []
    }))
    expect(violations).toEqual([])
  })
  it('links the design and evolution pair to each other', () => {
    expect(links(join(ROOT, 'docs', '011-design-principles.zh.md'))).toContain('012-platform-evolution.zh.md')
    expect(links(join(ROOT, 'docs', '012-platform-evolution.zh.md'))).toContain('011-design-principles.zh.md')
  })
  it('resolves every local link', () => {
    const missing = documents().flatMap(path => {
      const file = join(ROOT, path)
      return links(file).filter(target => !existsSync(resolve(dirname(file), target))).map(target => `${path} → ${target}`)
    })
    expect(missing).toEqual([])
  })
  it('leaves no merge conflict markers in any document', () => {
    expect(documents().filter(path => /^(<{7}|>{7}) /m.test(read(path)))).toEqual([])
  })
  it('leaves no moved document at the repository root', () => {
    const moved = ['DESIGN-PRINCIPLES.zh.md', 'PLATFORM-EVOLUTION.zh.md', 'TASK-PLAN.zh.md', 'M1-KICKOFF.zh.md', 'SESSION-ENTRY.zh.md']
    expect(moved.filter(path => existsSync(join(ROOT, path)))).toEqual([])
  })
  it('tracks every plan task once, with valid status, PR, evidence and date', () => {
    const rows = trackingRows()
    const ids = rows.map(row => row.task)
    expect(new Set(ids).size).toEqual(ids.length)
    expect([...ids].sort()).toEqual([...planTasks()].sort())

    const problems = rows.flatMap(row => {
      const issues: string[] = []
      if (!TASK_STATUSES.has(row.status)) issues.push(`bad status: ${row.status}`)
      if (row.pr !== '—' && !PR_URL.test(row.pr)) issues.push(`bad PR: ${row.pr}`)
      if (!row.evidence) issues.push('empty evidence')
      if (!validDate(row.updated)) issues.push(`bad date: ${row.updated}`)
      if (row.status === '未开始' && (row.pr !== '—' || row.evidence !== '—')) issues.push('未开始 must have no PR or evidence')
      if (row.status === '已完成' && row.evidence === '—') issues.push('已完成 needs acceptance evidence')
      return issues.map(issue => `${row.task}: ${issue}`)
    })
    expect(problems).toEqual([])
  })
  it('lists every module under packages in the module table of 007 Architecture, and only files that exist', () => {
    const modules = listed('Modules')
    expect([...files('packages')].filter(path => /\.tsx?$/.test(path) && !/\/node_modules\//.test(path) && !/^packages\/[^/]+\/lib\//.test(path)
      && !modules.includes(path))).toEqual([])
    expect(modules.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
  it('lists every test in the test table of 007 Architecture, and only files that exist', () => {
    const tests = listed('Tests')
    expect(files('tests').filter(path => /\.spec\.tsx?$/.test(path) && !tests.includes(path))).toEqual([])
    expect(tests.filter(path => !existsSync(join(ROOT, path)))).toEqual([])
  })
  it('documents every SourceManifest field, and only fields that exist', () => {
    const fields = manifestFields()
    const documented = documentedManifestFields()
    const problems = [
      ...fields.filter(field => !documented.includes(field)).map(field =>
        `SourceManifest.${field} is undocumented: add a row for \`${field}\` under "Manifest fields" in ${MANIFEST_GUIDE}`),
      ...documented.filter(field => !fields.includes(field)).map(field =>
        `${MANIFEST_GUIDE} documents \`${field}\` under "Manifest fields", but ${MANIFEST_SOURCE} has no such SourceManifest field; remove or correct that row`),
      ...documented.filter((field, index) => documented.indexOf(field) !== index).map(field =>
        `${MANIFEST_GUIDE} documents \`${field}\` more than once under "Manifest fields"`),
    ]
    expect(problems).toEqual([])
  })
  it('documents every public management route, and only routes that exist', () => {
    const routes = apiRoutes()
    const documented = documentedRoutes()
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const route of documented) {
      const shape = routeShape(route)
      if (seen.has(shape)) duplicates.push(route)
      else seen.set(shape, route)
    }
    const documentedUnique = [...seen.values()]
    const publicRoutes = [...PUBLIC_ROUTES]
    const shapes = new Set(publicRoutes.map(routeShape))
    const documentedShapes = new Set(seen.keys())
    const problems = [
      ...publicRoutes.filter((route, index) => publicRoutes.indexOf(route) !== index).map(route =>
        `${API_SOURCE} lists ${route} in PUBLIC_ROUTES more than once`),
      ...publicRoutes.filter(route => !routes.includes(route)).map(route =>
        `${API_SOURCE} lists ${route} in PUBLIC_ROUTES, but Api declares no such route; remove it or add the route`),
      ...duplicates.map(route =>
        `${DEPLOYMENT_GUIDE} documents ${route} more than once in the Management API table; keep one row`),
      ...publicRoutes.filter(route => !documentedShapes.has(routeShape(route))).map(route =>
        `public route ${route} is missing from the Management API table in ${DEPLOYMENT_GUIDE}; add a row for \`${route}\``),
      ...documentedUnique.filter(route => !shapes.has(routeShape(route))).map(route =>
        `${DEPLOYMENT_GUIDE} documents ${route} in the Management API table, but ${API_SOURCE} does not list it in PUBLIC_ROUTES; add it there or remove the row`),
    ]
    expect(problems).toEqual([])
  })
})
