# Drill: why-not-sent, on a fixture state directory

The runbook `why-not-sent.md` was walked once end to end, timed, on a fixture `orchestrator.sqlite` with three traces. The
repository has no production state directory, so the fixture stands in for one: it holds only `span` rows, built with the same
id derivation the Engine uses (`sha256(JSON.stringify([...]))`, first 32 hex characters).

## The fixture

| Trigger | Stages recorded | What a person should conclude |
| --- | --- | --- |
| `github:issue:901` | Received, Deduplicated, Gate (`admitted: false`, `reason: not_a_member`) | The sender is not on the repository's list |
| `feishu:om_2` | Received, Deduplicated (`duplicate: true`) | The Store already had this Trigger |
| `feishu:om_3` | Received, Deduplicated, Queued, Gate (`admitted: true`), Admitted to an Eval | The gate let it through; no Decision yet, so the trace is still in flight |

## What was done, and how long it took

Step 1 (find the Trigger) was skipped: the drill starts from the id, as a person arriving from a search or a link would.
Steps 2 and 3 were run with the runbook's shell commands, timed with `perf_counter` around them.

| Trigger | Trace lookup | Verdict read from the trace | Total |
| --- | --- | --- | --- |
| `github:issue:901` | 3 stages | Stopped at the gate: "The sender is not on the Source's list" → Settings › Sources | 50 ms |
| `feishu:om_2` | 2 stages | Stopped at deduplication: this message was already a Trigger | 39 ms |
| `feishu:om_3` | 5 stages | Past the gate, still in flight → Eval tab for the Decision | 36 ms |

All three are far inside the 30-second acceptance bar; the lookup itself is a single indexed read (`span_trace`).

## What the drill caught

- **The trace id depends on exact JSON encoding.** The first fixture was built in Python with `json.dumps` defaults, whose
  separators are `", "` and `": "`; the Engine's `JSON.stringify` emits `","` and `":"`. Every lookup returned zero rows. The
  runbook's `node -e` one-liner avoids this by using the same encoder as the Engine, and the fixture had to match it.
- **An empty trace is a different answer from an empty Stage list.** A Trigger id the Store never saw returns no rows at all;
  a Trigger whose Source dropped its own message never became a Trigger and will never have a trace. The runbook sends that
  case to the Source tab instead of to the Eval.
- **"Incomplete" had to be said out loud.** Before this drill the panel labelled the last recorded stage as the end of the
  trace, so a Trigger that passed the gate looked like it stopped at Admission. `TriggerTraceView.partial` now marks a trace
  with no Decision yet, and the panel says the later stages have not run instead.
- **The fixture was made before the last five stages existed.** It was rebuilt with the same rule the Engine now uses — the
  trace is complete once a Decision settles the Trigger — so a stage list ending at Admitted to an Eval reads as "still in
  flight" rather than "the Engine stopped writing here".

## The same two steps, automated

- `tests/trace-view.spec.ts` — the view: an unknown Trigger answers empty, stages come back in order with their facts, a
  refusal stops at the gate, and an admitted Trigger is `partial`.
- `tests/panel-trigger.spec.tsx` — the panel path: **Why** fetches `triggers/:id/trace` and shows the stage labels and the
  gate's reason.