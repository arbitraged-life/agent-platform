---
name: autonomous-pr-integration
description: Safely integrate one or more reviewed branches into a pull request using explicit branch scope, incremental integration, deterministic verification, and current-head merge gates.
---

# Autonomous Pull Request Integration

Use when consolidating related branch work into a pull request or driving an existing
pull request through validation and merge gates.

Automation does not expand authority. Preserve repository protections, required
reviews, current-head checks, and explicit branch scope.

## Preconditions

Before changing history or opening a pull request:

- identify the repository, base branch, and exact source branch set;
- inspect existing worktrees and dirty state;
- fetch remote state when network access is authorized;
- confirm the selected branches are not already integrated;
- discover repository-local validation and contribution rules.

If the base, branch set, merge strategy, or required checks are ambiguous, stop before
integrating.

## Integration

Create or use an isolated integration branch when combining multiple branches. Bring
changes in one source at a time so each conflict and regression can be attributed.

After each integration step:

1. inspect the resulting diff and conflict resolutions;
2. run the narrow checks needed to establish that step is sound;
3. record any skipped or unavailable verification.

Do not resolve semantic conflicts by mechanically choosing one side. Preserve unrelated
dirty work and never force-push a shared branch unless the user explicitly authorizes that
specific history rewrite.

## Pull request lifecycle

Before opening or updating the pull request, run the repository's relevant test, lint,
build, typecheck, or validation commands. Push the intended head and verify the pull
request points to that exact revision.

While the pull request is open:

- distinguish required checks from optional/advisory checks;
- address actionable review findings without silently expanding scope;
- re-run affected validation after changes;
- update from the base branch when required by repository policy;
- re-read the pull request head before any merge decision.

## Merge gate

Merge only when all repository-required conditions are presently satisfied for the exact
head being merged. At minimum, verify current head identity, required checks, blocking
reviews/conversations, mergeability, and expected base branch.

A stale successful check or approval from an older head does not authorize the new head.
A missing or unreadable required gate is unknown, not success.

Use an expected-head or equivalent optimistic-concurrency guard when the hosting platform
supports one.

## Cleanup

After a confirmed merge, remove only temporary integration state that is known to be
safe to delete. Do not remove dirty worktrees, unmerged branches, or state owned by another
agent/person merely because the pull request is complete.

## Report

Report the exact branches integrated, validation actually run, pull request/head state,
merge result, cleanup performed, and any remaining uncertainty. Never claim autonomous
completion when a required gate was unavailable or bypassed.
