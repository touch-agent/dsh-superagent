---
'@superagent/dsh': minor
---

Add X-09's three-zone entry page: **Waiting for you** joins Approvals, Tickets
that need a person and actionable system problems; **Running** shows the open
Tickets and Executor load; **Recently ended** lists the last eight endings,
newest first. The page adds `running` and `recent` to `GET overview`, folds the
24-hour flow and health figures under one E2 disclosure, and puts a warning dot
on the sidebar icon while anything waits for a person. `entry.threeZones.v1`
restores the previous Overview when off; no tab, filter, record or E2/E3 path is
removed.