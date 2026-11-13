import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
const root = dirname(fileURLToPath(import.meta.url))
/** Every file under a source directory, relative to the repository root, in a stable order. */
function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : [path]
  }).sort()
}
/** The build identity is baked into both halves, so a page and a service can tell when they come from different builds. */
function buildIdentity() {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
  const hash = createHash('sha256')
  for (const path of [...sourceFiles('packages/dsh/src'), ...sourceFiles('packages/kernel/src')]) {
    hash.update(path).update('\0').update(readFileSync(join(root, path)))
  }
  const git = (args: string[]): string => {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
    catch { return '' }
  }
  const commit = git(['rev-parse', '--short', 'HEAD']) || 'unknown'
  const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== ''
  return { version, commit, buildId: hash.digest('hex').slice(0, 12), builtAt: new Date().toISOString(), dirty }
}
const build = buildIdentity()
/** Values replaced in both bundles; `build-info.ts` falls back to its development values when they are absent. */
const identity = {
  __DSH_SUPERAGENT_VERSION__: JSON.stringify(build.version),
  __DSH_SUPERAGENT_COMMIT__: JSON.stringify(build.commit),
  __DSH_SUPERAGENT_BUILD_ID__: JSON.stringify(build.buildId),
  __DSH_SUPERAGENT_BUILT_AT__: JSON.stringify(build.builtAt),
  __DSH_SUPERAGENT_DIRTY__: JSON.stringify(build.dirty),
}
// The kernel is a workspace package bundled from source, mapped here exactly as tsconfig and vitest do. The runtime stays
// external in the meta entries: it is a package the bundle depends on, not code to inline.
const alias = { '@superagent/kernel': resolve(root, 'packages/kernel/src/index.ts') }
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
const node = { format: 'esm' as const, platform: 'node' as const, target: 'es2024', dts: true }
export default defineConfig([
  // The runtime package: the four plugin entries, built from packages/dsh/src into packages/dsh/lib.
  { entry: { index: 'packages/dsh/src/index.ts', 'github-watch': 'packages/dsh/src/sources/github.ts', 'feishu-watch': 'packages/dsh/src/sources/feishu.ts',
    'feishu-doc-watch': 'packages/dsh/src/sources/feishu-doc.ts' },
    outDir: 'packages/dsh/lib', ...node, fixedExtension: false, clean: true, alias, define: identity,
    deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  // The bundle's node half: thin entries that re-export the runtime, so the installed package name and its subpaths stay the same.
  { entry: { index: 'meta/index.ts', 'github-watch': 'meta/github-watch.ts', 'feishu-watch': 'meta/feishu-watch.ts', 'feishu-doc-watch': 'meta/feishu-doc-watch.ts' },
    outDir: 'lib', ...node, fixedExtension: false, clean: true,
    deps: { neverBundle: ['@superagent/dsh'] } },
  // The browser half belongs to the bundle: it keeps the module id `dsh-superagent`, which the panel slots are registered under.
  { entry: { client: 'packages/dsh/src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw], alias, define: identity,
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
