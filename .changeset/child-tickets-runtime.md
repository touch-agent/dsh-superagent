---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add child Tickets to the task tree. A tracked parent worker can delegate a child
under the same authorization root with `orchestrator_child`; the child has its
own worker Session, no Mandate or Decision of its own, and reports back to its
parent owner. The parent accepts, returns or cancels it, records self-work,
escalation or reassignment, and only its own ready result ends the root after
every child is resolved. A root ready report with unresolved children is
refused; a PR or thread close waits as `endPending`; a person's stop cancels the
subtree; a child whose parent is gone becomes orphaned with one attention.
Schema 15 adds generated `parent`/`root` columns and partial indexes, with old
rows read as roots. Child Sessions cannot start or message other Sessions, and
children cannot reply to people, page, escalate or open a new authorization
root.
