# Review remediation

`scripts/review/remediate.mjs` is the entrypoint. The caller supplies a trusted repository policy and a pinned agent image; this package contains no account or machine configuration.

The controller accepts allowlisted GitHub review events, reserves a signed attempt on the PR, exports its exact head without Git credentials, invokes the existing coding agent in a container, and checks the resulting patch with a separate offline verifier. Publication uses `createCommitOnBranch` with `expectedHeadOid`, never a force push. The agent has no GitHub token and cannot publish or resolve threads.

## Contract

- `inspect`: read-only eligibility and deduplication report.
- `remediate`: at most two reserved attempts per PR across all heads. Timeout, failure, and interrupted reservations consume the budget; no automatic reset.
- `finalize`: no model invocation. Resolve only signed, failing-before/passing-after proof for an unchanged discussion, the exact current head, and successful required checks from the configured GitHub App.
- `route`: turn supported GitHub event payloads into a per-PR Actions matrix. PR issue comments, summaries, billing notices, and unrelated bots are not remediation events.

Verifier exit values inside the JSON report are `0` (passes), `1` (reproduced failure), and `2` (unavailable). The `syntax` check must pass after editing. A finding without a matching trusted regression oracle remains open; existing green tests alone are not proof that a review finding was fixed.

Verifier expressions come only from the trusted runtime policy, never PR feedback. Review them for bounded matching against untrusted paths and comments; the 96 KiB feedback ceiling is not a regular-expression execution timeout.

Runtime policy supplies reviewer IDs and logins, PR author IDs, allowed patch paths, model and inference credential name, independent check mappings, CI check names and App ID, and optional offline generator commands. Directory prefixes end in `/`; other allowed paths match exactly. Protect the controller, policy, verification files, workflows, and credential paths from agent edits.

The caller must serialize all mutations using one concurrency key per repository/PR. The CLI is not a distributed locking service. On GitHub, use one workflow's per-PR concurrency group for review events, manual runs, and CI completion callbacks. Run the controller from trusted revisions, never the PR checkout. A rotated PAT invalidates old proof signatures but does not erase previous attempts by the same controller identity.

Archive symlinks, including outward-pointing links, are preserved as metadata rather than followed. Extraction prepares every parent directory before creating any links, so filesystem case/normalization aliases cannot turn directory creation into traversal through an earlier link. Host snapshots use `lstat`/`readlink`, never target contents. Agent and verifier execution occurs in containers, where links cannot access unmounted host paths. Symlink changes are rejected rather than published. The controller and Docker daemon must share the filesystem used for workspace bind mounts; a remote daemon cannot mount the controller's local temporary directory.

`review-remediation:hold` on a PR pauses both remediation and resolution. Changed heads, human replies, missing/pending/failed checks, unavailable host evidence, and uncertain agent output fail closed. No automatic merge or deployment is implemented.

## Validation

```sh
node --test tests/unit/review-remediation*.test.mjs
```

The tests exercise event identity, fork/author restrictions, durable budgets, signed receipts, pagination, compare-and-swap publication, process timeouts, archive traversal, special-file rejection, credential isolation, and CI-gated resolution. A repository adapter must also test its independent oracles against both failing and fixed fixtures.
