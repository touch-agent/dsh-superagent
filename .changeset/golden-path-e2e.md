---
---

Add the X-03 end-to-end golden path: an Issue from an allowed GitHub account is
admitted as an explicit request, becomes a tracked Ticket, delegates two child
Tickets whose parent owner returns and then accepts their work, delivers through
a PR with a person confirmation, is approved at one review revision by the
panel, and ends `merged` when the Source observes the human merge. The test runs
against a local fake host with no network or real GitHub/Feishu credentials and
does not retry. No runtime code changes.