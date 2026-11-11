---
'@superagent/dsh': minor
---

Add read-only organization and attention observation to `GET metrics`, and an offline replacement drill.

`organization` reports task-tree depth, active children, parent review waits, orphans and unresolved children from stored
Tickets. `attention` reports outbox requests and graded activity per ended result; the browser-only auto-open close rate
and default-surface click depth are explicitly `not-collected` rather than zero. `pnpm drill:replacement` runs the same
task through the real Engine and SQLite Store with the Executor port replayed, with the task view read and hidden, with a
flat organization, with a failing replacement and with the baseline restored, and asserts the audit chain and recovery.
The runbook and the drill report are `docs/runbooks/replacement.md` and `docs/runbooks/replacement.drill.md`.
