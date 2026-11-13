---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the Phase 1.5 AgentProfile management plane. The loopback management API
can create a profile, add an immutable revision, activate one, roll one step
back, retire a revision, stop or resume binding a profile to new Tickets, and
save the independent registry flags; the Settings panel gains an Agent profiles
page with the version history, active pointer, switches and field-level metrics.
Writes keep the Phase 1 invariants: the strict draft schema still refuses
authorization and credential fields, the built-in `worker-default@1` is
read-only, custom profiles may pin only the worker model already approved in
Executor settings, and no operation rewrites an already-bound Ticket snapshot.
Internal profile ids and content hashes stay under a technical fold rather than
the default list.
