# Generic code-quality checks

The repository-owned reusable lint workflow was retired on 2026-10-03 after a
controlled Qlty Cloud bake-off.

Qlty Cloud is now the canonical generic code-quality gate for pull requests. It
publishes the `qlty check` commit status and covers the commodity checks that
were previously maintained here (including Ruff, Bandit, ShellCheck, formatting,
and additional static analyzers).

The GitHub Actions CI remains responsible for repository-specific validation,
platform/runtime tests, and the independent TruffleHog secret job. Mergify
requires `qlty check` plus those deterministic checks before merge.
The secret gate runs the TruffleHog image pinned by digest and consumes JSONL
results. It permits one proven synthetic Postgres fixture result only when its
commit, file, line, detector, verification state, and raw-value SHA-256 all
match the reviewed disposition in `scripts/trufflehog_gate.py`. Malformed JSON,
scanner failures, duplicate results, or any other finding fail the gate.

The old reusable workflow had no active external default-branch consumers when
retired. Migration provenance remains in `docs/MIGRATION_PROVENANCE.md` and
`docs/migration/validation/reusable-lint.json`.

## Reviewed fixture findings

Shell-free subprocess fixtures still need review: use the current Python
interpreter or a resolved tool executable, and trace every argument to
repository-owned code or synthetic test input. The existing line-scoped
`qlty-ignore(bandit:B603)` convention records that rationale for a reviewed call.
It is not a file-wide or rule-wide exclusion. Changes to executable selection,
argument provenance, or shell interpretation require a fresh review.

## Acceptance evidence

A controlled PR seeded:

- Ruff F401 (unused Python import)
- Bandit B404/B602 (subprocess / `shell=True`)
- ShellCheck SC2086 and SC2164

Qlty reported all six issues and failed `qlty check`. SonarQube Cloud reported
zero new issues on the same fixture. The prior GitHub Actions linters annotated
findings but remained advisory/green.
