---
name: repository-safe-cleanup
description: Apply authorized repository migrations while preserving dirty work, explicit ownership and rollback.
---

# Repository safe cleanup

Read the audit and the consuming repository's instructions. Establish explicit
source and target roots, source revisions, allowed actions and validation
commands. Work in an isolated branch or worktree when the existing checkout is
dirty. Preserve unrelated modifications, ignored configuration and live state.

Before changing a path, compare its current fingerprint with the audited value.
Reconcile changed input instead of overwriting it. Stage only intended paths.
Never treat logs, empty directories or ignored files as disposable merely because
of their filename or extension; they can contain evidence or runtime state.

Apply one architectural component at a time. Normalize naming and configuration,
merge useful duplicate behavior, retain required licensing, then install through
an explicit versioned interface. A permanent sibling-checkout reference is not
a consumption contract. Public candidates need separate content and history
privacy checks before publication.

Update actual consumers and configuration generators. Run the repository's
documented validation command and representative acceptance for the affected
interfaces. Retain the old implementation until consumer handoff and rollback
are verified. Any temporary wrapper needs an owner, replacement and measurable
removal condition.

Deletion is limited to enumerated, authorized audit candidates whose current
contents and consumers have been checked. Uncertain candidates stay where they
are until assessed; moving them into quarantine can break consumers too.

Save the before/after mapping, validation results, compatibility state and
remaining worktree conflicts. Use
[cleanup-verification-qa](../cleanup-verification-qa/SKILL.md) before final
removal. Do not claim deployment or cutover from a successful file copy.
