---
'@superagent/dsh': patch
---

Return an already-current Session to its Chat View when **Open conversation** is used. Selecting the Session that is
already in front was a host no-op, and its Status View kept Status on screen, so the action looked dead. The Status
View now lends its Session-bound View selector to the shared opener, which switches to Chat and remembers that View;
the Ticket page header, assignments, the task list and the main-Session entry all use that opener. A Session missing
from the catalog still reports the localized reason in the panel notice instead of failing silently. Selecting a
different Session remains a visible Session change; the host still restores that Session's own last View.
