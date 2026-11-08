import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'scripts', 'check-tracking.mjs')
const PLAN = join('docs', 'plan', 'TASK-PLAN.zh.md')
const TRACKING = join('docs', 'plan', 'TRACKING.zh.md')
const EXEMPTIONS = join('docs', 'plan', 'TRACKING-EXEMPTIONS.json')
const PR5 = 'https://github.com/touch-agent/dsh-superagent/pull/5'
const PR6 = 'https://github.com/touch-agent/dsh-superagent/pull/6'
const HEADER = '| 任务 | 状态 | PR | 验收证据 | 最后更新 |\n| --- | --- | --- | --- | --- |'
const PLAN_TEXT = `# TASK-PLAN

| 任务 | 说明 |
| --- | --- |
| T0-01 | 完成 |
| T1-01 | 进行中 |
| X-01 | 未开始 |
`
const TRACKING_TEXT = `# TRACKING

${HEADER}
| T0-01 | 已完成 | ${PR5} | \`tests/a.spec.ts\` | 2026-11-08 |
| T1-01 | 进行中 | ${PR6} | \`tests/b.spec.ts\` | 2026-11-08 |
| X-01 | 未开始 | — | — | 2026-11-08 |
`

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Run the real script so the tests cover its arguments, output and exit code. */
function run(root: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): RunResult {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', ...env },
    timeout: 15_000,
  })
  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
}

/** The asynchronous form, for a test whose fake GitHub server must answer the child. */
function runAsync(root: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--root', root, ...args], {
      env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', ...env },
      timeout: 15_000,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', status => resolve({ status, stdout, stderr }))
  })
}

const temporary: string[] = []

/** A checkout-shaped directory containing only the two plan documents. */
function fixture(options: { plan?: string; tracking?: string; exemptions?: unknown; exemptionsText?: string; prStates?: unknown } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'tracking-check-'))
  temporary.push(root)
  mkdirSync(join(root, 'docs', 'plan'), { recursive: true })
  writeFileSync(join(root, PLAN), options.plan ?? PLAN_TEXT)
  writeFileSync(join(root, TRACKING), options.tracking ?? TRACKING_TEXT)
  if (options.exemptionsText !== undefined) writeFileSync(join(root, EXEMPTIONS), options.exemptionsText)
  else if (options.exemptions !== undefined) writeFileSync(join(root, EXEMPTIONS), JSON.stringify(options.exemptions, null, 2))
  if (options.prStates !== undefined) writeFileSync(join(root, 'pr-states.json'), JSON.stringify(options.prStates, null, 2))
  return root
}

function withRow(tracking: string, task: string, row: string): string {
  return tracking.split('\n').map(line => line.startsWith(`| ${task} |`) ? row : line).join('\n')
}

function withoutRow(tracking: string, task: string): string {
  return tracking.split('\n').filter(line => !line.startsWith(`| ${task} |`)).join('\n')
}

function appendRow(tracking: string, row: string): string {
  return `${tracking.trimEnd()}\n${row}\n`
}

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('tracking check', () => {
  it('accepts the repository tracking table offline', () => {
    const result = run(ROOT)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('tracking check passed')
    expect(result.stdout).toContain('PR states: not queried')
  })

  it('reports a plan task without a tracking row', () => {
    const result = run(fixture({ tracking: withoutRow(TRACKING_TEXT, 'T1-01') }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('T1-01: no tracking row')
    expect(result.stderr).toContain('| T1-01 | 未开始 | — | — |')
  })

  it('reports a tracking row without a plan task', () => {
    const result = run(fixture({ tracking: appendRow(TRACKING_TEXT, '| T9-99 | 未开始 | — | — | 2026-11-08 |') }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('T9-99: the row has no task in')
  })

  it('reports a duplicate row', () => {
    const result = run(fixture({ tracking: appendRow(TRACKING_TEXT, `| T0-01 | 已完成 | ${PR5} | \`tests/a.spec.ts\` | 2026-11-08 |`) }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('T0-01: duplicate row')
  })

  it('rejects an invalid status', () => {
    const tracking = withRow(TRACKING_TEXT, 'T0-01', `| T0-01 | 完成 | ${PR5} | \`tests/a.spec.ts\` | 2026-11-08 |`)
    const result = run(fixture({ tracking }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('status "完成" is not one of')
  })

  it('rejects a non-canonical PR link', () => {
    const tracking = withRow(TRACKING_TEXT, 'T0-01', '| T0-01 | 已完成 | https://github.com/other/repo/pull/5 | `tests/a.spec.ts` | 2026-11-08 |')
    const result = run(fixture({ tracking }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is not a canonical link')
  })

  it('rejects a bad last-updated date', () => {
    const tracking = withRow(TRACKING_TEXT, 'T0-01', `| T0-01 | 已完成 | ${PR5} | \`tests/a.spec.ts\` | 2026-02-30 |`)
    const result = run(fixture({ tracking }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not a real YYYY-MM-DD date')
  })

  it('rejects an empty evidence cell and a completed row without evidence', () => {
    const empty = run(fixture({ tracking: withRow(TRACKING_TEXT, 'T1-01', `| T1-01 | 进行中 | ${PR6} |  | 2026-11-08 |`) }))
    expect(empty.status).toBe(1)
    expect(empty.stderr).toContain('acceptance evidence is empty')

    const dash = run(fixture({ tracking: withRow(TRACKING_TEXT, 'T0-01', `| T0-01 | 已完成 | ${PR5} | — | 2026-11-08 |`) }))
    expect(dash.status).toBe(1)
    expect(dash.stderr).toContain('status is 已完成 but acceptance evidence is —')
  })

  it('rejects a not-started row with a PR or evidence', () => {
    const tracking = withRow(TRACKING_TEXT, 'X-01', `| X-01 | 未开始 | ${PR5} | \`tests/a.spec.ts\` | 2026-11-08 |`)
    const result = run(fixture({ tracking }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('status is 未开始 but PR/evidence are filled')
  })

  it('rejects a row without the five fields', () => {
    const tracking = withRow(TRACKING_TEXT, 'T1-01', `| T1-01 | 进行中 | ${PR6} | 2026-11-08 |`)
    const result = run(fixture({ tracking }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('the row has 4 cells')
  })

  it('rejects a table without the five-field header', () => {
    const tracking = TRACKING_TEXT.replace(HEADER, '| Task | Status | PR | Evidence | Updated |\n| --- | --- | --- | --- | --- |')
    const result = run(fixture({ tracking }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('the tracking header is missing')
  })

  it('rejects an in-progress row without a PR unless an explicit exemption names it', () => {
    const tracking = withRow(TRACKING_TEXT, 'T1-01', '| T1-01 | 进行中 | — | `tests/b.spec.ts` | 2026-11-08 |')
    const failed = run(fixture({ tracking }))
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('in-progress-without-pr')

    const waived = run(fixture({
      tracking,
      exemptions: { exemptions: [{ task: 'T1-01', rule: 'in-progress-without-pr', reason: 'direct commits while the branch is prepared' }] },
    }))
    expect(waived.status).toBe(0)
    expect(waived.stdout).toContain('exempted by')
    expect(waived.stdout).toContain('direct commits while the branch is prepared')
  })

  it('rejects a completed row whose PR is open', () => {
    const root = fixture({ prStates: { [PR5]: 'OPEN', [PR6]: 'OPEN' } })
    const result = run(root, ['--pr-states', join(root, 'pr-states.json')])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('status is 已完成 but PR #5 is OPEN')
  })

  it('accepts a completed row whose PR is merged', () => {
    const root = fixture({ prStates: { [PR5]: 'MERGED', [PR6]: 'OPEN' } })
    const result = run(root, ['--pr-states', join(root, 'pr-states.json')])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('read 2 link(s)')
  })

  it('rejects a completed row whose PR does not exist', () => {
    const root = fixture({ prStates: { [PR5]: 'NOT_FOUND', [PR6]: 'OPEN' } })
    const result = run(root, ['--pr-states', join(root, 'pr-states.json')])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('PR #5 does not exist')
  })

  it('does not waive a completed row whose PR is open', () => {
    const root = fixture({
      prStates: { [PR5]: 'OPEN', [PR6]: 'OPEN' },
      exemptions: { exemptions: [{ task: 'T0-01', rule: 'completed-pr-not-merged', reason: 'the PR is waiting for its last check' }] },
    })
    const result = run(root, ['--pr-states', join(root, 'pr-states.json')])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('allowed: in-progress-without-pr')
    expect(result.stderr).toContain('status is 已完成 but PR #5 is OPEN')
  })

  it('rejects a stale exemption', () => {
    const result = run(fixture({
      exemptions: { exemptions: [{ task: 'T1-01', rule: 'in-progress-without-pr', reason: 'not needed because the row has a PR' }] },
    }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('is stale')
  })

  it('rejects exemptions without a task, allowed rule or reason', () => {
    const unknownRule = run(fixture({
      exemptions: { exemptions: [{ task: 'T1-01', rule: 'bad-date', reason: 'x' }] },
    }))
    expect(unknownRule.status).toBe(1)
    expect(unknownRule.stderr).toContain('allowed: in-progress-without-pr')

    const unknownTask = run(fixture({
      exemptions: { exemptions: [{ task: 'T9-99', rule: 'in-progress-without-pr', reason: 'x' }] },
    }))
    expect(unknownTask.status).toBe(1)
    expect(unknownTask.stderr).toContain('names a task that is not in')

    const noReason = run(fixture({
      exemptions: { exemptions: [{ task: 'T1-01', rule: 'in-progress-without-pr', reason: '  ' }] },
    }))
    expect(noReason.status).toBe(1)
    expect(noReason.stderr).toContain('needs a non-empty reason')

    const duplicate = run(fixture({
      exemptions: { exemptions: [
        { task: 'T1-01', rule: 'in-progress-without-pr', reason: 'first' },
        { task: 'T1-01', rule: 'in-progress-without-pr', reason: 'second' },
      ] },
    }))
    expect(duplicate.status).toBe(1)
    expect(duplicate.stderr).toContain('duplicates the exemption')
  })

  it('rejects a malformed exemption file rather than skipping it', () => {
    const result = run(fixture({ exemptionsText: '{ not json' }))
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not valid JSON')
  })

  it('queries PR states through the GitHub API when asked', async () => {
    const states: Record<string, { state: string; merged_at: string | null }> = {
      '5': { state: 'closed', merged_at: '2026-11-08T00:00:00Z' },
      '6': { state: 'open', merged_at: null },
    }
    const requests: string[] = []
    const authorizations: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '')
      authorizations.push(request.headers.authorization ?? '')
      const number = /\/pulls\/(\d+)$/.exec(request.url ?? '')?.[1]
      const pull = number === undefined ? undefined : states[number]
      if (pull === undefined) {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(pull))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server has no port')
      const api = `http://127.0.0.1:${address.port}`
      const root = fixture()
      const passed = await runAsync(root, ['--check-prs'], { GH_TOKEN: 'test-token', GITHUB_API_URL: api })
      expect(passed.status).toBe(0)
      expect(passed.stdout).toContain('queried 2 link(s)')
      expect(requests).toEqual(expect.arrayContaining([
        '/repos/touch-agent/dsh-superagent/pulls/5',
        '/repos/touch-agent/dsh-superagent/pulls/6',
      ]))
      expect(authorizations.length).toBeGreaterThan(0)
      expect(authorizations.every(value => value === 'Bearer test-token')).toBe(true)

      states['5'] = { state: 'open', merged_at: null }
      const failed = await runAsync(fixture(), ['--check-prs'], { GH_TOKEN: 'test-token', GITHUB_API_URL: api })
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain('status is 已完成 but PR #5 is OPEN')

      delete states['5']
      const missing = await runAsync(fixture(), ['--check-prs'], { GH_TOKEN: 'test-token', GITHUB_API_URL: api })
      expect(missing.status).toBe(1)
      expect(missing.stderr).toContain('PR #5 does not exist')
    }
    finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('fails closed when the GitHub API cannot be reached', () => {
    const result = run(fixture(), ['--check-prs'], { GH_TOKEN: 'test-token', GITHUB_API_URL: 'http://127.0.0.1:1' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('could not query PR')
  })

  it('refuses to query GitHub without a token', () => {
    const result = run(fixture(), ['--check-prs'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('GH_TOKEN')
  })
})