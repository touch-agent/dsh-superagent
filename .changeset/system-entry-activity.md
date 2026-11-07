---
'@superagent/dsh': minor
---

Record every domain event in a graded `activity` table and expose it through `GET activity` with an incremental cursor, so the system view can show realtime events and Ticket changes without polling the whole panel. A Ticket end whose latest report was `ready` or `dropped`, or which a person ended, is now feed activity instead of a second main-Session notice: one outcome costs one notification. The main Session works in the new system root `<stateDir>/system`, and the default Ticket root moves to `<stateDir>/system/work`; existing Tickets keep their recorded directories.
