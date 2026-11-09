---
'@superagent/dsh': minor
---

Add a read-only audit timeline to every Ticket page. It composes the Trigger's trace, the dispositions of the Triggers that reached the Ticket, the Ticket's Approvals and the Ticket itself into readable steps that answer who acted, on what basis, and what changed, and states the gap when a record cannot answer. The same data is served by `GET tickets/:id/timeline`; no write path is added.
