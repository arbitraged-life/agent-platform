---
name: repo-style-miner
description: Mine accepted pull requests and reviewer feedback into a compact repository-specific style skill using observed evidence rather than generic humanization advice.
---
# Repository Style Miner

Use this when a coding agent should match an existing team's repository and PR
conventions instead of relying on generic style guidance.

## Evidence boundary

Mine the target repository's accepted work. Do not invent conventions from this
skill or copy employer/proprietary examples into `agent-platform`. Repository-
specific output belongs in the target repository or its authorized work-local
knowledge layer.

Prefer **20–40 merged PRs** when available. Favor PRs that were approved and
accepted without major rework, plus reviewer comments that caused concrete
changes. Exclude dependency-update bots, generated/vendor changes, mechanical
format-only PRs, and unusual emergency patches unless the target style explicitly
needs them.

## Extract

Record observable patterns, not intentions:

- naming and file placement
- abstraction size and when helpers/components are introduced
- comment/docstring density and what kinds of comments survive review
- error-handling and logging patterns
- test placement, test granularity, and mocking style
- common diff size and scope boundaries
- PR title/body tone and level of detail
- recurring reviewer requests and corrections
- patterns from 3–5 exemplar accepted PRs

For every proposed rule, retain evidence count and exemplar references. A rule
seen once is an example, not a convention.

## Produce

Create one small target-repository skill or guidance file with:

1. **Hard conventions** — repeatedly observed and reviewer-enforced.
2. **Preferred patterns** — common but context-dependent.
3. **Avoid** — recurring reviewer corrections.
4. **Examples** — 3–5 accepted PR links/IDs with one sentence on why each is representative.
5. **Unknowns** — areas where the sample is too weak or contradictory.

Keep it compact. Do not paste large code excerpts or full review threads. Prefer
specific examples such as "component tests normally use X helper" over generic
phrases such as "write human-like code."

## Validation

Before activating the style skill:

- compare its rules against at least five accepted PRs not used to derive it
- remove rules contradicted by the holdout sample
- distinguish repository conventions from one reviewer's personal preference
- keep deterministic lint/format/test requirements in code or CI rather than
  restating them as model instructions
- refresh only when reviewer behavior materially changes

The style skill guides semantic/code-readability choices; deterministic PR
structure, CODEOWNERS, CI checks, and code-generation budgets remain separate
mechanical controls.
