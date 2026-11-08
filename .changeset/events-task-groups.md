---
'@superagent/dsh': minor
---

Fold the Events tab into one group per task, with the task's current state, its
originating Thread and the latest event in the header, and readable event rows
with a badge for the object an event is about, the state it recorded, how long
after the task's start it happened and when. Add filters for everything, the
events needing a person, live work and failures. Activity records now keep the
event's subject and immutable facts; rows written earlier derive the same
presentation from their Ticket, Thread and one-line summary when the feed is
read, so the JSON column needs no migration.
