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
