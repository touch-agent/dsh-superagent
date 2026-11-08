---
'@superagent/dsh': minor
---

Let a Source take back a message after it was sent. A Channel may declare
`withdraw`, which finds the object it wrote and answers `withdrawn`, `gone`, or
`refused` with a reason; `SourceRegistry.withdraw` forwards it and answers
nothing for a Channel without the adapter. GitHub deletes the marked comment it
posted. Feishu refuses, because revoking a bot message is a high-risk write that
needs a person's confirmation. The `drill:withdraw` script sends through every
kind of Channel, withdraws where it can, reads the message back with `probe`, and
prints a table that reports a Source without the adapter as unable to withdraw
rather than as a success. The T2-09 chaos test now proves across 100
abort/restart rounds that a crash between enqueue and sent still delivers one
copy, and a duplicate prints the send Action's idempotency key and delivery trace.
