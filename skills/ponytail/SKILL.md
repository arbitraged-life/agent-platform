---
name: ponytail
description: Prefer the smallest maintainable code change by checking existing code, standard-library features, platform capabilities, and installed dependencies before adding new abstractions.
---

# Minimal-Change Engineering

Use when implementing or reviewing code where a new helper, dependency, abstraction, or file is being considered.

## Decision order

After understanding the real failure or requirement:

1. Confirm the change is needed.
2. Search the codebase for an existing implementation or established pattern.
3. Check the language standard library.
4. Check the platform/runtime's native capability.
5. Reuse an already-installed dependency when it is appropriate.
6. Prefer a direct local change over a new abstraction when both are maintainable.
7. Add new machinery only when the simpler options do not satisfy the requirement.

## Root-cause rule

For defects, trace callers and shared behavior far enough to identify the root cause. A smaller diff at the wrong layer is not preferable to a correct shared fix.

## Non-negotiable boundaries

Minimal code never means skipping:
- trust-boundary validation;
- security controls;
- data-loss prevention;
- required error handling;
- accessibility requirements;
- explicit acceptance criteria.

## Verification

Use the smallest reliable verification that would fail if the changed behavior regressed. Reuse the repository's existing test style and tooling rather than introducing a framework for one check.

Prefer deletion and reuse over duplication, but optimize for maintainability and correctness rather than line count alone.
