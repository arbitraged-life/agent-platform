---
name: aggressive-repository-cleanup
description: Remove verified obsolete repository state after authorized migration and independent acceptance.
---

# Final repository cleanup

Use after [the audit](../repository-systematic-audit/SKILL.md),
[implementation](../repository-safe-cleanup/SKILL.md) and
[verification](../cleanup-verification-qa/SKILL.md). Existing authorization can
cover this phase; the skill does not grant authority to delete unrelated data.

For each proposed removal, confirm its exact audited path and fingerprint,
canonical replacement, completed consumer handoff, reconciled worktrees and
rollback disposition. Reject unlisted candidates and candidates with unresolved
references. A quarantine directory is not automatically approved for deletion.

Delete only that enumerated set. Preserve unrelated dirty or untracked files.
Remove an empty parent directory only when that exact parent is also approved
and still empty; do not recursively sweep the repository for empty directories.
Never erase history, encrypted data or independently owned knowledge because it
appears unused by the engineering checkout.

Remove temporary wrappers and aliases after their stated removal conditions
hold. Update canonical documentation and machine-readable migration state.
Record intentional retained legacy paths and why they remain. Archiving a source
repository requires verifying that active automation no longer writes to it.

Run relevant validation and security hooks on the resulting diff. Compare final
status with the initial dirty-path inventory; unrelated changes can remain, so
report them accurately instead of forcing the whole checkout clean. Use
[status-report](../status-report/SKILL.md) to distinguish verified removals from
pending cleanup and operational blockers.

The optional [retired-source guard](../../docs/SOURCE_RETIREMENT.md) provides
commit and push enforcement once a component changes owner. Its private policy
lists exact retired paths and replacements; installation preserves existing
hooks. Reconcile historical work before retiring the source repository itself.
