---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Derive every outbound message's id from a `send` Action over `(source, objectId, action, revision, actor)`, so an
outbox receipt and its `reply` effect share one idempotency key: two revisions of one write produce two effects, and a
replay of one revision produces one. Answers, results and pull-request notices carry content revisions, so a changed
message is a new write; an acknowledgement is once per trigger and an attention question once per question. The undo
window, recall and withdrawal keep working by that key. Receipts queued before send Actions still read with their
original `kind`, and the acknowledgement, answer and attention lookups recognize their old ids. `SourceContext.notify`
now takes an `OutboundSend`, so a Source plugin must build the send Action; in-repo adapters are unchanged.