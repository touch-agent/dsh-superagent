---
'@superagent/dsh': minor
---

Let a Source answer whether an outbound message is already at the remote
service. The GitHub, Feishu and Feishu document Channels read back the invisible
delivery mark their send wrote, and answer `sent`, `gone` or `unknown` instead
of guessing. The Outbox records the start of a send attempt, so on a retry or after
a restart it probes first: `sent` settles the message without writing it again,
`gone` makes the retry safe, and `unknown` keeps it pending as a system problem
rather than risking a second copy. Sources without a probe retry as before, and
the conformance suite checks each adapter's probe answers.