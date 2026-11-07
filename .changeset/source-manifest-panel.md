---
'@superagent/dsh': minor
---

Drive the Source settings card from the manifest: `SourceRegistry.form()`
projects a registration through `manifestForm`, and the settings and health
views hand that model to the client. The card renders its fields from it and
shows the sign-in kind, the declared health entries and the polling default,
so a Source that registers only a manifest needs no panel code.