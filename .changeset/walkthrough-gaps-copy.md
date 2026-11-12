---
'@superagent/dsh': patch
---

Fix the copy and entry gaps G1–G6 found by the C4.5 novice walkthrough. The
overview's review card now offers a visible "open and confirm" action while its
title stays clickable; the review state is called "waiting for you" everywhere
instead of "awaiting review" / "needs me"; the approval page labels the revision
it binds to, states what approval will do (end the Task, apply a pending close,
or keep waiting for a followed Source), groups automatic rules apart from the
person's confirmations, and replaces internal wording such as
`artifact + revision` with "file and revision". No interaction model, data or
permission changes. Panel tests pin the new wording and assert that the default
surfaces contain no internal ids or the old bare revision prefix.