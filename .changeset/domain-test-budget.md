---
'dsh-superagent': patch
---

Add X-06's executable domain-test budget: `scripts/check-domain-budget.mjs` fixes the kernel test
suite and compares the median of three complete Vitest runs with the 2 s contract from
`docs/012-platform-evolution.zh.md` §10.1, naming the files and slowest tests on failure.
`pnpm check:domain` runs in `pnpm check`, so local and CI use the same gate, and the suite
membership is itself checked. Tests, scripts and documentation only; no runtime code or published
API changes.
