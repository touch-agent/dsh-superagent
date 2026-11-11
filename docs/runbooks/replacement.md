# Runbook: replacing an execution boundary

This runbook is the operational half of design principle D (`docs/011-design-principles.zh.md` §5): the organization,
the Executor, the model provider, the transport and the Store are meant to be replaceable, and a replacement must be
judged from records rather than from the task view the replacement might change. The drill that produced the evidence
is `docs/runbooks/replacement.drill.md`; run it with `pnpm drill:replacement`.

## The boundaries

| Boundary | Replaceable? | What a replacement may change | What must stay invariant | Health and impact evidence |
| --- | --- | --- | --- | --- |
| Source | Yes, by a registered plugin | How a payload becomes a Trigger and a Thread fact; which threads it follows | Intake idempotency, the gate, explicit vs inferred strength | Trigger dispositions, `ingest`/`gate` spans, `GET sources` |
| Executor | Yes, through the `Executor` port | How an Assignment runs: DSH Session, subagent, another runtime, a replay | The Engine callbacks (`assignmentStarted`, `inputsDelivered`, `inputsRead`, `report`), the Ticket ending rule, the audit chain | Assignment state, report state, `dispatch`/`report` spans, `GET metrics` |
| Model provider | Configurable per profile; unverified as a behavioral replacement | Provider, model, reasoning effort, prompt revision | The worker's result shape, the gate, the mandate limits; no model output may widen authorization | `ProfileSnapshot`, model-request records, `GET profiles/:id/metrics` |
| Transport / Channel | Yes, through the `Channel` adapter | How an outbound message reaches a person; how a sent message is withdrawn | One message per result, the undo window, the delivery marker, `probe` | Outbox receipts, `reply`/`notice` effects, activity levels, withdraw drill |
| Store | Yes, through `Repositories` | Persistence engine behind Triggers, Threads, Tickets, Assignments, Evals, outbox, trace, activity | Atomic units of work, nested rollback, the domain invariants the Engine enforces | Store tests, `MemoryRepositories` domain tests, schema migrations |
| Task view / organization | Yes, including removal or flattening | Milestone tree, child Tickets, categories, lanes, right panel | Tickets, Assignments, Decisions and reports remain explainable without the projection; views write nothing | `GET tasks`, `organization` and `attention` in `GET metrics`, `tests/replacement-metrics.spec.ts` |
| Presentation / attention | Partly; the default surface is a product decision | Cards, auto-open, default landing surface | One notification per result, no automatic reopening of a settled task; a person can reach the record | Outbox requests, activity levels, future client event reporting |

## Reading a replacement

1. **Record the baseline.** Run the task on the current implementation and keep its decisions, Tickets, spans, activity,
   outbox requests and the organization/attention figures. The drill's `baseline` run is that record.
2. **Run the replacement on the same fixture.** Same Trigger, same clock, same Policy and same worker plan. Only the
   boundary under test changes.
3. **Compare the explained facts, not only the ending.** A replacement that returns the same result while losing the
   Decision, the Assignment report or the trace is not equivalent; the audit chain is part of the result.
4. **Read the view twice.** Read `GET tasks` before and after a run and compare the stored rows; a projection is
   read-only. Then run with the view unread and compare the records with the baseline. This is what C4.4 checks.
5. **Grade every difference.** Write the difference, its area and severity in the drill report. A structural difference
   (fewer tickets, fewer spans after flattening) is not automatically acceptable: say what it changes and what it does
   not. Do not label a gap "acceptable" without a grade and a reason.
6. **Fail, then roll back.** Run a replacement that makes the worker report `failed`. The failure must be recorded (a
   failed report, a resolved child, no invented result). Then restore the baseline implementation and assert the
   baseline digest returns. A rollback that only starts the old process without comparing records is not evidence.

## The figures

`GET metrics` now carries two additive blocks, both read from stored domain rows:

- `organization.tickets`: roots, children, open Tickets, `maxDepth`, `medianDepth`, `depthDistribution`.
- `organization.children`: active children, `maxActivePerRoot`, roots with active children, orphaned and unresolved
  children.
- `organization.parentReview`: samples, median and p90 seconds between a child's report and its parent's disposition.
- `attention.results`: ended root Tickets the counts are attributed to.
- `attention.notifications`: outbox requests naming one of those roots, per result, by kind.
- `attention.activity`: the retained quiet/feed/notice window (newest 5,000 records) and notices per result.
- `attention.autoOpen` and `attention.clickDepth`: `status: "not-collected"`. Auto-open/close and default-surface clicks
  happen in the browser and are not sent to the server, so the figures are explicitly unavailable, not zero.

The figures are all read-only and do not depend on the task view. An empty Store reports `null` ratios and no samples,
never a healthy zero.

## Rollback

The drill adds no schema migration and no stored format; replacing the Executor is a code-level swap. To roll back a
production replacement:

1. Keep the previous build and its configuration; no data rewrite is needed for this boundary.
2. Redeploy the previous build (or restore the previous Executor adapter) and restart the Runtime.
3. Re-run `pnpm drill:replacement`; the `rollback` run must be audit-complete and its record must match the baseline
   digest, as the drill's own rollback phase asserts.
4. If a replacement did add a migration, follow `docs/006-deployment.md` and restore the backup instead; this runbook
   does not authorize an in-place downgrade of stored records.

## Limitations this runbook does not hide

- The drill replaces the Executor with a replay driver. It does not run the production `DshExecutor` against a DSH host
  and a model, and it does not claim model-turn equivalence.
- The model provider is not replaced in the drill; its boundary is configuration-level only in this evidence.
- Notifications are compared as outbox requests and graded activity; no real GitHub or Feishu message is sent.
- The Store stays SQLite in every run; `MemoryRepositories` is covered by domain tests, not by this drill.
- Auto-open/close and click depth remain uncollected, so the attention figures are partial. This is a recorded product
  gap, not a pass.

## The same checks without the drill

- `tests/replacement-drill.spec.ts` — the five runs, replay equivalence, the flat-organization behavior comparison, the
  view-hidden comparison, the failing run and rollback, and every audit-chain check.
- `tests/replacement-metrics.spec.ts` — depth, active children, parent review waits, orphans, unresolved children,
  messages/notices per result, empty-Store nulls and the two `not-collected` measures.
- `tests/metrics.spec.ts` — the existing health figures remain additive and unchanged in meaning.
- `tests/kernel-boundary.spec.ts`, `tests/layers.spec.ts` — the six boundary kinds stay in their layers (C4.1).
- `tests/withdraw-drill.spec.ts` — the transport contract the drill only compares as requests.