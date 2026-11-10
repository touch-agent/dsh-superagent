---
---

Add the X-03 end-to-end golden path: an Issue from an allowed GitHub account is
admitted as an explicit request, becomes a tracked Ticket, delegates two child
Tickets; the parent owner accepts both, returns one accepted child for a redo
and accepts it again; the root delivers through a PR with a person confirmation;
a person merges the PR first as a pending end, and the panel approval of the
current review revision applies it, ending the Ticket `merged`. The test runs
against a local fake host with no network or real GitHub/Feishu credentials and
does not retry. No runtime code changes.