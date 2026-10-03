---
name: cross-language-purity
description: Verify repository-level invariants across languages and configuration using fail-closed, repository-root-aware checks with explicit evidence and no private-environment assumptions.
---

# Cross-Language Purity

Use when a change affects repository layout, file ownership, cross-language boundaries, generated configuration, or tooling that spans multiple languages.

## Scope

This skill checks structural consistency. It does not replace language-specific tests or linters.

Start from the actual repository root. If the current directory is not inside a Git worktree, report that structural verification is unavailable rather than treating missing Git results as success.

## Required evidence

1. Inspect changed and untracked files with Git.
2. Resolve the repository root explicitly.
3. Run the repository's declared structural checks when present.
4. Run relevant language-specific checks for changed components.
5. Treat a missing required check as an unresolved verification item, not a pass.
6. Record which checks ran, which were unavailable, and their exit status.

## Invariants

Useful repository-wide invariants include:
- deterministic placement for generated or shared files;
- stable public paths for documented interfaces;
- searchability and provenance for generated artifacts;
- no cross-language dependency on undeclared relative paths;
- tests located where the owning runtime discovers them;
- configuration references that resolve to existing tracked paths.

Do not hard-code personal directories, VPS paths, account names, or private hook names into a reusable validator.

## Failure behavior

Fail closed when a required repository or language check cannot be executed. Do not suppress Git errors or skip a missing test suite while still claiming the structure is clean.

A report should distinguish:
- verified pass;
- verified failure;
- not applicable;
- unavailable/unverified.
