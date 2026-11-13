---
'@superagent/dsh': patch
---

Show the running interface's build identity. Both bundles now carry the package version, short commit, a source hash,
build time and dirty flag; `GET state` returns the service's copy, and Settings › Display shows it next to the page's own
copy with a reload action. When a page and service come from different builds, the panel offers a cache-revalidating
reload instead of leaving a stale bundle to guesswork. Document the post-upgrade evidence and per-screen checklist in
docs/027.