# Withdrawing a message after it was sent

The Outbox's undo window stops a message **before** it is sent: recalling it inside the window cancels delivery and
keeps its receipt `recalled`. Once the receipt is `sent`, the remote service has the message, and only the Source can
take it back. This runbook covers that second case.

## Which Sources can withdraw

A Source withdraws a sent message only when its Channel declares a `withdraw` adapter. The inventory below covers the
installed Sources and the drill's fixtures; it never assumes a Source can undo a write:

| Source | Can withdraw a sent message | What happens |
| --- | --- | --- |
| GitHub | Yes | The Channel finds the comment by its delivery marker and deletes it; `probe` then reads it as gone |
| Feishu | No | Revoking a bot message is a high-risk `lark-cli` write that needs a person's confirmation, so the Channel refuses with that reason |
| Feishu document | No | The comment Channel has no `withdraw` adapter |
| Conversation | No | The message is already in the main Session's history; it has no `withdraw` adapter |
| Mail draft, calendar invite | Future Sources | `docs/plan/TASK-PLAN.zh.md` examples; the drill uses fixture Channels until those Sources exist |

The drill runs the fixture rows, GitHub and Feishu. The Feishu document and Conversation rows are checked by reading
their Channels, not by the drill, because neither has a drill-safe remote.

A Source without the adapter is reported as **unable to withdraw** with the reason. It is never a silent success.

## Run the drill

```sh
pnpm drill:withdraw
```

The drill sends one message through each installed or fixture Channel it can run without a live account, asks the
Source to take it back, and reads it back with `probe` to prove it is gone. It prints a Markdown table; `docs/runbooks/withdraw.drill.md` records a run. It uses
fixture Channels and mocked CLI commands, so it deletes no real comment and sends no real message.

## When a withdrawal is refused

- **Feishu, high-risk refusal:** a person who has seen the message can recall it with
  `lark-cli im messages delete --message-id <om_…> --yes`. The agent must not add `--yes` on its own; only a person
  confirms that call.
- **No withdraw adapter:** the message cannot be taken back. Send a correction as a new message; do not reuse the send
  Action's idempotency key, which would be ignored as a duplicate.
- **A refusal after the read-back:** if a Channel answered `withdrawn` but `probe` still reads the message, the drill
  reports `failed`; treat the message as still present and correct it with a new message.

## Limits

- The receipt stays `sent` after a withdrawal: it records that the message reached the remote service, and the
  withdrawal is a later act on that object. The Outbox has no panel or HTTP route for post-send withdrawal yet; the
  drill exercises the Channel contract directly.
- A withdrawal is not retried automatically. A failed or refused withdrawal leaves the message in place.
- The drill does not run against a live deployment's GitHub or Feishu accounts: deleting a live comment and confirming
  a Feishu recall are acts a person must choose.
