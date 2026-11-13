---
'@superagent/dsh': minor
---

Add the plugin-possible part of the third UX batch. The task view gains a
main-Agent card with a browser-local name, four preset avatars or a local image
re-encoded to 96×96 without its original metadata, one-line state and an entry
to the existing main Session; nothing is written to the server. The panel's
first-level entries become Tasks, Notices, Files and Settings, the default route
moves to Tasks, and the duplicate right-pane Events and Tasks tabs are no longer
registered while this navigation is on. A frame-wide floating notice button
replaces the header bell with a count and the latest unread summary, falls back
to a quiet state, opens the existing drawer, and returns focus to its opener on
Escape or Close. The Files page is a read-only projection of the existing task
deliverables: `http(s)` references open directly and other references return to
their task. `ux.navFour.v1`, `ux.masterCard.v1`, `ux.noticeButton.v1` and
`ux.filesPage.v1` independently restore the earlier surfaces without deleting
any record; doc 026 lists the host limits that remain mapped to the upstream
requests in doc 022.
