---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Derive every outbound message's id from a `send` Action over `(source, objectId, action, revision, actor)`, so an
outbox receipt and its `reply` effect share one idempotency key: two revisions of one write produce two effects, and a
replay of one revision produces one. Acknowledgements, answers, results, attention questions and pull-request notices
each name the object they write on and their content revision, so a changed message is a new write. The undo window,
recall and withdrawal keep working by that key, and receipts queued before send Actions still read with their original
`kind`.