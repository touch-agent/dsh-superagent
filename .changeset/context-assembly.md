---
'@superagent/dsh': minor
---

Assemble the six context dimensions per Assignment (T5-04). A host-side
assembler reads only facts that already exist — the active Policy and worker
prompt revision, the origin Trigger, the derived context group, the root
Ticket and Mandate, a child's delegation, and the worker's profile/workspace —
and filters by presence: an absent subject contributes no empty layer. Entries
merge by key with constraint before scope, and an equal-strength conflict stops
the assembly instead of guessing. The first worker message carries
`context_assembly`; each Assignment keeps a read-only snapshot on
`Assignment.context` with entry metadata, digests, sources, absent dimensions,
merge decisions and conflicts but never entry text, and a `context` trace stage
records the decision. Missing, unreadable or conflicting context reports
`blocked` with a question for a person, before the workspace is touched. A
lightweight Ticket has only the task dimension, and a child inherits the root's
organization, user, group and task while carrying only its own subtask and
agent. Nothing here grants an action.
