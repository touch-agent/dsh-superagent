---
'@superagent/dsh': minor
---

Add the first UX batch from the task-first interface proposal. The task page
gains a flagged hierarchy view: one level of children at a time, owner profiles,
per-level deliverables, blockers, upward-report state and the root Session
entry, with internal ids folded into E2. The panel gains a notification layer
derived from `GET overview`: at most three eight-second floating cards, a
grouped drawer with an unread cursor, and in-place approve, deny, retry,
requeue, dismiss, disable-Source and view actions; no notification entity is
stored. Source, failed-task and other problems fold into one overview row with
retry count, latest time, retry and Source-disable entries, disappearing when
the upstream problem clears. Default task/overview/notification copy follows the
021 terminology table, and `ux.taskHierarchy.v1`, `ux.notifyDrawer.v1`,
`ux.notifyOverlay.v1` and `ux.errorAggregate.v1` independently restore the old
surfaces without deleting any record.