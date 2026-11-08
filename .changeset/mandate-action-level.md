---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Record `maxActionLevel` and an optional `expiresAt` on a Mandate, and revalidate both when a running Ticket takes an action. The Policy's `maxActionLevel` sets the ceiling (default `draft`; `commit`, `send` and `spend` need it raised explicitly) and `mandateMinutes` sets a new Mandate's lifetime (0 means until revoked). Revalidation always checks expiry, refuses an action above the Mandate's recorded level or the Policy's current ceiling (whichever is stricter) with `actionLevelExceeded`, and refuses an admission basis that no longer holds with `revoked`. A Mandate with a recorded ceiling never widens when the Policy raises its ceiling; a Mandate accepted before the field existed follows the current Policy.
