import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
// The kernel is a workspace package resolved from source; vitest aliases it the same way tsconfig and tsdown do.
const kernel = fileURLToPath(new URL('./packages/kernel/src/index.ts', import.meta.url))
// Share one React instance across DSH client packages and tests.
export default defineConfig({ resolve: { dedupe: ['react', 'react-dom'], alias: { '@superagent/kernel': kernel } },
  test: { include: ['tests/**/*.spec.{ts,tsx}'] } })