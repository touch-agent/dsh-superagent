---
'@superagent/dsh': minor
---

Make the main Conversation the plugin home without changing the DSH upstream or
the host shell. Selecting Superagent now opens the existing main Session, so the
user lands in the conversation and can hand over work immediately. The main
Session's header gains four icon entries (Tasks, Notices, Files, Settings, each
with its existing badge or unread dot); they open independent host right-sidebar
pages while the conversation stays visible, and links inside those pages stay in
the same tab. The panel keeps its auxiliary pages and "back to the main
conversation" action as the fallback for hosts without that sidebar, remembers
whether it was opened as the home or as an auxiliary page, and resets to home
when it is left. If the main Session is missing or archived, the
home card states the reason, offers a retry and the four auxiliary entries, and
never fakes a conversation. `ux.appShell.v1` restores the previous header and
task-view layout, while the four earlier flags keep their own fallbacks and no
record is deleted.

The browser bundle now measures 827,843 bytes for the home card, header actions,
right-sidebar page shells and new copy; it stays under the `lib/client.js`
ceiling of 830,000 bytes. The total ceiling moves from 1,860,000 to 1,866,000
bytes for the four embedded page shells.
