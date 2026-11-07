---
"@superagent/dsh": minor
"dsh-superagent": minor
---

Split the runtime out of the bundle: `packages/dsh` is now the `@superagent/dsh` package, holding the plugins, the management API, the browser half, the Source kinds, and the packaged skills and prompts. `dsh-superagent` becomes the bundle: its patch, its locale and its three node entry points, which re-export the runtime under the package name the patch names. The patch rows and the exported subpaths stay the same, so an installed profile keeps working.
