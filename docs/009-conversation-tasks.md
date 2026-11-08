# 009 Conversation tasks and multi-source work

Status: approved 2026-11-07 for phase 1 (M1.5 in TASK-PLAN). T1-13 (the built-in conversation Source) and T1-14 (`orchestrator_dispatch`, including attach to an existing ticket) are implemented, with the prompts updated. The panel marks the built-in Source, labels a conversation-origin Ticket, and can narrow the Ticket list to it; and the Ticket page links back to the main Session it came from, with the operation described in [005](005-panel.md). T1-15/T1-16 are implemented. T1-17 adds `Engine.bindChannel` and `orchestrator_ticket_bind`; the Ticket page shows each subscribed Thread as an anchor, with whether the Ticket opened it or follows it and its close, and its last event. A richer per-task card remains future polish. §10 records the decisions the design runs on.
It uses the terms of [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md) and [007 Architecture](007-architecture.md).

## 1. The gap

Work enters dsh-superagent only through a Source: an external event stream with a read position, its own identity, admission rules and Thread/Channel mappings. The main Session is a person-facing router, not a Source; its chat messages are DSH session messages, not Triggers. That has two consequences today:

- A person cannot assign work by talking to the main agent. Only a message in a Source Thread (GitHub, Feishu, a webhook queue) enters Eval and can become a Ticket.
- A Ticket has one origin Trigger and the Channels of the Triggers it was accepted with. It can follow other Sources' Threads for context, but it has no first-class way to report into, or be advanced by, a Source it did not start from. The "one task across several Sources" story exists in the data model but not in the product.

## 2. Requirements

| # | Requirement |
| --- | --- |
| R1 | A person can assign a task by talking to the main agent, and see it accepted. |
| R2 | A person can chat, ask questions, ask for status and discuss without every message becoming work. |
| R3 | A task can span Sources: started in one, advanced by events in others, reported where people are. |
| R4 | A Source event (PR merged, issue closed, document approved) can be the state change that moves a task on. |
| R5 | Audit, idempotence and authorization stay: every Ticket still comes from an Eval on Triggers, and a person's identity is never mapped across Sources. |
| R6 | The main agent coordinates (dispatch, attach, stop, answer); Executors still do technical work. |

## 3. Principles

1. **A conversation message becomes a Trigger before it becomes work.** The main Session never creates a Ticket. It records a Trigger from a built-in conversation Source, and Eval decides as it does for every Source. This keeps duplicate suppression, Decision history, Mandates and audit in one place.
2. **Chat is not a Trigger by default.** Only an explicit dispatch creates one. "What is the status?" or "thanks" must not create candidates, Eval batches or Tickets.
3. **A conversation Source is trusted and local, but still a Source.** Its actor is the authenticated local user, its admission row is fixed (the user is explicit by definition), and it has no roster or external credentials. It is built in so that identity and channel delivery cannot be configured away by a team.
4. **The Ticket remains the task aggregate.** Channels, Subscriptions, Assignments and Inputs already express a task that spans Sources; no second Task entity is introduced in this phase.
5. **The main agent routes and coordinates; it does not implement.** It may dispatch a request, attach a follow-up, ask a Ticket's Executor, answer a status question, or stop work. It does not read code, design a solution or operate a Source directly.
6. **Outbound actions keep their own authorization.** A Ticket replies through its Channels; the agent acts with its own bot identity on each Source. The person's identity is not reused on GitHub or Feishu, which keeps the policy model intact (001 rejects cross-Source identity mapping).

## 4. Design

### 4.1 A built-in conversation Source

A new Source kind, `conversation`, whose instance is the main Session's conversation. It is not a plugin a team installs; the runtime registers it with the main Session.

| Domain concept | Conversation mapping |
| --- | --- |
| Trigger | One dispatched request or one item a split message became (the message id is the stable id; a split item adds its own key) |
| Thread | The task thread: the request message and the replies under it. Recommended over one Thread per conversation, so status questions and follow-ups reach exactly one task |
| Actor | The authenticated local user |
| Channel address | The session and the task thread; `send` delivers into the conversation |
| Receiving scope | The conversation; every dispatched message is listened to and observed |
| Admission | The Source is trusted and local: its authenticated user is explicit by definition (`basis.via = local`), with no roster or admission row to configure |

`scope` listens to every Trigger this Source produces (they exist only when dispatched). `threadContext` reads the task thread from the session transcript, so Eval and Executors see the request and its discussion. `health` is empty: the main Session itself is the only dependency, and it reports its own state.

Two flows use the Source:

- **Dispatch.** The main agent calls a new tool, `orchestrator_dispatch`, with the current message (or a referenced one), an optional title and an optional existing Ticket. The host stores the conversation Trigger and calls `Engine.receive`. The normal path continues: candidate, Eval, Decision, Mandate, Ticket. For this Source Eval may be deterministic: the local user is explicit by definition, so it can accept without a model call while still recording the Decision, the Mandate and the origin. The alternative, an ordinary model Eval, stays available behind a setting.
- **Follow-up and status.** A reply in the task thread can be attached to the task's Ticket by `orchestrator_route attach` (or by the dispatch tool's existing-Ticket form). Then the Executor answers in the conversation. A pure status question may be answered by the main agent from `orchestrator_read` without touching the Ticket.

### 4.2 The dispatch tool

`orchestrator_dispatch` is available only to the main Session. Its input is a message reference (default: the message that triggered the current turn), a title, optionally a Ticket id to attach to, and, for a message with several requests, `items` with one title, scope and acknowledgement each. It:

1. verifies the message was written by the local user in this conversation;
2. builds one Trigger per item the dispatch configuration takes from the message (or one Trigger for the whole message), receiving every Trigger before deciding any;
3. calls `Engine.receive` for each, which stores it and schedules Eval, then records the accept (or attach) for each as a direct Eval;
4. returns every Trigger id and Ticket card it started or joined.

It does not accept work itself, does not decide scope, and cannot dispatch a message authored by the agent or a different person. A refused dispatch leaves the conversation unchanged and reports why.

#### One message, several tickets

The `dispatch` settings block decides how a person's message becomes work:

| `mode` | What it does |
| --- | --- |
| `single` (default) | One new Ticket at most, as before. Several items the main Session supplied are combined into one scope; an item naming an existing ticket still attaches. |
| `explicit` | Splits only an explicit list in the message: numbered or bulleted lines, a confirmation line, or a launching/confirming phrase with an inline list such as `开 A、B、C` or `确认：A、B`. Parsing is deterministic and conservative. |
| `auto` | Uses the `items` the main Session read; a single item is merged with a longer explicit list, and with no items the parser runs alone, then one Ticket. |

`maxTickets` (1–10, default 5) bounds the new tickets a split starts; attach items do not count against it. A message that is not an unambiguous explicit list, a message that reads as a question, an item with neither a title nor a scope, or a list of new items wider than `maxTickets` is not split: it becomes one Ticket that keeps the whole message or every item the Session read. A failed item never discards the other items; it is reported in the tool result and the tickets that did start remain.

Every item is its own Trigger with the same `meta.messageId` and `meta.sourceMessageId`, an `intent` of its index and count, and the item text. The source message therefore keeps an auditable link to each Ticket it started: a started Ticket's origin is its item Trigger, and the trigger card and ticket resource expose `source_message_id` and `intent`. The Trigger id derives from the message id and the item's title, scope and attach target, so re-dispatching the same message and plan is idempotent; re-dispatching a different plan after the message already reached a ticket is refused, so the existing ticket is not changed; send a new message or attach the new request.

An item with `ticket_id` attaches its Trigger to that existing Ticket instead of starting new work, so one message can both add to an existing ticket and start others. Deduplication is per intent within a plan: identical title, scope and target merge, and an item naming an existing ticket defaults to attach through `ticket_id`.

The dispatch mode is not part of the Policy version and grants nothing: it only chooses how an explicit local request becomes Tickets. Dispatching more than one ticket is conservative: a disabled Source refuses every item, a message that already reached a ticket is refused before anything is received, and an unknown attach target refuses that item alone while the other items proceed.

### 4.3 Task threads and chat

One conversation hosts many tasks. A task is a thread: the request message is its root, replies under it belong to it. This keeps "status of task A" away from task B and lets a Ticket's Channel address one thread instead of the whole conversation.

Chat stays chat: a message with no dispatch is visible to the main Session only. The main agent answers it, and nothing is stored as a Trigger. The product must make the difference visible (an explicit Dispatch action; the agent's acknowledgement names the Ticket), because "I said something and nothing happened" is the failure mode of an implicit model.

### 4.4 Multi-source tasks

The existing aggregate already holds several Threads and Channels. Two additions make multi-source work first class:

- **Bind a Channel when the task starts using another Source.** A Ticket gets the Channels of the Triggers it was accepted with; `Engine.bindChannel(ticketId, channel)` adds another and subscribes the Ticket to that Channel's Thread so later events reach it, without making the Thread a state point (`bindThread` does that). `orchestrator_ticket_bind` does the same from a `trigger_id`, so a task started in conversation can report into the GitHub PR it opens or the Feishu chat it was discussed in. Constraints: the Channel's Source must be enabled and its address allowed, checked by the caller; the Ticket must be live. The operation is recorded as a `binding` Input for audit, not delivered as work. Claiming a pull request follows the PR and adds its Channel automatically.
- **Treat external anchors as state points.** A PR, an Issue, a document and a chat thread are Threads with a lifecycle. `bindThread(..., own)` plus `threadClosed` already ends a Ticket when its own PR merges; the Ticket page surfaces each anchor's source facts, whether the Ticket opened it or follows it, its close, and its last event, and the main agent reads them for status answers.

Source events then advance a task without a new decision: a person's message on a subscribed Thread reaches the Executor, and a Thread close is a state change. Neither grants authority; the Mandate still limits scope.

### 4.5 Implementation notes found while planning

- **No configuration fields.** The conversation Source has nothing to configure, so the manifest schema must allow `fields: []` for built-in Sources; the current schema requires at least one field. This is part of T1-13.
- **Delivery is a host capability.** A Source Channel's `send` currently receives only `commands`; the conversation Channel must deliver into a DSH Session. T1-13 adds a `conversation` capability to `SourceContext` (or implements the Channel in the runtime) so the Source definition never imports DSH agent types and the web bundle stays clean.
- **Deterministic acceptance is still an Eval.** The dispatch tool calls `Engine.receive` and then records a Decision with `Engine.decide` (a direct Eval) carrying the title, scope and acknowledgement. That is the existing explicit path the main Session already uses for candidates, so no Ticket is created outside Eval and the Mandate still records the policy version and the local actor.

### 4.5 Authorization and audit

- The local user is the actor on every conversation Trigger. The conversation Source's admission is fixed (the signed-in local user, explicit, basis `local`); the Policy table does not let a team admit other people through it.
- A conversation Mandate records the same facts as any Mandate: Policy version, scope, strength, rule matches, the actor's identity on this Source and how the Source received the Trigger.
- The agent's outbound identity on GitHub or Feishu is its bot identity, not the person's. Replies to the conversation use the conversation Channel.
- Every dispatch, attach, bind and stop is an Input on the Ticket or a Decision with its Trigger id, so audit answers "who asked for this" without a new log.

## 5. Flows

**Assign.** "Fix the flaky test in acme/widgets." → main agent calls `orchestrator_dispatch` → conversation Trigger → Eval accepts (explicit, local user) → Ticket with the conversation Channel → Executor works, opens a PR, `bindThread` and `bindChannel` (GitHub) → reports go to the conversation; the PR's events also reach the Ticket.

**Chat.** "Thanks, and what does the policy say about bots?" → no dispatch; the main agent answers. No Trigger, no candidate.

**Status.** "How is the flaky test going?" in the task thread → the message is attached to that Ticket → the Executor answers in the thread, or the main agent answers from the ticket snapshot if the Executor is idle.

**State change.** The PR merges → `threadClosed(own)` ends the Ticket → the panel and the conversation show the state, and the main agent can summarize it. A person's later message on the task thread resumes the Ticket under the same Mandate unless a person stopped it.

**Stop.** "Stop the flaky test work." → the main agent routes the message as a stop with its Trigger id, as it does for a Source stop today.

## 6. Product changes

| Area | Change |
| --- | --- |
| Conversation | Task threads (root request + replies), a task card per accepted Ticket, a visible Dispatch action and acknowledgement |
| Main agent prompt | From "only routes" to "dispatches, coordinates and answers"; explicit rules for when not to dispatch (chat, status, duplicates) |
| Panel | A task view grouped by conversation, with the Sources a task touches, each anchor's state and the last event; a link from every Ticket to its conversation thread |
| Sources settings | The conversation Source is shown as built-in and not configurable beyond enabling it |
| Notifications | The conversation is a Channel: reports, questions and terminal notices land in the task thread, not only in the ticket's external Source |
| Metrics | Dispatch-to-accept latency, tasks per conversation, dispatch refusals, status answers, Source events per task |

Product decisions to make explicitly:

1. **Thread shape.** Per-task thread (recommended) versus one Thread per conversation. The former gives clean fan-out and status routing; the latter is simpler to render but mixes tasks.
2. **Auto-accept.** Deterministic acceptance for the local user (recommended, still recorded) versus a model Eval on every dispatch. Auto-accept removes latency but must stay auditable and must not bypass dedupe.
3. **Direct outbound.** Whether the main agent may post to an external Source on the person's behalf outside a Ticket. Recommendation: no; a Ticket and its Channel own outbound work, so authorization and idempotence stay in one place.
4. **Multi-user.** DSH sessions are local today. If a team shares a conversation, it is no longer a trusted local Source and needs the ordinary Source policy (roster, admission) or a real external Source.

## 7. Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Let the main Session create Tickets directly | Breaks "only Eval creates a Ticket"; duplicates, Mandate and audit would need a second path that diverges |
| Treat every chat message as a Trigger | Every message would be assessed; chat and status become candidates and noise |
| A new `Task` entity beside Ticket | Ticket already holds Channels, Subscriptions, Assignments and Inputs; a parallel aggregate would duplicate state and end conditions |
| Map the local user onto GitHub/Feishu identities | 001 rejects cross-Source identity mapping; the agent's bot identity is the outbound actor |
| A configurable `conversation` plugin | Identity and channel delivery are security-relevant; the built-in Source keeps them out of team configuration |

## 8. Rollout

| Phase | Work | Exit |
| --- | --- | --- |
| 0 | Decide §6.1–§6.4; define the local principal and its audit id | Decisions recorded |
| 1 | `conversation` Source, `orchestrator_dispatch`, deterministic Eval path, Channel delivery | Assign from chat creates one Ticket; repeated calls create none; chat creates none |
| 2 | Task threads, status answers, task card in the conversation, panel task view | The person can assign, ask and stop without leaving the conversation |
| 3 | `bindChannel`, multi-source state points, anchor view on the task card | A conversation task reports into GitHub and is advanced by its PR events |
| 4 | Hardening: replay, duplicate dispatch, prompt-injection review, privacy of transcripts | Audit and failure cases covered by tests |

Phases 1–3 are implemented as T1-13…T1-17; phase 4 remains.

## 9. Risks

- **Implicit work.** If dispatch is inferred from chat, small talk becomes Tickets. Keep dispatch explicit and observable.
- **Duplicate origin.** A conversation request that duplicates an existing Source request must be caught by Eval or by the main agent's ticket list; the conversation Source does not dedupe across Sources.
- **Transcript exposure.** `threadContext` reads the session transcript; the panel and logs must respect the same redaction as other resources.
- **Channel accumulation.** Binding every Source a task touches can leak reports to unintended chats; `bindChannel` needs the same `allowed` check a normal send uses.
- **Prompt injection in conversation.** Local chat is trusted for identity, not for instructions that override policy; the same untrusted-data rules as `meta` and `text` apply.

## 10. Decisions

| # | Decision | Consequence for the implementation |
| --- | --- | --- |
| 1 | **Task-scoped Threads.** The dispatched request is the root; replies under it belong to that task. | The conversation Channel address carries the task root. `threadContext` reads one task thread, not the whole session, so status questions and follow-ups cannot fan out to another task. |
| 2 | **Deterministic acceptance, with Eval retained.** A dispatched request is accepted without a model call because the local user is explicit by definition, but the Trigger still goes through `Engine.receive`/Eval and the Decision and Mandate are recorded. Later a fast classifier (such as jev) can pre-judge whether a raw conversation message is a task before dispatch. | The dispatch tool stays the only entry. Eval needs a trusted path for the conversation Source that accepts deterministically without skipping the records; the future classifier is an optional pre-filter, not a replacement for Eval. |
| 3 | **No direct outbound from the main agent.** It cannot send to GitHub, Feishu or any other Source outside a Ticket and its Channels. | Multi-source reporting needs the `bindChannel` operation (§4.4), not a main-agent send tool. Outbound authorization and idempotence stay in the Channel. |
| 4 | **Single-user first.** Multi-user conversations are out of scope; if added later they resemble a group chat and need roster/admission like Feishu. | The conversation Source is `trusted`: the gate admits its authenticated local user with the `local` basis and no roster. Multi-user would need its own Source policy, not a silent widening of this one. |

The attach rule is unchanged: a status message is attached to a Ticket only when the main agent can name that Ticket (an explicit id, a quoted ticket title or acknowledgement, or a single unambiguous match). It never guesses between two live tasks.

The panel lists the conversation Source in its own section; it does not appear under **Eval → On each Source**, because it has no team-editable admission rows.
