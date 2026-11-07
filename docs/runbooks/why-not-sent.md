# Why a message did not become work

A person asked, commented, or was named, and nothing happened. The Store saw the message — it is on a Thread — but no Ticket
followed, or the Ticket never started. This runbook answers the only question that matters in that moment: **where did it
stop, and what do I change?**

Work it in three steps. Each one is meant to take seconds, not minutes.

## 1. Find the Trigger

- The panel's header search finds a Trigger by its text, its id, a Feishu message id, or a stored link (for example a GitHub
  comment URL).
- From the conversation, open the Trigger tab and the Thread; every message on the Thread is one Trigger of its timeline.
- From a Decision, the Eval page links back to the Trigger it judged.

Every Trigger's row carries a **Why** button. That is the whole of step 2.

## 2. Read its trace

**Why** opens the stages the Engine ran for that Trigger, oldest first, each with the time it ran:

| Stage | What it means |
| --- | --- |
| Received | The Source handed the message over, and it was stored as a Trigger |
| Deduplicated | The Store already had this Trigger; nothing new happened. This is a stop, not an unfinished trace |
| Queued | The Thread was put in line for an Eval |
| Gate | The deterministic half of the Eval judged it: allowed sender, mention, admission cell |
| Admitted to an Eval | The Thread entered an Eval; the gate's strength and route are in its facts |
| Assessed | The candidate reached the main Session, which is now judging it |
| Decided | The Eval recorded what the Trigger became: accept, stop, ignore or unavailable |
| Attached | An accept opened a Ticket for it, or the message joined a Ticket that already ran |
| Dispatched | The Executor started an Assignment, a worker's Session, for that Ticket |
| Reported | That worker reported: progress, waiting, ready, blocked, failed or dropped |

A trace that stops before **Decided** is still in flight, and the panel says so rather than pretending the last stage was the
end. A trace with no stages at all is a different answer: the Trigger never reached the Store.

## 3. Read the stop

| What the trace shows | What it means | Where to change it |
| --- | --- | --- |
| Stops at **Gate**, reason "The sender is not on the Source's list" | The gate refused: no admission rule covers this sender, or the accept mode is off | Settings › Sources: the allowed list, then Settings › Eval: accept mode |
| Stops at **Gate**, reason "No enabled admission rule matched" | The sender is known, but no rule matched and the Thread is not already in play | Settings › Eval: the admission rules |
| Stops at **Gate**, reason "Observe mode: would accept (…)" | The gate admitted the message but the accept mode is `observe`, so the Decision was an ignore | Settings › Eval: accept mode `auto` |
| Stops at **Deduplicated** | The Store already had this exact Trigger; look at the Trigger that arrived first | The earlier Trigger on the same Thread |
| Stops at **Queued**, with no Gate stage | Nothing has evaluated the Thread yet: processing is paused, the passes are not running, or the Thread is still in line | Overview: Pause processing; the Eval tab's queue |
| Stops at **Admission** or **Assessed**, incomplete | The gate let it through and the main Session is judging it (or never got to); no Decision was recorded | Eval tab: the Thread's latest Eval and its timeout |
| Stops at **Decided** | The Trigger was judged but became no work: read the Decision's kind and reason on the Eval page | Eval tab: the Decision, then its reason |
| Stops at **Dispatched** | Work started but no worker reported yet: the Assignment is running or failed to launch | Execution tab: the Ticket and its Assignment |

If the trace is empty, the Trigger never reached the Store: that is a Source problem, not an Eval problem. Check the Source's
state on the Source tab; a polling Source that fails reports it there.

## Reading a trace without the panel

The panel is the intended path, but a state directory and `sqlite3` answer the same question. The trace id is derived from the
Trigger id, so it can be recomputed:

```sh
TRIGGER='feishu:om_xxxxxxxx'
TRACE=$(node -e "const { createHash } = require('node:crypto'); console.log(createHash('sha256').update(JSON.stringify(['trace', process.argv[1]])).digest('hex').slice(0, 32))" "$TRIGGER")
sqlite3 "$STATE_DIR/orchestrator.sqlite" \
  "select kind, at, json_extract(value, '$.data') from span where trace = '$TRACE' order by at, rowid"
```

The same rows come back through `GET triggers/:id/trace` on the management API.

## Limits worth knowing

- Recording is best effort: a span that fails to write is dropped, and the command that produced it still commits. A missing
  stage in the middle of a trace means the trace, not the work, is incomplete.
- No stage is recorded for a Trigger the Store rejected before intake (a Source filtering its own messages, or a scope that
  drops a Thread). Those never become Triggers, so nothing is there to explain; the Source tab's filtered counts are the
  place to look.
- Traces are kept forever and are not pruned yet, like every other record. The `span` table is the first thing to bound when
  retention work starts.

## Drill

`why-not-sent.drill.md` records a timed walk-through of this runbook on a fixture state directory.