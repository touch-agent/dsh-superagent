---
'@superagent/dsh': patch
---

Open a Ticket's **executor Session** from its page header instead of the main Session that dispatched it. The action
now uses the Ticket's own `worker-<ticketId>` id (the same one the Executor runs and the task projection exposes), stays
disabled with a reason until an Assignment has started, and never falls back to the source conversation. The main
Session remains reachable from the main-Agent card and the panel header. Assignment, Execution-list and task-hierarchy
entries keep the same executor target.