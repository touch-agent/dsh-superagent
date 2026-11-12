---
'dsh-superagent': patch
---

Add the ESLint check for X-01. The bundle gains the flat config, the type-aware
promise and `await` rules, `pnpm lint` and its wiring into `pnpm check`; the
one-time cleanup removes unused declarations, fixes the remaining findings and
leaves seven narrow reasoned suppressions. No published API, domain rule or UI
behavior changes.
