---
'@superagent/dsh': minor
---

Add the second UX batch from the task-first interface proposal. The default
surface keeps only Overview, Tasks and Settings: Sources, triggers, Eval and
Execution become grouped Settings pages with icons, one-line descriptions and
their existing status views, while `source`, `trigger`, `eval` and
`execution/:id` links keep resolving and direct record links do not select a
tab. The task detail answers, in order, what the person must decide (or that
nothing is needed), what was done with a result summary and deliverable link,
the next step with only the timing the record supports, and who is doing it in
human words from the profile registry; each child report folds open on its own.
A three-line first-use note and clickable empty-state entries start the first
task without inventing data. `ux.opsInSettings.v1`, `ux.taskDetail.v2` and
`ux.firstUse.v1` independently restore the earlier surfaces without deleting
any record.
