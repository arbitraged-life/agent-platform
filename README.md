# Agent Platform

Reusable, independently testable agent engineering components. Node.js 24 or
newer, Python 3.12 or newer, and Git are required. No private checkout,
account, service, or credentials are needed for local validation.

```sh
./scripts/setup
./scripts/validate
```

The initial release contains the execution router, bounded review remediation,
one portable execution-routing skill, deterministic routing evaluations, and
reusable stale-item and merge-gate workflows. Additional components are admitted
only after their own portability, provenance, and behavior checks pass.

- [Execution router](docs/execution-router.md): explicit policy, bounded process
  execution, immutable approval records, and independently verified completion.
- [Review remediation](runtime/review-remediation/README.md): trusted policies,
  bounded attempts, isolated execution, and exact-revision publication checks.
- [Release contract](docs/release-contract.md): immutable, digest-checked installs.
- [Migration provenance](docs/MIGRATION_PROVENANCE.md): source revisions and transformations.

`./scripts/validate lint`, `test`, `eval`, and `security` select individual local
gates. CI additionally runs independent secret scanners. Paid model runs and
live GitHub mutations require explicit deployment configuration and credentials;
the test suite uses isolated fixtures and fake clients.

Original code is licensed under Apache-2.0. See LICENSE and NOTICE.
