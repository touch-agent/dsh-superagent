/** Browser-side build identity and the one safe way to make the host page pick up a newly built bundle. */
import { BUILD, buildMismatch, isUnknownBuild, type BuildInfo } from '../build-info.ts'

export { BUILD, buildMismatch, isUnknownBuild, type BuildInfo }

/**
 * Re-fetch the host page with cache revalidation, then reload. A browser may hold the boot HTML, which names the
 * `client.js` revision; reloading after a build without first refreshing the HTML can keep the previous revision.
 * `cache: 'reload'` updates that HTML in the HTTP cache, so the reload that follows asks for the new revision.
 */
export async function reloadClient(): Promise<void> {
  try { await fetch(`${location.pathname}${location.search}`, { cache: 'reload', credentials: 'same-origin' }) }
  catch { /* an offline page still gets one ordinary reload attempt */ }
  location.reload()
}