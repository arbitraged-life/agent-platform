---
name: session-close-out
description: Determine whether an engineering session is safe to close by checking only the repositories and obligations actually observed, with explicit coverage and no hidden cleanup.
---

# Session Close-Out

Use when the user asks whether work is safely wrapped up or the current engineering session
can be closed.

This is an evidence check, not permission to discard work or perform opportunistic cleanup.

## Establish coverage

Build the repo set from reliable current-session evidence when available: explicit task
context, connected-agent/session metadata, worktree records, or repositories actually
operated on in the conversation. If there is no trustworthy session-wide record, check the
current repository and any other repos the user explicitly names.

Never claim coverage for repositories that were not observed. State the checked set in the
result.

## Repository checks

For each covered repository:

1. inspect branch/HEAD and working-tree status;
2. identify modified, staged, and untracked files;
3. determine whether committed work expected to be remote is actually pushed/upstream;
4. inspect open PR/CI state when that state is part of the task;
5. run a repo-defined verification command only when the user asked for close-out and the
   command is safe/reasonable in the current environment;
6. preserve all dirty/untracked state—do not clean, reset, stash, commit, or push merely to
   make the close-out result green.

A clean working tree alone does not prove the work is pushed, reviewed, deployed, or
accepted. Check only the states relevant to the work that was performed.

## Open obligations

If an authoritative task/todo system is available and relevant to the session, inspect
explicitly open items tied to this work. Do not invent tasks from code comments or prose.

If task state is unavailable, report that coverage gap instead of treating it as empty.

## Verdict

State **safe to close** only when the checked repositories have no unpreserved work and no
known session obligation requires immediate continuation. Otherwise list the concrete
blocking items.

A blocker can be an uncommitted change, an expected push that is absent, required CI/review
still pending, an unresolved conflict, or an explicit open obligation.

## Report

Include:

- repositories actually checked;
- branch/HEAD and dirty/clean state for each;
- push/PR/verification evidence that was actually observed;
- open obligations checked;
- exact blockers;
- explicit coverage limitation for any session state that could not be reconstructed.
