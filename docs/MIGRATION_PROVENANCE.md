# Migration provenance

This repository is a clean import. No private Git history is published.
The private migration ledger retains source-repository identities and detailed
path mappings; this public record identifies reusable source revisions only.

| Source revision | Source paths | Destination | Normalization |
|---|---|---|---|
| 92a774eae4528022982449d172801e6d891cfde3 | lib/execution-router, scripts/execution, tests, skills/execution-router | runtime/execution-router, scripts/execution, evals, tests, skills/execution-router | Explicit runtime ownership; deterministic eval placement; import updates |
| 92a774eae4528022982449d172801e6d891cfde3 | lib/review-remediation, scripts/review, tests/unit/review-remediation* | runtime/review-remediation, scripts/review, tests | Preserve bounded controller behavior and independent verification; import updates |
| de78d095b24c872a571d1f05c974f1fd455add42 | .github/scripts/merge_gate.py and tests; reusable merge/stale workflows | Repository-local .github | Preserve caller interfaces; pin checkout action |

New validation and digest-pinned release tooling are original platform code.
Account-specific configuration and unreviewed components are excluded.


Observability normalization draws on the legacy OMP and OpenCode/Kilo Opik
record builders at source revision `92a774eae4528022982449d172801e6d891cfde3`:
`harness/omp/src/opik-observability.ts`,
`harness/opencode-kilo/opik-records.js`, and
`harness/opencode-kilo/opik-observability.js`.
The shared UUID helper, usage mapping, and trace/span transport were normalized
into `runtime/observability/records.mjs` and `runtime/observability/opik.mjs`. Environment-specific
configuration discovery and raw content/error capture were not imported. Source
lifecycle adapters remain active until separately validated consumer cutover.

The offline coding benchmark was clean-imported from `benchmark/` and
`tests/unit/benchmark.test.mjs` at revision
`92a774eae4528022982449d172801e6d891cfde3` into `evals/benchmark/` and `tests/unit/`.
Normalization removes twelve duplicate shell oracle wrappers, validates task
IDs and checkout containment, bounds child processes, cleans scratch output,
and replaces real-clock rate-limit grading with a simulated clock.
