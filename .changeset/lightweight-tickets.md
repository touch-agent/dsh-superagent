---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the two Ticket forms, tracked and lightweight, and the inline path a lightweight Ticket runs without an Assignment or a worker Session. A lightweight Ticket records one `action` span per step under its Trigger's trace as the step runs, in order, followed by a `report` span when its run ends; the disposition records that the Ticket took the person's message up, and the Ticket ends `completed` or `dropped`. Its actions are limited to `read` and `draft`, because `commit`, `send` and `spend` need a tracked Ticket and a worker Session (R5); the kernel refuses such a step. A person's later message on one of its Threads resumes it inline under the same Mandate. Tracked remains the default form: the assessment does not choose lightweight yet (D3), and a deployment without an inline executor refuses such an accept and rolls its Decision back.