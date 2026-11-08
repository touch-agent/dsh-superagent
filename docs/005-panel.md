# 005 Panel

Open **Superagent** in the DeepSeek Harness Web sidebar to supervise the agent. The panel prioritizes work that needs a person, then system health and history. This document builds on [000 Philosophy](000-philosophy.md) through [004 Prompts](004-prompts.md).

## Three questions

Opening the panel answers three questions, in this order:

1. Does anything need me now?
2. Is the system healthy and doing the right things?
3. What is the history of one piece of work, from Trigger through Eval to Ticket?

## Tabs

The tabs follow the workflow: **Overview**, **Tasks** (任务), **Source**, **Trigger**, **Eval**, **Execution**, and **Settings**. Until repository and account setup succeeds, Overview shows what is missing and links to the relevant setting.

| Tab | Shows |
| --- | --- |
| Overview | Approvals waiting for a person, Tickets needing action, system problems, activity counts and health figures for the last 24 hours, and Executor load. Each block links to its detailed page |
| Tasks | The task tree: milestones and plan tasks above the Tickets, reviews and pull requests they contain, with state, child completion and elapsed time, plus an optional graph of parallel branches and their merge points |
| Source | Source state, setup problems and non-zero counts. Filtered Triggers and dropped messages cover the same 24-hour window as Overview |
| Trigger | Threads filtered by Subscribed, Evaluating, New Triggers in 24 h, or All Threads. Each Thread shows its Triggers newest first, Decisions and Subscriptions |
| Eval | Decisions with their reason and matched rules |
| Execution | Executor state, Pause processing, and Tickets filtered by Open, Pending, Working, Waiting for a Trigger or Ended. Ticket details show actions, the review preview, authorization, waiting Inputs, Subscriptions and Assignments |
| Settings | Sources, Eval, Execution, Prompts and Deployment. Each group includes its save history |

### Tasks

The Tasks tab answers what the work is made of and how far it has got. It folds Tickets into the plan the titles and Mandate scopes already name — a milestone (`M2`), a task (`T2-03`) and the Tickets under it — and puts each Ticket's reviews and pull requests below the Ticket. A review joins the Ticket whose pull request it reviews; a pull request hangs under the Ticket whose report published it. Tickets no plan names still appear, under **Unplanned**, rather than disappearing; a tree that hid unplanned work would lie by omission. Ownership is derived when the board is read (`packages/dsh/src/app/ownership.ts`), from the title first and the Mandate scope second, so no Ticket, Thread or database row gains a new field and older records read as before.

Every row shows a state dot and label, a progress ratio over the work below it, and the elapsed time from the first start to the latest end (or to now while work is live). Milestones and tasks can be folded, and **Expand all**/**Collapse all** move the whole tree at once. A failure colours its container; a review or blocked Ticket colours it amber in the tree. The optional **Graph** view draws one lane per top-level Ticket that ran, branching from the milestone trunk at its start and merging back where it ended, and reuses a lane once its earlier branch has ended; a live branch ends in an open circle instead of a merge point, a failed lane is solid error red, and a blocked lane is dashed red. Both views read the same `GET tasks` projection, so a node cannot show one state in the tree and another in the graph.

| Before (main `59b912c`) | After (this change) |
| --- | --- |
| ![Tickets listed one by one under Execution](images/tasks-board/before-execution.png) | ![The same Tickets folded into the task tree](images/tasks-board/after-tree.png) |
| — | ![The graph view of the same milestones](images/tasks-board/after-graph.png) |

Same 1440×900 viewport, light theme, collapsed left sidebar and one sanitized demo state: synthetic Tickets carrying `（T2-0x）` plan tags and descriptions such as `事件栏按任务分组`, synthetic pull request labels and no work content. Both captures read the same state database, unchanged between the runs. Before is `59b912c`, where the only way to see these Tickets was the flat Execution list and there was no Tasks tab; after is this branch, with the Tasks tab open and the same Tickets folded by milestone and plan task. The graph row is the same after capture with **图** selected.

### Approvals

An Action can wait for a person before it runs. Overview opens with **Waiting for my approval** when any Approval is still decidable: one row per request, in the order requested, showing its Ticket, Action, object and revision, the consequence of the requested level, and when it expires. **Approve** records consent at the requested level; choosing a lower level records only that smaller grant for the caller that runs the Action, and the consequence follows the chosen level. **Deny** records a refusal after a confirmation. The panel records itself as the decider, and the wait from request to decision feeds the approval figure below. The section takes no space when the queue is empty; a request past its expiry is neither shown nor returned as pending, and its wait counts as an expiry. The runtime's action producer fills this queue from outbound messages to external Channels: such a message waits as a pending receipt with no delivery attempt until its Approval is granted, and a recalled message revokes its still-requested Approval. An Approval the Policy auto-approved under its internal-domain whitelist is already `approved`; it never enters this queue and is left out of the human approval wait, though its record stays readable.

| Before (main `37eaff3`) | After (this change) |
| --- | --- |
| ![Overview before the approval queue](images/approval-panel/before-overview.png) | ![Overview with the approval queue and latency figure](images/approval-panel/after-overview.png) |

Same 1440×1000 viewport and light theme, cropped to the management panel, with a synthetic local Store holding two requested Approvals and one earlier decision. Before is the merge of #8, which has no approval section; after is this branch, which adds the queue and the fifth health figure.

### Reading individual records

A dropped message links to its Ticket, or to its Thread when it has no Ticket. The Source page explains whether its conversation disappeared or the Source stopped listening to it.

A human follow-up still owned by an Executor is marked **Delivered to Ticket**, without an Eval. The Thread also shows hand-back reasons and context-only Subscriptions. **Evaluate again** can send that follow-up to Eval, or retry a Trigger with no effective judgement: one filtered by its Source, an unavailable Eval, or a delivered message with neither a non-stop Decision nor an Executor acknowledgement. **Why**, on every Trigger, opens the stages it went through in the order the Engine ran them, from intake to the first report of the work it became, and stops where the trace stops — the gate's reason when it refused the Trigger, and an explicit "still in flight" before the Decision.

Ticket details show the originating Trigger, Decision and reason, scope and Policy version. Assignments and secondary details are folded below the immediate actions. **Retry** is available for failed Input delivery or a Ticket waiting for a person after a blocked or failed Report. Ended Tickets show outcomes such as **Pull request merged** or **Stopped by a person**.

A Ticket at `person / review` shows its review above the Mandate details: the artifact kind and reference, the revision, the preview kind and a link to the preview, the worker's summary, and the acceptance criteria. **批准 / Approve** accepts that revision and is shown only when the Report carried a preview; the button records the panel as the accepting actor, while the Ticket stays open for its followed pull request. A review-stage Ticket without a preview, or with a preview of another revision, shows **无法审核** and no approval button, and the HTTP route refuses the same request.

| Before (main `a45e643`) | After (this change) |
| --- | --- |
| ![Review-stage Ticket without a preview section](images/review-preview/before-review.png) | ![Review-stage Ticket with its preview and Approve button](images/review-preview/after-review.png) |

Same 1440×1000 viewport and light theme, with the same synthetic review-stage Ticket, pull request Thread and report. Before is the merge of #21, which has no review section; after is this branch, which renders the preview and offers **Approve**.

![The same Ticket when its report has no preview](images/review-preview/after-review-missing.png)

The same Ticket when its latest Report has no Deliverable preview: the review section says **无法审核** and offers no approval.

### Work assigned in the conversation

Talking to the main agent is a work entry, but only an explicit assignment becomes a Ticket. The main agent calls `orchestrator_dispatch` with the person's latest message; the message is recorded as a conversation Trigger and accepted by a direct Eval, so the Ticket keeps its Decision, Mandate and audit. Small talk, a status question and the agent's own notices create nothing.

The conversation Source is built in and has no configuration fields; **Source** shows it as **Built in** with a switch and no health probe. **Execution** gains **All origins / From the conversation**, which narrows the Ticket list to work assigned this way. Such a Ticket carries **From the conversation** in the list and on its page, where **Open conversation** returns to the main Session that started it. A status question or follow-up that names the Ticket is attached to it instead of opening a second one; the Ticket page shows the question among its Inputs.

Subscribed Threads appear as anchors on the Ticket page. Each shows its Source facts and last event; **Opened here** marks a Thread the Ticket created, such as its own PR, **External anchor** one that only has a Channel, and a closed anchor carries its outcome. A bound Channel is also listed among the Ticket's Channels and in its Inputs as a binding.

Only the latest message from the person is dispatched. A message that arrived from the agent, a Source notice or a relay is refused, so an obsolete request cannot be revived later.

### Main-Session surfaces

The main Session is the process's single router Session. Four surfaces make it the entry to the system; the Status tab reuses the management page itself so the two cannot drift apart:

- **New Session → Main Session.** The right side of the New Session composer offers **Main Session** (主会话), which selects the existing `masterId` through the Workspace. It never starts another router Session; using it twice returns to the same Conversation. If the Session catalog is not ready, the control disables itself and reports why. The management panel keeps its own **Open main Session** header button as a fallback.
- **The main Session row** carries a compact **Main** (主) badge in its leading decoration. DSH `0.2.1-rc.5` has no trailing decoration on Session rows, so the badge is leading rather than trailing.
- **Status** (状态) is a tab inside the main Conversation. It mounts the existing management page itself — the same header, search, tabs (Overview, Tasks, Sources, Triggers, Eval, Execution, Settings) and actions as the sidebar panel — rather than a reduced second view. The embedded copy keeps its own page route, so navigating inside 状态 does not move the sidebar panel, and vice versa. Any other Session shows one sentence explaining that the Status page belongs to the main Session.
- **Events** (事件) is a right-pane tab. Its title shows the number of unread `notice`-level events; opening the tab marks the current head seen and persists the cursor in this browser. The tab opens automatically once, when the first unread notice reaches the main Session; later opening and closing stay manual. The tab folds events into one group per task — a Ticket, or the Thread for work no Ticket owns yet. A review Ticket joins the Ticket it reviews, and both carry the plan task their titles name, so the Events groups and the Tasks tree never disagree about ownership. A group header names the task, its origin (the pull request or conversation it was accepted from), its current state and the latest event; unfolding it shows each event with a readable title, a badge for the object it is about (Ticket, Thread, Trigger, Decision or Policy) that opens that object's page, the state the event recorded, how long after the task's start it happened, and when. Filters above the list narrow it to all events, the ones needing a person (awaiting review, awaiting an answer, an undelivered input, blocked or failed), live work (queued, working or waiting for a Trigger), or failures alone. The tab uses the same-origin SSE stream and falls back to five-second cursor polling when the stream is unavailable; a notice whose result was already relayed by a report stays in the feed without counting as unread. Records written before these facts existed are completed from their Ticket, Thread and one-line summary when the feed is read; the `activity` table stores JSON, so no migration is needed.

These surfaces depend on host seats introduced by `0.2.1-rc.5` (`conversation.hero.options`, `conversation.view`, `sidebar.session.row.leading`, `sidebar.right.pane.tab` and its title, and `conversation.session.header.utilities`). Registration runs through `slots.inject`, so a host that does not declare a seat omits that surface and keeps the management panel; nothing throws and no separate business logic or API model is created.

| Surface | Before | After |
| --- | --- | --- |
| Main-Session entry in New Session | ![Before](images/session-entry/before-master-entry.png) | ![After](images/session-entry/after-master-entry.png) |
| Status page (reused management page) in the main Conversation | ![Before](images/session-entry/before-status-view.png) | ![After](images/session-entry/after-status-view.png) |
| Events tab grouped by task, with readable rows and filters | ![Before](images/session-entry/before-events-groups.png) | ![After](images/session-entry/after-events-groups.png) |

Captured on DSH `0.2.1-rc.5`, same 1440×900 viewport and light theme. The entry's Before is the host without this plugin's surface; the Status row's Before is revision `c18d8a6`, where 体系 was a reduced read-only view; the Events row's Before is revision `37eaff3`, with the flat event list. After is this branch in every row. The Events pair uses one sanitized demo state only — Tickets titled 示例 …（demo-*）, synthetic labels, no work content — and both captures read the same state database, unchanged between the runs. Both have the Events tab open and the left sidebar collapsed, so the unread count and session list are not part of the comparison.

### Health figures

Overview ends with five read-only figures, each derived from the Store: the time from a Trigger to the first Decision about it (median and p90), outbound messages that repeated the same words to one conversation for one ticket, how long work stayed stalled after a restart (median), judgements per hour, and how long approvals waited from request to decision (median and p90), counting approvals, denials and expiries but not withdrawals. A figure with no samples reads `—` rather than `0`, so an empty Store never looks healthy. `GET metrics` returns the same figures as JSON.

## Settings groups

- **Sources:** one card per Source with its switch, fields and verified account facts. The card derives its fields, sign-in hint, health entries and polling default from the Source manifest, so adding a Source needs no panel code. GitHub also offers receive-all switches for new Issues, pull requests, comments and default-branch CI. Polling and read limits are under Advanced.

| Before (main `37eaff3`) | After (this change) |
| --- | --- |
| ![Source card before](images/source-manifest/before-sources.png) | ![Source card after](images/source-manifest/after-sources.png) |

Same 1440×900 viewport, light theme and Settings › Sources. The GitHub card before shows only its fields; after it also shows the sign-in, health items and polling default read from the manifest.

- **Eval:** the Policy version and rules, followed by **On each Source** and the Eval settings. Each Source tab contains its allowed list, membership sync, admission table and bot list. Sync runs at startup and on **Sync now**. The admission table distinguishes receiving scope, sender membership and whether the message addresses the agent. Eval settings select the accept mode, timeout and assessment model.
- **Execution:** worker model, concurrency, directory root, prepare command and blocked commands. Clicking an available variable inserts it into the prepare command.
- **Prompts:** **Edit** changes team sections, built-in parts and skills. **Full prompt** shows the assembled text and compares it with saved text or defaults. **History** lists versions. Edited built-in parts are marked changed and can be reset; templates list their required placeholders.

  An upgrade that changes an overridden default marks it **Default updated** (默认内容已更新). The panel compares the old and new defaults above the team's text. If the old default was not recorded, it compares the team's text with the new default instead. Choose **Keep my text** or **Use the new default**. Overrides for removed parts are listed below the tab bar and dropped on the next save.
- **Deployment:** startup problems with **Check again**, the state directory and machine limits. Saved limits apply without restart. The DeepSeek Harness Plugin Manager exposes the same page.

## Search

The header search finds Triggers by text, id, Feishu message id or a stored link, such as a GitHub comment URL. A Feishu link missing from the original message becomes searchable only after the host reads it during the current process lifetime.

Search also finds Threads by references such as `#12` or a GitHub URL, and Tickets by title or a matching Thread.

## Principles

1. **Focus on what matters.** Every element answers one of the three questions, or it is removed. A number appears only when it changes what the supervisor does.
2. **Precise definitions.** Categories have checkable definitions, are mutually exclusive and cover every case, as the Ticket stages do. A label says whom a row waits for and what it needs, not an internal status code.
3. **One place per concept.** Source state belongs in Source; Threads and Triggers in Trigger; Decisions in Eval; Tickets in Execution. Settings are grouped by the concept they configure. Overview summarizes these pages and links to them instead of becoming another detailed view.
4. **Domain structure.** The panel uses the domain terms. Internal identifiers appear only in folded details, and names replace identifiers where they can be resolved.
5. **Honest state.** A count equals the length of the list it links to, and no state contradicts another fact.
6. **Quiet by default.** Healthy states take no extra space. Problems must be actionable; a one-off network error is not enough. Rows needing a person offer their action directly. Keep page explanations to one sentence and put further detail in the (?) tooltip. Destructive actions require confirmation.
7. **Consistent controls.** Use DeepSeek Harness design tokens and control behavior. The same information should look the same throughout the panel. Each settings block has one save bar, visible only while changes exist, a save runs or a save fails.
