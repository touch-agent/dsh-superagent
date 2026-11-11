---
'dsh-superagent': patch
---

Re-baseline the shipped-bundle budget after the first UX batch and the shared-account human-identity work.
The UX batch added 87,240 bytes to `lib/client.js` (already budgeted) and 1,355 bytes to
`packages/dsh/lib/index.js`; the human-identity work added 1,192 bytes to the runtime entry and 2,697 bytes
to the GitHub watcher and pull chunks. Raise the runtime ceiling to 814,000 bytes and the total to
1,668,000. No runtime behaviour or published API changes; the size gate still fails on later growth.
