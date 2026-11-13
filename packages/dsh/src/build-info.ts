/**
 * Identity of the built artifact, shared by the runtime and the browser bundle.
 *
 * `tsdown.config.ts` replaces the five constants below in both builds with the version, commit, source hash, build
 * time and whether the checkout was dirty. Code run directly from TypeScript (tests, the occasional `tsx` script) has
 * no replacement, so the `typeof` guards fall back to `dev`/`unknown` instead of throwing.
 *
 * The client and runtime bundles carry the same values when they are built together. A page that kept an older
 * `lib/client.js` while the service restarted with a newer build reports a different `buildId`, which is the signal
 * `buildMismatch` and the Display settings use to tell a person to reload.
 */
declare const __DSH_SUPERAGENT_VERSION__: string | undefined
declare const __DSH_SUPERAGENT_COMMIT__: string | undefined
declare const __DSH_SUPERAGENT_BUILD_ID__: string | undefined
declare const __DSH_SUPERAGENT_BUILT_AT__: string | undefined
declare const __DSH_SUPERAGENT_DIRTY__: boolean | undefined

export interface BuildInfo {
  /** Package version from the repository root `package.json`. */
  readonly version: string
  /** Short commit the build was produced from, or `unknown` outside a Git checkout. */
  readonly commit: string
  /** SHA-256 prefix of the runtime and browser sources this build contains. */
  readonly buildId: string
  /** ISO timestamp of the build. */
  readonly builtAt: string
  /** True when the build ran over uncommitted tracked changes. */
  readonly dirty: boolean
}

export const BUILD: BuildInfo = {
  version: typeof __DSH_SUPERAGENT_VERSION__ === 'string' ? __DSH_SUPERAGENT_VERSION__ : 'dev',
  commit: typeof __DSH_SUPERAGENT_COMMIT__ === 'string' ? __DSH_SUPERAGENT_COMMIT__ : 'unknown',
  buildId: typeof __DSH_SUPERAGENT_BUILD_ID__ === 'string' ? __DSH_SUPERAGENT_BUILD_ID__ : 'dev',
  builtAt: typeof __DSH_SUPERAGENT_BUILT_AT__ === 'string' ? __DSH_SUPERAGENT_BUILT_AT__ : '',
  dirty: typeof __DSH_SUPERAGENT_DIRTY__ === 'boolean' ? __DSH_SUPERAGENT_DIRTY__ : false,
}

/** A build produced by a test or a source run rather than the bundle; it cannot be compared with another build. */
export const isUnknownBuild = (build: Pick<BuildInfo, 'buildId'> | undefined): boolean =>
  !build || build.buildId === 'dev' || build.buildId === 'unknown'

/**
 * True when the page and the service were produced by different builds. A missing or development build is never a
 * mismatch: tests and a source checkout without `tsdown` have no comparable identity.
 */
export function buildMismatch(client: BuildInfo | undefined, server: Pick<BuildInfo, 'buildId'> | undefined): boolean {
  return !!client && !!server && !isUnknownBuild(client) && !isUnknownBuild(server) && client.buildId !== server.buildId
}