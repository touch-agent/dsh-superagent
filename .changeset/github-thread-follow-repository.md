---
'@superagent/dsh': patch
---

Refuse a context-only follow of a GitHub Thread that is not in the Source's
configured repository. The Source reads only that repository, so the Thread's
comments could never reach the Ticket, and the unreadable Thread kept every
poll failing for as long as the Ticket followed it. The Executor now gets a
clear error instead of creating a Subscription that poisons Source health.
