# Retired source guard

`scripts/check-retired-paths.py` rejects additions, modifications and type changes
under explicitly retired paths. It reads Git path names,
not file contents, and never stages, rewrites or deletes work. Deletions remain
possible for reviewed source removal. Copies and renames are evaluated as
additions at their destinations; moving a file out of a retired path is allowed
as removal. This guard does not establish ownership for the destination. Rename
detection is disabled explicitly so user Git configuration cannot change these
semantics.

A private consumer supplies a JSON policy with exactly these fields:

- `schema_version`: integer `1`.
- `baseline_commit`: the full immutable source commit at handoff.
- `paths`: a nonempty list of `{ "path": "old/runtime", "replacement": "platform/runtime" }` entries.

Paths are normalized repository-relative file or directory names, without
wildcards or traversal. Each entry covers the exact path and its descendants.
Replacement strings identify the new canonical source; they are never executed.
The reader rejects unknown fields, duplicate paths, invalid versions and floating
baselines. Policy upgrades require an explicit schema version change.

Install the released checker in a pre-commit wrapper using explicit `--root`
and `--policy` arguments. Pass Git's original pre-push input to `--pre-push`: it validates every pushed
revision against the baseline and inspects each introduced commit, including
edits later reverted. Preserve that input for the existing pre-push hook too. Preserve and run the existing hooks after the guard
succeeds. Keep guard code and policy outside the retiring checkout so a historical
branch cannot replace them. Pin the public release rather than resolving a sibling
checkout or a moving branch at hook time.

Exit status is 0 for no protected changes, 1 for rejected changes and 2 for an
unavailable or invalid check. Hook wrappers propagate either failure. This is
commit/push enforcement, not a filesystem access control: unstaged historical
work is retained for reconciliation. Server-side protections or repository
archival are still needed to prevent writes from unconfigured machines.
