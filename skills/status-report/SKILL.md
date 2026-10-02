---
name: status-report
description: Use when handing completed engineering work back to the user, opening a pull request, or switching tasks after substantive repository changes.
---

# Engineering Status Report

Report what actually changed, what was verified, what remains uncertain, and the exact repository state. This skill is a reporting layer; it does not authorize additional cleanup, commits, pushes, merges, or follow-up work.

## Evidence to collect

- branch and HEAD
- concise working-tree status
- files/components materially changed
- verification commands actually run and their observed results
- known failures, skipped checks, blockers, or external dependencies
- publication/deployment state when relevant

## Output

1. **Completed work** — one concise outcome statement plus material changes.
2. **Verification** — commands/checks and results; distinguish focused tests from full-suite coverage.
3. **Repository state** — branch, commit, dirty/clean state, push/PR status if observed.
4. **Risks and limits** — unresolved failures, unverified behavior, environment gaps, or permission blocks.
5. **Remaining work** — only real outstanding items; do not invent optimization tasks to fill this section.

Use exact evidence and paths where helpful. Do not claim checks, reviews, deployment, runtime health, or clean state that were not observed. If another installed planning/review skill owns the next phase, reference that canonical capability generically instead of hard-coding a local duplicate.
