/**
 * X-01: lint the repository for defects, not for a house style.
 *
 * The rule set is deliberately small. It covers the classes tests usually miss:
 * dead code (unused variables, imports and expressions), unhandled or misused
 * promises, `await` on a non-promise, and an explicit `any` that erases a type.
 * It enables no formatting, import-order or naming rule, so a lint run cannot
 * produce a large diff that hides a logic change.
 *
 * `packages/kernel`, `packages/dsh`, `meta/`, `scripts/` and `tests/` are all
 * checked. The one ignore with a reason is `tests/fixtures/dependency-rules/`:
 * those files are deliberately violating imports read by
 * `tests/dependency-rules.spec.ts`, so they are test data, not code.
 */
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/** Files the TypeScript program covers; only these get type-aware rules. */
const TYPED = ['packages/**/*.ts', 'packages/**/*.tsx', 'meta/**/*.ts', 'tests/**/*.ts', 'tests/**/*.tsx', 'scripts/**/*.ts', 'tsdown.config.ts']

export default tseslint.config(
  {
    name: 'x-01/ignores',
    ignores: [
      '**/node_modules/**',
      '**/lib/**',
      '.artifacts/**',
      'coverage/**',
      // Test data for tests/dependency-rules.spec.ts: each file is an import violation on purpose.
      'tests/fixtures/dependency-rules/**',
    ],
  },
  {
    name: 'x-01/language',
    languageOptions: {
      // The panel runs in the browser, the runtime and scripts in Node. Setting both avoids
      // guessing per file; TypeScript already reports an undefined name in typed files.
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    name: 'x-01/javascript',
    ...js.configs.recommended,
  },
  ...tseslint.configs.recommended,
  {
    name: 'x-01/typescript',
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // `no-unused-vars` from js.configs.recommended cannot see type positions; the typed rule can.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    name: 'x-01/typescript-typed',
    files: TYPED,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `prefer-const` is style, not a defect: it flags setup variables that are assigned once in a `beforeEach`, where a
      // `const` cannot express the lifecycle. Turning it off avoids a mechanical diff with no defect behind it.
      'prefer-const': 'off',
      // A promise nobody handles is an unobserved failure; these three are the reason this
      // configuration needs type information at all.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // `delete array[i]` leaves a hole; `"[object Object]"` as a string is almost always a bug.
      '@typescript-eslint/no-array-delete': 'error',
    },
  },
)
