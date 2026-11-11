---
'@superagent/dsh': patch
---

Extend the documentation guard (X-05) from "every test is in the architecture table" to the source manifest and the management API. `tests/docs.spec.ts` now reads `SourceManifest` from the kernel and `Api` from the runtime, then fails when a field has no row in `docs/010-adding-a-source.md` or a `PUBLIC_ROUTES` route has no row in the Management API table of `docs/006-deployment.md`; each failure names the missing field or route and the file to edit. `PUBLIC_ROUTES` is the machine-readable public contract, and no exemption list is added: a missing row is a test failure, not a waiver.