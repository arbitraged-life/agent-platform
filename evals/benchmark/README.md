# Offline coding benchmark

Twelve synthetic bug-fix tasks pair a ticket, seeded fixture, and behavioral
oracle. Five include known-correct reference fixes. The suite verifies that
all seeded bugs fail and all reference fixes pass; it does not invoke models.

## Run

```sh
node evals/benchmark/run.mjs --list
node evals/benchmark/run.mjs --task 01-pagination-off-by-one --workdir /tmp/work/01
node evals/benchmark/run.mjs --task 01-pagination-off-by-one --grade /tmp/work/01
node evals/benchmark/run.mjs --grade-all /tmp/work
```

An external harness or human edits the materialized fixture before grading.
Batch grading expects one directory per task ID. It emits a PASS/FAIL table
and a JSON record with type `benchmark-grade-all`, total, passed, and per-task
results. Exit status is nonzero if any task fails. Keep this record with the
model/configuration revision when comparing changes.

`./scripts/validate` runs the regression suite without credentials or network
access. The rate-limit oracle uses a simulated clock. Fixtures require Node
24 or newer and Bash on macOS or Linux.

## Execution boundary

Grading executes candidate JavaScript with the current user's privileges.
Use host grading only for trusted fixtures. Run untrusted model outputs inside
an independently provisioned sandbox with no credentials or private mounts;
this runner does not provide that security boundary.

Each subprocess has a five-second deadline and a 64 KiB output limit. Its
process group is terminated and owned temporary directory removed on success,
failure, output overflow, or timeout. Candidate code can still access host
files; process limits are resource controls, not isolation.

Fixture setup rejects destinations inside this repository, including symlink
aliases, and rejects nonempty destinations unless `--force` is explicit.
Task IDs are selected from the bundled task list. Relative paths are resolved
from the caller's working directory. Scratch directories remain caller-owned.

## Task layout

Each `tasks/<id>/` has `setup.sh`, `prompt.md`, `oracle.cjs`, and `README.md`.
The five reference tasks additionally contain `fixed/lib.js` and a readable
`reference-fix.patch`. The runner invokes each oracle directly; duplicate
shell wrappers were removed. Fixtures intentionally contain bugs, including
an injection example. Their failing behavior is the benchmark input.
