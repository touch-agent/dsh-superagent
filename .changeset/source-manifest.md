---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the declarative Source manifest to the kernel and its Zod validation to
the runtime. `Localized` and `FieldSpec` move to the kernel with the manifest
and stay re-exported from the runtime's SourceKind. Admission rows and the
explicit-request note stay in the adapter's policy part, where they follow
the configuration and the Policy version.
