---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the project/task data and dispatch layer from 029: Ticket `kind`, `goal`,
`projectTicketId` and `archivedAt`; project Tickets with an owner worker and a
coordination Session instead of a task Assignment; a Decision-backed admission
seam for project tasks with capability-scoped `create-task`/`assign-worker`
tools and no cross-project escalation; project archival that leaves task
visibility and attention unchanged; project dispatch that routes a Trigger to
the project worker, with an explicit refusal for unknown, non-project or
archived destinations and the flat task path when no project is named; the
`projects`/`unassigned` board projection with `active`/`archived`/`all`/`off`
filters; `GET projects/:id`, archive and restore routes; and the
`ux.projects.v1` rollback switch. Tickets are persisted as JSON, so the new
fields need no migration: old Tickets read as unassigned tasks, and
`GET tasks?projects=off` keeps the pre-project response shape.