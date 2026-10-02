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

Eight Cloudflare skill directories are imported directly from the official
`cloudflare/skills` repository at the immutable commit recorded in
`skills/upstream-lock.json` under Apache-2.0. The selected
358 Markdown files match the established skill inventory; the upstream backup
file is excluded. Reviewed overlays preserve specific-skill routing, repair external and local
documentation references, and replace credential-shaped examples with explicit
placeholders or environment references. `skills/upstream-lock.json` records original and installed SHA-256
digests. Private-network addresses in upstream networking examples are generic
documentation, not deployment configuration.

The separately licensed Turnstile Worker template was clean-imported from
`skills/turnstile-spin/templates/worker/` at source revision
`92a774eae4528022982449d172801e6d891cfde3`. Its Cloudflare MIT license is retained.
Offline tests are now separate from explicit network integration tests; repository
metadata identifies this maintained template, and the package is not published to npm.
The surrounding deployment skill and scripts are not part of this import.
Wrangler and Workers types were upgraded together to exact compatible versions;
the resulting lockfile passed the registry dependency audit with zero findings.
Security normalization rejects missing configured hostnames, prevents non-2xx
upstream data from overriding failure status, and logs custom-data presence only.
Four regression cases cover these inherited defects before publication.


Five repository-maintenance skills were adapted from source revision
`92a774eae4528022982449d172801e6d891cfde3`: the four cleanup/audit/verification
skills under `skills/devops/` and `skills/status-report/`. Their canonical homes
are flat skill directories in the catalog. Normalization removes pre-audit
quarantine moves, broad deletion recipes, fixed local roots and assumed private
validation helpers. Existing authorization, dirty-work preservation, enumerated
removals, independent acceptance and explicit unknown results are preserved.
They carry this repository's original-code license; no private operational
configuration or source history is imported.

The reusable lint workflow was normalized from `.github/workflows/lint-reusable.yml`
at source revision `c1841e237f0d5f4709827f7e940f2eee4033e8dd`. Tracked-file
discovery replaces shell evaluation, tool installations are pinned, downloaded
binaries are checksum-verified, and strict C++ failures propagate. Account-specific
comments and unused language advertising were removed.
