---
'@superagent/dsh': minor
---

Make the main Conversation the plugin home without changing the DSH upstream or
the host shell. Selecting Superagent now opens the existing main Session, so the
user lands in the conversation and can hand over work immediately. The main
Session's header gains four icon entries (Tasks, Notices, Files, Settings, each
with its existing badge or unread dot); they open the plugin panel at that
auxiliary page, and every such page has a "back to the main conversation"
action. The panel remembers whether it was opened as the home or as an auxiliary
page, resets to home when it is left, and keeps the batch-3 task page unchanged
when opened from the header. If the main Session is missing or archived, the
home card states the reason, offers a retry and the four auxiliary entries, and
never fakes a conversation. `ux.appShell.v1` restores the previous header and
task-view layout, while the four earlier flags keep their own fallbacks and no
record is deleted.

The browser bundle now measures 822,645 bytes for the home card, header actions,
return action and new copy, so the `lib/client.js` ceiling moves from 820,000 to
830,000 bytes; the total ceiling does not change.
