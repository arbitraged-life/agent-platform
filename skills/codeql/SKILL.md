---
name: codeql
description: Configure, run, and troubleshoot CodeQL scanning using current repository language evidence, pinned workflow actions, least-privilege permissions, and explicit SARIF/result verification.
---

# CodeQL

Use when adding or repairing CodeQL scanning in a repository, interpreting scan failures, or verifying that code-scanning results are actually being produced.

## Discovery

Before editing workflow configuration:

1. inspect the repository's actual languages and build system;
2. inspect existing code-scanning/security workflows;
3. identify whether default setup or advanced workflow configuration already owns CodeQL;
4. check current GitHub documentation for supported languages and action inputs.

Do not rely on a hard-coded language list or dated product availability claim.
## Workflow safety

When repository workflow files are required:
- pin third-party and GitHub-maintained actions to immutable commit SHAs according to repository policy;
- grant only the permissions required by the selected CodeQL flow;
- preserve existing branch/event policy unless the user requests a change;
- do not add broad write permissions merely to make uploads succeed;
- keep build-mode choices aligned with the actual project build.

## Verification

A green workflow file is not sufficient evidence.

Verify:
- initialization and analysis steps ran for the intended language set;
- the build phase, when required, exercised the expected code;
- SARIF/code-scanning upload completed;
- the current commit has the expected check/run result;
- failures are distinguished between build, query, permissions, upload, and configuration problems.

When exact syntax or supported behavior matters, consult current official CodeQL/GitHub documentation rather than stale examples.
