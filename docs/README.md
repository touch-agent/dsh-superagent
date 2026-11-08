# Documentation map

`docs/` holds four layers. Start with the numbered set, then the design and
evolution pair, then the plan set when you are picking up work.

| Layer | Where | What it answers |
| --- | --- | --- |
| Numbered mechanism and operations | `docs/000`–`docs/010` | How the system works, how it is authorized, operated and extended. |
| Design and evolution | `docs/011`–`docs/012` | Why it has this shape, and the product/organization principles above the mechanism. |
| Plans | [`plan/`](plan/README.md) | What to build, in what order, and the current status of every task. |
| Runbooks and evidence | [`runbooks/`](runbooks/why-not-sent.md), [`images/`](images/) | What to do when something is stuck; the before/after captures the documents cite. |

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

These two are a cross-referencing pair, written in Chinese. Read 011 for the
principles, then 012 for the evolution story and the cross-check.

| # | Document | Role |
| --- | --- | --- |
| 011 | [Design principles](011-design-principles.zh.md) | Attention as the budget, internalized organization, independent evolution, composable context and replaceable boundaries; each principle has a status and landing checkpoints. |
| 012 | [Platform evolution](012-platform-evolution.zh.md) | The problem definition, target architecture, domain model v2, mechanisms and migration path that the principles sit above. |

011 is the product and organization layer; 012 is the platform mechanism and
evolution layer. They are cross-checked against each other, and conflicts are
resolved in 011 §7.

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
- [`runbooks/`](runbooks/why-not-sent.md): stopping and tracing a stuck send.
- [`images/`](images/): the before/after captures cited by the numbered
  documents and the task view.