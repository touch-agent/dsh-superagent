---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Implement the minimal workspace model: `Execution.directory` is the only Space
locator, and an additive `space_lease` table (schema 16) coordinates writers.
The Executor reserves a lease before `prepare`, checks the canonical locator and
checkout after it, activates the lease before the worker starts, and releases it
when the Ticket ends; a conflicting live holder leaves the Assignment queued,
and an old-process lease without a live Session becomes stale instead of being
silently preempted. A lease never grants an action or changes authorization.
Child Tickets get a flat sibling directory under the execution root by default,
with `executor.workspace.childSibling` restoring the nested layout; the
`executor.workspace.lease` flag restores path-only behavior. The panel gains a
read-only Space block on a Ticket, a grouped `GET spaces` list on the Execution
page with a copyable path, and the `workspace.view` client fallback.