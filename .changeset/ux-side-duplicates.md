---
'@superagent/dsh': patch
---

Remove the duplicate way back on the right-sidebar auxiliary pages. A nested
task or Ticket page already renders its own back control, so the side shell no
longer adds a second "Back" above it. The Superagent side pages also hide the
host split control: opening another column would repeat the same auxiliary page
set instead of keeping the one tab set the header entries open.
