---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the kernel Approval object and its state machine: one Approval belongs to a Ticket and one Action, keeps the Action and revision it approves, and moves from `requested` to `approved`, `denied`, `expired` or `revoked`. It refuses a decision at or after its expiry and a jump out of a final state, while a repeated approval keeps its first decision time and approver. The Store keeps approvals in an additive `approval` table (schema 14) with per-Ticket and pending queries, and `MemoryRepositories` mirrors them.