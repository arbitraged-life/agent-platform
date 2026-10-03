# Merge automation

Mergify is the merge authority for `agent-platform`.

## Policy

- Merge Protections gate merges into `main` on deterministic CI, GitGuardian,
  Socket PR scanning, and the absence of outstanding change-request reviews.
- Safe Renovate updates receive `renovate-automerge`; security updates remain manual.
- Human-authored pull requests opt into automation with the `merge-ready` label.
- Auto-Merge sends eligible pull requests to the Merge Queue.
- The Merge Queue uses serial, single-PR squash merges with single-step in-place
  checks, preserving compatibility with GitHub's strict up-to-date required-status policy.
- Workflow Automation is limited to non-merge housekeeping; currently it comments
  when a pull request has a merge conflict.
- Security fixes have high queue priority; routine Renovate updates have low priority.

The fallback operator command is `@Mergifyio queue` when a pull request should be
queued manually.

## Failure behavior

A failed required check or merge conflict leaves the pull request unmerged. Workflow
Automation may comment on conflicts, but only Merge Protections plus the Merge Queue
authorize an automated merge.
