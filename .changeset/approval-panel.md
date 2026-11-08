---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Let the panel decide an Approval. Overview opens with the requested Actions
still waiting for a person, showing the Action, its object, the consequence of
its level and its expiry; one click approves at the requested level or at a
lower level the person picks, or denies it. A lower grant is kept on the
Approval as `grantedLevel`, and the wait from request to decision joins the
health figures as approval latency.