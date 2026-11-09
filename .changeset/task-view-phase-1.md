---
'@superagent/dsh': minor
---

Add T3-09's read-only task view. The Tasks board projection gains an additive
flat `tasks` list with each Ticket's form, review ownership, latest previewed
delivery, lightweight inline steps and last event, while the existing plan tree
stays intact. The panel registers a right-sidebar Task tab and shares one
`GET tasks` poll with a compact status-page list; selecting a Ticket narrows the
Events tab to that Ticket (a review narrows to the Ticket it reviews). A
lightweight Ticket shows its inline steps and no worker, Session or delivery,
and the `taskView.v1` client switch rolls the surface back to the plan tree.
