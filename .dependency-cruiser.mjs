/**
 * X-02: the layer and dependency-direction rules of docs/007-architecture.md,
 * checked by dependency-cruiser instead of a hand-written import scanner.
 *
 * Transitional state: `tests/layers.spec.ts` and `tests/kernel-boundary.spec.ts`
 * still run for one release (see "Retiring the old scanners" in
 * docs/007-architecture.md). They are deleted together with this file's
 * transitional note when the version after this change ships.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'kernel-zero-dependencies',
      comment: 'The kernel imports only its own files and node:crypto, its one built-in.',
      severity: 'error',
      from: { path: '^packages/kernel/src/' },
      to: { pathNot: ['^packages/kernel/src/', '^(?:node:)?crypto$'] },
    },
    {
      name: 'kernel-never-reaches-out',
      comment: 'No kernel file reaches outside the package by relative path.',
      severity: 'error',
      from: { path: '^packages/kernel/src/' },
      to: { pathNot: '^packages/kernel/src/', dependencyTypes: ['local'] },
    },
    {
      name: 'runtime-does-not-depend-on-bundle',
      comment: 'The runtime must not depend on the bundle (meta/) that installs it.',
      severity: 'error',
      from: { path: '^packages/dsh/' },
      to: { path: '^meta/' },
    },
    {
      name: 'runtime-uses-kernel-by-package-name',
      comment: '@superagent/kernel is imported by name, never by relative path.',
      severity: 'error',
      from: { path: '^packages/dsh/src/' },
      to: { path: '^packages/kernel/', dependencyTypes: ['local'], dependencyTypesNot: ['aliased-tsconfig-paths', 'aliased-tsconfig', 'aliased'] },
    },
    {
      name: 'meta-re-exports-runtime-only',
      comment: 'Bundle entries re-export @superagent/dsh and reach nothing else.',
      severity: 'error',
      from: { path: '^meta/' },
      to: { pathNot: '^packages/dsh/' },
    },
    {
      name: 'meta-uses-runtime-by-package-name',
      comment: 'A bundle entry names @superagent/dsh, never a relative path into packages/dsh.',
      severity: 'error',
      from: { path: '^meta/' },
      to: { path: '^packages/dsh/', dependencyTypes: ['local'], dependencyTypesNot: ['aliased-tsconfig-paths', 'aliased-tsconfig', 'aliased'] },
    },
    {
      name: 'meta-reexport-only',
      comment: 'A bundle entry only re-exports the runtime; it adds no import of its own.',
      severity: 'error',
      from: { path: '^meta/' },
      to: { path: '^packages/dsh/', dependencyTypesNot: ['export'] },
    },
    {
      name: 'sources-do-not-import-app',
      comment: 'A Source never depends on the host: nothing under src/sources imports src/app.',
      severity: 'error',
      from: { path: '^packages/dsh/src/sources/' },
      to: { path: '^packages/dsh/src/app/' },
    },
    {
      name: 'panel-never-imports-runtime',
      comment: 'The panel never reaches the Runtime; it sees the host through types and plain values.',
      severity: 'error',
      from: { path: '^packages/dsh/src/client/' },
      to: { path: '^packages/dsh/src/app/runtime\\.ts$' },
    },
    {
      name: 'panel-values-only-from-whitelist',
      comment: 'The panel takes host modules as types, and as values only from the documented plain-value modules.',
      severity: 'error',
      from: { path: '^packages/dsh/src/client/' },
      to: {
        path: '^packages/dsh/src/',
        pathNot: [
          '^packages/dsh/src/client/',
          '^packages/dsh/src/admission\\.ts$',
          '^packages/dsh/src/limits\\.ts$',
          '^packages/dsh/src/setup\\.ts$',
          '^packages/dsh/src/navigation\\.ts$',
          '^packages/dsh/src/build-info\\.ts$',
          '^packages/dsh/src/sources/host\\.ts$',
          '^packages/dsh/src/app/api\\.ts$',
          '^packages/dsh/src/app/work-tools\\.ts$',
        ],
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'panel-no-node-builtins',
      comment: 'The browser half of the panel imports no Node built-in.',
      severity: 'error',
      from: { path: '^packages/dsh/src/client/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'packages-imported-by-name',
      comment: 'packages/ is entered by package name from outside its package, never by relative path.',
      severity: 'error',
      from: { path: '^(packages/dsh/src|tests)/' },
      to: { path: '^packages/', pathNot: '^packages/dsh/', dependencyTypes: ['local'], dependencyTypesNot: ['aliased-tsconfig-paths', 'aliased-tsconfig', 'aliased'] },
    },
    {
      name: 'tests-do-not-reach-packages-by-relative-path',
      comment: 'Tests import @superagent/kernel and @superagent/dsh by package name.',
      severity: 'error',
      from: { path: '^tests/' },
      to: { path: '^packages/', dependencyTypes: ['local'], dependencyTypesNot: ['aliased-tsconfig-paths', 'aliased-tsconfig', 'aliased'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // The fixtures under tests/fixtures hold deliberate violations and are cruised
    // by tests/dependency-rules.spec.ts with this rule set, never by the repository check.
    exclude: { path: '^(lib|packages/[^/]+/lib|tests/fixtures/dependency-rules)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}