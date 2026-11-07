---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Record `maxActionLevel` and an optional `expiresAt` on a Mandate, and revalidate both when a running Ticket takes an action. The Policy's `maxActionLevel` sets the ceiling (default `draft`; `commit`, `send` and `spend` need it raised explicitly) and `mandateMinutes` sets a new Mandate's lifetime (0 means until revoked). Action-time revalidation refuses an expired Mandate with `mandateExpired`, an action above the Mandate's recorded level or the Policy's current ceiling with `actionLevelExceeded`, and an admission basis that no longer holds with `revoked`; a Mandate never widens when the Policy raises its ceiling.