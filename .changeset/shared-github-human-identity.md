---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Distinguish a person's actions from the agent's output when both use one GitHub account. Add the GitHub Source's
`humanIdentity` switch, off by default: a submitted `APPROVED` or `CHANGES_REQUESTED` review and a comment starting
with `[人]` or `HUMAN:` are human, while the account's other comments, `COMMENTED` reviews, and Issue or PR bodies stay
agent output or discussion and start no Ticket. The gate records such a Trigger with the `humanIdentity` Mandate basis
and revokes it at the next check when the switch is off.