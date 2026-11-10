#!/usr/bin/env node
/**
 * X-08: prove the bundle can be installed, used and uninstalled as one DSH plugin.
 *
 * The run is what the deployment guide's install block does, against a throwaway Harness home and state directory:
 * initialize a Web profile, install this checkout with `dsh plugin add`, start `dsh`, answer the panel, stop it, and
 * remove the plugin. The last assertion is the one that makes the bundle safe to upgrade: the state directory, and the
 * database in it, outlive the code.
 *
 * This is an integration script rather than a vitest spec because it starts a real DSH process and downloads nothing
 * into the repository: `pnpm check` stays fast, and the `install-e2e` CI job runs this file. It installs the checkout
 * with `link:` as the guide's install block does; the packages are private, so the registry path is not covered here.
 *
 * Usage: `pnpm test:install-e2e` (which builds first), or `node scripts/install-e2e.mjs` after `pnpm build`.
 * `DSH_BIN` selects the `dsh` executable (on Windows, point it at the package's `lib/bin.js`), and `KEEP=1`
 * leaves the temporary home for inspection.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, parse, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'install-e2e'
const isWindows = process.platform === 'win32'
// Windows' `stateDir` schema wants a POSIX-style absolute path, which Node resolves against the current
// drive (the checkout's drive here). Keep the throwaway home on that same drive so the two spellings name
// one directory; a drive-letter `stateDir` is rejected by the bundle and is documented as a Windows limit.
const temporary = mkdtempSync(join(isWindows ? dirname(root) : tmpdir(), 'dsh-superagent-install-e2e-'))
const home = join(temporary, 'home')
const statePath = join(temporary, 'state')
const stateDir = isWindows ? `/${relative(parse(statePath).root, statePath).split(sep).join('/')}` : statePath
const keep = process.env.KEEP === '1'
const env = { ...process.env, DSH_HOME: home, NO_COLOR: '1' }
const results = []

/**
 * Resolve the host CLI. On Windows the npm shim is `dsh.cmd`, which Node cannot spawn without a shell;
 * spawning through a shell would also make the long-running host a grandchild that `child.kill` cannot
 * stop. Run the global package entry with the current Node instead, so every platform kills the real host.
 * `DSH_BIN` may name another executable, or its `lib/bin.js` on Windows.
 */
function resolveDsh() {
  const configured = process.env.DSH_BIN
  if (configured !== undefined && configured !== '') {
    if (process.platform === 'win32' && !/\.[cm]?js$/i.test(configured))
      throw new Error(`DSH_BIN=${configured}: on Windows point it at the dsh JavaScript entry (…/@deepseek-ai/dsh/lib/bin.js)`)
    return process.platform === 'win32' ? { file: process.execPath, prefix: [configured] } : { file: configured, prefix: [] }
  }
  if (process.platform !== 'win32') return { file: 'dsh', prefix: [] }

  // `npm root --global` is the same npm the CI install step used, so it locates the host that install put there.
  const found = spawnSync('npm', ['root', '--global'], { encoding: 'utf8', shell: true, timeout: 60_000 })
  if (found.error !== undefined) throw new Error(`cannot locate the global npm root: ${found.error.message}`)
  if (found.status !== 0) throw new Error(`npm root --global exited ${found.status}\n${found.stdout}\n${found.stderr}`)
  const entry = join(found.stdout.trim(), '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`cannot find the dsh host entry at ${entry}; install @deepseek-ai/dsh or set DSH_BIN`)
  return { file: process.execPath, prefix: [entry] }
}

/** The host executable and its fixed leading arguments, resolved after the temporary home exists. */
let dsh

/** Record one assertion; the run fails if any is false. */
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/** Run the dsh CLI in this checkout's temporary home, and refuse a nonzero exit. */
function run(args) {
  const result = spawnSync(dsh.file, [...dsh.prefix, ...args], { cwd: root, env, encoding: 'utf8', timeout: 180_000 })
  const command = `dsh ${args.join(' ')}`
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}\n${result.stdout}\n${result.stderr}`)
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', command }
}

/** Resolve a port the OS says is free, so parallel runs do not pick the same one. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** Poll `probe` until it returns something, or fail with the process output when it exits or the deadline passes. */
async function waitFor(probe, timeoutMs, what, host) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    if (host !== undefined && (host.exitCode !== null || host.signalCode !== null))
      throw new Error(`${what}: dsh exited with ${host.exitCode ?? host.signalCode}\n${host.output}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`${what}: timed out after ${timeoutMs} ms\n${host?.output ?? ''}`)
}

/** Await `promise` with a deadline, clearing the timer so a completed run exits at once. */
async function withTimeout(promise, ms, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

/** Ask the panel's management API for the state page its Overview renders. */
async function panelState(base) {
  try {
    const response = await fetch(`${base}/orchestrator/api/state`, {
      headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(2_000),
    })
    return response.status === 200 ? { status: response.status, body: await response.json() } : undefined
  }
  catch {
    return undefined
  }
}

/** Fetch the Web UI: the token URL sets a session cookie and redirects, so follow it by hand. */
async function panelPage(tokenUrl) {
  const first = await fetch(tokenUrl, { redirect: 'manual' })
  if (first.status === 200) return { status: first.status, html: await first.text(), cookie: '' }
  const cookies = first.headers.getSetCookie?.() ?? [first.headers.get('set-cookie') ?? '']
  const cookie = cookies.map(value => value.split(';')[0]).filter(Boolean).join('; ')
  const page = await fetch(new URL('/', tokenUrl), { headers: cookie === '' ? {} : { cookie }, redirect: 'manual' })
  return { status: page.status, html: await page.text(), cookie }
}

/** Fetch one page asset with the panel's session cookie. */
async function panelAsset(tokenUrl, src, cookie) {
  try {
    const response = await fetch(new URL(src, tokenUrl), {
      headers: cookie === '' ? {} : { cookie }, signal: AbortSignal.timeout(5_000),
    })
    return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() }
  }
  catch {
    return undefined
  }
}

const failed = () => results.filter(result => !result.ok)
let child

try {
  dsh = resolveDsh()

  // The install uses the built packages (`lib/`), so a missing build is a setup error, not an assertion about the bundle.
  for (const file of ['lib/index.js', join('packages', 'dsh', 'lib', 'index.js')])
    if (!existsSync(join(root, file))) throw new Error(`${file} is missing; run \`pnpm build\` (or \`pnpm test:install-e2e\`) first`)

  const version = run(['--version']).stdout.trim()
  check('the dsh CLI answers', version !== '', version)

  // 1. A fresh profile from the shipped Web template, then the machine configuration the guide tells an installer to write.
  run(['--profile', profile, '--from-default-profile', 'web', '--dump-config'])
  const profileDir = join(home, 'profiles', profile)
  check('the Web profile template initializes', existsSync(join(profileDir, 'package.json')))
  // Pin the package manager the profile's pnpm calls run under. Without this a corepack-managed pnpm picks the latest
  // release for the fresh profile, which may not be the one this repository locked or even be downloadable in CI.
  const manager = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager
  const profileManifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ ...profileManifest, packageManager: manager }, undefined, 2) + '\n')
  const port = await freePort()
  writeFileSync(join(profileDir, 'cordis.patch.yml'), [
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${port}`,
    '- id: dsh-superagent',
    '  config:',
    `    stateDir: ${JSON.stringify(stateDir)}`,
    '',
  ].join('\n'))

  // 2. Install the bundle the way the deployment guide does: the built checkout as a linked package.
  // pnpm accepts forward slashes on Windows; keeping the drive-letter path absolute avoids a profile-relative link.
  const linkTarget = process.platform === 'win32' ? root.replaceAll('\\', '/') : root
  run(['plugin', '--profile', profile, 'add', `link:${linkTarget}`])
  const installed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  check('the bundle is a profile dependency', String(installed.dependencies?.['dsh-superagent'] ?? '').startsWith('link:'),
    String(installed.dependencies?.['dsh-superagent'] ?? 'missing'))
  check('`dsh plugin add` registers the bundle layer', (installed.dsh?.profile?.bundles ?? []).includes('dsh-superagent'),
    JSON.stringify(installed.dsh?.profile?.bundles ?? []))

  // 3. The bundle's patch is composed into the profile: six rows, not just an installed dependency.
  const composed = run(['--profile', profile, '--dump-config'])
  const rows = ['dsh-superagent', 'dsh-superagent-github', 'dsh-superagent-feishu', 'dsh-superagent-feishu-doc',
    'dsh-superagent-worker-preset', 'dsh-superagent-router-preset']
  for (const id of rows) check(`the composed profile has row ${id}`, composed.stdout.includes(`- id: ${id}\n`))
  const missing = composed.stderr.split('\n').filter(line => line.includes('not found') || line.startsWith('dsh: ['))
  check('composing the profile reports no missing entry', missing.length === 0, missing[0] ?? '')

  // 4. Start the real host and prove the panel half is mounted: the management API answers and the page loads its client.
  child = spawn(dsh.file, [...dsh.prefix, '--profile', profile, '--no-open'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.output = ''
  child.stdout.on('data', chunk => { child.output += chunk })
  child.stderr.on('data', chunk => { child.output += chunk })
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })))
  const tokenUrl = await waitFor(() => /(http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+)/.exec(child.output)?.[1], 90_000,
    'the host prints its Web URL', child)
  const base = new URL(tokenUrl).origin
  console.log(`note  the host prints its Web URL — ${base}`)

  const panel = await waitFor(() => panelState(base), 90_000, 'the panel management API answers', child)
  check('the panel management API answers', panel.status === 200, `${base}/orchestrator/api/state`)
  check('the panel is configured with the temporary stateDir', panel.body.setup?.machine?.stateDir === stateDir,
    String(panel.body.setup?.machine?.stateDir ?? 'missing'))
  check('the runtime mounted and waits for setup', panel.body.health?.runtime?.state === 'paused',
    String(panel.body.health?.runtime?.state ?? 'missing'))
  check('setup reports only the expected missing repository', panel.body.setup?.problem?.code === 'repositoryUnset',
    String(panel.body.setup?.problem?.code ?? 'none'))

  const page = await panelPage(tokenUrl)
  check('the Web UI page serves', page.status === 200 && page.html.includes('id="root"'), `HTTP ${page.status}`)
  const clientSrc = /"id":"dsh-superagent","url":"([^"]+)"/.exec(page.html)?.[1]
  const client = clientSrc === undefined ? undefined : await panelAsset(tokenUrl, clientSrc, page.cookie)
  check('the served page references the dsh-superagent client', clientSrc !== undefined, clientSrc ?? 'missing')
  check('the dsh-superagent client is served', client?.status === 200 && /javascript/.test(client.type) && client.body.length > 0,
    client === undefined ? 'not fetched' : `HTTP ${client.status} ${client.type} ${client.body.length} bytes`)

  // 5. Stop the host gracefully; an uninstall is only meaningful against a stopped process. Windows has no
  // POSIX SIGINT delivery: Node terminates the process, so this leg asserts the exit and the surviving data,
  // not the graceful-drain semantics that the Linux and macOS legs cover.
  child.kill('SIGINT')
  const stopped = await withTimeout(exited, 30_000, `dsh did not stop within 30 s\n${child.output}`)
  const stoppedOk = process.platform === 'win32' ? (stopped.code !== null || stopped.signal !== null) : stopped.code === 130
  check(process.platform === 'win32' ? 'the host exits when stopped (Windows has no graceful SIGINT)' : 'the host stops on SIGINT',
    stoppedOk, `${stopped.code ?? stopped.signal}`)

  const database = join(stateDir, 'orchestrator.sqlite')
  const databaseBytes = existsSync(database) ? statSync(database).size : 0
  check('the state directory exists after the first run', existsSync(stateDir), stateDir)
  check('the first run created its SQLite database', existsSync(database) && databaseBytes > 0, `${databaseBytes} bytes`)
  check('the database is SQLite', existsSync(database) && readFileSync(database).subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000')

  // 6. Uninstall: the dependency and the bundle layer go, the state directory stays.
  run(['plugin', '--profile', profile, 'remove', 'dsh-superagent'])
  const removed = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  check('the bundle is no longer a profile dependency', removed.dependencies?.['dsh-superagent'] === undefined)
  check('the bundle layer is no longer registered', !(removed.dsh?.profile?.bundles ?? []).includes('dsh-superagent'),
    JSON.stringify(removed.dsh?.profile?.bundles ?? []))
  const after = run(['--profile', profile, '--dump-config'])
  const leftover = after.stdout.split('\n').filter(line => /^\s*- id: dsh-superagent(?:-[a-z-]+)?$/.test(line))
  check('the composed profile has no dsh-superagent row', leftover.length === 0, leftover.join(', '))
  check('the composed profile still lists the host rows', after.stdout.includes('- id: webserver\n'), 'webserver')
  // The user's machine configuration still names the entry, because a reinstall should get its stateDir back. The host
  // warns that the entry is absent but composes anyway; the E2E asserts that retained warning.
  check('the retained profile patch is reported as missing', /entry "dsh-superagent" not found/.test(after.stderr),
    after.stderr.trim().split('\n')[0] ?? 'no warning')
  check('the profile still composes after uninstall', after.status === 0)

  check('the state directory survives uninstall', existsSync(stateDir), stateDir)
  const keptBytes = existsSync(database) ? statSync(database).size : 0
  check('the SQLite database survives uninstall', existsSync(database) && keptBytes > 0, `${keptBytes} bytes`)

  if (failed().length > 0) throw new Error(`${failed().length} assertion(s) failed`)
  console.log(`\ninstall/uninstall E2E passed with dsh ${version}, profile ${profile}: ${stateDir} kept its database${keep ? '' : ' (temporary home removed)'}`)
}
catch (error) {
  console.error(`\ninstall/uninstall E2E failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
finally {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    // Do not leave the host behind when a failed step skips the graceful stop above.
    await withTimeout(new Promise(resolve => child.once('exit', resolve)), 5_000, 'dsh did not die').catch(() => {})
  }
  if (!keep) rmSync(temporary, { recursive: true, force: true })
  else console.log(`kept the temporary home: ${temporary}`)
}
