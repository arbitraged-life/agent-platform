# Handoff contract v2

This contract applies to the configured local launcher. Host-supported delegated
tasks use the host's task schema and authorization flow; do not fabricate a local
launcher approval reference or translate a host task into this packet by default.

Task packets are JSON. Unknown top-level fields and legacy schema v1 are rejected.

| Field | Meaning |
|---|---|
| schema_version | Integer 2 |
| task_id | Unique lowercase letters, digits, underscore/hyphen; at most 80 characters |
| project | Originating project/agent, not the execution surface |
| objective | Remaining bounded work, including already resolved decisions |
| workspace | Absolute real repository/worktree root |
| profile | A name from the installed private policy |
| actions | read, edit, test; must be a subset of profile actions |
| source_write_authorized | True only when the user actually authorized changes or running source tests |
| delegation_reason | missing-capability, execution-lifecycle, local-harness, explicit-user-choice |
| delegation_detail | Concrete reason direct execution is insufficient or inferior |
| acceptance_criteria | Nonempty unique strings, each requiring evidence |
| references | Relevant source/artifact references; no credentials |
| review_context | Required typed `{"schema_version":1,"kind":"general"}` or `kind:"pr-review"` with repository, PR number, exact head SHA, and independent acceptance evidence; see below |
| parent_run_id | Optional originating observability ID |

Tests run repository code and may write caches or perform other side effects;
`test` is not equivalent to read-only inspection. Scope and inspect the test path.

The private Beads launcher takes `--review-context FILE` separately and binds
it into the prepared packet after checking claim readiness; do not include
`review_context` in an input packet submitted to that launcher. Direct canonical
launcher packets must include it themselves. This declares the task kind; the
router cannot infer PR-review intent from objective text or govern executors
outside this boundary.

For declared PR-review work, preparation requires the Q-first snapshot to cover
the exact PR head and independent acceptance evidence for every active finding
and nonempty review body. A missing, truncated, stale or changed snapshot denies
dispatch. The snapshot and bundled helper bytes join the prepared approval and
are rechecked before launch; passive skill text alone grants no dispatch.

The supervisor generates packet.json, HANDOFF.md, status.json, events.jsonl,
stdout.jsonl, stderr.log, and agent-final.txt where applicable. Local raw logs are
private (0600) and are not automatically exported to analytics. Review/redact
before sharing. Do not place runtime state in a public repository.

Preparation does not launch a model. A launch requires the prepared approval
hash and an actual user approval reference. The packet, rendered handoff, policy,
Q-first snapshot when applicable, tracked/untracked/ignored workspace bytes,
tracked symlink scope, and 24-hour preparation expiry are checked before launch.
Submodule worktrees remain unsupported; unreadable or oversized files and more
than 512 untracked/ignored files block preparation rather than weakening drift
checks. The ignored private router state is excluded from the fingerprint;
writable profiles must keep it outside the
writable worktree. A live concurrent filesystem mutation is not prevented by
these snapshots. Any material change requires a new task ID/preparation/approval.
One workspace run is allowed at a time. A stale heartbeat or lock requires
inspection, not an automatic restart or lock deletion.

The supported automatic adapter is Codex, with ChatGPT subscription login, explicit
read-only or workspace-write sandbox, no inherited user config, no API-key env,
no automatic approval escalation, and no task network access in workspace-write.
A write profile additionally requires an edit/test action, explicit source write
authorization, a linked worktree on a non-protected branch, and a private
`protected_branches` policy list matching the project's branch rules. Read-only
packets cannot use a writable profile.
Claude/OpenCode/other profiles may be handoff-only until a safe adapter is verified.
No general shell command or arbitrary extra argv is accepted from the task packet.
No push, commit, deployment, dependency installation, or recursive delegation is
part of the configured profiles. Model-provider requests still use subscription allowance;
there is no verified hard dollar/token cap. Runtime/output/concurrency are bounded
(the private profile may lower output using `max_output_bytes`). On Unix, the
supervisor terminates remaining processes in its owned group before unlocking;
if termination cannot be confirmed, it retains the lock for inspection.

Verification JSON:

```json
{
  "verifier": "chatgpt-controller",
  "summary": "Checks actually performed and their result.",
  "criteria": [{"criterion": "Exact criterion from packet", "passed": true,
                "evidence": "Observed command, exit code, or inspected state"}],
  "artifacts": ["/absolute/path/to/inspected/result"]
}
```

Verification requires all approved packet criteria and at least one in-scope
artifact inside the run directory or task workspace (at most 20 files, each at most 10 MiB); hashes identify the inspected bytes. Tampered packet criteria are
rejected at acceptance. It records controller attestation, not proof that an
independent party verified it. Keep failed/unverified work explicitly open.

Executable bytes are checked immediately before path-based launch. Installation updates must be coordinated with runs: this is not an atomic executable-handle guarantee against a concurrent local filesystem writer.
