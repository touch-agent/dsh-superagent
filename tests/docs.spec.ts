import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

/** The numbered documents the README's Documentation list names, in order. */
function readmeList(): string[] {
  const readme = read('README.md')
  const start = readme.indexOf('## Documentation')
  const end = readme.indexOf('## Development')
  return [...readme.slice(start, end).matchAll(/\]\(docs\/(\d{3})-[a-z0-9-]+(?:\.zh)?\.md\)/g)].map(match => match[1]!)
}

/**
 * Design principles (011) and platform evolution (012) are a deliberate
 * cross-referencing pair, so each may link to the other in either direction.
 */
const PAIR: Record<string, string> = { '011': '012', '012': '011' }

const TASK_PLAN = 'docs/plan/TASK-PLAN.zh.md'
const TRACKING = 'docs/plan/TRACKING.zh.md'
const TASK_STATUSES = new Set(['未开始', '进行中', '已完成', '已暂停', '已取消'])
const PR_URL = /^https:\/\/github\.com\/touch-agent\/dsh-superagent\/pull\/\d+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

interface TrackingRow {
  task: string
  status: string
  pr: string
  evidence: string
  updated: string
}

function trackingRows(): TrackingRow[] {
  return read(TRACKING).split('\n').filter(line => /^\| [TSXE]\d?-\d{2} \|/.test(line)).map(line => {
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    return { task: cells[0]!, status: cells[1]!, pr: cells[2]!, evidence: cells[3]!, updated: cells[4]! }
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
    expect(readmeList()).toEqual(numbered.map(name => name.slice(0, 3)))
  })
  it('links numbered documents only to earlier numbered documents', () => {
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
      if (!DATE.test(row.updated) || Number.isNaN(Date.parse(row.updated))) issues.push(`bad date: ${row.updated}`)
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
})