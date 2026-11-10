---
'@superagent/dsh': minor
---

Add the derived context-group dimension (T5-03). A Ticket's optional
`context_group` is derived at read time from its Source Channel addresses and
the Threads whose subscriptions still name it: Feishu group chats and GitHub
repositories are shared spaces, direct chats and the local conversation are
not. The projection carries the shared-space address, Source-owned visibility
and the Threads that supply its conventions; it stores nothing, creates no
`Membership` table, lists no members and grants no action. It appears in the
ticket read resource and the first Assignment message, `GET contexts/groups`
serves the aggregated read-only list, and `contextGroupDimension` yields the
optional entry shape T5-04's six-layer assembler consumes. Unsubscribing from
the last Thread of a space removes the dimension without rewriting the Ticket.
