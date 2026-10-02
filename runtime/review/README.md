# Structured review engine

This engine reviews pull-request diffs. Review remediation remains a separate
consumer of review findings: it edits code using its own bounded verifier contract.

Validate a consumer-owned policy without network access:

```sh
python3 -I scripts/review/review.py validate --config examples/review-policy.json
```

Policy schema version 1 has required `repository`, `publisher` and `providers`
fields. `publisher` and each optional `peer_reviewers` entry contain an immutable
GitHub numeric `id` and exact `login`. Provider entries contain `name`, `endpoint`,
`model`, `credential_envs` and `max_chars`. Only explicitly listed credential
references can activate a provider; endpoint/account policy belongs to the caller.
Endpoints are HTTPS without userinfo, query or fragment. Providers implement the
OpenAI-compatible chat completions shape and return a structured findings object.

`runtime/review/policy.py` is the executable configuration schema. It rejects
unknown fields, unsupported versions, malformed identities and unsafe budgets.
Defaults are 24,000 characters per chunk, eight chunks, 24 calls, 3,000 output
tokens, 3,500 peer-context characters, cross-provider assignment, `/review` commands,
inline findings enabled and publication disabled. Sequential assignment is also
supported. Changes to field meaning require a new schema version; defaults are
materialized by `validate` before execution. Validation errors identify the field;
the CLI emits a generic failure to avoid logging private input.

Resolve an authorized event with `context`, which writes a private snapshot, then
run against a checkout containing both immutable commits using `run`. Both commands
require `--config`, `--event`, `--event-name` and `--snapshot`; `run` also requires
`--checkout`. `REVIEW_GITHUB_TOKEN` authorizes GitHub reads and explicitly enabled
publication. Run trusted platform code with Python isolated mode, never code from
the reviewed checkout. The engine invokes Git only to read a diff, with external
diff and text-conversion drivers disabled. It does not install or execute PR code.

Provider fallback rotates explicitly configured credentials with a global call
budget. Each request has a socket timeout and a 1 MiB response ceiling, rejects
redirects and suppresses raw upstream errors. The surrounding job must also impose
a wall-clock timeout. Model messages, responses and raw diffs are not logged or
persisted by the CLI. Peer comments are selected by exact bot identity and treated
as untrusted context. Provider output is validated before publication.

Complete files are packed without truncation. Binary, metadata-only, oversized
and over-budget files appear in coverage omissions. Quoted or control-character
Git paths currently fail validation rather than receive an ambiguous line anchor.
All provider failures and incomplete JSON result in explicit unavailable coverage.
A partial review exits 2; validation, transport or execution failure exits 1.
Only complete coverage exits 0. Zero findings never means automatic approval.
Deterministic synthesis retains distinct evidence and the strongest duplicate
severity; it cannot discard findings through a prose reduction call.

Publication first verifies the authenticated GraphQL viewer against the configured
publisher ID and login. Summary updates require exact bot ownership plus the marker. Publication checks
both head and base immediately before each write; a changed PR is refused. GitHub
comment writes have no atomic expected-head precondition, so a race after that
check remains possible: every summary identifies the reviewed SHA and inline
reviews attach to that exact commit. Same-head inline reviews are idempotent;
workflow concurrency must serialize runs for the same PR. Older review comments
and approvals are never deleted or dismissed. Raw provider transcripts, automatic
approvals, severity-label mutation and webhook fan-out are intentionally absent.
Private adapters own any separately authorized notifications or provider routing.
