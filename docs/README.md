# Documentation map

`docs/` holds four layers. Start with the numbered set, then the design and
evolution set, then the plan set when you are picking up work.

| Layer | Where | What it answers |
| --- | --- | --- |
| Numbered mechanism and operations | `docs/000`–`docs/010` | How the system works, how it is authorized, operated and extended. |
| Design and evolution | `docs/011`–`docs/025` | Why it has this shape, the product/organization principles above the mechanism, the workspace model they imply, the end-to-end evidence path, the Goal read model those principles expose, the reusable profile layer over the worker role, the task-first interface proposal, the first and second implemented UX slices, and the git repository integration research. |
| Plans | [`plan/`](plan/README.md) | What to build, in what order, and the current status of every task. |
| Runbooks and evidence | [`runbooks/`](runbooks/why-not-sent.md), [`images/`](images/), [`prototypes/`](prototypes/ux-redesign.html) | What to do when something is stuck; the before/after captures and the clickable prototype the documents cite. |

## Numbered documents

Read 000–010 in order; each builds only on the ones before it.

| # | Document | Role |
| --- | --- | --- |
| 000 | [Philosophy](000-philosophy.md) | The attention rule and what the agent may and may not do. |
| 001 | [Domain model](001-domain.md) | Sources, Triggers, Threads, Evals, Mandates, Tickets, Assignments, Deliverables and Subscriptions. |
| 002 | [Authorization](002-authorization.md) | The gate, the admission table, Mandates, action levels and approvals. |
| 003 | [Execution](003-execution.md) | Ticket stages, the Executor, concurrency, failure, delivery and recovery. |
| 004 | [Prompts](004-prompts.md) | What the agents read, what a team can edit, and which rules code enforces. |
| 005 | [Panel](005-panel.md) | The three questions the panel answers and the tabs that answer them. |
| 006 | [Deployment](006-deployment.md) | Manual setup, accounts, configuration, upgrades and troubleshooting. |
| 007 | [Architecture](007-architecture.md) | The classes, modules, tests and tables of the implementation. |
| 008 | [Cookbook](008-cookbook.md) | The full recipe for adding a Source. |
| 009 | [Conversation tasks](009-conversation-tasks.md) | Assigning work by talking to the agent, and multi-source tasks. |
| 010 | [Adding a Source in 30 minutes](010-adding-a-source.md) | The fast path from an empty checkout to a registered, panel-visible Source. |

## Design and evolution

These fifteen are written in Chinese. 011 and 012 are a cross-referencing pair:
read 011 for the principles and their cross-check against the existing
documents, then 012 for the evolution story. 013 applies them to the workspace
model (space as an execution reference, orthogonal to the task tree). 014
records the golden-path E2E and the boundary of its fake host; 015 defines the
Goal read model that gives E0 a stable answer to the four questions without
adding a second authorization aggregate. 016 designs the reusable profile
layer over the worker role, keeping authorization in Policy/Eval. 017 defines
the derived context group (shared space) dimension, which adds no membership
table and no authorization. 018 turns the same principles into the E0–E3
exposure levels and the default-surface inventory T5-02 implements. 019
connects the six dimensions into the per-Assignment assembler: presence first,
constraint before scope, fail closed, and a read-only snapshot without text.
020 closes the loop above them: an offline observer reads sanitized telemetry,
a proposal carries its evidence and pre-registered holdout gate, and only a
person can apply it. 021 applies 018's exposure levels to the whole default
surface as a task-first proposal: a main Agent entry, a task view that replaces
the workspace, a task hierarchy with owners, sessions, deliverables, blockers
and reports, a right-side notification overlay plus drawer, and a four-item
main menu with operations moved into settings; its before/after captures,
extension-point annotations and clickable prototype ship with it. 022 audits
those host-dependent gaps against the shipped DSH `0.2.1-rc.5` plugin slots and
turns the remaining ones into per-item upstream requests, separating what
plugins can already do from what needs an additive seat or a whole-region
replacement.

| # | Document | Role |
| --- | --- | --- |
| 011 | [Design principles](011-design-principles.zh.md) | Attention as the budget, internalized organization, independent evolution, composable context and replaceable boundaries; each principle has a status and landing checkpoints. |
| 012 | [Platform evolution](012-platform-evolution.zh.md) | The problem definition, target architecture, domain model v2, mechanisms and migration path that the principles sit above. |
| 013 | [Workspace model](013-workspace-model.zh.md) | `Execution.directory` as the single space locator, write lease, lifecycle, decision rules, read-only UI exposure and phased migration for the workspace (proposal, not implemented). |
| 014 | [E2E golden path](014-e2e-golden-path.zh.md) | The one end-to-end path from a GitHub Issue to accepted, merged work: what it asserts, its local fake-host boundary, and its no-retry stability rules. |
| 015 | [Goal projection](015-goal-projection.zh.md) | One Ticket's read-only Goal (statement, source, state, decision, results, acceptance) shared by the main Session's result card and the task row; no schema, no authorization, no second aggregate. |
| 016 | [AgentProfile](016-agent-profile.zh.md) | Reusable, versioned execution profiles for the worker role, with authorization kept in Policy, Eval and the action gate; current-state evidence, evolution loop, risks and phased landing (proposal, not implemented). |
| 017 | [Context groups](017-context-groups.zh.md) | The optional group dimension derived from Channel addresses and live Thread subscriptions: read-only context and display, no membership table, no member list, no authorization. |
| 018 | [Exposure levels](018-exposure-levels.zh.md) | The E0–E3 display levels and the element-by-element default-surface inventory: attention cost, deeper entry and rollback for each surface, plus the T5-02 walkthrough evidence. |
| 019 | [Context assembly](019-context-assembly.zh.md) | The per-Assignment six-layer assembler: presence first, constraint before scope, conflict escalation, the read-only snapshot and `context` trace stage, fail-closed behavior, and child-ticket inheritance and flattening rules. |
| 020 | [Evolution loop](020-evolution-loop.zh.md) | The offline observe→summarize→propose→verify loop: sanitized samples, effective-hash and task-family aggregation, confidence downgrades, versioned proposals, the pre-registered holdout/MDE gate, the document-only approval queue, human apply and rollback; no write path. |
| 021 | [Interface redesign](021-ux-redesign.zh.md) | The revised task-first Superagent interface proposal: the main Agent as the first entry, the workspace replaced by a task view, the goal → task → subtask hierarchy with owners, sessions, deliverables, blockers and reports, a right-side notification overlay plus drawer, and a four-item main menu with operations in settings; includes the plugin-extension mapping (including what needs host work), phased rollout, before/after captures and a clickable prototype (proposal, not implemented). |
| 022 | [Harness extension requests](022-harness-extension-requests.zh.md) | The upstream request set behind 021's host-dependent gaps: a sidebar top seat and nav overrides, session-row presentation and archiving, a workspace-list seat, settings groups and icons, notification badges, and session-row trailing metadata; per item it gives the shipped capability, the gap, an interface sketch, MVP and later stages, host impact, rollback, priority and a no-host-change fallback, with DSH `0.2.1-rc.5` evidence (proposal, not implemented). |
| 023 | [UX first batch](023-ux-first-batch.zh.md) | The implemented task hierarchy, notification drawer/overlay, folded error aggregation, default-surface terminology and rollback flags. |
| 024 | [UX second batch](024-ux-second-batch.zh.md) | The second implemented UX slice: operations pages consolidated into grouped Settings pages with icons, descriptions and deep links; a task detail centred on the person's decision, result, next step with honest timing, human owner and per-child report folds; first-use notes and empty-state entries; three rollback flags and same-viewport before/after evidence. |
| 025 | [Git repository integration](025-git-repository-integration.zh.md) | The git-integration research: the current `Execution.directory`/`space_lease`/prepare/PR practice, the commit-right/concurrency/recycling/audit gaps, a nine-dimension comparison of per-ticket worktrees, a built-in bare repo, remote-only delivery and host-workspace nesting, the recommended A+C split, plugin-versus-host boundaries, risks and a PoC/metrics plan (research, not implemented). |

011 is the product and organization layer; 012 is the platform mechanism and
evolution layer; 013 is the execution-location design that applies both; 014
is the golden-path E2E; 015 is the E0 read model that follows from 011's
attention principle; 017 provides the group dimension; 018 is the display-level
checklist T5-02 lands; 019 assembles the six dimensions per Assignment; 020 is the offline evolution loop that consumes their telemetry and never applies its own proposals; 021 applies 018's levels to the default surface and the revised task-first interface (proposal); 022 audits 021's host-dependent gaps and sorts them into existing capability, additive seat and whole-region replacement; 023 implements the proposal's first task-hierarchy, notification and error-aggregation slice with rollback flags; 024 consolidates the operations pages into Settings and deepens the task detail, first-use and empty-state surfaces; 025 compares four ways to put source outputs under git and recommends an execution/authority split with a PoC plan, without implementing it. 011 §6
cross-checks the existing documents; conflicts are resolved in 011 §7.

## Plans

[`plan/`](plan/README.md) holds the milestone plan, its dated kickoff and
session-entry notes, and the single task tracking table. Current per-task
status lives only in [`plan/TRACKING.zh.md`](plan/TRACKING.zh.md); the root
README's milestone table and a plan document's dated progress section are
summaries, not a second status source.

## Other references

- [Architecture tour](../ARCHITECTURE-TOUR.zh.md): a guided read of the current
  implementation (Chinese).
- [Plugin packaging](../PLUGIN-PACKAGING.zh.md): installing the project as an
  independent DSH plugin (Chinese).
- [`runbooks/`](runbooks/why-not-sent.md): stopping and tracing a stuck send, and
  [replacing an execution boundary](runbooks/replacement.drill.md) with the T5-06 drill evidence.
- [`images/`](images/): the before/after captures cited by the numbered
  documents and the task view.
- [`prototypes/`](prototypes/ux-redesign.html): the single-file, dependency-free
  interface prototype (Chinese; open it directly in a browser).
