# Agent Platform

Reusable, independently testable agent engineering components. Node.js 24 or
newer, CPython 3.12–3.14, and Git are required for validation on macOS or Linux
x86_64/arm64. No private checkout,
account, service, or credentials are needed for local validation.

```sh
./scripts/setup
./scripts/validate
```

Setup creates an isolated validation environment with a hash-pinned YAML parser.
Runtime components use standard-library dependencies only. The validation lock is
generated from the [PyYAML 6.0.3 release metadata](https://pypi.org/pypi/PyYAML/6.0.3/json):
select `urls` entries with `packagetype == "bdist_wheel"`, collect their
`digests.sha256` values, deduplicate, sort, and write one `--hash=sha256:` per
line under the exact version pin. Compare that set with the metadata when
updating the lock; installation verifies the selected artifact with `--require-hashes`.

The platform contains the execution router, bounded review and remediation,
portable skills, deterministic evaluations, and reusable validation, review and
stale-item workflows. Commodity dependency updates and merge coordination are
delegated to Renovate and Mergify rather than maintained as platform runtime code.

- [Execution router](docs/execution-router.md): explicit policy, bounded process
  execution, immutable approval records, and independently verified completion.
- [Review remediation](runtime/review-remediation/README.md): trusted policies,
  bounded attempts, isolated execution, and exact-revision publication checks.
- [Release contract](docs/release-contract.md): immutable, digest-checked installs.
- [Skills](docs/skills.md): catalog, provenance, licensing and consumer overlays.
- [Migration provenance](docs/MIGRATION_PROVENANCE.md): source revisions and transformations.

`./scripts/validate lint`, `test`, `eval`, and `security` select individual local
gates. CI additionally runs an independent secret scanner. Paid model runs and
live GitHub mutations require explicit deployment configuration and credentials;
the test suite uses isolated fixtures and fake clients.

Original code is licensed under Apache-2.0. See LICENSE and NOTICE.
