---
'@superagent/dsh': patch
---

Finish the Phase 2 workspace leftovers without changing the lease/authorization boundary. The E2 Spaces list now warms each distinct directory once concurrently and caches directory kind/branch facts for fifteen seconds, so a cold poll reads each directory once and a warm poll reads the filesystem not at all; `tests/spaces.spec.ts` measures 600 rows with a p95 budget. E1 no longer carries or renders the absolute execution directory: the Ticket page names the space, and the path appears only on E2's Spaces list.