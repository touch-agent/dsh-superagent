---
'@superagent/dsh': minor
---

Make the plugin panel its own application shell without changing the DSH
upstream or the host shell. The panel now uses the full width the host gives it:
the main-Agent card sits at the top on every page, the four entries (Tasks,
Notices, Files, Settings) are icon-and-text tabs in the same frame, and the
content area keeps the search, glossary and notice entry. The landing page is
still Tasks; a right-hand "waiting for you" summary lists the tasks whose
`attention` flag is set, opens their detail, or applies the existing waiting
filter, without adding a second inbox or a write path. Inside the shell the card
is the only main-Session action and the host New Session page's duplicate
shortcut is no longer registered. `ux.appShell.v1` restores the previous header
and task-view layout, while the four earlier flags keep their own fallbacks and
no record is deleted.

The browser bundle grows by about 13.3 kB for the shell, the summary, the new
copy and styles, so the `lib/client.js` ceiling moves from 800,000 to 820,000
bytes and the total from 1,840,000 to 1,860,000.