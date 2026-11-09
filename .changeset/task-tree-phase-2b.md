---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the task-tree Phase 2b surface. A root Ticket's review now aggregates its
own and its accepted child Tickets' deliveries by `artifact.kind:ref:revision`,
keeps every coverable person confirmation, and appends a `reviewRevision` that
a person approves through `POST tickets/:id/approve`; a changed aggregate makes
the old approval stale and returns `409 reviewStale`. Accepted work with person
confirmations no longer ends before that approval, while rule-only work still
ends by itself. The task board projects roots once with child counts,
`GET tasks/:id?depth=` loads children on demand, `pendingEnd` is shown, and the
panel renders a one-layer child list, a lazily expanded Ticket tree and the
aggregated review without exposing Session ids in E1.
