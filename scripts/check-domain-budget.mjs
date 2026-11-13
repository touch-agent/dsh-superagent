#!/usr/bin/env node
/**
 * X-06: hold the domain tests to the kernel contract in `docs/012-platform-evolution.zh.md` §10.1 —
 * "memory store runs the whole domain test suite in under two seconds".
 *
 * The suite is a fixed set of files that drive the kernel `Engine` on `MemoryRepositories`, plus the
 * tests whose only subject is a kernel module. Files whose subject is the runtime — the SQLite Store,
 * HTTP, the panel, Sources, Sessions, the bundle — are outside it; a few included Engine tests also
 * read a SQLite trace or store back in one or two cases, because they still assert a domain rule.
 *
 * Membership is checked for what can be seen in the imports: every test file that mentions
 * `MemoryRepositories` or imports only `@superagent/kernel` (never `@superagent/dsh`) must be either
 * in `DOMAIN` or in `EXCLUDED` with its reason, so the common new domain test is classified rather
 * than skipped. The rule is textual: a test that reaches the Engine through a fixture helper, or
 * imports both packages without naming `MemoryRepositories`, can still be missed; the list in this
 * file is the source of truth, and a reviewer should extend it deliberately. The run also has to
 * report exactly the listed files.
 *
 * Measurement: five complete Vitest runs (the domain membership as positional filters), each
 * reported through Vitest's JSON reporter. The per-run total is the sum of each test file's
 * `endTime - startTime`: test bodies and their hooks, without Node/Vitest startup, TypeScript
 * transform or module import. The median of the five totals is compared with `CEILING_MS`, so up
 * to two noisy samples cannot decide the gate. The budget is always read after all five runs; a
 * test failure or crash fails immediately, and no run is retried. Files run in parallel, so the sum
 * is the work done, not wall-clock time, and sustained CPU contention can inflate it.
 *
 * Two ceilings apply, both to the median run: the whole suite must stay under the contract's 2 s,
 * and one test must not take more than 500 ms (a quarter of the suite budget) on its own. The
 * second is a deliberate early guard: the slowest current domain test is tens of milliseconds
 * (about 20–65 ms depending on load), so one test that starts doing far too much work is named
 * long before the suite crosses 2 s, and the 500 ms has enough headroom for a slow CI runner.
 * Neither ceiling is a knob to raise when the suite grows; docs/007-architecture.md records how to
 * investigate a failure.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** The written contract: the domain test suite must stay under 2 s. */
const CEILING_MS = 2_000
/** One test may not take more than a quarter of the suite budget; the slowest current test takes
 * tens of milliseconds, so this catches one runaway test long before the whole suite reaches 2 s
 * while leaving several times the headroom a slower CI machine needs. */
const TEST_CEILING_MS = 500
/** Median of five runs: up to two noisy samples cannot decide the gate, and no run is retried. */
const RUNS = 5
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const DOMAIN = [
  'tests/action.spec.ts',
  'tests/approval-policy.spec.ts',
  'tests/approval.spec.ts',
  'tests/assessment.spec.ts',
  'tests/core-engine.spec.ts',
  'tests/delegation-contract.spec.ts',
  'tests/delegation.spec.ts',
  'tests/deliverable.spec.ts',
  'tests/dispatch-split.spec.ts',
  'tests/dispatch.spec.ts',
  'tests/inline-work.spec.ts',
  'tests/lightweight.spec.ts',
  'tests/review-aggregate.spec.ts',
  'tests/stage.spec.ts',
  'tests/trace-stages.spec.ts',
]
/**
 * Files the membership rule would otherwise claim, with the reason they stay out of the budget.
 * Keep this list small: an exclusion weakens the contract, so it needs a subject that is not the
 * domain.
 */
const EXCLUDED = new Map([
  ['tests/store.spec.ts', 'the SQLite Store; it uses MemoryRepositories only to compare the two implementations'],
])
const KERNEL_IMPORT = /['"]@superagent\/kernel(?:[/'"])/
const RUNTIME_IMPORT = /['"]@superagent\/dsh(?:[/'"])/
const MEMORY_REPOSITORIES = /\bMemoryRepositories\b/

/** Every `*.spec.ts(x)` file under `tests/`, relative to the repository root. */
function specFiles() {
  return readdirSync(join(ROOT, 'tests'), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.spec\.tsx?$/.test(entry.name))
    .map(entry => relative(ROOT, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort()
}

/** Why a test file belongs in the domain suite review, or `undefined` when it does not. */
function domainish(file, source) {
  if (MEMORY_REPOSITORIES.test(source)) return 'drives the Engine on MemoryRepositories'
  if (KERNEL_IMPORT.test(source) && !RUNTIME_IMPORT.test(source)) return 'imports only the kernel'
  return undefined
}

/**
 * Fail when a test file that looks like a domain test is neither in the budget nor explicitly
 * excluded, or when the list names a file that is missing or no longer looks like a domain test.
 */
function checkMembership() {
  const files = specFiles()
  const problems = []
  for (const file of files) {
    const source = readFileSync(join(ROOT, file), 'utf8')
    const reason = domainish(file, source)
    if (!reason) continue
    if (DOMAIN.includes(file) || EXCLUDED.has(file)) continue
    problems.push(`${file} looks like a domain test (${reason}) but is neither in DOMAIN nor EXCLUDED in scripts/check-domain-budget.mjs`)
  }
  for (const file of DOMAIN) {
    if (!files.includes(file)) { problems.push(`${file} is listed as a domain test but does not exist; fix DOMAIN in scripts/check-domain-budget.mjs`); continue }
    const reason = domainish(file, readFileSync(join(ROOT, file), 'utf8'))
    if (!reason) problems.push(`${file} is listed as a domain test but no longer matches the rule; classify it again in scripts/check-domain-budget.mjs`)
  }
  for (const [file, reason] of EXCLUDED) {
    if (!files.includes(file)) problems.push(`${file} is excluded from the domain budget but does not exist; remove its exclusion`)
    else if (!domainish(file, readFileSync(join(ROOT, file), 'utf8'))) problems.push(`${file} is excluded from the domain budget but no longer looks like a domain test; remove its exclusion`)
    if (!reason) problems.push(`${file} is excluded from the domain budget without a reason`)
  }
  return problems
}

/** Run the domain suite once and return its files, tests and measured execution time. */
function measure(run) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-domain-budget-'))
  const report = join(directory, 'report.json')
  try {
    const result = spawnSync(process.execPath, [VITEST, 'run', ...DOMAIN, '--reporter=default', '--reporter=json', `--outputFile=${report}`], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    if (result.error) {
      const reason = result.error.code === 'ETIMEDOUT' ? `Vitest did not finish within 300 s` : `could not start Vitest: ${result.error.message}`
      return { failure: `run ${run}: ${reason}` }
    }
    if (result.status !== 0) {
      return { failure: `run ${run}: the domain suite itself did not pass (Vitest exited ${result.status}); fix the test failure before reading the budget\n${tail(result.stdout)}\n${tail(result.stderr)}` }
    }
    let parsed
    try { parsed = JSON.parse(readFileSync(report, 'utf8')) } catch (error) {
      return { failure: `run ${run}: Vitest wrote no readable JSON report: ${error.message}\n${tail(result.stdout)}\n${tail(result.stderr)}` }
    }
    const files = parsed.testResults.map(file => ({
      file: relative(ROOT, file.name).replaceAll('\\', '/'),
      duration: file.endTime - file.startTime,
      tests: file.assertionResults.length,
    }))
    const tests = parsed.testResults.flatMap(file => file.assertionResults.map(test => ({
      file: relative(ROOT, file.name).replaceAll('\\', '/'),
      name: test.fullName,
      duration: test.duration,
    })))
    const unexpected = files.filter(file => !DOMAIN.includes(file.file)).map(file => file.file)
    const missing = DOMAIN.filter(file => !files.some(found => found.file === file))
    if (unexpected.length || missing.length) {
      return { failure: `run ${run}: Vitest did not run exactly the listed files\n${[...unexpected.map(file => `  unexpected: ${file}`), ...missing.map(file => `  missing: ${file}`)].join('\n')}` }
    }
    return { files, tests, total: files.reduce((sum, file) => sum + file.duration, 0) }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/** The last few lines of a child's output, for a failure that should stay readable in CI. */
function tail(text, lines = 20) {
  if (!text) return ''
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

function main() {
  const membership = checkMembership()
  if (membership.length) {
    console.error('domain test budget: the suite membership is out of date')
    console.error(membership.map(problem => `- ${problem}`).join('\n'))
    process.exit(2)
  }
  if (!existsSync(VITEST)) {
    console.error('domain test budget: `node_modules/vitest/vitest.mjs` is missing; run `pnpm install` first')
    process.exit(2)
  }

  const runs = []
  for (let run = 1; run <= RUNS; run += 1) {
    const result = measure(run)
    if (result.failure) {
      console.error(`domain test budget: ${result.failure}`)
      process.exit(2)
    }
    runs.push(result)
  }
  const ordered = [...runs].sort((left, right) => left.total - right.total)
  const median = ordered[Math.floor(ordered.length / 2)]
  const count = median.files.length
  const tests = runs[0].tests.length
  // The file set is identical across runs; the median run supplies the details a failure names.
  const totals = runs.map(run => `${Math.round(run.total)}ms`).join(', ')
  const headroom = (CEILING_MS / median.total).toFixed(1)

  const overSuite = median.total > CEILING_MS
  const overTest = median.tests.filter(test => test.duration > TEST_CEILING_MS)
    .sort((left, right) => right.duration - left.duration)
  if (overSuite || overTest.length) {
    const files = [...median.files].sort((left, right) => right.duration - left.duration)
    const slowest = [...median.tests].sort((left, right) => right.duration - left.duration).slice(0, 10)
    if (overSuite) {
      console.error(`domain test budget exceeded: median ${Math.round(median.total)}ms over ${RUNS} runs ` +
        `(${totals}) is above the ${CEILING_MS}ms ceiling in docs/012-platform-evolution.zh.md §10.1`)
    }
    if (overTest.length) {
      console.error(`domain test single-test ceiling exceeded: ${overTest.length} test(s) in the median run take ` +
        `more than ${TEST_CEILING_MS}ms`)
    }
    console.error(`\nper-file execution (median run, ${count} files / ${tests} tests):`)
    console.error(files.map(file => `  ${String(Math.round(file.duration)).padStart(6)}ms  ${file.file} (${file.tests} tests)`).join('\n'))
    console.error('\nslowest tests (median run):')
    console.error(slowest.map(test => `  ${String(Math.round(test.duration)).padStart(6)}ms  ${test.file} > ${test.name}`).join('\n'))
    console.error('\nFind what grew in the named file or test; do not raise the ceiling. See docs/007-architecture.md, "Domain test budget".')
    process.exit(1)
  }

  console.log(`domain test budget: ${tests} tests in ${count} files, median ${Math.round(median.total)}ms over ${RUNS} runs ` +
    `(${totals}) against the ${CEILING_MS}ms ceiling — ${headroom}x headroom`)
}

main()