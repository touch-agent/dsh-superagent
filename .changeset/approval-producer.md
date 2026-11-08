---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Wire the runtime's Approval producer into the outbound path. A message to an
external Channel for a Ticket now revalidates its Mandate at the `send` level
and requests an Approval for the Action and its exact revision, recording the
destination as the target; the receipt waits as `pending` with no `reply`
effect until the Policy's whitelist approves it or a person decides in the
panel. A denial, expiry, revocation, missing record or lower grant settles the
receipt as dropped with that reason and never sends; a recall while waiting
revokes the request, and a new Action revision asks again. The built-in
conversation Source stays direct, and ticketless system writes are unchanged.
`OutboundSend` and receipts now carry the optional `target`, and `Outbox`
gains `reconcile`, which the pass loop, `sent` and the approval routes call.
The Policy's `maxActionLevel` still defaults to `draft`, so an operator must
raise it to `send` before external messages can leave.
