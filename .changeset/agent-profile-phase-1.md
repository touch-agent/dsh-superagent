---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the Phase 1 AgentProfile layer: immutable, versioned worker execution
profiles with a strict schema that refuses authorization and credential fields;
a top-level `Ticket.profile` snapshot bound at creation and copied to children;
model, work-tool and prompt resolution in worker Sessions, with pinned prompts
read at their revision and a fixed protocol-tool set; `dispatch` trace fields;
and read-only `GET profiles` routes whose metrics group by effective or run
hash, keep token availability and cost honest, and suppress rates under five
samples. Profiles default off, live in KV rather than Settings, and cannot change
a Decision, Mandate, action level or approval.
