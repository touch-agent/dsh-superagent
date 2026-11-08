---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Wire the runtime's Approval producer into the outbound path. A message to an
external Channel for a Ticket now revalidates its Mandate at the `send` level
and requests an Approval for the Action and its exact revision, deriving the
destination from the Channel as the target; the receipt waits as `pending`
with no `reply` effect until the Policy's whitelist approves it or a person
decides in the panel. Release revalidates the Mandate once more, so a Policy
or Mandate lowered while the request waited refuses there with the same
reason. A denial, expiry, revocation, missing record or lower grant settles
the receipt as dropped with that reason and never sends; a recall while
waiting revokes the request, or records it expired if its window passed, and
a new Action revision asks again. An external answer that belongs to no
Ticket is refused with `ticketlessReply`; the built-in conversation Source
and ticketless system writes stay direct. `Outbox` gains `reconcile`, which
the pass loop, `sent` and the approval routes call. The Policy's
`maxActionLevel` still defaults to `draft`, so an operator must raise it to
`send` before external messages can leave.
