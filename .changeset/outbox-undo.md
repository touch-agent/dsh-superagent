---
'@superagent/kernel': minor
'@superagent/dsh': minor
---

Hold outbound messages for a Policy undo window (default 30 seconds, 0 for IM
tenants), so a message stays pending and recallable before it is sent. Recalling
it marks the receipt `recalled`, cancels delivery and keeps its ID terminal; a
late recall is refused with the window's end, and the window is recorded per
message so a Policy change affects only later messages.
