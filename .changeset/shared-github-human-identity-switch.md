---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Show the GitHub Source's `humanIdentity` setting in the panel as a switch, off by default, instead of leaving it a
configuration-only flag. The switch words the shared-account effect: a submitted `APPROVED` review is a person's
approval, `CHANGES_REQUESTED` a rejection, and a comment starting with `[人]` or `HUMAN:` an instruction. A switch may
declare the other switches it `requires`; while `humanIdentity` is on, the card lists the missing receive switches
(`observeComments`, `observePulls`) as clicks that turn them on in the draft, and the hint explains what each one adds.