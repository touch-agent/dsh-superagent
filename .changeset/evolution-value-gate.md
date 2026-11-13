---
'@superagent/dsh': minor
'@superagent/kernel': minor
---

Add the Phase 2 value gate above the offline evolution loop's pre-registered
regression gate. `valueGate()`/`valueGateOf()` in `scripts/evolution/core.ts`
classify every gate result into exactly one of `improvement`, `no-difference`,
`guardrail-regression` or `insufficient-evidence`. A proposal is recommended for
adoption only when the exact (unrounded) primary success effect reaches the
pre-registered MDE, its 1−alpha interval lower bound is above zero, the two-sided
p is below the pre-registered alpha, and no available guardrail regressed past
its pre-registered threshold.

The value gate covers success rate, rework, review findings, p90 latency and
cost. Missing measurements stay `unknown` with null values instead of becoming
zero; token cost is a guardrail only when the host reports usage on every run,
and monetary cost is always unknown and never a gate. Phase 1 sample size,
stopping point, alpha, MDE and holdout rules are carried unchanged in
`valueGate.phase1`. There is still no write or apply path: the gate only reads
evidence and returns a document, `applied`/`liveConfigChange` stay false and
`decidedBy` stays null.

`tests/evolution.spec.ts` now covers the four outcomes, unknown cost, cost and
rework guardrail regressions, missing/undersized evidence, unrounded-MDE
refusal and small-sample refusal, and that every Phase 1 rule is preserved.
`docs/020`, `docs/016`, `docs/007`, the documentation indexes and
`docs/plan/TRACKING.zh.md` describe the gate and its limits.