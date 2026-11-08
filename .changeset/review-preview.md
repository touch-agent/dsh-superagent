---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Make a review-stage Ticket render its preview and withhold approval without one. `orchestrator_report` now accepts an optional `deliverable` on a ready Report: the artifact at one revision, a `previewRef` of that same revision, and the acceptance criteria. `Assignments.report` normalizes it through `enterReview` and keeps it with that Report revision; `Engine.reviewTicket` accepts only a review-stage Ticket whose latest Report carries a preview and records the accepting actor there without ending the Ticket. The Ticket page shows the deliverable, revision, preview link, summary and criteria, and offers **Approve** only when the preview exists; a review without one reads **Cannot review** and offers no approval. The HTTP route `POST tickets/<id>/approve` enforces the same rule. The browser bundle grows by about 4 KB, so its budget is raised with it.
