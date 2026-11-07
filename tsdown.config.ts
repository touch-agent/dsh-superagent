import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
const root = dirname(fileURLToPath(import.meta.url))
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
  // The runtime package: the three plugin entries, built from packages/dsh/src into packages/dsh/lib.
  { entry: { index: 'packages/dsh/src/index.ts', 'github-watch': 'packages/dsh/src/sources/github.ts', 'feishu-watch': 'packages/dsh/src/sources/feishu.ts' },
    outDir: 'packages/dsh/lib', ...node, fixedExtension: false, clean: true, alias,
    deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  // The bundle's node half: thin entries that re-export the runtime, so the installed package name and its three subpaths stay the same.
  { entry: { index: 'meta/index.ts', 'github-watch': 'meta/github-watch.ts', 'feishu-watch': 'meta/feishu-watch.ts' },
    outDir: 'lib', ...node, fixedExtension: false, clean: true,
    deps: { neverBundle: ['@superagent/dsh'] } },
  // The browser half belongs to the bundle: it keeps the module id `dsh-superagent`, which the panel slots are registered under.
  { entry: { client: 'packages/dsh/src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw], alias,
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent", factory: (require) => {', footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
