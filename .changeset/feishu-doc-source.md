---
'@superagent/dsh': minor
'dsh-superagent': minor
---

Add the Feishu document Source: it polls the comment cards of configured documents as the bot configured on the Feishu Source, turns new replies into Triggers (a comment card is the Thread, a bot mention is an explicit request), and answers on the card with an invisible delivery mark so a retried reply is not posted twice. It registers as a manifest plus adapter through `registerDefinition`, exports `./feishu-doc-watch`, and passes the shared adapter conformance suite; its patch row is disabled by default.
