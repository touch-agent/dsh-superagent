#!/usr/bin/env node
/**
 * X-13: keep the plan, the tracking table and the pull requests they name consistent.
 *
 * `docs/plan/TASK-PLAN.zh.md` is the definition, `docs/plan/TRACKING.zh.md` is the
 * only status source, and the PR column points at the work that proves a status.
 * `tests/docs.spec.ts` fixes the table's shape; this script checks the meaning:
 *
 * - every task in the plan has exactly one tracking row, and every row names a plan task;
 * - statuses are from the fixed five, dates are real YYYY-MM-DD dates, and the five
 *   fields are present;
 * - `未开始` has neither a PR nor evidence, `进行中` has a PR or an explicit exemption,
 *   and `已完成` has evidence and (when the PR was queried) a merged PR;
 * - every PR link uses the canonical form and, with `--check-prs`, exists;
 * - the exemption list only contains live, explicit reasons.
 *
 * The default run is offline and only checks the files; CI passes `--check-prs` so a
 * link that does not exist or a completed task whose PR is still open becomes red.
 *
 * Usage:
 *   node scripts/check-tracking.mjs
 *   GH_TOKEN=$(gh auth token) node scripts/check-tracking.mjs --check-prs
 *   node scripts/check-tracking.mjs --pr-states ./pr-states.json
 *   node scripts/check-tracking.mjs --root /path/to/checkout
 *
 * `--pr-states` is a JSON object of canonical PR URL to `OPEN`, `MERGED`, `CLOSED` or
 * `NOT_FOUND`; it exists so the tests and offline reproductions do not need GitHub.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLAN = join('docs', 'plan', 'TASK-PLAN.zh.md')
const TRACKING = join('docs', 'plan', 'TRACKING.zh.md')
const EXEMPTIONS = join('docs', 'plan', 'TRACKING-EXEMPTIONS.json')
const STATUSES = ['未开始', '进行中', '已完成', '已暂停', '已取消']
const TASK_STATUSES = new Set(STATUSES)
const PR_URL = /^https:\/\/github\.com\/touch-agent\/dsh-superagent\/pull\/(\d+)$/
const PR_URL_PARTS = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const PR_STATE_VALUES = new Set(['OPEN', 'MERGED', 'CLOSED', 'NOT_FOUND'])
/** The only waiver: an in-progress row that has no PR yet. Unmerged PRs and malformed rows are never waived. */
const EXEMPTABLE = new Set(['in-progress-without-pr'])
const HEADER = /^\|\s*任务\s*\|\s*状态\s*\|\s*PR\s*\|\s*验收证据\s*\|\s*最后更新\s*\|$/m

/** Read a path under `root`, naming the missing file rather than an ENOENT stack. */
function read(root, path) {
  const file = join(root, path)
  if (!existsSync(file)) throw new Error(`missing ${path} under ${root}`)
  return readFileSync(file, 'utf8')
}

/** Every task id the plan names, with the first line it appears on. */
function planTasks(text) {
  const tasks = new Map()
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\b([TSXE]\d?-\d{2})\b/g)) {
      if (!tasks.has(match[1])) tasks.set(match[1], index + 1)
    }
  })
  return tasks
}

/** The tracking rows, including cells so a malformed row can name itself. */
function trackingRows(text) {
  const rows = []
  text.split('\n').forEach((line, index) => {
    const task = /^\|\s*([TSXE]\d?-\d{2})\s*\|/.exec(line)
    if (task === null) return
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    rows.push({ task: task[1], cells, line: index + 1 })
  })
  return rows
}

/** A real calendar date in YYYY-MM-DD form. */
function validDate(value) {
  if (!DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** The local date a suggested row should use; the plan's dates are local dates. */
function today() {
  return new Date().toLocaleDateString('en-CA')
}

function exemptionKey(task, rule) {
  return `${task}\0${rule}`
}

/**
 * Read `TRACKING-EXEMPTIONS.json` when it exists. A missing file means no exemptions;
 * a malformed one is a problem rather than a silent pass.
 */
function loadExemptions(root) {
  if (!existsSync(join(root, EXEMPTIONS))) return { exemptions: [], problems: [] }
  let value
  try {
    value = JSON.parse(read(root, EXEMPTIONS))
  }
  catch (error) {
    return { exemptions: [], problems: [`${EXEMPTIONS}: not valid JSON (${error.message})`] }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return { exemptions: [], problems: [`${EXEMPTIONS}: the file must be an object with an "exemptions" array`] }
  if (!Array.isArray(value.exemptions))
    return { exemptions: [], problems: [`${EXEMPTIONS}: "exemptions" must be an array`] }

  const problems = []
  const exemptions = []
  const seen = new Set()
  value.exemptions.forEach((entry, index) => {
    const label = `${EXEMPTIONS}: exemption #${index + 1}`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${label} must be an object with "task", "rule" and "reason"`)
      return
    }
    if (typeof entry.task !== 'string' || !/^[TSXE]\d?-\d{2}$/.test(entry.task)) {
      problems.push(`${label} has no valid task id`)
      return
    }
    if (typeof entry.rule !== 'string' || !EXEMPTABLE.has(entry.rule)) {
      problems.push(`${label} has rule ${JSON.stringify(entry.rule)}; allowed: ${[...EXEMPTABLE].join(', ')}`)
      return
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      problems.push(`${label} for ${entry.task}/${entry.rule} needs a non-empty reason`)
      return
    }
    const key = exemptionKey(entry.task, entry.rule)
    if (seen.has(key)) {
      problems.push(`${label} duplicates the exemption for ${entry.task}/${entry.rule}`)
      return
    }
    seen.add(key)
    exemptions.push({ task: entry.task, rule: entry.rule, reason: entry.reason.trim(), key })
  })
  return { exemptions, problems }
}

/**
 * Validate the two documents. `prStates` is a Map of canonical PR URL to one of
 * OPEN/MERGED/CLOSED/NOT_FOUND, or undefined when the links were not queried.
 */
function validate({ plan, tracking, exemptions = [], prStates, planPath = PLAN, trackingPath = TRACKING, exemptionPath = EXEMPTIONS }) {
  const problems = []
  const warnings = []
  const planById = planTasks(plan)
  const rows = trackingRows(tracking)
  const rowByTask = new Map()
  const usedExemptions = new Set()
  const exemptionByKey = new Map(exemptions.map(exemption => [exemption.key, exemption]))

  if (!HEADER.test(tracking))
    problems.push(`${trackingPath}: the tracking header is missing; keep the five fields 任务 | 状态 | PR | 验收证据 | 最后更新`)

  for (const row of rows) {
    if (rowByTask.has(row.task)) {
      problems.push(`${trackingPath}:${row.line}: ${row.task}: duplicate row; keep exactly one row per plan task`)
      continue
    }
    rowByTask.set(row.task, row)
    if (!planById.has(row.task))
      problems.push(`${trackingPath}:${row.line}: ${row.task}: the row has no task in ${planPath}; remove it or add the task to the plan`)
  }

  for (const [task, line] of planById) {
    if (!rowByTask.has(task))
      problems.push(`${planPath}:${line}: ${task}: no tracking row; add \`| ${task} | 未开始 | — | — | ${today()} |\` to ${trackingPath}`)
  }

  /** Report a row problem, or record the explicit exemption that waives it. */
  function waive(row, rule, message, hint) {
    const key = exemptionKey(row.task, rule)
    const exemption = exemptionByKey.get(key)
    if (exemption === undefined) {
      problems.push(`${trackingPath}:${row.line}: ${row.task}: ${message}; ${hint}`)
      return
    }
    usedExemptions.add(key)
    warnings.push(`${row.task}: ${message} [exempted by ${exemptionPath}: ${exemption.reason}]`)
  }

  for (const row of rows) {
    if (row.cells.length !== 5) {
      problems.push(`${trackingPath}:${row.line}: ${row.task}: the row has ${row.cells.length} cells; the five fields are 任务 | 状态 | PR | 验收证据 | 最后更新`)
      continue
    }
    const [, status, pr, evidence, updated] = row.cells
    if (!TASK_STATUSES.has(status))
      problems.push(`${trackingPath}:${row.line}: ${row.task}: status ${JSON.stringify(status)} is not one of ${STATUSES.join(' / ')}`)
    if (pr !== '—' && !PR_URL.test(pr))
      problems.push(`${trackingPath}:${row.line}: ${row.task}: PR ${JSON.stringify(pr)} is not a canonical link; use https://github.com/touch-agent/dsh-superagent/pull/<n> or —`)
    if (evidence === '')
      problems.push(`${trackingPath}:${row.line}: ${row.task}: acceptance evidence is empty; write the test, command or drill, or — when not started`)
    if (!validDate(updated))
      problems.push(`${trackingPath}:${row.line}: ${row.task}: last-updated ${JSON.stringify(updated)} is not a real YYYY-MM-DD date`)
    if (status === '未开始' && (pr !== '—' || evidence !== '—'))
      problems.push(`${trackingPath}:${row.line}: ${row.task}: status is 未开始 but PR/evidence are filled; a not-started task has no PR and no evidence (set both to —)`)
    if (status === '已完成' && evidence === '—')
      problems.push(`${trackingPath}:${row.line}: ${row.task}: status is 已完成 but acceptance evidence is —; write the test, command or drill that proves it`)
    if (status === '进行中' && pr === '—')
      waive(row, 'in-progress-without-pr', 'status is 进行中 but the PR cell is —', 'add the PR URL or an explicit exemption with rule "in-progress-without-pr"')

    if (pr === '—' || !PR_URL.test(pr)) continue
    const number = PR_URL.exec(pr)[1]
    if (prStates === undefined) continue
    const state = prStates.get(pr)
    if (state === undefined) {
      problems.push(`${trackingPath}:${row.line}: ${row.task}: PR #${number} was not queried; provide every PR in the --pr-states file`)
      continue
    }
    if (state === 'NOT_FOUND') {
      problems.push(`${trackingPath}:${row.line}: ${row.task}: PR #${number} does not exist in touch-agent/dsh-superagent (GitHub returned 404); fix the link`)
      continue
    }
    if (status === '已完成' && state !== 'MERGED')
      problems.push(`${trackingPath}:${row.line}: ${row.task}: status is 已完成 but PR #${number} is ${state}; keep the row 进行中 until it merges, or point it at the merged PR`)
  }

  for (const exemption of exemptions) {
    if (usedExemptions.has(exemption.key)) continue
    if (!planById.has(exemption.task)) {
      problems.push(`${exemptionPath}: exemption for ${exemption.task}/${exemption.rule} names a task that is not in ${planPath}`)
      continue
    }
    problems.push(`${exemptionPath}: exemption for ${exemption.task}/${exemption.rule} is stale; the row no longer triggers it, so remove the entry`)
  }

  return { problems, warnings, rows: rows.length, tasks: planById.size, exemptions: exemptions.length }
}

/** Convert the URL-to-state JSON used by `--pr-states` into the validator's Map. */
function readPrStates(file) {
  let value
  try {
    value = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new Error(`could not read --pr-states ${file}: ${error.message}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('--pr-states must be a JSON object of PR URL to OPEN, MERGED, CLOSED or NOT_FOUND')
  const states = new Map()
  for (const [url, state] of Object.entries(value)) {
    const normalized = String(state).toUpperCase()
    if (!PR_STATE_VALUES.has(normalized))
      throw new Error(`--pr-states has ${JSON.stringify(state)} for ${url}; use OPEN, MERGED, CLOSED or NOT_FOUND`)
    states.set(url, normalized)
  }
  return states
}

/** Ask GitHub for each link's state. A 404 means the link is wrong, not a network skip. */
async function queryPrStates(urls) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (!token)
    throw new Error('--check-prs needs GH_TOKEN or GITHUB_TOKEN; set it to a token that can read pull requests (CI passes github.token)')
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '')
  const states = new Map()
  await Promise.all([...urls].map(async url => {
    const match = PR_URL_PARTS.exec(url)
    if (match === null) return
    const [, owner, repo, number] = match
    let response
    try {
      response = await fetch(`${api}/repos/${owner}/${repo}/pulls/${number}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'dsh-superagent-tracking-check',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15_000),
      })
    }
    catch (error) {
      throw new Error(`could not query PR #${number}: ${error.message}; run without --check-prs for the offline checks`)
    }
    if (response.status === 404) {
      states.set(url, 'NOT_FOUND')
      return
    }
    if (!response.ok)
      throw new Error(`GitHub returned ${response.status} for PR #${number}: ${(await response.text()).slice(0, 300)}`)
    const pull = await response.json()
    const state = pull.merged_at === null || pull.merged_at === undefined ? String(pull.state).toUpperCase() : 'MERGED'
    if (!PR_STATE_VALUES.has(state))
      throw new Error(`GitHub returned unexpected state ${JSON.stringify(pull.state)} for PR #${number}`)
    states.set(url, state)
  }))
  return states
}

function usage() {
  return [
    'usage: node scripts/check-tracking.mjs [--root <dir>] [--check-prs | --pr-states <file>]',
    '',
    '  --root <dir>        checkout to check (default: this repository)',
    '  --check-prs         query GitHub for PR existence and merge state (needs GH_TOKEN/GITHUB_TOKEN)',
    '  --pr-states <file>  read PR states from a JSON object instead of querying GitHub',
    '  --help              show this help',
  ].join('\n')
}

function parseArguments(argv) {
  const options = { root: ROOT, checkPrs: false, prStates: undefined, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument === '--check-prs') options.checkPrs = true
    else if (argument === '--root') {
      index += 1
      if (argv[index] === undefined) throw new Error('--root needs a directory')
      options.root = argv[index]
    }
    else if (argument === '--pr-states') {
      index += 1
      if (argv[index] === undefined) throw new Error('--pr-states needs a file')
      options.prStates = argv[index]
    }
    else throw new Error(`unknown argument: ${argument}`)
  }
  if (options.checkPrs && options.prStates !== undefined)
    throw new Error('--check-prs and --pr-states cannot be used together')
  return options
}

async function main() {
  let options
  try {
    options = parseArguments(process.argv.slice(2))
  }
  catch (error) {
    console.error(`tracking check: ${error.message}\n\n${usage()}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log(usage())
    return
  }

  const root = resolve(options.root)
  try {
    const plan = read(root, PLAN)
    const tracking = read(root, TRACKING)
    const loaded = loadExemptions(root)
    let prStates
    if (options.prStates !== undefined) {
      prStates = readPrStates(options.prStates)
      console.log(`PR states: read ${prStates.size} link(s) from ${options.prStates}`)
    }
    else if (options.checkPrs) {
      const links = new Set(trackingRows(tracking)
        .map(row => row.cells[2])
        .filter(pr => pr !== undefined && PR_URL.test(pr)))
      prStates = await queryPrStates(links)
      console.log(`PR states: queried ${prStates.size} link(s) through GitHub`)
    }
    else {
      console.log('PR states: not queried (offline); pass --check-prs with GH_TOKEN to verify existence and merge state')
    }

    const result = validate({
      plan,
      tracking,
      exemptions: loaded.exemptions,
      prStates,
      planPath: PLAN,
      trackingPath: TRACKING,
      exemptionPath: EXEMPTIONS,
    })
    const problems = [...loaded.problems, ...result.problems]

    if (result.warnings.length > 0) {
      console.log('warnings:')
      for (const warning of result.warnings) console.log(`- ${warning}`)
    }
    if (problems.length > 0) {
      console.error(`tracking check found ${problems.length} problem(s):`)
      for (const problem of problems) console.error(`- ${problem}`)
      console.error('No files were changed. Fix the rows above, then run `pnpm check:tracking`.')
      process.exitCode = 1
      return
    }
    console.log(`tracking check passed: ${result.tasks} plan tasks, ${result.rows} rows, ${result.exemptions} exemption(s)`)
    if (prStates === undefined) console.log('PR existence and merge state were not verified offline.')
  }
  catch (error) {
    console.error(`tracking check: ${error.message}`)
    process.exitCode = 1
  }
}

await main()