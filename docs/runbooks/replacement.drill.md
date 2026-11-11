# Drill: replacing an execution boundary

`pnpm drill:replacement` was run on 2026-11-11 in an offline worktree of `touch-agent/dsh-superagent` (Node 24.16.0,
pnpm 11.7.0). Every run used the real `Engine`, a real temporary SQLite `Store`, a fixed clock and a fixture Policy,
assessor and outbox. It called no network, used no credential, started no DSH Session and sent no message. The baseline
is `main@0af96a0`; the replacement is this branch's `ReplayExecutor`, and the runbook is
`docs/runbooks/replacement.md`.

## The drill

```text
| Run | Tickets | Children | Depth | Spans | Decisions | quiet/feed/notice | Outbox | Result | Audit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| baseline | 2 | 1 | 1 | 18 | 1 | 7/5/0 | 2 | completed | complete |
| replay | 2 | 1 | 1 | 18 | 1 | 7/5/0 | 2 | completed | complete |
| flat | 1 | 0 | 0 | 10 | 1 | 3/4/0 | 2 | completed | complete |
| failure | 2 | 1 | 1 | 16 | 1 | 7/4/0 | 1 | failed | complete |
| rollback | 2 | 1 | 1 | 18 | 1 | 7/5/0 | 2 | completed | complete |

Equivalence: executor replay true; flat behavior true; view hidden true; rollback true.
```

`Outbox` counts the outbox **port requests** the Engine made in the run (one acknowledgement plus one result for a
successful run); it is not a count of persisted receipts or of delivered messages. Every run's audit checks were
`decision`, `root`, `report`, `trace`, `activity`, `outbox`, and `child-chain` where a child existed; all passed.

## What each row proves

- **baseline** — one human request becomes one accepted Decision, one root Ticket, one child Ticket, a child report, a
  parent review (accept), a completed root, and one acknowledgement plus one result request. The trace has every stage
  from `ingest` to `report`; the activity feed holds the same events; the organization figures read depth 1 and one child.
- **replay** — the same task with the `Executor` port held by `ReplayExecutor`, which only looks up the baseline's
  recorded plans. Decisions, Tickets, spans, activity, outbox requests, organization and attention figures are
  byte-identical to the baseline (the test compares them as JSON). This is the replacement-equivalence evidence.
- **flat** — the same Trigger accepted the same way, but the worker reports the root directly: no delegation, no child,
  no parent review, 10 spans instead of 18. The root still ends `completed`, the acknowledgement and result messages are
  equal, and the notice count is equal. The audit is complete for the shape it ran; it is not byte-identical, because
  the child chain is gone (D2).
- **failure** — the child reports `failed`; the parent resolves it as failed and reports the root `failed`. Only the
  acknowledgement is requested; no result is invented, and the Ticket waits for a person. The failure is visible in the
  records and the audit chain is complete.
- **rollback** — the baseline `ScriptedExecutor` is restored after the failing replacement. The run is audit-complete,
  ends `completed`, and its stored rows and outcomes match the baseline again.

## Key metrics before and after

| Measure | Baseline Executor | Replayed replacement | Flat organization | Failing replacement | Restored baseline |
| --- | --- | --- | --- | --- | --- |
| Root outcome | completed | completed | completed | failed | completed |
| Tickets / children / depth | 2 / 1 / 1 | 2 / 1 / 1 | 1 / 0 / 0 | 2 / 1 / 1 | 2 / 1 / 1 |
| Spans | 18 | 18 | 10 | 16 | 18 |
| Outbox requests | 2 | 2 | 2 | 1 | 2 |
| Feed graded quiet/feed/notice | 7/5/0 | 7/5/0 | 3/4/0 | 7/4/0 | 7/5/0 |
| Parent review samples | 1 | 1 | 0 | 0 | 1 |
| Audit complete | yes | yes | yes | yes | yes |
| Result messages | `Drill: completed` | identical | identical | none | identical |

The drill did not observe a difference in the user-visible result, the result text, the acknowledgement, or the notice
count when the Executor was replaced or the task view was hidden. It did observe structural differences when the
organization was flattened, listed below.

## Non-equivalence and coverage record

Every difference is graded; none is waived as "acceptable". A `low` structural difference still bounds the claim, and a
`medium` coverage gap means the drill cannot support that part of the replaceability claim.

| # | Area | Severity | Difference | Effect on the conclusion |
| --- | --- | --- | --- | --- |
| D1 | coverage | medium | The Executor is replaced by a replay driver, not by the production `DshExecutor`. Equivalence covers the port → Engine → Store contract, not a live DSH Session and model turn. | The Executor boundary is proven replaceable at its port; the production implementation's behavior is not claimed. |
| D2 | structure | low | Flattening removes the child, the delegation stages and 8 spans; the flat audit is complete but not byte-identical (no `child-chain` check). | C4.2 is partial: result, messages and notices are equal, but "audit equivalent" holds only as "audit complete and explainable", not as identical evidence. |
| D3 | coverage | medium | The model provider is not replaced. The replay fixture fixes the worker decisions, so no provider- or prompt-level output equivalence is claimed. | The model boundary remains configuration-only evidence; it does not satisfy a behavioral replacement drill. |
| D4 | notification | medium | Notifications are compared as outbox requests and graded activity, not as live GitHub/Feishu deliveries. | The transport contract is covered by `tests/withdraw-drill.spec.ts`; this drill does not add delivery evidence. |
| D5 | coverage | medium | Auto-open close rate and default-surface click depth are not collected; both live only in the browser. `GET metrics` reports `status: "not-collected"`, not zero. | Attention observation is partial: the server-side counts are real, the two client measures remain a product gap. |
| D6 | coverage | medium | The Store stays SQLite in every run; the drill does not swap `Repositories` for another implementation. | The Store boundary is supported by the domain tests over `MemoryRepositories` and by the port's shape, not by this drill. |

## What the drill caught

- **The outbox port and the outbox table are not the same evidence.** The first version compared the `outbox` table, which
  the Runtime's `Outbox` adapter writes, but the drill supplies the `Outbox` port itself. The table was empty while the
  Engine had in fact requested an acknowledgement and a result. The drill now compares the port requests and says so;
  otherwise it would have reported "zero notifications" for a run that notified twice.
- **A failed run must not be forced to have a result.** The first audit required an acknowledgement *and* a result for
  every run, so the correctly failed run was marked incomplete. The rule now requires a result only when the root
  reports `ready`; a failed root legitimately waits for a person with only its acknowledgement.
- **A read-only projection is not proven by reading it once.** The baseline reads `GET tasks` before and after; both
  digests are equal and no row changes. The view-hidden comparison then shows the records do not depend on that read.
- **Flattening is not free.** Removing the child removes the delegation and parent-review evidence. The result is the
  same, but a drill that compared only the ending would have called the organizations identical; the structural
  difference is recorded as D2 and restricts C4.2.

## Boundary inventory and conclusion

| Boundary | Replaceability conclusion | Evidence from this drill |
| --- | --- | --- |
| Source | Replaceable plugin; not exercised here | Fixed Trigger; intake/gate stages and Decision are recorded, but no Source payload or registry swap |
| Executor | Replaceable at the port; production implementation unverified | Baseline vs replay byte-identical; failure and rollback recorded |
| Model provider | Configured, not behaviorally verified | Fixture decisions; D3 |
| Transport / Channel | Replaceable adapter; delivery not exercised | Outbox port requests compared; D4 |
| Store | Replaceable through `Repositories`; SQLite only here | Real SQLite Store throughout; domain tests over memory; D6 |
| Task view / organization | Removable and flattenable without losing records | View read wrote nothing; flat run kept result/notices; D2 |
| Presentation / attention | Server-side counts implemented; two client measures missing | `GET metrics` organization/attention; D5 |

## C4.1–C4.5, item by item

| Checkpoint | Verdict | Evidence and gap |
| --- | --- | --- |
| C4.1 Six boundary kinds stay in their layers | **Pass** | `packages/dsh/src/app/replacement.ts` reads only Store repositories; `scripts/replacement/core.ts` imports kernel ports and app adapters in the test/drill layer; `tests/kernel-boundary.spec.ts` and `tests/layers.spec.ts` enforce the dependency rules. |
| C4.2 Same task with the view hidden and the organization flattened keeps result and audit | **Partial** | Hidden view: byte-identical digest (pass). Flattened: same outcome, result text and notice count, but 10 vs 18 spans and no child chain; audit is complete, not identical (D2). The result-equivalence claim holds; the strict audit-equivalence claim does not. |
| C4.3 Removing the category overlay leaves Tickets intact; removing child delegation leaves Tickets/Assignments explainable | **Partial** | Child delegation removal is exercised by the flat run: the root still has its Decision, Assignment and report, and `taskDetail` explains it. No category overlay exists in this checkout, so there is nothing to delete or test; projection read-only is asserted (`viewWrites` empty). |
| C4.4 Observation does not depend on the replaced UI | **Pass, with D5** | The digest is built from decisions, Tickets, spans, activity, outbox port requests and metrics without reading the view; baseline and replay match. Two attention measures are client-only and are explicitly `not-collected` (D5), so the observation set is incomplete. |
| C4.5 A new person can finish a task without the organization view | **Not verified** | No new-person usability walkthrough was run; this drill is technical evidence, not a usability study. Recorded as a product gap, not claimed. |

The independent review comment on the PR repeats this table item by item, as the assignment requires.