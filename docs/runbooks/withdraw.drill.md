# Drill: withdrawing a message after it was sent

The runbook `withdraw.md` was walked once with `pnpm drill:withdraw` on 2026-11-08, on the local checkout with Node
24.16.0 and pnpm 11.7.0. The run used fixture Channels and mocked `gh`/`lark-cli` calls: it sent no real message and
deleted no real comment. The table below is the drill's own output.

## The drill

```text
| Source | Sent | Withdraw | Verify | Verdict |
| --- | --- | --- | --- | --- |
| mail-draft | sent | withdrawn | gone | withdrawn |
| calendar-invite | sent | refused | not attempted | cannot withdraw: Two guests accepted the invite; cancelling it needs the organizer |
| no-recall | sent | unsupported | not attempted | cannot withdraw: the no-recall Source has no withdraw adapter |
| already-gone | sent | gone | gone | already gone |
| github | sent | withdrawn | gone | withdrawn |
| feishu | sent | refused | not attempted | cannot withdraw: Recalling a Feishu message is a high-risk write that needs a person's confirmation |
```

## What each row proves

- **Mail draft (fixture):** a Source with a `withdraw` adapter deletes the sent object and `probe` reads it as `gone`;
  the whole send → withdraw → verify loop works, not only the delete call.
- **Calendar invite (fixture):** a Source that can locate the object but refuses returns a reason a person can act on,
  and the drill does not call `probe` or claim the message is gone.
- **No-recall (fixture):** a Source without the adapter is unsupported, with that reason. This is the case a careless
  drill would report as a false success.
- **Already-gone (fixture):** the object is absent when withdrawal starts, so `gone` is a successful no-op, not a
  refusal; the drill says `already gone`.
- **GitHub:** the marked comment is found by the same delivery marker `probe` uses, deleted at
  `issues/comments/77` by its own id, and the read-back then finds nothing. The drill asserted the exact DELETE path.
- **Feishu:** the Channel refuses before touching the remote. `lark-cli im messages delete` is a high-risk write that
  requires `--yes` after a person confirms it, and the agent must not pass that flag on its own.

## What the drill caught

- **The Feishu path cannot be automatic.** `lark-cli im messages delete --help` marks the recall `high-risk-write` and
  requires explicit confirmation. An automatic `withdraw` for Feishu would either bypass that rule or fail, so the
  Channel returns `refused` and the runbook tells a person the exact command.
- **The two examples in TASK-PLAN have no production Source.** There is no mail-draft or calendar-invite Source in the
  repository yet. The drill keeps those rows as fixtures so the contract is exercised now, and the table says so
  instead of pretending the Sources exist.
- **A delete that returns success is not proof.** The GitHub row is only accepted after `probe` reads the comment as
  gone; the drill's verdict is `failed` when the Channel answers `withdrawn` or `gone` but the read-back still sees it.

## The same checks without the script

- `tests/withdraw-drill.spec.ts` — the drill: the six rows above, the exact GitHub DELETE path, a non-empty refusal
  reason, no false success for a Source without an adapter, and a GitHub comment that is already gone or whose delete
  is refused.
- `tests/registry.spec.ts` — `SourceRegistry.withdraw` forwards to the Channel, and answers nothing for a kind without
  the adapter or a kind that is not installed.
- `tests/chaos.spec.ts` — the related T2-09 guarantee: a crash between enqueue and sent still delivers one copy, so a
  withdrawal is never compensating for a duplicate send.
