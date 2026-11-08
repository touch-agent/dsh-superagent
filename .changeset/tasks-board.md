---
'@superagent/dsh': minor
---

Add the **Tasks** tab to the management panel. It folds Tickets into the
milestone and plan task their titles or Mandate scopes already name, places
review Tickets under the Ticket whose pull request they review, and hangs
each Ticket's pull requests below it. Every row shows its state, child
completion and elapsed time; milestones and tasks fold. An optional graph
draws a lane per top-level Ticket that ran, reusing a lane after its
earlier branch ended, with merge points, open branches, a solid red failed
lane and a dashed red blocked lane. Ownership is derived when the board and the Events
feed are read, so no schema migration and no new Ticket field are needed.
