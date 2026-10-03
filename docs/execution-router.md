# Execution Router v1.0.3

A shared decision skill and small, dependency-free local handoff supervisor for a
multi-brain execution mesh. ChatGPT, CLI coding agents, and other local agents can
all be valid reasoning/execution surfaces over the same authoritative repositories
and systems. The router does not replace ChatGPT's platform routing, a coding
harness, or an OS sandbox.

## Execution model

The system that owns the state remains authoritative regardless of which executor
performed the work. Prefer the lowest-overhead authorized surface that is best
suited to complete and verify the task. ChatGPT connectors are often ideal for
app-owned state; coding/local agents can be better for sustained implementation,
repository-native harnesses, local test loops, or resumable execution. Handoff is
a routing choice, not an escalation hierarchy.

### Desktop Commander transport selection

If ChatGPT has multiple Desktop Commander paths to the same machine, the
private/direct path should be selected first when healthy: for example an
OpenAI Secure MCP Tunnel that terminates at the machine's local stdio Desktop
Commander. A vendor-hosted Remote Desktop Commander bridge is a fallback for
surfaces or incidents where the private/direct path is unavailable. Transport
selection does not change state ownership or authorization.

Never blindly retry a failed mutating call over the fallback. Verify whether the
first path changed local state, then continue or retry deliberately. Keep the
hosted bridge installed when it provides useful resilience, but do not spend its
quota for ordinary work while the private/direct path is healthy.

## Ownership

- `skills/execution-router/`: portable workflow and contract.
- `runtime/execution-router/`: policy validation, bounded launch, status, verification.
- `scripts/execution/router.mjs`: command-line entry point.
- Private operational repository: machine profiles, deployment, observability IDs.
- Runtime state: private ignored local directory; never a public source directory.

## Use

Run `node scripts/execution/router.mjs --help`. Supply a private `--policy` JSON
file for doctor/prepare/run/status/cancel/verify. The template is maintained by
your operational repository; the reusable framework contains no personal paths,
account identifiers, credentials, or blanket launch approvals.
For `route --facts FILE`, supplied `authority_blocked`, `native_available`,
and `local_available` values must be JSON booleans; strings such as `"false"`
are rejected instead of being interpreted as available capabilities.
Writable profiles require the private policy to list the repository's protected
branch names under `protected_branches` (for example,
`["main","master","trunk","develop","release"]`); the launcher also always
protects `main` and `master`. Keep that list aligned with actual branch rules:
only linked non-protected worktrees may be writable. Read-only packets cannot
select a workspace-write profile, even when that profile also permits `read`.
Codex profiles must specify a nonempty executable path; manual handoff-only
profiles need not. The policy approval digest covers resolved executable,
workspace roots, and state directory, not just literal policy JSON. Moving
a relative policy path to a different executable invalidates prior approval.
An optional per-profile `max_output_bytes` can lower the default 10 MiB output
ceiling; unsupported/unknown policy settings fail closed.

Profile names are own JSON keys, including `__proto__`; inherited names are
not profiles. The canonical policy digest covers every configured profile.
The router's internal `router_version` is distinct from the operator-managed
`policy_version`. Prepared approval digests bind the internal router version;
approvals prepared by an older router must be prepared and approved again
before launch. Existing returned runs remain available for inspection and
controller verification.

`prepare` never calls a model. `run` requires an approval reference and exact
prepared digest. `doctor` checks CLI flags and subscription authentication but
does not make a model request. `run` is supervised while the launcher process is
alive; it is not a new daemon or scheduler. Cancellation is a request to that
supervisor, not a facility to kill an arbitrary PID.

## Security and reliability boundaries

The launcher rejects scope expansion, unrecognized task fields, path traversal,
realpath escapes (including tracked and ignored symlinks), hard-linked regular
files (which could alias files outside the workspace), stale or modified
packets/policies/workspaces/executables, concurrent runs, API-key-authenticated Codex,
dangerous sandbox modes, and reuse of launched tasks. The executable's resolved
path and content digest are part of the approval and are rechecked after doctor
checks immediately before launch. The workspace approval fingerprint includes
Git HEAD, the raw bytes of the current branch/ref and worktree Git directory
in its digest, index entries, raw bytes and executable bits of tracked files,
plus untracked and ignored file bytes, executable bits, and empty-directory
paths. Git paths that are not valid UTF-8 are rejected rather than ambiguously
decoded; a leading U+FEFF remains part of the filename, not a removable text BOM.
It never runs repository Git hooks, clean filters, or external diff drivers.
Tracked, untracked, and ignored symlinks must resolve inside the workspace to
files whose bytes are independently included in the approval fingerprint; the
link text and resolved target identity of untracked/ignored symlinks are also
fingerprinted. This excludes links into private router state, Git metadata,
and other non-fingerprinted locations, including links through alias directories.
Submodule worktrees are unsupported: preparation refuses them until their
nested inputs can be accounted for. Private router state is excluded from the
fingerprint only when it is ignored by Git and inside the workspace; unignored
state is fingerprinted and its own run records invalidate launch. Writable
profiles require state outside their writable worktree.
For nested in-workspace state, preparation creates its parent directories
before fingerprinting so the first launch does not invalidate its own approval.
Git tracked-file metadata is streamed rather than limited by `execFile`'s
4 MiB output buffer, but the entire index and file contents still require
available memory; reading the
tracked Git metadata must complete within 15 seconds. Tracked-file hashing
starts after that Git process finishes and does not consume its transport deadline.
Repositories with more than 512 untracked/ignored files or empty directories,
more than 100,000 scanned directory entries, tracked/untracked/ignored inputs
over 10 MiB, or unreadable/dangling symlinks cannot be prepared: use a smaller
worktree instead of silently accepting
an incomplete fingerprint. Preparation and launch recheck the fingerprint;
launch repeats the worktree and protected-branch checks under the workspace
lock after doctor and immediately before spawning. Concurrent filesystem
changes after the final check require operational inspection; this is not a
filesystem freeze. Runtime is at most 30 minutes.
Combined stdout, stderr, and final-message output has a 10 MiB ceiling unless
the private profile lowers it. Stdout/stderr trigger termination at the limit;
the final-message file is checked every 100 ms and again after exit, so it can
transiently exceed the ceiling between polls, but an over-limit run is never
returned as successful. No shell interpolation is used for task content.
An unreadable final-message file fails the run; its original read error is retained
even if cancelling the child also reports a signalling error.

Launch sends the already-verified handoff snapshot to the child, even if the
on-disk handoff is modified while executable doctor checks run. Acceptance
holds a per-run exclusive lock through validation and the status transition;
another verifier or stale lock fails closed rather than replacing the first
accepted evidence. A validation error releases its owned lock.

The same operating-system user can edit files and forge approval/evidence records.
This is a guardrail and audit mechanism, not an authentication service. Native
sandboxing is required but does not make the wrapper a complete security boundary:
read access, project configuration, hooks, MCP permissions, and model-provider
traffic are separate concerns. Agent-level instructions forbid commit/push/deploy
and scope expansion; do not describe those prose restrictions as universal OS
access controls. Review a workspace's configuration before authorizing its run.

Verification evidence accepts only verifier, summary, criteria and artifact paths.
The serialized payload is limited to 64 KiB; verifier names to 256 characters,
summaries and criterion diagnostics to 8,192 characters, and paths/criterion
labels to 4,096 characters. Unknown fields and oversized evidence are rejected
without changing the returned status.

Acceptance revalidates the packet digest against the approved packet before
checking criteria, and compares the live workspace fingerprint with the one
recorded when the child returned before recording `verified-complete`. Drift
leaves the run `returned` for inspection; the acceptance lock is released.
If a returned run cannot obtain its final workspace
fingerprint, or leaves descendant processes in its owned Unix process group,
it remains `needs-review`, not `verified-complete`. The supervisor terminates
that process group before releasing the workspace lock; if it cannot confirm
termination the lock remains for manual inspection. A pending cancellation
poll cannot schedule another signal after the child closes or the run is
released. Other process groups and Windows descendants are not confined by
this mechanism. A successful child is `returned`; controller inspection with
artifact hashes and per-criterion evidence is required for
`verified-complete`. A stale heartbeat becomes `unknown`; do not automatically
restart or clear its workspace lock.
Local logs may contain sensitive task data despite credential-pattern screening.
Do not export them without review. Usage numbers unavailable to the launcher are
null, not zero. External telemetry is owned by existing configured integrations.

## Validation

`node --test tests/unit/execution-router.test.mjs` exercises real temporary Git
repositories and a fixture executable with Codex's interface. No provider is
called. This validates mechanical behavior, not end-to-end model quality or
whether ChatGPT will invoke the skill in every new conversation. Run fresh-chat
routing scenarios separately after installing the plugin/project overlay.

## Maintenance

Version the skill, private policy, runtime deployment, and installed plugin.
Compare source digests before redeployment. Preserve current worktrees and
unrelated uncommitted changes. Do not silently grant additional permissions,
upgrade running agents, create duplicate queues, or attach every transcript to
memory. Existing maintenance workflows should report drift and unresolved runs.

Automatic process execution supports POSIX process groups. Windows uses manual handoffs until process-tree supervision is available. Exceptional exits retain the workspace lock and report `cleanup-uncertain` if descendant termination cannot be confirmed.

A test-only task can use a writable sandbox because tests execute repository code, but any resulting workspace change requires review unless the task also authorizes `edit`. This includes generated test artifacts; acceptance does not silently widen task actions.
