---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Let a live Ticket gain a Channel from another Source as a first-class anchor:
`Engine.bindChannel` subscribes it to the Channel's Thread and records a
`binding` Input for audit; `orchestrator_ticket_bind`
does the same from a trigger. Claiming a pull request adds its GitHub Channel,
and the Ticket page shows each anchor's source facts, ownership, close state
and last event.
