---
name: cleanup-verification-qa
description: Independently verify a cleanup diff against its audited decisions before merge or final removal.
---

# Cleanup verification QA

Review without performing the moves or deletions under review. Establish the
source/base revision, candidate revision and current dirty state. A helper
reviewer may contribute independent evidence; unavailable reviewers do not
replace required checks.

Compare every added, modified, renamed and deleted path with the authorized
audit. Flag unexplained additions, unlisted deletions, changed fingerprints and
unreconciled worktrees. Check installed consumers and generated configurations
as well as source references. Verify replacement paths actually resolve and
exercise the affected behavior.

Check preserved governance, licensing, hooks, environment configuration and
knowledge ownership. Run available secret and privacy checks without printing
credential values. Public history, generated artifacts and fixtures need review
in addition to the current source tree.

Use the consuming repository's documented validation commands for meaningful
tests, builds, lint and lifecycle gates. Record the command, revision, result
and scope. Unavailable or skipped checks are unknown, never passes. A baseline
failure is distinct from a regression, but still needs explicit disposition.

Save a review note with audit-to-diff mapping, validation, unresolved findings
and remaining acceptance. Final deletion requires accounted-for paths, passing
applicable checks and verified consumer handoff. Failed or unavailable required
checks leave the affected removal pending. Other independent work can continue.

[Status reporting](../status-report/SKILL.md) summarizes this evidence; it does
not substitute for it or authorize additional changes.
