---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Add the kernel's Deliverable model: one artifact at one revision (file, document, spreadsheet, mail draft or calendar invite), the `PreviewRef` that shows that revision, and its acceptance criteria. `enterReview` refuses a review without a deliverable or without a preview of the artifact's revision, so the panel cannot offer approval for work a person cannot inspect. It keeps a criterion as a machine rule only when the kernel can judge it (`pr.merged`, `artifact.sent`, `artifact.unchanged` with an hours window) and downgrades any other rule to a human confirmation with a coded reason and the replaced rule. The runtime does not submit Deliverables yet; this is the contract the previewers and the review surface build on.
