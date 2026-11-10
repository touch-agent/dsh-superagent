---
'@superagent/dsh': minor
---

Add the E0–E3 default-surface cleanup from T5-02: approval rows use the E0
decision copy and fold object ids and action kinds into technical details;
Ticket rows drop the Executor Session button and undelivered marker; the task
detail shows the Ticket's goal, decision and result and labels the plan tree as
the E2 fallback; the Ticket page moves the Executor Session behind its
identifiers fold. The Events pane no longer auto-opens by default; Settings ›
Display adds a per-browser trust-phase opt-in, gated by `events.autoOpen.v1`.
No schema, migration or authorization change.
