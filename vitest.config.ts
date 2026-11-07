import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
// The kernel and the runtime are workspace packages resolved from source, and tsconfig and tsdown map the same names.
// The runtime is imported by subpath (`@superagent/dsh/app/x`), which the wildcard alias turns into packages/dsh/src.
const kernel = fileURLToPath(new URL('./packages/kernel/src/index.ts', import.meta.url))
const dsh = fileURLToPath(new URL('./packages/dsh/src', import.meta.url))
// Share one React instance across DSH client packages and tests.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'], alias: [
  { find: '@superagent/kernel', replacement: kernel },
  { find: '@superagent/dsh/github-watch', replacement: `${dsh}/sources/github.ts` },
  { find: '@superagent/dsh/feishu-watch', replacement: `${dsh}/sources/feishu.ts` },
  { find: /^@superagent\/dsh$/, replacement: `${dsh}/index.ts` },
  { find: /^@superagent\/dsh\/(.*)$/, replacement: `${dsh}/$1` },
] }, test: { include: ['tests/**/*.spec.{ts,tsx}'] } })
