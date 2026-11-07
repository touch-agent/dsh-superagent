---
'@superagent/dsh': minor
---

Add the main-Session entry, the read-only System view inside the main Conversation, and the right Events tab with unread notices, plus a Server-Sent Events stream at `GET activity/stream` for incremental delivery. The entry opens the existing `masterId` instead of creating another router Session; the Events tab falls back to cursor polling when the stream is unavailable. Host development and peer baselines move to `0.2.1-rc.5`, and every surface is registered through `slots.inject`, so a host that lacks a seat keeps the management panel and simply omits that surface.
