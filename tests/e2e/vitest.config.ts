import { defineConfig } from 'vitest/config'
import base from '../../vitest.config.ts'

/**
 * The golden-path suite runs alone: it boots the Runtime against a local fake host, so it is not part of `pnpm test`'s
 * fast domain feedback. It reuses the root configuration's aliases and dedupe list; only the files and the timeout differ.
 */
const root = base as typeof base & { resolve?: { alias?: unknown[]; dedupe?: string[] } }
export default defineConfig({
  resolve: root.resolve,
  // No retry: a red golden path is a real regression. A flaky path is fixed, never retried away.
  test: { include: ['tests/e2e/**/*.e2e.ts'], testTimeout: 30_000, hookTimeout: 30_000, retry: 0 },
})