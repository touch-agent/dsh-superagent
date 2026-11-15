---
'@superagent/dsh': minor
---

Add the flagged project layer to the Tasks page. A project board from the
contract becomes the default view with project cards (goal, responsible
worker, progress, pending and recent activity), an active/archived filter that
keeps archived pending work visible, and project → task → subtask drill-down
with owners, statuses, breadcrumbs, deliverables, blockers and report history.
Missing fields stay visibly unknown, and turning `ux.projects.v1` off or a host
without `projects` restores the existing flat list unchanged.
