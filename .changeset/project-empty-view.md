---
'@superagent/dsh': patch
---

Show an explicit project-view empty state when no project exists instead of
falling back to the old flat task list. `GET tasks` now returns an empty
`projects`/`unassigned` projection for `active`/`archived`/`all` (only
`projects=off` keeps the pre-project response shape), the panel asks for that
projection explicitly, and old flat tasks are shown under "not in a project"
while the page says it is the project view and how to create one in the main
conversation. Adds an end-to-end test of the real project accept, task
admission/assignment, archive/restore and both projections.