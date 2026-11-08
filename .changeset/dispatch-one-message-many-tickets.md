---
'@superagent/dsh': minor
---

Make dispatch configurable for one message that holds several requests. The
`dispatch` settings block has `mode` (`single`, the existing one-ticket
behavior; `explicit`, which deterministically splits a numbered, bulleted,
confirmation or launching list; and `auto`, which takes the main Session's
items) and `maxTickets`. Each item becomes its own conversation Trigger with
the source message id in `meta`, so one message can start several auditable
Tickets, an item can attach to an existing Ticket instead, and re-dispatching
the same plan creates nothing new. An ambiguous or over-wide split, or an item
with neither a title nor a scope, falls back to one Ticket without losing the
items, and attach items do not count against `maxTickets`. A disabled Source
refuses the dispatch, and a message that already reached a ticket is refused
rather than changed. The dispatch prompt and docs/009 describe the modes, and
the trigger and ticket resources expose the source message and intent.
