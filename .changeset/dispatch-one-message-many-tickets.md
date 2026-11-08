---
'@superagent/dsh': minor
---

Make dispatch configurable for one message that holds several requests. The
new `dispatch` settings block has `mode` (`single`, the existing one-ticket
behavior, `explicit`, which deterministically splits a numbered, bulleted,
confirmation or launching list, and `auto`, which takes the main Session's
items) and `maxTickets`. Each item becomes its own conversation Trigger with
the source message id in `meta`, so one message can start several auditable
Tickets, an item can attach to an existing Ticket instead, and a re-dispatched
plan creates nothing new. Ambiguous or over-wide splits, a missing title or
scope, or a disabled Source fall back to one Ticket without losing the items.
The dispatch prompt and docs/009 describe the modes, and the trigger and
ticket resources expose the source message and intent.