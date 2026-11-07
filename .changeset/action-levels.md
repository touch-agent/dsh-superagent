---
'@superagent/kernel': minor
---

Add the kernel's Action model: the five levels `read`, `draft`, `commit`,
`send` and `spend`, keyed by Source, object, kind, action level, revision
and actor. `createAction` derives the idempotency key and refuses a spend
without a money or time cost, so a calendar booking that takes another
person's time is expressed as a spend with a time cost.