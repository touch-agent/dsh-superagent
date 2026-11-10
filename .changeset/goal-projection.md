---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the Goal read model: `goalOf(ticket)` derives a Ticket's statement, source,
state, the decision a person owes, its delivered results and an acceptance
summary from facts the Ticket already stores. `GET goals` and `GET goals/:id`
serve root Goals and any single Ticket's Goal as read-only routes, and the same
projection is attached to the main Session's ticket card and the task row. The
projection stores nothing, grants nothing, exposes no Assignment, worker or
Session id, and deleting it leaves every Ticket intact.