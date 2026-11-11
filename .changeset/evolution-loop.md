---
'@superagent/dsh': minor
'@superagent/kernel': minor
---

Add the offline evolution loop from T5-05 under `scripts/evolution/`. A
read-only exporter turns sanitized Ticket telemetry into a sample set; the pure
analyzer aggregates by `effective.hash` and task family, records structured
diagnoses with sample references, withholds low-confidence or baseline-less
observations, and builds versioned proposals with a limited execution-content
diff, evidence, confidence, scope, guardrails and a rollback pointer. Every
proposal carries a pre-registered holdout manifest, primary metric, MDE,
α/power, required sample size, allocation and stopping rule; only a passing
paired or randomized replay reaches the document-only human approval queue.
There is no Store, profile-registry, network or filesystem write path in the
analyzer, and `applied`/`decidedBy` stay false/null. `tests/evolution.spec.ts`
covers aggregation, downgrade, privacy, forbidden authorization fields, gate
pass/reject/insufficient/no-difference, holdout contamination, rollback and
deterministic CLI replay.